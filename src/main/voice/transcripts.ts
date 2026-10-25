/**
 * Cartesia message → SttEvent translation (Appendix A.4). One builder per session.
 * Auto transcripts are cumulative (replace); Manual deltas concatenate verbatim, final ones only.
 */
export type SttSignal =
  | { type: 'SttSpeechStart' }
  | { type: 'SttPartial'; text: string; eager: boolean }
  | { type: 'SttTurnResume' }
  | { type: 'SttFinal'; text: string }
  | { type: 'SttFinalizeRejected' }
  | { type: 'SttError'; code: number | string; message: string; permanent: boolean }
  | { type: 'Log'; fields: Record<string, unknown> };

type Message = Record<string, unknown>;
const text = (value: unknown): string => typeof value === 'string' ? value : '';

function errorSignal(message: Message): SttSignal {
  const status = typeof message.status_code === 'number' ? message.status_code : null;
  const code = status ?? (text(message.error_code) || 'error');
  const detail = text(message.message) || text(message.title) || 'Cartesia error';
  return { type: 'SttError', code, message: `${detail}${message.error_code ? ` (${text(message.error_code)})` : ''}`, permanent: status === 401 || status === 403 };
}

export class AutoTranscriptBuilder {
  /** Auto `connected` is log-only: SttConnected comes from the handshake. */
  accept(message: Message): SttSignal[] {
    switch (message.type) {
      case 'connected': return [{ type: 'Log', fields: { connected: message.request_id ?? null } }];
      case 'turn.start': return [{ type: 'SttSpeechStart' }];
      case 'turn.update': return [{ type: 'SttPartial', text: text(message.transcript), eager: false }];
      case 'turn.eager_end': return [{ type: 'SttPartial', text: text(message.transcript), eager: true }];
      case 'turn.resume': return [{ type: 'SttTurnResume' }];
      case 'turn.end': return [{ type: 'SttFinal', text: text(message.transcript) }];
      case 'error': return [errorSignal(message)];
      default: return [{ type: 'Log', fields: { unknown: message.type ?? null } }];
    }
  }
  /** Socket closed: nothing buffered client-side. */
  closed(): SttSignal[] { return []; }
}

const FINALIZE_WHILE_SPEAKING = /finaliz|speaking|in progress|still/i;

export class ManualTranscriptBuilder {
  private finals = '';
  private interim = '';
  private awaitingFlush = false;
  private emittedSinceFinalize = false;
  /** Called when we send `finalize` (or `close`). */
  finalizeSent(): void { this.awaitingFlush = true; this.emittedSinceFinalize = false; }
  accept(message: Message): SttSignal[] {
    switch (message.type) {
      case 'transcript': {
        const delta = text(message.text);
        if (message.is_final === true) { this.finals += delta; this.interim = ''; } // verbatim: no trimming, no inserted spaces
        else this.interim = delta;
        return [{ type: 'SttPartial', text: this.finals + this.interim, eager: false }];
      }
      case 'flush_done': case 'done': return this.emitFinal(message.type);
      case 'error': {
        const detail = `${text(message.message)} ${text(message.error_code)} ${text(message.title)}`;
        const status = typeof message.status_code === 'number' ? message.status_code : null;
        if (this.awaitingFlush && status !== 401 && status !== 403 && FINALIZE_WHILE_SPEAKING.test(detail)) { this.awaitingFlush = false; return [{ type: 'SttFinalizeRejected' }]; }
        return [errorSignal(message)];
      }
      default: return [{ type: 'Log', fields: { unknown: message.type ?? null } }];
    }
  }
  /** If flush_done never arrives, the close emits the single Final. */
  closed(): SttSignal[] { return this.awaitingFlush ? this.emitFinal('closed') : []; }
  private emitFinal(reason: string): SttSignal[] {
    if (!this.awaitingFlush || this.emittedSinceFinalize) return [{ type: 'Log', fields: { [reason]: 'no pending finalize' } }];
    const final = this.finals;
    // Reset so the next finalize yields only new text.
    this.finals = ''; this.interim = ''; this.awaitingFlush = false; this.emittedSinceFinalize = true;
    return [{ type: 'SttFinal', text: final }];
  }
}
