import { describe, expect, test } from 'vitest';
import { buildCalibration, CalibrationCapture, CalibrationSession, calibrationKey, isCalibrationV1, median, recenterCalibration, scaledMAD, type CaptureStep, type CaptureSummary } from '../../src/renderer/engine';
import type { Mode, Point, TrackingSample } from '../../src/shared/contracts';
const sample = (id: number, time: number, anchor: Point | null = { x: 0.5, y: 0.5 }, mode: Mode = 'head'): TrackingSample => ({ generation: 4, frameId: id, captureTimestamp: time, mode, valid: anchor !== null, anchor, qualityReason: anchor ? 'valid' : 'no subject', ...(mode === 'palm' ? { selectedHand: 'Right' as const } : {}) });
const summary = (x: number, y: number, hand: 'Left' | 'Right' | null = null): CaptureSummary => ({ position: { x, y }, jitter: { x: 0.001, y: 0.001 }, validSamples: 60, totalFrames: 60, selectedHand: hand });
const captures = (): Record<CaptureStep, CaptureSummary> => ({ neutral: summary(0.5, 0.5), left: summary(0.3, 0.5), right: summary(0.8, 0.5), up: summary(0.5, 0.4), down: summary(0.5, 0.7) });
const input = () => ({ cameraId: 'camera-1', mode: 'head' as const, captures: captures() });
const context = { cameraId: 'camera-1', mode: 'head' as const, generation: 4 };

describe('two-second capture boundaries and frame validity', () => {
  test('has no pre-capture movement deadline and never accepts a short capture', () => {
    const capture = new CalibrationCapture(context, 100000);
    for (let index = 0; index < 40; index++) capture.add(sample(index, 100000 + index * 40));
    expect(capture.finish(101999).ok).toBe(false);
    expect(capture.finish(102000)).toMatchObject({ ok: true, capture: { validSamples: 40, totalFrames: 40 } });
  });
  test('40 valid of 50 frames passes exactly 80%; 40 of 51 fails', () => {
    for (const total of [50, 51]) {
      const capture = new CalibrationCapture(context, 0);
      for (let index = 0; index < total; index++) capture.add(sample(index, index * 30, index < 40 ? { x: 0.5, y: 0.5 } : null));
      expect(capture.finish(2000).ok).toBe(total === 50);
    }
  });
  test('39 valid samples fails even at 100% validity', () => {
    const capture = new CalibrationCapture(context, 0);
    for (let index = 0; index < 39; index++) capture.add(sample(index, index * 40));
    expect(capture.finish(2000)).toMatchObject({ ok: false, reason: expect.stringContaining('40 valid') });
  });
  test('duplicates, foreign generation/mode, stale and out-of-window receipts cannot inflate a capture', () => {
    const capture = new CalibrationCapture(context, 1000);
    expect(capture.add(sample(0, 999))).toBe(false);
    expect(capture.add({ ...sample(0, 1000), generation: 3 })).toBe(false);
    expect(capture.add(sample(0, 1000, { x: 0.5, y: 0.5 }, 'palm'))).toBe(false);
    expect(capture.add(sample(0, 1000), 1250)).toBe(false);
    expect(capture.add(sample(0, 1000), 999)).toBe(false);
    expect(capture.add(sample(0, 1000))).toBe(true);
    expect(capture.add(sample(0, 1001))).toBe(false);
    expect(capture.add(sample(1, 1000))).toBe(false);
    expect(capture.add(sample(1, 2999), 3000)).toBe(false);
    expect(capture.add(sample(1, 3000))).toBe(false);
    expect(capture.finish(3000)).toMatchObject({ ok: false, reason: expect.stringContaining('received 1') });
  });
  test('coordinate medians and scaled MAD resist a final endpoint outlier', () => {
    const capture = new CalibrationCapture(context, 0);
    for (let index = 0; index < 41; index++) capture.add(sample(index, index * 40, { x: index === 40 ? 0.9 : 0.5 + ((index % 3) - 1) * 0.001, y: 0.6 }));
    const result = capture.finish(2000);
    expect(result.ok).toBe(true);
    if (result.ok) { expect(result.capture.position).toEqual({ x: 0.5, y: 0.6 }); expect(result.capture.jitter.x).toBeCloseTo(0.0014826); expect(result.capture.jitter.y).toBe(0); }
    expect(median([3, 1, 2, 4])).toBe(2.5);
    expect(scaledMAD([1, 2, 3])).toBe(1.4826);
  });
  test('palm accepts one stable model label and includes wrong/missing labels as invalid', () => {
    const capture = new CalibrationCapture({ ...context, mode: 'palm' }, 0);
    for (let index = 0; index < 50; index++) capture.add({ ...sample(index, index * 30, { x: 0.5, y: 0.5 }, 'palm'), selectedHand: index < 40 ? 'Right' : index < 45 ? 'Left' : null });
    expect(capture.finish(2000)).toMatchObject({ ok: true, capture: { validSamples: 40, totalFrames: 50, selectedHand: 'Right' } });
  });
});

