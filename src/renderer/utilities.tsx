import { useEffect, useRef, useState } from 'react';
import type { ProbeStatus, ToastMessage } from '../shared/contracts';
import { BunnyMark } from './logo';
import type { LocalActionID } from '../main/commands';
import type { ProbeReport } from './probe';
import { Icon, type IconName } from './icons';

/** Statheros 2 floating surfaces: the compact panel and the Camera Preview, plus transient notifications. The
 * panel renderer owns the camera; it streams preview frames to the Camera Preview window. */
export const PREVIEW_FRAMES_CHANNEL = 'steady-preview-frames';
export const initialStatus: ProbeStatus = { native: null, displays: [], fault: null, collapsed: false, settingsOpen: false, generation: 0, realInput: false, microphoneEnabled: false };
export const initialProbe: ProbeReport = { message: 'Camera off', frames: 0, delegate: null, running: false };

/** Statheros 2 state language: CONNECTED/ACTIVE mint, DISCONNECTED/UNAVAILABLE/LOST/FAILED coral,
 * CONNECTING/WAITING blue, USER-PAUSED gray. Always paired with a text label, never color alone. */
export type StateTone = 'active' | 'failed' | 'connecting' | 'paused';

/** Never show a false Active/Connected (handoff §04): status comes from the helper and the live feed. */
export function trackingState(status: ProbeStatus, probe: ProbeReport): { label: string; tone: StateTone; paused: boolean; palm: boolean; lost: boolean } {
  const native = status.native?.state, palm = (status.settings?.mode ?? 'head') === 'palm';
  const lost = Boolean(probe.running && (probe.confirmationRequired || probe.rejection));
  const [label, tone]: [string, StateTone] = !native ? ['Connecting', 'connecting'] : native === 'FAULT' ? ['Unavailable', 'failed'] : native === 'PAUSED' ? ['Paused', 'paused'] : native === 'SETUP' ? ['Setting canvas', 'connecting'] : !probe.running ? ['No camera', 'failed']
    : lost ? ['Tracking Lost', 'failed'] : ['Active', 'active'];
  return { label, tone, paused: !native || native === 'PAUSED' || native === 'FAULT', palm, lost };
}

/** Camera connection from the live feed: running with a ready detector is Connected. */
export function cameraState(probe: ProbeReport): { label: 'Connected' | 'Connecting' | 'Disconnected'; tone: StateTone } {
  return probe.running ? (probe.delegate ? { label: 'Connected', tone: 'active' } : { label: 'Connecting', tone: 'connecting' }) : { label: 'Disconnected', tone: 'failed' };
}

export function useStatus(onError?: (message: string) => void): ProbeStatus {
  const [status, setStatus] = useState(initialStatus);
  useEffect(() => {
    void window.steady.status().then(setStatus).catch(cause => onError?.(String(cause)));
    return window.steady.onStatus(setStatus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return status;
}

/** The panel's camera reports, read the same way the Settings window reads them. */
export function useProbeReport(): ProbeReport {
  const [probe, setProbe] = useState(initialProbe);
  useEffect(() => {
    const channel = new BroadcastChannel('steady-camera-probe');
    channel.onmessage = event => { if (event.data?.type === 'report') setProbe(event.data.report as ProbeReport); };
    channel.postMessage({ type: 'query' });
    return () => channel.close();
  }, []);
  return probe;
}

/** Registers enabled `data-action` buttons as tracked-click targets for this window. */
export function useTrackedButtons(enabled: boolean, deps: readonly unknown[]): void {
  useEffect(() => {
    if (!enabled) return;
    const register = (): void => {
      const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('button[data-action]:not(:disabled)')).map(button => {
        const rect = button.getBoundingClientRect();
        const clip = button.closest('.panel-content')?.getBoundingClientRect() ?? document.body.getBoundingClientRect();
        const x = Math.max(rect.left, clip.left), y = Math.max(rect.top, clip.top);
        return { actionId: button.dataset.action as LocalActionID, rect: { x, y, width: Math.min(rect.right, clip.right) - x, height: Math.min(rect.bottom, clip.bottom) - y } };
      }).filter(button => button.rect.width > 0 && button.rect.height > 0);
      window.steady.registerButtons(buttons);
    };
    register();
    const mutations = new MutationObserver(register);
    mutations.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'data-action', 'hidden', 'open'] });
    const observer = new ResizeObserver(register);
    observer.observe(document.body);
    document.addEventListener('scroll', register, true);
    return () => { mutations.disconnect(); observer.disconnect(); document.removeEventListener('scroll', register, true); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, ...deps]);
}

