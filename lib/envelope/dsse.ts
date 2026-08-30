// The DSSE envelope: serialization and authentication, and NOTHING ELSE.
//
// SPEC: https://github.com/secure-systems-lab/dsse/blob/master/envelope.md
//
//   { "payload": "<base64>", "payloadType": "<string>",
//     "signatures": [ { "keyid": "<optional string>", "sig": "<base64>" } ] }
//
// `payload`, `payloadType`, `signatures` and `signatures[].sig` are
// required (possibly empty); `keyid` is optional and an absent keyid is
// treated identically to an empty string. Either standard or URL-safe
// base64 is permitted. Unrecognised fields are ignored, not rejected.
//
// ── WHY THIS FILE KNOWS NOTHING ABOUT P1–P8 ─────────────────────────────
//
// This is the whole point of WO-2. Before it, a leaf was a flat object and
// the compliance vocabulary was fused into the signed thing: adding a
// property, renaming an enforcement mechanism or versioning the placement
// model meant changing the shape that gets signed, which means changing
// what every existing verifier must understand in order to check a
// signature it does not care about the meaning of.
//
// in-toto splits this four ways (docs/canon/oss-study/in-toto.md §3.1) and
// the payoff is read straight off their versioning policy: a new predicate
// type is a PATCH release because "none of these changes affects the
// semantics of the core spec". Their envelope spec says a verifier
// "SHOULD NOT require the verifier to parse the payload before verifying"
// — that non-requirement IS the split, expressed mechanically.
//
// So: nothing in this file or in pae.ts may name a predicate, a property,
// a placement or a surface. `test/v2/envelope.test.ts` scans both files'
// source and fails if one does. That test is not decoration — it is the
// only thing that stops the split being reintroduced by a convenience
// import six months from now.
//
// ── ONE HARD RULE, TAKEN FROM THE SPEC ──────────────────────────────────
//
// envelope.md: an implementation "MUST ensure that the same payload bytes
// that are verified are the ones sent to the application layer" and must
// not re-parse the envelope after verification. `verifyEnvelope()`
// therefore RETURNS the verified bytes. A caller that verifies and then
// calls `decodePayload()` again has written the bug the rule exists to
// prevent, and the API is shaped so the correct path is the shorter one.

import crypto from 'node:crypto';
import { pae } from './pae';

export interface DsseSignature {
  /** Optional per the spec. Absent and '' are the same thing. */
  keyid?: string;
  /** base64 of the raw signature bytes. */
  sig: string;
}

export interface DsseEnvelope {
  /** base64 of the payload bytes. */
  payload: string;
  payloadType: string;
  signatures: DsseSignature[];
}

/**
 * Signs PAE bytes. Deliberately not "signs a payload": a signer that took
 * a payload could be handed one without its type, which is the confusion
 * PAE exists to prevent.
 */
export interface EnvelopeSigner {
  /** '' is legal — the spec treats absent and empty identically. */
  keyid: string;
  sign(paeBytes: Buffer): Buffer;
}

export interface EnvelopeVerifier {
  keyid: string;
  verify(paeBytes: Buffer, sig: Buffer): boolean;
}

export class EnvelopeError extends Error {}

/* ── base64 ───────────────────────────────────────────────────────────── */

/** Emit standard base64 with padding. Both variants are legal; pick one. */
function b64(buf: Buffer): string {
  return buf.toString('base64');
}

/** Accept either variant, per the spec. */
function unb64(s: string, what: string): Buffer {
  const normalized = s.replace(/-/g, '+').replace(/_/g, '/');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    throw new EnvelopeError(`${what} is not base64`);
  }
  return Buffer.from(normalized, 'base64');
}

/* ── construction ─────────────────────────────────────────────────────── */

/**
 * Wrap a payload and sign it. Multiple signers produce multiple signatures
 * over the SAME PAE bytes — the spec's m-of-n shape, not a countersignature
 * chain.
 */
export function signEnvelope(
  payloadType: string,
  payload: Uint8Array | string,
  signers: EnvelopeSigner[],
): DsseEnvelope {
  if (!payloadType) throw new EnvelopeError('payloadType must not be empty');
  if (signers.length === 0) throw new EnvelopeError('an envelope with no signature authenticates nothing');

  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload);
  const paeBytes = pae(payloadType, body);

  return {
    payload: b64(body),
    payloadType,
    signatures: signers.map((s) => ({ keyid: s.keyid, sig: b64(s.sign(paeBytes)) })),
  };
}

/* ── verification ─────────────────────────────────────────────────────── */

export interface EnvelopeVerification {
  /**
   * THE verified bytes. Use these; do not decode the envelope again.
   * envelope.md's rule about the payload the application layer sees.
   */
  payload: Buffer;
  payloadType: string;
  /** keyids whose signature verified. May contain ''. */
  acceptedKeyIds: string[];
}

/**
 * Verify at least `threshold` distinct verifiers over the envelope.
 *
 * A verifier is tried against every signature, not only against the one
 * whose `keyid` matches: keyid is a HINT (in-toto's own verifier treats it
 * that way), and a producer that omitted it must not therefore be
 * unverifiable. A verifier counts once however many signatures it matches.
 *
 * Throws on failure rather than returning a false-ish value, so a caller
 * cannot reach the payload without having passed.
 */
