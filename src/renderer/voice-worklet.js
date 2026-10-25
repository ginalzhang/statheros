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
    this.history = new Float32Array(0);
    this.frame = new Int16Array(FRAME);
    this.filled = 0;
    this.taps = Math.max(1, Math.round(this.ratio));
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0 || !input[0]) return true;
    const length = input[0].length;
    const mono = new Float32Array(length);
    for (const channel of input) for (let i = 0; i < length; i++) mono[i] += channel[i] / input.length;
    if (this.ratio === 1) { for (let i = 0; i < length; i++) this.push(mono[i]); return true; }
    const joined = new Float32Array(this.history.length + length);
    joined.set(this.history); joined.set(mono, this.history.length);
    let pos = this.position;
    while (pos + this.taps < joined.length) {
      const index = Math.floor(pos), frac = pos - index;
      let a = 0, b = 0;
      for (let t = 0; t < this.taps; t++) { a += joined[index + t]; b += joined[index + t + 1]; }
      this.push((a + (b - a) * frac) / this.taps);
      pos += this.ratio;
    }
    const keep = Math.floor(pos);
    this.history = joined.slice(keep);
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
