import { describe, expect, it } from 'vitest';
import { ENGAGE_RETRY_MS, OUTSIDE_CANVAS_CODES, PenArming } from '../src/main/pen-arming';
import { LIFT_DEBOUNCE_MS, LiftGesture, palmSize } from '../src/renderer/tracking';
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

describe('rest/lift gesture', () => {
  it('measures an aspect-corrected palm size', () => {
    const hand = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5 }));
    hand[0] = { x: 0.5, y: 0.7 }; hand[9] = { x: 0.5, y: 0.5 }; hand[5] = { x: 0.45, y: 0.5 }; hand[17] = { x: 0.55, y: 0.5 };
    expect(palmSize(hand, 4 / 3)).toBeCloseTo((0.2 + 0.1 * 4 / 3) / 2);
    expect(palmSize([], 1)).toBeNull();
  });
  it('switches with hysteresis and debounce; missing hands change nothing', () => {
    const gesture = new LiftGesture({ restSize: 0.1, threshold: 0.2 });
    expect(gesture.update(0.1, 0)).toBeNull();
    expect(gesture.update(0.1, LIFT_DEBOUNCE_MS)).toBe('rest');
    expect(gesture.update(0.115, 200)).toBeNull(); // between the bands: no change
    expect(gesture.update(0.125, 300)).toBeNull();
    expect(gesture.update(null, 350)).toBeNull(); // hand lost resets the pending reading
    expect(gesture.update(0.125, 400)).toBeNull();
    expect(gesture.update(0.125, 400 + LIFT_DEBOUNCE_MS)).toBe('lift');
    expect(gesture.update(0.108, 700)).toBeNull(); // not yet below rest × 1.1
    expect(gesture.update(0.105, 800)).toBeNull();
    expect(gesture.update(0.105, 800 + LIFT_DEBOUNCE_MS)).toBe('rest');
  });
  it('a brief spike does not flip the pen', () => {
    const gesture = new LiftGesture({ restSize: 0.1, threshold: 0.2 });
    gesture.update(0.1, 0); gesture.update(0.1, 200);
    expect(gesture.update(0.13, 300)).toBeNull();
    expect(gesture.update(0.1, 350)).toBeNull();
    expect(gesture.state).toBe('rest');
  });
});

describe('pen gesture settings', () => {
  it('validates entries', () => {
    const base = defaultSettings();
    expect(isSettingsV1({ ...base, penGestures: [{ cameraId: 'cam', enabled: true, restSize: 0.12, threshold: 0.2 }] })).toBe(true);
    expect(isSettingsV1({ ...base, penGestures: [{ cameraId: 'cam', enabled: true, restSize: 0, threshold: 0.2 }] })).toBe(false);
    expect(isSettingsV1({ ...base, penGestures: [{ cameraId: 'cam', enabled: true, restSize: 0.12, threshold: 0.9 }] })).toBe(false);
    expect(isSettingsV1({ ...base, penGestures: [{ cameraId: 'cam', enabled: true, restSize: 0.12, threshold: 0.2 }, { cameraId: 'cam', enabled: false, restSize: 0.1, threshold: 0.2 }] })).toBe(false);
  });
});
