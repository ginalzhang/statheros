import { describe, expect, it } from 'vitest';
import { Harness } from './harness';

/** Wake + connect at t=0 / t=0.26 with the user still speaking (one breath). */
function wakeAndConnect(h: Harness, speaking = true): void {
  h.vad(speaking);
  h.send({ type: 'WakeDetected', phrase: 'hey cartesia', ts: h.now, score: null });
  h.advance(h.now + 0.26);
  h.stt({ type: 'SttConnected' });
}

describe('§5.4 happy path (Auto, one breath, eager off)', () => {
  it('follows the trace exactly', () => {
    const h = new Harness();
    h.vad(true);
    h.send({ type: 'WakeDetected', phrase: 'hey cartesia', ts: 0, score: null });
    expect(h.types()).toEqual(['PlayEarcon', 'ShowState', 'OpenStt', 'SetTimer', 'SetTimer', 'Log']);
    expect(h.find('OpenStt')[0]).toMatchObject({ kind: 'auto', sessionId: 1 });
    expect(h.ctx.gen).toBe(1);
    expect(h.timer('watchdog')?.deadline).toBe(75);
    expect(h.timer('connect')?.deadline).toBe(5);
    expect(h.gate()).toBe(false); // WAKING is cloud-silent

    h.now = 0.26; h.stt({ type: 'SttConnected' });
    expect(h.state).toBe('LISTENING');
    expect(h.find('StartForwarding', h.last)[0]?.fromTs).toBeCloseTo(-1.5);
    expect(h.gate()).toBe(true);
    expect(h.timer('max_utterance')?.deadline).toBeCloseTo(15.26);
    expect(h.timer('no_speech')).toBeUndefined(); // vad_active → not armed
    expect(h.timer('connect')).toBeUndefined();

    h.now = 0.5; h.stt({ type: 'SttSpeechStart' });
    expect(h.timer('no_speech')).toBeUndefined();
    h.now = 0.9; h.stt({ type: 'SttPartial', text: 'sia open', eager: false });
    expect(h.find('ShowTranscript', h.last)[0]).toMatchObject({ text: 'open', final: false });
    h.now = 1.3; h.vad(false); h.send({ type: 'VadSpeechEnd', ts: 1.3, speechMs: 1600 });
    expect(h.timer('stt_final')?.deadline).toBeCloseTo(3.2);
    h.now = 1.8; h.stt({ type: 'SttFinal', text: 'sia open chrome' });
    expect(h.timer('stt_final')).toBeUndefined();
    expect(h.dispatched()).toEqual(['open chrome']);
    expect(h.state).toBe('EXECUTING');
    expect(h.has('SendClose')).toBe(true);
    expect(h.gate()).toBe(false);
    expect(h.timer('watchdog')).toBeUndefined();
    expect(h.timer('command')).toMatchObject({ stamp: 1, deadline: 31.8 });
    expect(h.find('ShowTranscript', h.last).at(-1)).toMatchObject({ text: 'open chrome', final: true });

    h.now = 2.15; h.send({ type: 'CommandDone', cmdId: 1, resultText: 'Opened Chrome' });
    expect(h.state).toBe('FEEDBACK');
    expect(h.toasts(h.last)).toEqual(['Opened Chrome']);
    expect(h.timer('executing_spinner')).toBeUndefined();
    h.advance(2.85);
    expect(h.state).toBe('PASSIVE');
    expect(h.ctx.gen).toBe(2);
  });

  it('shows "working…" only after the spinner delay', () => {
    const h = new Harness();
    wakeAndConnect(h); h.vad(false);
    h.stt({ type: 'SttFinal', text: 'pen down' });
    expect(h.has('ShowWorking')).toBe(false);
    h.advance(h.now + 0.41);
    expect(h.has('ShowWorking')).toBe(true);
  });
});

describe('§5.5 trace A — turn.end never arrives', () => {
  function setup(): Harness {
    const h = new Harness();
    wakeAndConnect(h);
    h.stt({ type: 'SttPartial', text: 'open chro', eager: false });
    h.now = 1.3; h.vad(false); h.send({ type: 'VadSpeechEnd', ts: 1.3, speechMs: 1000 });
    h.advance(3.2);
    return h;
  }
  it('forced end then a late Final dispatches with high confidence', () => {
    const h = setup();
    expect(h.state).toBe('PROCESSING');
    expect(h.ctx.closeSent).toBe(true);
    expect(h.gate()).toBe(false);
    h.now = 3.5; h.stt({ type: 'SttFinal', text: 'open chrome' });
    expect(h.dispatched()).toEqual(['open chrome']);
    expect(h.find('Dispatch')[0]?.command.confidence).toBe('high');
  });
  it('forced_end with only a partial: ptt_only drops the wake result with a statement toast', () => {
    const h = setup();
    h.advance(4.2);
    expect(h.dispatched()).toEqual([]);
    expect(h.toasts()).toContain("Heard 'open chro' — try again with 'hey cartesia'");
    expect(h.state).toBe('PASSIVE');
  });
  it('dispatch_low_confidence=always dispatches the partial', () => {
    const h = new Harness({ config: c => { c.dispatchLowConfidence = 'always'; } });
    wakeAndConnect(h);
    h.stt({ type: 'SttPartial', text: 'open chro', eager: false });
    h.vad(false); h.send({ type: 'VadSpeechEnd', ts: h.now, speechMs: 1000 });
    h.advance(h.now + 3);
    expect(h.find('Dispatch')[0]?.command).toMatchObject({ text: 'open chro', confidence: 'low' });
  });
});

