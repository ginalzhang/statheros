import Anthropic from '@anthropic-ai/sdk';
import { spawnSync } from 'node:child_process';
import { ACTIONS, type ActionID } from '../../shared/contracts';

/**
 * Natural-language fallback: when a cloud transcript ("hey cartesia …" / push-to-talk) names no Steady command,
 * Claude maps what the artist meant ("get rid of that last line") onto the same fixed action set, or "none".
 * It never invents actions: the response is constrained to the enum below.
 */
export const INTENT_MODEL = 'claude-haiku-5-5';
const KEYCHAIN_SERVICE = 'org.steady.anthropic';

const MEANINGS: Record<ActionID, string> = {
  penDown: 'start drawing (press the pen down)', penUp: 'stop drawing (lift the pen)', penToggle: 'toggle the pen up/down',
  click: 'click once at the pointer', undo: 'undo the last stroke or change', redo: 'redo what was undone',
  brush: 'switch to the brush tool', toggleErase: 'toggle eraser mode on/off', bigger: 'make the brush bigger',
  smaller: 'make the brush smaller', pause: 'pause head/hand tracking', resume: 'resume head/hand tracking',
  recenter: 'recalibrate the neutral position', markCorner: 'mark a canvas corner', microphoneOff: 'turn the microphone off',
  swapColors: 'swap the foreground and background colors', tremorFilter: 'toggle the heavy tremor-smoothing stroke mode on/off',
};
const SYSTEM = `You turn one short spoken request from an artist drawing in Krita with Steady (hands-free head/hand tracking) into exactly one Steady action.
Actions:
${ACTIONS.map(id => `- ${id}: ${MEANINGS[id]}`).join('\n')}
Answer "none" when the request is not about drawing, is ambiguous, or asks for more than one action. Never guess: a wrong action changes the artwork.`;
const SCHEMA = { type: 'object', properties: { action: { type: 'string', enum: [...ACTIONS, 'none'] } }, required: ['action'], additionalProperties: false };

/** ANTHROPIC_API_KEY, else the key stored with `security add-generic-password -s org.steady.anthropic -a steady -w`. */
export function anthropicKey(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.ANTHROPIC_API_KEY?.trim()) return env.ANTHROPIC_API_KEY.trim();
  const result = spawnSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', 'steady', '-w'], { encoding: 'utf8', timeout: 2000 });
  return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : null;
}

export type IntentClient = Pick<Anthropic, 'messages'>;
export const createIntentClient = (apiKey: string): IntentClient => new Anthropic({ apiKey, timeout: 4000, maxRetries: 0 });

/** The single action the utterance means, or null ("none", refusal, malformed output). Network errors propagate. */
export async function interpretIntent(client: IntentClient, text: string): Promise<ActionID | null> {
  const response = await client.messages.create({
    model: INTENT_MODEL, max_tokens: 1024, system: SYSTEM,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{ role: 'user', content: text.slice(0, 300) }],
  });
  if (response.stop_reason === 'refusal') return null;
  for (const block of response.content) {
    if (block.type !== 'text') continue;
    try {
      const action = (JSON.parse(block.text) as { action?: unknown }).action;
      return typeof action === 'string' && (ACTIONS as readonly string[]).includes(action) ? action as ActionID : null;
    } catch { return null; }
  }
  return null;
}
