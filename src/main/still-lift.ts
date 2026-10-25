import type { Point } from '../shared/contracts';

/** Each stroke must move 15 pt before a 1.2 s dwell within 7.5 pt can lift it. */
export class StillLift {
  private origin: Point | null = null;
  private armed = false;
  private anchor: { position: Point; since: number } | null = null;
  reset(): void { this.origin = null; this.armed = false; this.anchor = null; }
  update(position: Point, now: number): boolean {
    const distance = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);
    this.origin ??= position;
    this.armed ||= distance(position, this.origin) > 15;
    if (!this.armed) return false;
    if (!this.anchor || distance(position, this.anchor.position) > 7.5) {
      this.anchor = { position, since: now }; return false;
    }
    if (now - this.anchor.since < 1200) return false;
    this.reset(); return true;
  }
}
