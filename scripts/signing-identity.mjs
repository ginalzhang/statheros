import { spawnSync } from 'node:child_process';

/** Self-signed local identity created by `npm run setup:signing`. */
export const SIGNING_IDENTITY = 'Steady Local Signing';

export function selectSigningIdentity(output) {
  const fingerprints = [...output.matchAll(/^\s*\d+\)\s+([A-Fa-f0-9]{40})\s+"Steady Local Signing"\s*$/gm)]
    .map(match => match[1].toUpperCase()).sort();
  // A certificate name can be duplicated in the keychain. Its fingerprint is
  // unambiguous; sorting keeps our choice stable if security changes list order.
  return fingerprints[0] ?? '-';
}

/**
 * A stable identity keeps macOS Microphone/Accessibility grants across rebuilds: TCC pins ad-hoc builds to
 * their code hash, but certificate-signed builds to the certificate. Without it, fall back to ad-hoc ('-').
 */
export function signingIdentity() {
  const result = spawnSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' });
  return result.status === 0 ? selectSigningIdentity(result.stdout) : '-';
}
