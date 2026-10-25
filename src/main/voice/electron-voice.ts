import { globalShortcut, safeStorage, systemPreferences, type BrowserWindow } from 'electron';
import { Worker } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { defaultVoiceConfig, type VoiceConfig } from './config';
import { KeyStore } from './key-store';
import { BufferedLog } from '../buffered-log';
import { latencySummary, VoiceRuntime, type VoiceHost } from './runtime';
import { FRAME_SAMPLES, peakDbfs } from './audio';
import type { InferenceReply, InferenceRequest } from './inference-worker';
import type { CommandEvent } from './types';
import { initialVoiceSnapshot, type VoiceCaptureCommand, type VoiceCaptureReport, type VoiceLatencyReport, type VoiceSelfTest, type VoiceSnapshot } from '../../shared/voice';

export interface ElectronVoiceOptions {
  /** Bundled main-process output directory (contains voice-worker.cjs). */
  buildDir: string;
  /** resources/voice (models, keywords, packaged addon). */
  voiceRoot: string;
  packaged: boolean;
  userData: string;
  panel: () => BrowserWindow | null;
  windows: () => (BrowserWindow | null)[];
  execute: (command: CommandEvent) => Promise<string | null>;
  microphoneChanged: (open: boolean) => void;
  config?: VoiceConfig;
}

/** Electron adapter: renderer = capture + earcons; main = everything else (prompt §2). */
export class ElectronVoice {
  readonly config: VoiceConfig;
  private runtime: VoiceRuntime | null = null;
  private worker: Worker | null = null;
  private outstanding = 0;
  private readonly keys: KeyStore;
  private started = false;
  private readonly hotkeys = new Set<string>();
  private snapshotValue: VoiceSnapshot | null = null;
  private lastMute = -Infinity;
  private selfTestTap: ((pcm: Int16Array) => void) | null = null;
  private refusal: string | null = null;
  private readonly logger: BufferedLog;
  private selfTestPending: Promise<VoiceSelfTest> | null = null;

  constructor(private readonly options: ElectronVoiceOptions) {
    this.config = options.config ?? defaultVoiceConfig();
    this.keys = new KeyStore(path.join(options.userData, 'cartesia-key.bin'), safeStorage);
    this.logger = new BufferedLog(path.join(options.userData, 'voice.log'));
  }

  start(): void {
    if (!this.config.enabled || this.started) return;
    this.started = true;
    this.startRuntime();
    this.registerHotkeys();
  }

  /** Steady launches microphone-off (plan §2): local command listening starts when the user turns the mic on. */
  private startRuntime(muted = true): void {
    const apiKey = this.keys.get();
    const runtime = this.runtime = new VoiceRuntime(this.config, this.host(), { apiKey, abortSupported: false });
    runtime.start({ muted });
  }

  private host(): VoiceHost {
    return {
      executeCommand: command => this.options.execute(command),
      openCapture: () => { if (this.runtime && !this.worker) this.startWorker(this.runtime); void this.openCapture(); },
      closeCapture: () => { this.toPanel({ type: 'close' }); this.options.microphoneChanged(false); },
      playEarcon: (name, playId) => this.toPanel({ type: 'earcon', name, playId }),
      stopPlayback: () => this.toPanel({ type: 'stopPlayback' }),
      inference: {
        frame: (pcm, ts) => {
          if (!this.worker) return;
          if (this.outstanding >= this.config.audio.frameQueueMax) { this.log('warn', { inferenceBehindFrames: this.outstanding }); return; }
          this.outstanding++;
          this.worker.postMessage({ type: 'frame', pcm, ts } satisfies InferenceRequest, [pcm.buffer as ArrayBuffer]);
        },
        setWakeEnabled: enabled => this.worker?.postMessage({ type: 'setWakeEnabled', enabled } satisfies InferenceRequest),
        resetWake: () => this.worker?.postMessage({ type: 'resetWake' } satisfies InferenceRequest),
        reset: () => this.worker?.postMessage({ type: 'reset' } satisfies InferenceRequest),
      },
      changed: snapshot => { this.snapshotValue = snapshot; this.broadcast(); },
      log: (level, fields) => this.log(level, fields),
    };
  }

  private startWorker(runtime: VoiceRuntime): void {
    const script = path.join(this.options.buildDir, 'voice-worker.cjs');
    const addonRoot = this.options.packaged ? path.join(this.options.voiceRoot, 'addon') : null;
    try {
      // Eval mode reads the bundled script through Electron's asar-aware fs.
      this.worker = new Worker(readFileSync(script, 'utf8'), { eval: true, workerData: {
        addonRoot, modelDir: path.join(this.options.voiceRoot, 'models'), keywordsFile: path.join(this.options.voiceRoot, this.config.wake.keywordsFile),
        wakePhrase: this.config.wake.phrase, vadThreshold: this.config.vad.threshold, hangoverMs: this.config.vad.hangoverMs,
      } });
    } catch (error) {
      runtime.setInferenceStatus({ wake: false, vad: 'energy', error: `Local command recognition unavailable; push-to-talk still works (${String(error)})` });
      return;
    }
    const worker = this.worker;
    worker.on('message', (message: InferenceReply) => {
      if (this.worker !== worker || this.runtime !== runtime) return;
      if (message.type === 'ready') return runtime.setInferenceStatus(message);
      this.outstanding = Math.max(0, this.outstanding - 1);
      runtime.inferenceResult(message);
    });
    worker.on('error', error => {
      if (this.worker !== worker || this.runtime !== runtime) return;
      this.log('warn', { workerError: String(error) });
      runtime.setInferenceStatus({ wake: false, vad: 'energy', error: 'Local command recognition crashed; push-to-talk still works' });
      this.worker = null; this.outstanding = 0;
    });
  }