describe('§5.5 trace B — pause after the wake phrase', () => {
  it('text-less pause keeps listening, then the command dispatches', () => {
    const h = new Harness();
    wakeAndConnect(h);
    h.now = 0.8; h.vad(false); h.send({ type: 'VadSpeechEnd', ts: 0.8, speechMs: 900 });
    expect(h.ctx.remnantTurns).toBe(1);
    expect(h.ctx.speechMs).toBeNull();
    expect(h.timer('no_speech')?.deadline).toBeCloseTo(6.8);
    expect(h.timer('stt_final')).toBeUndefined();
    expect(h.timer('max_utterance')?.deadline).toBeCloseTo(15.26);
    h.now = 1.1; h.stt({ type: 'SttSpeechStart' });
    expect(h.timer('no_speech')?.deadline).toBeCloseTo(7.1); // re-armed, not cancelled
    // Late server Final for the remnant → (b) re-entry on the same socket.
    h.now = 2.3; h.stt({ type: 'SttFinal', text: 'sia' });
    expect(h.state).toBe('LISTENING');
    expect(h.dispatched()).toEqual([]);
    expect(h.ctx.remnantTurns).toBe(1); // already counted
    expect(h.timer('max_utterance')?.deadline).toBeCloseTo(15.26);
    expect(h.gate()).toBe(true);
    h.now = 3.1; h.vad(true); h.send({ type: 'VadSpeechStart', ts: 3.1 });
    expect(h.timer('no_speech')).toBeUndefined();
    h.stt({ type: 'SttPartial', text: 'open chrome', eager: false });
    h.now = 4; h.vad(false); h.send({ type: 'VadSpeechEnd', ts: 4, speechMs: 700 });
    expect(h.timer('stt_final')).toBeDefined();
    h.now = 4.6; h.stt({ type: 'SttFinal', text: 'open chrome' });
    expect(h.dispatched()).toEqual(['open chrome']);
  });
  it('lagging partial arms stt_final (lag-corrective arm)', () => {
    const h = new Harness();
    wakeAndConnect(h);
    h.vad(false); h.send({ type: 'VadSpeechEnd', ts: h.now, speechMs: 900 });
    expect(h.timer('no_speech')).toBeDefined();
    h.stt({ type: 'SttPartial', text: 'open chrome', eager: false });
    expect(h.timer('no_speech')).toBeUndefined();
    expect(h.timer('stt_final')).toBeDefined();
  });
  it('coughs never end the utterance; the original max_utterance deadline bounds it', () => {
    const h = new Harness();
    wakeAndConnect(h);
    for (let t = 1; t < 15; t += 2) {
      h.now = t; h.vad(true); h.send({ type: 'VadSpeechStart', ts: t });
      h.now = t + 0.5; h.vad(false); h.send({ type: 'VadSpeechEnd', ts: t + 0.5, speechMs: 300 });
      expect(h.state).toBe('LISTENING');
    }
    h.vad(true); // applause keeps the VAD active so no_speech never fires
    h.send({ type: 'VadSpeechStart', ts: 15 });
    h.advance(15.3);
    expect(h.state).toBe('PROCESSING'); // max_utterance forced end at 15.26
    h.advance(16.4);
    expect(h.state).toBe('PASSIVE');
    expect(h.dispatched()).toEqual([]);
  });
  it('no speech after the wake: silent PASSIVE after no_speech, socket closed', () => {
    const h = new Harness();
    wakeAndConnect(h, false);
    h.advance(10);
    expect(h.state).toBe('PASSIVE');
    expect(h.find('SendClose').length).toBe(1);
    expect(h.toasts()).toEqual([]);
    expect(h.gate()).toBe(false);
  });
});

