import { expect, it } from 'vitest';
import { activePreset, gainFromPercent, sensitivityPercent, STROKE_PRESETS } from '../src/renderer/stroke-presets';
import type { CalibrationV1 } from '../src/shared/contracts';
const base: CalibrationV1 = { schemaVersion: 1, cameraId: 'c', mode: 'palm', selectedHand: null, neutral: { x: 0.5, y: 0.5 }, extents: { left: 0.2, right: 0.2, up: 0.2, down: 0.2 }, jitter: { x: 0.001, y: 0.001 }, gain: 1, smoothing: 50 };
it('maps sensitivity percent to the engine gain range and back', () => {
  expect(gainFromPercent(0)).toBe(0.5); expect(gainFromPercent(100)).toBe(3); expect(sensitivityPercent(1)).toBe(20);
  for (const percent of [0, 25, 50, 75, 100]) expect(sensitivityPercent(gainFromPercent(percent))).toBe(percent);
});
it('recognizes the active stroke mode from smoothing (and gain when the mode sets it)', () => {
  expect(activePreset({ ...base, smoothing: 75, gain: 2.2 })?.id).toBe('steady');
  expect(activePreset({ ...base, smoothing: 60, gain: 0.8 })?.id).toBe('precision');
  expect(activePreset({ ...base, smoothing: 60, gain: 1 })).toBeNull();
  expect(activePreset(null)).toBeNull();
  expect(STROKE_PRESETS.filter(preset => preset.available !== false).every(preset => preset.smoothing >= 0 && preset.smoothing <= 100 && (preset.gain === undefined || (preset.gain >= 0.5 && preset.gain <= 3)))).toBe(true);
});
it('lists all six design modes and never reports Adaptive, which has no engine behavior, as active', () => {
  expect(STROKE_PRESETS.map(preset => preset.label)).toEqual(['Natural', 'Steady', 'Precision', 'Sketch', 'Tremor Filter', 'Adaptive']);
  expect(STROKE_PRESETS.find(preset => preset.id === 'adaptive')?.available).toBe(false);
  expect(activePreset({ ...base, smoothing: -1 })).toBeNull();
});
