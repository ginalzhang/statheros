import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { energyAbove, LocalVad, type VadEvent } from './vad';

/**
 * Wake word + local VAD (prompt §6). All local, no network. sherpa-onnx open-vocabulary keyword
 * spotting and Silero VAD (512-sample windows inside sherpa), with an energy fallback.
 */
export interface InferenceInit {
  /** Directory containing node_modules/sherpa-onnx-node (packaged app), or null to resolve normally. */
  addonRoot: string | null;
  modelDir: string;
  keywordsFile: string;
  wakePhrase: string;
  vadThreshold: number;
  hangoverMs: number;
}
export interface InferenceResult {
  ts: number; vadActive: boolean; rawActive: boolean; vadEvent: VadEvent | null;
  wake: { phrase: string; ts: number } | null;
  /** A Steady command spotted locally (no wake phrase needed), as its vocabulary phrase. */
  command: { text: string; ts: number } | null;
  inferMs: number;
}

/** Keyword display labels (resources/voice/keywords_raw.txt) → wake, local stop, or a command phrase. */
export function keywordMeaning(label: string): { kind: 'wake' } | { kind: 'stop' } | { kind: 'command'; text: string } {
  const upper = label.toUpperCase();
  if (upper === 'STOP') return { kind: 'stop' };
  if (upper === 'HEY_CARTESIA') return { kind: 'wake' };
  return { kind: 'command', text: upper.toLowerCase().replace(/_/g, ' ') };
}

interface Stream { acceptWaveform(input: { sampleRate: number; samples: Float32Array }): void }
interface Spotter { createStream(): Stream; isReady(stream: Stream): boolean; decode(stream: Stream): void; reset(stream: Stream): void; getResult(stream: Stream): { keyword: string } }
interface SileroVad { acceptWaveform(samples: Float32Array): void; isDetected(): boolean; isEmpty(): boolean; pop(): void; reset(): void }
interface Sherpa { KeywordSpotter: new (config: unknown) => Spotter; Vad: new (config: unknown, bufferSeconds: number) => SileroVad }

export function loadSherpa(addonRoot: string | null): Sherpa {
  const base = addonRoot ? path.join(addonRoot, 'index.js') : path.join(process.cwd(), 'index.js');
  return createRequire(base)(addonRoot ? path.join(addonRoot, 'node_modules', 'sherpa-onnx-node') : 'sherpa-onnx-node') as Sherpa;
}

export class Inference {
  private readonly vad: LocalVad;
  private spotter: Spotter | null = null;
  private stream: Stream | null = null;
  private silero: SileroVad | null = null;
  private wakeEnabled = true;
  readonly error: string | null;

  constructor(private readonly init: InferenceInit, sherpa?: Sherpa) {
    this.vad = new LocalVad(init.hangoverMs);
    let error: string | null = null;
    try {
      const lib = sherpa ?? loadSherpa(init.addonRoot);
      const kws = path.join(init.modelDir, 'kws');
      if (!existsSync(init.keywordsFile)) throw new Error(`missing keywords file ${init.keywordsFile}`);
      this.spotter = new lib.KeywordSpotter({
        featConfig: { sampleRate: 16000, featureDim: 80 },
        modelConfig: { transducer: { encoder: path.join(kws, 'encoder.int8.onnx'), decoder: path.join(kws, 'decoder.int8.onnx'), joiner: path.join(kws, 'joiner.int8.onnx') }, tokens: path.join(kws, 'tokens.txt'), numThreads: 1, provider: 'cpu', debug: 0 },
        keywordsScore: 1.0, keywordsThreshold: 0.25, numTrailingBlanks: 1, keywordsFile: init.keywordsFile,
      });
      this.stream = this.spotter.createStream();
      try {
        this.silero = new lib.Vad({ sileroVad: { model: path.join(init.modelDir, 'silero_vad.onnx'), threshold: init.vadThreshold, minSilenceDuration: 0.1, minSpeechDuration: 0.05, windowSize: 512, maxSpeechDuration: 30 }, sampleRate: 16000, numThreads: 1, provider: 'cpu', debug: 0 }, 60); // ≥ maxSpeechDuration: no regrowth copies
      } catch (cause) { error = `Silero VAD unavailable; using energy VAD (${String(cause)})`; }
    } catch (cause) { error = `Local command recognition unavailable; push-to-talk still works (${String(cause)})`; }
    this.error = error;
  }
  get wakeReady(): boolean { return this.spotter !== null; }
  get vadKind(): 'silero' | 'energy' { return this.silero ? 'silero' : 'energy'; }
  setWakeEnabled(enabled: boolean): void { this.wakeEnabled = enabled; }
  resetWake(): void { if (this.spotter) this.stream = this.spotter.createStream(); }
  reset(): void { this.vad.reset(); this.silero?.reset(); this.resetWake(); }

  /** `ts` = frame start in seconds (monotonic, same clock as hotkeys). */
  frame(pcm: Int16Array, ts: number): InferenceResult {
    const started = performance.now();
    const samples = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) samples[i] = pcm[i]! / 32768;
    let above: boolean;
    if (this.silero) {
      this.silero.acceptWaveform(samples);
      above = this.silero.isDetected();
      while (!this.silero.isEmpty()) this.silero.pop();
    } else above = energyAbove(pcm);
    const vadEvent = this.vad.process(above, ts);
    let wake: InferenceResult['wake'] = null, command: InferenceResult['command'] = null;
    if (this.spotter && this.stream) {
      // Keep feeding while gated or refractory: pausing would re-trigger on buffered audio.
      this.stream.acceptWaveform({ sampleRate: 16000, samples });
      while (this.spotter.isReady(this.stream)) {
        this.spotter.decode(this.stream);
        const keyword = this.spotter.getResult(this.stream).keyword;
        if (!keyword) continue;
        this.spotter.reset(this.stream);
        if (!this.wakeEnabled) continue;
        const meaning = keywordMeaning(keyword), at = ts + pcm.length / 16000;
        if (meaning.kind === 'command') command = { text: meaning.text, ts: at };
        else wake = { phrase: meaning.kind === 'stop' ? 'stop' : this.init.wakePhrase, ts: at };
      }
    }
    return { ts, vadActive: this.vad.isActive, rawActive: this.vad.rawActive, vadEvent, wake, command, inferMs: performance.now() - started };
  }
}
