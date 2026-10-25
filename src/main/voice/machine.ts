import { connectBackstopSeconds, sttFinalSeconds, type VoiceConfig } from './config';
import { classify, joinText, stripWake, wordCount } from './postprocess';
import {
  SESSION_STATES, STATE_TIMERS, UNSTAMPED_TIMERS, UTTERANCE_TIMERS,
  type Confidence, type Endpoint, type TimerName, type VoiceAction, type VoiceContext, type VoiceEvent, type VoiceState,
} from './types';

export const KEY_REJECTED = 'Cartesia key rejected — check CARTESIA_API_KEY';
export const KEY_MISSING = 'CARTESIA_API_KEY is missing';
const BUSY = 'Cartesia busy (concurrency limit)';
const UNREACHABLE = "Couldn't reach Cartesia";
const NETWORK = "Can't reach Cartesia — check network";
const LOST = 'Lost connection, say that again';
const DIDNT_CATCH = "Didn't catch that";
const MIC_PERMISSION = 'Microphone permission needed for Steady — open System Settings › Privacy › Microphone';

/** The capture reason decides the hint; only a real denial is reported as a permission problem. */
export function captureFailedMessage(reason: string): string {
  if (/^(denied|restricted)$|^NotAllowedError\b/.test(reason)) return MIC_PERMISSION;
  // macOS feeds exact zeros when the grant belongs to an earlier (re-signed) build.
  if (reason === 'silent input') return 'Mic is sending only silence — macOS may be blocking this build. Run `tccutil reset Microphone org.steady.local`, relaunch and allow again';
  if (/^NotFoundError\b/.test(reason)) return 'No microphone found — connect or select an input device';
  if (/^NotReadableError\b/.test(reason)) return 'Microphone is busy or unavailable — close other apps using it and try again';
  return `Couldn't open the microphone (${reason})`;
}

/**
 * Pure voice state machine (prompt §5). `handle` is the only mutator of the context
 * (except the runtime's two VAD mirror fields) and never performs I/O.
 * §5 is the behavioral source of truth; comments cite the rule they implement.
 */
export class VoiceStateMachine {
  constructor(private readonly config: VoiceConfig) {}

  handle(event: VoiceEvent, ctx: VoiceContext, now: number): VoiceAction[] {
    return new Step(this.config, ctx, now).run(event);
  }
}

class Step {
  private readonly out: VoiceAction[] = [];
  constructor(private readonly c: VoiceConfig, private readonly ctx: VoiceContext, private readonly now: number) {}

  run(ev: VoiceEvent): VoiceAction[] {
    const ctx = this.ctx;
    switch (ev.type) {
      case 'WakeDetected': this.wakeDetected(ev.phrase, ev.ts); break;
      case 'LocalCommand': this.localCommand(ev.text, ev.ts); break;
      case 'VadSpeechStart': this.vadStart(); break;
      case 'VadSpeechEnd': this.vadEnd(ev.ts, ev.speechMs); break;
      case 'HotkeyDown': this.hotkeyDown(ev.ts); break;
      case 'HotkeyUp': this.hotkeyUp(ev.ts); break;
      case 'HotkeyToggle': this.toggleOrButton(false); break;
      case 'ButtonPressed': this.toggleOrButton(true); break;
      case 'ButtonLongPress': if (ctx.state === 'MUTED') this.unmute(); else this.mute(); break;
      case 'MuteHotkey': if (ctx.state === 'MUTED') this.unmute(); else this.mute(); break;
      case 'Mute': if (ctx.state !== 'MUTED') this.mute(); break;
      case 'Unmute': if (ctx.state === 'MUTED') this.unmute(); break;
      case 'Cancel': this.cancel(); break;
      case 'AppFocused': if (ctx.state === 'MUTED' && ctx.mutedReason === 'permission') this.emit({ type: 'OpenCapture' }); break;
      case 'CaptureOpened': if (ctx.state === 'MUTED' && ctx.mutedReason === 'permission') { this.emit({ type: 'ResetWake' }); this.enter('PASSIVE'); } break;
      case 'SttConnected': this.sttConnected(); break;
      case 'SttSpeechStart': if (ctx.state === 'LISTENING' && this.live('no_speech')) this.setTimer('no_speech', this.c.timers.noSpeechS); else this.log('debug', { event: ev.type }); break;
      case 'SttPartial': this.sttPartial(ev.text, ev.eager); break;
      case 'SttTurnResume': if (ctx.state === 'LISTENING') { ctx.lastPartialEager = false; this.cancelTimer('eager_commit'); } else this.log('debug', { event: ev.type }); break;
      case 'SttFinal': this.sttFinal(ev.text); break;
      case 'SttFinalizeRejected': this.finalizeRejected(); break;
      case 'SttError': this.sttError(ev.code, ev.message, ev.permanent); break;
      case 'SttClosed': this.sttClosed(); break;
      case 'PlaybackStarted': this.playbackStarted(ev.kind, ev.text, ev.playId); break;
      case 'PlaybackStopped': this.playbackStopped(ev.playId); break;
      case 'ProbeResult': this.probe(ev.ok, ev.code); break;
      case 'CaptureFailed':
        this.log('warn', { captureFailed: ev.reason });
        this.abortIfOpen(); this.emit({ type: 'CloseCapture' }); ctx.mutedReason = 'permission'; this.enter('MUTED');
        this.toast(captureFailedMessage(ev.reason), 'warn'); break;
      case 'DeviceChanged':
        if (this.sessionOpen()) { this.abortStt(); this.error('Mic changed, say that again'); }
        else ctx.deviceSwapUntil = this.now + this.c.wake.skipAfterDeviceSwapMs / 1000;
        break;
      case 'AttentionHint': if (ev.facingScreen) ctx.lastAttentionTs = ev.ts; break;
      case 'GestureHint': this.log('debug', { event: ev.type, palmRaised: ev.palmRaised }); break;
      case 'TimerFired': this.timerFired(ev.name, ev.stamp, ev.seq); break;
      case 'CommandDone': this.commandFinished(ev.cmdId, true, ev.resultText); break;
      case 'CommandFailed': this.commandFinished(ev.cmdId, false, ev.message); break;
      case 'Shutdown':
        this.emit({ type: 'CloseCapture' });
        if (this.sessionOpen()) this.sendClose();
        for (const name of [...ctx.timers.keys()]) this.cancelTimer(name);
        ctx.state = 'DISABLED'; this.emit({ type: 'ShowState', state: 'DISABLED' }); break;
    }
    return this.out;
  }

