import type { ActionID } from '../../shared/contracts';

/**
 * Steady's voice vocabulary (plan/PLAN.md §2) plus the plain words people say for the same action. A command is
 * picked out wherever it is mentioned ("can you switch to the brush" → brush); case and punctuation are ignored.
 */
const VOCABULARY: Record<string, ActionID> = {
  'pen down': 'penDown', 'pen up': 'penUp', 'pen toggle': 'penToggle', click: 'click', undo: 'undo', redo: 'redo',
  brush: 'brush', 'toggle erase': 'toggleErase', eraser: 'toggleErase', erase: 'toggleErase', bigger: 'bigger', smaller: 'smaller',
  pause: 'pause', resume: 'resume', recenter: 'recenter', 're center': 'recenter', 'mark corner': 'markCorner',
  'microphone off': 'microphoneOff', 'mic off': 'microphoneOff',
};
export const VOICE_LABELS: Record<ActionID, string> = {
  penDown: 'Pen down', penUp: 'Pen up', penToggle: 'Pen toggled', click: 'Clicked', undo: 'Undone', redo: 'Redone', brush: 'Brush',
  toggleErase: 'Eraser toggled', bigger: 'Bigger brush', smaller: 'Smaller brush', pause: 'Paused', resume: 'Resumed',
  recenter: 'Recentering', markCorner: 'Corner marked', microphoneOff: 'Microphone off',
};
// Longest first, so "toggle erase" wins over "erase" and "pen down" is one mention.
const PHRASES = Object.keys(VOCABULARY).map(phrase => phrase.split(' ')).sort((a, b) => b.length - a.length);

/** Every distinct action mentioned in `text`, in order (non-overlapping, longest phrase first). */
export function findSteadyCommands(text: string): ActionID[] {
  const words = text.toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean);
  const found: { at: number; action: ActionID }[] = [];
  const used = new Array<boolean>(words.length).fill(false);
  for (const phrase of PHRASES) {
    for (let i = 0; i + phrase.length <= words.length; i++) {
      if (phrase.some((word, k) => used[i + k] || words[i + k] !== word)) continue;
      for (let k = 0; k < phrase.length; k++) used[i + k] = true;
      found.push({ at: i, action: VOCABULARY[phrase.join(' ')]! });
    }
  }
  return [...new Set(found.sort((a, b) => a.at - b.at).map(item => item.action))];
}

/** The single action mentioned in `text`, or null when there is none or more than one. */
export function parseSteadyCommand(text: string): ActionID | null {
  const actions = findSteadyCommands(text);
  return actions.length === 1 ? actions[0]! : null;
}
