import { afterEach, expect, it, vi } from 'vitest';
import { CanvasSetRequest } from '../src/main/canvas-set-request';
import { ConfigurationQueue } from '../src/main/configuration';

const context = { generation: 4, targetPid: 123, displayId: 1 };
afterEach(() => vi.useRealTimers());

it('waits ten seconds without blocking observations or cancellation in the configuration queue', async () => {
  vi.useFakeTimers();
  const request = new CanvasSetRequest(), queue = new ConfigurationQueue(), fallback = vi.fn();
  await queue.run(async () => request.start(context, fallback));
  expect(queue.busy).toBe(false);
  await vi.advanceTimersByTimeAsync(9999);
  expect(fallback).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(fallback).toHaveBeenCalledExactlyOnceWith(request.current);
  request.cancel();
});

it('binds continuation to the same generation, target and display', () => {
  vi.useFakeTimers();
  const request = new CanvasSetRequest(); request.start(context, vi.fn());
  expect(request.matches(context)).toBe(true);
  for (const patch of [{ generation: 5 }, { targetPid: 456 }, { displayId: 2 }]) {
    expect(request.matches({ ...context, ...patch })).toBe(false);
  }
  request.cancel(); expect(request.matches(context)).toBe(false);
});

it('consumes success or review once, preventing a duplicate timeout overlay', async () => {
  vi.useFakeTimers();
  const request = new CanvasSetRequest(), fallback = vi.fn(); request.start(context, fallback);
  const token = request.current!;
  expect(request.consume(token)).toBe(true);
  expect(request.consume(token)).toBe(false);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(fallback).not.toHaveBeenCalled();
});

it('cancellation prevents even an already queued timeout from acting on a replacement', async () => {
  vi.useFakeTimers();
  const request = new CanvasSetRequest(), queue = new ConfigurationQueue(), fallback = vi.fn();
  let release!: () => void;
  const blocked = queue.run(() => new Promise<void>(resolve => { release = resolve; }));
  await Promise.resolve();
  request.start(context, token => {
    void queue.run(async () => { if (request.consume(token)) fallback(); });
  });
  await vi.advanceTimersByTimeAsync(10_000);
  request.cancel(); request.start({ ...context, generation: 5 }, vi.fn());
  release(); await blocked;
  await queue.run(async () => undefined);
  expect(fallback).not.toHaveBeenCalled(); expect(request.current?.generation).toBe(5);
  request.cancel();
});

it('replacement cancels the prior timer', async () => {
  vi.useFakeTimers();
  const request = new CanvasSetRequest(), oldFallback = vi.fn(), newFallback = vi.fn();
  request.start(context, oldFallback);
  await vi.advanceTimersByTimeAsync(5000);
  request.start({ ...context, generation: 5 }, newFallback);
  await vi.advanceTimersByTimeAsync(5000);
  expect(oldFallback).not.toHaveBeenCalled(); expect(newFallback).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(5000);
  expect(newFallback).toHaveBeenCalledOnce();
  request.cancel();
});
