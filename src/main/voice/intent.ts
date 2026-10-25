import Anthropic from '@anthropic-ai/sdk';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
import { ACTIONS, type ActionID } from '../../shared/contracts';
import { MAX_REPEAT, normalizePlan, type PlanStep } from './plan';

/**
 * Natural-language reading: when a transcript isn't a plain command ("get rid of the last few lines", "don't undo"),
 * Claude maps what the artist meant onto Steady's fixed actions as an ordered plan with repeat counts, or an empty
 * plan. It never invents actions: the response is constrained to the enum below, and counts are clamped after.
 */
export const INTENT_MODEL = 'claude-haiku-5-5';
const KEYCHAIN_SERVICE = 'org.steady.anthropic';

const MEANINGS: Record<ActionID, string> = {
  penDown: 'start drawing (press the pen down)', penUp: 'stop drawing (lift the pen)', penToggle: 'toggle the pen up/down',
  click: 'click once at the pointer', undo: 'undo the last stroke or change', redo: 'redo what was undone',
  brush: 'switch to the brush tool (turns the eraser off)', eraser: 'switch to the eraser (erase mode on; does nothing if already erasing)',
  toggleErase: 'flip eraser mode on/off (only when the artist asks to toggle)', bigger: 'make the brush bigger',
  smaller: 'make the brush smaller', pause: 'pause head/hand tracking', resume: 'resume head/hand tracking',
  recenter: 'recalibrate the neutral position', markCorner: 'mark a canvas corner', microphoneOff: 'turn the microphone off',
  swapColors: 'swap the foreground and background colors', tremorFilter: 'toggle the heavy tremor-smoothing stroke mode on/off',
};
const SYSTEM = `You turn one short spoken request from an artist drawing in Krita with Steady (hands-free head/hand tracking) into Steady actions.
Actions:
${ACTIONS.map(id => `- ${id}: ${MEANINGS[id]}`).join('\n')}
Return the steps in the order they should run. "times" is how many times to run a step: 1 unless the artist asks for a repeat. Only undo, redo, bigger and smaller can repeat, at most ${MAX_REPEAT} times.
How artists phrase things:
- Lines, strokes, marks and scribbles are strokes. Getting rid of, removing, deleting, scrapping or erasing the last strokes means undo, once per stroke: "undo the last two strokes" → undo 2.
- Vague amounts are still requests: "a couple" → 2, "a few", "some" or "the last few" → 3, "a bunch" or "a lot" → 5 ("a lot bigger" → bigger 3).
- "Change brush", "switch brush", "back to the brush" and "pencil" mean brush.
The transcript may start with the wake phrase "hey cartesia" (any spelling, capitalization or punctuation). It means the rest is addressed to Steady; it is not itself an action.
Without the wake phrase, the microphone may have caught talk to someone else in the room, thinking aloud or background speech.
Act on every part of the request you can map to an action. Return no steps for a part that is negated ("don't undo"), and no steps at all when the speech is not a drawing request addressed to Steady.`;
const STEP = { type: 'object', properties: { action: { type: 'string', enum: [...ACTIONS] }, times: { type: 'integer' } }, required: ['action', 'times'], additionalProperties: false };
const SCHEMA = { type: 'object', properties: { steps: { type: 'array', items: STEP } }, required: ['steps'], additionalProperties: false };

/** ANTHROPIC_API_KEY, else the key stored with `security add-generic-password -s org.steady.anthropic -a steady -w`. */
export async function anthropicKey(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  if (env.ANTHROPIC_API_KEY?.trim()) return env.ANTHROPIC_API_KEY.trim();
  try {
    const { stdout } = await execFileAsync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', 'steady', '-w'], { encoding: 'utf8', timeout: 2000 });
    return stdout.trim() || null;
  } catch { return null; }
}

export type IntentClient = Pick<Anthropic, 'messages'>;
export const createIntentClient = (apiKey: string): IntentClient => new Anthropic({ apiKey, timeout: 4000, maxRetries: 0 });

/** The plan the utterance means ([] for none, a refusal or malformed output). Network errors propagate. */
export async function interpretPlan(client: IntentClient, text: string): Promise<PlanStep[]> {
  const response = await client.messages.create({
    model: INTENT_MODEL, max_tokens: 1024, system: SYSTEM,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{ role: 'user', content: text.slice(0, 300) }],
  });
  if (response.stop_reason === 'refusal') return [];
  for (const block of response.content) {
    if (block.type !== 'text') continue;
    try {
      const steps = (JSON.parse(block.text) as { steps?: unknown }).steps;
      if (!Array.isArray(steps)) return [];
      return normalizePlan(steps.filter((step): step is PlanStep => typeof step === 'object' && step !== null &&
        (ACTIONS as readonly unknown[]).includes((step as PlanStep).action) && Number.isFinite((step as PlanStep).times)));
    } catch { return []; }
  }
  return [];
}
