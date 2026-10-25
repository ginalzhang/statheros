import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';

const workers = vi.hoisted(() => [] as (EventEmitter & { postMessage: ReturnType<typeof vi.fn> })[]);
vi.mock('node:worker_threads', async () => {
  const { EventEmitter } = await import('node:events');
  return { Worker: class extends EventEmitter {
    postMessage = vi.fn((message: { type: string }) => { if (message.type === 'exit') queueMicrotask(() => this.emit('exit')); });
    terminate = vi.fn(async () => {});
    constructor() { super(); workers.push(this); }
  } };
});
vi.mock('electron', () => ({
  globalShortcut: { register: vi.fn(() => true), unregister: vi.fn() },
  safeStorage: { isEncryptionAvailable: () => true },
  systemPreferences: { getMediaAccessStatus: () => 'granted' },
}));
import { ElectronVoice } from '../../src/main/voice/electron-voice';
import { defaultVoiceConfig } from '../../src/main/voice/config';

let root: string;
let voice: ElectronVoice | undefined;
afterEach(async () => {
  await voice?.stop(); voice = undefined;
  if (root) await rm(root, { recursive: true, force: true });
  workers.length = 0; vi.unstubAllEnvs();
});

it('ignores old worker results and errors when a key change replaces the voice pipeline', async () => {
  vi.stubEnv('CARTESIA_API_KEY', '');
  root = await mkdtemp(path.join(os.tmpdir(), 'steady-voice-'));
  await writeFile(path.join(root, 'voice-worker.cjs'), '');
  voice = new ElectronVoice({ buildDir: root, voiceRoot: root, userData: root, packaged: false,
    panel: () => null, windows: () => [], execute: async () => 'ok', microphoneChanged: vi.fn() });
  voice.start();
  expect(workers).toHaveLength(0); // Models stay unloaded while muted.
  voice.setMicrophone(true);
  const old = workers[0]!;
  voice.setKey(null);
  const current = workers[1]!;
  current.emit('message', { type: 'ready', wake: true, vad: 'silero', error: null });
  old.emit('message', { type: 'ready', wake: false, vad: 'energy', error: 'stale worker error' });
  old.emit('error', new Error('old worker crashed'));
  expect(voice.snapshot()?.wakeReady).toBe(true);
  voice.setMicrophone(true);
  voice.frame(new Uint8Array(2560));
  expect(current.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'frame' }), expect.any(Array));
  const count = current.postMessage.mock.calls.length;
  expect(() => voice!.frame(new ArrayBuffer(3))).not.toThrow();
  voice.frame(new Uint8Array(2_000_000));
  expect(current.postMessage).toHaveBeenCalledTimes(count);
});

it('does not start disabled voice through key changes or microphone controls', async () => {
  vi.stubEnv('CARTESIA_API_KEY', '');
  root = await mkdtemp(path.join(os.tmpdir(), 'steady-voice-disabled-'));
  const config = defaultVoiceConfig(); config.enabled = false;
  voice = new ElectronVoice({ config, buildDir: root, voiceRoot: root, userData: root, packaged: false,
    panel: () => null, windows: () => [], execute: async () => 'ok', microphoneChanged: vi.fn() });
  voice.start(); voice.setKey(null); voice.setMicrophone(true);
  expect(workers).toHaveLength(0);
  expect(voice.snapshot()).toBeNull();
});

it('shows capture pending until opened, and shares concurrent microphone self-tests', async () => {
  vi.stubEnv('CARTESIA_API_KEY', '');
  root = await mkdtemp(path.join(os.tmpdir(), 'steady-voice-selftest-'));
  await writeFile(path.join(root, 'voice-worker.cjs'), '');
  voice = new ElectronVoice({ buildDir: root, voiceRoot: root, userData: root, packaged: false,
    panel: () => null, windows: () => [], execute: async () => 'ok', microphoneChanged: vi.fn() });
  voice.start(); voice.setMicrophone(true);
  expect(voice.snapshot()?.captureOpen).toBe(false);
  voice.report({ type: 'opened' });
  expect(voice.snapshot()?.captureOpen).toBe(true);
  vi.useFakeTimers();
  const first = voice.selfTest(), second = voice.selfTest();
  expect(first).toBe(second);
  for (let i = 0; i < 25; i++) {
    voice.frame(new Int16Array(1280).fill(1000));
    await vi.advanceTimersByTimeAsync(80);
  }
  expect(await first).toMatchObject({ ok: true, samplesPerSecond: 16000 });
  voice.setMicrophone(false);
  expect(voice.snapshot()?.captureOpen).toBe(false);
  vi.useRealTimers();
});
