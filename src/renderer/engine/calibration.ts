import type { CalibrationV1, Mode, Point, TrackingSample } from '../../shared/contracts';
import { rejectionHint } from '../tracking';

export const CALIBRATION_STEPS = ['neutral', 'left', 'right', 'up', 'down'] as const;
export type CaptureStep = typeof CALIBRATION_STEPS[number];
export type HandLabel = 'Left' | 'Right';
export interface CaptureContext { cameraId: string; mode: Mode; generation: number; selectedHand?: HandLabel | null }
export interface CaptureSummary { position: Point; jitter: Point; validSamples: number; totalFrames: number; selectedHand: HandLabel | null }
export type CaptureResult = { ok: true; capture: CaptureSummary } | { ok: false; reason: string };
export const CAPTURE_MS = 2000;
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, expected: string[]): boolean => Object.keys(value).length === expected.length && expected.every(key => key in value);
export const normalizedPoint = (value: unknown): value is Point => object(value) && keys(value, ['x', 'y']) && finite(value.x) && finite(value.y) && value.x >= 0 && value.x <= 1 && value.y >= 0 && value.y <= 1;
export function median(values: readonly number[]): number {
  if (!values.length || !values.every(Number.isFinite)) throw new Error('A median needs finite samples');
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}
export function scaledMAD(values: readonly number[]): number {
  const center = median(values);
  return 1.4826 * median(values.map(value => Math.abs(value - center)));
}
function validContext(context: CaptureContext): boolean {
  return typeof context.cameraId === 'string' && context.cameraId.length > 0 && context.cameraId.length <= 1024 && ['head', 'palm'].includes(context.mode) && integer(context.generation) && (context.mode === 'head' ? context.selectedHand == null : context.selectedHand == null || context.selectedHand === 'Left' || context.selectedHand === 'Right');
}
/** One explicit Capture starts one two-second window; waiting before Capture has no deadline. */
export class CalibrationCapture {
  readonly deadline: number;
  private frames = 0;
  private points: Point[] = [];
  private lastFrame = -1;
  private lastTimestamp = -Infinity;
  private hand: HandLabel | null;
  private rejections = new Map<string, number>();
  constructor(readonly context: CaptureContext, readonly startedAt: number) {
    if (!validContext(context) || !finite(startedAt) || startedAt < 0) throw new Error('Invalid calibration capture context');
    this.context = { ...context };
    this.hand = context.mode === 'palm' ? context.selectedHand ?? null : null;
    this.deadline = startedAt + CAPTURE_MS;
  }
  add(sample: TrackingSample, receiptTimestamp = sample.captureTimestamp): boolean {
    if (!finite(receiptTimestamp) || receiptTimestamp < sample.captureTimestamp || receiptTimestamp >= this.deadline || !finite(sample.captureTimestamp) || sample.captureTimestamp < this.startedAt || sample.captureTimestamp >= this.deadline || receiptTimestamp - sample.captureTimestamp >= 250 || sample.generation !== this.context.generation || sample.mode !== this.context.mode || !integer(sample.frameId) || sample.frameId <= this.lastFrame || sample.captureTimestamp <= this.lastTimestamp) return false;
    this.lastFrame = sample.frameId;
    this.lastTimestamp = sample.captureTimestamp;
    this.frames++;
    if (!sample.valid || !normalizedPoint(sample.anchor)) return this.reject(sample.qualityReason || 'invalid landmark');
    if (this.context.mode === 'palm') {
      const label = sample.selectedHand;
      if (label !== 'Left' && label !== 'Right') return this.reject('missing handedness label');
      if (this.hand !== null && this.hand !== label) return this.reject('different hand label');
      this.hand = label;
    }
    this.points.push({ ...sample.anchor });
    return true;
  }
  private reject(reason: string): false {
    this.rejections.set(reason, (this.rejections.get(reason) ?? 0) + 1);
    return false;
  }
  /** The most common rejection, in plain language, so a failed Capture says what to fix. */
  private dominantRejection(): string {
    const top = [...this.rejections.entries()].sort((a, b) => b[1] - a[1])[0];
    if (!top) return this.frames === 0 ? ' No tracking frames arrived; check the camera.' : '';
    return ` Most frames: ${(rejectionHint(top[0], this.context.mode) ?? top[0]).replace(/^./, c => c.toLowerCase())}.`;
  }
  finish(now: number): CaptureResult {
    if (!finite(now) || now < this.deadline) return { ok: false, reason: 'Capture is still sampling for two seconds' };
    if (this.points.length < 40) return { ok: false, reason: `Need at least 40 valid samples; received ${this.points.length}.${this.dominantRejection()} Retry or Cancel.` };
    if (this.points.length / this.frames < 0.8) return { ok: false, reason: `Need at least 80% valid frames; received ${Math.round(100 * this.points.length / this.frames)}%.${this.dominantRejection()} Retry or Cancel.` };
    const x = this.points.map(point => point.x), y = this.points.map(point => point.y);
    return { ok: true, capture: { position: { x: median(x), y: median(y) }, jitter: { x: scaledMAD(x), y: scaledMAD(y) }, validSamples: this.points.length, totalFrames: this.frames, selectedHand: this.hand } };
  }
}