  // ───────────────────────── primitives ─────────────────────────
  private emit(action: VoiceAction): void { this.out.push(action); }
  private log(level: 'debug' | 'info' | 'warn', fields: Record<string, unknown>): void { this.emit({ type: 'Log', level, fields: { state: this.ctx.state, ...fields } }); }
  private toast(message: string, level: 'info' | 'warn' = 'info'): void { this.emit({ type: 'Toast', message, level }); }
  private live(name: TimerName): boolean { return this.ctx.timers.has(name); }
  private sessionOpen(): boolean { return SESSION_STATES.includes(this.ctx.state); }
  private strip(text: string): string { return stripWake(text, this.c); }

  /** SetTimer stamps the current gen; `command` is stamped with its cmd_id; the gate timers are unstamped. Replaces a live timer. */
  private setTimer(name: TimerName, seconds: number, stamp = this.ctx.gen): void {
    const seq = ++this.ctx.timerSeq;
    const effective = UNSTAMPED_TIMERS.includes(name) ? -1 : stamp;
    this.ctx.timers.set(name, { deadline: this.now + seconds, stamp: effective, seq });
    this.emit({ type: 'SetTimer', name, seconds, stamp: effective, seq });
  }
  private cancelTimer(name: TimerName): void {
    if (!this.ctx.timers.delete(name)) return;
    this.emit({ type: 'CancelTimer', name });
  }

  /** State transition: cancels the old state's timers; entering PASSIVE/MUTED/ERROR bumps gen first (§4.5). */
  private enter(next: VoiceState, errorMessage?: string): void {
    const ctx = this.ctx;
    if (ctx.state !== next) {
      for (const name of STATE_TIMERS) this.cancelTimer(name);
      if (next === 'PASSIVE' || next === 'MUTED' || next === 'ERROR') {
        ctx.gen++;
        for (const name of UTTERANCE_TIMERS) this.cancelTimer(name);
      }
    }
    ctx.state = next;
    this.emit({ type: 'ShowState', state: next });
    if (next === 'ERROR') {
      ctx.lastError = errorMessage ?? 'Voice error';
      this.toast(ctx.lastError, 'warn');
      this.setTimer('error_clear', this.c.timers.errorClearS);
    }
  }
  private error(message: string): void { this.enter('ERROR', message); }

  /** OpenStt assigns the session, bumps gen and performs the utterance reset (§4.5). */
  private openStt(kind: Endpoint): void {
    const ctx = this.ctx;
    for (const name of UTTERANCE_TIMERS) this.cancelTimer(name);
    ctx.sessionId = ++ctx.sessionCounter; ctx.gen++; ctx.endpoint = kind;
    ctx.lastPartial = null; ctx.lastPartialEager = false; ctx.speechMs = null; ctx.pendingPrefix = null; ctx.remnantTurns = 0;
    ctx.closeSent = false; ctx.bargeIn = false; ctx.releaseDeferred = false; ctx.sttConnected = false; ctx.tSpeechEnd = null;
    this.emit({ type: 'OpenStt', kind, sessionId: ctx.sessionId });
  }
  /** Gate invariant: AbortStt and SendClose always imply SetCloudGate(false), StopForwarding first. */
  private abortStt(): void {
    this.emit({ type: 'SetCloudGate', on: false }); this.emit({ type: 'StopForwarding' }); this.emit({ type: 'AbortStt' });
    this.ctx.sessionId = null;
  }
  private abortIfOpen(): void { if (this.sessionOpen()) this.abortStt(); }
  private sendClose(): void {
    this.emit({ type: 'SetCloudGate', on: false }); this.emit({ type: 'StopForwarding' }); this.emit({ type: 'SendClose' });
    this.ctx.closeSent = true;
  }
  private gateOff(): void { this.emit({ type: 'SetCloudGate', on: false }); this.emit({ type: 'StopForwarding' }); }

