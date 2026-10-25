/**
 * Steady icon family (Figma "Steady — Krita icon set": 24 px grid, 1.5 px stroke, round caps/joins,
 * currentColor; hollow = up/off, filled = down/on). Designer-traced glyphs first, utility glyphs after.
 */
export type IconName =
  | 'penUp' | 'penDown' | 'latch' | 'pauseTracking' | 'recenter' | 'steadiness' | 'micOff' | 'micOn' | 'calibrate'
  | 'cursor' | 'eraser' | 'undo' | 'redo' | 'brush' | 'bigger' | 'smaller' | 'sparkle' | 'gear' | 'chevronDown' | 'chevronUp' | 'close' | 'corner' | 'resumeTracking' | 'pause' | 'sliders' | 'hand' | 'alert';

const NIB = 'M11.5 4.8 L17.3 10.2 L11.3 16 C9.5 17.7 6.6 17.1 5.8 15 C5.3 13.6 5.7 11.9 6.7 10.5 Z';
const glyphs: Record<IconName, React.JSX.Element> = {
  penUp: <><path d={NIB} /><path d="M14.6 7.1 L18.4 3.6" /><path d="M5.3 19.9 H12.4" /></>,
  penDown: <><path d={NIB} fill="currentColor" /><path d="M14.6 7.1 L18.4 3.6" /><path d="M5.3 19.9 H12.4" /></>,
  latch: <><path d="M9.4 4 L13.6 8 L8.9 12.4 C7.6 13.6 5.4 13.2 4.7 11.6 C4.3 10.6 4.6 9.3 5.4 8.3 Z" /><path d="M11.9 5.6 L14.6 3.4" /><rect x="12.9" y="14.9" width="7.4" height="5.6" rx="1.5" /><path d="M15 14.9 V11.6 A1.75 1.75 0 0 1 18.5 11.6 V14.9" /></>,
  pauseTracking: <><path d="M5.4 12.2 L3.6 10.6 C2.9 10 3.2 8.9 4.1 8.9 C4.6 8.9 5 9.2 5.4 9.6 L6.1 10.3 V5.5 C6.1 4.8 6.6 4.3 7.2 4.3 C7.8 4.3 8.3 4.8 8.3 5.5 V9.2 V3.9 C8.3 3.2 8.8 2.8 9.4 2.8 C10 2.8 10.5 3.2 10.5 3.9 V9.2 V4.5 C10.5 3.8 11 3.4 11.6 3.4 C12.2 3.4 12.7 3.8 12.7 4.5 V9.4 V6.3 C12.7 5.7 13.2 5.2 13.8 5.2 C14.4 5.2 14.9 5.7 14.9 6.3 V12 C14.9 13 14.6 13.9 14 14.7 L12.9 16.2 V19.6 H6.6 V16.4 C6.6 15.7 6.3 15.1 5.9 14.6 Z" /><path d="M17.4 15.2 V21" /><path d="M20.7 15.2 V21" /></>,
  recenter: <><rect x="4" y="4" width="16" height="16" rx="3.5" /><path d="M12 7 V10" /><path d="M12 14 V17" /><path d="M7 12 H10" /><path d="M14 12 H17" /><circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none" /></>,
  steadiness: <><path d="M4.2 9.6 C5.2 7.9 6.4 8.4 7.4 9.9 C8.6 11.8 9.9 12 11 9.6 C12 7.2 13 5.6 14.2 6.2 C15.6 6.9 16.4 9.6 17.2 11.4 C17.9 13 19.2 13.3 20 9.9" /><path d="M4 17.8 H20" /></>,
  micOff: <><rect x="9" y="3.5" width="6" height="11" rx="3" /><path d="M6 10.3 V11 A6 6 0 0 0 18 11 V10.3" /><path d="M12 17 V20.3" /><path d="M9 20.3 H15" /></>,
  micOn: <><rect x="9" y="3.5" width="6" height="11" rx="3" fill="currentColor" /><path d="M6 10.3 V11 A6 6 0 0 0 18 11 V10.3" /><path d="M12 17 V20.3" /><path d="M9 20.3 H15" /></>,
  calibrate: <><path d="M19.9 14.2 A7 7 0 1 1 16.4 6.3" /><path d="M17.9 3.4 V7.4 H13.9" /><circle cx="12" cy="12.6" r="1.4" fill="currentColor" stroke="none" /></>,
  cursor: <path d="M6 4 L18 12.2 L12.6 13.4 L15.4 19.2 L13.2 20.2 L10.4 14.4 L6 18 Z" />,
  eraser: <><path d="M14.2 4.8 L19.2 9.8 L10.8 18.2 H6.6 L4.8 16.4 C4.2 15.8 4.2 14.8 4.8 14.2 Z" /><path d="M9.6 9.4 L14.6 14.4" /><path d="M10.8 18.2 H19" /></>,
  undo: <><path d="M9 7.5 L5 11.5 L9 15.5" /><path d="M5.5 11.5 H14 C17 11.5 19 13.5 19 16.2 V17.5" /></>,
  redo: <><path d="M15 7.5 L19 11.5 L15 15.5" /><path d="M18.5 11.5 H10 C7 11.5 5 13.5 5 16.2 V17.5" /></>,
  brush: <><path d="M19.5 4.5 L11.2 12.8" /><path d="M10.6 12.2 L12.8 14.4 C12.4 17.4 10.4 19.4 7.2 19.6 C5.8 19.7 4.6 19.4 4.4 19.2 C5.8 18.2 6 16.8 6.4 15.6 C7 13.8 8.6 12.4 10.6 12.2 Z" /></>,
  bigger: <><circle cx="10" cy="12" r="5.6" /><path d="M18 9 V15" /><path d="M15 12 H21" /></>,
  smaller: <><circle cx="10" cy="12" r="3.4" /><path d="M15 12 H21" /></>,
  sparkle: <path d="M12 3.6 C12.6 8 14 9.4 18.4 10 C14 10.6 12.6 12 12 16.4 C11.4 12 10 10.6 5.6 10 C10 9.4 11.4 8 12 3.6 Z M18 15.4 C18.2 16.9 18.7 17.4 20.2 17.6 C18.7 17.8 18.2 18.3 18 19.8 C17.8 18.3 17.3 17.8 15.8 17.6 C17.3 17.4 17.8 16.9 18 15.4 Z" />,
  // Gear after Lucide "settings" (ISC).
  gear: <><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" /><circle cx="12" cy="12" r="3" /></>,
  chevronDown: <path d="M7 10 L12 15 L17 10" />,
  chevronUp: <path d="M7 14 L12 9 L17 14" />,
  close: <path d="M7 7 L17 17 M17 7 L7 17" />,
  resumeTracking: <path d="M8 5.5 V18.5 L18.5 12 Z" />,
  // Statheros 2 header: Pause/Play and Tune (sliders) beside collapse and close.
  pause: <><path d="M9 6 V18" /><path d="M15 6 V18" /></>,
  sliders: <><path d="M4 7 H14" /><path d="M18 7 H20" /><circle cx="16" cy="7" r="2" /><path d="M4 17 H6" /><path d="M10 17 H20" /><circle cx="8" cy="17" r="2" /></>,
  hand: <><path d="M8 12.5 V6.5 A1.25 1.25 0 0 1 10.5 6.5 V11 V4.8 A1.25 1.25 0 0 1 13 4.8 V11 V5.8 A1.25 1.25 0 0 1 15.5 5.8 V11.5 V8.3 A1.25 1.25 0 0 1 18 8.3 V13.5 C18 17.4 15.6 20 12.4 20 C10.2 20 8.8 19 7.6 17.3 L5.2 13.8 A1.3 1.3 0 0 1 7.3 12.3 Z" /></>,
  alert: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.8 V12.6" /><circle cx="12" cy="16" r="0.9" fill="currentColor" stroke="none" /></>,
  corner: <><path d="M5 10 V5 H10" /><path d="M14 19 H19 V14" /><circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" /></>,
};

export function Icon({ name, size = 20 }: { name: IconName; size?: number }): React.JSX.Element {
  return <svg className="icon-glyph" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">{glyphs[name]}</svg>;
}
