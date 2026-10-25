/** Events, actions and context of the voice state machine (prompt §4.2–4.4). */
export type VoiceState = 'DISABLED' | 'PASSIVE' | 'WAKING' | 'LISTENING' | 'PTT_ACTIVE' | 'PROCESSING' | 'EXECUTING' | 'FEEDBACK' | 'ERROR' | 'MUTED';
export type Endpoint = 'auto' | 'manual';
export type Confidence = 'high' | 'low';
export type EarconName = 'wake' | 'cancel';

export type TimerName =
  | 'watchdog' | 'connect' | 'no_speech' | 'ptt_no_speech' | 'max_utterance' | 'stt_final' | 'eager_commit' | 'manual_end'
  | 'prefix_timeout' | 'tap_decide' | 'release_grace' | 'release_cap' | 'hold_silence' | 'ptt_auto_end' | 'forced_end' | 'command'
  | 'executing_spinner' | 'feedback_min' | 'error_clear' | 'wake_gate_tail' | 'gate_cap';

/** Cancelled on exit from the state that armed them. */
export const STATE_TIMERS: readonly TimerName[] = ['connect', 'no_speech', 'ptt_no_speech', 'max_utterance', 'stt_final', 'eager_commit', 'manual_end', 'prefix_timeout', 'tap_decide', 'release_grace', 'release_cap', 'hold_silence', 'ptt_auto_end', 'executing_spinner', 'feedback_min', 'error_clear'];
/** Cancelled on entering PASSIVE, MUTED or ERROR, or on a new utterance. */
export const UTTERANCE_TIMERS: readonly TimerName[] = ['watchdog', 'forced_end'];
/** Survive every state and generation; never ignored by the gen rule. */
export const UNSTAMPED_TIMERS: readonly TimerName[] = ['wake_gate_tail', 'gate_cap'];

export interface CommandEvent {
  cmdId: number; text: string; kind: 'command' | 'dictation'; source: 'wake' | 'ptt'; confidence: Confidence;
  utteranceGen: number; sessionId: number; tWake: number | null; tSpeechEnd: number | null; tFinal: number;
}

export type VoiceEvent =
  | { type: 'WakeDetected'; phrase: string; ts: number; score: number | null }
  | { type: 'VadSpeechStart'; ts: number }
  | { type: 'VadSpeechEnd'; ts: number; speechMs: number }
  | { type: 'HotkeyDown'; ts: number }
  | { type: 'HotkeyUp'; ts: number }
  | { type: 'HotkeyToggle' }
  | { type: 'ButtonPressed' }
  | { type: 'ButtonLongPress' }
  | { type: 'MuteHotkey' }
  | { type: 'Cancel'; reason: 'esc' | 'click' }
  | { type: 'Mute' }
  | { type: 'Unmute' }
  | { type: 'AppFocused' }
  | { type: 'CaptureOpened' }
  | { type: 'SttConnected'; sessionId: number }
  | { type: 'SttSpeechStart'; sessionId: number }
  | { type: 'SttPartial'; sessionId: number; text: string; eager: boolean }
  | { type: 'SttTurnResume'; sessionId: number }
  | { type: 'SttFinal'; sessionId: number; text: string }
  | { type: 'SttFinalizeRejected'; sessionId: number }
  | { type: 'SttError'; sessionId: number; code: number | string; message: string; permanent: boolean }
  | { type: 'SttClosed'; sessionId: number }
  | { type: 'PlaybackStarted'; kind: 'earcon' | 'tts'; text: string | null; playId: string }
  | { type: 'PlaybackStopped'; playId: string }
  | { type: 'ProbeResult'; ok: boolean; code: number | string | null }
  | { type: 'CaptureFailed'; reason: string }
  | { type: 'DeviceChanged' }
  | { type: 'AttentionHint'; facingScreen: boolean; ts: number }
  | { type: 'GestureHint'; palmRaised: boolean; ts: number }
  | { type: 'TimerFired'; name: TimerName; stamp: number; seq: number }
  | { type: 'CommandDone'; cmdId: number; resultText: string | null }
  | { type: 'CommandFailed'; cmdId: number; message: string }
  | { type: 'Shutdown' };

