import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultVoiceConfig } from '../../src/main/voice/config';
import { AutoTranscriptBuilder, ManualTranscriptBuilder } from '../../src/main/voice/transcripts';
import { Forwarder, type AudioSink, type PacingClock } from '../../src/main/voice/forwarder';
import { RingBuffer, FRAME_SAMPLES } from '../../src/main/voice/audio';
import { LocalVad } from '../../src/main/voice/vad';
import { sttUrl } from '../../src/main/voice/stt-session';
import { PidLock } from '../../src/main/voice/lock';
import { parseSteadyCommand } from '../../src/main/voice/steady-commands';

describe('transcript builders', () => {
  it('Auto: cumulative replace, eager flag, resume, Final on turn.end', () => {
    const b = new AutoTranscriptBuilder();
    expect(b.accept({ type: 'connected', request_id: 'x' })[0]?.type).toBe('Log');
    expect(b.accept({ type: 'turn.start' })).toEqual([{ type: 'SttSpeechStart' }]);
    expect(b.accept({ type: 'turn.update', transcript: 'open goo' })).toEqual([{ type: 'SttPartial', text: 'open goo', eager: false }]);
    expect(b.accept({ type: 'turn.eager_end', transcript: 'open google' })).toEqual([{ type: 'SttPartial', text: 'open google', eager: true }]);
    expect(b.accept({ type: 'turn.resume' })).toEqual([{ type: 'SttTurnResume' }]);
    expect(b.accept({ type: 'turn.end', transcript: 'open google chrome', extra: 1 })).toEqual([{ type: 'SttFinal', text: 'open google chrome' }]);
    expect(b.accept({ type: 'error', status_code: 401, message: 'bad key' })[0]).toMatchObject({ type: 'SttError', code: 401, permanent: true });
    expect(b.accept({ type: 'error', status_code: 429, message: 'busy' })[0]).toMatchObject({ permanent: false });
  });
  it('Manual: verbatim delta concat of finals, one Final on flush_done, then reset', () => {
    const b = new ManualTranscriptBuilder();
    expect(b.accept({ type: 'transcript', is_final: false, text: ' pe' })[0]).toEqual({ type: 'SttPartial', text: ' pe', eager: false });
    b.accept({ type: 'transcript', is_final: true, text: ' pen' });
    expect(b.accept({ type: 'transcript', is_final: true, text: ' down' })[0]).toEqual({ type: 'SttPartial', text: ' pen down', eager: false });
    b.finalizeSent();
    expect(b.accept({ type: 'flush_done' })).toEqual([{ type: 'SttFinal', text: ' pen down' }]);
    expect(b.accept({ type: 'done' })[0]?.type).toBe('Log'); // never a second Final
    b.accept({ type: 'transcript', is_final: true, text: ' undo' });
    b.finalizeSent();
    expect(b.accept({ type: 'flush_done' })).toEqual([{ type: 'SttFinal', text: ' undo' }]);
  });
  it('Manual: Final on close when flush_done never arrives; finalize-while-speaking is classified', () => {
    const b = new ManualTranscriptBuilder();
    b.accept({ type: 'transcript', is_final: true, text: 'redo' });
    b.finalizeSent();
    expect(b.accept({ type: 'error', status_code: 400, message: 'Cannot finalize while speech is in progress' })).toEqual([{ type: 'SttFinalizeRejected' }]);
    b.finalizeSent();
    expect(b.closed()).toEqual([{ type: 'SttFinal', text: 'redo' }]);
  });
});

class FakeClock implements PacingClock {
  t = 0; private ticks: (() => void)[] = [];
  now = (): number => this.t;
  every = (_ms: number, tick: () => void): (() => void) => { this.ticks.push(tick); return () => { this.ticks = this.ticks.filter(t => t !== tick); }; };
  advance(seconds: number): void { const end = this.t + seconds; while (this.t < end - 1e-9) { this.t = Math.min(end, this.t + 0.025); for (const tick of this.ticks) tick(); } }
}
class FakeSink implements AudioSink {
  isOpen = false; sends: { t: number; bytes: number }[] = []; controls: string[] = [];
  constructor(private clock: FakeClock) {}
  sendAudio(pcm: Buffer): boolean { this.sends.push({ t: this.clock.t, bytes: pcm.length }); return true; }
  finalize(): void { this.controls.push('finalize'); }
  close(): void { this.controls.push('close'); }
}
const frame = (ts: number) => ({ pcm: new Int16Array(FRAME_SAMPLES).fill(100), ts });

