/* global sampleRate, registerProcessor, AudioWorkletProcessor */
// Voice tap: downmix → 16 kHz → int16 → 1280-sample frames, posted to the panel renderer.
// Resampling is stateful (fractional position carried across blocks) with a short anti-alias
// average when downsampling; never drops samples to resample.
const OUT_RATE = 16000;
const FRAME = 1280;

class SteadyVoiceTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / OUT_RATE;
    this.position = 0; // fractional read position into `history`
    this.history = new Float32Array(1024);
    this.historyLength = 0;
    this.frame = new Int16Array(FRAME);
    this.filled = 0;
    this.taps = Math.max(1, Math.round(this.ratio));
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0 || !input[0]) return true;
    const length = input[0].length;
    const total = this.historyLength + length;
    // Grow only for an unusually large render quantum; reuse storage on every normal callback.
    if (this.history.length < total) {
      const larger = new Float32Array(Math.max(total, this.history.length * 2));
      larger.set(this.history); this.history = larger;
    }
    this.history.fill(0, this.historyLength, total);
    for (const channel of input) {
      for (let i = 0; i < length; i++) this.history[this.historyLength + i] += channel[i] / input.length;
    }
    if (this.ratio === 1) {
      for (let i = 0; i < length; i++) this.push(this.history[i]);
      return true;
    }
    let pos = this.position;
    while (pos + this.taps < total) {
      const index = Math.floor(pos), frac = pos - index;
      let a = 0, b = 0;
      for (let t = 0; t < this.taps; t++) { a += this.history[index + t]; b += this.history[index + t + 1]; }
      this.push((a + (b - a) * frac) / this.taps);
      pos += this.ratio;
    }
    const keep = Math.floor(pos);
    this.history.copyWithin(0, keep, total);
    this.historyLength = total - keep;
    this.position = pos - keep;
    return true;
  }
  push(value) {
    const clamped = Math.max(-1, Math.min(1, value));
    this.frame[this.filled++] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    if (this.filled === FRAME) {
      const out = this.frame;
      this.port.postMessage(out.buffer, [out.buffer]);
      this.frame = new Int16Array(FRAME);
      this.filled = 0;
    }
  }
}
registerProcessor('steady-voice-tap', SteadyVoiceTap);
