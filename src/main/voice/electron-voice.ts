import { globalShortcut, safeStorage, systemPreferences, type BrowserWindow } from 'electron';
import { Worker } from 'node:worker_threads';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';
import { defaultVoiceConfig, type VoiceConfig } from './config';
import { KeyStore } from './key-store';
import { PidLock } from './lock';
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
  private readonly lock: PidLock;
  private snapshotValue: VoiceSnapshot | null = null;
  private lastMute = -Infinity;
  private selfTestTap: ((pcm: Int16Array) => void) | null = null;
  private refusal: string | null = null;
  private readonly logFile: string;

  constructor(private readonly options: ElectronVoiceOptions) {
    this.config = options.config ?? defaultVoiceConfig();
    this.keys = new KeyStore(path.join(options.userData, 'cartesia-key.bin'), safeStorage);
    this.lock = new PidLock(path.join(options.userData, 'voice.lock'));
    this.logFile = path.join(options.userData, 'voice.log');
  }

  start(): void {
    if (!this.config.enabled) return;
    if (!this.lock.acquire()) return this.toast('Voice already running in another instance');
    this.startRuntime();
    this.registerHotkeys();
  }

  /** Steady launches microphone-off (plan §2): wake listening starts when the user turns the mic on. */
  private startRuntime(muted = true): void {
    const apiKey = this.keys.get();
    const runtime = this.runtime = new VoiceRuntime(this.config, this.host(), { apiKey, abortSupported: false });
    this.startWorker(runtime);
    runtime.start({ muted });
  }

  private host(): VoiceHost {
    return {
      executeCommand: command => this.options.execute(command),
      openCapture: () => { void this.openCapture(); },
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
      runtime.setInferenceStatus({ wake: false, vad: 'energy', error: `Wake word unavailable; push-to-talk still works (${String(error)})` });
      return;
    }
    this.worker.on('message', (message: InferenceReply) => {
      if (message.type === 'ready') return runtime.setInferenceStatus(message);
      this.outstanding = Math.max(0, this.outstanding - 1);
      runtime.inferenceResult(message);
    });
    this.worker.on('error', error => { this.log('warn', { workerError: String(error) }); runtime.setInferenceStatus({ wake: false, vad: 'energy', error: 'Wake word crashed; push-to-talk still works' }); this.worker = null; });
  }

  private registerHotkeys(): void {
    const register = (accelerator: string, callback: () => void): void => {
      let ok = false;
      try { ok = globalShortcut.register(accelerator, callback); } catch { ok = false; }
      if (!ok) this.toast(`${accelerator}: shortcut taken by another app`);
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
    if (process.platform === 'darwin') {
      let status = systemPreferences.getMediaAccessStatus('microphone');
      if (status === 'not-determined') status = (await systemPreferences.askForMediaAccess('microphone')) ? 'granted' : 'denied';
      if (status === 'denied' || status === 'restricted') { this.runtime?.post({ type: 'CaptureFailed', reason: status }); return; }
    }
    // The user may have muted while the permission prompt was up.
    if (this.runtime?.ctx.state === 'MUTED' && this.runtime.ctx.mutedReason === 'user') return;
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
      case 'opened': this.options.microphoneChanged(true); runtime.post({ type: 'CaptureOpened' }); return;
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
  /** `voice selftest`: 1 s of real capture through the tap; expect 16000 ± 1 % samples/s. */
  async selfTest(): Promise<VoiceSelfTest> {
    if (!this.runtime || this.runtime.ctx.state === 'MUTED') return { ok: false, samplesPerSecond: 0, peakDbfs: null, message: 'Turn the microphone on first.' };
    let samples = 0, peak = -Infinity;
    const started = performance.now();
    this.selfTestTap = pcm => { samples += pcm.length; peak = Math.max(peak, peakDbfs(pcm)); };
    await new Promise(resolve => setTimeout(resolve, 2000));
    this.selfTestTap = null;
    const rate = samples / ((performance.now() - started) / 1000);
    const ok = Math.abs(rate - 16000) <= 160 * 2.5; // IPC batching jitter over a 2 s window
    const quiet = peak < -45;
    const message = `${Math.round(rate)} samples/s${ok ? '' : ' (expected 16000)'}; peak ${Number.isFinite(peak) ? peak.toFixed(1) : '−∞'} dBFS${quiet ? ' — very quiet input will hurt wake recall' : ''}`;
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
    globalShortcut.unregister(this.config.ptt.hotkey); globalShortcut.unregister(this.config.ptt.muteHotkey);
    this.runtime?.shutdown(); this.runtime = null;
    const worker = this.worker; this.worker = null;
    this.lock.release();
    if (worker) await this.terminate(worker);
  }
  /**
   * sherpa-onnx aborts the whole process if its thread is killed inside a native call, so the worker
   * drains its queue and exits on its own; terminate() is only a fallback after 3 s.
   */
  private async terminate(worker: Worker): Promise<void> {
    const exited = new Promise<void>(resolve => worker.once('exit', () => resolve()));
    worker.postMessage({ type: 'exit' } satisfies InferenceRequest);
    const timeout = (ms: number) => new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), ms));
    if (await Promise.race([exited, timeout(3000)]) === 'timeout') await Promise.race([worker.terminate(), timeout(1500)]);
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
    try {
      mkdirSync(path.dirname(this.logFile), { recursive: true });
      if (existsSync(this.logFile) && statSync(this.logFile).size > 1_000_000) renameSync(this.logFile, `${this.logFile}.1`);
      appendFileSync(this.logFile, `${JSON.stringify({ t: new Date().toISOString(), level, ...fields })}\n`);
    } catch { /* logging never breaks voice */ }
  }
}

function toInt16(data: unknown): Int16Array | null {
  if (data instanceof ArrayBuffer) return new Int16Array(data.slice(0));
  if (ArrayBuffer.isView(data) && data.byteLength % 2 === 0) return new Int16Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
  return null;
}
