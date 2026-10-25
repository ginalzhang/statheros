import type { CalibrationV1, Mode, GlobalBindings, ShortcutProfile, Rect } from './contracts';
import { validateBindings, validateProfile } from '../main/commands';
import { isCalibrationV1, calibrationKey } from '../renderer/engine';

/** Per-camera orientation for unusual mounts (e.g. overhead tripods). Absent = default (mirrored once). */
export interface CameraOrientation { cameraId: string; flipX: boolean; flipY: boolean }
/** Retired rest/lift settings: accepted only to preserve existing settings-v1 files. */
export interface PenGestureSetting { cameraId: string; enabled: boolean; restSize: number; threshold: number }
/**
 * The last accepted canvas plus the Krita state it was accepted in (window frame, hashed document identity,
 * observed workspace/viewport). It is reapplied (still paused) only when Krita looks exactly the same again.
 */
export interface RememberedCanvas { displayId: number; canvas: Rect; windowBounds: Rect; windowToken: string; workspace: Rect | null; viewport: Rect | null }
export interface SettingsV1 { schemaVersion: 1; cameraId: string; mode: Mode; calibrations: CalibrationV1[]; bindings?: GlobalBindings; profile?: ShortcutProfile; orientations?: CameraOrientation[]; penGestures?: PenGestureSetting[]; rememberedCanvas?: RememberedCanvas }
const isRect = (value: unknown): value is Rect => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  return Object.keys(r).length === 4 && ['x', 'y', 'width', 'height'].every(k => typeof r[k] === 'number' && Number.isFinite(r[k])) && (r.width as number) > 0 && (r.height as number) > 0;
};
export function validRememberedCanvas(value: unknown): value is RememberedCanvas {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const c = value as Record<string, unknown>;
  return Object.keys(c).length === 6 && Number.isSafeInteger(c.displayId) && (c.displayId as number) >= 0 && isRect(c.canvas) && isRect(c.windowBounds)
    && typeof c.windowToken === 'string' && c.windowToken.length > 0 && c.windowToken.length <= 256 && (c.workspace === null || isRect(c.workspace)) && (c.viewport === null || isRect(c.viewport));
}
function validPenGesture(value: unknown): value is PenGestureSetting {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const g = value as Record<string, unknown>;
  return Object.keys(g).length === 4 && typeof g.cameraId === 'string' && g.cameraId.length > 0 && g.cameraId.length <= 1024 && typeof g.enabled === 'boolean'
    && typeof g.restSize === 'number' && Number.isFinite(g.restSize) && g.restSize > 0.005 && g.restSize < 1
    && typeof g.threshold === 'number' && Number.isFinite(g.threshold) && g.threshold >= 0.05 && g.threshold <= 0.6;
}
function validPenGestures(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > 64 || !value.every(validPenGesture)) return false;
  return new Set(value.map(entry => (entry as PenGestureSetting).cameraId)).size === value.length;
}
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
  if (Object.keys(p).some(k => !['calibrations','cameraId','mode','schemaVersion','bindings','profile','orientations','penGestures','rememberedCanvas'].includes(k)) || (p.rememberedCanvas !== undefined && !validRememberedCanvas(p.rememberedCanvas)) || (p.orientations !== undefined && !validOrientations(p.orientations)) || (p.penGestures !== undefined && !validPenGestures(p.penGestures)) || p.schemaVersion !== 1 || typeof p.cameraId !== 'string' || p.cameraId.length > 1024 || !['head', 'palm'].includes(p.mode as string) || !Array.isArray(p.calibrations) || !p.calibrations.every(isCalibrationV1)) return false;
  try { if (p.bindings !== undefined) validateBindings(p.bindings); if (p.profile !== undefined) validateProfile(p.profile); } catch { return false; }
  return new Set(p.calibrations.map(c => calibrationKey(c.cameraId, c.mode))).size === p.calibrations.length;
}
export function withCalibration(settings: SettingsV1, calibration: CalibrationV1): SettingsV1 {
  if (!isCalibrationV1(calibration)) throw new Error('Invalid calibration');
  return { ...settings, calibrations: [...settings.calibrations.filter(c => calibrationKey(c.cameraId, c.mode) !== calibrationKey(calibration.cameraId, calibration.mode)), structuredClone(calibration)] };
}
