import { describe, expect, it } from 'vitest';
import { ENGAGE_RETRY_MS, OUTSIDE_CANVAS_CODES, PenArming } from '../src/main/pen-arming';
import { defaultSettings, isSettingsV1 } from '../src/shared/settings';

const hover = (inCanvas: boolean, buttonDown = false) => ({ native: 'HOVER' as const, buttonDown, inCanvas });

describe('armed pen', () => {
  it('asks the native helper to press and stays armed for re-entry', () => {
    const pen = new PenArming();
    expect(pen.request('down', hover(false))).toBe('press');
    expect(pen.armed).toBe(true);
    expect(OUTSIDE_CANVAS_CODES).toContain('not-hover-or-canvas');
  });
  it('engages on entering the canvas, re-engages after drifting out, backs off after a refusal', () => {
    const pen = new PenArming(); pen.request('down', hover(false));
    expect(pen.shouldEngage(hover(false), 0)).toBe(false);
    expect(pen.shouldEngage(hover(true), 0)).toBe(true);
    pen.attempted(false, 100);
    expect(pen.shouldEngage(hover(true), 100 + ENGAGE_RETRY_MS - 1)).toBe(false);
    expect(pen.shouldEngage(hover(true), 100 + ENGAGE_RETRY_MS)).toBe(true);
    expect(pen.shouldEngage(hover(true, true), 1000)).toBe(false); // already down
    expect(pen.native('HOVER')).toBe(false); // native lifted at the canvas edge: still armed
    expect(pen.shouldEngage(hover(true), 2000)).toBe(true);
  });
  it('never arms without active tracking; pause, loss and Pen Up disarm', () => {
    const pen = new PenArming();
    expect(pen.request('down', { native: 'PAUSED', buttonDown: false })).toBe('not-tracking');
    expect(pen.armed).toBe(false);
    pen.request('down', hover(false));
    expect(pen.native('PAUSED')).toBe(true); expect(pen.armed).toBe(false);
    pen.request('down', hover(false)); pen.release(); expect(pen.armed).toBe(false);
    pen.request('down', hover(false)); pen.native('FAULT'); expect(pen.shouldEngage(hover(true), 0)).toBe(false);
  });
  it('F8 toggle releases a down pen and disarms an armed one', () => {
    const pen = new PenArming();
    expect(pen.request('toggle', hover(true, true))).toBe('release');
    pen.request('toggle', hover(false));
    expect(pen.armed).toBe(true);
    expect(pen.request('toggle', hover(false))).toBe('disarm');
    expect(pen.armed).toBe(false);
  });
});

describe('retired pen gesture settings compatibility', () => {
  it('validates entries', () => {
    const base = defaultSettings();
    expect(isSettingsV1({ ...base, penGestures: [{ cameraId: 'cam', enabled: true, restSize: 0.12, threshold: 0.2 }] })).toBe(true);
    expect(isSettingsV1({ ...base, penGestures: [{ cameraId: 'cam', enabled: true, restSize: 0, threshold: 0.2 }] })).toBe(false);
    expect(isSettingsV1({ ...base, penGestures: [{ cameraId: 'cam', enabled: true, restSize: 0.12, threshold: 0.9 }] })).toBe(false);
    expect(isSettingsV1({ ...base, penGestures: [{ cameraId: 'cam', enabled: true, restSize: 0.12, threshold: 0.2 }, { cameraId: 'cam', enabled: false, restSize: 0.1, threshold: 0.2 }] })).toBe(false);
  });
});
