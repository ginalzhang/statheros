import type { Mode, Point, TrackingSample } from '../shared/contracts';

export interface Landmark { x: number; y: number }
export type HandLabel = 'Left' | 'Right';
export interface AnchorResult { valid: boolean; anchor: Point | null; reason: string }
/** Mirroring occurs exactly here, before samples leave the tracking worker. */
export function extractAnchor(mode: Mode, landmarks: Landmark[][]): AnchorResult {
  if (landmarks.length !== 1) return { valid: false, anchor: null, reason: landmarks.length ? 'multiple subjects' : 'no subject' };
  const points = mode === 'head' ? [landmarks[0]?.[1]] : [0, 5, 9, 13, 17].map(index => landmarks[0]?.[index]);
  if (points.some(point => !point || !Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1)) return { valid: false, anchor: null, reason: 'invalid landmark' };
  const anchor = points.reduce((sum, point) => ({ x: sum.x + point!.x, y: sum.y + point!.y }), { x: 0, y: 0 });
  return { valid: true, anchor: { x: 1 - anchor.x / points.length, y: anchor.y / points.length }, reason: 'valid' };
}

/** Initialization fallback is bounded; an inference error never reinitializes. */
export async function initializeDelegate<T>(initialize: (delegate: 'GPU' | 'CPU') => Promise<T>): Promise<{ detector: T; delegate: 'GPU' | 'CPU' }> {
  try { return { detector: await initialize('GPU'), delegate: 'GPU' }; }
  catch { return { detector: await initialize('CPU'), delegate: 'CPU' }; }
}

export class FrameGate {
  private busy = false;
  acquire(): boolean { if (this.busy) return false; this.busy = true; return true; }
  release(): void { this.busy = false; }
}

/** A polling tick is not a camera frame. Each media timestamp can be used once. */
export class FrameProgress {
  private latest: { mediaTime: number; captureTimestamp: number } | null = null;
  private consumed = -Infinity;
  receive(mediaTime: number, receiptTimestamp: number, captureTimestamp?: number): void {
    if (!Number.isFinite(mediaTime) || !Number.isFinite(receiptTimestamp) || mediaTime < 0 || receiptTimestamp < 0 || mediaTime <= (this.latest?.mediaTime ?? -Infinity)) return;
    const timestamp = captureTimestamp !== undefined && Number.isFinite(captureTimestamp) && captureTimestamp >= 0 && captureTimestamp <= receiptTimestamp ? captureTimestamp : receiptTimestamp;
    this.latest = { mediaTime, captureTimestamp: timestamp };
  }
  take(): number | null {
    if (!this.latest || this.latest.mediaTime <= this.consumed) return null;
    this.consumed = this.latest.mediaTime; return this.latest.captureTimestamp;
  }
}

/** Results keep the original capture time. A fresh receipt cannot revive a stale frame. */
export class SampleGate {
  private frame = -1;
  private timestamp = -Infinity;
  accept(sample: TrackingSample, generation: number, mode: Mode, now: number): boolean {
    if (sample.generation !== generation || sample.mode !== mode || !Number.isSafeInteger(sample.frameId) || sample.frameId < 0 || sample.frameId <= this.frame || !Number.isFinite(sample.captureTimestamp) || sample.captureTimestamp < 0 || sample.captureTimestamp <= this.timestamp || sample.captureTimestamp > now || now - sample.captureTimestamp >= 250) return false;
    this.frame = sample.frameId; this.timestamp = sample.captureTimestamp; return true;
  }
}

/**
 * Declared-loss lock only: how long without an accepted matching frame (by result *receipt* time)
 * before the selected hand must be confirmed again. Input safety is separate and unchanged: the
 * native watchdog pauses and releases at 250 ms since the last valid capture (plan §3).
 */
export const HAND_LOSS_MS = 1000;
/** A confirm click may arrive via main (pause round trip); the candidate must be this recent on receipt. */
export const CONFIRM_FRESH_MS = 500;

