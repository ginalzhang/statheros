/** 16 kHz mono int16 frames of 1280 samples (80 ms). */
export const FRAME_SAMPLES = 1280;
export const SAMPLE_RATE = 16000;
export const FRAME_SECONDS = FRAME_SAMPLES / SAMPLE_RATE;
export const CHUNK_BYTES = 3200; // 100 ms at 16 kHz s16le

export interface Frame { pcm: Int16Array; ts: number }

/** RAM-only pre-roll. One reader: the Forwarder. Zeroed on CloseCapture. */
export class RingBuffer {
  private frames: Frame[] = [];
  constructor(private readonly capacity: number) {}
  append(frame: Frame): void {
    this.frames.push(frame);
    if (this.frames.length > this.capacity) this.frames.shift();
  }
  /** Frames starting at `ts` (clamped to the oldest); `null` = from the newest frame onward (nothing buffered). */
  readFrom(ts: number | null): Frame[] {
    if (ts === null) return [];
    return this.frames.filter(frame => frame.ts + FRAME_SECONDS > ts);
  }
  clear(): void { for (const frame of this.frames) frame.pcm.fill(0); this.frames = []; }
  get size(): number { return this.frames.length; }
}

export function peakDbfs(pcm: Int16Array): number {
  let peak = 0;
  for (const sample of pcm) { const value = Math.abs(sample); if (value > peak) peak = value; }
  return peak === 0 ? -Infinity : 20 * Math.log10(peak / 32768);
}
export const isSilentZero = (pcm: Int16Array): boolean => pcm.every(sample => sample === 0);
