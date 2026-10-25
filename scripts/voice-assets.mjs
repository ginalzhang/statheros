// Restore and verify the local voice models (resources/voice/models) and stage the native
// sherpa-onnx addon outside ASAR for packaging (resources/voice/addon). Hashes are pinned in
// resources/voice/manifest.json. `--fetch` downloads; without it, files are only verified.
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const root = 'resources/voice';
const manifest = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const models = path.join(root, 'models');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const fetchBytes = async url => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Voice asset fetch failed: ${url}: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
};
const fetching = process.argv.includes('--fetch');
mkdirSync(models, { recursive: true });

for (const archive of manifest.archives) {
  const missing = archive.files.some(file => !existsSync(path.join(models, file.path)) || sha(readFileSync(path.join(models, file.path))) !== file.sha256);
  if (missing && fetching) {
    const bytes = await fetchBytes(archive.source);
    if (sha(bytes) !== archive.sha256) throw new Error(`Voice archive hash mismatch: ${archive.source}`);
    const scratch = mkdtempSync(path.join(os.tmpdir(), 'steady-voice-'));
    try {
      writeFileSync(path.join(scratch, 'archive.tar.bz2'), bytes);
      execFileSync('tar', ['xjf', 'archive.tar.bz2', ...archive.files.map(file => `${archive.root}/${file.from}`)], { cwd: scratch });
      for (const file of archive.files) {
        const destination = path.join(models, file.path);
        mkdirSync(path.dirname(destination), { recursive: true });
        cpSync(path.join(scratch, archive.root, file.from), destination);
      }
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  }
  for (const file of archive.files) {
    const actual = sha(readFileSync(path.join(models, file.path)));
    if (actual !== file.sha256) throw new Error(`Voice asset hash mismatch: ${file.path}`);
    console.log(`verified voice/${file.path}`);
  }
}
for (const file of manifest.files) {
  const destination = path.join(models, file.path);
  if (fetching && (!existsSync(destination) || sha(readFileSync(destination)) !== file.sha256)) writeFileSync(destination, await fetchBytes(file.source));
  if (sha(readFileSync(destination)) !== file.sha256) throw new Error(`Voice asset hash mismatch: ${file.path}`);
  console.log(`verified voice/${file.path}`);
}
// Native addon (+ its dylibs) must live outside ASAR; resolved by createRequire at runtime.
const addon = path.join(root, 'addon', 'node_modules');
rmSync(path.join(root, 'addon'), { recursive: true, force: true });
for (const name of manifest.addon) {
  const source = path.join('node_modules', name);
  if (!existsSync(source)) throw new Error(`Missing ${source}; run npm ci`);
  cpSync(source, path.join(addon, name), { recursive: true });
}
writeFileSync(path.join(root, 'addon', 'index.js'), '// createRequire anchor for the packaged voice addon\n');
console.log('staged voice addon');
