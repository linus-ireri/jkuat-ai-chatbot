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
 * Trim text to a speakable length so TTS finishes quickly.
 * Keeps up to `maxSentences` complete sentences (default 4).
 * The user reads the full answer on screen; audio covers the opening.
 * @param {string} text   Already stripped of markdown
 * @param {number} maxSentences
 * @returns {string}
 */
export function truncateForSpeech(text, maxSentences = 4) {
  const clean = String(text || '').trim();
  // Split on sentence-ending punctuation followed by whitespace or end
  const sentences = clean.match(/[^.!?]+[.!?]+(\s|$)/g) || [clean];
  return sentences.slice(0, maxSentences).join(' ').trim();
}

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
 * Synthesise speech using the persistent Piper process (Amy medium voice).
 * Piper is the only TTS engine — no espeak-ng, no browser fallback.
 * Returns null only if PIPER_MODEL is not configured or Piper crashes.
 */
/**
 * Synthesise speech using the Piper binary (preferred) or espeak-ng (fallback).
 *
 * Piper is kept as a **persistent process** — the ONNX model loads once at
 * first use (~3 s) and stays resident. Every subsequent call takes ~0.3–0.8 s
 * regardless of text length, eliminating the per-call startup cost.
 *
 * Priority:
 *   1. Persistent Piper process (PIPER_MODEL configured)
 *   2. espeak-ng — lightweight fallback
 *   3. null      — caller falls back to browser speechSynthesis
 *
 * @param {string} text  Clean plain-text to speak
 * @returns {Promise<Buffer|null>}  WAV audio buffer, or null if both fail/unavailable.
 */

// ── Persistent Piper process ──────────────────────────────────────────────────
let _piperProc = null;       // the long-lived child process
let _piperBusy = false;      // only one synthesis at a time
let _piperQueue = [];        // queued requests while busy

