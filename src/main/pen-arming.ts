import type { InputState } from '../shared/contracts';

/**
 * "Armed" pen: a Pen Down request (panel, F8, voice or the rest gesture) made while the tracked pointer is
 * outside the canvas, e.g. on the Steady panel, cannot press there. It arms instead, and the pen goes down
 * when the pointer next enters the canvas. Armed survives leaving and re-entering the canvas (the native
 * helper lifts at the edge); pause, tracking loss, setup and Pen Up disarm. The native helper still
 * enforces every pen-down rule (HOVER, inside canvas, outside panel, fresh tracking, Krita foreground).
 */
export interface PenContext { native: InputState | undefined; buttonDown: boolean; inCanvas: boolean }
export type PenDecision = 'press' | 'disarm' | 'release' | 'not-tracking';
/** The native refusal that means "pointer not in the canvas (or on the panel)": arm instead of failing. */
export const OUTSIDE_CANVAS_CODES: readonly string[] = ['not-hover-or-canvas'];
export const ENGAGE_RETRY_MS = 500;
const TRACKING: readonly (InputState | undefined)[] = ['HOVER', 'DRAWING'];

export class PenArming {
  armed = false;
  private retryAt = 0;

  /**
   * Pen Down / Pen toggle requested. 'press' arms and asks the native helper to press now; the helper is
   * authoritative about the pointer position, and its outside-canvas refusal leaves the pen armed.
   */
  request(kind: 'down' | 'toggle', ctx: Omit<PenContext, 'inCanvas'>): PenDecision {
    if (kind === 'toggle' && ctx.buttonDown) { this.armed = false; return 'release'; }
    if (kind === 'toggle' && this.armed) { this.armed = false; return 'disarm'; }
    if (!TRACKING.includes(ctx.native)) { this.armed = false; return 'not-tracking'; }
    this.armed = true; this.retryAt = 0;
    return 'press';
  }
  /** Pen Up (or the lift gesture). */
  release(): void { this.armed = false; }
  /** On every tracked sample: press now? */
  shouldEngage(ctx: PenContext, now: number): boolean {
    return this.armed && ctx.native === 'HOVER' && !ctx.buttonDown && ctx.inCanvas && now >= this.retryAt;
  }
  /** Result of an engage attempt; a refusal backs off so samples don't flood the helper. */
  attempted(ok: boolean, now: number): void { if (!ok) this.retryAt = now + ENGAGE_RETRY_MS; }
  /** Native state changed: anything but active tracking disarms. */
  native(state: InputState | undefined): boolean {
    if (this.armed && !TRACKING.includes(state)) { this.armed = false; return true; }
    return false;
  }
}
