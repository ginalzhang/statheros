import { describe, expect, it } from 'vitest';
import { describePlan, parsePlan, resolvePlan, withoutFirstRun, type Interpreter } from '../../src/main/voice/plan';

const plan = (text: string) => parsePlan(text).steps;

describe('local plan parsing', () => {
  it('reads repeat counts in the ways people say them', () => {
    for (const text of ['undo 3 times', 'undo three times', 'Undo, three times.', 'undo 3', 'undo 3x', 'undo x3', 'undo undo undo', 'undo the last three strokes', 'three times undo', 'undo it three more times'])
      expect(plan(text), text).toEqual([{ action: 'undo', times: 3 }]);
    expect(plan('undo twice')).toEqual([{ action: 'undo', times: 2 }]);
    expect(plan('undo to times')).toEqual([{ action: 'undo', times: 2 }]);
    expect(plan('make it two sizes bigger')).toEqual([{ action: 'bigger', times: 2 }]);
    expect(plan('smaller a couple of times')).toEqual([{ action: 'smaller', times: 2 }]);
    expect(plan('undo')).toEqual([{ action: 'undo', times: 1 }]);
  });
  it('keeps several commands in order, each with its own count', () => {
    expect(plan('undo twice then switch to the brush')).toEqual([{ action: 'undo', times: 2 }, { action: 'brush', times: 1 }]);
    expect(plan('erase and make it bigger 3 times')).toEqual([{ action: 'toggleErase', times: 1 }, { action: 'bigger', times: 3 }]);
  });
  it('only repeats actions where repeating means something, and caps the count', () => {
    expect(plan('erase three times')).toEqual([{ action: 'toggleErase', times: 1 }]);
    expect(plan('undo 500 times')).toEqual([{ action: 'undo', times: 20 }]);
  });
  it('marks plain phrasings simple and leaves the rest to Claude', () => {
    expect(parsePlan('can you undo that three times please').simple).toBe(true);
    expect(parsePlan('undo twice then switch to the brush').simple).toBe(true);
    expect(parsePlan('get rid of that last line').simple).toBe(false);
    expect(parsePlan('okay now erase this part').simple).toBe(false);
    expect(parsePlan("don't undo")).toMatchObject({ simple: false, negated: true });
  });
});

describe('resolving a plan', () => {
  const claude = (answer: ReturnType<Interpreter> extends Promise<infer T> ? T : never, seen: string[] = []): Interpreter =>
    async text => { seen.push(text); return answer; };
  it('runs plain phrasings without asking Claude', async () => {
    const seen: string[] = [];
    expect(await resolvePlan('undo three times', claude([], seen))).toEqual({ steps: [{ action: 'undo', times: 3 }], by: 'local' });
    expect(seen).toEqual([]);
  });
  it("asks Claude about anything else and trusts its answer, including 'nothing'", async () => {
    expect(await resolvePlan('get rid of the last few lines', claude([{ action: 'undo', times: 3 }]))).toEqual({ steps: [{ action: 'undo', times: 3 }], by: 'claude' });
    expect((await resolvePlan("don't undo", claude([]))).steps).toEqual([]);
  });
  it('falls back to the local parse without Claude, except after a negation', async () => {
    expect((await resolvePlan('okay now erase this part', claude(null))).steps).toEqual([{ action: 'toggleErase', times: 1 }]);
    expect((await resolvePlan('okay now erase this part', null)).steps).toEqual([{ action: 'toggleErase', times: 1 }]);
    expect((await resolvePlan("don't undo", null)).steps).toEqual([]);
  });
});

describe('follow-up after an on-device keyword', () => {
  it('subtracts the run that already happened', () => {
    expect(withoutFirstRun([{ action: 'undo', times: 3 }], 'undo')).toEqual([{ action: 'undo', times: 2 }]);
    expect(withoutFirstRun([{ action: 'undo', times: 1 }], 'undo')).toEqual([]);
    expect(withoutFirstRun([{ action: 'undo', times: 2 }, { action: 'brush', times: 1 }], 'undo')).toEqual([{ action: 'undo', times: 1 }, { action: 'brush', times: 1 }]);
  });
  it('runs nothing extra when the transcript never mentions that action', () => {
    expect(withoutFirstRun([{ action: 'redo', times: 2 }], 'undo')).toBeNull();
  });
  it('describes what ran', () => {
    expect(describePlan([{ action: 'undo', times: 3 }, { action: 'brush', times: 1 }])).toBe('Undone ×3 · Brush');
  });
});
