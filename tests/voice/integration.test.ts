import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import { defaultVoiceConfig, type VoiceConfig } from '../../src/main/voice/config';
import { Inference } from '../../src/main/voice/inference';
import { VoiceRuntime, type VoiceHost } from '../../src/main/voice/runtime';
import { FRAME_SAMPLES } from '../../src/main/voice/audio';
import type { CommandEvent } from '../../src/main/voice/types';

/**
 * WAV fixtures through the real VAD + wake pipeline (sherpa-onnx) faster than real time, with
 * Cartesia replaced by a local WebSocket server that replays scripted messages.
 */
const models = path.resolve('resources/voice/models');
const ready = existsSync(path.join(models, 'kws', 'encoder.int8.onnx'));

class VirtualClock {
  t = 0;
  private seq = 0;
  private readonly timers = new Map<number, { at: number; fn: () => void; every?: number }>();
  now = (): number => this.t;
  setTimer = (fn: () => void, ms: number): number => { const id = ++this.seq; this.timers.set(id, { at: this.t + ms / 1000, fn }); return id; };
  clearTimer = (id: unknown): void => { this.timers.delete(id as number); };
  every = (ms: number, fn: () => void): (() => void) => { const id = ++this.seq; this.timers.set(id, { at: this.t + ms / 1000, fn, every: ms / 1000 }); return () => this.timers.delete(id); };
  /** Advance virtual time, firing due timers, yielding to real socket I/O between steps. */
  async step(seconds: number): Promise<void> {
    const end = this.t + seconds;
    for (;;) {
      const due = [...this.timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      const [id, timer] = due;
      this.t = Math.max(this.t, timer.at);
      if (timer.every) timer.at += timer.every; else this.timers.delete(id);
      timer.fn();
    }
    this.t = end;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}

interface Script { finalAfterAudioS: number; transcript: string; reject?: number }
interface ServerLog { connections: number; audioBytes: number; texts: string[] }

async function fakeCartesia(script: Script): Promise<{ url: string; log: ServerLog; close: () => Promise<void> }> {
  const log: ServerLog = { connections: 0, audioBytes: 0, texts: [] };
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, verifyClient: (_info, done) => script.reject ? done(false, script.reject, 'Unauthorized') : done(true) });
  server.on('connection', (socket: ServerSocket, request) => {
    log.connections++;
    const manual = !request.url?.includes('/turns/');
    let bytes = 0, finalSent = false, started = false;
    if (!manual) socket.send(JSON.stringify({ type: 'connected', request_id: 'r1' }));
    socket.on('message', (data, binary) => {
      if (!binary) {
        const text = data.toString(); log.texts.push(text);
        if (manual && (text === 'finalize' || text === 'close')) {
          if (!finalSent) { socket.send(JSON.stringify({ type: 'transcript', is_final: true, text: script.transcript })); finalSent = true; }
          socket.send(JSON.stringify({ type: text === 'close' ? 'done' : 'flush_done' }));
        }
        if (text === 'close' || text.includes('"close"')) socket.close();
        return;
      }
      bytes += (data as Buffer).length; log.audioBytes += (data as Buffer).length;
      if (manual) return;
      const seconds = bytes / 32000;
      if (!started && seconds > 0.4) { started = true; socket.send(JSON.stringify({ type: 'turn.start' })); }
      if (!finalSent && seconds >= script.finalAfterAudioS) { finalSent = true; socket.send(JSON.stringify({ type: 'turn.end', transcript: script.transcript })); }
    });
  });
  // events.once rejects on server errors instead of leaving setup pending until the test timeout.
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return { url: `ws://127.0.0.1:${port}`, log, close: () => new Promise(resolve => { for (const client of server.clients) client.terminate(); server.close(() => resolve()); }) };
}

function readWav(name: string): Int16Array {
  const bytes = readFileSync(path.join('tests/fixtures/voice', name));
  return new Int16Array(bytes.buffer.slice(bytes.byteOffset + 44));
}

