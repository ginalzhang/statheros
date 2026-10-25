import type { ActionID } from '../../shared/contracts';
import type { CommandEvent } from './types';
import { parseSteadyCommand } from './steady-commands';
import { describePlan, resolvePlan, withoutFirstRun, type Interpreter, type PlanStep } from './plan';

// Krita needs a beat between repeated shortcuts to apply each one.
const REPEAT_GAP_MS = 60;

/**
 * Resolve the spoken plan ("undo three times, then brush"), then run each step through the app dispatcher so its
 * canvas and input gates remain authoritative. Stops at the first rejected step and never retries it.
 * Returns '' (shown as nothing) when an open-mic utterance was not a request.
 */
export async function dispatchVoiceCommand(
  command: CommandEvent,
  enqueue: (action: ActionID) => Promise<unknown>,
  interpret: Interpreter,
): Promise<string | null> {
  if (command.kind === 'dictation') throw new Error("Dictation isn't available in Steady");
  // A bare on-device keyword is always a vocabulary phrase; follow-up transcripts are full sentences worth reading.
  const bareKeyword = command.source === 'local' && command.alreadyRan === undefined;
  let { steps } = await resolvePlan(command.text, bareKeyword ? null : interpret);
  const ran = command.alreadyRan === undefined ? null : parseSteadyCommand(command.alreadyRan);
  if (ran) {
    // The on-device keyword already ran this once; run only what the full sentence adds ("… three times" → two more).
    const rest = withoutFirstRun(steps, ran);
    if (!rest?.length) return describePlan([{ action: ran, times: 1 }]);
    steps = rest;
  }
  // Open mic hears everything said near it; an utterance that isn't a request is ignored silently.
  if (!steps.length && command.source === 'open') return '';
  if (!steps.length) throw new Error(`No command heard in “${command.text.slice(0, 40)}”`);
  const done: PlanStep[] = [];
  for (const step of steps) {
    for (let i = 0; i < step.times; i++) {
      if (done.length || i) await new Promise(resolve => setTimeout(resolve, REPEAT_GAP_MS));
      try { await enqueue(step.action); }
      catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (i) done.push({ action: step.action, times: i });
        throw new Error(done.length ? `${describePlan(done)}, then stopped: ${reason}` : reason);
      }
    }
    done.push(step);
  }
  return describePlan(done);
}
