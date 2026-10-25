import { defaultVoiceConfig, type VoiceConfig } from '../../src/main/voice/config';
import { VoiceStateMachine } from '../../src/main/voice/machine';
import { createContext, type TimerName, type VoiceAction, type VoiceContext, type VoiceEvent } from '../../src/main/voice/types';

type Distribute<T> = T extends unknown ? Omit<T, 'sessionId'> : never;
type SttEventInput = Distribute<Extract<VoiceEvent, { sessionId: number }>>;

/** Fake-clock driver: fires due timers in deadline order, mirrors VAD state like the runtime does. */
export class Harness {
  readonly config: VoiceConfig;
  readonly machine: VoiceStateMachine;
  readonly ctx: VoiceContext;
  now = 0;
  actions: VoiceAction[] = [];
  /** Actions of the most recent `send`/`advance`. */
  last: VoiceAction[] = [];
  constructor(options: { abortSupported?: boolean; config?: (config: VoiceConfig) => void; sttDisabled?: boolean } = {}) {
    this.config = defaultVoiceConfig();
    options.config?.(this.config);
    this.machine = new VoiceStateMachine(this.config);
    this.ctx = createContext({ abortSupported: options.abortSupported ?? true, sttDisabled: options.sttDisabled });
  }
  get state() { return this.ctx.state; }
  send(event: VoiceEvent): VoiceAction[] {
    const out = this.machine.handle(event, this.ctx, this.now);
    this.actions.push(...out); this.last = out;
    return out;
  }
  /** Sends an Stt* event for the current session (the runtime's session filter). */
  stt(event: SttEventInput): VoiceAction[] {
    return this.send({ ...event, sessionId: this.ctx.sessionId ?? -1 } as VoiceEvent);
  }
  vad(active: boolean, raw = active): void { this.ctx.vadActive = active; this.ctx.vadRawActive = raw; }
  /** Advance the fake clock to `to` seconds, firing every timer that comes due. */
  advance(to: number): VoiceAction[] {
    const fired: VoiceAction[] = [];
    for (;;) {
      const due = [...this.ctx.timers.entries()].filter(([, timer]) => timer.deadline <= to + 1e-9).sort((a, b) => a[1].deadline - b[1].deadline)[0];
      if (!due) break;
      const [name, timer] = due;
      this.now = Math.max(this.now, timer.deadline);
      fired.push(...this.send({ type: 'TimerFired', name, stamp: timer.stamp, seq: timer.seq }));
    }
    this.now = to; this.last = fired;
    return fired;
  }
  types(actions = this.last): string[] { return actions.map(action => action.type); }
  has(type: VoiceAction['type'], actions = this.last): boolean { return actions.some(action => action.type === type); }
  find<T extends VoiceAction['type']>(type: T, actions = this.actions): Extract<VoiceAction, { type: T }>[] {
    return actions.filter(action => action.type === type) as Extract<VoiceAction, { type: T }>[];
  }
  timer(name: TimerName) { return this.ctx.timers.get(name); }
  toasts(actions = this.actions): string[] { return this.find('Toast', actions).map(toast => toast.message); }
  dispatched(): string[] { return this.find('Dispatch').map(action => action.command.text); }
  /** Cloud gate as the Forwarder would see it after all actions so far. */
  gate(): boolean {
    let on = false;
    for (const action of this.actions) if (action.type === 'SetCloudGate') on = action.on;
    return on;
  }
}