export function isCalibrationV1(value: unknown): value is CalibrationV1 {
  if (!object(value) || !keys(value, ['schemaVersion', 'cameraId', 'mode', 'selectedHand', 'neutral', 'extents', 'jitter', 'gain', 'smoothing']) || value.schemaVersion !== 1 || typeof value.cameraId !== 'string' || value.cameraId.length === 0 || value.cameraId.length > 1024 || !['head', 'palm'].includes(value.mode as string) || !normalizedPoint(value.neutral) || !object(value.extents) || !keys(value.extents, ['left', 'right', 'up', 'down']) || !object(value.jitter) || !keys(value.jitter, ['x', 'y']) || !finite(value.jitter.x) || !finite(value.jitter.y) || value.jitter.x < 0 || value.jitter.y < 0 || !finite(value.gain) || value.gain < 0.5 || value.gain > 3 || !finite(value.smoothing) || value.smoothing < 0 || value.smoothing > 100) return false;
  if (value.mode === 'head' ? value.selectedHand !== null : value.selectedHand !== 'Left' && value.selectedHand !== 'Right') return false;
  const extents = value.extents;
  return (['left', 'right', 'up', 'down'] as const).every(direction => {
    const extent = extents[direction];
    const jitter = (direction === 'left' || direction === 'right') ? (value.jitter as Point).x : (value.jitter as Point).y;
    return finite(extent) && extent <= 1 && extent > 0.01 && extent > 3 * jitter;
  });
}
function validSummary(capture: CaptureSummary, mode: Mode, selectedHand: HandLabel | null): boolean {
  return normalizedPoint(capture.position) && finite(capture.jitter.x) && capture.jitter.x >= 0 && finite(capture.jitter.y) && capture.jitter.y >= 0 && integer(capture.validSamples) && capture.validSamples >= 40 && integer(capture.totalFrames) && capture.totalFrames >= capture.validSamples && capture.validSamples / capture.totalFrames >= 0.8 && (mode === 'head' ? capture.selectedHand === null : selectedHand !== null && capture.selectedHand === selectedHand);
}
export function buildCalibration(input: { cameraId: string; mode: Mode; captures: Record<CaptureStep, CaptureSummary>; gain?: number; smoothing?: number }): CalibrationV1 {
  const neutral = input.captures.neutral;
  if (!neutral || !CALIBRATION_STEPS.every(step => input.captures[step] && validSummary(input.captures[step], input.mode, neutral.selectedHand))) throw new Error('All five successful captures must use the same selected hand and camera/mode');
  const { left, right, up, down } = input.captures;
  const calibration: CalibrationV1 = {
    schemaVersion: 1, cameraId: input.cameraId, mode: input.mode, selectedHand: neutral.selectedHand,
    neutral: { ...neutral.position }, jitter: { ...neutral.jitter },
    extents: { left: neutral.position.x - left.position.x, right: right.position.x - neutral.position.x, up: neutral.position.y - up.position.y, down: down.position.y - neutral.position.y },
    gain: input.gain ?? 1, smoothing: input.smoothing ?? 50,
  };
  if (!isCalibrationV1(calibration)) throw new Error('Each directional extent must exceed 0.01 and three times neutral jitter. Recapture comfortable bounds; gain is not increased automatically.');
  return calibration;
}
export function recenterCalibration(calibration: CalibrationV1, capture: CaptureSummary): CalibrationV1 {
  if (!isCalibrationV1(calibration) || !validSummary(capture, calibration.mode, calibration.selectedHand)) throw new Error('Recenter needs a successful neutral capture of the selected hand');
  const next: CalibrationV1 = { ...calibration, neutral: { ...capture.position }, jitter: { ...capture.jitter }, extents: { ...calibration.extents } };
  if (!isCalibrationV1(next)) throw new Error('Recenter jitter exceeds saved directional range; recalibrate.');
  return next;
}
/** JSON tuple encoding prevents camera/mode key collisions. */
export function calibrationKey(cameraId: string, mode: Mode): string { return JSON.stringify([cameraId, mode]); }