describe('§5.5 trace C — hold-to-talk (Manual)', () => {
  it('release after speech ends sends finalize, then dispatches', () => {
    const h = new Harness();
    h.send({ type: 'HotkeyDown', ts: 0 });
    expect(h.state).toBe('PTT_ACTIVE');
    expect(h.find('OpenStt')[0]?.kind).toBe('manual');
    expect(h.gate()).toBe(true); // frames queue in RAM until connected
    expect(h.find('PlayEarcon')).toEqual([]); // hold is walkie-talkie
    expect(h.timer('ptt_no_speech')?.deadline).toBe(8);
    expect(h.timer('max_utterance')?.deadline).toBe(60);
    h.now = 0.22; h.stt({ type: 'SttConnected' });
    expect(h.timer('connect')).toBeUndefined();
    h.now = 0.4; h.vad(true); h.send({ type: 'VadSpeechStart', ts: 0.4 });
    expect(h.timer('ptt_no_speech')).toBeUndefined();
    h.now = 2.1; h.vad(false); h.send({ type: 'VadSpeechEnd', ts: 2.1, speechMs: 1100 });
    expect(h.timer('hold_silence')?.deadline).toBeCloseTo(8.1);
    h.now = 2.3; h.send({ type: 'HotkeyUp', ts: 2.3 });
    expect(h.timer('hold_silence')).toBeUndefined();
    expect(h.timer('release_grace')?.deadline).toBeCloseTo(2.5);
    h.advance(2.5);
    expect(h.has('SendFinalize')).toBe(true);
    expect(h.state).toBe('PTT_ACTIVE');
    h.now = 2.85; h.stt({ type: 'SttFinal', text: 'scroll down' });
    expect(h.dispatched()).toEqual(['scroll down']);
    expect(h.state).toBe('EXECUTING');
  });
  it('release while still speaking defers finalize to VadSpeechEnd', () => {
    const h = new Harness();
    h.send({ type: 'HotkeyDown', ts: 0 }); h.stt({ type: 'SttConnected' });
    h.now = 0.4; h.vad(true); h.send({ type: 'VadSpeechStart', ts: 0.4 });
    h.now = 2; h.send({ type: 'HotkeyUp', ts: 2 });
    h.advance(2.4);
    expect(h.ctx.releaseDeferred).toBe(true);
    expect(h.timer('release_cap')).toBeDefined();
    expect(h.find('SendFinalize')).toEqual([]);
    h.now = 3; h.vad(false); h.send({ type: 'VadSpeechEnd', ts: 3, speechMs: 2500 });
    expect(h.find('SendFinalize').length).toBe(1);
    expect(h.timer('release_cap')).toBeUndefined();
  });
  it('lost HotkeyUp: hold_silence ends the utterance', () => {
    const h = new Harness();
    h.send({ type: 'HotkeyDown', ts: 0 }); h.stt({ type: 'SttConnected' });
    h.vad(true); h.send({ type: 'VadSpeechStart', ts: 0.2 });
    h.now = 1; h.vad(false); h.send({ type: 'VadSpeechEnd', ts: 1, speechMs: 600 });
    h.advance(7.1);
    expect(h.find('SendFinalize').length).toBe(1);
  });
  it('a short tap switches to toggle with the wake earcon', () => {
    const h = new Harness();
    h.send({ type: 'HotkeyDown', ts: 0 });
    h.now = 0.1; h.send({ type: 'HotkeyUp', ts: 0.1 });
    expect(h.ctx.pttMode).toBe('toggle');
    expect(h.find('PlayEarcon', h.last)[0]?.name).toBe('wake');
    expect(h.timer('ptt_no_speech')).toBeDefined();
  });
  it('PTT with no speech says "Didn\'t catch that" after 8 s and closes', () => {
    const h = new Harness();
    h.send({ type: 'HotkeyToggle' });
    h.stt({ type: 'SttConnected' });
    h.advance(8.1);
    expect(h.toasts()).toContain("Didn't catch that");
    expect(h.state).toBe('PASSIVE');
    expect(h.has('AbortStt')).toBe(true);
    expect(h.gate()).toBe(false);
  });
  it('toggle: second press is a soft end; the following HotkeyUp is ignored', () => {
    const h = new Harness();
    h.send({ type: 'HotkeyToggle' }); h.stt({ type: 'SttConnected' });
    expect(h.find('PlayEarcon')[0]?.name).toBe('wake');
    h.stt({ type: 'SttPartial', text: 'undo', eager: false });
    h.send({ type: 'HotkeyToggle' });
    expect(h.find('SendFinalize').length).toBe(1);
    h.send({ type: 'HotkeyToggle' }); // pending soft end → no-op
    expect(h.find('SendFinalize').length).toBe(1);
    h.stt({ type: 'SttFinal', text: 'undo' });
    expect(h.dispatched()).toEqual(['undo']);
  });
  it('quiet speaker: a partial without a VAD start cancels ptt_no_speech and arms ptt_auto_end (toggle)', () => {
    const h = new Harness();
    h.send({ type: 'HotkeyToggle' }); h.stt({ type: 'SttConnected' });
    h.stt({ type: 'SttPartial', text: 'undo', eager: false });
    expect(h.timer('ptt_no_speech')).toBeUndefined();
    expect(h.timer('ptt_auto_end')).toBeDefined();
    h.advance(h.now + 0.5);
    expect(h.find('SendFinalize').length).toBe(1);
  });
  it('forced_end in PTT dispatches the last partial at low confidence', () => {
    const h = new Harness();
    h.send({ type: 'HotkeyToggle' }); h.stt({ type: 'SttConnected' });
    h.stt({ type: 'SttPartial', text: 'pen down', eager: false });
    h.send({ type: 'HotkeyToggle' });
    h.advance(h.now + 1.1);
    expect(h.find('Dispatch')[0]?.command).toMatchObject({ text: 'pen down', confidence: 'low', source: 'ptt' });
  });
  it('a soft end before SttConnected restarts the forced_end countdown at connect', () => {
    const h = new Harness();
    h.send({ type: 'HotkeyToggle' });
    h.now = 0.1; h.send({ type: 'HotkeyToggle' });
    h.now = 0.9; h.stt({ type: 'SttConnected' });
    expect(h.timer('forced_end')?.deadline).toBeCloseTo(1.9);
  });
  it('the connect backstop does not trip a long PTT utterance', () => {
    const h = new Harness();
    h.send({ type: 'HotkeyToggle' }); h.now = 0.3; h.stt({ type: 'SttConnected' });
    h.vad(true); h.send({ type: 'VadSpeechStart', ts: 0.3 });
    h.advance(7);
    expect(h.state).toBe('PTT_ACTIVE');
  });
  it('SttFinalizeRejected cancels forced_end and re-sends after VadSpeechEnd', () => {
    const h = new Harness();
    h.send({ type: 'HotkeyToggle' }); h.stt({ type: 'SttConnected' });
    h.vad(true); h.send({ type: 'VadSpeechStart', ts: 0 });
    h.send({ type: 'HotkeyToggle' });
    h.stt({ type: 'SttFinalizeRejected' });
    expect(h.timer('forced_end')).toBeUndefined();
    expect(h.timer('release_cap')).toBeDefined();
    h.vad(false); h.send({ type: 'VadSpeechEnd', ts: 1, speechMs: 900 });
    expect(h.find('SendFinalize').length).toBe(2);
  });
});

