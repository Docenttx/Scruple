// COPY of lib/witness/canonicalLeafV24.ts — kept byte-for-byte compatible.
// Same drift discipline as canonicalLeafV23.mjs; parity-vector tests
// against ../test/fixtures/canonical-leaf-v24-vectors.json in CI.

import { createHash } from 'node:crypto';

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
];

export function canonicalLeafV24(input) {
  const out = {};
  for (const key of LEAF_V24_FIELD_ORDER) {
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

export function leafHashV24(input) {
  return createHash('sha256').update(canonicalLeafV24(input), 'utf8').digest('hex');
}
