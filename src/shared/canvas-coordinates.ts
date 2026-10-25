import type { Point, Rect } from './contracts';

/** Browser content bounds and Quartz screen geometry are logical points.
 * Use the measured content origin: macOS may move a requested fullscreen-sized
 * auxiliary window below its menu bar. Display origin is not a substitute.
 */
export function screenRectToSurface(rect: Rect, surface: Rect): Rect {
  return { x: rect.x - surface.x, y: rect.y - surface.y, width: rect.width, height: rect.height };
}

/** Pointer capture may deliver positions outside the surface. Keep the resulting
 * screen point on the selected display, without applying a Retina multiplier.
 */
export function surfacePointToScreen(point: Point, surface: Rect, display: Rect): Point {
  return {
    x: Math.max(display.x, Math.min(display.x + display.width, surface.x + point.x)),
    y: Math.max(display.y, Math.min(display.y + display.height, surface.y + point.y)),
  };
}

export function rectangleBetween(a: Point, b: Point): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) };
}
