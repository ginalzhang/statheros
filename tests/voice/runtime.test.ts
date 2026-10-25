import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { defaultVoiceConfig } from '../../src/main/voice/config';
import { MAX_LATENCY_SAMPLES, VoiceRuntime, type VoiceHost } from '../../src/main/voice/runtime';
import type { SocketFactory } from '../../src/main/voice/stt-session';

const host = (): VoiceHost => ({
  executeCommand: vi.fn(async () => 'ok'), openCapture: vi.fn(), closeCapture: vi.fn(),
  playEarcon: vi.fn(), stopPlayback: vi.fn(), changed: vi.fn(), log: vi.fn(),
  inference: { frame: vi.fn(), setWakeEnabled: vi.fn(), resetWake: vi.fn(), reset: vi.fn() },
});
afterEach(() => vi.useRealTimers());

it('aborts the startup probe and ignores late events after shutdown', async () => {
  vi.useFakeTimers();
  const socket = Object.assign(new EventEmitter(), { readyState: 0, terminate: vi.fn() });
  const adapter = host();
  const runtime = new VoiceRuntime(defaultVoiceConfig(), adapter, { apiKey: 'test', abortSupported: false, socketFactory: (() => socket) as unknown as SocketFactory });
  runtime.start({ muted: true }); runtime.shutdown();
  const changed = vi.mocked(adapter.changed).mock.calls.length;
  await Promise.resolve(); await Promise.resolve();
  runtime.post({ type: 'Unmute' });
  runtime.inferenceResult({ ts: 0, vadActive: false, rawActive: false, vadEvent: null, wake: null, command: { text: 'undo', ts: 1 }, inferMs: 1 });
  expect(socket.terminate).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
  expect(adapter.changed).toHaveBeenCalledTimes(changed);
  expect(adapter.openCapture).not.toHaveBeenCalled();
  expect(runtime.ctx.state).toBe('DISABLED');
});

it('drops a command still queued when the voice pipeline shuts down', async () => {
  vi.useFakeTimers();
  const adapter = host();
  const runtime = new VoiceRuntime(defaultVoiceConfig(), adapter, { apiKey: null, abortSupported: false });
  runtime.start(); runtime.post({ type: 'LocalCommand', text: 'undo', ts: 1 });
  runtime.shutdown();
  await Promise.resolve(); await Promise.resolve();
  expect(adapter.executeCommand).not.toHaveBeenCalled();
});

it('bounds command latency history during a long voice session', async () => {
  vi.useFakeTimers();
  const adapter = host();
  let now = 1;
  const runtime = new VoiceRuntime(defaultVoiceConfig(), adapter, { apiKey: null, abortSupported: false, now: () => now });
  runtime.start();
  for (let i = 0; i < MAX_LATENCY_SAMPLES + 10; i++) {
    runtime.post({ type: 'LocalCommand', text: 'undo', ts: now });
    await vi.advanceTimersByTimeAsync(2000); now += 2;
  }
  expect(adapter.executeCommand).toHaveBeenCalledTimes(MAX_LATENCY_SAMPLES + 10);
  expect(runtime.latencies).toHaveLength(MAX_LATENCY_SAMPLES);
  runtime.shutdown();
});

it('includes time waiting behind another command in final-to-dispatch latency', async () => {
  vi.useFakeTimers();
  const adapter = host();
  let finish!: (value: string) => void;
  vi.mocked(adapter.executeCommand).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  let now = 1;
  const runtime = new VoiceRuntime(defaultVoiceConfig(), adapter, { apiKey: null, abortSupported: false, now: () => now });
  runtime.start(); runtime.post({ type: 'LocalCommand', text: 'undo', ts: 1 });
  await Promise.resolve();
  // Fixture: a second PTT final arrives while the first native action is still pending.
  Object.assign(runtime.ctx, { state: 'PTT_ACTIVE', sessionId: 1, source: 'ptt', endpoint: 'manual' });
  runtime.post({ type: 'SttFinal', sessionId: 1, text: 'redo' });
  now = 3; finish('ok');
  await vi.advanceTimersByTimeAsync(0);
  expect(adapter.executeCommand).toHaveBeenCalledTimes(2);
  expect(runtime.latencies.at(-1)?.finalToDispatchMs).toBe(2000);
  runtime.shutdown();
});
