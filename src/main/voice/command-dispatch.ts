import type { ActionID } from '../../shared/contracts';
import type { CommandEvent } from './types';
import { findSteadyCommands, VOICE_LABELS } from './steady-commands';

/** Resolve voice intent, then use the app dispatcher so its canvas and input gates remain authoritative. */
export async function dispatchVoiceCommand(
  command: CommandEvent,
  enqueue: (action: ActionID) => Promise<unknown>,
  interpret: (text: string) => Promise<ActionID | null>,
): Promise<string | null> {
  if (command.kind === 'dictation') throw new Error("Dictation isn't available in Steady");
  let actions = findSteadyCommands(command.text);
  if (actions.length === 0 && command.source !== 'local') {
    // No command word: let Claude map what was meant ("get rid of that line") onto the same fixed actions.
    const meant = await interpret(command.text);
    if (meant) actions = [meant];
  }
  if (actions.length === 0) throw new Error(`No command heard in “${command.text.slice(0, 40)}”`);
  if (actions.length > 1) throw new Error(`Heard more than one command (${actions.map(id => VOICE_LABELS[id].toLowerCase()).join(', ')}): say one at a time`);
  const action = actions[0]!;
  await enqueue(action);
  return VOICE_LABELS[action];
}
