import { afterEach, expect, it, vi } from 'vitest';
import { PreviewStreamer } from '../../src/renderer/utilities';
import { Earcons, VoiceCapture } from '../../src/renderer/voice-capture';

afterEach(() => vi.unstubAllGlobals());

it('reuses preview canvas dimensions and ignores a JPEG completed after close', () => {
  const postMessage = vi.fn(), close = vi.fn();
  vi.stubGlobal('BroadcastChannel', class { postMessage = postMessage; close = close; });
  let heightWrites = 0, height = 0;
  const context = { drawImage: vi.fn() };
  const callbacks: BlobCallback[] = [];
  const scaled = { width: 0, get height() { return height; }, set height(value: number) { heightWrites++; height = value; }, getContext: () => context, toBlob: (callback: BlobCallback) => callbacks.push(callback) };
  vi.stubGlobal('document', { createElement: () => scaled });
  const streamer = new PreviewStreamer();
  const source = { width: 640, height: 480 } as HTMLCanvasElement;
  streamer.push(source, 0); callbacks[0]!(new Blob(['jpeg']));
  streamer.push(source, 33); // Intermediate camera frames are skipped before drawing/encoding.
  expect(context.drawImage).toHaveBeenCalledOnce();
  streamer.push(source, 67);
  expect(heightWrites).toBe(1); // initialization only, no per-frame backing-store reset
  expect(context.drawImage).toHaveBeenCalledTimes(2);
  streamer.close(); callbacks[1]!(new Blob(['jpeg']));
  streamer.push(source);
  expect(postMessage).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
});

it('removes device listeners, stops capture and drops old worklet frames on disposal', async () => {
  const mediaDevices = Object.assign(new EventTarget(), { getUserMedia: vi.fn() });
  const remove = vi.spyOn(mediaDevices, 'removeEventListener');
  const track = { stop: vi.fn() };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  mediaDevices.getUserMedia.mockResolvedValue(stream);
  vi.stubGlobal('navigator', { mediaDevices });
  const connectable = { connect: () => connectable };
  const closeContext = vi.fn(async () => {});
  vi.stubGlobal('AudioContext', class {
    audioWorklet = { addModule: async () => {} };
    destination = {};
    createGain = () => ({ ...connectable, gain: { value: 1 } });
    createMediaStreamSource = () => connectable;
    close = closeContext;
  });
  let port: { onmessage: ((event: { data: ArrayBuffer }) => void) | null };
  vi.stubGlobal('AudioWorkletNode', class { port = port = { onmessage: null }; });
  const frame = vi.fn();
  const capture = new VoiceCapture(frame, vi.fn(), vi.fn(), vi.fn());
  await capture.open();
  port!.onmessage!({ data: new ArrayBuffer(2560) });
  capture.dispose();
  port!.onmessage!({ data: new ArrayBuffer(2560) });
  mediaDevices.dispatchEvent(new Event('devicechange'));
  expect(frame).toHaveBeenCalledOnce();
  expect(track.stop).toHaveBeenCalledOnce();
  expect(closeContext).toHaveBeenCalledOnce();
  expect(remove).toHaveBeenCalledWith('devicechange', expect.any(Function));
  expect(mediaDevices.getUserMedia).toHaveBeenCalledOnce();
});

it('closes the earcon output context and suppresses callbacks after disposal', () => {
  const close = vi.fn(async () => {}), stop = vi.fn();
  const source = { buffer: null, connect: vi.fn(), onended: null as (() => void) | null, start: vi.fn(), stop };
  vi.stubGlobal('AudioContext', class {
    sampleRate = 16000; destination = {}; state = 'running'; close = close;
    createBuffer = (_channels: number, length: number) => ({ getChannelData: () => new Float32Array(length) });
    createBufferSource = () => source;
  });
  const stopped = vi.fn();
  const earcons = new Earcons(vi.fn(), stopped);
  earcons.play('wake', '1'); earcons.dispose();
  expect(source.onended).toBeNull();
  expect(stop).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
  expect(stopped).not.toHaveBeenCalled();
});
