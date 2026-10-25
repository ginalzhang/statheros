/** Fixed wire contract. All timestamps are monotonic milliseconds. */
export const PROTOCOL_VERSION = 1 as const;
export const MAX_MESSAGE_BYTES = 16 * 1024;
export const ACTIONS = ['penDown', 'penUp', 'penToggle', 'click', 'undo', 'redo', 'brush', 'toggleErase', 'bigger', 'smaller', 'pause', 'resume', 'recenter', 'markCorner', 'microphoneOff'] as const;
export type ActionID = typeof ACTIONS[number];
export const LOCAL_ACTIONS = ['openSettings', 'togglePanel', 'quit', 'beginCanvas', 'selectCanvas', 'reviewWorkspace', 'beginLegacyCanvas', 'cancelCanvas', 'recover', 'confirmHand'] as const;
export type LocalActionID = ActionID | typeof LOCAL_ACTIONS[number];
export type ShortcutActionID = 'undo' | 'redo' | 'brush' | 'toggleErase' | 'bigger' | 'smaller';
export interface ShortcutProfile { name: string; targetBundleId: string; shortcuts: Record<ShortcutActionID, string> }
export type GlobalBindings = Partial<Record<LocalActionID, string>>;
export type Mode = 'head' | 'palm';
export type InputState = 'SETUP' | 'PAUSED' | 'HOVER' | 'DRAWING' | 'FAULT';
export interface Point { x: number; y: number }
export interface Rect extends Point { width: number; height: number }
export interface CanvasAccessibilityDiagnostics {
  inspected: number; complete: boolean; truncated: boolean;
  windowSource: 'ax' | 'window-server' | 'none';
  nodes: { path: string; role: string; subrole: string; identifier: string | null; bounds: Rect | null; childCount: number }[];
}
export interface CanvasObservation {
  generation: number; targetPid: number | null; windowId: string | null; layoutToken: string | null;
  windowBounds: Rect | null; windowToken: string | null;
  workspaceSuggestion: Rect | null;
  diagnostics: CanvasAccessibilityDiagnostics | null;
  rect: Rect | null; kind: 'document' | 'viewport' | null;
  availability: 'available' | 'unavailable'; reason: string; observedAt: number;
}
export type CanvasObservationSummary = Omit<CanvasObservation, 'diagnostics'>;
export interface CanvasDiagnosticsReport {
  version: 1; current: CanvasObservation | null; history: CanvasObservationSummary[];
  lastInvalidation: { reason: string; changed: string[]; previous: CanvasObservationSummary | null; current: CanvasObservationSummary | null } | null;
  lastSelectionValidation: {
    stage: 'preview' | 'confirm'; selection: Rect | null; displayBounds: Rect; panelBounds: Rect | null;
    controlsBounds: Rect | null; surfaceBounds: Rect | null; panelIntersection: Rect | null; accepted: boolean;
  } | null;
}
export interface CanvasSetupStatus {
  active: boolean; firstCorner: Point | null; message: string;
  mode: 'idle' | 'detect' | 'mouse' | 'legacy'; phase: 'idle' | 'selecting' | 'preview' | 'confirmed';
  sessionId: string | null; displayId: number | null; preview: Rect | null; initialSelection: Rect | null;
  initialSelectionAdjusted: boolean;
  selectionControlsBounds: Rect | null;
  workspaceSuggestion: Rect | null;
  source: 'manual' | 'document' | 'viewport' | null;
  detection: { availability: 'checking' | 'available' | 'unavailable'; reason: string };
}
export interface CanvasSelectionSession { sessionId: string; generation: number; displayId: number }
export interface CanvasSurfaceSession extends CanvasSelectionSession { surfaceBounds: Rect }
export interface CanvasSelection extends CanvasSurfaceSession { rect: Rect | null }
export interface TrackingSample { generation: number; frameId: number; captureTimestamp: number; mode: Mode; valid: boolean; anchor: Point | null; qualityReason: string; selectedHand?: 'Left' | 'Right' | null }
export interface CalibrationV1 { schemaVersion: 1; cameraId: string; mode: Mode; selectedHand: 'Left' | 'Right' | null; neutral: Point; extents: { left: number; right: number; up: number; down: number }; jitter: Point; gain: number; smoothing: number }
export interface Command { eventId: string; source: 'voice' | 'key' | 'panel'; actionId: ActionID; generation: number }
export interface Permissions { accessibility: boolean; camera: string; microphone: string; speech: string }
export interface NativeState { lastReleaseTimestamp?: number | null; lastValidCaptureTimestamp?: number | null; state: InputState; reason: string; buttonDown: boolean; foregroundTarget: string | null; permissions: Permissions; generation: number; latestValidFrame: number | null }
export interface DisplayInfo { id: number; bounds: Rect; workArea: Rect; builtIn: boolean; primary: boolean; scaleFactor: number }
export interface RequestPayloads {
  hello: { bundleId: 'org.steady.local' };
  configure: { generation: number; targetBundleId: 'org.krita'; targetPid: number; displayId: number; canvas: Rect | null; excludedRects: Rect[] };
  sample: { generation: number; frameId: number; captureTimestamp: number; valid: boolean; position: Point | null };
  action: { generation: number; eventId: string; actionId: ActionID };
  ping: { senderTimestamp: number };
  restoreTarget: { targetPid: number };
  microphone: { enabled: boolean; speechSession: string };
  installSpeechAssets: { locale: 'en-US' };
  shutdown: Record<string, never>;
}
export interface Ack { requestSeq: number; accepted: boolean; code: string; state: NativeState; nativeTimestamp: number | null; protocolVersion?: 1; displays?: DisplayInfo[]; capabilities?: string[]; senderTimestamp?: number; targetPid?: number | null }
export interface SpeechEvent { speechSession: string; utterance: number; actionId: ActionID | null; speechEndTimestamp: number; acceptedTimestamp: number; final: true; reason: string }
export interface ReplyPayloads { ack: Ack; state: NativeState; speech: SpeechEvent; canvasObservation: CanvasObservation; fault: { code: string; message: string } }
export type Envelope<K extends string = string, P = Record<string, unknown>> = { v: 1; session: string; seq: number; type: K; payload: P };
export type Request = { [K in keyof RequestPayloads]: Envelope<K, RequestPayloads[K]> }[keyof RequestPayloads];
export type Reply = { [K in keyof ReplyPayloads]: Envelope<K, ReplyPayloads[K]> }[keyof ReplyPayloads];

