import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import path from 'node:path';

/** Bounded, ordered diagnostic writes. Disk latency never blocks input or capture. */
export class BufferedLog {
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private size: number | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private flushing: Promise<void> | null = null;
  constructor(private readonly filename: string, private readonly maxBytes = 1_000_000) {}
  write(value: string | Buffer): void {
    const bytes = Buffer.from(value);
    if (bytes.length > this.maxBytes) return;
    while (this.pendingBytes + bytes.length > this.maxBytes) this.pendingBytes -= this.pending.shift()!.length;
    this.pending.push(bytes); this.pendingBytes += bytes.length;
    if (!this.timer && !this.flushing) {
      this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, 50);
      this.timer.unref();
    }
  }
  async flush(): Promise<void> {
    clearTimeout(this.timer); this.timer = undefined;
    if (this.flushing) return this.flushing;
    this.flushing = this.drain();
    try { await this.flushing; }
    finally { this.flushing = null; if (this.pending.length) await this.flush(); }
  }
  private async drain(): Promise<void> {
    try {
      await mkdir(path.dirname(this.filename), { recursive: true });
      if (this.size === null) {
        try { this.size = (await stat(this.filename)).size; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; this.size = 0; }
      }
      while (this.pending.length) {
        const batch = this.pending; this.pending = []; this.pendingBytes = 0;
        const bytes = Buffer.concat(batch);
        if (this.size + bytes.length > this.maxBytes) {
          if (this.size > 0) await rename(this.filename, `${this.filename}.1`);
          this.size = 0;
        }
        await appendFile(this.filename, bytes, { mode: 0o600 }); this.size += bytes.length;
      }
    } catch { this.pending = []; this.pendingBytes = 0; this.size = null; /* Diagnostics cannot break drawing. */ }
  }
}
