import type { NativeState } from '../shared/contracts';

const ACCESSIBILITY = 'Steady needs Accessibility access: System Settings › Privacy & Security › Accessibility, turn on Steady, then Recover native helper';
const FOREGROUND = 'Click into your Krita document first: Steady only sends commands while Krita is the front app';

/** Turns a native rejection code into the step the user can take; unknown codes pass through unchanged. */
export function explainRejection(code: string, native: NativeState | null): string {
  switch (code) {
    case 'foreground-or-permission':
      return native && !native.permissions.accessibility ? ACCESSIBILITY : FOREGROUND;
    case 'foreground': return FOREGROUND;
    case 'prerequisites': return 'Resume needs the camera on, a set canvas and half a second of steady tracking';
    case 'not-hover-or-canvas': case 'not-hover-or-panel': return 'Resume tracking and point inside the canvas first';
    case 'display-reconfiguration-pending': return 'The display changed: set the canvas again';
    case 'canvas-bounds': return 'The canvas must be at least 100 × 100 points, on one display, and clear of the Statheros panel and Camera Preview';
    default: return code;
  }
}
