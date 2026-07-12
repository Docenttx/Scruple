// Checkpoint signer — Ed25519 by default; OCI Vault swap comes under WO-01.
//
// This module is designed as a Signer.from_callback-style seam so the local
// key path (used today, in-process, cryptography-library style) can be
// swapped for an OCI Vault callback later without changing any caller.
//
// Local key file at `data/witness/checkpoint-signer.ed25519.pem` is
// auto-generated on first use if absent. It is gitignored by convention —
// treat like any private key. When OCI Vault lands (WO-01), the CI /
// deploy path removes this file and env-configures the Vault OCID; the
// signer callback below is the only code that changes.
//
// The witness trust manifest published at /.well-known/witness-trust.json
// reads the PUBLIC half of this key so verifiers can look it up.

import { createPrivateKey, createPublicKey, generateKeyPairSync, KeyObject, sign as nodeSign } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const KEY_DIR = process.env.SCRUPLE_WITNESS_KEY_DIR ?? path.join(process.cwd(), 'data', 'witness');
const PRIV_PATH = path.join(KEY_DIR, 'checkpoint-signer.ed25519.pem');
const PUB_PATH = path.join(KEY_DIR, 'checkpoint-signer.ed25519.pub.pem');
export const WITNESS_KEY_ID = process.env.SCRUPLE_WITNESS_CHECKPOINT_KEY_ID ?? 'scruple-witness-checkpoint-dev';
export const WITNESS_KEY_ALG = 'ED25519';

let cachedPriv: KeyObject | null = null;
let cachedPubPem: string | null = null;

function ensureKeyMaterial(): void {
  if (fs.existsSync(PRIV_PATH) && fs.existsSync(PUB_PATH)) return;
  fs.mkdirSync(KEY_DIR, { recursive: true });
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const privPem = privateKey.export({ format: 'pem', type: 'pkcs8' }) as string;
  const pubPem = publicKey.export({ format: 'pem', type: 'spki' }) as string;
  fs.writeFileSync(PRIV_PATH, privPem, { mode: 0o600 });
  fs.writeFileSync(PUB_PATH, pubPem, { mode: 0o644 });
}

function getPriv(): KeyObject {
  if (cachedPriv) return cachedPriv;
  ensureKeyMaterial();
  cachedPriv = createPrivateKey(fs.readFileSync(PRIV_PATH));
  return cachedPriv;
}

/** Return the checkpoint pubkey as PEM. Trust manifest reads this. */
export function getCheckpointPublicKeyPem(): string {
  if (cachedPubPem) return cachedPubPem;
  ensureKeyMaterial();
  cachedPubPem = fs.readFileSync(PUB_PATH, 'utf-8');
  return cachedPubPem;
}

/**
 * Sign an arbitrary digest with the current checkpoint key.
 * Ed25519 takes the whole message (not a pre-hashed digest) so we pass the
 * canonical checkpoint bundle bytes directly — the signature covers the
 * bundle, not sha256(bundle).
 *
 * Return: 64-byte Ed25519 signature as hex.
 */
export function signCheckpointBytes(bundleBytes: Buffer): string {
  const priv = getPriv();
  const sig = nodeSign(null, bundleBytes, priv);
  return sig.toString('hex');
}