/** Spawn (or re-spawn) the persistent Piper process. */
function _ensurePiper() {
  if (_piperProc) return;

  const model  = process.env.PIPER_MODEL;
  const binary = process.env.PIPER_BINARY || 'piper';
  if (!model) return;

  try {
    _piperProc = spawn(binary, [
      '--model', model,
      '--output-raw',
      '--sentence-silence', '0.1',
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    _piperProc.stderr.on('data', (d) => {
      const msg = d.toString().trim();
      if (msg) console.log('[piper]', msg);
    });

    _piperProc.on('error', (err) => {
      console.warn('[piper] process error:', err.message);
      _piperProc = null;
    });

    _piperProc.on('exit', (code) => {
      console.log(`[piper] process exited (${code}) — will respawn on next request`);
      _piperProc = null;
    });

    console.log('[piper] persistent process started');
  } catch (err) {
    console.warn('[piper] failed to start:', err.message);
    _piperProc = null;
  }
}

/**
 * Split text into individual sentences for line-by-line Piper input.
 * Shorter lines are more reliable for Piper and reduce the chance of
 * internal buffering gaps that can trigger premature silence detection.
 *
 * @param {string} text
 * @returns {string[]}
 */
function _splitSentences(text) {
  const clean = String(text || '').trim();
  if (!clean) return [];
  // Match runs ending with sentence punctuation (keeping the punctuation).
  const matches = clean.match(/[^.!?]+[.!?]+/g) || [];
  // Capture any trailing text after the last punctuation mark.
  const remainder = clean.replace(/[^.!?]+[.!?]+/g, '').trim();
  if (remainder) matches.push(remainder);
  return matches.map((s) => s.trim()).filter(Boolean);
}

/**
 * Send text to the persistent Piper process and collect the raw PCM output.
 *
 * Text is split into sentences and each sentence is written as a separate
 * line on Piper's stdin — Piper reads and synthesises each line, producing
 * continuous PCM on stdout for the full text.
 *
 * End-of-output is detected with an **adaptive silence heuristic** that is
 * robust for long responses:
 *
 *   • Before the first chunk: 8 s window for model initialisation.
 *   • Until enough bytes arrive: 3 s gap (generous — covers inter-sentence
 *     processing pauses without cutting off).
 *   • After the estimated minimum bytes: 800 ms gap (snappy end detection).
 *
 * The "estimated minimum bytes" threshold is derived from the text length
 * and Piper's audio format (22 050 Hz × 16-bit × mono).  This prevents the
 * silence timer from firing mid-response when Piper briefly pauses between
 * sentences — the most common cause of Piper "going silent" and dropping
 * words on long outputs.
 *
 * @param {string} text
 * @returns {Promise<Buffer|null>}
 */
function _piperSynth(text) {
  return new Promise((resolve) => {
    _ensurePiper();
    if (!_piperProc) { resolve(null); return; }

    const chunks = [];
    let silenceTimer = null;
    let overallTimer = null;
    let totalBytes = 0;

    // Split into sentences and send each as a separate line.
    const sentences = _splitSentences(text);
    const lines = sentences.length ? sentences : [String(text || '').trim()];
    const fullText = lines.join(' ');
    if (!fullText.trim()) { resolve(null); return; }

    // ── Expected-bytes threshold ────────────────────────────────────────────
    // Piper outputs 22 050 Hz, 16-bit, mono → 44 100 bytes/sec.
    // Average English speech ≈ 14 chars/sec → ≈ 3 150 bytes/char.
    // We use 50 % of the estimate as the minimum before switching to the
    // short (snappy) silence gap.  This is conservative: even if speech is
    // 2× faster than estimated the threshold is still reached late enough
    // to avoid cutting off.
    const BYTES_PER_SEC = 22050 * 2;        // 44 100
    const CHARS_PER_SEC = 14;
    const estimatedBytes = Math.max(
      fullText.length * (BYTES_PER_SEC / CHARS_PER_SEC),
      BYTES_PER_SEC * 0.1,                 // at least 0.1 s of audio
    );
    const minBytesBeforeShortSilence = Math.floor(estimatedBytes * 0.5);

    // Overall timeout scales with text length so very long answers are not
    // truncated by a fixed ceiling.  2.5× the estimated duration gives ample
    // headroom for Piper's processing overhead.
    const estimatedDurationMs = (estimatedBytes / BYTES_PER_SEC) * 1000;
    const MAX_WAIT_MS = Math.max(estimatedDurationMs * 2.5, 30000);

    const INIT_GAP_MS = 8000;   // before first chunk (model warm-up)
    const LONG_GAP_MS = 3000;   // until we have enough bytes
    const SHORT_GAP_MS = 800;  // after we have enough bytes

    const cleanup = () => {
      if (silenceTimer) clearTimeout(silenceTimer);
      if (overallTimer) clearTimeout(overallTimer);
      _piperProc.stdout.removeListener('data', onData);
      _piperProc.removeListener('exit', onExit);
    };

    const done = () => {
      cleanup();
      resolve(chunks.length ? Buffer.concat(chunks) : null);
    };

    const resetTimer = () => {
      if (silenceTimer) clearTimeout(silenceTimer);
      let gap;
      if (totalBytes === 0) {
        gap = INIT_GAP_MS;          // model initialisation
      } else if (totalBytes < minBytesBeforeShortSilence) {
        gap = LONG_GAP_MS;          // still collecting expected audio
      } else {
        gap = SHORT_GAP_MS;        // enough audio — detect actual end
      }
      silenceTimer = setTimeout(done, gap);
    };

    const onData = (chunk) => {
      chunks.push(chunk);
      totalBytes += chunk.length;
      resetTimer();
    };

    const onExit = () => {
      cleanup();
      _piperProc = null;
      resolve(chunks.length ? Buffer.concat(chunks) : null);
    };

    _piperProc.stdout.on('data', onData);
    _piperProc.once('exit', onExit);

    // Send each sentence as its own line — Piper synthesises each and
    // outputs continuous PCM for the entire text on stdout.
    for (const line of lines) {
      const safe = line.replace(/\n+/g, ' ').trim();
      if (safe) _piperProc.stdin.write(safe + '\n');
    }

    resetTimer();                          // start the initial wait window
    overallTimer = setTimeout(done, MAX_WAIT_MS);  // safety net
  });
}

/**
 * Serialise calls to the persistent process — it can only handle one at a time.
 */
function _piperSynthQueued(text) {
  return new Promise((resolve, reject) => {
    const run = () => {
      _piperBusy = true;
      _piperSynth(text)
        .then(resolve, reject)
        .finally(() => {
          _piperBusy = false;
          if (_piperQueue.length) _piperQueue.shift()();
        });
    };
    if (_piperBusy) {
      _piperQueue.push(run);
    } else {
      run();
    }
  });
}

export async function synthesisePiper(text) {
  // ── 1. Try persistent Piper if configured ─────────────────────────────────
  if (process.env.PIPER_MODEL) {
    try {
      const raw = await _piperSynthQueued(text);
      if (raw && raw.length > 0) {
        return wrapInWav(raw, 22050, 1, 16);
      }
    } catch (err) {
      console.warn('[piper] synthesis error:', err.message);
    }
  }

  // Piper not configured or failed — return null, caller handles silence
  return null;
}

/**
 * Pre-warm Piper at server startup by spawning the process and sending a
 * silent dummy sentence. After this resolves the model is loaded in memory
 * and all subsequent calls are fast (~0.5 s instead of ~3.5 s).
 */
export async function warmUpPiper() {
  if (!process.env.PIPER_MODEL) return;
  console.log('[piper] warming up TTS model…');
  try {
    await synthesisePiper('Ready.');
    console.log('[piper] warm-up complete — TTS is ready');
  } catch (err) {
    console.warn('[piper] warm-up failed (non-fatal):', err.message);
  }
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