describe('§5.5 trace D — abort tap during a long command', () => {
  function executing(abortSupported: boolean): Harness {
    const h = new Harness({ abortSupported });
    h.send({ type: 'HotkeyToggle' }); h.stt({ type: 'SttConnected' });
    h.stt({ type: 'SttFinal', text: 'open chrome' });
    expect(h.state).toBe('EXECUTING');
    return h;
  }
  it('with a hook: tap aborts with the cancel earcon; the late CommandFailed is log-only', () => {
    const h = executing(true);
    h.send({ type: 'HotkeyDown', ts: h.now });
    expect(h.timer('tap_decide')).toBeDefined();
    h.now += 0.12; h.send({ type: 'HotkeyUp', ts: h.now });
    expect(h.find('AbortCommand')[0]).toMatchObject({ cmdId: 1, spokenText: null });
    expect(h.find('PlayEarcon', h.last)[0]?.name).toBe('cancel');
    expect(h.state).toBe('PASSIVE');
    h.send({ type: 'CommandFailed', cmdId: 1, message: 'aborted' });
    expect(h.types()).toEqual(['Log']);
  });
  it('without a hook: honest toast, stays EXECUTING, no earcon, no phantom PTT', () => {
    const h = executing(false);
    h.send({ type: 'HotkeyDown', ts: h.now });
    h.now += 0.12; h.send({ type: 'HotkeyUp', ts: h.now });
    expect(h.toasts(h.last)).toEqual(["Can't stop that one"]);
    expect(h.find('PlayEarcon', h.last)).toEqual([]);
    expect(h.state).toBe('EXECUTING');
    h.advance(h.now + 1);
    expect(h.state).toBe('EXECUTING'); // tap_decide cancelled
    h.send({ type: 'CommandDone', cmdId: 1, resultText: 'Opened' });
    expect(h.state).toBe('FEEDBACK');
  });
  it('hold past tap_max starts a PTT barge-in from the key-down; "stop" aborts', () => {
    const h = executing(true);
    const down = h.now;
    h.send({ type: 'HotkeyDown', ts: down });
    h.advance(down + 0.25);
    expect(h.state).toBe('PTT_ACTIVE');
    expect(h.ctx.bargeIn).toBe(true);
    expect(h.find('StartForwarding', h.last)[0]?.fromTs).toBe(down);
    h.stt({ type: 'SttConnected' });
    h.stt({ type: 'SttFinal', text: 'stop' });
    expect(h.find('AbortCommand')[0]).toMatchObject({ cmdId: 1, spokenText: 'stop' });
    expect(h.state).toBe('PASSIVE');
  });
  it('barge-in non-interrupt with no hook queues behind and dispatches', () => {
    const h = executing(false);
    h.send({ type: 'HotkeyDown', ts: h.now }); h.advance(h.now + 0.25);
    h.stt({ type: 'SttConnected' });
    h.stt({ type: 'SttFinal', text: 'open slack' });
    expect(h.toasts()).toContain('Will run after the current command');
    expect(h.dispatched()).toEqual(['open chrome', 'open slack']);
    expect(h.ctx.inFlightCmd).toBe(2);
    h.send({ type: 'CommandDone', cmdId: 1, resultText: null });
    expect(h.state).toBe('EXECUTING'); // old cmd_id → log only
  });
});

describe('§5.3 interrupts', () => {
  for (const phrase of ['cancel', 'never mind', 'cancel that', 'cancel cancel', 'forget it.', 'Nevermind']) {
    it(`"${phrase}" is never dispatched`, () => {
      const h = new Harness();
      wakeAndConnect(h); h.vad(false);
      h.stt({ type: 'SttFinal', text: `hey cartesia ${phrase}` });
      expect(h.dispatched()).toEqual([]);
      expect(h.find('PlayEarcon').map(e => e.name)).toEqual(['wake', 'cancel']);
      expect(h.state).toBe('PASSIVE');
    });
  }
  it('"stop" with nothing in flight is a normal command', () => {
    const h = new Harness();
    wakeAndConnect(h); h.vad(false);
    h.stt({ type: 'SttFinal', text: 'stop' });
    expect(h.dispatched()).toEqual(['stop']);
  });
  it('wake during EXECUTING is a barge-in; "stop" reaches the hook via AbortCommand', () => {
    const h = new Harness();
    h.send({ type: 'HotkeyToggle' }); h.stt({ type: 'SttConnected' }); h.stt({ type: 'SttFinal', text: 'open chrome' });
    h.now = 5; wakeAndConnect(h, false);
    expect(h.ctx.bargeIn).toBe(true);
    h.stt({ type: 'SttFinal', text: 'stop' });
    expect(h.find('AbortCommand')[0]?.spokenText).toBe('stop');
    expect(h.dispatched()).toEqual(['open chrome']);
  });
  it('barge-in "stop" after the command finished is dropped', () => {
    const h = new Harness();
    h.send({ type: 'HotkeyToggle' }); h.stt({ type: 'SttConnected' }); h.stt({ type: 'SttFinal', text: 'open chrome' });
    h.now = 5; wakeAndConnect(h, false);
    h.send({ type: 'CommandDone', cmdId: 1, resultText: 'ok' });
    h.stt({ type: 'SttFinal', text: 'stop' });
    expect(h.dispatched()).toEqual(['open chrome']);
    expect(h.state).toBe('PASSIVE');
  });
  it('local "stop" keyword aborts an in-flight command with earcon and toast', () => {
    const h = new Harness();
    h.send({ type: 'HotkeyToggle' }); h.stt({ type: 'SttConnected' }); h.stt({ type: 'SttFinal', text: 'open chrome' });
    h.send({ type: 'WakeDetected', phrase: 'stop', ts: h.now, score: null });
    expect(h.find('AbortCommand')[0]?.spokenText).toBe('stop');
    expect(h.toasts(h.last)).toEqual(['stopped']);
    expect(h.state).toBe('PASSIVE');
  });
  it('local "stop" is ignored with nothing in flight', () => {
    const h = new Harness();
    h.send({ type: 'WakeDetected', phrase: 'stop', ts: 0, score: null });
    expect(h.types()).toEqual(['Log']);
  });
});

