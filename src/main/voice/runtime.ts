import { randomUUID } from 'node:crypto';
import { ringFrames, type VoiceConfig } from './config';
import { FRAME_SECONDS, isSilentZero, peakDbfs, RingBuffer, type Frame } from './audio';
import { Forwarder, realClock, type PacingClock } from './forwarder';
import { KEY_MISSING, VoiceStateMachine } from './machine';
import { SttSession, type SessionSignal, type SocketFactory } from './stt-session';
import type { InferenceResult } from './inference';
import { createContext, type CommandEvent, type EarconName, type TimerName, type VoiceAction, type VoiceContext, type VoiceEvent } from './types';
import type { VoiceSnapshot } from '../../shared/voice';

/** What the voice module needs from the app. The module never draws (prompt §4.5 UI). */
export interface VoiceHost {
  /** <<COMMAND_ENTRYPOINT>>: resolves after the action completes with a short result, rejects with a user-facing message. */
  executeCommand(command: CommandEvent): Promise<string | null>;
  /** Cancel hook; omitted when the command layer has none (abort_supported = false). */
  abortCommand?: (cmdId: number, spokenText: string | null) => void;
  openCapture(): void;
  closeCapture(): void;
  playEarcon(name: EarconName, playId: string): void;
  stopPlayback(): void;
  /** `frame` receives a copy it may transfer to another thread. */
  inference: { frame(pcm: Int16Array, ts: number): void; setWakeEnabled(enabled: boolean): void; resetWake(): void; reset(): void };
  changed(snapshot: VoiceSnapshot): void;
  log(level: 'debug' | 'info' | 'warn', fields: Record<string, unknown>): void;
}

export type { VoiceSnapshot } from '../../shared/voice';

export interface UtteranceLatency { wakeToFirstByteMs: number | null; speechEndToFinalMs: number | null; finalToDispatchMs: number | null; source: 'wake' | 'ptt' }

export interface RuntimeOptions {
  apiKey: string | null;
  abortSupported: boolean;
  socketFactory?: SocketFactory;
  baseUrl?: string;
  clock?: PacingClock;
  /** Monotonic seconds; the same clock stamps frames, hotkeys and wake detections. */
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * Executes the machine's actions in order. One consumer drains the event queue; Stt* events from a
 * stale session are dropped before `handle`. Only `handle` mutates the context, except the VAD mirrors.
 */
export class VoiceRuntime {
  readonly ctx: VoiceContext;
  private readonly machine: VoiceStateMachine;
  private readonly ring: RingBuffer;
  readonly forwarder: Forwarder;
  private session: SttSession | null = null;
  private readonly sessions = new Set<SttSession>();
  private readonly queue: VoiceEvent[] = [];
  private draining = false;
  private readonly timers = new Map<TimerName, unknown>();
  private executor: Promise<void> = Promise.resolve();
  private readonly now: () => number;
  private readonly setT: (fn: () => void, ms: number) => unknown;
  private readonly clearT: (handle: unknown) => void;
  private ui = { transcript: '', transcriptFinal: false, working: false, toast: null as VoiceSnapshot['toast'], levelDbfs: null as number | null };
  private toastId = 0;
  private zeroSince: number | null = null;
  private zeroReported = false;
  private wakeReady = false;
  private vadKind: VoiceSnapshot['vad'] = 'none';
  private utterance: { wakeTs: number | null; firstByteTs: number | null; speechEndTs: number | null; finalTs: number | null } = { wakeTs: null, firstByteTs: null, speechEndTs: null, finalTs: null };
  readonly latencies: UtteranceLatency[] = [];
  readonly inferenceMs: number[] = [];