async function run(name: string, script: Script, tailS = 12, configure?: (config: VoiceConfig) => void) {
  const config = defaultVoiceConfig();
  configure?.(config);
  const server = await fakeCartesia(script);
  const clock = new VirtualClock();
  const inference = new Inference({ addonRoot: null, modelDir: models, keywordsFile: path.resolve('resources/voice/keywords.txt'), wakePhrase: config.wake.phrase, vadThreshold: config.vad.threshold, hangoverMs: config.vad.hangoverMs });
  const commands: CommandEvent[] = [], states: string[] = [], toasts: string[] = [];
  let runtime!: VoiceRuntime;
  let binarySendsOutsideStreaming = 0;
  const host: VoiceHost = {
    executeCommand: async command => { commands.push(command); return 'ok'; },
    openCapture: () => undefined, closeCapture: () => undefined,
    playEarcon: (_name, playId) => clock.setTimer(() => runtime.post({ type: 'PlaybackStopped', playId }), 120),
    stopPlayback: () => undefined,
    // Transfer like ElectronVoice's postMessage: this detaches the argument.
    inference: { frame: (pcm, ts) => { const moved = structuredClone(pcm, { transfer: [pcm.buffer as ArrayBuffer] }); runtime.inferenceResult(inference.frame(moved, ts)); }, setWakeEnabled: enabled => inference.setWakeEnabled(enabled), resetWake: () => inference.resetWake(), reset: () => inference.reset() },
    changed: snapshot => { if (process.env.VOICE_DEBUG && states.at(-1) !== snapshot.state) console.log(clock.t.toFixed(2), 'STATE', snapshot.state, snapshot.transcript); if (states.at(-1) !== snapshot.state) states.push(snapshot.state); if (snapshot.toast && toasts.at(-1) !== snapshot.toast.message) toasts.push(snapshot.toast.message); },
    log: (level, fields) => { if (process.env.VOICE_DEBUG) console.log(clock.t.toFixed(2), level, JSON.stringify(fields)); },
  };
  runtime = new VoiceRuntime(config, host, { apiKey: 'sk_car_test_key_0000', abortSupported: false, baseUrl: server.url, clock, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  runtime.forwarder.onWrite = () => { if (!['LISTENING', 'PTT_ACTIVE'].includes(runtime.ctx.state)) binarySendsOutsideStreaming++; };
  runtime.start();
  // Let the startup probe settle.
  for (let i = 0; i < 20; i++) await clock.step(0.01);
  const pcm = readWav(name);
  for (let offset = 0; offset + FRAME_SAMPLES <= pcm.length; offset += FRAME_SAMPLES) {
    runtime.frame(pcm.slice(offset, offset + FRAME_SAMPLES), clock.t);
    await clock.step(0.08);
  }
  // Keep "listening" to background noise after the file ends.
  for (let t = 0; t < tailS; t += 0.08) { runtime.frame(new Int16Array(FRAME_SAMPLES).map(() => (Math.random() * 6 - 3) | 0), clock.t); await clock.step(0.08); }
  if (process.env.VOICE_DEBUG) console.log(name, JSON.stringify({ states, toasts, wakes: runtime.ctx.sessionCounter, server: server.log, ctx: { state: runtime.ctx.state, lastError: runtime.ctx.lastError } }));
  runtime.shutdown();
  await server.close();
  return { commands, states, toasts, server: server.log, wakes: runtime.ctx.sessionCounter, binarySendsOutsideStreaming, runtime };
}

describe.skipIf(!ready)('voice integration (real keyword spotter + VAD, fake Cartesia)', () => {
  afterEach(() => undefined);
  it('a command word inside a longer utterance runs once, on-device, and keeps the utterance local', async () => {
    const result = await run('wake_plus_command_one_breath.wav', { finalAfterAudioS: 1.6, transcript: 'hey cartesia, pen down.' });
    expect(result.commands.map(command => [command.text, command.source])).toEqual([['pen down', 'local']]);
    expect(result.server.audioBytes).toBe(0);
  }, 30_000);
  it('mention_brush_no_wake → the spotted command runs locally, nothing sent to Cartesia', async () => {
    const result = await run('mention_brush_no_wake.wav', { finalAfterAudioS: 99, transcript: 'never' }, 2);
    expect(result.commands.map(command => [command.text, command.source])).toEqual([['brush', 'local']]);
    expect(result.wakes).toBe(0);
    expect(result.server.audioBytes).toBe(0);
  }, 30_000);
  it('open mic: speech with no command word is streamed from its start and dispatched for Claude to read', async () => {
    const transcript = 'I was thinking we could grab lunch later and talk about the project timeline.';
    const result = await run('conversation_no_command.wav', { finalAfterAudioS: 4, transcript }, 6);
    expect(result.commands.map(command => [command.text, command.source])).toEqual([[transcript.replace(/\.$/, ''), 'open']]);
    expect(result.wakes).toBe(1);
    expect(result.server.audioBytes).toBeGreaterThanOrEqual(4 * 32000);
    expect(result.binarySendsOutsideStreaming).toBe(0);
    expect(result.toasts).toEqual(['ok']); // the fake host's result, and nothing else
  }, 30_000);
  it('the old wake phrase is ordinary speech now: one open turn, nothing dispatched without a transcript', async () => {
    const result = await run('double_wake_1s_apart.wav', { finalAfterAudioS: 99, transcript: '' }, 9);
    expect(result.wakes).toBe(1);
    expect(result.commands).toEqual([]);
    expect(result.toasts).toEqual([]);
  }, 30_000);
  it('silence_5s → nothing sent', async () => {
    const result = await run('silence_5s.wav', { finalAfterAudioS: 1, transcript: 'never' }, 1);
    expect(result.wakes).toBe(0);
    expect(result.server.audioBytes).toBe(0);
    expect(result.server.connections).toBe(1); // the startup probe only
  }, 30_000);
  it('401 on connect → key toast at startup, open mic never connects, no retry loop', async () => {
    const result = await run('conversation_no_command.wav', { finalAfterAudioS: 1, transcript: 'pen down', reject: 401 }, 2);
    expect(result.toasts).toContain('Cartesia key rejected — check CARTESIA_API_KEY');
    expect(result.server.connections).toBe(0);
    expect(result.server.audioBytes).toBe(0);
    expect(result.runtime.ctx.sttDisabled).toBe(true);
    expect(result.commands).toEqual([]);
  }, 30_000);
});
