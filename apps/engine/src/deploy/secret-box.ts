import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * AES-256-GCM seal/unseal for server credentials (PEM keys). The master key
 * lives OUTSIDE the database (~/.vision/master.key) so a copied dev.db alone
 * decrypts nothing. Sealed blobs are base64(iv | authTag | ciphertext).
 */

const IV_LEN = 12;
const TAG_LEN = 16;

let cachedKey: Buffer | null = null;

function keyFile(): string {
  return (
    process.env.VISION_MASTER_KEY_FILE ?? path.join(os.homedir(), '.vision', 'master.key')
  );
}

function masterKey(): Buffer {
  if (cachedKey) return cachedKey;
  const file = keyFile();
  if (fs.existsSync(file)) {
    const key = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex');
    if (key.length !== 32) {
      throw new Error(`master key at ${file} is corrupt (expected 32 bytes of hex)`);
    }
    cachedKey = key;
    return key;
  }
  const key = randomBytes(32);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, key.toString('hex') + '\n', { mode: 0o600 });
  cachedKey = key;
  return key;
}

export function seal(plaintext: string): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', masterKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
}

export function unseal(sealed: string): string {
  const buf = Buffer.from(sealed, 'base64');
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', masterKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