/** Conservative continuity only: handedness and proximity never identify a person. */
export class SelectedHandContinuity {
  selectedHand: HandLabel | null = null;
  confirmationRequired = false;
  private previous: Point | null = null;
  private lastValidReceipt: number | null = null;
  private candidate: { anchor: Point; timestamp: number; receivedAt: number } | null = null;
  setSelectedHand(label: HandLabel | null, confirmed = false): void {
    this.selectedHand = label; this.confirmationRequired = label !== null && !confirmed;
    this.previous = null; this.lastValidReceipt = null; this.candidate = null;
  }
  /** Returns true only on the transition to declared loss, including camera stalls. */
  expire(now: number): boolean {
    if (this.selectedHand !== null && !this.confirmationRequired && this.lastValidReceipt !== null && now - this.lastValidReceipt >= HAND_LOSS_MS) {
      this.confirmationRequired = true; this.previous = null; this.candidate = null; return true;
    }
    return false;
  }
  /** `timestamp` = capture time, `now` = receipt time of this result. */
  observe(result: AnchorResult, label: HandLabel | null, timestamp: number, now: number): AnchorResult {
    this.expire(now);
    if (!result.valid || !result.anchor) { this.candidate = null; return result; }
    if (!label) { this.candidate = null; return { valid: false, anchor: null, reason: 'missing handedness label' }; }
    if (this.selectedHand !== null && label !== this.selectedHand) { this.candidate = null; return { valid: false, anchor: null, reason: 'different hand label' }; }
    if (this.selectedHand === null) this.selectedHand = label;
    this.candidate = { anchor: result.anchor, timestamp, receivedAt: now };
    if (this.confirmationRequired) return { valid: false, anchor: null, reason: 'confirm selected hand' };
    if (this.previous && Math.hypot(result.anchor.x - this.previous.x, result.anchor.y - this.previous.y) > 0.12) return { valid: false, anchor: null, reason: 'hand anchor jump' };
    this.previous = result.anchor; this.lastValidReceipt = now;
    return result;
  }
  confirm(now: number): boolean {
    if (!this.confirmationRequired || !this.candidate || now < this.candidate.receivedAt || now - this.candidate.receivedAt >= CONFIRM_FRESH_MS) return false;
    // Restart the loss clock from the confirmation itself, so the watchdog cannot re-lock at once.
    this.previous = this.candidate.anchor; this.lastValidReceipt = now;
    this.confirmationRequired = false; return true;
  }
}

/** Plain-language reason a frame was rejected (panel hint under the preview). */
export function rejectionHint(reason: string | null | undefined, mode: Mode): string | null {
  const subject = mode === 'palm' ? 'hand' : 'face';
  switch (reason) {
    case undefined: case null: case 'valid': return null;
    case 'no subject': return `No ${subject} in view`;
    case 'multiple subjects': return mode === 'palm' ? 'Two hands in view — show only one' : 'More than one face in view';
    case 'missing handedness label': case 'invalid landmark': return `Keep your whole ${subject} in the frame`;
    case 'different hand label': return "That's your other hand";
    case 'hand anchor jump': return 'Moved too fast — hold steady';
    case 'confirm selected hand': return 'Hand was lost — show it and press Confirm';
    default: return reason;
  }
}

/** MediaPipe hand skeleton (21 landmarks). */
export const HAND_CONNECTIONS: readonly [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17],
];
/** Display-only landmarks for the preview; never sent to main. Unmirrored model coordinates. */
export interface PreviewOverlay { mode: Mode; landmarks: Landmark[]; valid: boolean; receivedAt: number }
export const OVERLAY_MAX_AGE_MS = 250;

/** Draws over the already-mirrored preview, mirroring x exactly once to match it. */
export function drawLandmarkOverlay(canvas: HTMLCanvasElement, overlay: PreviewOverlay | null, now: number): void {
  if (!overlay || !overlay.landmarks.length || now - overlay.receivedAt > OVERLAY_MAX_AGE_MS) return;
  const context = canvas.getContext('2d');
  if (!context) return;
  const w = canvas.width, h = canvas.height, scale = Math.max(1, w / 320);
  const at = (point: Landmark): [number, number] => [(1 - point.x) * w, point.y * h];
  context.save();
  context.strokeStyle = context.fillStyle = overlay.valid ? '#70B99D' : '#A9B0B0';
  context.lineWidth = 1.5 * scale;
  if (overlay.mode === 'palm') {
    context.beginPath();
    for (const [a, b] of HAND_CONNECTIONS) {
      const p = overlay.landmarks[a], q = overlay.landmarks[b];
      if (!p || !q) continue;
      context.moveTo(...at(p)); context.lineTo(...at(q));
    }
    context.stroke();
  } else {
    const xs = overlay.landmarks.map(point => 1 - point.x), ys = overlay.landmarks.map(point => point.y);
    const [x0, x1, y0, y1] = [Math.min(...xs) * w, Math.max(...xs) * w, Math.min(...ys) * h, Math.max(...ys) * h];
    const arm = Math.min(x1 - x0, y1 - y0) * 0.22;
    context.beginPath();
    for (const [x, y, dx, dy] of [[x0, y0, 1, 1], [x1, y0, -1, 1], [x0, y1, 1, -1], [x1, y1, -1, -1]] as const) {
      context.moveTo(x + dx * arm, y); context.lineTo(x, y); context.lineTo(x, y + dy * arm);
    }
    context.stroke();
  }
  for (const point of overlay.landmarks) { const [x, y] = at(point); context.beginPath(); context.arc(x, y, 2.2 * scale, 0, Math.PI * 2); context.fill(); }
  context.restore();
}

/** The preview is flipped once; inference consumes the original unflipped video. */
export function drawMirroredPreview(canvas: HTMLCanvasElement, video: HTMLVideoElement): void {
  const context = canvas.getContext('2d');
  if (!context || !video.videoWidth || !video.videoHeight) return;
  if (canvas.width !== video.videoWidth) canvas.width = video.videoWidth;
  if (canvas.height !== video.videoHeight) canvas.height = video.videoHeight;
  context.save(); context.translate(canvas.width, 0); context.scale(-1, 1);
  context.drawImage(video, 0, 0, canvas.width, canvas.height); context.restore();
}