  // ───────────────────────── abort path (§4.5) ─────────────────────────
  /** Returns whether an AbortCommand was actually issued. Never changes state. */
  private abortPath(spokenText: string | null, noHookToast = "Can't stop that one"): boolean {
    const ctx = this.ctx;
    if (ctx.inFlightCmd === null) return false;
    if (ctx.abortSupported) {
      this.emit({ type: 'AbortCommand', cmdId: ctx.inFlightCmd, spokenText });
      ctx.inFlightCmd = null; this.cancelTimer('command');
      return true;
    }
    this.toast(noHookToast);
    return false;
  }
  /** Tap / Toggle / Button / Cancel in EXECUTING. */
  private abortTapInExecuting(): void {
    this.cancelTimer('tap_decide');
    if (this.abortPath(null)) { this.emit({ type: 'PlayEarcon', name: 'cancel' }); this.enter('PASSIVE'); }
  }

  // ───────────────────────── end paths (§5.0) ─────────────────────────
  private softEnd(): void {
    if (this.live('forced_end')) return; // a second soft end while one is pending is a no-op
    this.emit({ type: 'SendFinalize' });
    this.setTimer('forced_end', this.c.timers.forcedEndWaitS);
  }
  private forcedEnd(): void {
    const ctx = this.ctx;
    if (ctx.endpoint === 'auto') {
      if (this.c.stt.autoForcedEnd === 'pad_then_close') {
        // Zeros only, gate stays on for the pad; the runtime then closes (§5.0 forced end).
        this.emit({ type: 'StopForwarding' }); this.emit({ type: 'PadZeros', seconds: this.c.timers.forcedEndWaitS }); ctx.closeSent = true;
      } else this.sendClose();
    } else {
      this.gateOff(); this.emit({ type: 'SendFinalize' }); this.emit({ type: 'SendClose' }); ctx.closeSent = true;
    }
    this.enter('PROCESSING');
    this.setTimer('forced_end', this.c.timers.forcedEndWaitS);
  }
  private normalEnd(text: string, confidence: Confidence): void {
    this.gateOff(); this.ctx.pendingPrefix = null;
    this.ctx.tSpeechEnd ??= this.ctx.lastVadEndTs;
    this.emit({ type: 'ShowState', state: 'PROCESSING' });
    this.outcome(text, confidence);
  }

  /** §9 + PROCESSING outcomes (a)–(d). */
  private outcome(text: string, confidence: Confidence): void {
    const ctx = this.ctx;
    const stripped = this.strip(text);
    const result = classify(stripped, this.c, ctx.speechMs);
    if (result.kind === 'interrupt') return this.interrupt(result.text, true);
    if (result.kind === 'stop-command') {
      if (ctx.inFlightCmd !== null) return this.interrupt(result.text, false);
      if (ctx.bargeIn) return this.dropped('stop after command finished');
      return this.command(result.text, 'command', confidence);
    }
    if (result.kind === 'empty') {
      if (ctx.source === 'wake' && !ctx.closeSent) return this.remnantReentry();
      return this.dropped('empty');
    }
    if (result.kind === 'drop') return this.dropped(result.reason);
    if (confidence === 'low') {
      const mode = this.c.dispatchLowConfidence;
      const dispatch = mode === 'always' || (mode === 'ptt_only' && ctx.source === 'ptt');
      if (!dispatch) {
        this.toast(`Heard '${result.text}' — try again with '${this.c.wake.phrase}'`);
        if (!ctx.closeSent) this.sendClose();
        return this.enter('PASSIVE');
      }
    }
    this.command(result.text, result.commandKind, confidence);
  }
  /** (a) interrupt. */
  private interrupt(spoken: string, always: boolean): void {
    const ctx = this.ctx;
    if (!ctx.closeSent) this.sendClose();
    const issued = ctx.inFlightCmd !== null ? this.abortPath(spoken) : false;
    if (always || issued) this.emit({ type: 'PlayEarcon', name: 'cancel' });
    this.enter('PASSIVE');
  }
  /** (b) remnant-only / empty on the same socket; max_utterance keeps its original deadline. */
  private remnantReentry(): void {
    const ctx = this.ctx;
    if (ctx.speechMs === null) this.log('debug', { remnant: 'already counted' });
    else { ctx.remnantTurns++; ctx.speechMs = null; ctx.lastPartial = null; }
    this.emit({ type: 'SetCloudGate', on: true }); this.emit({ type: 'StartForwarding', fromTs: null });
    if (ctx.state !== 'LISTENING') { this.enter('LISTENING'); this.setTimer('max_utterance', this.c.timers.maxUtteranceS); }
    else this.emit({ type: 'ShowState', state: 'LISTENING' });
    if (!ctx.vadActive) this.setTimer('no_speech', this.c.timers.noSpeechS);
  }
  /** (c) dropped. */
  private dropped(reason: string): void {
    const ctx = this.ctx;
    if (!ctx.closeSent) this.sendClose();
    this.log('info', { dropped: reason });
    if (ctx.source === 'ptt') this.toast(DIDNT_CATCH);
    this.enter('PASSIVE');
  }
  /** (d) command. */
  private command(text: string, kind: 'command' | 'dictation', confidence: Confidence): void {
    if (!this.ctx.closeSent) this.sendClose();
    this.dispatchCommand(text, kind, confidence);
  }
  private dispatchCommand(text: string, kind: 'command' | 'dictation', confidence: Confidence): void {
    const ctx = this.ctx;
    this.emit({ type: 'ShowTranscript', text, final: true });
    if (ctx.inFlightCmd !== null) this.abortPath(null, 'Will run after the current command');
    const cmdId = ++ctx.cmdCounter;
    ctx.inFlightCmd = cmdId;
    this.emit({ type: 'Dispatch', command: {
      cmdId, text, kind, source: ctx.source ?? 'ptt', confidence, utteranceGen: ctx.gen, sessionId: ctx.sessionId ?? 0,
      tWake: ctx.source === 'wake' ? ctx.detectionTs : null, tSpeechEnd: ctx.tSpeechEnd, tFinal: this.now,
    } });
    this.setTimer('command', this.c.timers.commandS, cmdId);
    this.cancelTimer('watchdog');
    this.enter('EXECUTING');
    this.setTimer('executing_spinner', this.c.timers.spinnerDelayMs / 1000);
  }

