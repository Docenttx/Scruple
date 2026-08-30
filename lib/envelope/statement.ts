// The statement — the layer that binds a predicate to what it is ABOUT.
//
// Shape taken from in-toto's Statement (docs/canon/oss-study/in-toto.md
// §3.1): a `_type`, a `subject` array of resource descriptors, a
// `predicateType` URI, and the predicate itself. The reasoning for the
// split is theirs; the URIs, the subject binding and the versioning are
// ours, and this file deliberately does NOT emit `_type:
// https://in-toto.io/Statement/v1`. Claiming their type URI would assert
// conformance to a spec we have not tested against their verifier, and
// their verifier could not check our predicate anyway (ITE-10/11, the
// mechanism for binding a non-Link predicate, is still Draft).
//
// ── THE SUBJECT IS THE LEAF, AND THE DIGEST IS NOT A NEW HASH ───────────
//
// The leaf rides here VERBATIM. Not normalized, not re-keyed, not
// canonicalized: `leafSubject()` puts the caller's object in and
// `leafFromSubject()` gives the same object back, and the round-trip test
// asserts byte identity through JSON, not merely deep equality. The
// envelope wraps; it does not reshape. Integrity of the leaf comes from
// the DSSE signature over the whole statement, which is precisely why
// nothing here needs to hash it.
//
// The `digest` field is therefore NOT a hash of the leaf JSON. It is the
// leaf's own `output_hash` — sha256 of the raw output bytes, per
// lib/leaf/registry.yaml — which is the one digest a third party holding
// the artifact can actually re-derive, and which is what in-toto's subject
// digest means. Inventing a "hash of the leaf object" here would create a
// second preimage for something that already has one, and
// lib/leaf/hashes.ts opens with why that is the expensive kind of mistake.
//
// ── NO FIELD LIST LIVES IN THIS FILE ────────────────────────────────────
//
// The leaf's shape is lib/leaf/registry.yaml's, and reading a field out of
// a leaf goes through `resolveField` so that `content_hash` (the submit
// and storage spelling) and `output_hash` (the preimage spelling) both
// resolve — that rename is recorded in the registry precisely so callers
// do not have to know which of the two they were handed.

import { resolveField, type LeafSurface } from '@/lib/leaf';

/** The payload media type. Authenticated by PAE; see pae.ts. */
export const SCRUPLE_STATEMENT_PAYLOAD_TYPE = 'application/vnd.scruple.statement+json';

/**
 * The statement's own version, in `_type`, NOT in `payloadType`.
 *
 * in-toto keeps `application/vnd.in-toto+json` stable across statement
 * versions and puts the version inside the payload, and we copy that for a
 * concrete reason: a generic consumer that only checks signatures never has
 * to change when the statement version moves, because the PAE bytes it
 * length-prefixes are described by a media type that did not change.
 */
export const SCRUPLE_STATEMENT_TYPE_BASE = 'https://scruple.ai/attestation/Statement/';
export const SCRUPLE_STATEMENT_VERSION = 1;

export function statementType(version: number = SCRUPLE_STATEMENT_VERSION): string {
  return `${SCRUPLE_STATEMENT_TYPE_BASE}v${version}`;
}

/** A witness leaf, as lib/leaf/registry.yaml defines it. Opaque here. */
export type WitnessLeaf = Record<string, unknown>;

export interface LeafSubject {
  /** Human-readable name. Never load-bearing; in-toto matches on digest. */
  name: string;
  /**
   * The artifact's own sha256 — the leaf's `output_hash`. Re-derivable by
   * anyone holding the bytes. A DigestSet is keyed by algorithm name and
   * nothing else may be put in here.
   */
  digest: { sha256: string };
  /** The leaf, verbatim. */
  leaf: WitnessLeaf;
}

export interface ScrupleStatement<P = unknown> {
  _type: string;
  subject: LeafSubject[];
  predicateType: string;
  predicate: P;
}

export class StatementError extends Error {}

