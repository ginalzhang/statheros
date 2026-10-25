import WebSocket from 'ws';
import { CARTESIA_VERSION, effectiveKeyterms, type VoiceConfig } from './config';
import { AutoTranscriptBuilder, ManualTranscriptBuilder, type SttSignal } from './transcripts';
import type { Endpoint } from './types';

/** What the runtime receives from a session; every signal belongs to `sessionId`. */
export type SessionSignal = SttSignal | { type: 'SttConnected' } | { type: 'SttClosed' };

export interface SocketLike {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string | Buffer): void;
  close(code?: number): void;
  terminate(): void;
  on(event: 'open', listener: () => void): this;
  on(event: 'message', listener: (data: WebSocket.RawData, isBinary: boolean) => void): this;
  on(event: 'close', listener: () => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'unexpected-response', listener: (request: unknown, response: { statusCode?: number }) => void): this;
}
export type SocketFactory = (url: string, headers: Record<string, string>) => SocketLike;

export const defaultSocketFactory: SocketFactory = (url, headers) => new WebSocket(url, { headers, handshakeTimeout: 3000 }) as unknown as SocketLike;

const ORIGIN = 'wss://api.cartesia.ai';
const PATHS: Record<Endpoint, string> = { auto: '/stt/turns/websocket', manual: '/stt/websocket' };
/** At most two seconds of audio may wait in the socket's write queue. */
export const MAX_BUFFERED_AUDIO_BYTES = 16000 * 2 * 2;

/** Query string per Appendix A.1. The version is a query parameter on raw WebSockets. */
export function sttUrl(kind: Endpoint, config: VoiceConfig, origin?: string): string {
  const url = new URL(PATHS[kind], origin ?? ORIGIN);
  if (url.protocol !== 'wss:' && !(origin && url.hostname === '127.0.0.1')) throw new Error('Refusing a non-TLS Cartesia URL'); // loopback only for tests
  url.searchParams.set('model', config.stt.model);
  url.searchParams.set('encoding', 'pcm_s16le');
  url.searchParams.set('sample_rate', String(config.stt.sampleRate));
  url.searchParams.set('cartesia_version', CARTESIA_VERSION);
  // keyterm: ink-2 only, ≤100 terms / ≤1200 chars, fixed for the connection (use-the-api/stt/keyterms).
  let budget = 1200;
  for (const term of effectiveKeyterms(config).slice(0, 100)) { if ((budget -= term.length) < 0) break; url.searchParams.append('keyterm', term); }
  if (kind === 'auto') {
    const t = config.stt.turn;
    url.searchParams.set('turn_start_threshold', String(t.startThreshold));
    url.searchParams.set('turn_eager_end_threshold', String(t.eagerEndThreshold));
    url.searchParams.set('turn_end_threshold', String(t.endThreshold));
    url.searchParams.set('turn_end_timeout_ms', String(t.endTimeoutMs));
  }
  return url.toString();
}

/**
 * One Cartesia STT WebSocket per utterance. open() performs connect retries internally and ends in
 * exactly one SttConnected or SttError (4xx is never retried; 401/403 are permanent).
 */
export class SttSession {
  private socket: SocketLike | null = null;
  private readonly builder: AutoTranscriptBuilder | ManualTranscriptBuilder;
  private finished = false;
  private connected = false;
  private closeTimer: ReturnType<typeof setTimeout> | undefined;
  private cancelConnect: (() => void) | null = null;

  constructor(
    readonly sessionId: number, readonly kind: Endpoint, private readonly config: VoiceConfig, private readonly apiKey: string,
    private readonly emit: (signal: SessionSignal) => void,
    private readonly options: { factory?: SocketFactory; baseUrl?: string; now?: () => number } = {},
  ) {
    this.builder = kind === 'auto' ? new AutoTranscriptBuilder() : new ManualTranscriptBuilder();
  }

  get isOpen(): boolean { return !this.finished && this.connected && this.socket?.readyState === WebSocket.OPEN; }

