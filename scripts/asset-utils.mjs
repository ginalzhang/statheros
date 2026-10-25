import { createHash } from 'node:crypto';
import { createReadStream, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export async function hashFile(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}
async function treeDigest(root) {
  const hash = createHash('sha256');
  async function visit(relative) {
    const filename = path.join(root, relative), info = lstatSync(filename);
    hash.update(JSON.stringify([relative, info.mode & 0o777]));
    if (info.isSymbolicLink()) hash.update(`link:${readlinkSync(filename)}`);
    else if (info.isDirectory()) for (const name of readdirSync(filename).sort()) await visit(path.join(relative, name));
    else hash.update(await hashFile(filename));
  }
  await visit(''); return hash.digest('hex');
}

const ANCHOR = '// createRequire anchor for the packaged voice addon\n';
/** Verify content, permissions and file lists; preserve a correct staging tree without copying it again. */
export async function stageAddon(sourceRoot, destination, names) {
  const expected = await Promise.all(names.map(async name => {
    const source = path.join(sourceRoot, name);
    if (!existsSync(source)) throw new Error(`Missing ${source}; run npm ci`);
    return [name, await treeDigest(source)];
  }));
  try {
    const installed = path.join(destination, 'node_modules');
    const matchingRoot = JSON.stringify(readdirSync(destination).sort()) === JSON.stringify(['index.js', 'node_modules']);
    const matchingNames = JSON.stringify(readdirSync(installed).sort()) === JSON.stringify([...names].sort());
    if (matchingRoot && matchingNames && readFileSync(path.join(destination, 'index.js'), 'utf8') === ANCHOR &&
        (await Promise.all(expected.map(async ([name, digest]) => await treeDigest(path.join(installed, name)) === digest))).every(Boolean)) return false;
  } catch { /* Missing or corrupt staging is replaced below. */ }
  mkdirSync(path.dirname(destination), { recursive: true });
  const scratch = mkdtempSync(`${destination}.stage-`);
  try {
    for (const name of names) cpSync(path.join(sourceRoot, name), path.join(scratch, 'node_modules', name), { recursive: true, verbatimSymlinks: true });
    writeFileSync(path.join(scratch, 'index.js'), ANCHOR);
    rmSync(destination, { recursive: true, force: true }); renameSync(scratch, destination);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
  return true;
}
