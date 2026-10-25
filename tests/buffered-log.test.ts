import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { BufferedLog } from '../src/main/buffered-log';
let root: string;
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });
it('serializes concurrent flushes, rotates bounded files and keeps write order', async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'steady-log-'));
  const filename = path.join(root, 'log.jsonl'), log = new BufferedLog(filename, 32);
  log.write('one\n'); log.write('two\n');
  await Promise.all([log.flush(), log.flush()]);
  expect(await readFile(filename, 'utf8')).toBe('one\ntwo\n');
  log.write('a'.repeat(28)); await log.flush();
  expect(await readFile(`${filename}.1`, 'utf8')).toBe('one\ntwo\n');
  expect((await stat(filename)).size).toBeLessThanOrEqual(32);
});
it('bounds the pending queue and tolerates an unwritable log destination', async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'steady-log-'));
  const filename = path.join(root, 'bounded'), log = new BufferedLog(filename, 8);
  log.write('1234'); log.write('5678'); log.write('abcd');
  await log.flush(); expect(await readFile(filename, 'utf8')).toBe('5678abcd');
  const broken = new BufferedLog(path.join(filename, 'cannot-be-a-directory'));
  broken.write('ignored'); await expect(broken.flush()).resolves.toBeUndefined();
});
