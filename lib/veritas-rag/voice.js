/**
 * Voice pipeline: Whisper (ASR) + Piper (TTS) for VeritasRAG.
 *
 * Whisper is loaded once at startup via @huggingface/transformers.
 * Piper is spawned as a child process for TTS; if PIPER_BINARY or
 * PIPER_MODEL are not configured the module silently disables TTS
 * so the browser can fall back to speechSynthesis.
 *
 * No audio is stored: Float32 PCM arrives in memory, is transcribed,
 * and the buffer is discarded. TTS output is read from Piper's stdout
 * and base64-encoded directly into the response.
 */

import { pipeline } from '@huggingface/transformers';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Whisper ──────────────────────────────────────────────────────────────────

/** @type {import('@huggingface/transformers').AutomaticSpeechRecognitionPipeline | null} */
let whisperPipeline = null;
let whisperLoading = null; // single in-flight promise so concurrent calls don't double-load

/**
 * Whisper model.
 * Default: tiny.en (~39 MB quantised) — fast CPU inference, low RAM.
 * Override with WHISPER_MODEL=Xenova/whisper-base.en for better accuracy.
 */
const WHISPER_MODEL = process.env.WHISPER_MODEL || 'Xenova/whisper-base.en';

/**
 * How long (ms) the Whisper pipeline is kept in memory after the last request.
 * After this idle period the model is released so RAM is reclaimed.
 * Set WHISPER_IDLE_MS=0 to keep the model loaded indefinitely.
 * Default: 5 minutes.
 */
const WHISPER_IDLE_MS = Number(process.env.WHISPER_IDLE_MS ?? 5 * 60 * 1000);

let _idleTimer = null;

/** Cancel the current idle-release timer (called when a new request arrives). */
function _resetIdleTimer() {
  if (WHISPER_IDLE_MS <= 0) return; // keep-alive mode
  if (_idleTimer) clearTimeout(_idleTimer);
  _idleTimer = setTimeout(() => {
    if (whisperPipeline) {
      console.log('[voice] Whisper idle timeout — releasing model to free RAM.');
      whisperPipeline = null;
      whisperLoading = null;
    }
    _idleTimer = null;
  }, WHISPER_IDLE_MS);
  // Don't let this timer prevent the Node process from exiting cleanly
  if (_idleTimer.unref) _idleTimer.unref();
}

/**
 * Load the Whisper pipeline on demand and cache it.
 * Returns the cached instance on subsequent calls.
 * The pipeline is automatically released after WHISPER_IDLE_MS of inactivity.
 */
export async function loadWhisper() {
  // Reset the idle release timer on every load call (i.e. every voice request)
  _resetIdleTimer();

  if (whisperPipeline) return whisperPipeline;
  if (whisperLoading) return whisperLoading;

  whisperLoading = (async () => {
    console.log(`[voice] Loading Whisper model: ${WHISPER_MODEL}`);
    const p = await pipeline('automatic-speech-recognition', WHISPER_MODEL, {
      // q8 quantisation cuts RAM roughly in half vs fp32
      dtype: 'q8',
      cache_dir: process.env.HF_CACHE_DIR || undefined,
    });
    whisperPipeline = p;
    console.log('[voice] Whisper pipeline ready.');
    return p;
  })();

  return whisperLoading;
}

/**
 * Transcribe raw 16 kHz mono Float32 PCM audio.
 *
 * @param {Float32Array} samples  Raw PCM samples at 16 000 Hz
 * @returns {Promise<string>} Transcribed text (empty string if silent)
 */
export async function transcribeFloat32(samples) {
  const pipe = await loadWhisper();

  // @huggingface/transformers v3 accepts a Float32Array directly when
  // sampling_rate is provided in the options object.
  const result = await pipe(samples, {
    sampling_rate: 16000,
    return_timestamps: false,
  });

  // Result shape: { text: string } or { chunks: [{text}] }
  const text = Array.isArray(result?.chunks)
    ? result.chunks.map((c) => c.text).join(' ')
    : String(result?.text || '');

  return text.trim();
}

// ─── Piper TTS ────────────────────────────────────────────────────────────────

/**
 * Strip markdown so Piper doesn't read symbols aloud.
 * Also removes content that doesn't make sense as spoken audio.
 * @param {string} text
 * @returns {string}
 */
