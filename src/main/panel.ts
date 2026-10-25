import type { DisplayInfo, Rect } from '../shared/contracts';
export function preferredDisplay(displays:DisplayInfo[],selected?:number):DisplayInfo|undefined {
  return displays.find(display=>display.id===selected)??displays.find(display=>display.builtIn)??displays.find(display=>display.primary)??displays[0];
}
export function panelPosition(display:DisplayInfo):{x:number;y:number} {
  return {x:display.workArea.x+display.workArea.width-320-16,y:display.workArea.y+16};
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
  const width = Math.min(320, display.bounds.width), height = Math.min(560, display.bounds.height);
  const onDisplay = panel.x < display.bounds.x + display.bounds.width && display.bounds.x < panel.x + panel.width &&
    panel.y < display.bounds.y + display.bounds.height && display.bounds.y < panel.y + panel.height;
  const anchor = onDisplay ? panel : panelPosition(display);
  return {
    x: Math.max(display.bounds.x, Math.min(anchor.x, display.bounds.x + display.bounds.width - width)),
    y: Math.max(display.bounds.y, Math.min(anchor.y, display.bounds.y + display.bounds.height - height)),
    width, height,
  };
}
