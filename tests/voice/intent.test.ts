import { expect, it } from 'vitest';
import { anthropicKey, interpretIntent, INTENT_MODEL, type IntentClient } from '../../src/main/voice/intent';

const fake = (reply: { text?: string; stop_reason?: string }, seen: unknown[] = []): IntentClient => ({
  messages: { create: async (params: unknown) => { seen.push(params); return { stop_reason: reply.stop_reason ?? 'end_turn', content: reply.text === undefined ? [] : [{ type: 'text', text: reply.text }] }; } },
} as unknown as IntentClient);

it('maps the constrained answer to an action and everything else to null', async () => {
  const seen: unknown[] = [];
  expect(await interpretIntent(fake({ text: '{"action":"undo"}' }, seen), 'get rid of that last line')).toBe('undo');
  expect(seen[0]).toMatchObject({ model: INTENT_MODEL, output_config: { effort: 'low', format: { type: 'json_schema' } } });
  expect(await interpretIntent(fake({ text: '{"action":"none"}' }), 'what time is it')).toBeNull();
  expect(await interpretIntent(fake({ text: '{"action":"delete everything"}' }), 'x')).toBeNull();
  expect(await interpretIntent(fake({ text: 'not json' }), 'x')).toBeNull();
  expect(await interpretIntent(fake({ stop_reason: 'refusal' }), 'x')).toBeNull();
});
it('prefers ANTHROPIC_API_KEY', () => {
  expect(anthropicKey({ ANTHROPIC_API_KEY: ' sk-test ' })).toBe('sk-test');
});
