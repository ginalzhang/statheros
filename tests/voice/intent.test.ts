import { expect, it } from 'vitest';
import { anthropicKey, interpretPlan, INTENT_MODEL, type IntentClient } from '../../src/main/voice/intent';

const fake = (reply: { text?: string; stop_reason?: string }, seen: unknown[] = []): IntentClient => ({
  messages: { create: async (params: unknown) => { seen.push(params); return { stop_reason: reply.stop_reason ?? 'end_turn', content: reply.text === undefined ? [] : [{ type: 'text', text: reply.text }] }; } },
} as unknown as IntentClient);

it('maps the constrained answer to a clamped plan and everything else to no steps', async () => {
  const seen: unknown[] = [];
  expect(await interpretPlan(fake({ text: '{"steps":[{"action":"undo","times":3}]}' }, seen), 'get rid of the last three lines')).toEqual([{ action: 'undo', times: 3 }]);
  expect(seen[0]).toMatchObject({ model: INTENT_MODEL, output_config: { effort: 'low', format: { type: 'json_schema' } } });
  expect(await interpretPlan(fake({ text: '{"steps":[{"action":"undo","times":500},{"action":"brush","times":4}]}' }), 'x')).toEqual([{ action: 'undo', times: 20 }, { action: 'brush', times: 1 }]);
  expect(await interpretPlan(fake({ text: '{"steps":[]}' }), 'what time is it')).toEqual([]);
  expect(await interpretPlan(fake({ text: '{"steps":[{"action":"delete everything","times":1}]}' }), 'x')).toEqual([]);
  expect(await interpretPlan(fake({ text: 'not json' }), 'x')).toEqual([]);
  expect(await interpretPlan(fake({ stop_reason: 'refusal' }), 'x')).toEqual([]);
});
it('prefers ANTHROPIC_API_KEY', async () => {
  expect(await anthropicKey({ ANTHROPIC_API_KEY: ' sk-test ' })).toBe('sk-test');
});

// Regression: "hey cartesia get rid of the last few lines and change brush" was dropped as a guess or half-run.
// Against claude-haiku-5-5 (3 runs × 12 phrases) the old prompt scored 31/36; this one 36/36.
it('tells Claude the wake phrase addresses Steady, how vague counts map, and to keep the parts it understands', async () => {
  const seen: { system?: string }[] = [];
  await interpretPlan(fake({ text: '{"steps":[]}' }, seen), 'hey cartesia get rid of the last few lines and change brush');
  const system = seen[0]!.system ?? '';
  expect(system).toContain('"hey cartesia"');
  expect(system).toContain('"the last few" → 3');
  expect(system).toContain('"Change brush"');
  expect(system).toContain('Act on every part of the request you can map');
  expect(system).not.toContain('you would have to guess');
});
