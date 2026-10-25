// Restore and verify the local voice models (resources/voice/models) and stage the native
// sherpa-onnx addon outside ASAR for packaging (resources/voice/addon). Hashes are pinned in
// resources/voice/manifest.json. `--fetch` downloads; without it, files are only verified.
import { createHash } from 'node:crypto';
import { hashFile, stageAddon } from './asset-utils.mjs';
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
  const verified = new Set();
  if (fetching) for (const file of archive.files) {
    const filename = path.join(models, file.path);
    if (existsSync(filename) && await hashFile(filename) === file.sha256) verified.add(file.path);
  }
  const missing = verified.size !== archive.files.length;
  if (missing && fetching) {
    const bytes = await fetchBytes(archive.source);
    if (sha(bytes) !== archive.sha256) throw new Error(`Voice archive hash mismatch: ${archive.source}`);
    const scratch = mkdtempSync(path.join(os.tmpdir(), 'steady-voice-'));
    try {
      writeFileSync(path.join(scratch, 'archive.tar.bz2'), bytes);
      execFileSync('tar', ['xjf', 'archive.tar.bz2', ...archive.files.map(file => `${archive.root}/${file.from}`)], { cwd: scratch });
      verified.clear();
      for (const file of archive.files) {
        const destination = path.join(models, file.path);
        mkdirSync(path.dirname(destination), { recursive: true });
        cpSync(path.join(scratch, archive.root, file.from), destination);
      }
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  }
  for (const file of archive.files) {
    const actual = verified.has(file.path) ? file.sha256 : await hashFile(path.join(models, file.path));
    if (actual !== file.sha256) throw new Error(`Voice asset hash mismatch: ${file.path}`);
    console.log(`verified voice/${file.path}`);
  }
}
for (const file of manifest.files) {
  const destination = path.join(models, file.path);
  let actual = existsSync(destination) ? await hashFile(destination) : null;
  if (fetching && actual !== file.sha256) {
    const bytes = await fetchBytes(file.source); actual = sha(bytes);
    if (actual !== file.sha256) throw new Error(`Voice asset hash mismatch: ${file.path}`);
    writeFileSync(destination, bytes);
  }
  if (actual !== file.sha256) throw new Error(`Voice asset hash mismatch: ${file.path}`);
  console.log(`verified voice/${file.path}`);
}
// Native addon (+ its dylibs) must live outside ASAR; resolved by createRequire at runtime.
const staged = await stageAddon('node_modules', path.join(root, 'addon'), manifest.addon);
console.log(staged ? 'staged voice addon' : 'verified existing voice addon');
