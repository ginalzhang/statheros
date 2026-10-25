import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { ClockSync, LineDecoder, validReply, validRequest } from './protocol';
import type { Ack, NativeState, Reply, RequestPayloads, TrackingSample } from '../shared/contracts';
import { SpeechDiagnosticDecoder } from './speech-diagnostics';

export class NativeSupervisor extends EventEmitter {
  readonly session = randomUUID(); readonly clock = new ClockSync();
  state: NativeState | null = null;
  private seq = 0; private lastReplySeq = -1; private child: ChildProcessWithoutNullStreams | null = null;
  private stopping = false; private sample: RequestPayloads['sample'] | null = null; private sampling = false;
  private failed = false;
  private configurationRequests = 0;
  private synchronizing = false;
  private pending = new Map<number, { resolve: (ack: Ack) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private refresh: ReturnType<typeof setInterval> | null = null;
  private speechSession:string|null=null;private lastDiagnostic=-Infinity;
  constructor(readonly executable: string, readonly realInput: boolean, readonly testFakeBackend = false) { super(); }
  async start(): Promise<void> {
    const child = this.child = spawn(this.executable, this.realInput ? ['--real-input'] : this.testFakeBackend ? ['--test-fake-backend','--test-system-displays'] : [], { stdio: ['pipe','pipe','pipe'] });
    const decoder = new LineDecoder();
    child.stdout.on('data', chunk => { try { for (const value of decoder.push(chunk)) this.receive(value); } catch (error) { this.fail(String(error)); } });
    const diagnostics=new SpeechDiagnosticDecoder();
    child.stderr.on('data',chunk=>{for(const value of diagnostics.push(chunk,this.speechSession)){const now=performance.now();if(now-this.lastDiagnostic>=1000){this.lastDiagnostic=now;this.emit('speech-diagnostics',value);}}});
    child.on('error', error => this.fail(error.message));
    child.on('exit', () => { this.child = null; this.emergencyRelease(); if (!this.stopping) this.fail('Native helper exited; explicit restart required'); });
    const hello = await this.request('hello', { bundleId: 'org.steady.local' });
    if (hello.protocolVersion !== 1) {this.fail('Native protocol mismatch');throw new Error('Native protocol mismatch');}
    this.emit('hello', hello);
    await this.synchronize();
    this.refresh = setInterval(() => { void this.synchronize().catch(error => this.fail(String(error))); }, 30_000);
  }
  private receive(value: unknown): void {
    if (!validReply(value) || value.session !== this.session || value.seq <= this.lastReplySeq) throw new Error('Invalid native reply/session/sequence');
    this.lastReplySeq = value.seq;
    const reply = value as Reply;
    if (reply.type === 'ack') {
      const pending = this.pending.get(reply.payload.requestSeq);
      if (!pending) throw new Error('Unexpected acknowledgment');
      clearTimeout(pending.timer); this.pending.delete(reply.payload.requestSeq);
      this.state = reply.payload.state; this.emit('state', this.state);
      if(reply.payload.displays)this.emit('displays',reply.payload.displays);
      if(reply.payload.targetPid!==undefined)this.emit('target',reply.payload.targetPid);
      if (reply.payload.accepted) pending.resolve(reply.payload); else pending.reject(new Error(reply.payload.code));
    } else if (reply.type === 'state') { this.state = reply.payload; this.emit('state', this.state); }
    else if (reply.type === 'fault') {this.emit('native-fault',reply.payload.code);this.fail(reply.payload.message);}
    else if (reply.type === 'canvasObservation') this.emit('canvas-observation', reply.payload);
    else this.emit('speech', reply.payload);
  }
  request<K extends keyof RequestPayloads>(type: K, payload: RequestPayloads[K]): Promise<Ack> {
    const seq = ++this.seq;
    const message = { v: 1, session: this.session, seq, type, payload };
    if (!validRequest(message)) return Promise.reject(new Error('Invalid outbound request'));
    if (this.failed || !this.child || this.child.killed) return Promise.reject(new Error('Native helper unavailable'));
    const configuration = type === 'configure';
    if (configuration) { this.configurationRequests++; this.sample = null; }
    if(type==='microphone'){const control=payload as RequestPayloads['microphone'];this.speechSession=control.enabled?control.speechSession:null;this.lastDiagnostic=-Infinity;}
    return new Promise<Ack>((resolve,reject) => {
      const timer = setTimeout(() => { this.pending.delete(seq); reject(new Error('Native acknowledgment timeout')); this.fail('Native acknowledgment timeout'); }, 500);
      this.pending.set(seq, { resolve, reject, timer });
      this.child!.stdin.write(JSON.stringify(message)+'\n', error => { if (error) this.fail(error.message); });
    }).finally(() => { if (configuration) this.configurationRequests--; });
  }
  async synchronize(): Promise<void> {
    if (this.synchronizing) return;
    this.synchronizing = true; this.sample = null;
    try {
    this.clock.uncertainty = Infinity;
    this.emit('clock-ready',false);
    // A noisy estimate pauses native control before one fresh eight-trip attempt.
    // Never infer freshness from these pings or silently resume after recovery.
    for (let attempt=0;attempt<2;attempt++) {
      const probes = [];
      for (let i=0;i<8;i++) {
        const sent = performance.now(); const ack = await this.request('ping', { senderTimestamp: sent }); const received = performance.now();
        if (ack.nativeTimestamp === null) throw new Error('Missing native clock timestamp');
        probes.push({ sent, received, native: ack.nativeTimestamp });
      }
      this.clock.choose(probes, performance.now());
      if (this.clock.uncertainty <= 10) break;
      await this.request('action', { generation:this.state?.generation ?? 0, eventId:randomUUID(), actionId:'pause' });
      this.emit('clock-uncertain',this.clock.uncertainty);
      if (attempt===1) {this.fail('Clock uncertainty exceeds 10 ms after resynchronization');throw new Error('Clock uncertainty exceeds 10 ms after resynchronization');}
    }
    this.emit('clock-ready',true);
    } finally { this.synchronizing = false; }
  }
  submit(sample: TrackingSample, mapped: {x:number;y:number} | null, mainCaptureTimestamp: number): void {
    if (this.failed || this.synchronizing || this.configurationRequests > 0 || this.clock.uncertainty > 10 || performance.now() - this.clock.synchronizedAt > 30_000) return;
    try {
      this.sample = { generation: sample.generation, frameId: sample.frameId, captureTimestamp: this.clock.convert(mainCaptureTimestamp, performance.now()), valid: sample.valid, position: sample.valid ? mapped : null };
      void this.drainSamples();
    } catch (error) { this.fail(String(error)); }
  }
  private async drainSamples(): Promise<void> {
    if (this.sampling) return; this.sampling = true;
    try { while (this.sample && this.configurationRequests === 0 && !this.synchronizing) { const latest = this.sample; this.sample = null; const sentTimestamp=performance.now(); const ack=await this.request('sample', latest); this.emit('sample-timing',{generation:latest.generation,frameId:latest.frameId,nativeCaptureTimestamp:latest.captureTimestamp,nativeActionTimestamp:ack.nativeTimestamp,sentTimestamp,receivedTimestamp:performance.now(),state:ack.state.state,posted:ack.code==='move-posted'}); } }
    catch (error) { this.fail(String(error)); }
    finally { this.sampling = false; }
  }
  private fail(message: string): void {
    if (this.failed) return; this.failed = true;
    this.sample = null; this.clock.uncertainty = Infinity;
    if (this.refresh) clearInterval(this.refresh);
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error(message)); } this.pending.clear();
    this.child?.stdin.end();
    this.emergencyRelease();
    this.emit('fault', message);
  }
  emergencyRelease(): void { spawnSync(this.executable, ['--release-and-exit', ...(this.realInput ? ['--real-input'] : this.testFakeBackend ? ['--test-fake-backend'] : [])], { timeout: 1000, stdio: 'ignore' }); }
  async stop(): Promise<void> {
    this.stopping = true; if (this.refresh) clearInterval(this.refresh);
    try { if (this.child) await this.request('shutdown', {}); } catch { /* Release always runs. */ }
    this.emergencyRelease(); this.child?.stdin.end();
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Helper stopped')); } this.pending.clear();
  }
}
