import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fixtures from '../fixtures/tracking-v1.json';
import { isCalibrationV1 } from '../src/renderer/engine';
import { isTrackingSample } from '../src/shared/tracking-validation';
import { defaultSettings, isSettingsV1, withCalibration } from '../src/shared/settings';
import { SettingsStore } from '../src/main/settings';
describe('shared tracking contract authority', () => {
  it('matches positive and negative calibration/sample fixtures', () => {
    for (const c of fixtures.calibration.positive) expect(isCalibrationV1(c)).toBe(true);
    for (const c of fixtures.calibration.negative) expect(isCalibrationV1(c.value), c.name).toBe(false);
    for (const s of fixtures.sample.positive) expect(isTrackingSample(s)).toBe(true);
    for (const s of fixtures.sample.negative) expect(isTrackingSample(s.value), s.name).toBe(false);
  });
  it('atomically stores distinct camera/mode calibrations without runtime states', () => {
    const filename = path.join(mkdtempSync(path.join(os.tmpdir(), 'steady-settings-')), 'settings.json');
    const store = new SettingsStore(filename);
    let s = defaultSettings();
    for (const c of fixtures.calibration.positive) { if (!isCalibrationV1(c)) throw new Error('bad fixture'); s = withCalibration(s, c); }
    store.save(s); expect(store.load().settings.calibrations).toHaveLength(3);
    expect(isSettingsV1({ ...s, microphoneEnabled: true })).toBe(false);
    expect(isSettingsV1({ ...s, penDown: false })).toBe(false);
    expect(isSettingsV1({ ...s, calibrations: [s.calibrations[0], s.calibrations[0]] })).toBe(false);
    expect(readFileSync(filename, 'utf8')).not.toContain('canvas');
    writeFileSync(filename, '{'); expect(store.load()).toMatchObject({ settings: defaultSettings(), warning: expect.any(String) });
    writeFileSync(filename, JSON.stringify({ ...s, schemaVersion: 2 })); expect(store.load().settings).toEqual(defaultSettings());
  });
});

describe('camera orientations', () => {
  it('accepts per-camera flips and rejects malformed or duplicate entries', () => {
    const base = defaultSettings();
    expect(isSettingsV1({ ...base, orientations: [{ cameraId: 'cam', flipX: false, flipY: true }] })).toBe(true);
    expect(isSettingsV1({ ...base, orientations: [{ cameraId: 'cam', flipX: 'no', flipY: true }] })).toBe(false);
    expect(isSettingsV1({ ...base, orientations: [{ cameraId: 'cam', flipX: true, flipY: true }, { cameraId: 'cam', flipX: false, flipY: true }] })).toBe(false);
    expect(isSettingsV1({ ...base, orientations: [{ cameraId: 'cam', flipX: true, flipY: true, extra: 1 }] })).toBe(false);
  });
});