/** Preload allowlist: the renderer never chooses a native wire type. */
export interface SpeechDiagnostics {v:1;session:string|null;phase:'idle'|'permission'|'checkingAssets'|'preparing'|'listening'|'stopped'|'error';assets:'unknown'|'installing'|'ready'|'missing'|'error';audioBuffers:number;audioSeconds:number;transcriberResults:number;transcriberFinals:number;detectorResults:number;speechResults:number;silenceResults:number;acceptedUtterances:number;errorCode:string|null}
export interface TrackingProbeMetrics { frames: number; validFrames: number; mappedFrames: number; elapsedMs: number; mappingHz: number; receiptToMappedP95Ms: number | null; position: Point | null; reason: string }
export interface ProbeStatus { canvasSurfaceBounds?: Rect; canvasSetup?: CanvasSetupStatus; canvasDiagnostics?: CanvasDiagnosticsReport; canvas?: Rect | null; targetPid?: number | null; bindings?: GlobalBindings; bindingConflicts?: string[]; profile?: ShortcutProfile;  nativeFault?: string | null; native: NativeState | null; displays: DisplayInfo[]; fault: string | null; collapsed: boolean; settingsOpen: boolean; realInput: boolean; generation: number; microphoneEnabled?: boolean; selectedDisplayId?:number; speechDiagnostics?:SpeechDiagnostics; nativeClockReady?:boolean; settings?: import('./settings').SettingsV1; canvasConfirmed?: boolean; panelOpacity?: number; trackingMetrics?: TrackingProbeMetrics }
export interface SteadyAPI {
  status(): Promise<ProbeStatus>;
  onStatus(callback: (status: ProbeStatus) => void): () => void;
  action(actionId: ActionID): Promise<void>;
  localAction(actionId: LocalActionID): Promise<void>;
  beginCanvas(): Promise<void>;
  copyCanvasDiagnostics(): Promise<void>;
  selectCanvas(): Promise<void>;
  reviewWorkspace(): Promise<void>;
  beginLegacyCanvas(): Promise<void>;
  previewCanvas(selection: CanvasSelection): Promise<void>;
  confirmCanvas(selection: CanvasSurfaceSession): Promise<void>;
  cancelCanvas(sessionId?: string): Promise<void>;
  setRealInput(enabled: boolean): Promise<void>;
  recover(): Promise<void>;
  saveBindings(bindings: GlobalBindings): Promise<void>;
  saveProfile(profile: ShortcutProfile): Promise<void>;
  onLocalAction(callback: (actionId: LocalActionID) => void): () => void;
  onConfirmHand(callback: () => void): () => void;
  collapse(collapsed: boolean): Promise<void>;
  openSettings(): Promise<void>;
  closeSettings(): Promise<void>;
  selectCamera(cameraId: string, mode: Mode): Promise<void>;
  selectDisplay(displayId:number):Promise<void>;
  submitSample(sample: TrackingSample): void;
  recordTrackingMetrics(metrics: TrackingProbeMetrics): Promise<void>;
  onRecenter(callback: () => void): () => void;
  saveCalibration(calibration: CalibrationV1): Promise<void>;
  tuneCalibration(calibration: CalibrationV1): Promise<void>;
  setPanelOpacity(opacity: 1 | 0.7): Promise<void>;
  setCameraOrientation(cameraId: string, flipX: boolean, flipY: boolean): Promise<void>;
  submitMappedProbe(sample: TrackingSample, position: Point | null): void;
  microphone(enabled: boolean): Promise<void>;
  installSpeechAssets(): Promise<void>;
  runNativeProbe(): Promise<void>;
  releaseInput(): Promise<void>;
  registerButtons(buttons: { actionId: LocalActionID; rect: Rect }[]): void;
  quit(): Promise<void>;
  voiceStatus(): Promise<{ snapshot: import('./voice').VoiceSnapshot | null; keySource: 'env' | 'settings' | null }>;
  onVoice(callback: (snapshot: import('./voice').VoiceSnapshot | null, keySource: 'env' | 'settings' | null) => void): () => void;
  onVoiceCapture(callback: (command: import('./voice').VoiceCaptureCommand) => void): () => void;
  voiceFrame(pcm: ArrayBuffer): void;
  voiceReport(report: import('./voice').VoiceCaptureReport): void;
  voiceButton(kind: 'press' | 'longpress'): void;
  voiceCancel(): void;
  setVoiceKey(key: string | null): Promise<void>;
  voiceSelfTest(): Promise<import('./voice').VoiceSelfTest>;
  voiceLatency(): Promise<import('./voice').VoiceLatencyReport | null>;
}
