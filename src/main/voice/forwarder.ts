import { CHUNK_BYTES, type Frame, type RingBuffer } from './audio';

/** The write side of one STT socket. */
export interface AudioSink {
  readonly isOpen: boolean;
  sendAudio(pcm: Buffer): boolean;
  finalize(): void;
  close(): void;
}
export interface PacingClock { now(): number; every(ms: number, tick: () => void): () => void }
export const realClock: PacingClock = {
  now: () => performance.now() / 1000,
  every: (ms, tick) => { const handle = setInterval(tick, ms); return () => clearInterval(handle); },
};

type Control = { kind: 'finalize' | 'close'; afterByte: number };

/**
 * The only code path that sends audio (prompt §4.5). Every binary write checks `gate`;
 * a chunk reaching the write site with the gate off is discarded, never held.
 * Backlog: first 1 s back-to-back, the rest at 2× real time, then live at real time.
 */
export class Forwarder {
  gate = false;
  private sink: AudioSink | null = null;
  private forwarding = false;
  private pending = Buffer.alloc(0);
  private queued = 0; // bytes ever queued for this sink
  private sent = 0;   // bytes sent or discarded
  private burst = 0;  // bytes allowed back-to-back
  private controls: Control[] = [];
  private stopTick: (() => void) | null = null;
  private lastPaced = 0;
  private padding: { until: number; then: () => void } | null = null;
  /** Telemetry: first binary byte per sink, and a test hook for every write. */
  onFirstByte: (() => void) | null = null;
  onWrite: ((bytes: number) => void) | null = null;
  private firstByteSent = false;

  constructor(private readonly ring: RingBuffer, private readonly clock: PacingClock = realClock) {}

  attach(sink: AudioSink): void {
    this.detach();
    this.sink = sink; this.firstByteSent = false;
    this.stopTick = this.clock.every(25, () => this.pump());
  }
  detach(): void {
    this.stopTick?.(); this.stopTick = null;
    this.sink = null; this.forwarding = false; this.padding = null;
    this.pending = Buffer.alloc(0); this.queued = this.sent = this.burst = 0; this.controls = [];
  }
  get isForwarding(): boolean { return this.forwarding; }

  /** Idempotent. `null` = from the newest frame onward. Queued in RAM until the socket opens. */
  start(fromTs: number | null): void {
    if (this.forwarding || !this.sink) return;
    this.forwarding = true;
    const backlog = this.ring.readFrom(fromTs);
    for (const frame of backlog) this.enqueue(frame.pcm);
    this.burst = Math.min(this.pending.length, CHUNK_BYTES * 10);
    this.lastPaced = this.clock.now();
    this.pump();
  }
  /** Discards queued-but-unsent audio so later control frames go out immediately. */
  stop(): void {
    this.forwarding = false; this.padding = null;
    this.sent = this.queued; this.pending = Buffer.alloc(0); this.burst = 0;
    this.pump();
  }
  /** Live frame from the tap (already appended to the ring buffer). */
  push(frame: Frame): void {
    if (this.forwarding) { this.enqueue(frame.pcm); this.pump(); }
  }
  /** Enqueued behind pending audio. Dropped if the socket never opened. */
  control(kind: 'finalize' | 'close'): void {
    if (!this.sink) return;
    this.controls.push({ kind, afterByte: this.queued });
    this.pump();
  }
  /** pad_then_close: zeros only, gate on, then `then()` closes. */
  padZeros(seconds: number, then: () => void): void {
    this.stop();
    this.padding = { until: this.clock.now() + seconds, then };
    this.lastPaced = this.clock.now();
  }

  private enqueue(pcm: Int16Array): void {
    const bytes = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    this.pending = Buffer.concat([this.pending, bytes]);
    this.queued += bytes.length;
  }
  private write(chunk: Buffer): void {
    this.sent += chunk.length;
    if (!this.gate || !this.sink) return; // gate off: discard, never hold
    if (this.sink.sendAudio(chunk)) {
      this.onWrite?.(chunk.length);
      if (!this.firstByteSent) { this.firstByteSent = true; this.onFirstByte?.(); }
    }
  }
  private pump(): void {
    const sink = this.sink;
    if (!sink || !sink.isOpen) return;
    const now = this.clock.now();
    if (this.padding) {
      const elapsed = now - this.lastPaced;
      const zeros = Math.floor(elapsed / 0.1);
      for (let i = 0; i < zeros; i++) this.write(Buffer.alloc(CHUNK_BYTES));
      if (zeros) this.lastPaced += zeros * 0.1;
      if (now >= this.padding.until) { const then = this.padding.then; this.padding = null; then(); }
      return;
    }
    // Controls due before any more audio.
    this.flushControls(sink);
    while (this.pending.length >= CHUNK_BYTES || (this.pending.length && this.nextControlDue())) {
      const behind = this.pending.length > CHUNK_BYTES * 2;
      if (this.burst > 0) this.burst -= CHUNK_BYTES;
      else {
        const interval = behind ? 0.05 : 0.1; // 2× real time while catching up
        // A due control frame only flushes a trailing partial chunk; it never bypasses pacing.
        if (now - this.lastPaced < interval - 1e-3 && !(this.pending.length < CHUNK_BYTES && this.nextControlDue())) break;
        this.lastPaced = Math.max(this.lastPaced + interval, now - interval);
      }
      const size = Math.min(CHUNK_BYTES, this.pending.length);
      const chunk = this.pending.subarray(0, size);
      this.pending = this.pending.subarray(size);
      this.write(Buffer.from(chunk));
      this.flushControls(sink);
    }
  }
  private nextControlDue(): boolean { return this.controls.length > 0 && this.controls[0]!.afterByte <= this.queued && this.controls[0]!.afterByte > this.sent; }
  private flushControls(sink: AudioSink): void {
    while (this.controls.length && this.controls[0]!.afterByte <= this.sent) {
      const control = this.controls.shift()!;
      if (control.kind === 'finalize') sink.finalize(); else sink.close();
    }
  }
}