export function stripMarkdownForSpeech(text) {
  return String(text || '')
    // Remove fenced code blocks entirely (they're unreadable aloud)
    .replace(/```[\s\S]*?```/g, '')
    // Remove inline code
    .replace(/`[^`]*`/g, '')
    // Remove markdown links — keep link text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    // Remove images
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    // Headings → plain text
    .replace(/^#{1,6}\s+/gm, '')
    // Bold/italic markers
    .replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1')
    .replace(/_{1,2}([^_]+)_{1,2}/g, '$1')
    // Blockquotes
    .replace(/^>\s*/gm, '')
    // Unordered list markers
    .replace(/^[-*+]\s+/gm, '')
    // Ordered list markers
    .replace(/^\d+\.\s+/gm, '')
    // Table delimiters (pipe chars + separator rows)
    .replace(/^\s*\|.+\|\s*$/gm, (line) => line.replace(/\|/g, ' ').trim())
    .replace(/^\s*[-|: ]+$/gm, '')
    // Trailing whitespace / multiple blanks
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Synthesise speech using the Piper binary (preferred) or espeak-ng (fallback).
 *
 * Priority:
 *   1. Piper  — high-quality neural TTS (requires PIPER_MODEL env var)
 *   2. espeak-ng — lightweight, already available on most Linux systems
 *   3. null   — caller falls back to browser speechSynthesis
 *
 * @param {string} text  Clean plain-text to speak
 * @returns {Promise<Buffer|null>}  WAV audio buffer, or null if both fail/unavailable.
 */
export async function synthesisePiper(text) {
  // ── 1. Try Piper first if configured ──────────────────────────────────────
  const model = process.env.PIPER_MODEL;
  if (model) {
    const binary = process.env.PIPER_BINARY || 'piper';
    const piperResult = await _spawnTts(binary, ['--model', model, '--output-raw'], text);
    if (piperResult) {
      // Piper --output-raw emits raw 16-bit LE mono PCM at 22050 Hz
      return wrapInWav(piperResult, 22050, 1, 16);
    }
  }

  // ── 2. Fall back to espeak-ng ──────────────────────────────────────────────
  const espeakBin = process.env.ESPEAK_BINARY || 'espeak-ng';
  // espeak-ng writes WAV directly to stdout with --stdout
  const espeakResult = await _spawnTts(
    espeakBin,
    [
      '--stdout',           // WAV to stdout
      '-v', process.env.ESPEAK_VOICE || 'en',
      '-s', '145',          // words per minute (slightly slower than default 175)
      '-a', '180',          // amplitude (volume) 0-200
    ],
    text,
    true  // output is already WAV — don't wrap it
  );
  if (espeakResult) return espeakResult;

  // ── 3. Nothing available ───────────────────────────────────────────────────
  return null;
}

/**
 * Spawn a TTS process, feed it text on stdin, collect stdout.
 * @param {string}   binary
 * @param {string[]} args
 * @param {string}   text
 * @param {boolean}  [rawIsWav=false]  If true the stdout bytes are a complete WAV file already.
 * @returns {Promise<Buffer|null>}
 */
async function _spawnTts(binary, args, text, rawIsWav = false) {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      console.warn(`[voice] TTS spawn failed (${binary}):`, err.message);
      resolve(null);
      return;
    }

    const outChunks = [];
    const errChunks = [];
    proc.stdout.on('data', (c) => outChunks.push(c));
    proc.stderr.on('data', (c) => errChunks.push(c));
    proc.on('error', (err) => {
      console.warn(`[voice] TTS process error (${binary}):`, err.message);
      resolve(null);
    });
    proc.on('close', (code) => {
      if (code !== 0) {
        const errText = Buffer.concat(errChunks).toString().trim();
        console.warn(`[voice] TTS exited ${code} (${binary}): ${errText}`);
        resolve(null);
        return;
      }
      const out = Buffer.concat(outChunks);
      resolve(rawIsWav ? out : out);
    });

    proc.stdin.write(text, 'utf8');
    proc.stdin.end();
  });
}

/**
 * Wrap raw PCM bytes in a RIFF/WAV header.
 * @param {Buffer} pcm    Raw signed 16-bit LE PCM data
 * @param {number} sampleRate
 * @param {number} channels
 * @param {number} bitsPerSample
 * @returns {Buffer}
 */
function wrapInWav(pcm, sampleRate, channels, bitsPerSample) {
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const dataSize = pcm.length;
  const header = Buffer.alloc(44);

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);          // PCM chunk size
  header.writeUInt16LE(1, 20);           // AudioFormat = PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcm]);
}