  constructor(private readonly config: VoiceConfig, private readonly host: VoiceHost, private readonly options: RuntimeOptions) {
    this.machine = new VoiceStateMachine(config);
    this.ctx = createContext({ abortSupported: options.abortSupported });
    this.ring = new RingBuffer(ringFrames(config));
    this.forwarder = new Forwarder(this.ring, options.clock ?? realClock);
    this.forwarder.onFirstByte = () => { this.utterance.firstByteTs ??= this.now(); };
    this.now = options.now ?? (() => performance.now() / 1000);
    this.setT = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearT = options.clearTimer ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  /** Key presence check runs before the first handle and is exempt from "only handle mutates". */
  start(options: { muted?: boolean } = {}): void {
    if (!this.options.apiKey) {
      this.ctx.sttDisabled = true; this.ctx.sttDisabledMessage = KEY_MISSING;
      this.toast(KEY_MISSING, 'warn');
    } else void this.probe();
    if (options.muted) this.post({ type: 'Mute' });
    else this.host.openCapture();
    this.publish();
  }

  /** Startup probe: one Manual socket opened and closed, no audio. */
  private async probe(): Promise<void> {
    let result: { ok: boolean; code: number | string | null } = { ok: false, code: 'timeout' };
    const probe = new SttSession(0, 'manual', this.config, this.options.apiKey!, signal => {
      if (signal.type === 'SttConnected') result = { ok: true, code: null };
      if (signal.type === 'SttError') result = { ok: false, code: signal.code };
    }, { factory: this.options.socketFactory, baseUrl: this.options.baseUrl });
    await probe.open();
    probe.abort();
    this.post({ type: 'ProbeResult', ...result });
  }

  /** A toast from outside the machine (hotkey conflicts, setup problems). */
  notify(message: string, level: 'info' | 'warn' = 'info'): void { this.toast(message, level); this.publish(); }

  setInferenceStatus(status: { wake: boolean; vad: 'silero' | 'energy'; error: string | null }): void {
    this.wakeReady = status.wake; this.vadKind = status.vad;
    if (status.error) this.toast(status.error, 'warn');
    this.publish();
  }

  post(event: VoiceEvent): void {
    this.queue.push(event);
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length) {
        const next = this.queue.shift()!;
        if ('sessionId' in next && next.type.startsWith('Stt') && next.sessionId !== this.ctx.sessionId) {
          this.host.log('debug', { droppedStale: next.type, sessionId: next.sessionId });
          continue;
        }
        if (next.type === 'SttFinal') this.utterance.finalTs = this.now();
        const actions = this.machine.handle(next, this.ctx, this.now());
        // One failing action must never strand the rest of the batch (timers, gate) or the queue.
        for (const action of actions) {
          try { this.execute(action); } catch (error) { this.host.log('warn', { actionFailed: action.type, error: String(error) }); }
        }
      }
    } finally { this.draining = false; }
    this.publish();
  }

  /** Live capture frame (16 kHz int16 × 1280) stamped on arrival in main. */
  frame(pcm: Int16Array, ts = this.now() - FRAME_SECONDS): void {
    if (this.ctx.state === 'MUTED' || this.ctx.state === 'DISABLED') return;
    const frame: Frame = { pcm, ts };
    this.ring.append(frame);
    this.forwarder.push(frame);
    this.ui.levelDbfs = peakDbfs(pcm);
    // 2 s of exact zeros → device changed; still zero after 3 s cumulative → permission failure.
    if (isSilentZero(pcm)) {
      this.zeroSince ??= ts;
      const zeroFor = ts - this.zeroSince;
      if (zeroFor >= 2 && !this.zeroReported) { this.zeroReported = true; this.post({ type: 'DeviceChanged' }); this.host.closeCapture(); this.host.openCapture(); }
      else if (zeroFor >= 3) { this.zeroSince = null; this.zeroReported = false; this.post({ type: 'CaptureFailed', reason: 'silent input' }); }
    } else { this.zeroSince = null; this.zeroReported = false; }
    // The host may transfer (detach) what it receives; the ring buffer keeps its own copy for the pre-roll.
    this.host.inference.frame(pcm.slice(), ts);
  }

