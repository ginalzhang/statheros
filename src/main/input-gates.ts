import type { ProbeStatus, TrackingSample, Point } from '../shared/contracts';
import { isTrackingSample } from '../shared/tracking-validation';
import { point } from './protocol';

/** Main checks UI/configuration prerequisites; native still guards every event. */
export function calibrationReady(status: ProbeStatus): boolean {
  const settings = status.settings;
  return Boolean(settings?.calibrations.some(c => c.cameraId === settings.cameraId && c.mode === settings.mode));
}
export function readyForControl(status: ProbeStatus, canvasRequired: boolean): string | null {
  if (status.nativeFault || !status.nativeClockReady) return 'Recover the native helper and synchronize clocks first.';
  if (status.settingsOpen) return 'Close Settings before canvas setup or Resume.';
  if (!calibrationReady(status)) return 'Calibrate the selected camera and mode first.';
  if (!status.targetPid) return 'Open a disposable document in Krita, then recover the helper.';
  if (!status.native?.permissions.accessibility) return 'Accessibility permission is required.';
  if (status.native?.foregroundTarget !== 'org.krita') return 'Keep Krita in the foreground.';
  if (canvasRequired && (!status.canvasConfirmed || !status.canvas)) return 'Set the canvas first: choose Detect canvas or Review suggested workspace on the panel.';
  return null;
}
export function mappedSampleAllowed(value: unknown, position: unknown, status: ProbeStatus, now: number): value is TrackingSample {
  return isTrackingSample(value) && value.generation === status.generation && value.mode === status.settings?.mode &&
    now - value.captureTimestamp < 250 && value.captureTimestamp <= now &&
    (value.valid ? point(position) : position === null) && calibrationReady(status);
}
export function freshPointer(pointer: { position: Point; timestamp: number; generation: number } | null, generation: number, now: number): Point | null {
  return pointer && pointer.generation === generation && now >= pointer.timestamp && now - pointer.timestamp < 250 ? pointer.position : null;
}
