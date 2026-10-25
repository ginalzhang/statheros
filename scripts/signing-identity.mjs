import { spawnSync } from 'node:child_process';

/** Self-signed local identity created by `npm run setup:signing`. */
export const SIGNING_IDENTITY = 'Steady Local Signing';

/**
 * A stable identity keeps macOS Microphone/Accessibility grants across rebuilds: TCC pins ad-hoc builds to
 * their code hash, but certificate-signed builds to the certificate. Without it, fall back to ad-hoc ('-').
 */
export function signingIdentity() {
  const result = spawnSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' });
  return result.status === 0 && result.stdout.includes(`"${SIGNING_IDENTITY}"`) ? SIGNING_IDENTITY : '-';
}