describe('wake rules', () => {
  it('a double fire within the refractory window yields one utterance', () => {
    const h = new Harness();
    h.send({ type: 'WakeDetected', phrase: 'hey cartesia', ts: 0, score: null });
    h.send({ type: 'Cancel', reason: 'esc' });
    h.now = 0.5; h.send({ type: 'WakeDetected', phrase: 'hey cartesia', ts: 0.5, score: null });
    expect(h.find('OpenStt').length).toBe(1);
    h.now = 1.5; h.send({ type: 'WakeDetected', phrase: 'hey cartesia', ts: 1.5, score: null });
    expect(h.find('OpenStt').length).toBe(2);
  });
  it('wake during LISTENING / PTT_ACTIVE is ignored', () => {
    const h = new Harness();
    wakeAndConnect(h);
    h.now = 3; h.send({ type: 'WakeDetected', phrase: 'hey cartesia', ts: 3, score: null });
    expect(h.find('OpenStt').length).toBe(1);
  });
  it('wake during PROCESSING aborts the old session and accepts the new wake', () => {
    const h = new Harness();
    wakeAndConnect(h);
    h.stt({ type: 'SttPartial', text: 'open', eager: false });
    h.vad(false); h.send({ type: 'VadSpeechEnd', ts: h.now, speechMs: 500 });
    h.advance(h.now + 2);
    expect(h.state).toBe('PROCESSING');
    h.now += 0.3; h.send({ type: 'WakeDetected', phrase: 'hey cartesia', ts: h.now, score: null });
    expect(h.has('AbortStt')).toBe(true);
    expect(h.state).toBe('WAKING');
    expect(h.find('PlayEarcon', h.last)[0]?.name).toBe('wake');
  });
  it('stt_disabled toasts instead of connecting', () => {
    const h = new Harness({ sttDisabled: true });
    h.send({ type: 'WakeDetected', phrase: 'hey cartesia', ts: 0, score: null });
    expect(h.has('OpenStt')).toBe(false);
    expect(h.toasts()).toEqual(['CARTESIA_API_KEY is missing']);
    h.send({ type: 'HotkeyToggle' });
    expect(h.has('OpenStt')).toBe(false);
  });
  it('a pending one-word prefix dispatches on prefix_timeout ("undo")', () => {
    const h = new Harness();
    wakeAndConnect(h);
    h.vad(false, true); // hangover done, but above threshold right now
    h.stt({ type: 'SttFinal', text: 'undo' });
    expect(h.ctx.pendingPrefix).toBe('undo');
    h.vad(false, false);
    h.advance(h.now + 1.01);
    expect(h.dispatched()).toEqual(['undo']);
  });
  it('a pending prefix joins the next Final', () => {
    const h = new Harness();
    wakeAndConnect(h);
    h.vad(true, true);
    h.stt({ type: 'SttFinal', text: 'pen' });
    h.stt({ type: 'SttPartial', text: 'down', eager: false });
    h.vad(false, false);
    h.stt({ type: 'SttFinal', text: 'down' });
    expect(h.dispatched()).toEqual(['pen down']);
  });
  it('eager commit fires after local speech end; the following turn.end is log-only', () => {
    const h = new Harness({ config: c => { c.stt.eagerCommit = true; } });
    wakeAndConnect(h);
    h.vad(false); h.send({ type: 'VadSpeechEnd', ts: h.now, speechMs: 900 });
    h.stt({ type: 'SttPartial', text: 'open chrome', eager: true });
    expect(h.timer('eager_commit')).toBeDefined();
    h.advance(h.now + 0.31);
    expect(h.dispatched()).toEqual(['open chrome']);
    h.stt({ type: 'SttFinal', text: 'open chrome' });
    expect(h.dispatched()).toEqual(['open chrome']);
  });
  it('turn.resume cancels the eager commit; a remnant-only eager partial never commits', () => {
    const h = new Harness({ config: c => { c.stt.eagerCommit = true; } });
    wakeAndConnect(h); h.vad(false);
    h.stt({ type: 'SttPartial', text: 'sia', eager: true });
    expect(h.timer('eager_commit')).toBeUndefined();
    h.stt({ type: 'SttPartial', text: 'open chrome', eager: true });
    h.stt({ type: 'SttTurnResume' });
    expect(h.timer('eager_commit')).toBeUndefined();
  });
  it('Electron toggle hand-off from WAKING forwards from the pre-roll without an earcon', () => {
    const h = new Harness();
    h.vad(false);
    h.send({ type: 'WakeDetected', phrase: 'hey cartesia', ts: 10, score: null });
    h.now = 11; h.send({ type: 'HotkeyToggle' });
    expect(h.state).toBe('PTT_ACTIVE');
    expect(h.find('StartForwarding', h.last)[0]?.fromTs).toBeCloseTo(8.5);
    expect(h.find('PlayEarcon', h.last)).toEqual([]);
    expect(h.timer('ptt_auto_end')).toBeDefined();
  });
  it('mic button during WAKING / LISTENING cancels', () => {
    const h = new Harness();
    wakeAndConnect(h);
    h.send({ type: 'ButtonPressed' });
    expect(h.state).toBe('PASSIVE');
    expect(h.has('AbortStt')).toBe(true);
  });
});