describe('Forwarder', () => {
  it('never writes binary with the gate off; queued audio is not a send', () => {
    const clock = new FakeClock(), ring = new RingBuffer(63), forwarder = new Forwarder(ring, clock), sink = new FakeSink(clock);
    for (let i = 0; i < 10; i++) ring.append(frame(i * 0.08));
    forwarder.attach(sink);
    forwarder.start(0);
    clock.advance(1);
    expect(sink.sends).toEqual([]); // not connected yet: queued in RAM
    sink.isOpen = true;
    clock.advance(1);
    expect(sink.sends).toEqual([]); // gate off: discarded, never held
    forwarder.gate = true;
    forwarder.push(frame(1)); forwarder.push(frame(1.08));
    clock.advance(0.5);
    expect(sink.sends.length).toBeGreaterThan(0);
  });
  it('bursts at most 1 s of backlog, then catches up at 2× real time', () => {
    const clock = new FakeClock(), ring = new RingBuffer(63), forwarder = new Forwarder(ring, clock), sink = new FakeSink(clock);
    for (let i = 0; i < 50; i++) ring.append(frame(i * 0.08)); // 4 s of backlog
    forwarder.attach(sink); forwarder.gate = true; sink.isOpen = true;
    forwarder.start(0);
    const burst = sink.sends.filter(send => send.t === 0).reduce((n, send) => n + send.bytes, 0);
    expect(burst).toBeLessThanOrEqual(32000);
    clock.advance(1);
    const afterOne = sink.sends.reduce((n, send) => n + send.bytes, 0);
    expect(afterOne).toBeLessThanOrEqual(32000 + 2 * 32000 + 3200);
    expect(afterOne).toBeGreaterThan(32000 + 1.5 * 32000);
  });
  it('control frames go behind pending audio; StopForwarding drops the backlog so close goes out at once', () => {
    const clock = new FakeClock(), ring = new RingBuffer(63), forwarder = new Forwarder(ring, clock), sink = new FakeSink(clock);
    for (let i = 0; i < 40; i++) ring.append(frame(i * 0.08));
    forwarder.attach(sink); forwarder.gate = true; sink.isOpen = true;
    forwarder.start(0);
    forwarder.control('finalize');
    expect(sink.controls).toEqual([]);
    forwarder.gate = false; forwarder.stop(); forwarder.control('close');
    expect(sink.controls).toEqual(['finalize', 'close']);
  });
  it('pad_then_close still sends the close when the pad is cut short by StopForwarding', () => {
    const clock = new FakeClock(), ring = new RingBuffer(63), forwarder = new Forwarder(ring, clock), sink = new FakeSink(clock);
    forwarder.attach(sink); forwarder.gate = true; sink.isOpen = true;
    forwarder.padZeros(1, () => { forwarder.gate = false; forwarder.stop(); forwarder.control('close'); });
    clock.advance(0.3);
    expect(sink.sends.length).toBeGreaterThan(0);
    forwarder.stop();
    expect(sink.controls).toEqual(['close']);
  });
  it('audio queued before connect gets the 1 s burst once the socket opens (PTT)', () => {
    const clock = new FakeClock(), ring = new RingBuffer(63), forwarder = new Forwarder(ring, clock), sink = new FakeSink(clock);
    forwarder.attach(sink); forwarder.gate = true;
    forwarder.start(null);
    for (let i = 0; i < 8; i++) { forwarder.push(frame(i * 0.08)); clock.advance(0.08); }
    sink.isOpen = true;
    clock.advance(0.025);
    expect(sink.sends.reduce((n, send) => n + send.bytes, 0)).toBeGreaterThanOrEqual(6 * 3200);
  });
  it('StartForwarding is idempotent and clamps to the oldest frame', () => {
    const clock = new FakeClock(), ring = new RingBuffer(5), forwarder = new Forwarder(ring, clock), sink = new FakeSink(clock);
    for (let i = 0; i < 10; i++) ring.append(frame(i * 0.08));
    forwarder.attach(sink); forwarder.gate = true; sink.isOpen = true;
    forwarder.start(-100); forwarder.start(-100);
    clock.advance(2);
    expect(sink.sends.reduce((n, send) => n + send.bytes, 0)).toBe(5 * FRAME_SAMPLES * 2);
  });
});