/**
 * Read one registry-defined field off a leaf, whatever spelling the leaf
 * used for it. Returns undefined when the leaf does not carry it.
 *
 * This is the function that makes the round-trip work for a leaf that came
 * off the wire (`content_hash`) and for one lifted out of the canonical
 * record (`output_hash`) without this file knowing there are two names.
 */
export function readLeafField(
  leaf: WitnessLeaf,
  fieldId: string,
  surface?: LeafSurface,
): unknown {
  for (const key of Object.keys(leaf)) {
    const f = resolveField(key, surface);
    if (f?.id === fieldId) return leaf[key];
  }
  return undefined;
}

/**
 * Bind a leaf as the subject of a statement.
 *
 * Refuses a leaf with no output_hash rather than inventing a digest for it.
 * The registry marks output_hash `required` on submit, record and storage;
 * a leaf without one is not a weaker subject, it is an unidentifiable one.
 */
export function leafSubject(leaf: WitnessLeaf, surface?: LeafSurface): LeafSubject {
  const outputHash = readLeafField(leaf, 'output_hash', surface);
  if (typeof outputHash !== 'string' || !/^[0-9a-f]{64}$/.test(outputHash)) {
    throw new StatementError(
      'leaf carries no output_hash (registry id; spelled content_hash on the submit and storage surfaces). ' +
        'The subject digest is the artifact hash and is not synthesised here.',
    );
  }
  const witnessId = readLeafField(leaf, 'witness_id', surface);
  return {
    name: typeof witnessId === 'string' && witnessId ? `scruple:leaf:${witnessId}` : 'scruple:leaf',
    digest: { sha256: outputHash },
    leaf,
  };
}

/** The leaf back out, by reference. No copy, no normalization, no repair. */
export function leafFromSubject(subject: LeafSubject): WitnessLeaf {
  if (!subject || typeof subject !== 'object' || !subject.leaf) {
    throw new StatementError('subject carries no leaf');
  }
  return subject.leaf;
}

export function buildStatement<P>(
  subjects: LeafSubject[],
  predicateType: string,
  predicate: P,
  version: number = SCRUPLE_STATEMENT_VERSION,
): ScrupleStatement<P> {
  if (subjects.length === 0) throw new StatementError('a statement with no subject is about nothing');
  if (!predicateType) throw new StatementError('predicateType must not be empty');
  return { _type: statementType(version), subject: subjects, predicateType, predicate };
}

/** Serialize for the envelope payload. Key order is insertion order and stable. */
export function serializeStatement<P>(s: ScrupleStatement<P>): Buffer {
  return Buffer.from(JSON.stringify(s), 'utf8');
}

/**
 * Parse VERIFIED payload bytes back into a statement.
 *
 * Takes Buffer, not a DsseEnvelope, on purpose: the only bytes that should
 * ever reach here are the ones `verifyEnvelope()` returned. Accepting an
 * envelope would make it possible to parse one that was never verified.
 */
export function parseStatement<P = unknown>(payload: Buffer): ScrupleStatement<P> {
  let raw: unknown;
  try {
    raw = JSON.parse(payload.toString('utf8'));
  } catch (e) {
    throw new StatementError(`statement payload is not JSON: ${String(e)}`);
  }
  const s = raw as ScrupleStatement<P>;
  if (!s || typeof s !== 'object' || Array.isArray(s)) {
    throw new StatementError('statement must be a JSON object');
  }
  if (typeof s._type !== 'string' || !s._type.startsWith(SCRUPLE_STATEMENT_TYPE_BASE)) {
    throw new StatementError(`unrecognised statement _type: ${String(s._type)}`);
  }
  if (!Array.isArray(s.subject) || s.subject.length === 0) {
    throw new StatementError('statement must carry at least one subject');
  }
  if (typeof s.predicateType !== 'string' || !s.predicateType) {
    throw new StatementError('statement must carry a predicateType');
  }
  return s;
}
