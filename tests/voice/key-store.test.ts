import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { expect, it } from 'vitest';
import { KeyStore } from '../../src/main/voice/key-store';
it('uses the same trimmed environment-key precedence for reading and editing', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'steady-key-'));
  try {
    const env = { CARTESIA_API_KEY: '   ' };
    const store = new KeyStore(path.join(root, 'key.bin'), { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: bytes => bytes.toString() }, env);
    expect(store.source).toBeNull();
    store.set('saved-test-key-00000000');
    expect(store.source).toBe('settings'); expect(store.get()).toBe('saved-test-key-00000000');
    env.CARTESIA_API_KEY = ' env-test-key-0000000000 ';
    expect(store.source).toBe('env'); expect(store.get()).toBe('env-test-key-0000000000');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
