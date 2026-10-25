import { contextBridge, ipcRenderer } from 'electron';
import { estimateClock, type ClockRoundTrip } from './clock';
import type { VoiceCaptureCommand, VoiceCaptureReport, VoiceSnapshot } from '../shared/voice';
import type { ActionID, LocalActionID, GlobalBindings, ShortcutProfile, CalibrationV1, CanvasSelection, CanvasSurfaceSession, Point, TrackingProbeMetrics, Mode, ProbeStatus, Rect, SteadyAPI, TrackingSample } from '../shared/contracts';

const auxiliaryCanvasView = ['canvas-overlay', 'canvas-outline'].includes(new URLSearchParams(location.search).get('view') ?? '');

let clockOffset = 0;
let clockReady = false;
let synchronizing = false;
let clockFault: string | null = 'Synchronizing capture clock';
const clockListeners = new Set<(status: ProbeStatus) => void>();
const statusWithClock = (status: ProbeStatus): ProbeStatus => auxiliaryCanvasView ? status : ({ ...status, fault: status.fault ?? clockFault });
async function synchronizeClock(): Promise<void> {
  if (synchronizing) return;
  synchronizing = true;
  clockReady = false;
  try {
    const samples: ClockRoundTrip[] = [];
    for (let index = 0; index < 8; index++) {
      const sent = performance.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const remote = await Promise.race([
          ipcRenderer.invoke('steady:clock') as Promise<number>,
          new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Clock synchronization timeout')), 500); }),
        ]);
        samples.push({ sent, received: performance.now(), remote });
      } finally { clearTimeout(timer); }
    }
    const estimate = estimateClock(samples);
    if (estimate.uncertainty > 10) throw new Error('Capture clock uncertainty exceeds 10 ms');
    clockOffset = estimate.offset;
    clockReady = true;
    clockFault = null;
  } catch (error) {
    clockFault = String(error);
    ipcRenderer.send('steady:clock-fault', clockFault);
    void ipcRenderer.invoke('steady:action', 'pause').catch(() => undefined);
  } finally {
    synchronizing = false;
    void ipcRenderer.invoke('steady:status').then((status: ProbeStatus) => { for (const callback of clockListeners) callback(statusWithClock(status)); }).catch(() => undefined);
  }
}
if (!auxiliaryCanvasView) {
  void synchronizeClock();
  setInterval(() => { void synchronizeClock(); }, 30_000);
  ipcRenderer.on('steady:resync-clocks', () => { void synchronizeClock(); });
}

