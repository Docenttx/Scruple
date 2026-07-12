// COPY of lib/witness/canonicalLeafV23.ts — kept byte-for-byte compatible.
// The scruple-verify package is intentionally self-contained (no runtime
// dependency on the main app repo). Drift is caught by CI: after any change
// to the master, re-copy + re-run the verifier's fixture tests.

import { createHash } from 'node:crypto';

export const LEAF_V23_FIELD_ORDER = [
  'tenant_id',
  'principal_id',
  'stream_id',
  'tenant_seq',
  'event_time',
  'payload_hash',
  'dims',
];

export function canonicalLeafV23(input) {
  const out = {};
  for (const key of LEAF_V23_FIELD_ORDER) {
    if (key === 'dims') {
      const dims = input.dims ?? {};
      const sortedKeys = Object.keys(dims).sort();
      const sortedDims = {};
      for (const k of sortedKeys) sortedDims[k] = dims[k];
      out.dims = sortedDims;
    } else if (key === 'tenant_seq') {
      out.tenant_seq = input.tenant_seq ?? 0;
    } else {
      out[key] = input[key] ?? '';
    }
  }
  return JSON.stringify(out);
}

export function leafHashV23(input) {
  const preimage = canonicalLeafV23(input);
  return createHash('sha256').update(preimage, 'utf8').digest('hex');
}
