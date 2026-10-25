import type { CalibrationV1, Mode, GlobalBindings, ShortcutProfile } from './contracts';
import { validateBindings, validateProfile } from '../main/commands';
import { isCalibrationV1, calibrationKey } from '../renderer/engine';

/** Per-camera orientation for unusual mounts (e.g. overhead tripods). Absent = default (mirrored once). */
export interface CameraOrientation { cameraId: string; flipX: boolean; flipY: boolean }
export interface SettingsV1 { schemaVersion: 1; cameraId: string; mode: Mode; calibrations: CalibrationV1[]; bindings?: GlobalBindings; profile?: ShortcutProfile; orientations?: CameraOrientation[] }
export const orientationFor = (settings: SettingsV1 | undefined, cameraId: string): { flipX: boolean; flipY: boolean } => {
  const found = settings?.orientations?.find(entry => entry.cameraId === cameraId);
  return { flipX: found?.flipX ?? false, flipY: found?.flipY ?? false };
};
function validOrientations(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > 64) return false;
  const ids = new Set<string>();
  return value.every(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const o = entry as Record<string, unknown>;
    if (Object.keys(o).length !== 3 || typeof o.cameraId !== 'string' || o.cameraId.length > 1024 || typeof o.flipX !== 'boolean' || typeof o.flipY !== 'boolean' || ids.has(o.cameraId)) return false;
    ids.add(o.cameraId); return true;
  });
}
export const defaultSettings = (): SettingsV1 => ({ schemaVersion: 1, cameraId: '', mode: 'head', calibrations: [] });
export function isSettingsV1(value: unknown): value is SettingsV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const p = value as Record<string, unknown>;
  if (Object.keys(p).some(k => !['calibrations','cameraId','mode','schemaVersion','bindings','profile','orientations'].includes(k)) || (p.orientations !== undefined && !validOrientations(p.orientations)) || p.schemaVersion !== 1 || typeof p.cameraId !== 'string' || p.cameraId.length > 1024 || !['head', 'palm'].includes(p.mode as string) || !Array.isArray(p.calibrations) || !p.calibrations.every(isCalibrationV1)) return false;
  try { if (p.bindings !== undefined) validateBindings(p.bindings); if (p.profile !== undefined) validateProfile(p.profile); } catch { return false; }
  return new Set(p.calibrations.map(c => calibrationKey(c.cameraId, c.mode))).size === p.calibrations.length;
}
export function withCalibration(settings: SettingsV1, calibration: CalibrationV1): SettingsV1 {
  if (!isCalibrationV1(calibration)) throw new Error('Invalid calibration');
  return { ...settings, calibrations: [...settings.calibrations.filter(c => calibrationKey(c.cameraId, c.mode) !== calibrationKey(calibration.cameraId, calibration.mode)), structuredClone(calibration)] };
}
