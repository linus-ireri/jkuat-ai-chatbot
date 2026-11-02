/**
 * AudioWorkletProcessor — captures raw Float32 PCM from the microphone.
 * Runs in the AudioWorklet thread; posts chunks back to the main thread.
 */
class PcmCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel?.length) {
      // Post a copy — the original buffer is reused each quantum
      this.port.postMessage(new Float32Array(channel));
    }
    return true; // keep alive
  }
}

registerProcessor('pcm-capture', PcmCaptureProcessor);
