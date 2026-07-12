// COPY of lib/witness/canonicalCheckpointV1.ts — see canonicalLeafV23.mjs
// header for the copy discipline.

export const CHECKPOINT_V1_FIELD_ORDER = [
  'stream_id',
  'epoch_index',
  'first_seq',
  'last_seq',
  'merkle_root',
  'prev_checkpoint_id',
  'is_heartbeat',
  'created_at',
];

export function canonicalCheckpointV1(bundle) {
  const out = {};
  for (const k of CHECKPOINT_V1_FIELD_ORDER) {
    if (k === 'is_heartbeat') {
      out[k] = !!bundle.is_heartbeat;
    } else if (k === 'first_seq' || k === 'last_seq' || k === 'epoch_index') {
      out[k] = bundle[k] ?? 0;
    } else if (k === 'prev_checkpoint_id') {
      out[k] = bundle.prev_checkpoint_id ?? '';
    } else {
      out[k] = bundle[k] ?? '';
    }
  }
  return Buffer.from(JSON.stringify(out), 'utf-8');
}