  /** Result from the inference thread: mirror VAD state first, then post its events. */
  inferenceResult(result: InferenceResult): void {
    this.ctx.vadActive = result.vadActive; this.ctx.vadRawActive = result.rawActive;
    this.inferenceMs.push(result.inferMs);
    if (this.inferenceMs.length >= 750) {
      const mean = this.inferenceMs.reduce((a, b) => a + b, 0) / this.inferenceMs.length;
      this.host.log('info', { inferenceMeanMs: Number(mean.toFixed(2)) }); this.inferenceMs.length = 0;
    }
    if (result.vadEvent) {
      if (result.vadEvent.type === 'VadSpeechEnd') this.utterance.speechEndTs = result.vadEvent.ts;
      this.post(result.vadEvent);
    }
    if (result.wake) this.post({ type: 'WakeDetected', phrase: result.wake.phrase, ts: result.wake.ts, score: null });
    else if (!result.vadEvent && this.ui.levelDbfs !== null) this.publishThrottled();
  }

  snapshot(): VoiceSnapshot {
    return {
      state: this.ctx.state, transcript: this.ui.transcript, transcriptFinal: this.ui.transcriptFinal, cloudOn: this.forwarder.gate,
      levelDbfs: this.ui.levelDbfs !== null && Number.isFinite(this.ui.levelDbfs) ? this.ui.levelDbfs : null, lastError: this.ctx.lastError,
      sttDisabled: this.ctx.sttDisabled, inFlight: this.ctx.inFlightCmd !== null, working: this.ui.working && this.ctx.inFlightCmd !== null,
      toast: this.ui.toast, wakePhrase: this.config.wake.phrase, hotkey: this.config.ptt.hotkey, muteHotkey: this.config.ptt.muteHotkey,
      wakeReady: this.wakeReady, vad: this.vadKind, keyPresent: Boolean(this.options.apiKey),
    };
  }

  shutdown(): void {
    this.post({ type: 'Shutdown' });
    for (const handle of this.timers.values()) this.clearT(handle);
    this.timers.clear();
    for (const session of this.sessions) session.abort();
    this.forwarder.detach();
  }

  private lastPublish = 0;
  private publishThrottled(): void { const now = this.now(); if (now - this.lastPublish > 0.1) this.publish(); }
  private publish(): void { this.lastPublish = this.now(); this.host.changed(this.snapshot()); }
  private toast(message: string, level: 'info' | 'warn'): void { this.ui.toast = { id: ++this.toastId, message, level }; }

  private execute(action: VoiceAction): void {
    switch (action.type) {
      case 'OpenStt': return this.openStt(action.kind, action.sessionId);
      case 'StartForwarding': return this.forwarder.start(action.fromTs);
      case 'StopForwarding': return this.forwarder.stop();
      case 'SendFinalize': return this.forwarder.control('finalize');
      case 'SendClose': return this.forwarder.control('close');
      case 'AbortStt': {
        this.session?.abort(); this.session = null;
        this.forwarder.detach();
        return;
      }
      case 'SetCloudGate': this.forwarder.gate = action.on; return;
      case 'SetWakeEnabled': return this.host.inference.setWakeEnabled(action.enabled);
      case 'ResetWake': return this.host.inference.resetWake();
      case 'PlayEarcon': {
        const playId = randomUUID();
        // Gate wake from the moment we ask for playback; the renderer reports the stop.
        this.queue.push({ type: 'PlaybackStarted', kind: 'earcon', text: null, playId });
        return this.host.playEarcon(action.name, playId);
      }
      case 'StopPlayback': return this.host.stopPlayback();
      case 'ShowState':
        if (action.state === 'WAKING') this.utterance = { wakeTs: this.ctx.detectionTs, firstByteTs: null, speechEndTs: null, finalTs: null };
        if (action.state === 'PTT_ACTIVE') this.utterance = { wakeTs: this.now(), firstByteTs: null, speechEndTs: null, finalTs: null };
        if (action.state === 'PASSIVE' || action.state === 'PTT_ACTIVE' || action.state === 'WAKING') { this.ui.working = false; if (action.state !== 'PASSIVE') { this.ui.transcript = ''; this.ui.transcriptFinal = false; } }
        if (action.state === 'EXECUTING') this.ui.working = false;
        return;
      case 'ShowWorking': this.ui.working = true; return;
      case 'ShowTranscript': this.ui.transcript = action.text; this.ui.transcriptFinal = action.final; return;
      case 'Toast': return this.toast(action.message, action.level);
      case 'Dispatch': return this.dispatch(action.command);
      case 'AbortCommand': this.host.abortCommand?.(action.cmdId, action.spokenText); this.queue.push({ type: 'CommandFailed', cmdId: action.cmdId, message: 'aborted' }); return;
      case 'SetTimer': {
        const previous = this.timers.get(action.name);
        if (previous !== undefined) this.clearT(previous);
        this.timers.set(action.name, this.setT(() => { this.timers.delete(action.name); this.post({ type: 'TimerFired', name: action.name, stamp: action.stamp, seq: action.seq }); }, action.seconds * 1000));
        return;
      }
      case 'CancelTimer': {
        const handle = this.timers.get(action.name);
        if (handle !== undefined) { this.clearT(handle); this.timers.delete(action.name); }
        return;
      }
      case 'OpenCapture': return this.host.openCapture();
      case 'CloseCapture': this.ring.clear(); this.host.inference.reset(); this.ui.levelDbfs = null; return this.host.closeCapture();
      case 'PadZeros': return this.forwarder.padZeros(action.seconds, () => { this.forwarder.gate = false; this.forwarder.stop(); this.forwarder.control('close'); });
      case 'Log': return this.host.log(action.level, action.fields);
    }
  }

