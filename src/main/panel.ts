import type { DisplayInfo } from '../shared/contracts';
export function preferredDisplay(displays:DisplayInfo[],selected?:number):DisplayInfo|undefined {
  return displays.find(display=>display.id===selected)??displays.find(display=>display.builtIn)??displays.find(display=>display.primary)??displays[0];
}
/** Statheros control panel (Figma: 300 px wide; header-only when minimized). */
export const PANEL_WIDTH=300, PANEL_HEIGHT=660, PANEL_COLLAPSED_HEIGHT=48;
export function panelPosition(display:DisplayInfo):{x:number;y:number} {
  return {x:display.workArea.x+display.workArea.width-PANEL_WIDTH-16,y:display.workArea.y+16};
}
