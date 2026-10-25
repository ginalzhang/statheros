import { parentPort, workerData } from 'node:worker_threads';
import { Inference, type InferenceInit, type InferenceResult } from './inference';

/** Inference thread in the main process (prompt §2 Electron column). Never touches the network. */
export type InferenceRequest =
  | { type: 'frame'; pcm: Int16Array; ts: number }
  | { type: 'setWakeEnabled'; enabled: boolean }
  | { type: 'resetWake' }
  | { type: 'reset' }
  /** Finish queued work, then let the thread exit naturally (never interrupt a native call). */
  | { type: 'exit' };
export type InferenceReply =
  | { type: 'ready'; wake: boolean; vad: 'silero' | 'energy'; error: string | null }
  | ({ type: 'result' } & InferenceResult);

const port = parentPort!;
const inference = new Inference(workerData as InferenceInit);
port.postMessage({ type: 'ready', wake: inference.wakeReady, vad: inference.vadKind, error: inference.error } satisfies InferenceReply);
port.on('message', (message: InferenceRequest) => {
  switch (message.type) {
    case 'frame': port.postMessage({ type: 'result', ...inference.frame(message.pcm, message.ts) } satisfies InferenceReply); return;
    case 'setWakeEnabled': inference.setWakeEnabled(message.enabled); return;
    case 'resetWake': inference.resetWake(); return;
    case 'reset': inference.reset(); return;
    case 'exit': port.close(); return;
  }
});