  /**
   * On-device command keyword: runs straight away while voice is on, no wake phrase and no audio leaves the Mac.
   * An open cloud session owns the utterance (its transcript carries the same words), so it is ignored there.
   */
  private localCommand(text: string, ts: number): void {
    const ctx = this.ctx;
    if (ctx.state === 'MUTED' || ctx.state === 'DISABLED') return;
    if (SESSION_STATES.includes(ctx.state)) return this.log('debug', { localCommand: 'ignored during a cloud session' });
    if (ts <= ctx.wakeGatedUntil || ts < ctx.deviceSwapUntil) return this.log('info', { localCommand: 'gated' });
    const last = ctx.lastLocalCommand;
    if (last && last.text === text && ts - last.ts < this.c.wake.refractoryS) return this.log('info', { localCommand: 'refractory' });
    ctx.lastLocalCommand = { text, ts };
    ctx.source = 'local'; ctx.detectionTs = null; ctx.tSpeechEnd = null;
    this.log('info', { localCommand: text });
    this.dispatchCommand(text, 'command', 'high');
  }

  // ───────────────────────── wake (§5.2) ─────────────────────────
  private attentive(): boolean { return !this.c.wake.requireAttention || this.now - this.ctx.lastAttentionTs <= this.c.wake.attentionWindowMs / 1000; }
  private wakeDetected(phrase: string, ts: number): void {
    const ctx = this.ctx;
    if (ctx.state === 'MUTED' || ctx.state === 'DISABLED') return;
    if (phrase === 'stop') return this.localStop();
    if (ctx.state === 'PROCESSING') { this.abortStt(); this.enter('PASSIVE'); }
    if (!['PASSIVE', 'EXECUTING', 'FEEDBACK', 'ERROR'].includes(ctx.state)) return this.log('debug', { wake: 'ignored in state' });
    if (ts - ctx.lastWakeTs < this.c.wake.refractoryS) return this.log('info', { wake: 'refractory' });
    if (ts <= ctx.wakeGatedUntil) return this.log('info', { wake: 'gated (playback)' });
    if (ts < ctx.deviceSwapUntil) return this.log('info', { wake: 'device swap' });
    if (!this.attentive()) return this.log('info', { wake: 'not facing screen' });
    if (ctx.sttDisabled) return this.toast(ctx.sttDisabledMessage ?? KEY_MISSING, 'warn');
    const fromExecuting = ctx.state === 'EXECUTING';
    ctx.lastWakeTs = ts; ctx.detectionTs = ts; ctx.source = 'wake';
    if (ctx.livePlaybacks.size) this.emit({ type: 'StopPlayback' });
    this.emit({ type: 'PlayEarcon', name: 'wake' });
    this.enter('WAKING');
    this.openStt(this.c.stt.wakeEndpoint);
    if (fromExecuting) ctx.bargeIn = true;
    this.setTimer('watchdog', this.c.timers.watchdogS);
    this.setTimer('connect', connectBackstopSeconds(this.c));
    this.log('info', { wake: 'accepted', ts });
  }
  /** Local "stop" keyword (sherpa path): EXECUTING, PASSIVE with a command in flight, or a barge-in WAKING/LISTENING. */
  private localStop(): void {
    const ctx = this.ctx;
    if (!this.c.wake.localStopKeyword || ctx.inFlightCmd === null || !this.attentive()) return this.log('debug', { stop: 'ignored' });
    const eligible = ctx.state === 'EXECUTING' || ctx.state === 'PASSIVE' || ((ctx.state === 'WAKING' || ctx.state === 'LISTENING') && ctx.bargeIn);
    if (!eligible) return this.log('debug', { stop: 'ignored in state' });
    if (this.abortPath('stop')) {
      this.abortIfOpen();
      this.emit({ type: 'PlayEarcon', name: 'cancel' }); this.toast('stopped'); this.enter('PASSIVE');
    }
  }

