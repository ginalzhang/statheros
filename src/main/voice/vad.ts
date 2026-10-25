import { FRAME_SECONDS } from './audio';

export type VadEvent = { type: 'VadSpeechStart'; ts: number } | { type: 'VadSpeechEnd'; ts: number; speechMs: number };

/**
 * Hysteresis over a per-frame "above threshold" signal (prompt §6.3): start after 2 consecutive frames,
 * end after `hangoverMs` below threshold; speech_ms excludes the hangover.
 */
export class LocalVad {
  private run = 0;
  private active = false;
  private raw = false;
  private startTs = 0;
  private lastAboveEnd = 0;
  constructor(private readonly hangoverMs: number) {}
  get isActive(): boolean { return this.active; }
  get rawActive(): boolean { return this.raw; }
  /** `ts` = frame start (seconds). */
  process(above: boolean, ts: number): VadEvent | null {
    this.raw = above;
    if (above) {
      this.run++;
      this.lastAboveEnd = ts + FRAME_SECONDS;
      if (!this.active && this.run >= 2) {
        this.active = true;
        this.startTs = ts - FRAME_SECONDS;
        return { type: 'VadSpeechStart', ts: this.startTs };
      }
      return null;
    }
    this.run = 0;
    if (this.active && ts + FRAME_SECONDS - this.lastAboveEnd >= this.hangoverMs / 1000) {
      this.active = false;
      return { type: 'VadSpeechEnd', ts: ts + FRAME_SECONDS, speechMs: Math.round((this.lastAboveEnd - this.startTs) * 1000) };
    }
    return null;
  }
  reset(): void { this.run = 0; this.active = false; this.raw = false; }
}

/** RMS fallback when Silero cannot load (−35 dBFS, same hysteresis). */
export function energyAbove(pcm: Int16Array, thresholdDbfs = -35): boolean {
  let sum = 0;
  for (const sample of pcm) sum += sample * sample;
  const rms = Math.sqrt(sum / Math.max(1, pcm.length));
  return rms > 0 && 20 * Math.log10(rms / 32768) > thresholdDbfs;
}
