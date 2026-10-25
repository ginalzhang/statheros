import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { defaultVoiceConfig } from '../../src/main/voice/config';
import { SttSession, type SocketFactory } from '../../src/main/voice/stt-session';

afterEach(() => vi.useRealTimers());

it('reports a synchronous socket construction failure without throwing a timer initialization error', async () => {
  const signals = vi.fn();
  const config = defaultVoiceConfig(); config.stt.connectAttempts = 1;
  const session = new SttSession(1, 'auto', config, 'test', signals, { factory: () => { throw new Error('socket unavailable'); } });
  await session.open();
  expect(signals).toHaveBeenCalledWith(expect.objectContaining({ type: 'SttError', message: 'Error: socket unavailable' }));
});

it('abort settles a pending connect and clears its timeout, with no retry or late events', async () => {
  vi.useFakeTimers();
  const socket = Object.assign(new EventEmitter(), { readyState: 0, terminate: vi.fn() });
  const factory = vi.fn(() => socket) as unknown as SocketFactory;
  const signals = vi.fn();
  const session = new SttSession(1, 'auto', defaultVoiceConfig(), 'test', signals, { factory });
  const opening = session.open();
  session.abort(); await opening;
  expect(vi.getTimerCount()).toBe(0);
  socket.emit('open'); socket.emit('close');
  expect(signals).not.toHaveBeenCalled();
  await session.open();
  expect(factory).toHaveBeenCalledOnce();
});

it('terminates congested audio instead of growing the socket backlog or claiming a send', async () => {
  const { MAX_BUFFERED_AUDIO_BYTES } = await import('../../src/main/voice/stt-session');
  const socket = Object.assign(new EventEmitter(), { readyState: 1, bufferedAmount: MAX_BUFFERED_AUDIO_BYTES - 3200, send: vi.fn(), terminate: vi.fn() });
  const signals = vi.fn();
  const session = new SttSession(1, 'auto', defaultVoiceConfig(), 'test', signals, { factory: (() => socket) as unknown as SocketFactory });
  const opening = session.open(); socket.emit('open'); await opening;
  expect(session.sendAudio(Buffer.alloc(3200))).toBe(true);
  socket.bufferedAmount++;
  expect(session.sendAudio(Buffer.alloc(3200))).toBe(false);
  expect(socket.terminate).toHaveBeenCalledOnce();
  expect(signals).toHaveBeenCalledWith(expect.objectContaining({ type: 'SttError', code: 'backpressure' }));
  expect(session.sendAudio(Buffer.alloc(3200))).toBe(false);
  expect(socket.send).toHaveBeenCalledOnce();
});