  // ───────────────────────── VAD ─────────────────────────
  private vadStart(): void {
    const ctx = this.ctx;
    if (ctx.state === 'LISTENING') for (const name of ['no_speech', 'stt_final', 'manual_end', 'eager_commit'] as const) this.cancelTimer(name);
    else if (ctx.state === 'PTT_ACTIVE') {
      this.cancelTimer('ptt_no_speech');
      this.cancelTimer(ctx.pttMode === 'hold' ? 'hold_silence' : 'ptt_auto_end');
    }
  }
  private textless(): boolean { return this.ctx.lastPartial === null || this.strip(this.ctx.lastPartial) === ''; }
  private vadEnd(ts: number, speechMs: number): void {
    const ctx = this.ctx;
    ctx.speechMs = speechMs; ctx.lastVadEndTs = ts;
    if (ctx.state === 'LISTENING') {
      if (ctx.releaseDeferred) { this.cancelTimer('release_cap'); ctx.releaseDeferred = false; return this.softEnd(); }
      if (ctx.pendingPrefix !== null && this.textless()) { if (!this.live('prefix_timeout')) this.setTimer('prefix_timeout', this.c.stt.prefixTimeoutMs / 1000); return; }
      if (this.textless()) {
        // Text-less pause rule: nothing commandable yet (wake tail, cough, applause). Bounded by max_utterance.
        ctx.remnantTurns++; ctx.speechMs = null; ctx.lastPartial = null;
        if (!ctx.vadActive) this.setTimer('no_speech', this.c.timers.noSpeechS);
        return;
      }
      ctx.tSpeechEnd = ts;
      if (ctx.endpoint === 'auto') {
        this.setTimer('stt_final', sttFinalSeconds(this.c));
        if (ctx.lastPartialEager && this.c.stt.eagerCommit) this.setTimer('eager_commit', this.c.stt.eagerCommitMs / 1000);
      } else this.setTimer('manual_end', this.c.stt.manualEndSilenceMs / 1000);
    } else if (ctx.state === 'PTT_ACTIVE') {
      ctx.tSpeechEnd = ts;
      if (ctx.releaseDeferred) { this.cancelTimer('release_cap'); ctx.releaseDeferred = false; return this.softEnd(); }
      if (ctx.pttMode === 'hold') return this.setTimer('hold_silence', this.c.ptt.holdSilenceS);
      if (this.textless() && speechMs < 250) {
        this.log('debug', { vad: 'earcon/click blip' });
        if (!ctx.vadActive) this.setTimer('ptt_no_speech', this.c.ptt.noSpeechS);
        return;
      }
      this.setTimer('ptt_auto_end', this.c.ptt.autoEndSilenceMs / 1000);
    }
  }

