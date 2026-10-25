import type { LocalActionID } from '../shared/contracts';
import type { ConfigurationQueue } from './configuration';

/** Krita keyboard shortcuts: they don't depend on canvas/panel geometry, and native re-checks the foreground target live. */
const SHORTCUTS: readonly LocalActionID[] = ['undo', 'redo', 'brush', 'toggleErase', 'bigger', 'smaller', 'eraser', 'swapColors'];

/**
 * Bind pointer command intent to the configuration visible when it was received. Shortcuts instead wait for an
 * in-flight configuration and run after it, so "undo" never has to be repeated because the panel was settling.
 */
export function deliverCommand<T>(queue: ConfigurationQueue, generation: () => number, action: LocalActionID, execute: () => Promise<T>): Promise<T> {
  if (action === 'pause' || action === 'penUp') return execute();
  if (SHORTCUTS.includes(action)) return queue.run(execute);
  if (queue.busy) return Promise.reject(new Error('Command discarded: control configuration is busy. Retry explicitly.'));
  const receivedGeneration = generation();
  return queue.run(async () => {
    if (generation() !== receivedGeneration) throw new Error('Command discarded: control configuration changed. Retry explicitly.');
    return execute();
  });
}
