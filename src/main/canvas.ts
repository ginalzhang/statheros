import type { Point, Rect } from '../shared/contracts';

export function containsPoint(rect: Rect, point: Point): boolean {
  return point.x >= rect.x && point.y >= rect.y && point.x < rect.x + rect.width && point.y < rect.y + rect.height;
}
export function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}
export function validateCanvas(first: Point, second: Point, display: Rect, excluded: readonly Rect[]): Rect {
  if (![first.x, first.y, second.x, second.y].every(Number.isFinite)) throw new Error('Canvas corners must be finite screen coordinates.');
  const canvas = { x: first.x, y: first.y, width: second.x - first.x, height: second.y - first.y };
  if (canvas.width < 100 || canvas.height < 100) throw new Error('Mark the top-left corner first, then a bottom-right corner at least 100 × 100 logical points away.');
  if (canvas.x < display.x || canvas.y < display.y || canvas.x + canvas.width > display.x + display.width || canvas.y + canvas.height > display.y + display.height) throw new Error('Canvas must fit inside the selected display.');
  if (excluded.some(rect => intersects(rect, canvas))) throw new Error('Canvas intersects the Steady panel. Move the panel or mark a smaller canvas.');
  return canvas;
}
/** Keep a reviewed suggestion useful without weakening the panel exclusion rule.
 * A single panel divides the suggestion into four possible rectangular strips.
 * Keep the largest valid strip; if none fits, leave the outline for manual redraw.
 */
export function fitWorkspaceSuggestion(suggestion: Rect, display: Rect, panel: Rect | null): Rect {
  const original = validateCanvas(suggestion, { x: suggestion.x + suggestion.width, y: suggestion.y + suggestion.height }, display, []);
  if (!panel || !intersects(original, panel)) return original;
  const right = original.x + original.width, bottom = original.y + original.height;
  const candidates: Rect[] = [
    { ...original, width: panel.x - original.x },
    { ...original, x: panel.x + panel.width, width: right - panel.x - panel.width },
    { ...original, height: panel.y - original.y },
    { ...original, y: panel.y + panel.height, height: bottom - panel.y - panel.height },
  ];
  const valid = candidates.filter(candidate => candidate.width >= 100 && candidate.height >= 100 &&
    candidate.x >= original.x && candidate.y >= original.y && candidate.x + candidate.width <= right &&
    candidate.y + candidate.height <= bottom && !intersects(candidate, panel));
  return valid.reduce((largest, candidate) => !largest || candidate.width * candidate.height > largest.width * largest.height ? candidate : largest, null as Rect | null) ?? original;
}
export class CanvasCapture {
  active = false;
  firstCorner: Point | null = null;
  message = 'Canvas must be confirmed each launch.';
  begin(): void { this.active = true; this.firstCorner = null; this.message = 'Pen is forced up. Keep Krita foreground; mark the top-left corner with F8, then the bottom-right corner.'; }
  cancel(): void { this.active = false; this.firstCorner = null; this.message = 'Canvas setup canceled; input stays paused.'; }
  mark(position: Point, display: Rect, excluded: readonly Rect[]): Rect | null {
    if (!this.active) throw new Error('Begin canvas setup before marking corners.');
    if (!Number.isFinite(position.x) || !Number.isFinite(position.y) || !containsPoint(display, position)) throw new Error('Corner must be inside the selected display.');
    if (excluded.some(rect => containsPoint(rect, position))) throw new Error('Corner is over the Steady panel.');
    if (!this.firstCorner) { this.firstCorner = { ...position }; this.message = 'Top-left captured. Mark the bottom-right corner with F8.'; return null; }
    const canvas = validateCanvas(this.firstCorner, position, display, excluded);
    this.active = false; this.firstCorner = null; this.message = 'Canvas confirmed. Input stays paused; explicitly Resume when ready.';
    return canvas;
  }
  snapshot(): { active: boolean; firstCorner: Point | null; message: string } { return { active: this.active, firstCorner: this.firstCorner && { ...this.firstCorner }, message: this.message }; }
}