/** Panel side: downscales the drawn preview (video + landmarks) and posts it as a JPEG, one frame in flight. */
export class PreviewStreamer {
  private readonly channel = new BroadcastChannel(PREVIEW_FRAMES_CHANNEL);
  private readonly scaled = document.createElement('canvas');
  private encoding = false;
  constructor() { this.scaled.width = 400; this.scaled.height = 300; }
  push(source: HTMLCanvasElement): void {
    if (this.encoding || !source.width || !source.height) return;
    const context = this.scaled.getContext('2d');
    if (!context) return;
    this.scaled.height = Math.round(this.scaled.width * source.height / source.width);
    context.drawImage(source, 0, 0, this.scaled.width, this.scaled.height);
    this.encoding = true;
    this.scaled.toBlob(blob => { this.encoding = false; if (blob) this.channel.postMessage({ type: 'frame', blob }); }, 'image/jpeg', 0.8);
  }
  close(): void { this.channel.close(); }
}

/** Camera Preview widget, 200 × 180 (Statheros 2): bunny header, mirrored camera with landmarks, status/pen footer. */
export function CameraPreviewWindow(): React.JSX.Element {
  const status = useStatus(), probe = useProbeReport();
  const canvas = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const channel = new BroadcastChannel(PREVIEW_FRAMES_CHANNEL);
    let drawing = false;
    channel.onmessage = event => {
      const blob: unknown = event.data?.blob;
      if (event.data?.type !== 'frame' || !(blob instanceof Blob) || drawing) return;
      drawing = true;
      void createImageBitmap(blob).then(bitmap => {
        const target = canvas.current;
        if (target) {
          if (target.width !== bitmap.width) target.width = bitmap.width;
          if (target.height !== bitmap.height) target.height = bitmap.height;
          target.getContext('2d')?.drawImage(bitmap, 0, 0);
        }
        bitmap.close();
      }).catch(() => undefined).finally(() => { drawing = false; });
    };
    return () => channel.close();
  }, []);
  const tracking = trackingState(status, probe), camera = cameraState(probe), penDown = Boolean(status.native?.buttonDown);
  // Camera problems outrank tracking state: a disconnected feed can never read as paused or active.
  const footer: { label: string; tone: StateTone } = camera.tone !== 'active' ? { label: `Camera ${camera.label}`, tone: camera.tone }
    : status.native?.state === 'FAULT' ? { label: 'Tracking Unavailable', tone: 'failed' }
    : tracking.paused ? { label: 'Tracking Paused', tone: 'paused' } : tracking.lost ? { label: 'Tracking Lost', tone: 'failed' } : { label: `Tracking ${tracking.label}`, tone: tracking.tone };
  const caption = camera.tone !== 'active' ? null : tracking.paused ? 'Tracking paused' : tracking.lost ? 'Move back into camera view.' : null;
  return <main className="utility preview-window" aria-label="Camera Preview">
    <h1><BunnyMark size={14} />Camera Preview</h1>
    <div className="preview-frame">
      <canvas ref={canvas} hidden={!probe.running} aria-label="Mirrored local camera preview" className="camera-preview" />
      {camera.tone === 'failed' && <p className="preview-empty tone-failed">Camera unavailable</p>}
      {camera.tone === 'connecting' && <p className="preview-empty tone-connecting">Connecting to camera…</p>}
      {caption && <p className={`preview-caption${tracking.lost ? ' tone-failed' : ''}`} role="status">{caption}</p>}
    </div>
    <footer><span className={`dot ${footer.tone}`} /><span className={`tone-${footer.tone}`}>{footer.label}</span><span className="divider" /><span className="muted">{penDown ? 'Pen Down' : 'Pen Up'}</span></footer>
  </main>;
}

const TOASTS: Record<ToastMessage['kind'], { label: string; icon: IconName; tone: StateTone }> = {
  undo: { label: 'Undo', icon: 'undo', tone: 'active' },
  redo: { label: 'Redo', icon: 'redo', tone: 'active' },
  // Krita's E is a toggle and Steady does not read its state, so the result cannot say which tool is now active.
  eraser: { label: 'Eraser toggled', icon: 'eraser', tone: 'active' },
  pencil: { label: 'Switch to Pencil', icon: 'brush', tone: 'active' },
  paused: { label: 'Drawing Paused', icon: 'pause', tone: 'paused' },
  resumed: { label: 'Drawing Resumed', icon: 'resumeTracking', tone: 'active' },
  trackingLost: { label: 'Tracking Lost', icon: 'hand', tone: 'failed' },
  failed: { label: 'Action Failed', icon: 'alert', tone: 'failed' },
};

/** Transient upper-left notification (Statheros 2 "Notification / …"), shown by the main process after a confirmed result. */
export function ToastWindow(): React.JSX.Element {
  const [toast, setToast] = useState<ToastMessage | null>(null);
  useEffect(() => window.steady.onToast(setToast), []);
  if (!toast) return <></>;
  const view = TOASTS[toast.kind];
  const detail = toast.kind === 'trackingLost' ? 'Move back into camera view.' : toast.kind === 'failed' ? toast.detail : null;
  return <div key={toast.id} className={`toast tone-bg-${view.tone}`} role="status" aria-live="polite">
    <span className="toast-icon"><Icon name={view.icon} size={18} /></span>
    <span className="toast-text"><strong>{view.label}</strong>{detail && <span>{detail}</span>}</span>
  </div>;
}
