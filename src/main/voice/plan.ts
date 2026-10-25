import type { ActionID } from '../../shared/contracts';
import { commandMentions, tokenize, VOICE_LABELS } from './steady-commands';

/**
 * A spoken request as an ordered list of actions with repeat counts ("undo three times, then brush" →
 * undo×3, brush×1). Plain phrasings are parsed here instantly; anything else goes to Claude (intent.ts).
 */
export interface PlanStep { action: ActionID; times: number }

/** Repeating these means something ("undo 3 times"); every other action runs once whatever count was said. */
export const REPEATABLE: readonly ActionID[] = ['undo', 'redo', 'bigger', 'smaller'];
export const MAX_REPEAT = 20;
export const MAX_STEPS = 6;

const NUMBERS: Record<string, number> = {
  one: 1, once: 1, two: 2, twice: 2, three: 3, thrice: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
  couple: 2, few: 3,
};
// How transcripts often spell "two"/"four"; only a count when "times" follows ("undo to times").
const HOMOPHONES: Record<string, number> = { to: 2, too: 2, for: 4, fore: 4 };
const TIMES = new Set(['times', 'time', 'x']);
const UNITS = new Set([...TIMES, 'more', 'strokes', 'stroke', 'steps', 'step', 'lines', 'line', 'things', 'thing', 'changes', 'change', 'sizes', 'size', 'notches', 'notch', 'levels', 'level', 'of']);
/** Words that carry no meaning of their own in a command; anything else is left to Claude. */
const FILLER = new Set([
  'please', 'steady', 'hey', 'ok', 'okay', 'now', 'can', 'could', 'would', 'will', 'you', 'just', 'the', 'a', 'an', 'it', 'that', 'this',
  'again', 'and', 'then', 'also', 'make', 'go', 'do', 'me', 'let', 'lets', 's', 'um', 'uh', 'so', 'yeah', 'yes', 'bit', 'little', 'last',
  'ones', 'switch', 'use', 'mode', 'tool', 'thanks', 'thank', 'quickly', 'quick', 'i', 'want', 'my', 'more', 'times', 'time', 'x', 'by', 'to', 'of',
]);
/** Their presence means the words around a command may not ask for it ("don't undo"). */
const NEGATIONS = new Set(['don', 'dont', 'not', 'no', 'never', 'wait', 'stop', 'cancel', 'nevermind', 'without', 'instead']);

function countAt(words: readonly string[], i: number): number | null {
  const word = words[i]!;
  if (/^\d+$/.test(word)) return Number(word);
  if (word in NUMBERS) return NUMBERS[word]!;
  if (word in HOMOPHONES && TIMES.has(words[i + 1] ?? '')) return HOMOPHONES[word]!;
  return null;
}

export const clampStep = (step: PlanStep): PlanStep =>
  ({ action: step.action, times: REPEATABLE.includes(step.action) ? Math.min(MAX_REPEAT, Math.max(1, Math.floor(step.times) || 1)) : 1 });

/** Clamps counts, merges back-to-back repeats ("undo undo undo" → undo×3) and caps the step count. */
export function normalizePlan(steps: readonly PlanStep[]): PlanStep[] {
  const merged: PlanStep[] = [];
  for (const step of steps) {
    const last = merged.at(-1);
    if (last && last.action === step.action && REPEATABLE.includes(step.action)) last.times += step.times;
    else merged.push({ ...step });
  }
  return merged.slice(0, MAX_STEPS).map(clampStep);
}

/**
 * Local parse. `simple` means every word was a command, a count or filler, so the plan is safe to run without
 * asking Claude; `negated` means a "don't"/"not"-style word was heard.
 */
export function parsePlan(text: string): { steps: PlanStep[]; simple: boolean; negated: boolean } {
  const words = tokenize(text);
  const mentions = commandMentions(words);
  const consumed = new Array<boolean>(words.length).fill(false);
  for (const mention of mentions) for (let k = 0; k < mention.length; k++) consumed[mention.at + k] = true;
  const steps = mentions.map((mention, index) => {
    const end = mention.at + mention.length;
    const limit = Math.min(index + 1 < mentions.length ? mentions[index + 1]!.at : words.length, end + 5);
    let times: number | null = null;
    // After the command: "undo 3", "undo three times", "undo the last two strokes", "bigger twice".
    for (let i = end; i < limit && times === null; i++) {
      if (consumed[i]) continue;
      times = countAt(words, i);
      if (times !== null) { consumed[i] = true; if (UNITS.has(words[i + 1] ?? '')) consumed[i + 1] = true; }
    }
    // Before it: "two sizes bigger", "three times undo".
    if (times === null) {
      const before = mention.at - (UNITS.has(words[mention.at - 1] ?? '') ? 2 : 1);
      const count = before >= 0 && !consumed[before] ? countAt(words, before) : null;
      if (count !== null) { times = count; for (let i = before; i < mention.at; i++) consumed[i] = true; }
    }
    return { action: mention.action, times: times ?? 1 };
  });
  const negated = words.some(word => NEGATIONS.has(word));
  const simple = !negated && words.every((word, i) => consumed[i] || FILLER.has(word));
  return { steps: normalizePlan(steps), simple, negated };
}

/** Claude's reading of an utterance: a plan, [] for "not a request", or null when Claude is unavailable. */
export type Interpreter = (text: string) => Promise<PlanStep[] | null>;

/**
 * Plain phrasings run straight from the local parse; anything with words the parser can't vouch for is read by
 * Claude. Without Claude, the local parse still runs unless it heard a negation.
 */
export async function resolvePlan(text: string, interpret: Interpreter | null): Promise<{ steps: PlanStep[]; by: 'local' | 'claude' }> {
  const local = parsePlan(text);
  if (local.simple && local.steps.length) return { steps: local.steps, by: 'local' };
  const meant = interpret ? await interpret(text) : null;
  if (meant !== null) return { steps: normalizePlan(meant), by: 'claude' };
  return { steps: local.negated ? [] : local.steps, by: 'local' };
}

/**
 * The cloud transcript of an utterance whose first command already ran from the on-device keyword: drop that one
 * run. null when the transcript never mentions that action (it heard something else; run nothing extra).
 */
export function withoutFirstRun(steps: readonly PlanStep[], action: ActionID): PlanStep[] | null {
  const index = steps.findIndex(step => step.action === action);
  if (index < 0) return null;
  const rest = steps.map(step => ({ ...step }));
  if (--rest[index]!.times === 0) rest.splice(index, 1);
  return rest;
}

export const describePlan = (steps: readonly PlanStep[]): string =>
  steps.map(step => `${VOICE_LABELS[step.action]}${step.times > 1 ? ` ×${step.times}` : ''}`).join(' · ');
