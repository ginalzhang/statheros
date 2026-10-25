import { app } from 'electron';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
export function resourcesRoot(): string { return app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), 'resources'); }
export async function verifyResources(): Promise<void> {
  const root = resourcesRoot();
  const manifest = JSON.parse(await readFile(path.join(root, 'asset-manifest.json'), 'utf8')) as { assets: {path:string;sha256:string}[] };
  if (!Array.isArray(manifest.assets) || !manifest.assets.length) throw new Error('Missing model/runtime manifest');
  for (const asset of manifest.assets) {
    const filename = path.resolve(root, 'assets', asset.path);
    if (!filename.startsWith(path.resolve(root,'assets')+path.sep)) throw new Error('Invalid asset path');
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(filename)) hash.update(chunk);
    const actual = hash.digest('hex');
    if (actual !== asset.sha256) throw new Error(`Corrupt local asset: ${asset.path}`);
  }
}
