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

export function parseSteadyCommand(text: string): ActionID | null {
  const phrase = text.toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^steady\s+/, '');
  return VOCABULARY[phrase] ?? null;
}
