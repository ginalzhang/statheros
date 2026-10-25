import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** PID lock so a second instance never opens a second voice pipeline (prompt §4.5). */
export class PidLock {
  private held = false;
  constructor(private readonly filename: string, private readonly pid = process.pid, private readonly alive: (pid: number) => boolean = pidAlive) {}
  acquire(): boolean {
    mkdirSync(path.dirname(this.filename), { recursive: true });
    try {
      const owner = Number(readFileSync(this.filename, 'utf8').trim());
      if (Number.isSafeInteger(owner) && owner > 0 && owner !== this.pid && this.alive(owner)) return false;
    } catch { /* no lock yet */ }
    writeFileSync(this.filename, `${this.pid}\n`, { mode: 0o600 });
    this.held = true;
    return true;
  }
  release(): void {
    if (!this.held) return;
    try { if (Number(readFileSync(this.filename, 'utf8').trim()) === this.pid) rmSync(this.filename); } catch { /* gone */ }
    this.held = false;
  }
}
function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}
