import workletUrl from './voice-worklet.js?url';

/**
 * Dumb capture + earcon output (prompt §2 Electron topology). The main process owns the ring buffer,
 * wake word, VAD, state machine, socket and key. Mute stops every track and closes the context so the
 * OS microphone indicator turns off.
 */
export class VoiceCapture {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private run = 0;
  constructor(private readonly frame: (pcm: ArrayBuffer) => void, private readonly failed: (reason: string) => void, private readonly opened: () => void, private readonly deviceChanged: () => void) {
    navigator.mediaDevices.addEventListener('devicechange', () => { if (this.stream) { this.deviceChanged(); void this.open(); } });
  }
  get isOpen(): boolean { return this.stream !== null; }
  async open(): Promise<void> {
    this.close();
    const run = ++this.run;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false }, video: false });
      if (run !== this.run) { stream.getTracks().forEach(track => track.stop()); return; }
      const context = new AudioContext({ sampleRate: 16000, latencyHint: 'interactive' });
      await context.audioWorklet.addModule(workletUrl);
      if (run !== this.run) { stream.getTracks().forEach(track => track.stop()); void context.close(); return; }
      const node = new AudioWorkletNode(context, 'steady-voice-tap', { numberOfInputs: 1, numberOfOutputs: 1 });
      node.port.onmessage = event => this.frame(event.data as ArrayBuffer);
      // A silent sink keeps the graph pulled; nothing is audible.
      const sink = context.createGain(); sink.gain.value = 0;
      context.createMediaStreamSource(stream).connect(node).connect(sink).connect(context.destination);
      for (const track of stream.getAudioTracks()) track.onended = () => { if (this.stream === stream) { this.deviceChanged(); void this.open(); } };
      this.stream = stream; this.context = context;
      this.opened();
    } catch (error) {
      if (run === this.run) this.failed(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    }
  }
  close(): void {
    this.run++;
    this.stream?.getTracks().forEach(track => track.stop());
    void this.context?.close().catch(() => undefined);
    this.stream = null; this.context = null;
  }
}

/** Pre-rendered ≤150 ms non-speech tones on a persistent output context (a cold start misses the 50 ms target). */
export class Earcons {
  private readonly context = new AudioContext({ latencyHint: 'interactive' });
  private readonly buffers: Record<'wake' | 'cancel', AudioBuffer>;
  private playing = new Map<string, AudioBufferSourceNode>();
  constructor(private readonly started: (playId: string) => void, private readonly stopped: (playId: string) => void) {
    this.buffers = { wake: this.tone([660, 990], 0.12), cancel: this.tone([660, 440], 0.12) };
  }
  private tone(frequencies: number[], seconds: number): AudioBuffer {
    const rate = this.context.sampleRate, length = Math.round(rate * seconds);
    const buffer = this.context.createBuffer(1, length, rate), data = buffer.getChannelData(0);
    const half = length / frequencies.length;
    for (let i = 0; i < length; i++) {
      const f = frequencies[Math.min(frequencies.length - 1, Math.floor(i / half))]!;
      const local = (i % half) / half;
      const envelope = Math.min(1, local * 12) * Math.min(1, (1 - local) * 6);
      data[i] = 0.18 * envelope * Math.sin(2 * Math.PI * f * i / rate);
    }
    return buffer;
  }
  play(name: 'wake' | 'cancel', playId: string): void {
    try {
      if (this.context.state === 'suspended') void this.context.resume();
      const source = this.context.createBufferSource();
      source.buffer = this.buffers[name];
      source.connect(this.context.destination);
      source.onended = () => { this.playing.delete(playId); this.stopped(playId); };
      this.playing.set(playId, source);
      source.start();
      this.started(playId);
    } catch { this.stopped(playId); } // an earcon failure is logged by gate_cap, never raised
  }
  stopAll(): void { for (const source of this.playing.values()) { try { source.stop(); } catch { /* ended */ } } }
}
