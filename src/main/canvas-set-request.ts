export interface CanvasSetContext {
  generation: number;
  targetPid: number;
  displayId: number;
}

/** One explicit Set canvas request; observation handling must never wait on its timer. */
export class CanvasSetRequest {
  current: Readonly<CanvasSetContext> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  start(context: CanvasSetContext, timedOut: (request: Readonly<CanvasSetContext>) => void): void {
    this.cancel();
    const request = this.current = { ...context };
    this.timer = setTimeout(() => {
      if (this.current === request) timedOut(request);
    }, 10_000);
  }

  matches(context: CanvasSetContext): boolean {
    return this.current !== null && this.current.generation === context.generation &&
      this.current.targetPid === context.targetPid && this.current.displayId === context.displayId;
  }

  consume(request: Readonly<CanvasSetContext>): boolean {
    if (this.current !== request) return false;
    this.cancel();
    return true;
  }

  cancel(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.current = null;
  }
}