  private openStt(kind: 'auto' | 'manual', sessionId: number): void {
    this.session?.abort();
    if (!this.options.apiKey) return;
    const session = new SttSession(sessionId, kind, this.config, this.options.apiKey, signal => this.signal(sessionId, signal), { factory: this.options.socketFactory, baseUrl: this.options.baseUrl });
    this.session = session; this.sessions.add(session);
    this.forwarder.attach(session);
    void session.open().catch(error => this.host.log('warn', { openFailed: String(error) })).finally(() => this.sessions.delete(session));
  }
  private signal(sessionId: number, signal: SessionSignal): void {
    if (signal.type === 'Log') return this.host.log('debug', { sessionId, ...signal.fields });
    if (signal.type === 'SttConnected') this.host.log('info', { sessionId, connected: true });
    this.post({ ...signal, sessionId } as VoiceEvent);
  }

  /** Single-worker executor: commands never run concurrently; a second Dispatch queues behind the first. */
  private dispatch(command: CommandEvent): void {
    const u = this.utterance;
    const latency: UtteranceLatency = {
      source: command.source,
      wakeToFirstByteMs: u.wakeTs !== null && u.firstByteTs !== null ? Math.round((u.firstByteTs - u.wakeTs) * 1000) : null,
      speechEndToFinalMs: u.speechEndTs !== null && u.finalTs !== null ? Math.round((u.finalTs - u.speechEndTs) * 1000) : null,
      finalToDispatchMs: u.finalTs !== null ? Math.round((this.now() - u.finalTs) * 1000) : null,
    };
    this.latencies.push(latency);
    this.host.log('info', { utterance: latency, confidence: command.confidence });
    this.executor = this.executor.then(async () => {
      try { this.post({ type: 'CommandDone', cmdId: command.cmdId, resultText: await this.host.executeCommand(command) }); }
      catch (error) { this.post({ type: 'CommandFailed', cmdId: command.cmdId, message: error instanceof Error ? error.message : String(error) }); }
    });
  }
}

/** Median / max over a session (`voice debug latency`). */
export function latencySummary(values: (number | null)[]): { median: number | null; max: number | null; n: number } {
  const sorted = values.filter((value): value is number => value !== null).sort((a, b) => a - b);
  if (!sorted.length) return { median: null, max: null, n: 0 };
  return { median: sorted[Math.floor((sorted.length - 1) / 2)]!, max: sorted.at(-1)!, n: sorted.length };
}