describe('five positions, range validation and recenter', () => {
  test('builds directional extents with exact defaults and validates per camera/mode keys', () => {
    const calibration = buildCalibration(input());
    expect(calibration).toMatchObject({ schemaVersion: 1, gain: 1, smoothing: 50, selectedHand: null, neutral: { x: 0.5, y: 0.5 } });
    expect(calibration.extents.left).toBeCloseTo(0.2); expect(calibration.extents.right).toBeCloseTo(0.3);
    expect(calibration.extents.up).toBeCloseTo(0.1); expect(calibration.extents.down).toBeCloseTo(0.2);
    expect(calibrationKey('a,palm', 'head')).not.toBe(calibrationKey('a', 'palm'));
    expect(calibrationKey('a', 'head')).not.toBe(calibrationKey('b', 'head'));
  });
  test.each([0, 0.009, 0.01])('extent %s fails the strict normalized minimum', extent => {
    const calibration = buildCalibration(input());
    expect(isCalibrationV1({ ...calibration, extents: { ...calibration.extents, left: extent } })).toBe(false);
  });
  test('extent must exceed three times matching-axis jitter', () => {
    const calibration = buildCalibration(input());
    const value = { ...calibration, jitter: { x: 0.01, y: 0.002 }, extents: { ...calibration.extents, left: 0.03 } };
    expect(isCalibrationV1(value)).toBe(false);
    expect(isCalibrationV1({ ...value, extents: { ...value.extents, left: 0.0300001 } })).toBe(true);
  });
  test('rejects reversed directions and mixed selected labels without changing gain', () => {
    const value = input(); value.captures.left.position.x = 0.6;
    expect(() => buildCalibration(value)).toThrow('Each directional extent');
    const palm = captures(); Object.values(palm).forEach(capture => { capture.selectedHand = 'Left'; }); palm.down.selectedHand = 'Right';
    expect(() => buildCalibration({ ...input(), mode: 'palm', captures: palm })).toThrow('same selected hand');
  });
  test('session advances only successful steps and retries inadequate directional range', () => {
    const session = new CalibrationSession(context);
    let timestamp = 0, frame = 0;
    const record = (point: Point): void => { session.start(timestamp); for (let index = 0; index < 50; index++) session.add(sample(frame++, timestamp + index * 30, point)); timestamp += 2000; };
    expect(() => session.build()).toThrow();
    record({ x: 0.5, y: 0.5 }); expect(session.finish(timestamp).ok).toBe(true); expect(session.step).toBe('left');
    record({ x: 0.495, y: 0.5 }); expect(session.finish(timestamp).ok).toBe(false); expect(session.step).toBe('left');
    for (const point of [{ x: 0.3, y: 0.5 }, { x: 0.8, y: 0.5 }, { x: 0.5, y: 0.4 }, { x: 0.5, y: 0.7 }]) { record(point); expect(session.finish(timestamp).ok).toBe(true); }
    expect(session.step).toBeNull(); expect(session.build()).toEqual({ ...buildCalibration(input()), jitter: { x: 0, y: 0 } });
    session.cancel(); expect(session.step).toBe('neutral'); expect(session.active).toBe(false); expect(session.captures).toEqual({});
  });
  test('early finish keeps active capture; failed completed capture allows retry and cancel clears it', () => {
    const session = new CalibrationSession(context); session.start(0);
    expect(session.finish(1999).ok).toBe(false); expect(session.active).toBe(true);
    expect(session.finish(2000).ok).toBe(false); expect(session.active).toBe(false); expect(session.step).toBe('neutral');
    session.start(5000); session.cancel(); expect(session.active).toBe(false);
  });
  test('recenter changes neutral/jitter, preserves independent extents and never raises gain', () => {
    const original = buildCalibration(input()), moved = recenterCalibration(original, summary(0.6, 0.55));
    expect(moved.neutral).toEqual({ x: 0.6, y: 0.55 }); expect(moved.extents).toEqual(original.extents); expect(moved.gain).toBe(1);
    expect(original.neutral).toEqual({ x: 0.5, y: 0.5 });
    expect(() => recenterCalibration(original, { ...summary(0.6, 0.55), jitter: { x: 0.1, y: 0.1 } })).toThrow('recalibrate');
  });
});

describe('persisted calibration schema boundaries', () => {
  test.each([0.5, 3])('accepts gain bound %s', gain => expect(isCalibrationV1({ ...buildCalibration(input()), gain })).toBe(true));
  test.each([0, 100])('accepts smoothing bound %s', smoothing => expect(isCalibrationV1({ ...buildCalibration(input()), smoothing })).toBe(true));
  test('rejects malformed, nonfinite, extra-state and incompatible mode values', () => {
    const value = buildCalibration(input());
    for (const bad of [null, {}, { ...value, schemaVersion: 2 }, { ...value, cameraId: '' }, { ...value, gain: 3.01 }, { ...value, gain: 0.49 }, { ...value, smoothing: -1 }, { ...value, smoothing: 101 }, { ...value, jitter: { x: NaN, y: 0 } }, { ...value, neutral: { x: -0.1, y: 0.5 } }, { ...value, penDown: true }, { ...value, selectedHand: 'Left' }, { ...value, mode: 'palm' }, { ...value, extents: { ...value.extents, left: Infinity } }]) expect(isCalibrationV1(bad)).toBe(false);
    expect(isCalibrationV1({ ...value, mode: 'palm', selectedHand: 'Left' })).toBe(true);
  });
});

test('a failed palm capture names the most common rejection in plain language', () => {
  const capture = new CalibrationCapture({ cameraId: 'cam', mode: 'palm', generation: 1 }, 0);
  for (let frame = 0; frame < 50; frame++) capture.add({ generation: 1, frameId: frame, captureTimestamp: frame * 33 + 1, mode: 'palm', valid: false, anchor: null, qualityReason: 'confirm selected hand', selectedHand: 'Left' }, frame * 33 + 2);
  const result = capture.finish(2000);
  expect(result.ok).toBe(false);
  expect(!result.ok && result.reason).toContain('received 0. Most frames: hand was lost — show it and press Confirm.');
});