export type VoiceAction =
  | { type: 'OpenStt'; kind: Endpoint; sessionId: number }
  | { type: 'StartForwarding'; fromTs: number | null }
  | { type: 'StopForwarding' }
  | { type: 'SendFinalize' }
  | { type: 'SendClose' }
  | { type: 'AbortStt' }
  | { type: 'SetCloudGate'; on: boolean }
  | { type: 'SetWakeEnabled'; enabled: boolean }
  | { type: 'ResetWake' }
  | { type: 'PlayEarcon'; name: EarconName }
  | { type: 'StopPlayback' }
  | { type: 'ShowState'; state: VoiceState }
  | { type: 'ShowWorking' }
  | { type: 'ShowTranscript'; text: string; final: boolean }
  | { type: 'Toast'; message: string; level: 'info' | 'warn' }
  | { type: 'Dispatch'; command: CommandEvent }
  | { type: 'AbortCommand'; cmdId: number; spokenText: string | null }
  | { type: 'SetTimer'; name: TimerName; seconds: number; stamp: number; seq: number }
  | { type: 'CancelTimer'; name: TimerName }
  | { type: 'OpenCapture' }
  | { type: 'CloseCapture' }
  | { type: 'PadZeros'; seconds: number }
  | { type: 'Log'; level: 'debug' | 'info' | 'warn'; fields: Record<string, unknown> };

export interface LiveTimer { deadline: number; stamp: number; seq: number }

export interface VoiceContext {
  state: VoiceState; gen: number; sessionId: number | null; sessionCounter: number; source: 'wake' | 'ptt' | null; endpoint: Endpoint;
  pttMode: 'hold' | 'toggle'; hotkeyDownTs: number | null; releaseDeferred: boolean; detectionTs: number | null; lastWakeTs: number;
  vadActive: boolean; vadRawActive: boolean; lastVadEndTs: number | null; speechMs: number | null;
  lastPartial: string | null; lastPartialEager: boolean; pendingPrefix: string | null; remnantTurns: number; closeSent: boolean; sttConnected: boolean;
  cmdCounter: number; inFlightCmd: number | null; abortSupported: boolean; bargeIn: boolean;
  wakeGatedUntil: number; livePlaybacks: Set<string>; gatingPlayId: string | null;
  timers: Map<TimerName, LiveTimer>; timerSeq: number;
  sttDisabled: boolean; sttDisabledMessage: string | null; deviceSwapUntil: number; mutedReason: 'user' | 'permission' | null; lastAttentionTs: number;
  lastError: string | null; tSpeechEnd: number | null;
}

export function createContext(options: { abortSupported: boolean; sttDisabled?: boolean; sttDisabledMessage?: string | null }): VoiceContext {
  return {
    state: 'PASSIVE', gen: 0, sessionId: null, sessionCounter: 0, source: null, endpoint: 'auto', pttMode: 'hold', hotkeyDownTs: null,
    releaseDeferred: false, detectionTs: null, lastWakeTs: -Infinity, vadActive: false, vadRawActive: false, lastVadEndTs: null, speechMs: null,
    lastPartial: null, lastPartialEager: false, pendingPrefix: null, remnantTurns: 0, closeSent: false, sttConnected: false,
    cmdCounter: 0, inFlightCmd: null, abortSupported: options.abortSupported, bargeIn: false,
    wakeGatedUntil: -Infinity, livePlaybacks: new Set(), gatingPlayId: null, timers: new Map(), timerSeq: 0,
    sttDisabled: options.sttDisabled ?? false, sttDisabledMessage: options.sttDisabledMessage ?? null, deviceSwapUntil: -Infinity,
    mutedReason: null, lastAttentionTs: -Infinity, lastError: null, tSpeechEnd: null,
  };
}

export const SESSION_STATES: readonly VoiceState[] = ['WAKING', 'LISTENING', 'PTT_ACTIVE', 'PROCESSING'];
export const ACTIVE_STATES: readonly VoiceState[] = ['WAKING', 'LISTENING', 'PTT_ACTIVE', 'PROCESSING', 'EXECUTING'];
