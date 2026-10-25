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
  const interpret = vi.fn(async () => 'resume' as const);
  await expect(dispatchVoiceCommand(command('resume'), enqueue, interpret)).rejects.toThrow('Confirm the canvas');
  await expect(dispatchVoiceCommand(command('keep going', 'ptt'), enqueue, interpret)).rejects.toThrow('Confirm the canvas');
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

it('does not interpret local misses, multiple commands, or retry rejected actions', async () => {
  const enqueue = vi.fn(async () => { throw new Error('Finish or cancel mouse selection'); });
  const interpret = vi.fn(async () => 'undo' as const);
  await expect(dispatchVoiceCommand(command('keep going'), enqueue, interpret)).rejects.toThrow('No command heard');
  await expect(dispatchVoiceCommand(command('undo and redo', 'wake'), enqueue, interpret)).rejects.toThrow('more than one');
  await expect(dispatchVoiceCommand(command('undo'), enqueue, interpret)).rejects.toThrow('Finish or cancel mouse selection');
  expect(enqueue).toHaveBeenCalledTimes(1);
  expect(interpret).not.toHaveBeenCalled();
});