  async open(): Promise<void> {
    if (this.finished) return;
    const now = this.options.now ?? (() => performance.now() / 1000);
    const deadline = now() + this.config.stt.connectTimeoutS;
    for (let attempt = 1; attempt <= this.config.stt.connectAttempts; attempt++) {
      const started = now();
      const budget = Math.min(attempt === 1 ? 3.0 : Infinity, deadline - started);
      if (budget <= 0) break;
      const result = await this.connectOnce(budget);
      if (this.finished) return;
      if (result.ok) { this.connected = true; this.emit({ type: 'SttConnected' }); return; }
      const status = result.status;
      if (status !== null && status >= 400 && status < 500) {
        // 4xx on connect is permanent for that request: never retried.
        return this.fail(status, result.message, status === 401 || status === 403);
      }
      const fast = now() - started < 1;
      if (!fast || attempt === this.config.stt.connectAttempts) return this.fail(status ?? 'connect', result.message, false);
    }
    this.fail('timeout', 'Connect timed out', false);
  }

  private connectOnce(seconds: number): Promise<{ ok: true } | { ok: false; status: number | null; message: string }> {
    return new Promise(resolve => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = (value: { ok: true } | { ok: false; status: number | null; message: string }): void => { if (!settled) { settled = true; clearTimeout(timer); this.cancelConnect = null; resolve(value); } };
      let socket: SocketLike;
      try { socket = (this.options.factory ?? defaultSocketFactory)(sttUrl(this.kind, this.config, this.options.baseUrl), { 'X-API-Key': this.apiKey }); }
      catch (error) { done({ ok: false, status: null, message: String(error) }); return; }
      this.socket = socket;
      this.cancelConnect = () => done({ ok: false, status: null, message: 'Connection aborted' });
      timer = setTimeout(() => { socket.terminate(); done({ ok: false, status: null, message: 'Connect timed out' }); }, seconds * 1000);
      socket.on('unexpected-response', (_request, response) => { done({ ok: false, status: response.statusCode ?? null, message: `HTTP ${response.statusCode}` }); socket.terminate(); });
      socket.on('open', () => done({ ok: true }));
      socket.on('error', error => done({ ok: false, status: null, message: error.message }));
      socket.on('message', (data, isBinary) => { if (!isBinary && socket === this.socket) this.onMessage(data.toString()); });
      socket.on('close', () => {
        done({ ok: false, status: null, message: 'Closed during connect' });
        if (socket === this.socket && this.connected) this.onClosed();
      });
    });
  }

  private onMessage(raw: string): void {
    let message: unknown;
    try { message = JSON.parse(raw); } catch { this.emit({ type: 'Log', fields: { unparsable: raw.slice(0, 80) } }); return; }
    if (!message || typeof message !== 'object') return;
    for (const signal of this.builder.accept(message as Record<string, unknown>)) this.emit(signal);
  }
  private onClosed(): void {
    if (this.finished) return;
    for (const signal of this.builder.closed()) this.emit(signal);
    this.finished = true; clearTimeout(this.closeTimer);
    this.emit({ type: 'SttClosed' });
  }
  private fail(code: number | string, message: string, permanent: boolean): void {
    if (this.finished) return;
    this.finished = true;
    this.socket?.terminate();
    this.emit({ type: 'SttError', code, message, permanent });
  }

  /** Binary write; the Forwarder is the only caller and has already checked the cloud gate. */
  sendAudio(pcm: Buffer): boolean {
    if (!this.isOpen) return false;
    if (this.socket!.bufferedAmount + pcm.length > MAX_BUFFERED_AUDIO_BYTES) {
      this.fail('backpressure', 'Connection is too slow for live audio. Please try again.', false);
      return false;
    }
    try { this.socket!.send(pcm); }
    catch { this.fail('send', 'Audio connection closed. Please try again.', false); return false; }
    return true;
  }
  /** Manual: bare text frame. Auto has no finalize primitive. */
  finalize(): void {
    if (!this.isOpen) return;
    if (this.kind === 'manual') { (this.builder as ManualTranscriptBuilder).finalizeSent(); this.socket!.send('finalize'); }
    else this.emit({ type: 'Log', fields: { finalize: 'ignored on Auto' } });
  }
  /** Close flushes buffered audio; the socket is awaited ≤2 s in the background, then terminated. */
  close(): void {
    if (!this.isOpen) { this.abort(); return; }
    if (this.kind === 'manual') { (this.builder as ManualTranscriptBuilder).finalizeSent(); this.socket!.send('close'); }
    else this.socket!.send(JSON.stringify({ type: 'close' }));
    clearTimeout(this.closeTimer);
    this.closeTimer = setTimeout(() => this.abort(), 2000);
  }
  abort(): void {
    clearTimeout(this.closeTimer);
    const socket = this.socket;
    this.finished = true; this.socket = null;
    this.cancelConnect?.();
    try { socket?.terminate(); } catch { /* already gone */ }
  }
}
