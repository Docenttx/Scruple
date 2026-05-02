// AES-256-GCM symmetric encryption for at-rest secrets (provider API
// keys). KDF input is AUTH_SECRET (or PROVIDER_KEY_KDF if set).
// scrypt → 32-byte key. Output format: <iv:base64>.<authTag:base64>.<ciphertext:base64>

import crypto from 'node:crypto';

const KDF_INPUT = process.env.PROVIDER_KEY_KDF || process.env.AUTH_SECRET || '';
if (!KDF_INPUT) {
  // We let this slide at module load — tests may import without env set.
  // The actual encrypt/decrypt calls will throw clearly if KDF_INPUT empty.
}
const SALT = 'scruple-web-provider-keys-v1'; // static salt is fine: KDF input is per-deploy

let _key: Buffer | null = null;
function key(): Buffer {
  if (_key) return _key;
  if (!KDF_INPUT) throw new Error('AUTH_SECRET (or PROVIDER_KEY_KDF) must be set to encrypt provider keys');
  _key = crypto.scryptSync(KDF_INPUT, SALT, 32);
  return _key;
}

export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${tag.toString('base64')}.${ct.toString('base64')}`;
}

export function decryptSecret(ciphertext: string): string {
  const [iv, tag, ct] = ciphertext.split('.');
  if (!iv || !tag || !ct) throw new Error('Malformed ciphertext');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  const pt = Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]);
  return pt.toString('utf8');
}
