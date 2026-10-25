// Creates the self-signed "Steady Local Signing" code-signing identity in the login keychain (once per Mac).
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { SIGNING_IDENTITY, signingIdentity } from './signing-identity.mjs';

if (signingIdentity() === SIGNING_IDENTITY) { console.log(`"${SIGNING_IDENTITY}" already installed`); process.exit(0); }

const run = (command, args) => {
  const result = spawnSync(command, args, { stdio: ['inherit', 'inherit', 'inherit'] });
  if (result.status !== 0) throw new Error(`${command} ${args[0]} failed (${result.status ?? result.error})`);
};
const keychain = path.join(homedir(), 'Library/Keychains/login.keychain-db');
const dir = mkdtempSync(path.join(tmpdir(), 'steady-signing-'));
try {
  const key = path.join(dir, 'key.pem'), cert = path.join(dir, 'cert.pem'), p12 = path.join(dir, 'identity.p12'), config = path.join(dir, 'cert.cnf');
  writeFileSync(config, [
    '[req]', 'distinguished_name=dn', 'x509_extensions=ext', 'prompt=no',
    '[dn]', `CN=${SIGNING_IDENTITY}`,
    '[ext]', 'basicConstraints=critical,CA:false', 'keyUsage=critical,digitalSignature', 'extendedKeyUsage=critical,codeSigning',
  ].join('\n'));
  run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '3650', '-config', config]);
  const password = randomBytes(18).toString('hex');
  // macOS `security import` only reads the legacy PKCS#12 algorithms.
  run('openssl', ['pkcs12', '-export', '-inkey', key, '-in', cert, '-out', p12, '-passout', `pass:${password}`, '-name', SIGNING_IDENTITY,
    '-keypbe', 'PBE-SHA1-3DES', '-certpbe', 'PBE-SHA1-3DES', '-macalg', 'sha1']);
  run('security', ['import', p12, '-k', keychain, '-P', password, '-T', '/usr/bin/codesign']);
  console.log('Trusting the certificate for code signing; macOS asks for your password once.');
  run('security', ['add-trusted-cert', '-p', 'codeSign', '-k', keychain, cert]);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
if (signingIdentity() !== SIGNING_IDENTITY) throw new Error(`"${SIGNING_IDENTITY}" is not a valid code-signing identity after setup`);
console.log(`Installed "${SIGNING_IDENTITY}". Rebuild, then grant Microphone and Accessibility once more; later rebuilds keep them.`);