  private registerHotkeys(): void {
    const register = (accelerator: string, callback: () => void): void => {
      let ok = false;
      try { ok = globalShortcut.register(accelerator, callback); } catch { ok = false; }
      if (ok) this.hotkeys.add(accelerator);
      else this.toast(`${accelerator}: shortcut taken by another app`);
    };
    // globalShortcut is key-down only: toggle, no hold-to-talk (prompt §2).
    register(this.config.ptt.hotkey, () => this.runtime?.post({ type: 'HotkeyToggle' }));
    register(this.config.ptt.muteHotkey, () => {
      const now = performance.now();
      if (now - this.lastMute < this.config.ptt.muteHotkeyDebounceMs) return;
      this.lastMute = now; this.runtime?.post({ type: 'MuteHotkey' });
    });
  }
  private toast(message: string): void {
    this.log('warn', { toast: message });
    if (this.runtime) this.runtime.notify(message, 'warn');
    else { this.refusal = message; this.broadcast(); }
  }

  private async openCapture(): Promise<void> {
    const runtime = this.runtime;
    if (!runtime) return;
    if (process.platform === 'darwin') {
      let status = systemPreferences.getMediaAccessStatus('microphone');
      const initial = status;
      if (status === 'not-determined') status = (await systemPreferences.askForMediaAccess('microphone')) ? 'granted' : 'denied';
      this.log('info', { micAccess: status, ...(initial !== status ? { micAccessBefore: initial } : {}) });
      if (this.runtime !== runtime) return;
      if (status === 'denied' || status === 'restricted') { runtime.post({ type: 'CaptureFailed', reason: status }); return; }
    }
    // The user may have muted while the permission prompt was up.
    if (this.runtime !== runtime || runtime.ctx.state === 'DISABLED' || (runtime.ctx.state === 'MUTED' && runtime.ctx.mutedReason === 'user')) return;
    this.toPanel({ type: 'open' });
  }

