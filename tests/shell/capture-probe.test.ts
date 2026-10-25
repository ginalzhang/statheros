import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CameraProbe, type ProbeReport } from '../../src/renderer/probe';
import { HAND_LOSS_MS } from '../../src/renderer/tracking';
import type { TrackingSample } from '../../src/shared/contracts';

class FakeWorker {
  static all: FakeWorker[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  sent: any[] = [];
  terminate = vi.fn();
  constructor() { FakeWorker.all.push(this); }
  postMessage(value: unknown): void { this.sent.push(value); }
  receive(data: unknown): void { this.onmessage?.({ data }); }
}

describe('CameraProbe lifecycle with fake media and worker', () => {
  let camera: CameraProbe;
  let report: ReturnType<typeof vi.fn<(value: ProbeReport) => void>>;
  let output: ReturnType<typeof vi.fn<(value: TrackingSample) => void>>;
  let fault: ReturnType<typeof vi.fn<() => void>>;
  let callback: VideoFrameRequestCallback;
  let generation: number;
  let track: { stop: ReturnType<typeof vi.fn>; onended: (() => void) | null; getSettings: () => MediaTrackSettings };
  const receiveFrame = (time: number): void => callback(performance.now(), { mediaTime: time, captureTime: performance.now() } as VideoFrameCallbackMetadata);
  const result = (frame: any, label = 'Left') => ({ type: 'sample', sample: { generation: frame.generation, frameId: frame.frameId, captureTimestamp: frame.captureTimestamp, mode: 'palm', valid: true, anchor: { x: 0.5, y: 0.5 }, qualityReason: 'valid', selectedHand: label } });
  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(0); FakeWorker.all = []; generation = 1;
    report = vi.fn(); output = vi.fn(); fault = vi.fn();
    track = { stop: vi.fn(), onended: null, getSettings: () => ({ deviceId: 'camera-1', width: 640, height: 480, frameRate: 30 }) };
    const video = { readyState: 2, muted: false, playsInline: false, srcObject: null, play: vi.fn(async () => {}), pause: vi.fn(), requestVideoFrameCallback: vi.fn((value: VideoFrameRequestCallback) => { callback = value; return 1; }), cancelVideoFrameCallback: vi.fn() };
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(async () => ({ getVideoTracks: () => [track], getTracks: () => [track] })) } });
    vi.stubGlobal('document', { createElement: vi.fn(() => video) });
    vi.stubGlobal('Worker', FakeWorker);
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ close: vi.fn() })));
    camera = new CameraProbe(() => generation, report, output, fault);
  });
  afterEach(() => { camera.stop(); vi.useRealTimers(); vi.unstubAllGlobals(); });
  it('requests nearest camera format and dispatches one frame while dropping intermediate frames', async () => {
    await camera.start('camera-1', 'palm');
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({ audio: false, video: { deviceId: { exact: 'camera-1' }, width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } } });
    const worker = FakeWorker.all[0]!; worker.receive({ type: 'ready', delegate: 'GPU' });
    receiveFrame(1); await vi.advanceTimersByTimeAsync(34);
    receiveFrame(2); await vi.advanceTimersByTimeAsync(34);
    receiveFrame(3); await vi.advanceTimersByTimeAsync(34);
    const frames = () => worker.sent.filter(value => value.type === 'frame');
    expect(frames()).toHaveLength(1);
    worker.receive(result(frames()[0])); expect(output).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(34); expect(frames()).toHaveLength(2);
    expect(frames()[1].captureTimestamp).toBeGreaterThan(frames()[0].captureTimestamp);
  });
  it('rejects replaced-generation/stale results and declares hand loss during no-frame starvation', async () => {
    await camera.start('', 'palm'); const worker = FakeWorker.all[0]!; worker.receive({ type: 'ready', delegate: 'CPU' });
    receiveFrame(1); await vi.advanceTimersByTimeAsync(34); const frame = worker.sent.find(value => value.type === 'frame');
    worker.receive(result(frame)); expect(output).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(250); expect(fault).not.toHaveBeenCalled(); // input pause is native; no lock yet
    await vi.advanceTimersByTimeAsync(HAND_LOSS_MS - 250 + 10); expect(fault).toHaveBeenCalledOnce(); // next 10 ms watchdog tick
    expect(report.mock.lastCall?.[0].confirmationRequired).toBe(true);
    expect(camera.confirmHand()).toBe(false);
    receiveFrame(2); await vi.advanceTimersByTimeAsync(34); const next = worker.sent.filter(value => value.type === 'frame')[1];
    generation = 2; worker.receive(result(next)); expect(output).toHaveBeenCalledOnce();
    expect(report.mock.lastCall?.[0].staleFrames).toBe(1);
    receiveFrame(3); await vi.advanceTimersByTimeAsync(34); const stale = worker.sent.filter(value => value.type === 'frame')[2];
    await vi.advanceTimersByTimeAsync(250); worker.receive(result(stale)); expect(output).toHaveBeenCalledOnce();
    expect(report.mock.lastCall?.[0].staleFrames).toBe(2);
  });
  it('retains an automatically selected hand through same-camera restart and requires confirmation', async () => {
    await camera.start('camera-1', 'palm');
    const worker = FakeWorker.all[0]!; worker.receive({ type: 'ready', delegate: 'GPU' });
    receiveFrame(1); await vi.advanceTimersByTimeAsync(34);
    worker.receive(result(worker.sent.find(value => value.type === 'frame'), 'Left'));
    expect(output.mock.lastCall?.[0].valid).toBe(true);
    camera.stop(); await camera.start('camera-1', 'palm');
    const replacement = FakeWorker.all[1]!; replacement.receive({ type: 'ready', delegate: 'GPU' });
    expect(report.mock.lastCall?.[0].selectedHand).toBe('Left');
    expect(report.mock.lastCall?.[0].confirmationRequired).toBe(true);
    receiveFrame(2); await vi.advanceTimersByTimeAsync(34);
    replacement.receive(result(replacement.sent.find(value => value.type === 'frame'), 'Right'));
    expect(output.mock.lastCall?.[0].qualityReason).toBe('different hand label');
    expect(camera.confirmHand()).toBe(false);
  });
  it('requires explicit restart after inference failure and ignores old-run messages', async () => {
    await camera.start('', 'palm'); const worker = FakeWorker.all[0]!;
    worker.receive({ type: 'ready', delegate: 'GPU' }); worker.receive({ type: 'fault', message: 'Inference failed; restart explicitly' });
    expect(worker.terminate).toHaveBeenCalledOnce(); expect(track.stop).toHaveBeenCalledOnce(); expect(fault).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1000); expect(FakeWorker.all).toHaveLength(1);
    worker.receive({ type: 'ready', delegate: 'CPU' }); expect(report.mock.lastCall?.[0].running).toBe(false);
    camera.setSelectedHand('Right'); await camera.start('', 'palm');
    const replacement = FakeWorker.all[1]!; replacement.receive({ type: 'ready', delegate: 'GPU' });
    receiveFrame(1); await vi.advanceTimersByTimeAsync(34); replacement.receive(result(replacement.sent.find(value => value.type === 'frame'), 'Right'));
    expect(output.mock.lastCall?.[0].qualityReason).toBe('confirm selected hand');
    expect(camera.confirmHand()).toBe(true);
    camera.stop(); await camera.start('', 'palm'); expect(report.mock.lastCall?.[0].confirmationRequired).toBe(true);
  });
});
