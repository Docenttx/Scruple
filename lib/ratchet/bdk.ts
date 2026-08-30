// Custody of the Base Derivation Key.
//
// WHERE THE BDK IS SUPPOSED TO LIVE. §4.1: "32B, generated in and never
// leaving the signer HSM (OCI Vault, the key already in the TOE)". §9
// settles who holds it: Scruple, because a vendor-held BDK lets a vendor
// forge their own tenants' leaves and makes component identity theirs
// rather than ours. Vendor-held remains available as a declared,
// receipt-visible variant for a sovereignty-constrained vendor, and the
// claim weakens correspondingly.
//
// WHERE IT ACTUALLY LIVES TODAY. In this environment variable. This is the
// surrogate-era stand-in, exactly as H-1's leaf signing is "implemented
// against the surrogate" rather than in the CVM (L2_AS_THE_VENDOR_FLOOR.md).
// A BDK in a process environment is readable by anything that can read
// /proc/self/environ, which is not the bar §4.1 sets. It is written this
// way so that moving to the HSM changes this one file and no caller:
// everything else in lib/ratchet asks for `bdk()` and does not care.
//
// FAIL CLOSED. Modelled on the SECRET block in
// services/witness-server/server.js, which was itself a fix: that secret
// used to fall back to a constant published in the same file, so every
// leaf it sealed was forgeable by anyone who had read the source, and
// nothing downstream could tell — the seal verified perfectly, against a
// key everybody had. A BDK with a default would be that, once per
// component, forever. There is no default here.

import crypto from 'node:crypto';

const MIN_BDK_BYTES = 32;

// The published dev constant. It is published deliberately: a dev key that
// looks like a secret is worse than one that obviously is not, because
// somebody eventually ships it. Reaching it requires SCRUPLE_BDK_ALLOW_DEV=1,
// the same shape as SCRUPLE_WITNESS_ALLOW_DEV_SECRET=1.
const DEV_BDK_HEX = 'de7de7de7de7de7de7de7de7de7de7de7de7de7de7de7de7de7de7de7de7de7d';

let cached: Buffer | null = null;

function fatal(lines: string[]): never {
  for (const l of lines) console.error(`[ratchet] ${l}`);
  process.exit(1);
}

/**
 * The BDK, or the process does not continue.
 *
 * Every component's IK is HKDF(BDK, component_id). A wrong BDK does not
 * fail loudly — it silently rejects every genuine component's MAC while
 * accepting every component provisioned under the same wrong value, so
 * the estate splits in two and both halves look healthy. Hence: exact
 * length checks, no truncation, no coercion.
 */
export function bdk(): Buffer {
  if (cached) return cached;

  const hex = process.env.SCRUPLE_BDK_HEX;

  if (hex !== undefined && hex !== '') {
    const trimmed = hex.trim();
    if (!/^[0-9a-fA-F]+$/.test(trimmed) || trimmed.length % 2 !== 0) {
      fatal([
        'FATAL: SCRUPLE_BDK_HEX is not an even-length hex string.',
        'Refusing to start rather than deriving component keys from a',
        'value that is not the key you think it is.',
      ]);
    }
    const buf = Buffer.from(trimmed, 'hex');
    if (buf.length < MIN_BDK_BYTES) {
      fatal([
        `FATAL: SCRUPLE_BDK_HEX decodes to ${buf.length} bytes; ${MIN_BDK_BYTES} is the minimum.`,
        'The spec (§4.1) says 32 bytes. A short BDK narrows the keyspace',
        'for every component derived from it, not just this one.',
      ]);
    }
    cached = buf;
    return cached;
  }

  if (process.env.SCRUPLE_BDK_ALLOW_DEV === '1') {
    console.warn('[ratchet] WARNING: running with the PUBLISHED DEV BDK.');
    console.warn('[ratchet] Every component IK derived by this process is');
    console.warn('[ratchet] computable by anyone who has read lib/ratchet/bdk.ts.');
    console.warn('[ratchet] Never in production.');
    cached = Buffer.from(DEV_BDK_HEX, 'hex');
    return cached;
  }

  fatal([
    'FATAL: SCRUPLE_BDK_HEX is not set.',
    'The base derivation key backs every capture component in the estate.',
    'Refusing to start rather than inventing one: a BDK invented at boot',
    'silently invalidates every already-provisioned component, and a BDK',
    'with a published default is forgeable by anyone who read the source.',
    'Set SCRUPLE_BDK_HEX to 32+ bytes of hex, or set SCRUPLE_BDK_ALLOW_DEV=1',
    'to accept a forgeable one deliberately.',
  ]);
}

/** Test-only: drop the memoised BDK so a test can change the env var. */
export function resetBdkCache(): void {
  if (cached) cached.fill(0);
  cached = null;
}

/** A fingerprint of the BDK, safe to log and to store on a component row.
 *  Lets an operator tell "wrong BDK" from "bad MAC" without ever printing
 *  the key — the split-estate failure above is otherwise invisible. */
export function bdkFingerprint(): string {
  return crypto.createHash('sha256').update(bdk()).digest('hex').slice(0, 16);
}
