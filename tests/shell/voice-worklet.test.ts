import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';

const script = readFileSync('src/renderer/voice-worklet.js', 'utf8');
function tap(rate: number) {
  const frames: Int16Array[] = [];
  let Processor: any;
  let allocations = 0;
  class CountedFloat32Array extends Float32Array { constructor(length: number) { super(length); allocations++; } }
  runInNewContext(script, {
    sampleRate: rate, Float32Array: CountedFloat32Array,
    registerProcessor: (_name: string, value: any) => { Processor = value; },
    AudioWorkletProcessor: class { port = { postMessage: (data: ArrayBuffer) => frames.push(new Int16Array(structuredClone(data, { transfer: [data] }))) }; },
  });
  return { processor: new Processor(), frames, allocations: () => allocations };
}

it.each([16000, 44100, 48000])('preserves streaming resampling at %i Hz without steady-state scratch allocations', rate => {
  const { processor, frames, allocations } = tap(rate);
  const initial = allocations(), size = rate; // One second of stereo input in irregular blocks.
  const left = Float32Array.from({ length: size }, (_, i) => 0.4 * Math.sin(i * 2 * Math.PI * 440 / rate));
  const right = Float32Array.from(left, value => value * 0.5);
  let cursor = 0;
  for (const block of [128, 64, 256]) {
    // Exercise different quantum sizes while keeping the same continuous waveform.
    const end = Math.min(size, cursor + Math.floor(size / 3));
    while (cursor < end) {
      const next = Math.min(end, cursor + block);
      processor.process([[left.subarray(cursor, next), right.subarray(cursor, next)]]); cursor = next;
    }
  }
  if (cursor < size) processor.process([[left.subarray(cursor), right.subarray(cursor)]]);
  expect(allocations()).toBe(initial);
  expect(frames.length).toBeGreaterThanOrEqual(12); // 80 ms output frames, including filter lookahead.
  const output = frames.flatMap(frame => Array.from(frame));
  const ratio = rate / 16000, taps = Math.max(1, Math.round(ratio));
  for (let i = 0; i < output.length; i++) {
    const pos = i * ratio, index = Math.floor(pos), fraction = pos - index;
    let a = 0, b = 0;
    for (let t = 0; t < (rate === 16000 ? 1 : taps); t++) {
      a += left[index + t]! * 0.75; b += left[index + t + 1]! * 0.75;
    }
    const expected = rate === 16000 ? left[i]! * 0.75 : (a + (b - a) * fraction) / taps;
    const pcm = Math.trunc(expected * (expected < 0 ? 32768 : 32767));
    expect(Math.abs(output[i]! - pcm)).toBeLessThanOrEqual(1);
  }
});
