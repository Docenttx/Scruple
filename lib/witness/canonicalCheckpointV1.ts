// Canonical checkpoint bundle for stream checkpoints.
//
// Same discipline as canonicalLeafV23: fixed field order, compact JSON,
// no whitespace, empty-string defaults. This is the byte sequence the
// witness Ed25519/ECDSA signature covers.
//
// CHECKPOINT V1 CONTRACT — DO NOT MUTATE FIELDS OR ORDER.
// Any change requires a v2 module and version bump on new rows.

import { createHash } from 'node:crypto';

export const CHECKPOINT_V1_FIELD_ORDER = [
  'stream_id',
  'epoch_index',
  'first_seq',
  'last_seq',
  'merkle_root',
  'prev_checkpoint_id',
  'is_heartbeat',
  'created_at',
] as const;

export interface CheckpointBundle {
  stream_id: string;
  epoch_index: number;
  first_seq: number;
  last_seq: number;
  merkle_root: string;
  prev_checkpoint_id?: string;
  is_heartbeat: boolean;
  created_at: string;
}

export function canonicalCheckpointV1(bundle: CheckpointBundle): Buffer {
  const out: Record<string, unknown> = {};
  for (const k of CHECKPOINT_V1_FIELD_ORDER) {
    if (k === 'is_heartbeat') {
      out[k] = !!bundle.is_heartbeat;
    } else if (k === 'first_seq' || k === 'last_seq' || k === 'epoch_index') {
      out[k] = (bundle as unknown as Record<string, number | undefined>)[k] ?? 0;
    } else if (k === 'prev_checkpoint_id') {
      out[k] = bundle.prev_checkpoint_id ?? '';
    } else {
      out[k] = (bundle as unknown as Record<string, string | undefined>)[k] ?? '';
    }
  }
  return Buffer.from(JSON.stringify(out), 'utf-8');
}

export function checkpointDigest(bundle: CheckpointBundle): Buffer {
  return createHash('sha256').update(canonicalCheckpointV1(bundle)).digest();
}
