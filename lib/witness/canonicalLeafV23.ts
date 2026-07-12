// Canonical leaf preimage for the Scruple audit log.
//
// LEAF V23 CONTRACT — DO NOT MUTATE
// =================================
// The field list and encoding rules below are the load-bearing invariant
// of the entire audit chain. Changing them silently breaks:
//   - The parity guarantee between this module and its Python twin
//     (services/witness/canonical_leaf_v23.py).
//   - The verifier CLI's re-derivation of leaf hashes from proof
//     bundles.
//   - The audit trail of every leaf ever ingested against this schema.
//
// If you need to change the leaf shape:
//   1. Bump to v24 by creating parallel new module files
//      (canonicalLeafV24.ts + canonical_leaf_v24.py).
//   2. Add v24 fixtures to test/fixtures/canonical-leaf-v24-vectors.json.
//   3. Update the verifier CLI's accepted-versions list.
//   4. Update lib/db/migrations/ with a leaf_scheme column bump on
//      new rows.
// Never edit LEAF_V23_FIELD_ORDER or the JSON encoding conventions
// in this file in place.
//
// Related:
//   - docs/architecture/CANONICAL_SCRUPLE_WITNESSING_L2.md §6.3
//   - docs/architecture/SCRUPLE_CONTINUOUS_AUDIT_API_DESIGN.md §5.1
//   - docs/wo/2026-07-12-witnessing-l2/WO-05-audit-api-schema.md

import { createHash } from 'node:crypto';

/** Fixed field order. Do not reorder without version bump. */
export const LEAF_V23_FIELD_ORDER = [
  'tenant_id',
  'principal_id',
  'stream_id',
  'tenant_seq',
  'event_time',
  'payload_hash',
  'dims',
] as const;

export type LeafV23FieldName = (typeof LEAF_V23_FIELD_ORDER)[number];

export interface CanonicalLeafV23Input {
  tenant_id: string;
  /** '' when absent — never omit. */
  principal_id?: string;
  stream_id: string;
  tenant_seq: number;
  /** RFC3339 UTC. */
  event_time: string;
  /** e.g. 'sha256:<64-hex>' */
  payload_hash: string;
  /** Optional. Keys are canonicalized (sorted). Values must be strings. */
  dims?: Record<string, string>;
}

/**
 * Return the canonical UTF-8 preimage bytes for a leaf.
 *
 * Rules (all load-bearing):
 *   1. Field order per LEAF_V23_FIELD_ORDER.
 *   2. Missing string fields default to empty string ''.
 *   3. Missing integer fields default to 0.
 *   4. `dims` keys are sorted alphabetically for determinism; absent
 *      dims serialize as {}.
 *   5. JSON encoding uses no whitespace ({"a":1} not {"a": 1}).
 *   6. Non-ASCII characters are emitted verbatim as UTF-8 (JSON.stringify
 *      does NOT escape by default in modern Node).
 */
export function canonicalLeafV23(input: CanonicalLeafV23Input): string {
  const out: Record<string, unknown> = {};
  for (const key of LEAF_V23_FIELD_ORDER) {
    if (key === 'dims') {
      const dims = input.dims ?? {};
      const sortedKeys = Object.keys(dims).sort();
      const sortedDims: Record<string, string> = {};
      for (const k of sortedKeys) sortedDims[k] = dims[k];
      out.dims = sortedDims;
    } else if (key === 'tenant_seq') {
      out.tenant_seq = input.tenant_seq ?? 0;
    } else {
      out[key] = (input as unknown as Record<string, unknown>)[key] ?? '';
    }
  }
  return JSON.stringify(out);
}

/** Return the 64-character lowercase-hex SHA-256 of the canonical preimage. */
export function leafHashV23(input: CanonicalLeafV23Input): string {
  const preimage = canonicalLeafV23(input);
  return createHash('sha256').update(preimage, 'utf8').digest('hex');
}

/**
 * Compute chain_hash = sha256(prev_chain_hash_bytes || leaf_hash_bytes).
 * Both inputs are lowercase 64-char hex strings; input is decoded to bytes
 * before hashing so cross-language parity is byte-level, not text-level.
 * For the first leaf on a stream, pass 64 zero characters.
 */
export function chainHashV23(prevChainHashHex: string, leafHashHex: string): string {
  if (prevChainHashHex.length !== 64) {
    throw new Error(`prev_chain_hash must be 64 hex chars, got ${prevChainHashHex.length}`);
  }
  if (leafHashHex.length !== 64) {
    throw new Error(`leaf_hash must be 64 hex chars, got ${leafHashHex.length}`);
  }
  const prev = Buffer.from(prevChainHashHex, 'hex');
  const leaf = Buffer.from(leafHashHex, 'hex');
  return createHash('sha256').update(Buffer.concat([prev, leaf])).digest('hex');
}

export const CHAIN_HASH_ZERO = '0'.repeat(64);
