import type { ActionID } from '../../shared/contracts';

/**
 * Steady's fixed voice vocabulary (plan/PLAN.md §2). The wake phrase replaces the spoken "Steady" prefix,
 * which stays optional. Case and punctuation are ignored; synonyms and multiple actions are rejected.
 */
const VOCABULARY: Record<string, ActionID> = {
  'pen down': 'penDown', 'pen up': 'penUp', 'pen toggle': 'penToggle', click: 'click', undo: 'undo', redo: 'redo',
  brush: 'brush', 'toggle erase': 'toggleErase', bigger: 'bigger', smaller: 'smaller', pause: 'pause', resume: 'resume',
  recenter: 'recenter', 'mark corner': 'markCorner', 'microphone off': 'microphoneOff',
};
export const VOICE_LABELS: Record<ActionID, string> = {
  penDown: 'Pen down', penUp: 'Pen up', penToggle: 'Pen toggled', click: 'Clicked', undo: 'Undone', redo: 'Redone', brush: 'Brush',
  toggleErase: 'Eraser toggled', bigger: 'Bigger brush', smaller: 'Smaller brush', pause: 'Paused', resume: 'Resumed',
  recenter: 'Recentering', markCorner: 'Corner marked', microphoneOff: 'Microphone off',
};

const VOCABULARY_WORDS = new Set(Object.keys(VOCABULARY).flatMap(phrase => phrase.split(' ')));
/** Words a misheard wake phrase may leave before the command ("here okay undo" for "hey cartesia, undo"). */
const MAX_WAKE_REMNANT_WORDS = 2;

/**
 * Exact vocabulary match. After a local wake detection the transcript can start with a misheard wake phrase,
 * so `wake` utterances also accept up to two leading non-vocabulary words; push-to-talk stays exact.
 */
export function parseSteadyCommand(text: string, source: 'wake' | 'ptt' = 'ptt'): ActionID | null {
  const phrase = text.toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^steady\s+/, '');
  const exact = VOCABULARY[phrase];
  if (exact || source !== 'wake') return exact ?? null;
  const words = phrase.split(' ');
  for (let skip = 1; skip <= MAX_WAKE_REMNANT_WORDS && skip < words.length; skip++) {
    const remnant = words.slice(0, skip);
    if (remnant.some(word => VOCABULARY_WORDS.has(word))) return null;
    const action = VOCABULARY[words.slice(skip).join(' ').replace(/^steady\s+/, '')];
    if (action) return action;
  }
  return null;
}