  // ───────────────────────── hotkey / button (§5.1, §8) ─────────────────────────
  private hotkeyDown(ts: number): void {
    const ctx = this.ctx;
    ctx.hotkeyDownTs = ts;
    switch (ctx.state) {
      case 'PASSIVE': case 'FEEDBACK': case 'ERROR': return this.pttEntry('hold', { handoff: false, fromTap: false });
      case 'WAKING': case 'LISTENING': case 'PROCESSING': this.abortStt(); return this.pttEntry('hold', { handoff: true, fromTap: false });
      case 'EXECUTING': return this.setTimer('tap_decide', this.c.ptt.tapMaxMs / 1000);
      case 'PTT_ACTIVE': return this.softEnd(); // hold: lost-HotkeyUp recovery; toggle: second press
      case 'MUTED': return this.toast('unmute first');
      default: return;
    }
  }
  private hotkeyUp(ts: number): void {
    const ctx = this.ctx;
    const downTs = ctx.hotkeyDownTs; ctx.hotkeyDownTs = null;
    if (ctx.state === 'EXECUTING') { if (this.live('tap_decide')) this.abortTapInExecuting(); return; }
    if (ctx.state !== 'PTT_ACTIVE' || ctx.pttMode !== 'hold') return;
    if (this.live('forced_end') || ctx.releaseDeferred) return;
    this.cancelTimer('hold_silence');
    const held = downTs === null ? Infinity : (ts - downTs) * 1000;
    if (held < this.c.ptt.tapMaxMs && !ctx.bargeIn) {
      ctx.pttMode = 'toggle';
      this.emit({ type: 'PlayEarcon', name: 'wake' });
      if (!ctx.vadActive) this.setTimer('ptt_no_speech', this.c.ptt.noSpeechS);
      return;
    }
    const grace = ctx.speechMs === null || ctx.lastVadEndTs === null ? this.c.ptt.releaseGraceMs : Math.max(0, this.c.ptt.releaseGraceMs - (this.now - ctx.lastVadEndTs) * 1000);
    this.setTimer('release_grace', grace / 1000);
  }
  private toggleOrButton(button: boolean): void {
    const ctx = this.ctx;
    switch (ctx.state) {
      case 'PASSIVE': case 'FEEDBACK': case 'ERROR': return this.pttEntry('toggle', { handoff: false, fromTap: false });
      case 'WAKING': case 'LISTENING': case 'PROCESSING':
        if (button) return this.cancel(); // users tap the mic to stop
        this.abortStt(); return this.pttEntry('toggle', { handoff: true, fromTap: false });
      case 'EXECUTING': return this.abortTapInExecuting();
      case 'PTT_ACTIVE': return this.softEnd();
      case 'MUTED': return this.toast('unmute first');
      default: return;
    }
  }
  /** PTT entry (§5.2). */
  private pttEntry(mode: 'hold' | 'toggle', options: { handoff: boolean; fromTap: boolean }): void {
    const ctx = this.ctx;
    if (ctx.sttDisabled) {
      this.toast(ctx.sttDisabledMessage ?? KEY_MISSING, 'warn');
      if (options.handoff) this.enter('PASSIVE');
      return;
    }
    const previousSource = ctx.source;
    ctx.source = 'ptt'; ctx.pttMode = mode;
    this.enter('PTT_ACTIVE');
    this.openStt('manual');
    if (options.fromTap) ctx.bargeIn = true;
    const from = options.fromTap ? ctx.hotkeyDownTs : options.handoff && previousSource === 'wake' && ctx.detectionTs !== null ? ctx.detectionTs - this.c.wake.prerollMs / 1000 : null;
    this.emit({ type: 'SetCloudGate', on: true });
    this.emit({ type: 'StartForwarding', fromTs: from });
    if (ctx.livePlaybacks.size) this.emit({ type: 'StopPlayback' });
    if (!options.handoff && mode === 'toggle') this.emit({ type: 'PlayEarcon', name: 'wake' });
    this.setTimer('watchdog', this.c.timers.watchdogS);
    this.setTimer('connect', connectBackstopSeconds(this.c));
    this.setTimer('max_utterance', this.c.timers.maxUtterancePttS);
    if (options.handoff && mode === 'toggle' && !ctx.vadActive) this.setTimer('ptt_auto_end', this.c.ptt.autoEndSilenceMs / 1000);
    else if (!ctx.vadActive) this.setTimer('ptt_no_speech', this.c.ptt.noSpeechS);
  }

  // ───────────────────────── global (§5.2) ─────────────────────────
  private cancel(): void {
    const ctx = this.ctx;
    if (ctx.state === 'EXECUTING') return this.abortTapInExecuting();
    if (this.sessionOpen()) {
      this.abortStt();
      if (ctx.inFlightCmd !== null) this.abortPath(null);
      this.emit({ type: 'PlayEarcon', name: 'cancel' });
      return this.enter('PASSIVE');
    }
    if (ctx.state === 'PASSIVE' && ctx.inFlightCmd !== null) { if (this.abortPath(null)) this.emit({ type: 'PlayEarcon', name: 'cancel' }); return; }
    if (ctx.state === 'FEEDBACK') return this.enter('PASSIVE');
    this.log('debug', { event: 'Cancel' });
  }
  private mute(): void {
    this.abortIfOpen();
    this.emit({ type: 'CloseCapture' });
    this.ctx.mutedReason = 'user';
    this.enter('MUTED');
  }
  private unmute(): void {
    this.ctx.mutedReason = null;
    this.emit({ type: 'OpenCapture' }); this.emit({ type: 'ResetWake' });
    this.enter('PASSIVE');
  }
  private probe(ok: boolean, code: number | string | null): void {
    if (ok) return this.log('info', { probe: 'ok' });
    if (code === 401 || code === 403) { this.ctx.sttDisabled = true; this.ctx.sttDisabledMessage = KEY_REJECTED; return this.toast(KEY_REJECTED, 'warn'); }
    this.toast(code === 429 ? BUSY : NETWORK, 'warn');
  }
  private playbackStarted(kind: 'earcon' | 'tts', text: string | null, playId: string): void {
    const ctx = this.ctx;
    ctx.livePlaybacks.add(playId);
    const keywords = [this.c.wake.phrase.trim().split(/\s+/).pop()?.toLowerCase(), ...(this.c.wake.localStopKeyword ? ['stop'] : [])].filter(Boolean) as string[];
    const gates = kind === 'earcon' || (text !== null && keywords.some(word => new RegExp(`\\b${word}\\b`, 'i').test(text)));
    if (!gates) return;
    this.cancelTimer('wake_gate_tail');
    this.emit({ type: 'SetWakeEnabled', enabled: false });
    ctx.wakeGatedUntil = Infinity; ctx.gatingPlayId = playId;
    this.setTimer('gate_cap', kind === 'earcon' ? this.c.wake.gateCapS.earcon : this.c.wake.gateCapS.tts);
  }
  private playbackStopped(playId: string): void {
    const ctx = this.ctx;
    ctx.livePlaybacks.delete(playId);
    if (playId !== ctx.gatingPlayId) return;
    ctx.gatingPlayId = null;
    this.cancelTimer('gate_cap');
    this.setTimer('wake_gate_tail', this.c.wake.playbackGateTailMs / 1000);
  }
  private reenableWake(): void {
    this.emit({ type: 'SetWakeEnabled', enabled: true }); this.emit({ type: 'ResetWake' });
    this.ctx.wakeGatedUntil = this.now;
  }

