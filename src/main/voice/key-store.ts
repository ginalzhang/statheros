import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface Encryptor { isEncryptionAvailable(): boolean; encryptString(value: string): Buffer; decryptString(value: Buffer): string }

/**
 * CARTESIA_API_KEY from the environment wins; otherwise a key entered in Settings, encrypted with the
 * OS keychain (Electron safeStorage). The key lives in the main process only and is never sent back.
 */
export class KeyStore {
  constructor(private readonly filename: string, private readonly crypto: Encryptor, private readonly env: NodeJS.ProcessEnv = process.env) {}
  get source(): 'env' | 'settings' | null { return this.env.CARTESIA_API_KEY?.trim() ? 'env' : existsSync(this.filename) ? 'settings' : null; }
  get(): string | null {
    const fromEnv = this.env.CARTESIA_API_KEY?.trim();
    if (fromEnv) return fromEnv;
    try { return this.crypto.decryptString(readFileSync(this.filename)).trim() || null; } catch { return null; }
  }
  set(key: string): void {
    const value = key.trim();
    if (!/^[\x21-\x7e]{16,256}$/.test(value)) throw new Error('That does not look like a Cartesia API key.');
    if (!this.crypto.isEncryptionAvailable()) throw new Error('Keychain encryption is unavailable; set CARTESIA_API_KEY instead.');
    mkdirSync(path.dirname(this.filename), { recursive: true });
    const temporary = `${this.filename}.tmp`;
    writeFileSync(temporary, this.crypto.encryptString(value), { mode: 0o600 });
    renameSync(temporary, this.filename);
  }
  clear(): void { rmSync(this.filename, { force: true }); }
}