export function verifyEnvelope(
  envelope: DsseEnvelope,
  verifiers: EnvelopeVerifier[],
  opts: { threshold?: number } = {},
): EnvelopeVerification {
  const threshold = opts.threshold ?? 1;
  if (threshold < 1) throw new EnvelopeError('threshold must be at least 1');

  assertEnvelopeShape(envelope);

  const body = unb64(envelope.payload, 'payload');
  const paeBytes = pae(envelope.payloadType, body);

  const accepted: string[] = [];
  for (const v of verifiers) {
    for (const s of envelope.signatures) {
      let ok = false;
      try {
        ok = v.verify(paeBytes, unb64(s.sig, 'sig'));
      } catch {
        ok = false;
      }
      if (ok) {
        accepted.push(v.keyid);
        break;
      }
    }
  }

  if (accepted.length < threshold) {
    throw new EnvelopeError(
      `envelope did not meet the signature threshold: ${accepted.length} of ${threshold}`,
    );
  }

  return { payload: body, payloadType: envelope.payloadType, acceptedKeyIds: accepted };
}

/**
 * Decode the payload WITHOUT verifying anything.
 *
 * Named to be uncomfortable at a call site. Legitimate for inspection,
 * logging and debugging; never legitimate as the input to a decision. If
 * you want the payload for a decision, call verifyEnvelope and use what it
 * hands back.
 */
export function decodeUnverifiedPayload(envelope: DsseEnvelope): Buffer {
  assertEnvelopeShape(envelope);
  return unb64(envelope.payload, 'payload');
}

/* ── serialization ────────────────────────────────────────────────────── */

export function serializeEnvelope(envelope: DsseEnvelope): string {
  assertEnvelopeShape(envelope);
  return JSON.stringify(envelope);
}

/**
 * Parse and shape-check. Unrecognised top-level fields are dropped rather
 * than rejected — the spec requires consumers to ignore fields added by
 * producers or by a future version — and dropping them here means they can
 * never be mistaken for something this code understood.
 */
export function parseEnvelope(json: string): DsseEnvelope {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    throw new EnvelopeError(`envelope is not JSON: ${String(e)}`);
  }
  const o = raw as Record<string, unknown>;
  if (!o || typeof o !== 'object' || Array.isArray(o)) {
    throw new EnvelopeError('envelope must be a JSON object');
  }
  const envelope: DsseEnvelope = {
    payload: o.payload as string,
    payloadType: o.payloadType as string,
    signatures: Array.isArray(o.signatures)
      ? (o.signatures as Record<string, unknown>[]).map((s) => {
          const sig: DsseSignature = { sig: s?.sig as string };
          if (typeof s?.keyid === 'string') sig.keyid = s.keyid;
          return sig;
        })
      : (undefined as unknown as DsseSignature[]),
  };
  assertEnvelopeShape(envelope);
  return envelope;
}

function assertEnvelopeShape(e: DsseEnvelope): void {
  if (typeof e?.payload !== 'string') throw new EnvelopeError('payload must be a base64 string');
  if (typeof e?.payloadType !== 'string' || e.payloadType.length === 0) {
    throw new EnvelopeError('payloadType must be a non-empty string');
  }
  if (!Array.isArray(e.signatures)) throw new EnvelopeError('signatures must be an array');
  for (const s of e.signatures) {
    if (typeof s?.sig !== 'string') throw new EnvelopeError('signatures[].sig must be a base64 string');
    if (s.keyid !== undefined && typeof s.keyid !== 'string') {
      throw new EnvelopeError('signatures[].keyid must be a string when present');
    }
  }
}

/* ── an ECDSA P-256 signer, because the spec's own vector is one ─────────
 *
 * DSSE's protocol.md worked example is ECDSA over NIST P-256 with SHA-256
 * and a raw r||s signature (IEEE P1363), which is what
 * `dsaEncoding: 'ieee-p1363'` selects. Node's ECDSA is not RFC 6979
 * deterministic, so we cannot reproduce the spec's signature BYTES — but we
 * can verify them, and verifying them is the stronger test: the spec's
 * signature only checks out if our PAE bytes are exactly the spec's PAE
 * bytes, which makes protocol.md's vector an end-to-end check of this file
 * and pae.ts together.
 *
 * These helpers are here so tests and the reference path have a signer at
 * all. They are not a key-custody story — P3 custody is the component's
 * (H-4 §4), and nothing here should be read as one.
 * ─────────────────────────────────────────────────────────────────────── */

export function ecdsaP256Signer(privateKey: crypto.KeyObject, keyid = ''): EnvelopeSigner {
  return {
    keyid,
    sign: (paeBytes) =>
      crypto.sign('sha256', paeBytes, { key: privateKey, dsaEncoding: 'ieee-p1363' }),
  };
}

export function ecdsaP256Verifier(publicKey: crypto.KeyObject, keyid = ''): EnvelopeVerifier {
  return {
    keyid,
    verify: (paeBytes, sig) =>
      crypto.verify('sha256', paeBytes, { key: publicKey, dsaEncoding: 'ieee-p1363' }, sig),
  };
}
