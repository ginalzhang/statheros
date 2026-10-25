import type { CalibrationV1, DisplayInfo, Point, TrackingProbeMetrics, TrackingSample } from '../shared/contracts';
import type { SettingsV1 } from '../shared/settings';
import { CalibrationCapture, CalibrationSession, TrackingEngine, recenterCalibration, type CaptureStep } from './engine';

/**
 * Live calibration guide. `offset` is the signed distance from the neutral capture in the step's
 * direction; `target` is a comfortable margin over the hard rule (> 0.01 and > 3 × neutral jitter).
 */
export interface CalibrationGuide {
  step: CaptureStep; offset: number | null; target: number | null; farEnough: boolean; steadyMs: number; auto: boolean;
  /** The hand moved at least `target` the opposite way: the camera axis is likely flipped for this mount. */
  wrongWay: boolean;
}
/** Auto-capture: hold still this long (all frames valid, spread ≤ HOLD_SPREAD) once far enough. */
export const HOLD_MS = 1000;
export const HOLD_SPREAD = 0.015;
export const targetFor = (jitter: number): number => Math.max(0.05, 4 * jitter);
const STEP_PROMPTS: Record<CaptureStep, string> = {
  neutral: 'Rest your hand in a comfortable middle position.',
  left: 'Move a little to your left', right: 'Move a little to your right', up: 'Move a little up', down: 'Move a little down',
};
export interface SetupSnapshot {
  step: CaptureStep | null; active: boolean; calibrating: boolean; recentering: boolean;
  message: string; calibration: CalibrationV1 | null; position: Point | null; guide: CalibrationGuide | null;
  metrics: TrackingProbeMetrics; baseline: 'idle' | 'warmup' | 'measuring' | 'complete';
}
const emptyMetrics = (): TrackingProbeMetrics => ({ frames: 0, validFrames: 0, mappedFrames: 0, elapsedMs: 0, mappingHz: 0, receiptToMappedP95Ms: null, position: null, reason: 'No mapped samples' });
/** Panel-owned workflow, never sends input actions. Saved configuration is its only durable state. */
export class SetupController {
  private settings: SettingsV1 | null = null;
  private display: DisplayInfo | null = null;
  private generation = 0;
  private context = '';
  private engine: TrackingEngine | null = null;
  private session: CalibrationSession | null = null;
  private recenter: CalibrationCapture | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private baselineWarmupTimer: ReturnType<typeof setTimeout> | undefined;
  private baselineFinishTimer: ReturnType<typeof setTimeout> | undefined;
  private baselineStart: number | null = null;
  private latencies: number[] = [];
  private lastEmit = -Infinity;
  state: SetupSnapshot = { step: null, active: false, calibrating: false, recentering: false, message: 'Select a camera and start tracking, then calibrate.', calibration: null, position: null, guide: null, metrics: emptyMetrics(), baseline: 'idle' };
  autoCapture = true;
  private hold: { anchor: Point; at: number }[] = [];
  /** Wrong-way detection starts only after the hand passes near neutral during the current step
   *  (Right starts from the Left position and Down from Up, which are legitimately "opposite"). */
  private nearNeutral: { step: CaptureStep | null; seen: boolean } = { step: null, seen: false };
  constructor(private changed: (snapshot: SetupSnapshot) => void, private save: (calibration: CalibrationV1) => Promise<void>, private mapped: (sample: TrackingSample, position: Point | null) => void, private recorded: (metrics: TrackingProbeMetrics) => void = () => {}) {}
  update(settings: SettingsV1 | undefined, display: DisplayInfo | undefined, generation: number): void {
    if (!settings) return;
    // Native JSON object key order can vary between otherwise identical replies.
    // Compare mapping geometry only; Spaces/work-area updates cannot cancel capture.
    const geometry = display ? [display.id, display.bounds.x, display.bounds.y, display.bounds.width, display.bounds.height, display.scaleFactor] : null;
    const key = JSON.stringify([settings.cameraId, settings.mode, settings.calibrations, geometry, generation]);
    if (key === this.context) return;
    this.cancel(false); this.context = key; this.settings = settings; this.display = display ?? null; this.generation = generation;
    const calibration = settings.calibrations.find(c => c.cameraId === settings.cameraId && c.mode === settings.mode) ?? null;
    this.state = { ...this.state, calibration, position: null, metrics: emptyMetrics(), baseline: 'idle', message: calibration ? 'Saved calibration loaded. Input paused; canvas confirmation requires Phase 03.' : 'Calibration required for this camera and mode.' };
    this.engine = calibration && display ? new TrackingEngine(calibration, display.bounds, generation) : null;
    this.emit();
  }
  begin(): void {
    if (!this.settings?.cameraId) throw new Error('Start a selected camera before calibrating.');
    this.cancel(false);
    this.session = new CalibrationSession({ cameraId: this.settings.cameraId, mode: this.settings.mode, generation: this.generation });
    this.hold = [];
    this.state = { ...this.state, calibrating: true, step: 'neutral', message: this.prompt('neutral') };
    this.emit();
  }
  capture(): void {
    if (!this.session || this.state.active) throw new Error('Start calibration before Capture.');
    this.hold = [];
    this.session.start(performance.now()); this.state.active = true; this.state.guide = null; this.state.message = `Capturing ${this.session.step} for two seconds — keep holding…`; this.emit();
    this.timer = setTimeout(() => { void this.finish(); }, 2005);
  }
  beginRecenter(): void {
    if (!this.settings || !this.state.calibration) throw new Error('Calibrate this camera and mode before recentering.');
    this.cancel(false);
    this.recenter = new CalibrationCapture({ cameraId: this.settings.cameraId, mode: this.settings.mode, generation: this.generation, selectedHand: this.state.calibration.selectedHand }, performance.now());
    this.state = { ...this.state, active: true, recentering: true, message: 'Capturing a new neutral for two seconds; directional extents will be preserved.' }; this.emit();
    this.timer = setTimeout(() => { void this.finish(); }, 2005);
  }
  private async finish(): Promise<void> {
    const session = this.session, recenter = this.recenter;
    const result = recenter ? recenter.finish(performance.now()) : session?.finish(performance.now());
    this.state.active = false; this.hold = [];
    if (!result) return;
    if (!result.ok) { this.recenter = null; this.state.recentering = false; this.state.message = /Retry|Cancel/.test(result.reason) ? result.reason : `${result.reason}. Retry Capture or Cancel.`; this.emit(); return; }
    const counts = `${result.capture.validSamples}/${result.capture.totalFrames} valid frames`;
    try {
      if (recenter && this.state.calibration) {
        const calibration = recenterCalibration(this.state.calibration, result.capture);
        await this.save(calibration); this.engine?.reset(calibration); this.recenter = null; this.state.recentering = false; this.state.calibration = calibration; this.state.message = `Recenter saved (${counts}). Extents preserved, filters reset, input paused.`;
      } else if (session?.step) {
        this.state.step = session.step; this.state.message = `Captured ${counts}. ${this.prompt(session.step)}`;
      } else if (session) {
        const calibration = session.build(); await this.save(calibration); this.session = null; this.state.calibrating = false; this.state.step = null; this.state.calibration = calibration;
        this.state.message = `Five-position calibration saved (${counts}). Input paused; canvas confirmation remains required.`;
      }
    } catch (error) { this.state.message = String(error); }
    this.emit();
  }
  cancel(emit = true): void {
    clearTimeout(this.timer); this.timer = undefined; this.session?.cancel(); this.session = null; this.recenter = null;
    this.state.active = false; this.state.calibrating = false; this.state.recentering = false; this.state.step = null; this.state.baseline = 'idle'; this.state.guide = null; this.hold = [];
    this.engine?.reset(); this.baselineStart = null; clearTimeout(this.baselineWarmupTimer); clearTimeout(this.baselineFinishTimer);
    if (emit) { this.state.message = 'Calibration cancelled; input paused.'; this.emit(); }
  }
  startBaseline(): void {
    if (!this.engine) throw new Error('Complete calibration and select a display before measuring.');
    this.baselineStart = performance.now(); this.latencies = []; this.state.metrics = emptyMetrics(); this.state.baseline = 'warmup'; this.emit();
    clearTimeout(this.baselineWarmupTimer); clearTimeout(this.baselineFinishTimer);
    this.baselineWarmupTimer = setTimeout(() => { this.state.baseline = 'measuring'; this.emit(); }, 10_000);
    this.baselineFinishTimer = setTimeout(() => this.finishBaseline(), 70_000);
  }
  sample(sample: TrackingSample): void {
    const received = performance.now();
    this.session?.add(sample, received); this.recenter?.add(sample, received);
    this.guide(sample, received);
    const result = this.engine?.process(sample, received);
    const position = result?.valid ? result.position : null;
    this.state.position = position ?? null;
    this.mapped({ ...sample, valid: Boolean(position), anchor: position ? sample.anchor : null }, position ?? null);
    const started = this.baselineStart;
    if (started !== null) {
      const elapsed = received - started - 10_000;
      if (elapsed >= 0 && elapsed < 60_000) {
        this.state.baseline = 'measuring';
        const m = this.state.metrics; m.frames++; if (sample.valid) m.validFrames++; if (position) { m.mappedFrames++; this.latencies.push(performance.now() - received); }
        m.elapsedMs = elapsed; m.mappingHz = elapsed > 0 ? m.mappedFrames * 1000 / elapsed : 0;
        const sorted = [...this.latencies].sort((a, b) => a - b); m.receiptToMappedP95Ms = sorted.length ? sorted[Math.ceil(sorted.length * .95) - 1]! : null;
        m.position = position ?? null; m.reason = result?.reason ?? 'Calibration required';
      } else if (elapsed >= 60_000) {
        this.finishBaseline();
      }
    }
    if (received - this.lastEmit >= 100 || this.state.baseline === 'complete') { this.lastEmit = received; this.emit(); }
  }
  private finishBaseline(): void {
    if (this.baselineStart === null) return;
    this.state.metrics.elapsedMs = 60_000; this.state.metrics.mappingHz = this.state.metrics.mappedFrames / 60;
    this.state.baseline = 'complete'; this.baselineStart = null; this.recorded(structuredClone(this.state.metrics)); this.emit();
  }
  setAutoCapture(enabled: boolean): void { this.autoCapture = enabled; this.hold = []; if (this.state.guide) this.state.guide = { ...this.state.guide, auto: enabled }; this.emit(); }
  private prompt(step: CaptureStep): string {
    const hold = this.autoCapture ? 'Hold still to capture.' : 'Press Capture when ready.';
    return step === 'neutral' ? `${STEP_PROMPTS.neutral} ${hold}` : `${STEP_PROMPTS[step]} — you don't need to reach the edge. ${hold}`;
  }
  /** Live guide between captures; starts a capture after HOLD_MS steady once far enough. */
  private guide(sample: TrackingSample, received: number): void {
    const session = this.session, step = session?.step;
    if (!session || !step || this.state.active || !this.state.calibrating) return;
    if (!sample.valid || !sample.anchor) this.hold = [];
    else {
      this.hold.push({ anchor: { ...sample.anchor }, at: received });
      while (this.hold.length && received - this.hold[0]!.at > HOLD_MS) this.hold.shift();
      const first = this.hold[0]!.anchor;
      if (this.hold.some(entry => Math.hypot(entry.anchor.x - first.x, entry.anchor.y - first.y) > HOLD_SPREAD)) this.hold = [this.hold.at(-1)!];
    }
    const neutral = session.neutral;
    let offset: number | null = null, target: number | null = null;
    if (step !== 'neutral' && neutral && sample.valid && sample.anchor) {
      const a = sample.anchor, n = neutral.position;
      offset = step === 'left' ? n.x - a.x : step === 'right' ? a.x - n.x : step === 'up' ? n.y - a.y : a.y - n.y;
      target = targetFor(step === 'left' || step === 'right' ? neutral.jitter.x : neutral.jitter.y);
    }
    const farEnough = step === 'neutral' ? Boolean(sample.valid) : offset !== null && target !== null && offset >= target;
    const steadyMs = this.hold.length > 1 ? this.hold.at(-1)!.at - this.hold[0]!.at : 0;
    if (this.nearNeutral.step !== step) this.nearNeutral = { step, seen: false };
    if (offset !== null && target !== null && Math.abs(offset) < target / 2) this.nearNeutral.seen = true;
    const wrongWay = this.nearNeutral.seen && offset !== null && target !== null && -offset >= target;
    this.state.guide = { step, offset, target, farEnough, steadyMs: farEnough ? steadyMs : 0, auto: this.autoCapture, wrongWay };
    // Spans of ≥ HOLD_MS minus one frame count as a full second of holding.
    if (this.autoCapture && farEnough && steadyMs >= HOLD_MS - 40) this.capture();
  }
  snapshot(): SetupSnapshot { return structuredClone(this.state); }
  private emit(): void { this.changed(this.snapshot()); }
}