const api: SteadyAPI = Object.freeze({
  status: (): Promise<ProbeStatus> => ipcRenderer.invoke('steady:status').then(statusWithClock),
  onStatus: (callback: (status: ProbeStatus) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, value: ProbeStatus): void => callback(statusWithClock(value));
    ipcRenderer.on('steady:status-changed', handler);
    clockListeners.add(callback);
    return () => { ipcRenderer.removeListener('steady:status-changed', handler); clockListeners.delete(callback); };
  },
  action: (actionId: ActionID): Promise<void> => ipcRenderer.invoke('steady:action', actionId),
  localAction: (actionId: LocalActionID): Promise<void> => ipcRenderer.invoke('steady:local-action', actionId),
  beginCanvas: (): Promise<void> => ipcRenderer.invoke('steady:begin-canvas'),
  copyCanvasDiagnostics: (): Promise<void> => ipcRenderer.invoke('steady:copy-canvas-diagnostics'),
  selectCanvas: (): Promise<void> => ipcRenderer.invoke('steady:select-canvas'),
  reviewWorkspace: (): Promise<void> => ipcRenderer.invoke('steady:review-workspace'),
  beginLegacyCanvas: (): Promise<void> => ipcRenderer.invoke('steady:begin-legacy-canvas'),
  previewCanvas: (selection: CanvasSelection): Promise<void> => ipcRenderer.invoke('steady:preview-canvas', selection),
  confirmCanvas: (selection: CanvasSurfaceSession): Promise<void> => ipcRenderer.invoke('steady:confirm-canvas', selection),
  cancelCanvas: (sessionId?: string): Promise<void> => ipcRenderer.invoke('steady:cancel-canvas', sessionId),
  setRealInput: (enabled: boolean): Promise<void> => ipcRenderer.invoke('steady:real-input', enabled),
  recover: (): Promise<void> => ipcRenderer.invoke('steady:recover'),
  saveBindings: (bindings: GlobalBindings): Promise<void> => ipcRenderer.invoke('steady:save-bindings', bindings),
  saveProfile: (profile: ShortcutProfile): Promise<void> => ipcRenderer.invoke('steady:save-profile', profile),
  onLocalAction: (callback: (actionId: LocalActionID) => void): (() => void) => { const handler = (_event: Electron.IpcRendererEvent, actionId: LocalActionID): void => callback(actionId); ipcRenderer.on('steady:local-action', handler); return () => { ipcRenderer.removeListener('steady:local-action', handler); }; },
  onConfirmHand: (callback: () => void): (() => void) => { const handler = (): void => callback(); ipcRenderer.on('steady:confirm-hand', handler); return () => { ipcRenderer.removeListener('steady:confirm-hand', handler); }; },
  collapse: (collapsed: boolean): Promise<void> => ipcRenderer.invoke('steady:collapse', collapsed),
  openSettings: (): Promise<void> => ipcRenderer.invoke('steady:open-settings'),
  closeSettings: (): Promise<void> => ipcRenderer.invoke('steady:close-settings'),
  selectCamera: (cameraId: string, mode: Mode): Promise<void> => ipcRenderer.invoke('steady:select-camera', cameraId, mode),
  selectDisplay: (displayId:number):Promise<void>=>ipcRenderer.invoke('steady:select-display',displayId),
  submitSample: (sample: TrackingSample): void => { if (clockReady) ipcRenderer.send('steady:sample', { ...sample, captureTimestamp: sample.captureTimestamp + clockOffset }); },
  recordTrackingMetrics: (metrics: TrackingProbeMetrics): Promise<void> => ipcRenderer.invoke('steady:tracking-metrics', metrics),
  onRecenter: (callback: () => void): (() => void) => { const handler = (): void => callback(); ipcRenderer.on('steady:recenter', handler); return () => { ipcRenderer.removeListener('steady:recenter', handler); }; },
  saveCalibration: (calibration: CalibrationV1): Promise<void> => ipcRenderer.invoke('steady:save-calibration', calibration),
  tuneCalibration: (calibration: CalibrationV1): Promise<void> => ipcRenderer.invoke('steady:tune-calibration', calibration),
  setPanelOpacity: (opacity: 1 | 0.7): Promise<void> => ipcRenderer.invoke('steady:panel-opacity', opacity),
  setCameraOrientation: (cameraId: string, flipX: boolean, flipY: boolean): Promise<void> => ipcRenderer.invoke('steady:set-orientation', cameraId, flipX, flipY),
  submitMappedProbe: (sample: TrackingSample, position: Point | null): void => { if (clockReady) ipcRenderer.send('steady:mapped-probe', { ...sample, captureTimestamp: sample.captureTimestamp + clockOffset }, position); },
  microphone: (enabled: boolean): Promise<void> => ipcRenderer.invoke('steady:microphone', enabled),
  installSpeechAssets: (): Promise<void> => ipcRenderer.invoke('steady:install-speech-assets'),
  runNativeProbe: (): Promise<void> => ipcRenderer.invoke('steady:run-native-probe'),
  releaseInput: (): Promise<void> => ipcRenderer.invoke('steady:release-input'),
  registerButtons: (buttons: { actionId: LocalActionID; rect: Rect }[]): void => ipcRenderer.send('steady:register-buttons', buttons),
  quit: (): Promise<void> => ipcRenderer.invoke('steady:quit'),
  voiceStatus: () => ipcRenderer.invoke('steady:voice-status'),
  onVoice: (callback: (snapshot: VoiceSnapshot | null, keySource: 'env' | 'settings' | null) => void): (() => void) => { const handler = (_event: Electron.IpcRendererEvent, snapshot: VoiceSnapshot | null, keySource: 'env' | 'settings' | null): void => callback(snapshot, keySource); ipcRenderer.on('steady:voice-changed', handler); return () => { ipcRenderer.removeListener('steady:voice-changed', handler); }; },
  onVoiceCapture: (callback: (command: VoiceCaptureCommand) => void): (() => void) => { const handler = (_event: Electron.IpcRendererEvent, command: VoiceCaptureCommand): void => callback(command); ipcRenderer.on('steady:voice-capture', handler); return () => { ipcRenderer.removeListener('steady:voice-capture', handler); }; },
  voiceFrame: (pcm: ArrayBuffer): void => ipcRenderer.send('steady:voice-frame', new Uint8Array(pcm)),
  voiceReport: (report: VoiceCaptureReport): void => ipcRenderer.send('steady:voice-report', report),
  voiceButton: (kind: 'press' | 'longpress'): void => ipcRenderer.send('steady:voice-button', kind),
  voiceCancel: (): void => ipcRenderer.send('steady:voice-cancel'),
  setVoiceKey: (key: string | null): Promise<void> => ipcRenderer.invoke('steady:voice-key', key),
  voiceSelfTest: () => ipcRenderer.invoke('steady:voice-selftest'),
  voiceLatency: () => ipcRenderer.invoke('steady:voice-latency'),
});
contextBridge.exposeInMainWorld('steady', api);
