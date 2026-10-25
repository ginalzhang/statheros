import type { DisplayInfo, Rect } from '../shared/contracts';
export function preferredDisplay(displays:DisplayInfo[],selected?:number):DisplayInfo|undefined {
  return displays.find(display=>display.id===selected)??displays.find(display=>display.builtIn)??displays.find(display=>display.primary)??displays[0];
}
/** Statheros control panel (Figma: 300 px wide; header-only when minimized). */
export const PANEL_WIDTH=300, PANEL_HEIGHT=660, PANEL_COLLAPSED_HEIGHT=48;
export function panelPosition(display:DisplayInfo):{x:number;y:number} {
  return {x:display.workArea.x+display.workArea.width-PANEL_WIDTH-16,y:display.workArea.y+16};
}

/** Figma (Statheros 2): the Camera Preview is a separate movable window, never nested in the panel. */
export type UtilityView = 'preview';
export const UTILITY_SIZE: Record<UtilityView, { width: number; height: number }> = {
  preview: { width: 200, height: 180 },
};
/** Figma scene (1440 × 900): Camera Preview at x238, 88 pt above the bottom. */
export function utilityPosition(view: UtilityView, workArea: Rect): { x: number; y: number } {
  const { width, height } = UTILITY_SIZE[view];
  return {
    x: Math.round(Math.max(workArea.x, Math.min(workArea.x + workArea.width * 238 / 1440, workArea.x + workArea.width - width))),
    y: Math.round(Math.max(workArea.y, workArea.y + workArea.height - height - 88)),
  };
}

/** The helper refuses a canvas that intersects an excluded rect, and the Camera Preview is excluded.
 * Returns the nearest origin that keeps the preview inside the work area and clear of the canvas and
 * the given rects (8 pt gap), or null when nothing fits. */
export function previewClearOf(preview: Rect, canvas: Rect, workArea: Rect, avoid: readonly Rect[]): { x: number; y: number } | null {
  const gap = 8, grow = (r: Rect): Rect => ({ x: r.x - gap, y: r.y - gap, width: r.width + 2 * gap, height: r.height + 2 * gap });
  const blocked = [canvas, ...avoid].map(grow);
  const overlaps = (a: Rect, b: Rect): boolean => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
  const maxX = workArea.x + workArea.width - preview.width, maxY = workArea.y + workArea.height - preview.height;
  if (maxX < workArea.x || maxY < workArea.y) return null;
  // Candidate coordinates: every edge just outside a blocked rect, plus the work-area edges.
  const xs = new Set([workArea.x, maxX, preview.x]), ys = new Set([workArea.y, maxY, preview.y]);
  for (const r of blocked) { xs.add(r.x - preview.width); xs.add(r.x + r.width); ys.add(r.y - preview.height); ys.add(r.y + r.height); }
  let best: { x: number; y: number } | null = null, bestDistance = Infinity;
  for (const rawX of xs) for (const rawY of ys) {
    const x = Math.round(Math.min(maxX, Math.max(workArea.x, rawX))), y = Math.round(Math.min(maxY, Math.max(workArea.y, rawY)));
    const at = { x, y, width: preview.width, height: preview.height };
    if (blocked.some(r => overlaps(at, r))) continue;
    const distance = Math.hypot(x - preview.x, y - preview.y);
    if (distance < bestDistance) { best = { x, y }; bestDistance = distance; }
  }
  return best;
}

/** Settings modal (~860 × 690) floats over Krita beside the compact panel; Figma scene x180, y100. */
export const SETTINGS_WIDTH = 860, SETTINGS_HEIGHT = 690;
export function settingsFrame(workArea: Rect): Rect {
  const width = Math.min(SETTINGS_WIDTH, workArea.width), height = Math.min(SETTINGS_HEIGHT, workArea.height);
  return {
    x: Math.round(Math.max(workArea.x, Math.min(workArea.x + workArea.width * 180 / 1440, workArea.x + workArea.width - width))),
    y: Math.round(Math.max(workArea.y, Math.min(workArea.y + workArea.height * 100 / 900, workArea.y + workArea.height - height))),
    width, height,
  };
}

/** Transient upper-left notifications (replace the persistent toolbar). The window includes an 8 pt shadow margin. */
export const TOAST_WIDTH = 268, TOAST_HEIGHT = 64;
export function toastPosition(workArea: Rect): { x: number; y: number } {
  return { x: workArea.x + 14, y: workArea.y + 38 };
}

/** Fullscreen/Spaces work-area animations do not move a selection's screen frame. */
export function sameCanvasSelectionDisplay(previous: DisplayInfo | undefined, current: DisplayInfo | undefined): boolean {
  return Boolean(previous && current && previous.id === current.id && previous.scaleFactor === current.scaleFactor &&
    previous.bounds.x === current.bounds.x && previous.bounds.y === current.bounds.y &&
    previous.bounds.width === current.bounds.width && previous.bounds.height === current.bounds.height);
}

/** Reuse the panel's screen location, expanding collapsed controls only for setup.
 * Clamp on the owning display so confirmation/cancellation remain reachable.
 */
export function canvasSelectionControlsFrame(panel: Rect, display: DisplayInfo): Rect {
  const width = Math.min(PANEL_WIDTH, display.bounds.width), height = Math.min(PANEL_HEIGHT, display.bounds.height);
  const onDisplay = panel.x < display.bounds.x + display.bounds.width && display.bounds.x < panel.x + panel.width &&
    panel.y < display.bounds.y + display.bounds.height && display.bounds.y < panel.y + panel.height;
  const anchor = onDisplay ? panel : panelPosition(display);
  return {
    x: Math.max(display.bounds.x, Math.min(anchor.x, display.bounds.x + display.bounds.width - width)),
    y: Math.max(display.bounds.y, Math.min(anchor.y, display.bounds.y + display.bounds.height - height)),
    width, height,
  };
}