describe('errors, timers and invariants', () => {
  it('401/403 disables STT once; later wakes toast without connecting', () => {
    const h = new Harness();
    h.send({ type: 'HotkeyToggle' });
    h.stt({ type: 'SttError', code: 401, message: 'Unauthorized', permanent: true });
    expect(h.state).toBe('ERROR');
    expect(h.toasts()).toEqual(['Cartesia key rejected — check CARTESIA_API_KEY']);
    h.advance(h.now + 3.1);
    expect(h.state).toBe('PASSIVE');
    h.send({ type: 'HotkeyToggle' });
    expect(h.find('OpenStt').length).toBe(1);
  });
  it('429 on connect is not sticky', () => {
    const h = new Harness();
    h.send({ type: 'WakeDetected', phrase: 'hey cartesia', ts: 0, score: null });
    h.stt({ type: 'SttError', code: 429, message: 'busy', permanent: false });
    expect(h.toasts()).toContain('Cartesia busy (concurrency limit)');
    h.advance(4);
    h.now = 5; h.send({ type: 'WakeDetected', phrase: 'hey cartesia', ts: 5, score: null });
    expect(h.find('OpenStt').length).toBe(2);
  });
  it('mid-utterance drop → ERROR, no reconnect', () => {
    const h = new Harness();
    wakeAndConnect(h);
    h.stt({ type: 'SttClosed' });
    expect(h.state).toBe('ERROR');
    expect(h.toasts()).toContain('Lost connection, say that again');
    expect(h.find('OpenStt').length).toBe(1);
  });
  it('SttClosed in PROCESSING before a Final acts as forced_end', () => {
    const h = new Harness({ config: c => { c.dispatchLowConfidence = 'always'; } });
    wakeAndConnect(h);
    h.stt({ type: 'SttPartial', text: 'pen up', eager: false });
    h.vad(false); h.send({ type: 'VadSpeechEnd', ts: h.now, speechMs: 600 });
    h.advance(h.now + 2);
    h.stt({ type: 'SttClosed' });
    expect(h.dispatched()).toEqual(['pen up']);
  });
  it('SttFinalizeRejected in PROCESSING keeps forced_end running', () => {
    const h = new Harness();
    wakeAndConnect(h);
    h.stt({ type: 'SttPartial', text: 'pen up', eager: false });
    h.vad(false); h.send({ type: 'VadSpeechEnd', ts: h.now, speechMs: 600 });
    h.advance(h.now + 2);
    h.stt({ type: 'SttFinalizeRejected' });
    expect(h.timer('forced_end')).toBeDefined();
  });
  it('a stale timer cannot act on a newer utterance', () => {
    const h = new Harness();
    wakeAndConnect(h, false);
    const stale = h.timer('no_speech')!;
    h.send({ type: 'Cancel', reason: 'esc' });
    h.now = 2; wakeAndConnect(h, false);
    h.send({ type: 'TimerFired', name: 'no_speech', stamp: stale.stamp, seq: stale.seq });
    expect(h.state).toBe('LISTENING');
  });
  it('command timer orphans a hookless command with one toast', () => {
    const h = new Harness({ abortSupported: false });
    h.send({ type: 'HotkeyToggle' }); h.stt({ type: 'SttConnected' }); h.stt({ type: 'SttFinal', text: 'pen down' });
    h.advance(h.now + 31);
    expect(h.toasts()).toEqual(['That took too long']);
    expect(h.ctx.inFlightCmd).toBeNull();
    expect(h.state).toBe('PASSIVE');
    h.send({ type: 'CommandDone', cmdId: 1, resultText: 'late' });
    expect(h.toasts()).toEqual(['That took too long']);
  });
  it('command layer failure → ERROR with its message; voice keeps running', () => {
    const h = new Harness();
    h.send({ type: 'HotkeyToggle' }); h.stt({ type: 'SttConnected' }); h.stt({ type: 'SttFinal', text: 'make coffee' });
    h.send({ type: 'CommandFailed', cmdId: 1, message: "“make coffee” isn't a Steady command" });
    expect(h.state).toBe('ERROR');
    h.advance(h.now + 3.1);
    h.send({ type: 'HotkeyToggle' });
    expect(h.state).toBe('PTT_ACTIVE');
  });
  it('wake_gate_tail is unstamped and survives a gen bump', () => {
    const h = new Harness();
    h.send({ type: 'PlaybackStarted', kind: 'earcon', text: null, playId: 'p1' });
    expect(h.find('SetWakeEnabled')[0]?.enabled).toBe(false);
    h.send({ type: 'PlaybackStopped', playId: 'p1' });
    h.send({ type: 'HotkeyToggle' }); h.send({ type: 'Cancel', reason: 'esc' }); // gen bumps
    h.advance(h.now + 0.21);
    expect(h.find('SetWakeEnabled').at(-1)?.enabled).toBe(true);
  });
  it('gate_cap re-enables wake after a lost PlaybackStopped', () => {
    const h = new Harness();
    h.send({ type: 'PlaybackStarted', kind: 'earcon', text: null, playId: 'p1' });
    h.advance(1.01);
    expect(h.find('SetWakeEnabled').at(-1)?.enabled).toBe(true);
    expect(h.ctx.livePlaybacks.size).toBe(0);
  });
  it('20 back-to-back earcons gate wake throughout; enabled 200 ms after the last', () => {
    const h = new Harness();
    for (let i = 0; i < 20; i++) {
      h.send({ type: 'PlaybackStarted', kind: 'earcon', text: null, playId: `p${i}` });
      h.advance(h.now + 0.1);
      h.send({ type: 'PlaybackStopped', playId: `p${i}` });
      h.send({ type: 'WakeDetected', phrase: 'hey cartesia', ts: h.now, score: null });
    }
    expect(h.find('OpenStt')).toEqual([]);
    h.advance(h.now + 0.21);
    expect(h.find('SetWakeEnabled').at(-1)?.enabled).toBe(true);
  });
  it('TTS without a detector keyword leaves wake on', () => {
    const h = new Harness();
    h.send({ type: 'PlaybackStarted', kind: 'tts', text: 'Your brush is bigger', playId: 't' });
    expect(h.has('SetWakeEnabled')).toBe(false);
    h.send({ type: 'PlaybackStopped', playId: 't' });
    expect(h.ctx.livePlaybacks.size).toBe(0);
  });
  it('mute closes capture and aborts STT; unmute reopens', () => {
    const h = new Harness();
    wakeAndConnect(h);
    h.send({ type: 'MuteHotkey' });
    expect(h.types().filter(type => type !== 'CancelTimer')).toEqual(['SetCloudGate', 'StopForwarding', 'AbortStt', 'CloseCapture', 'ShowState']);
    expect(h.ctx.timers.size).toBe(0);
    expect(h.state).toBe('MUTED');
    h.send({ type: 'HotkeyToggle' });
    expect(h.toasts(h.last)).toEqual(['unmute first']);
    h.send({ type: 'MuteHotkey' });
    expect(h.state).toBe('PASSIVE');
    expect(h.has('OpenCapture')).toBe(true);
  });
  it('device change with a session open → ERROR; otherwise detections are skipped briefly', () => {
    const h = new Harness();
    h.send({ type: 'DeviceChanged' });
    h.send({ type: 'WakeDetected', phrase: 'hey cartesia', ts: 0.2, score: null });
    expect(h.has('OpenStt')).toBe(false);
    h.now = 1; wakeAndConnect(h);
    h.send({ type: 'DeviceChanged' });
    expect(h.state).toBe('ERROR');
  });
  it('the cloud gate is off in every non-streaming state', () => {
    const h = new Harness();
    const check = () => { if (!['LISTENING', 'PTT_ACTIVE'].includes(h.state)) expect(h.gate()).toBe(false); };
    wakeAndConnect(h); check();
    h.vad(false); h.stt({ type: 'SttFinal', text: 'pen down' }); check();
    h.send({ type: 'CommandDone', cmdId: 1, resultText: null }); check();
    h.advance(h.now + 1); check();
    h.send({ type: 'HotkeyToggle' }); h.advance(h.now + 9); check();
    h.send({ type: 'HotkeyToggle' }); h.send({ type: 'Cancel', reason: 'click' }); check();
    h.send({ type: 'HotkeyToggle' }); h.advance(h.now + 80); check();
  });
  it('probe results set stt_disabled only for 401/403', () => {
    const h = new Harness();
    h.send({ type: 'ProbeResult', ok: false, code: 500 });
    expect(h.ctx.sttDisabled).toBe(false);
    expect(h.toasts()).toEqual(["Can't reach Cartesia — check network"]);
    h.send({ type: 'ProbeResult', ok: false, code: 403 });
    expect(h.ctx.sttDisabled).toBe(true);
  });
  it('dictation prefix yields kind=dictation', () => {
    const h = new Harness();
    h.send({ type: 'HotkeyToggle' }); h.stt({ type: 'SttConnected' });
    h.stt({ type: 'SttFinal', text: 'type hello world' });
    expect(h.find('Dispatch')[0]?.command).toMatchObject({ kind: 'dictation', text: 'hello world' });
  });
  it('consecutive utterances reset stale partials and barge-in', () => {
    const h = new Harness();
    wakeAndConnect(h); h.stt({ type: 'SttPartial', text: 'pen', eager: false });
    h.send({ type: 'Cancel', reason: 'esc' });
    h.now = 3; wakeAndConnect(h);
    expect(h.ctx.lastPartial).toBeNull();
    expect(h.ctx.bargeIn).toBe(false);
  });
});

