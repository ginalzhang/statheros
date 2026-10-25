/** Voice layer configuration (CARTESIA_VOICE_INPUT_PROMPT.md §12). Timer values are never hard-coded elsewhere. */
export interface VoiceConfig {
  enabled: boolean;
  dispatchLowConfidence: 'ptt_only' | 'always' | 'never';
  audio: { frameQueueMax: number };
  wake: {
    phrase: string; keywordsFile: string; refractoryS: number; prerollMs: number; playbackGateTailMs: number;
    gateCapS: { earcon: number; tts: number }; skipAfterDeviceSwapMs: number; localStopKeyword: boolean;
    remnantAliases: string[]; requireAttention: boolean; attentionWindowMs: number;
    /** After an on-device command keyword runs, stream that utterance to Cartesia to hear counts and follow-ons ("undo … three times"). */
    localFollowUp: boolean;
    /**
     * Open mic: with the mic on, an utterance with no command word is sent to Cartesia (and Claude) without a wake phrase.
     * Command words still run on-device at once and keep their utterance local.
     */
    openMic: boolean; openPrerollMs: number; openMinSpeechMs: number;
  };
  vad: { threshold: number; hangoverMs: number };
  stt: {
    model: string; wakeEndpoint: 'auto' | 'manual'; eagerCommit: boolean; eagerCommitMs: number; prefixTimeoutMs: number;
    autoForcedEnd: 'close' | 'pad_then_close'; manualEndSilenceMs: number; sampleRate: 16000; chunkMs: 100; keyterms: string[];
    turn: { startThreshold: number; eagerEndThreshold: number; endThreshold: number; endTimeoutMs: number };
    connectTimeoutS: number; connectAttempts: number;
  };
  timers: { noSpeechS: number; maxUtteranceS: number; maxUtterancePttS: number; forcedEndWaitS: number; commandS: number; spinnerDelayMs: number; feedbackMinMs: number; errorClearS: number; watchdogS: number };
  ptt: {
    hotkey: string; muteHotkey: string; tapMaxMs: number; releaseGraceMs: number; releaseSpeechCapS: number; holdSilenceS: number;
    autoEndSilenceMs: number; noSpeechS: number; muteHotkeyDebounceMs: number; palmToggle: boolean; palmDwellMs: number; palmReleaseMs: number;
  };
  interrupts: { always: string; inFlightOnly: string };
  hallucinationBlocklist: string[];
}

/** Cartesia API version: a code constant, never an environment variable (Appendix A). */
export const CARTESIA_VERSION = '2026-08-14';

export const defaultVoiceConfig = (): VoiceConfig => ({
  enabled: true,
  // Steady's command layer is a fixed vocabulary, not LLM-backed (docs/voice/DISCOVERY.md §4).
  dispatchLowConfidence: 'ptt_only',
  audio: { frameQueueMax: 25 },
  wake: {
    phrase: 'hey cartesia', keywordsFile: 'keywords.txt', refractoryS: 1.0,
    // Keyword spotting fires up to ~1 s after the phrase ends; in one breath the command is already spoken by then.
    prerollMs: 1500, playbackGateTailMs: 200,
    gateCapS: { earcon: 1, tts: 30 }, skipAfterDeviceSwapMs: 500, localStopKeyword: true, remnantAliases: [],
    requireAttention: false, attentionWindowMs: 1500,
    // Off: command words stay on-device and instant. Counts ("undo three times") work after the wake phrase or push-to-talk.
    localFollowUp: false,
    // Pre-roll covers VAD onset lag only; a longer one could re-send the previous utterance's command word.
    openMic: true, openPrerollMs: 300, openMinSpeechMs: 250,
  },
  vad: { threshold: 0.5, hangoverMs: 600 },
  stt: {
    model: 'ink-2', wakeEndpoint: 'auto', eagerCommit: false, eagerCommitMs: 300, prefixTimeoutMs: 1000, autoForcedEnd: 'close',
    manualEndSilenceMs: 150, sampleRate: 16000, chunkMs: 100,
    keyterms: ['pen', 'down', 'up', 'toggle', 'click', 'undo', 'redo', 'brush', 'erase', 'bigger', 'smaller', 'pause', 'resume', 'recenter', 'corner', 'microphone', 'Steady'],
    turn: { startThreshold: 0.7, eagerEndThreshold: 0.6, endThreshold: 0.4, endTimeoutMs: 1500 },
    connectTimeoutS: 4, connectAttempts: 2,
  },
  // Steady commands are native acks (sub-second); command_s = max(30, 2 × worst case).
  timers: { noSpeechS: 6, maxUtteranceS: 15, maxUtterancePttS: 60, forcedEndWaitS: 1, commandS: 30, spinnerDelayMs: 400, feedbackMinMs: 700, errorClearS: 3, watchdogS: 75 },
  ptt: {
    hotkey: 'CommandOrControl+Shift+Space', muteHotkey: 'CommandOrControl+Shift+M', tapMaxMs: 250, releaseGraceMs: 400, releaseSpeechCapS: 1.5,
    holdSilenceS: 6, autoEndSilenceMs: 400, noSpeechS: 8, muteHotkeyDebounceMs: 500, palmToggle: false, palmDwellMs: 1000, palmReleaseMs: 300,
  },
  interrupts: { always: '^((cancel|never ?mind|forget it)[,. ]*){1,3}(that|it)?$', inFlightOnly: '^(stop[,. ]*){1,3}(it|that)?$' },
  hallucinationBlocklist: ['thank you', 'thanks for watching', 'you', 'bye', 'um', 'uh'],
});

/** stt_final = turn.end_timeout + 1 s − VAD hangover (= 1.9 s with defaults). */
export const sttFinalSeconds = (c: VoiceConfig): number => c.stt.turn.endTimeoutMs / 1000 + 1.0 - c.vad.hangoverMs / 1000;
/** Machine backstop for open(): its own deadline normally fails first. */
export const connectBackstopSeconds = (c: VoiceConfig): number => c.stt.connectTimeoutS + 1;
/** Ring buffer frames: the pre-roll must survive the worst-case connect (≈5 s). */
export const ringFrames = (c: VoiceConfig): number => Math.ceil((c.stt.connectTimeoutS + c.wake.prerollMs / 1000 + 0.5) / 0.08);
/** Keyterms: the title-cased last word of the wake phrase always comes first (§9.2). */
export function effectiveKeyterms(c: VoiceConfig): string[] {
  const last = c.wake.phrase.trim().split(/\s+/).pop() ?? '';
  const title = last ? last[0]!.toUpperCase() + last.slice(1).toLowerCase() : '';
  return [...(title ? [title] : []), ...c.stt.keyterms.filter(term => term.toLowerCase() !== title.toLowerCase())];
}
