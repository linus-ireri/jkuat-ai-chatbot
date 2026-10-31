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

/** Whisper model — whisper-base.en quantised for fast CPU inference */
const WHISPER_MODEL = process.env.WHISPER_MODEL || 'Xenova/whisper-base.en';

/**
 * Load the Whisper pipeline once and cache it.  Returns the cached
 * instance on subsequent calls.
 */
export async function loadWhisper() {
  if (whisperPipeline) return whisperPipeline;
  if (whisperLoading) return whisperLoading;

  whisperLoading = (async () => {
    console.log(`[voice] Loading Whisper model: ${WHISPER_MODEL}`);
    const p = await pipeline('automatic-speech-recognition', WHISPER_MODEL, {
      // Use the quantised (q8) variant for faster load + less RAM
      dtype: 'q8',
      // Cache models in the project's node_modules cache by default
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
 * Synthesise speech using the Piper binary.
 *
 * @param {string} text  Clean plain-text to speak
 * @returns {Promise<Buffer|null>}
 *   WAV audio buffer, or null if Piper is not configured / fails.
 */
export async function synthesisePiper(text) {
  const binary = process.env.PIPER_BINARY || 'piper';
  const model = process.env.PIPER_MODEL;

  if (!model) {
    // TTS not configured — caller should fall back to browser speechSynthesis
    return null;
  }

  return new Promise((resolve) => {
    const args = ['--model', model, '--output-raw'];
    // If a config JSON sits next to the model file, use it automatically
    const configPath = model.replace(/\.onnx$/, '.json');
    // piper auto-discovers the config if it exists; no flag needed

    let proc;
    try {
      proc = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      console.warn('[voice] Piper spawn failed:', err.message);
      resolve(null);
      return;
    }

    const chunks = [];
    const errChunks = [];

    proc.stdout.on('data', (chunk) => chunks.push(chunk));
    proc.stderr.on('data', (chunk) => errChunks.push(chunk));

    proc.on('error', (err) => {
      console.warn('[voice] Piper process error:', err.message);
      resolve(null);
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        const errText = Buffer.concat(errChunks).toString().trim();
        console.warn(`[voice] Piper exited ${code}: ${errText}`);
        resolve(null);
        return;
      }
      // Piper --output-raw emits raw 16-bit LE mono PCM at 22050 Hz.
      // Wrap in a minimal WAV header so browsers can play it directly.
      const raw = Buffer.concat(chunks);
      resolve(wrapInWav(raw, 22050, 1, 16));
    });

    // Feed text to piper's stdin
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
