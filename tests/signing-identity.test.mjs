import { test } from 'vitest';
import assert from 'node:assert/strict';
import { selectSigningIdentity } from '../scripts/signing-identity.mjs';

const first = '1'.repeat(40), second = '2'.repeat(40);
const row = (index, fingerprint, name = 'Steady Local Signing') => `  ${index}) ${fingerprint} "${name}"`;

test('selects an unambiguous fingerprint when certificate names are duplicated', () => {
  assert.equal(selectSigningIdentity([row(1, second), row(2, first)].join('\n')), first);
  assert.equal(selectSigningIdentity([row(1, first), row(2, second)].join('\n')), first);
});

test('ignores other identities and invalid certificate entries', () => {
  assert.equal(selectSigningIdentity(`${row(1, first, 'Other Signing')}\n${row(2, second)} (CSSMERR_TP_CERT_EXPIRED)`), '-');
  assert.equal(selectSigningIdentity('  0 valid identities found'), '-');
});

test('accepts the exact signing name and normalizes fingerprints', () => {
  assert.equal(selectSigningIdentity(row(1, 'ab'.repeat(20))), 'AB'.repeat(20));
  assert.equal(selectSigningIdentity(row(1, first, 'Steady Local Signing Copy')), '-');
});
