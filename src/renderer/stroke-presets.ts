import type { CalibrationV1 } from '../shared/contracts';

/**
 * Stroke Assistance modes (Figma "Stroke / …"), expressed only in the existing engine's two
 * calibration parameters: smoothing (0–100 → One Euro min cutoff) and gain (0.5–3). No new
 * algorithm (handoff §02). Steady is the source default. The current design lists six modes; Adaptive has
 * no engine behavior yet, so it is shown but unavailable (`available: false`) rather than invented.
 * A mode without `gain` keeps the user's sensitivity.
 */
export const STROKE_PRESETS: readonly { id: string; label: string; smoothing: number; gain?: number; preview: string; available?: false }[] = [
  { id: 'natural', label: 'Natural', smoothing: 20, preview: 'M3 14 C 8 9, 11 16, 16 11 S 23 13, 27 9 S 34 14, 39 10' },
  { id: 'steady', label: 'Steady', smoothing: 75, preview: 'M3 15 C 12 15, 14 7, 21 7 S 32 14, 39 9' },
  { id: 'precision', label: 'Precision', smoothing: 60, gain: 0.8, preview: 'M3 17 C 15 16, 26 12, 39 6' },
  { id: 'sketch', label: 'Sketch', smoothing: 10, gain: 1.4, preview: 'M3 15 l3 -6 l3 7 l3 -7 l3 7 l3 -7 l3 7 l3 -7 l3 7 l3 -6 l3 6 l3 -5' },
  { id: 'tremor', label: 'Tremor Filter', smoothing: 95, preview: 'M3 12 C 10 7, 16 7, 21 12 S 32 17, 39 12' },
  { id: 'adaptive', label: 'Adaptive', smoothing: -1, preview: 'M3 11 C 9 4, 15 4, 21 11 S 33 18, 39 11', available: false },
];
export type StrokePreset = typeof STROKE_PRESETS[number];

export const GAIN_MIN = 0.5, GAIN_MAX = 3;
/** Movement Sensitivity % ↔ calibration gain, linear over the engine's validated range. */
export const sensitivityPercent = (gain: number): number => Math.round(100 * (gain - GAIN_MIN) / (GAIN_MAX - GAIN_MIN));
export const gainFromPercent = (percent: number): number => Math.round((GAIN_MIN + (GAIN_MAX - GAIN_MIN) * Math.min(100, Math.max(0, percent)) / 100) * 100) / 100;

export function activePreset(calibration: CalibrationV1 | null | undefined): StrokePreset | null {
  if (!calibration) return null;
  return STROKE_PRESETS.find(preset => preset.available !== false && preset.smoothing === calibration.smoothing && (preset.gain === undefined || Math.abs(preset.gain - calibration.gain) < 0.01)) ?? null;
}
