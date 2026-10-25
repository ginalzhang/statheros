/** Voice snapshot shared with the renderer. The renderer never sees the API key or raw socket messages. */
export type VoiceStateName = 'DISABLED' | 'PASSIVE' | 'WAKING' | 'LISTENING' | 'PTT_ACTIVE' | 'PROCESSING' | 'EXECUTING' | 'FEEDBACK' | 'ERROR' | 'MUTED';
export interface VoiceSnapshot {
  captureOpen: boolean;
  state: VoiceStateName; transcript: string; transcriptFinal: boolean; cloudOn: boolean; levelDbfs: number | null; lastError: string | null;
  sttDisabled: boolean; inFlight: boolean; working: boolean; toast: { id: number; message: string; level: 'info' | 'warn' } | null;
  wakePhrase: string; hotkey: string; muteHotkey: string; wakeReady: boolean; vad: 'silero' | 'energy' | 'none'; keyPresent: boolean;
}
/** Main → panel capture commands. */
export type VoiceCaptureCommand = { type: 'open' } | { type: 'close' } | { type: 'earcon'; name: 'wake' | 'cancel'; playId: string } | { type: 'stopPlayback' };
/** Panel → main capture reports. */
export type VoiceCaptureReport =
  | { type: 'opened' } | { type: 'failed'; reason: string } | { type: 'deviceChanged' }
  | { type: 'earconStarted'; playId: string } | { type: 'earconStopped'; playId: string };
export interface VoiceSelfTest { ok: boolean; samplesPerSecond: number; peakDbfs: number | null; message: string }
export interface VoiceLatencyReport { utterances: number; wakeToFirstByte: { median: number | null; max: number | null }; speechEndToFinal: { median: number | null; max: number | null }; finalToDispatch: { median: number | null; max: number | null }; inferenceMeanMs: number | null }
export const initialVoiceSnapshot = (): VoiceSnapshot => ({ captureOpen: false, state: 'DISABLED', transcript: '', transcriptFinal: false, cloudOn: false, levelDbfs: null, lastError: null, sttDisabled: false, inFlight: false, working: false, toast: null, wakePhrase: 'hey cartesia', hotkey: '', muteHotkey: '', wakeReady: false, vad: 'none', keyPresent: false });