/** Pure ordered setup helper. Retry repeats the current step, and Cancel clears all captures. */
export class CalibrationSession {
  private index = 0;
  private capture: CalibrationCapture | null = null;
  private values: Partial<Record<CaptureStep, CaptureSummary>> = {};
  constructor(readonly context: CaptureContext) { if (!validContext(context)) throw new Error('Invalid calibration session context'); }
  get step(): CaptureStep | null { return CALIBRATION_STEPS[this.index] ?? null; }
  get active(): boolean { return this.capture !== null; }
  get captures(): Partial<Record<CaptureStep, CaptureSummary>> { return structuredClone(this.values); }
  start(now: number): void {
    if (this.active || this.step === null) throw new Error('No available capture step');
    this.capture = new CalibrationCapture({ ...this.context, selectedHand: this.values.neutral?.selectedHand ?? this.context.selectedHand }, now);
  }
  add(sample: TrackingSample, receiptTimestamp = sample.captureTimestamp): boolean { return this.capture?.add(sample, receiptTimestamp) ?? false; }
  finish(now: number): CaptureResult {
    if (!this.capture || this.step === null) return { ok: false, reason: 'Press Capture to start the two-second window' };
    const result = this.capture.finish(now);
    if (!result.ok && (!Number.isFinite(now) || now < this.capture.deadline)) return result;
    this.capture = null;
    if (result.ok) {
      const step = this.step;
      if (step !== 'neutral') {
        const neutral = this.values.neutral!;
        const horizontal = step === 'left' || step === 'right';
        const extent = step === 'left' ? neutral.position.x - result.capture.position.x : step === 'right' ? result.capture.position.x - neutral.position.x : step === 'up' ? neutral.position.y - result.capture.position.y : result.capture.position.y - neutral.position.y;
        const jitter = horizontal ? neutral.jitter.x : neutral.jitter.y;
        if (extent <= 0.01 || extent <= 3 * jitter) return { ok: false, reason: `${step} range must exceed 0.01 and three times neutral jitter. Retry or Cancel.` };
      }
      this.values[step] = result.capture; this.index++;
    }
    return result;
  }
  cancel(): void { this.capture = null; this.index = 0; this.values = {}; }
  build(gain = 1, smoothing = 50): CalibrationV1 {
    if (this.step !== null) throw new Error('Five successful captures are required');
    return buildCalibration({ ...this.context, captures: this.values as Record<CaptureStep, CaptureSummary>, gain, smoothing });
  }
}
