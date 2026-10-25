import { describe, expect, it } from 'vitest';
import { defaultVoiceConfig, effectiveKeyterms, ringFrames, sttFinalSeconds } from '../../src/main/voice/config';
import { classify, stripWake } from '../../src/main/voice/postprocess';

const config = defaultVoiceConfig();
const jarvis = (() => { const c = defaultVoiceConfig(); c.wake.phrase = 'hey jarvis'; return c; })();

describe('§9.2 wake stripping', () => {
  const cases: [string, string][] = [
    ['sia open chrome', 'open chrome'],
    ['hey cartesia open chrome', 'open chrome'],
    ['Hey, Cartesia, open chrome', 'open chrome'],
    ['Hey Cartesia—open chrome', 'open chrome'],
    ['cartesia', ''],
    ['cartesian coordinates', 'cartesian coordinates'],
    ['sia open chrome hey cartesia open slack', 'open slack'],
    ['open chrome hey cartesia', 'open chrome'],
    ['  Pen   down. ', 'Pen down'],
  ];
  for (const [input, expected] of cases) it(`"${input}" → "${expected}"`, () => expect(stripWake(input, config)).toBe(expected));
  it('works for "hey jarvis"', () => expect(stripWake('vis open chrome', jarvis)).toBe('open chrome'));
  it('honors remnant aliases exactly', () => {
    const c = defaultVoiceConfig(); c.wake.remnantAliases = ['Asia'];
    expect(stripWake('Asia undo', c)).toBe('undo');
    expect(stripWake('Asian undo', c)).toBe('Asian undo');
  });
});

describe('§9.3–5 classification', () => {
  it('blocklist is an exact match', () => {
    expect(classify('thank you', config, null)).toEqual({ kind: 'drop', reason: 'blocklist' });
    expect(classify('say thank you', config, null).kind).toBe('command');
  });
  it('drops bracketed non-speech tags', () => {
    expect(classify('[Applause]', config, null).kind).toBe('drop');
    expect(classify('(laughter)', config, null).kind).toBe('drop');
  });
  it('length filter only applies when speech_ms is known', () => {
    expect(classify('undo', config, null).kind).toBe('command');
    expect(classify('undo', config, 100).kind).toBe('drop');
    expect(classify('undo', config, 400).kind).toBe('command');
  });
  it('dictation prefix', () => expect(classify('type hello world', config, null)).toEqual({ kind: 'command', text: 'hello world', commandKind: 'dictation' }));
  it('interrupt classification', () => {
    expect(classify('cancel that', config, null)).toMatchObject({ kind: 'interrupt', always: true });
    expect(classify('Never mind.', config, null)).toMatchObject({ kind: 'interrupt', always: true });
    expect(classify('stop stop', config, null).kind).toBe('stop-command');
    expect(classify('stop the video', config, null).kind).toBe('command');
  });
});

describe('derived configuration', () => {
  it('derives stt_final, the ring size and keyterms', () => {
    expect(sttFinalSeconds(config)).toBeCloseTo(1.9);
    expect(ringFrames(config)).toBe(63);
    expect(effectiveKeyterms(config)[0]).toBe('Cartesia');
  });
});
