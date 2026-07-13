// Canonical leaf preimage for the Scruple audit log — v2.4.
//
// LEAF V24 CONTRACT — DO NOT MUTATE
// =================================
// v2.4 promotes two provenance-bearing hashes to first-class leaf fields
// so they land in the signed preimage and cannot be silently omitted or
// tampered with via the loose `dims` cargo bag:
//
//   - workflow_hash          sha256 of the canonical workflow_api_json
//                            describing which nodes the operator chose,
//                            how they were wired, and with what params.
//                            This is the human-authorship claim.
//
//   - machine_manifest_hash  sha256 of the canonical machine manifest
//                            (ComfyUI version + custom-node pack pinning).
//                            Binds the artist's chosen toolchain into the
//                            leaf so a node swap invalidates the audit.
//
// Both fields default to '' (empty string) when absent. Every leaf emits
// both slots so the JSON shape is stable across use cases.
//
// The rules match v2.3 otherwise:
//   1. Field order per LEAF_V24_FIELD_ORDER.
//   2. Missing string fields default to ''.
//   3. Missing integer fields default to 0.
//   4. `dims` keys sorted alphabetically; absent dims serialize as {}.
//   5. JSON encoding uses no whitespace ({"a":1} not {"a": 1}).
//   6. Non-ASCII characters emitted verbatim as UTF-8.
//
// If v2.4 needs to change:
//   1. Bump to v2.5 by creating parallel new module files
//      (canonicalLeafV25.ts + canonical_leaf_v25.py).
//   2. Add v2.5 fixtures to test/fixtures/canonical-leaf-v25-vectors.json.
//   3. Update verifier CLI's accepted-versions list.
//   4. Bump leaf_scheme default in lib/db/migrations/ on new rows.
// Never edit LEAF_V24_FIELD_ORDER or the JSON encoding conventions
// in this file in place.
//
// Related:
//   - lib/witness/canonicalLeafV23.ts (predecessor)
//   - services/witness/canonical_leaf_v24.py (Python twin)
//   - docs/wo/2026-07-13-node-workflow-provenance/WO-01-leaf-v24.md
//   - docs/architecture/SCRUPLE_INTEGRATION_REQUIREMENTS_v1.md §5

import { createHash } from 'node:crypto';

/** Fixed field order. Do not reorder without version bump. */
export const LEAF_V24_FIELD_ORDER = [
  'tenant_id',
  'principal_id',
  'stream_id',
  'tenant_seq',
  'event_time',
  'payload_hash',
  'workflow_hash',
  'machine_manifest_hash',
  'dims',
] as const;

export type LeafV24FieldName = (typeof LEAF_V24_FIELD_ORDER)[number];

export interface CanonicalLeafV24Input {
  tenant_id: string;
  /** '' when absent — never omit. */
  principal_id?: string;
  stream_id: string;
  tenant_seq: number;
  /** RFC3339 UTC. */
  event_time: string;
  /** e.g. 'sha256:<64-hex>' */
  payload_hash: string;
  /** sha256 of canonicalized workflow_api_json. '' when the event has no workflow. */
  workflow_hash?: string;
  /** sha256 of canonicalized machine manifest. '' when unpinned. */
  machine_manifest_hash?: string;
  /** Optional. Keys canonicalized (sorted). Values must be strings. */
  dims?: Record<string, string>;
}

export function canonicalLeafV24(input: CanonicalLeafV24Input): string {
  const out: Record<string, unknown> = {};
  for (const key of LEAF_V24_FIELD_ORDER) {
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
export function leafHashV24(input: CanonicalLeafV24Input): string {
  const preimage = canonicalLeafV24(input);
  return createHash('sha256').update(preimage, 'utf8').digest('hex');
}

/**
 * Compute chain_hash = sha256(prev_chain_hash_bytes || leaf_hash_bytes).
 * Identical semantics to v2.3 — the chain hash function is not
 * version-scoped, only the leaf preimage is. Same helper is re-exported
 * here so v2.4 callers don't need to reach into the v2.3 module.
 */
export function chainHashV24(prevChainHashHex: string, leafHashHex: string): string {
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

export const CHAIN_HASH_ZERO_V24 = '0'.repeat(64);