describe('LocalVad', () => {
  it('starts after 2 frames above threshold and ends after the hangover; speech_ms excludes it', () => {
    const vad = new LocalVad(600);
    const events = [];
    for (let i = 0; i < 30; i++) { const e = vad.process(i >= 2 && i < 12, i * 0.08); if (e) events.push(e); }
    expect(events[0]).toMatchObject({ type: 'VadSpeechStart' });
    expect(events[1]).toMatchObject({ type: 'VadSpeechEnd', speechMs: 800 });
    expect(vad.isActive).toBe(false);
  });
  it('a single loud frame is not speech', () => {
    const vad = new LocalVad(600);
    expect([true, false, false].map((above, i) => vad.process(above, i * 0.08))).toEqual([null, null, null]);
  });
});

describe('sttUrl', () => {
  const config = defaultVoiceConfig();
  it('builds the Auto URL with turn params, version and keyterms', () => {
    const url = new URL(sttUrl('auto', config));
    expect(url.origin + url.pathname).toBe('wss://api.cartesia.ai/stt/turns/websocket');
    expect(url.searchParams.get('model')).toBe('ink-2');
    expect(url.searchParams.get('encoding')).toBe('pcm_s16le');
    expect(url.searchParams.get('sample_rate')).toBe('16000');
    expect(url.searchParams.get('cartesia_version')).toBe('2026-08-14');
    expect(url.searchParams.get('turn_end_timeout_ms')).toBe('1500');
    expect(url.searchParams.getAll('keyterm')[0]).toBe('Cartesia');
  });
  it('Manual URL has no turn params; non-TLS is refused', () => {
    const url = new URL(sttUrl('manual', config));
    expect(url.pathname).toBe('/stt/websocket');
    expect(url.searchParams.has('turn_end_threshold')).toBe(false);
    expect(() => sttUrl('manual', config, 'ws://example.com')).toThrow();
  });
});

describe('PidLock', () => {
  it('refuses while another live instance holds it', () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'steady-lock-')), 'voice.lock');
    const first = new PidLock(file, 111, () => true), second = new PidLock(file, 222, () => true);
    expect(first.acquire()).toBe(true);
    expect(second.acquire()).toBe(false);
    first.release();
    expect(second.acquire()).toBe(true);
    expect(new PidLock(file, 333, () => false).acquire()).toBe(true); // stale owner
  });
});

describe('Steady voice vocabulary', () => {
  it('maps the fixed vocabulary and rejects everything else', () => {
    expect(parseSteadyCommand('Pen down.')).toBe('penDown');
    expect(parseSteadyCommand('steady undo')).toBe('undo');
    expect(parseSteadyCommand('Toggle erase!')).toBe('toggleErase');
    expect(parseSteadyCommand('microphone off')).toBe('microphoneOff');
    expect(parseSteadyCommand('put the pen down')).toBeNull();
    expect(parseSteadyCommand('undo redo')).toBeNull();
    // A misheard wake phrase ("hey cartesia" → "here okay") may precede the command after a wake detection only.
    expect(parseSteadyCommand('Here okay, undo.', 'wake')).toBe('undo');
    expect(parseSteadyCommand('okay pen down', 'wake')).toBe('penDown');
    expect(parseSteadyCommand('here okay steady undo', 'wake')).toBe('undo');
    expect(parseSteadyCommand('here okay undo')).toBeNull();
    expect(parseSteadyCommand('here okay undo', 'ptt')).toBeNull();
    expect(parseSteadyCommand('one two three undo', 'wake')).toBeNull();
    expect(parseSteadyCommand('undo redo', 'wake')).toBeNull();
    expect(parseSteadyCommand('pen up down', 'wake')).toBeNull();
  });
});