  // ───────────────────────── STT events ─────────────────────────
  private sttConnected(): void {
    const ctx = this.ctx;
    ctx.sttConnected = true;
    if (ctx.state === 'WAKING') {
      // WAKING is provably cloud-silent: forwarding starts only after the handshake (§11.1).
      this.enter('LISTENING');
      this.emit({ type: 'SetCloudGate', on: true });
      this.emit({ type: 'StartForwarding', fromTs: ctx.detectionTs === null ? null : ctx.detectionTs - this.c.wake.prerollMs / 1000 });
      this.setTimer('max_utterance', this.c.timers.maxUtteranceS);
      if (!ctx.vadActive) this.setTimer('no_speech', this.c.timers.noSpeechS);
    } else if (ctx.state === 'PTT_ACTIVE') {
      this.cancelTimer('connect');
      if (this.live('forced_end')) this.setTimer('forced_end', this.c.timers.forcedEndWaitS);
    } else this.log('debug', { event: 'SttConnected duplicate' });
  }
  private lagCorrectiveArm(): void {
    if (this.ctx.endpoint === 'auto') this.setTimer('stt_final', sttFinalSeconds(this.c));
    else this.setTimer('manual_end', this.c.stt.manualEndSilenceMs / 1000);
  }
  private sttPartial(text: string, eager: boolean): void {
    const ctx = this.ctx;
    const stripped = this.strip(text);
    if (ctx.state === 'LISTENING') {
      ctx.lastPartial = text; ctx.lastPartialEager = eager;
      this.emit({ type: 'ShowTranscript', text: stripped, final: false });
      if (!stripped) return;
      if (this.live('prefix_timeout') || this.live('no_speech')) {
        this.cancelTimer('prefix_timeout'); this.cancelTimer('no_speech');
        if (!ctx.vadActive) this.lagCorrectiveArm();
      }
      if (eager && !ctx.vadActive && this.c.stt.eagerCommit) this.setTimer('eager_commit', this.c.stt.eagerCommitMs / 1000);
    } else if (ctx.state === 'PTT_ACTIVE') {
      ctx.lastPartial = text; ctx.lastPartialEager = false;
      this.emit({ type: 'ShowTranscript', text: stripped, final: false });
      if (stripped && this.live('ptt_no_speech')) {
        this.cancelTimer('ptt_no_speech');
        if (ctx.pttMode === 'toggle' && !ctx.vadActive) this.setTimer('ptt_auto_end', this.c.ptt.autoEndSilenceMs / 1000);
      }
    } else if (ctx.state === 'PROCESSING') {
      ctx.lastPartial = text;
      this.emit({ type: 'ShowTranscript', text: stripped, final: false });
    } else this.log('debug', { event: 'SttPartial' });
  }
  private sttFinal(text: string): void {
    const ctx = this.ctx;
    if (ctx.state === 'LISTENING') {
      ctx.lastPartial = null; ctx.lastPartialEager = false;
      for (const name of ['forced_end', 'stt_final', 'eager_commit', 'manual_end', 'prefix_timeout'] as const) this.cancelTimer(name);
      const s = this.strip(text);
      if (!s && ctx.pendingPrefix !== null) return this.normalEnd(ctx.pendingPrefix, 'high');
      if (!s) return this.outcome('', 'high');
      if (ctx.vadRawActive && wordCount(s) <= 1) {
        // The user resumed within one RTT of turn.end: hold the word and join it to the next Final.
        ctx.pendingPrefix = ctx.pendingPrefix ? joinText(ctx.pendingPrefix, s) : s;
        return this.setTimer('prefix_timeout', this.c.stt.prefixTimeoutMs / 1000);
      }
      return this.normalEnd(ctx.pendingPrefix !== null ? joinText(ctx.pendingPrefix, s) : text, 'high');
    }
    if (ctx.state === 'PTT_ACTIVE') {
      ctx.lastPartial = null;
      this.cancelTimer('forced_end');
      return this.normalEnd(text, 'high');
    }
    if (ctx.state === 'PROCESSING') {
      this.cancelTimer('forced_end');
      const s = this.strip(text);
      return this.normalEnd(ctx.pendingPrefix !== null ? joinText(ctx.pendingPrefix, s) : text, 'high');
    }
    this.log('debug', { event: 'SttFinal (after commit)' });
  }
  private finalizeRejected(): void {
    const ctx = this.ctx;
    if (ctx.state === 'LISTENING' || ctx.state === 'PTT_ACTIVE') {
      // Never re-send finalize synchronously; VadSpeechEnd or release_cap does.
      this.cancelTimer('forced_end'); ctx.releaseDeferred = true;
      this.setTimer('release_cap', this.c.ptt.releaseSpeechCapS);
      this.log('info', { event: 'SttFinalizeRejected' });
    } else this.log('debug', { event: 'SttFinalizeRejected' });
  }
  private sttError(code: number | string, message: string, permanent: boolean): void {
    const ctx = this.ctx;
    if (permanent) {
      ctx.sttDisabled = true; ctx.sttDisabledMessage = KEY_REJECTED;
      if (this.sessionOpen()) this.abortStt();
      return this.error(KEY_REJECTED);
    }
    if (ctx.state === 'PROCESSING') return this.log('info', { sttError: code, message });
    if (!this.sessionOpen()) return this.log('debug', { sttError: code, message });
    this.abortStt();
    this.error(code === 429 ? BUSY : ctx.sttConnected ? LOST : UNREACHABLE);
  }
  private sttClosed(): void {
    const ctx = this.ctx;
    if (ctx.state === 'PROCESSING') return this.forcedEndFired();
    if (ctx.state === 'WAKING' || ctx.state === 'LISTENING' || ctx.state === 'PTT_ACTIVE') { this.abortStt(); return this.error(ctx.sttConnected ? LOST : UNREACHABLE); }
    this.log('debug', { event: 'SttClosed' });
  }

