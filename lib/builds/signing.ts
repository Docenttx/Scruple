// The registry signing key (H-4 §10 C-4, WO-15).
//
// Ed25519, seed in SCRUPLE_BUILD_REGISTRY_KEY_HEX, read LAZILY inside the
// function — the same shape as lib/ratchet/bdk.ts, and for the same
// reason: a module that reads the environment at import time cannot be
// tested without a process per key, and cannot be rotated without a
// restart.
//
// WHAT IT IS NOT. This key does not sign the component, and it does not
// vouch for the component's behaviour. It signs the STATEMENT "Scruple
// published measurement X for component Y at time T", and later "…and
// withdrew it at T'". A verifier holding the public key can check that
// statement without our cooperation and without trusting the database it
// came out of, which is the whole reason the registry is signed rather
// than merely stored: WRITE ACCESS TO THE DATABASE IS NOT PUBLICATION.
// Someone who can INSERT a row cannot make it verify.
//
// WHY IT FAILS CLOSED AND lib/ratchet/verify.ts DOES NOT. Publication is
// an administrative act on our own side of the boundary; refusing to
// publish without a key suppresses nothing, because no artifact exists
// yet that would go unrecorded. Ingest is the opposite — refusing there
// destroys evidence of an artifact that already exists — which is why the
// check at ingest degrades to a recorded status and never to a rejection.
// Two different postures, one rule: fail closed where failing closed
// costs evidence nothing.

import crypto from 'node:crypto';

export class BuildRegistryKeyError extends Error {}

export const SIGNATURE_ALG = 'ed25519' as const;

/** RFC 8410 PKCS#8 prefix for a bare Ed25519 seed. */
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
/** RFC 8410 SPKI prefix for a bare Ed25519 public key. */
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export interface RegistrySigner {
  keyId: string;
  publicKeyHex: string;
  sign(preimage: Buffer): string;
}

function privateKeyFromSeed(seed: Buffer): crypto.KeyObject {
  return crypto.createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
}

export function publicKeyFromHex(publicKeyHex: string): crypto.KeyObject {
  const raw = Buffer.from(publicKeyHex, 'hex');
  if (raw.length !== 32) {
    throw new BuildRegistryKeyError('An Ed25519 public key is 32 bytes / 64 hex chars.');
  }
  return crypto.createPublicKey({
    key: Buffer.concat([SPKI_ED25519_PREFIX, raw]),
    format: 'der',
    type: 'spki',
  });
}

/**
 * A key id anyone can recompute from the public key alone.
 *
 * Derived rather than assigned, so a registry entry naming a key id and a
 * verifier holding a public key can be paired up with no third artifact
 * to look the mapping up in — the same reason `bdk_fingerprint` exists on
 * `components`, where a rotated key otherwise presents as every component
 * in the estate suddenly failing with nothing to say why.
 */
export function keyIdFor(publicKeyHex: string): string {
  return crypto.createHash('sha256').update(Buffer.from(publicKeyHex, 'hex')).digest('hex').slice(0, 32);
}

/** The configured signer, or a typed error naming the missing variable. */
export function registrySigner(): RegistrySigner {
  const hex = process.env.SCRUPLE_BUILD_REGISTRY_KEY_HEX;
  if (!hex) {
    throw new BuildRegistryKeyError(
      'SCRUPLE_BUILD_REGISTRY_KEY_HEX is not set, so nothing can be published to the ' +
        'build registry. Generate one with `node --import tsx lib/builds/cli.ts keygen`. ' +
        'Publishing fails closed on purpose: an unsigned registry entry would be ' +
        'indistinguishable from a row somebody INSERTed.',
    );
  }
  const seed = Buffer.from(hex.trim(), 'hex');
  if (seed.length !== 32) {
    throw new BuildRegistryKeyError(
      `SCRUPLE_BUILD_REGISTRY_KEY_HEX must be 32 bytes / 64 hex chars; got ${seed.length} bytes.`,
    );
  }
  const priv = privateKeyFromSeed(seed);
  const pubHex = Buffer.from(
    crypto.createPublicKey(priv).export({ format: 'der', type: 'spki' }),
  )
    .subarray(SPKI_ED25519_PREFIX.length)
    .toString('hex');

  return {
    keyId: keyIdFor(pubHex),
    publicKeyHex: pubHex,
    sign: (preimage: Buffer) => crypto.sign(null, preimage, priv).toString('hex'),
  };
}

/** The public half, when there is one. Null rather than throwing: a
 *  read-only surface listing the registry must still answer on a host
 *  that holds no signing key, and saying "unsigned-here" is honest where
 *  omitting the field would read as "unsigned". */
export function registryPublicKey(): { keyId: string; publicKeyHex: string; alg: string } | null {
  try {
    const s = registrySigner();
    return { keyId: s.keyId, publicKeyHex: s.publicKeyHex, alg: SIGNATURE_ALG };
  } catch {
    return null;
  }
}

export function verifyDetached(preimage: Buffer, signatureHex: string, publicKeyHex: string): boolean {
  try {
    return crypto.verify(
      null,
      preimage,
      publicKeyFromHex(publicKeyHex),
      Buffer.from(signatureHex, 'hex'),
    );
  } catch {
    return false;
  }
}

/** For `cli.ts keygen` and for tests. Never called on an ingest path. */
export function generateSeedHex(): string {
  return crypto.randomBytes(32).toString('hex');
}