describe('capture failures', () => {
  it('logs the reason and mutes with a reason-specific toast', () => {
    const cases: [string, RegExp][] = [
      ['denied', /permission needed/], ['NotAllowedError: Permission denied', /permission needed/],
      ['silent input', /tccutil reset Microphone/], ['NotFoundError: Requested device not found', /No microphone found/],
      ['NotReadableError: Could not start audio source', /busy or unavailable/], ['AbortError: worklet failed', /Couldn't open the microphone \(AbortError: worklet failed\)/],
    ];
    for (const [reason, toast] of cases) {
      const h = new Harness();
      h.send({ type: 'CaptureFailed', reason });
      expect(h.state).toBe('MUTED');
      expect(h.ctx.mutedReason).toBe('permission');
      expect(h.toasts()).toEqual([expect.stringMatching(toast)]);
      expect(h.find('Log')[0]?.fields).toMatchObject({ captureFailed: reason });
    }
  });
});

describe('local command keywords (no wake phrase)', () => {
  it('dispatches straight from PASSIVE; without follow-up or a key it never opens the cloud', () => {
    for (const h of [new Harness({ config: c => { c.wake.localFollowUp = false; } }), new Harness({ sttDisabled: true })]) {
      h.send({ type: 'LocalCommand', text: 'undo', ts: 1 });
      expect(h.dispatched()).toEqual(['undo']);
      expect(h.find('Dispatch')[0]?.command).toMatchObject({ source: 'local', confidence: 'high', tWake: null });
      expect(h.find('OpenStt')).toEqual([]);
      expect(h.find('SetCloudGate').some(action => action.on)).toBe(false);
      expect(h.state).toBe('EXECUTING');
    }
  });
  it('ignores repeats within the refractory window, but not a different command', () => {
    const h = new Harness({ config: c => { c.wake.localFollowUp = false; } });
    h.send({ type: 'LocalCommand', text: 'toggle erase', ts: 1 });
    h.send({ type: 'LocalCommand', text: 'toggle erase', ts: 1.4 });
    h.send({ type: 'LocalCommand', text: 'brush', ts: 1.5 });
    expect(h.dispatched()).toEqual(['toggle erase', 'brush']);
  });
  it('is ignored while muted, during a cloud session, and while an earcon plays', () => {
    const muted = new Harness();
    muted.send({ type: 'Mute' }); muted.send({ type: 'LocalCommand', text: 'undo', ts: 1 });
    expect(muted.dispatched()).toEqual([]);
    const session = new Harness();
    wakeAndConnect(session);
    session.send({ type: 'LocalCommand', text: 'undo', ts: session.now });
    expect(session.dispatched()).toEqual([]);
    expect(session.state).toBe('LISTENING');
    const gated = new Harness();
    gated.ctx.wakeGatedUntil = 2;
    gated.send({ type: 'LocalCommand', text: 'undo', ts: 1.5 });
    expect(gated.dispatched()).toEqual([]);
  });
});

describe('follow-up after a local keyword ("undo … three times")', () => {
  function keyword(h: Harness, text = 'undo', ts = 1): void {
    h.now = ts; h.vad(true);
    h.send({ type: 'LocalCommand', text, ts });
  }
  it('runs the keyword at once, then silently transcribes the utterance from the pre-roll', () => {
    const h = new Harness({ config: c => { c.wake.localFollowUp = true; } });
    keyword(h);
    expect(h.dispatched()).toEqual(['undo']);
    expect(h.state).toBe('WAKING');
    expect(h.find('PlayEarcon')).toEqual([]);
    h.advance(1.2); h.stt({ type: 'SttConnected' });
    expect(h.state).toBe('LISTENING');
    expect(h.find('StartForwarding').at(-1)?.fromTs).toBeCloseTo(1 - h.config.wake.prerollMs / 1000);
    expect(h.gate()).toBe(true);
    h.vad(false); h.stt({ type: 'SttFinal', text: 'undo three times' });
    expect(h.dispatched()).toEqual(['undo', 'undo three times']);
    expect(h.find('Dispatch')[1]?.command).toMatchObject({ source: 'local', alreadyRan: 'undo' });
    expect(h.gate()).toBe(false);
  });
  it('queues behind the keyword command instead of aborting it', () => {
    const h = new Harness({ abortSupported: true, config: c => { c.wake.localFollowUp = true; } });
    keyword(h);
    h.advance(1.2); h.stt({ type: 'SttConnected' }); h.vad(false);
    h.stt({ type: 'SttFinal', text: 'undo twice' });
    expect(h.find('AbortCommand')).toEqual([]);
    expect(h.toasts()).not.toContain('Will run after the current command');
  });
  it('shows the keyword result while still listening', () => {
    const h = new Harness({ config: c => { c.wake.localFollowUp = true; } });
    keyword(h);
    const cmdId = h.find('Dispatch')[0]!.command.cmdId;
    h.send({ type: 'CommandDone', cmdId, resultText: 'Undone' });
    expect(h.toasts()).toEqual(['Undone']);
    expect(h.state).toBe('WAKING');
  });
  it('drops a failed follow-up quietly: the keyword already ran', () => {
    const h = new Harness({ config: c => { c.wake.localFollowUp = true; } });
    keyword(h);
    h.advance(10);
    expect(h.state).toBe('PASSIVE');
    expect(h.toasts()).toEqual([]);
    expect(h.ctx.followUp).toBeNull();
  });
  it('a keyword spotted in audio the cloud already heard is not run twice', () => {
    const h = new Harness({ config: c => { c.wake.localFollowUp = true; } });
    keyword(h, 'undo', 1);
    h.advance(1.2); h.stt({ type: 'SttConnected' });
    h.now = 2.5; h.vad(false); h.stt({ type: 'SttFinal', text: 'undo undo' });
    const cmdId = h.find('Dispatch')[1]!.command.cmdId;
    h.send({ type: 'CommandDone', cmdId, resultText: 'Undone' });
    // The spotter reports the second "undo" late, after the transcript already counted it.
    h.now = 3; h.send({ type: 'LocalCommand', text: 'undo', ts: 2.3 });
    expect(h.dispatched()).toEqual(['undo', 'undo undo']);
    // A new utterance afterwards still runs.
    h.advance(4); h.send({ type: 'LocalCommand', text: 'undo', ts: 4 });
    expect(h.dispatched()).toEqual(['undo', 'undo undo', 'undo']);
    // Its pre-roll starts where the last transcript's audio ended, not 1.5 s back.
    h.advance(4.2); h.stt({ type: 'SttConnected' });
    expect(h.find('StartForwarding').at(-1)?.fromTs).toBe(2.5);
  });
  it('is off by default: the keyword runs and nothing opens a cloud session', () => {
    const h = new Harness();
    keyword(h);
    expect(h.dispatched()).toEqual(['undo']);
    expect(h.find('OpenStt')).toEqual([]);
    expect(h.state).toBe('EXECUTING');
  });
});