  // ───────────────────────── timers ─────────────────────────
  private timerFired(name: TimerName, stamp: number, seq: number): void {
    const ctx = this.ctx;
    const live = ctx.timers.get(name);
    if (!live || live.seq !== seq || live.stamp !== stamp) return this.log('debug', { staleTimer: name });
    if (name === 'command') { if (stamp !== ctx.inFlightCmd) return this.log('debug', { staleTimer: name }); }
    else if (!UNSTAMPED_TIMERS.includes(name) && stamp !== ctx.gen) return this.log('debug', { staleTimer: name });
    ctx.timers.delete(name);
    switch (name) {
      case 'watchdog': this.abortStt(); this.log('warn', { timer: 'watchdog' }); return this.enter('PASSIVE');
      case 'connect': this.abortStt(); return this.error(UNREACHABLE);
      case 'no_speech': this.sendClose(); return this.enter('PASSIVE');
      case 'ptt_no_speech': this.abortStt(); this.toast(DIDNT_CATCH); return this.enter('PASSIVE');
      case 'max_utterance': case 'stt_final': return this.forcedEnd();
      case 'eager_commit': {
        const text = joinText(ctx.pendingPrefix, ctx.lastPartial);
        this.sendClose();
        return this.normalEnd(text, 'high');
      }
      case 'manual_end': case 'hold_silence': case 'ptt_auto_end': return this.softEnd();
      case 'prefix_timeout':
        if (ctx.vadActive) return this.setTimer('prefix_timeout', this.c.stt.prefixTimeoutMs / 1000);
        return this.normalEnd(ctx.pendingPrefix ?? '', 'high');
      case 'tap_decide': return this.pttEntry('hold', { handoff: false, fromTap: true });
      case 'release_grace':
        if (ctx.vadActive) { ctx.releaseDeferred = true; return this.setTimer('release_cap', this.c.ptt.releaseSpeechCapS); }
        return this.softEnd();
      case 'release_cap': ctx.releaseDeferred = false; return this.softEnd();
      case 'forced_end': return this.forcedEndFired();
      case 'command': {
        this.toast('That took too long', 'warn');
        if (ctx.abortSupported) this.abortPath(null);
        else { ctx.inFlightCmd = null; this.log('warn', { command: 'executor still busy' }); }
        if (ctx.state === 'EXECUTING') this.enter('PASSIVE');
        return;
      }
      case 'executing_spinner': return this.emit({ type: 'ShowWorking' });
      case 'feedback_min': case 'error_clear': return this.enter('PASSIVE');
      case 'wake_gate_tail': return this.reenableWake();
      case 'gate_cap':
        if (ctx.gatingPlayId !== null) { ctx.livePlaybacks.delete(ctx.gatingPlayId); ctx.gatingPlayId = null; }
        return this.reenableWake();
    }
  }
  private forcedEndFired(): void {
    const ctx = this.ctx;
    this.cancelTimer('forced_end');
    this.gateOff();
    const text = joinText(ctx.pendingPrefix, ctx.lastPartial);
    ctx.pendingPrefix = null;
    this.emit({ type: 'ShowState', state: 'PROCESSING' });
    if (text) return this.outcome(text, 'low');
    this.dropped('no final');
  }

  // ───────────────────────── commands ─────────────────────────
  private commandFinished(cmdId: number, ok: boolean, text: string | null): void {
    const ctx = this.ctx;
    if (cmdId !== ctx.inFlightCmd) return this.log('debug', { command: 'unmatched', cmdId, ok });
    ctx.inFlightCmd = null; this.cancelTimer('command');
    const message = (text ?? '').slice(0, 80);
    if (ctx.state === 'EXECUTING') {
      if (!ok) return this.error(message || "That didn't work");
      this.enter('FEEDBACK');
      this.toast(message || 'Done');
      return this.setTimer('feedback_min', this.c.timers.feedbackMinMs / 1000);
    }
    this.toast(message || (ok ? 'Done' : "That didn't work"), ok ? 'info' : 'warn');
  }
}
