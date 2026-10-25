import { expect, it, vi } from 'vitest';
import { dispatchVoiceCommand } from '../../src/main/voice/command-dispatch';
import { ConfigurationQueue } from '../../src/main/configuration';
import { deliverCommand } from '../../src/main/command-delivery';
import { readyForControl } from '../../src/main/input-gates';
import { defaultSettings } from '../../src/shared/settings';
import type { CalibrationV1, ProbeStatus } from '../../src/shared/contracts';
import type { CommandEvent } from '../../src/main/voice/types';
import fixtures from '../../fixtures/tracking-v1.json';

const command = (text: string, source: CommandEvent['source'] = 'local'): CommandEvent => ({
  cmdId: 1, text, source, kind: 'command', confidence: 'high', utteranceGen: 1,
  sessionId: 1, tWake: null, tSpeechEnd: null, tFinal: 0,
});

it('local and interpreted Resume retain the shared calibration and canvas prerequisites', async () => {
  const calibration = fixtures.calibration.positive[0] as CalibrationV1;
  const status: ProbeStatus = {
    generation: 1, realInput: false, displays: [], collapsed: false, settingsOpen: false, fault: null,
    nativeClockReady: true, targetPid: 123, canvasConfirmed: false, canvas: null,
    settings: { ...defaultSettings(), cameraId: calibration.cameraId, mode: calibration.mode, calibrations: [calibration] },
    native: { state: 'PAUSED', reason: 'test', buttonDown: false, foregroundTarget: 'org.krita', generation: 1,
      latestValidFrame: null, permissions: { accessibility: true, camera: 'authorized', microphone: 'notDetermined', speech: 'notDetermined' } },
  };
  const nativeAction = vi.fn(async () => undefined);
  const enqueue = async () => {
    const reason = readyForControl(status, true);
    if (reason) throw new Error(reason);
    await nativeAction();
  };
  const interpret = vi.fn(async () => [{ action: 'resume' as const, times: 1 }]);
  await expect(dispatchVoiceCommand(command('resume'), enqueue, interpret)).rejects.toThrow('Set the canvas first');
  await expect(dispatchVoiceCommand(command('keep going', 'ptt'), enqueue, interpret)).rejects.toThrow('Set the canvas first');
  expect(nativeAction).not.toHaveBeenCalled();
  status.canvas = { x: 0, y: 0, width: 300, height: 200 }; status.canvasConfirmed = true;
  status.settingsOpen = true;
  await expect(dispatchVoiceCommand(command('resume'), enqueue, interpret)).rejects.toThrow('Close Settings');
  status.settingsOpen = false;
  await expect(dispatchVoiceCommand(command('resume'), enqueue, interpret)).resolves.toBe('Resumed');
  expect(nativeAction).toHaveBeenCalledTimes(1);
});

it('voice cannot queue drawing through a canvas configuration change; Pause still releases', async () => {
  const queue = new ConfigurationQueue(); const effects: string[] = [];
  let finish!: () => void;
  const selection = queue.run(() => new Promise<void>(resolve => { finish = resolve; }));
  await Promise.resolve();
  const enqueue = (action: Parameters<typeof deliverCommand>[2]) => deliverCommand(queue, () => 1, action, async () => { effects.push(action); });
  const interpret = vi.fn(async () => null);
  await expect(dispatchVoiceCommand(command('pen down'), enqueue, interpret)).rejects.toThrow('configuration is busy');
  await expect(dispatchVoiceCommand(command('pause'), enqueue, interpret)).resolves.toBe('Paused');
  finish(); await selection;
  expect(effects).toEqual(['pause']);
  expect(interpret).not.toHaveBeenCalled();
});

it('does not interpret bare local keywords or retry rejected actions', async () => {
  const enqueue = vi.fn(async () => { throw new Error('Finish or cancel mouse selection'); });
  const interpret = vi.fn(async () => [{ action: 'undo' as const, times: 1 }]);
  await expect(dispatchVoiceCommand(command('keep going'), enqueue, interpret)).rejects.toThrow('No command heard');
  await expect(dispatchVoiceCommand(command('undo three times', 'wake'), enqueue, interpret)).rejects.toThrow('Finish or cancel mouse selection');
  expect(enqueue).toHaveBeenCalledTimes(1);
  expect(interpret).not.toHaveBeenCalled();
});

it('runs counts and several commands in order, and reports where a sequence stopped', async () => {
  const effects: string[] = [];
  const interpret = vi.fn(async () => null);
  await expect(dispatchVoiceCommand(command('undo twice then brush', 'wake'), async action => { effects.push(action); }, interpret)).resolves.toBe('Undone ×2 · Brush');
  expect(effects).toEqual(['undo', 'undo', 'brush']);
  let calls = 0;
  const failThird = async () => { if (++calls === 3) throw new Error('Click into your Krita document first'); };
  await expect(dispatchVoiceCommand(command('undo 5 times', 'ptt'), failThird, interpret)).rejects.toThrow('Undone ×2, then stopped: Click into your Krita document first');
});

it('a follow-up transcript runs only what the on-device keyword did not, and asks Claude for fuzzy wording', async () => {
  const effects: string[] = [];
  const enqueue = async (action: string) => { effects.push(action); };
  const followUp = (text: string): CommandEvent => ({ ...command(text), alreadyRan: 'undo' });
  await expect(dispatchVoiceCommand(followUp('undo three times'), enqueue, vi.fn(async () => null))).resolves.toBe('Undone ×2');
  await expect(dispatchVoiceCommand(followUp('undo'), enqueue, vi.fn(async () => null))).resolves.toBe('Undone');
  await expect(dispatchVoiceCommand(followUp('you do that'), enqueue, vi.fn(async () => [{ action: 'redo' as const, times: 1 }]))).resolves.toBe('Undone');
  const interpret = vi.fn(async () => [{ action: 'undo' as const, times: 4 }]);
  await expect(dispatchVoiceCommand(followUp('undo, get rid of those lines'), enqueue, interpret)).resolves.toBe('Undone ×3');
  expect(interpret).toHaveBeenCalledWith('undo, get rid of those lines');
  expect(effects).toEqual(['undo', 'undo', 'undo', 'undo', 'undo']);
});

it('open mic: Claude reads what was meant, and speech that is not a request stays silent', async () => {
  const enqueue = vi.fn(async () => undefined);
  const claude = vi.fn(async (text: string) => text.includes('rub') ? [{ action: 'eraser' as const, times: 1 }] : []);
  await expect(dispatchVoiceCommand(command('I want to rub that out', 'open'), enqueue, claude)).resolves.toBe('Eraser');
  expect(enqueue).toHaveBeenCalledWith('eraser');
  await expect(dispatchVoiceCommand(command("yeah I'll be there in five", 'open'), enqueue, claude)).resolves.toBe('');
  // Push-to-talk was a deliberate request, so it still says nothing was heard.
  await expect(dispatchVoiceCommand(command("yeah I'll be there in five", 'ptt'), enqueue, claude)).rejects.toThrow('No command heard');
  expect(enqueue).toHaveBeenCalledTimes(1);
});
