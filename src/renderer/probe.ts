import type { Mode, TrackingSample } from '../shared/contracts';
import { drawLandmarkOverlay, drawMirroredPreview, FrameGate, FrameProgress, SampleGate, SelectedHandContinuity, type HandLabel, type Landmark, type PreviewOverlay } from './tracking';

export interface ProbeReport {
  mode?: Mode; message: string; frames: number; delegate: string | null; running: boolean;
  selectedHand?: HandLabel | null; confirmationRequired?: boolean; cameraId?: string;
  width?: number; height?: number; frameRate?: number; validFrames?: number; staleFrames?: number;
  /** Nearest-rank p95 from bitmap dispatch to inference result receipt, milliseconds. */
  inferenceMsP95?: number;
  /** Latest rejection reason (qualityReason of an invalid sample), or null while samples are valid. */
  rejection?: string | null;
}
/** Camera ownership stays in the panel window, including while settings is closed/collapsed. */
export class CameraProbe {
  private stream: MediaStream | null = null;
  private worker: Worker | null = null;
  private video: HTMLVideoElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private watchdog: ReturnType<typeof setInterval> | undefined;
  private gate = new FrameGate();
  private progress = new FrameProgress();
  private results = new SampleGate();
  private continuity = new SelectedHandContinuity();
  private configuredHand: HandLabel | null = null;
  private frameCallback: number | undefined;
  private run = 0;
  private frame = 0;
  private validFrames = 0;
  private staleFrames = 0;
  private durations: number[] = [];
  private pending: { frameId: number; generation: number; timestamp: number; sent: number } | null = null;
  private delegate: string | null = null;
  private mode: Mode = 'head';
  private format: MediaTrackSettings = {};
  private overlay: PreviewOverlay | null = null;
  private rejection: string | null = null;
  constructor(private generation: () => number, private report: (value: ProbeReport) => void, private sample: (value: TrackingSample) => void, private fault: () => void) {}
  setSelectedHand(label: HandLabel | null, confirmed = false): void {
    this.configuredHand = label; this.continuity.setSelectedHand(label, confirmed);
  }
  confirmHand(): boolean {
    const confirmed = this.continuity.confirm(performance.now());
    this.emit(confirmed ? 'Selected hand confirmed; remains paused' : 'Show exactly the selected hand before confirming');
    return confirmed;
  }
  preview(canvas: HTMLCanvasElement | null): void { this.canvas = canvas; }
  private emit(message: string, running = true): void {
    const sorted = [...this.durations].sort((a, b) => a - b);
    this.report({ mode: this.mode, message, frames: this.frame, delegate: this.delegate, running,
      selectedHand: this.continuity.selectedHand, confirmationRequired: this.continuity.confirmationRequired,
      cameraId: this.format.deviceId, width: this.format.width, height: this.format.height, frameRate: this.format.frameRate,
      validFrames: this.validFrames, staleFrames: this.staleFrames, inferenceMsP95: sorted.length ? sorted[Math.ceil(sorted.length * 0.95) - 1] : 0, rejection: this.rejection });
  }
  async start(cameraId: string, mode: Mode): Promise<void> {
    this.stop(); this.mode = mode;
    this.continuity.setSelectedHand(this.configuredHand, false);
    const run = this.run;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { deviceId: cameraId ? { exact: cameraId } : undefined, width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } } });
      if (run !== this.run) { stream.getTracks().forEach(track => track.stop()); return; }
      this.stream = stream; this.format = stream.getVideoTracks()[0]?.getSettings() ?? {};
      for (const track of stream.getVideoTracks()) track.onended = () => this.fail('Camera disconnected');
      const video = document.createElement('video');
      video.muted = true; video.playsInline = true; video.srcObject = stream; this.video = video;
      await video.play();
      if (run !== this.run) return;
      if (typeof video.requestVideoFrameCallback !== 'function') throw new Error('Camera frame timing is unavailable');
      const receiveFrame: VideoFrameRequestCallback = (now, metadata) => {
        if (run !== this.run) return;
        this.progress.receive(metadata.mediaTime, now, metadata.captureTime);
        if (this.canvas) { drawMirroredPreview(this.canvas, video); drawLandmarkOverlay(this.canvas, this.overlay, performance.now()); }
        this.frameCallback = video.requestVideoFrameCallback(receiveFrame);
      };
      this.frameCallback = video.requestVideoFrameCallback(receiveFrame);
      const worker = new Worker(new URL('./vision.worker.ts', import.meta.url), { type: 'module' });
      this.worker = worker;
      worker.onerror = event => { if (run === this.run) this.fail(`Tracking worker failed: ${event.message}`); };
      worker.onmessage = (event: MessageEvent) => {
        if (run !== this.run) return;
        const value = event.data;
        if (value.type === 'ready') {
          this.delegate = value.delegate; this.schedule(run);
          this.watchdog = setInterval(() => {
            if (mode === 'palm' && this.continuity.expire(performance.now())) { this.fault(); this.emit('Selected hand lost; confirm selected hand'); }
          }, 10);
        } else if (value.type === 'sample') {
          const raw = value.sample as TrackingSample;
          const pending = this.pending;
          // Only the outstanding frame can release the one-frame gate.
          if (!pending || raw.frameId !== pending.frameId || raw.generation !== pending.generation || raw.captureTimestamp !== pending.timestamp) return;
          this.pending = null; this.gate.release();
          const now = performance.now();
          this.durations.push(now - pending.sent); if (this.durations.length > 1800) this.durations.shift();
          if (!this.results.accept(raw, this.generation(), mode, now)) { this.staleFrames++; this.emit('Stale inference result rejected'); return; }
          let output = raw;
          if (mode === 'palm') {
            const wasConfirmationRequired = this.continuity.confirmationRequired;
            const result = this.continuity.observe({ valid: raw.valid, anchor: raw.anchor, reason: raw.qualityReason }, raw.selectedHand ?? null, raw.captureTimestamp, now);
            this.configuredHand = this.continuity.selectedHand;
            if (!wasConfirmationRequired && this.continuity.confirmationRequired) this.fault();
            // Retain the first selected label across explicit restarts. A new
            // camera/mode selection is the only caller that deliberately clears it.
            this.configuredHand = this.continuity.selectedHand;
            output = { ...raw, valid: result.valid, anchor: result.anchor, qualityReason: result.reason, selectedHand: this.continuity.selectedHand };
          }
          if (output.valid) this.validFrames++;
          this.rejection = output.valid ? null : output.qualityReason;
          this.overlay = { mode, landmarks: Array.isArray(value.landmarks) ? (value.landmarks as Landmark[]) : [], valid: output.valid, receivedAt: now };
          this.sample(output); this.emit(output.qualityReason);
        } else if (value.type === 'fault') this.fail(String(value.message));
      };
      worker.postMessage({ type: 'initialize', mode, assetRoot: 'steady-resource://assets/' });
      this.emit('Initializing local detector…');
    } catch (error) { if (run === this.run) this.fail(`Camera probe failed: ${String(error)}`); }
  }
  private schedule(run: number): void {
    if (run !== this.run) return;
    this.timer = setTimeout(() => { void this.capture(run); }, 1000 / 30);
  }
  private async capture(run: number): Promise<void> {
    if (run !== this.run) return;
    this.schedule(run);
    if (!this.video || !this.worker || this.video.readyState < 2 || !this.gate.acquire()) return;
    const captureTimestamp = this.progress.take();
    if (captureTimestamp === null || performance.now() - captureTimestamp >= 250) { this.gate.release(); return; }
    const generation = this.generation();
    try {
      const bitmap = await createImageBitmap(this.video);
      if (run !== this.run || !this.worker) { bitmap.close(); return; }
      if (generation !== this.generation()) { bitmap.close(); this.gate.release(); return; }
      this.pending = { frameId: ++this.frame, generation, timestamp: captureTimestamp, sent: performance.now() };
      this.worker.postMessage({ type: 'frame', bitmap, captureTimestamp, frameId: this.frame, generation }, [bitmap]);
    } catch (error) { if (run === this.run) this.fail(`Frame capture failed: ${String(error)}`); }
  }
  private fail(message: string): void {
    const frames = this.frame, delegate = this.delegate;
    this.stop(); this.fault(); this.report({ mode: this.mode, message, frames, delegate, running: false });
  }
  stop(): void {
    this.run++; clearTimeout(this.timer); clearInterval(this.watchdog);
    this.worker?.terminate(); this.worker = null;
    this.stream?.getTracks().forEach(track => { track.onended = null; track.stop(); }); this.stream = null;
    if (this.video) { if (this.frameCallback !== undefined) this.video.cancelVideoFrameCallback(this.frameCallback); this.video.pause(); this.video.srcObject = null; }
    this.video = null; this.frameCallback = undefined;
    this.canvas?.getContext('2d')?.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.gate = new FrameGate(); this.progress = new FrameProgress(); this.results = new SampleGate(); this.pending = null;
    this.frame = 0; this.validFrames = 0; this.staleFrames = 0; this.durations = []; this.delegate = null; this.format = {}; this.overlay = null; this.rejection = null;
    this.continuity.setSelectedHand(this.configuredHand, false);
  }
}