  // ───────────── IPC entry points (validated by the caller) ─────────────
  frame(data: unknown): void {
    const pcm = toInt16(data);
    if (!pcm || pcm.length !== FRAME_SAMPLES || !this.runtime) return;
    this.selfTestTap?.(pcm);
    this.runtime.frame(pcm);
  }
  report(report: VoiceCaptureReport): void {
    const runtime = this.runtime;
    if (!runtime) return;
    switch (report.type) {
      case 'opened':
        if (runtime.ctx.state === 'DISABLED' || (runtime.ctx.state === 'MUTED' && runtime.ctx.mutedReason === 'user')) { this.toPanel({ type: 'close' }); return; }
        this.options.microphoneChanged(true); runtime.post({ type: 'CaptureOpened' }); return;
      case 'failed': runtime.post({ type: 'CaptureFailed', reason: report.reason }); return;
      case 'deviceChanged': runtime.post({ type: 'DeviceChanged' }); return;
      case 'earconStarted': return; // gating starts when PlayEarcon is issued
      case 'earconStopped': runtime.post({ type: 'PlaybackStopped', playId: report.playId }); return;
    }
  }
  button(kind: 'press' | 'longpress'): void {
    const runtime = this.runtime;
    if (!runtime) return;
    if (kind === 'press' && runtime.ctx.state === 'MUTED') return runtime.post({ type: 'Unmute' });
    runtime.post({ type: kind === 'press' ? 'ButtonPressed' : 'ButtonLongPress' });
  }
  cancel(): void { this.runtime?.post({ type: 'Cancel', reason: 'click' }); }
  appFocused(): void { this.runtime?.post({ type: 'AppFocused' }); }
  setMicrophone(enabled: boolean): void { this.runtime?.post({ type: enabled ? 'Unmute' : 'Mute' }); }
  setKey(key: string | null): void {
    if (this.keys.source === 'env') throw new Error('CARTESIA_API_KEY is set in the environment; it takes precedence.');
    if (key === null) this.keys.clear(); else this.keys.set(key);
    if (!this.started || !this.config.enabled) return;
    // Restart the pipeline with the new key (the probe reports a bad key at once).
    const wasOn = this.runtime !== null && this.runtime.ctx.state !== 'MUTED';
    this.runtime?.shutdown();
    const old = this.worker; this.worker = null; this.outstanding = 0;
    if (old) void this.terminate(old);
    this.startRuntime(!wasOn);
  }
  snapshot(): VoiceSnapshot | null {
    const value = this.snapshotValue;
    if (!value) return this.refusal ? { ...initialVoiceSnapshot(), lastError: this.refusal, toast: { id: 1, message: this.refusal, level: 'warn' } } : null;
    return value;
  }
  /** `voice selftest`: 2 s of real capture through the tap; allow 2.5% IPC batching jitter. */
  selfTest(): Promise<VoiceSelfTest> {
    if (this.selfTestPending) return this.selfTestPending;
    const pending = this.runSelfTest().finally(() => { if (this.selfTestPending === pending) this.selfTestPending = null; });
    this.selfTestPending = pending; return pending;
  }
  private async runSelfTest(): Promise<VoiceSelfTest> {
    if (!this.runtime?.snapshot().captureOpen) return { ok: false, samplesPerSecond: 0, peakDbfs: null, message: 'Turn the microphone on first.' };
    const runtime = this.runtime;
    let samples = 0, peak = -Infinity;
    const started = performance.now();
    this.selfTestTap = pcm => { samples += pcm.length; peak = Math.max(peak, peakDbfs(pcm)); };
    await new Promise(resolve => setTimeout(resolve, 2000));
    this.selfTestTap = null;
    if (this.runtime !== runtime || !runtime.snapshot().captureOpen) return { ok: false, samplesPerSecond: 0, peakDbfs: null, message: 'Microphone capture changed during the test. Try again.' };
    const rate = samples / ((performance.now() - started) / 1000);
    const ok = Math.abs(rate - 16000) <= 160 * 2.5; // IPC batching jitter over a 2 s window
    const quiet = peak < -45;
    const message = `${Math.round(rate)} samples/s${ok ? '' : ' (expected 16000)'}; peak ${Number.isFinite(peak) ? peak.toFixed(1) : '−∞'} dBFS${quiet ? ' — very quiet input will hurt command recognition' : ''}`;
    this.log('info', { selftest: message });
    return { ok: ok && !quiet, samplesPerSecond: Math.round(rate), peakDbfs: Number.isFinite(peak) ? peak : null, message };
  }
  /** `voice debug latency`. */
  latency(): VoiceLatencyReport {
    const list = this.runtime?.latencies ?? [];
    const pick = (key: 'wakeToFirstByteMs' | 'speechEndToFinalMs' | 'finalToDispatchMs') => { const { median, max } = latencySummary(list.map(item => item[key])); return { median, max }; };
    const inference = this.runtime?.inferenceMs ?? [];
    return { utterances: list.length, wakeToFirstByte: pick('wakeToFirstByteMs'), speechEndToFinal: pick('speechEndToFinalMs'), finalToDispatch: pick('finalToDispatchMs'), inferenceMeanMs: inference.length ? Number((inference.reduce((a, b) => a + b, 0) / inference.length).toFixed(2)) : null };
  }
  get keySource(): 'env' | 'settings' | null { return this.keys.source; }
  /** Resolves once the inference thread has exited: the native addon must not be torn down mid-process-exit. */
  async stop(): Promise<void> {
    this.started = false;
    for (const key of this.hotkeys) globalShortcut.unregister(key);
    this.hotkeys.clear();
    this.runtime?.shutdown(); this.runtime = null;
    const worker = this.worker; this.worker = null;
    if (worker) await this.terminate(worker);
    await this.logger.flush();
  }
  /**
   * sherpa-onnx aborts the whole process if its thread is killed inside a native call, so the worker
   * drains its queue and exits on its own; terminate() is only a fallback after 3 s.
   */
  private async terminate(worker: Worker): Promise<void> {
    const exited = new Promise<void>(resolve => worker.once('exit', () => resolve()));
    worker.postMessage({ type: 'exit' } satisfies InferenceRequest);
    const wait = async (completion: Promise<unknown>, ms: number): Promise<unknown> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { return await Promise.race([completion, new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), ms); })]); }
      finally { clearTimeout(timer); }
    };
    if (await wait(exited, 3000) === 'timeout') await wait(worker.terminate(), 1500);
  }

  private toPanel(command: VoiceCaptureCommand): void {
    const panel = this.options.panel();
    if (panel && !panel.isDestroyed()) panel.webContents.send('steady:voice-capture', command);
  }
  private broadcast(): void {
    const snapshot = this.snapshot();
    for (const win of this.options.windows()) if (win && !win.isDestroyed()) win.webContents.send('steady:voice-changed', snapshot, this.keys.source);
  }
  private log(level: 'debug' | 'info' | 'warn', fields: Record<string, unknown>): void {
    if (level === 'debug' && !process.env.STEADY_VOICE_DEBUG) return;
    this.logger.write(`${JSON.stringify({ t: new Date().toISOString(), level, ...fields })}\n`);
  }
}

function toInt16(data: unknown): Int16Array | null {
  // Reject malformed IPC before allocating; an odd ArrayBuffer used to throw here.
  if (data instanceof ArrayBuffer && data.byteLength === FRAME_SAMPLES * 2) return new Int16Array(data.slice(0));
  if (ArrayBuffer.isView(data) && data.byteLength === FRAME_SAMPLES * 2) return new Int16Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
  return null;
}
