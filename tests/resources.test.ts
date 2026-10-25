import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const app = vi.hoisted(() => ({ isPackaged: false, getAppPath: vi.fn() }));
vi.mock('electron', () => ({ app }));
import { verifyResources } from '../src/main/resources';
let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'steady-assets-'));
  app.getAppPath.mockReturnValue(root);
  await mkdir(path.join(root, 'resources/assets'), { recursive: true });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it('verifies streamed model contents and rejects a changed byte', async () => {
  const bytes = Buffer.alloc(200_000, 42);
  const filename = path.join(root, 'resources/assets/model.task');
  await writeFile(filename, bytes);
  await writeFile(path.join(root, 'resources/asset-manifest.json'), JSON.stringify({ assets: [{ path: 'model.task', sha256: createHash('sha256').update(bytes).digest('hex') }] }));
  await expect(verifyResources()).resolves.toBeUndefined();
  bytes[100_000] = 43; await writeFile(filename, bytes);
  await expect(verifyResources()).rejects.toThrow('Corrupt local asset: model.task');
});

it('rejects paths outside the asset directory and an empty manifest', async () => {
  const manifest = path.join(root, 'resources/asset-manifest.json');
  await writeFile(manifest, JSON.stringify({ assets: [{ path: '../outside', sha256: '' }] }));
  await expect(verifyResources()).rejects.toThrow('Invalid asset path');
  await writeFile(manifest, JSON.stringify({ assets: [] }));
  await expect(verifyResources()).rejects.toThrow('Missing model/runtime manifest');
});
