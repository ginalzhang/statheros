import { expect, it } from 'vitest';
import { ConfigurationQueue } from '../src/main/configuration';
import { deliverCommand } from '../src/main/command-delivery';

it('discards commands during an in-flight configuration immediately, while safety release bypasses it', async () => {
  const queue = new ConfigurationQueue(); let generation = 1; const effects: string[] = [];
  let finish!: () => void;
  const configuration = queue.run(async () => { await new Promise<void>(resolve => { finish = resolve; }); generation++; });
  await Promise.resolve();
  const down = deliverCommand(queue, () => generation, 'penDown', async () => { effects.push('down'); });
  await expect(down).rejects.toThrow('configuration is busy');
  await deliverCommand(queue, () => generation, 'pause', async () => { effects.push('release'); });
  expect(effects).toEqual(['release']);
  finish(); await configuration;
  expect(effects).toEqual(['release']);
  await deliverCommand(queue, () => generation, 'undo', async () => { effects.push('undo'); });
  expect(effects).toEqual(['release', 'undo']);
});
it('queues Krita shortcuts behind an in-flight configuration instead of discarding them', async () => {
  const queue = new ConfigurationQueue(); let generation = 1; const effects: string[] = [];
  let finish!: () => void;
  const configuration = queue.run(async () => { await new Promise<void>(resolve => { finish = resolve; }); generation++; effects.push('configured'); });
  await Promise.resolve();
  const actions = ['undo', 'eraser', 'swapColors'] as const;
  const pending = actions.map(action => deliverCommand(queue, () => generation, action, async () => { effects.push(action); }));
  finish(); await configuration; await Promise.all(pending);
  expect(effects).toEqual(['configured', ...actions]);
});
