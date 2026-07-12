// Per-stream checkpoint tick — the core action of the scheduler.
//
// This module is pure logic — the outer loop (BullMQ, setInterval, or the
// scripts/run-checkpoint-tick.ts helper) calls tickOne() for each active
// stream on its schedule.
//
// Per-tick per stream:
//   1. Look up latest checkpoint for the stream.
//   2. Fetch leaves after last checkpoint's last_seq.
//   3. If empty → heartbeat checkpoint (root = sha256(prev.merkle_root)).
//      Bootstrap heartbeat (no prior + no leaves) uses a self-descriptive
//      root — see below.
//   4. Otherwise build a balanced Merkle over the leaf hashes.
//   5. Assemble the canonical checkpoint bundle, sign it, INSERT.

import { createHash } from 'node:crypto';
import { conn } from '@/lib/db/sqlite';
import { buildBalancedMerkle } from './merkle';
import {
  canonicalCheckpointV1,
  type CheckpointBundle,
} from './canonicalCheckpointV1';
import {
  signCheckpointBytes,
  WITNESS_KEY_ID,
} from './checkpointSign';
import { checkpointIdFromMerkleRootHex } from './streamIds';

interface StreamRow {
  stream_id: string;
  name: string;
  tenant_id: string;
  checkpoint_secs: number;
}

interface CheckpointRow {
  checkpoint_id: string;
  epoch_index: number;
  first_seq: number;
  last_seq: number;
  merkle_root: string;
  prev_checkpoint: string | null;
  is_heartbeat: number;
}

interface LeafRow {
  tenant_seq: number;
  leaf_hash: string;
}

export interface TickResult {
  stream_id: string;
  action: 'wrote_checkpoint' | 'wrote_heartbeat' | 'no_prior_no_leaves_bootstrapped' | 'skipped';
  checkpoint_id?: string;
  epoch_index?: number;
  first_seq?: number;
  last_seq?: number;
  reason?: string;
}

function listActiveStreams(): StreamRow[] {
  return conn()
    .prepare(`SELECT stream_id, name, tenant_id, checkpoint_secs FROM streams`)
    .all() as StreamRow[];
}

function latestCheckpoint(streamId: string): CheckpointRow | null {
  const r = conn()
    .prepare(
      `SELECT checkpoint_id, epoch_index, first_seq, last_seq, merkle_root,
              prev_checkpoint, is_heartbeat
         FROM log_checkpoints
        WHERE stream_id = ?
        ORDER BY epoch_index DESC LIMIT 1`,
    )
    .get(streamId) as CheckpointRow | undefined;
  return r ?? null;
}

function leavesAfter(streamId: string, afterSeq: number): LeafRow[] {
  return conn()
    .prepare(
      `SELECT tenant_seq, leaf_hash FROM log_leaves
        WHERE stream_id = ? AND tenant_seq > ?
        ORDER BY tenant_seq`,
    )
    .all(streamId, afterSeq) as LeafRow[];
}

/**
 * Advance the checkpoint chain for one stream by one tick.
 * Returns a structured description of what happened for logging/audit.
 */
export function tickOne(stream: StreamRow, now: Date = new Date()): TickResult {
  const prior = latestCheckpoint(stream.stream_id);
  const afterSeq = prior?.last_seq ?? 0;
  const leaves = leavesAfter(stream.stream_id, afterSeq);
  const nowIso = now.toISOString();

  let bundle: CheckpointBundle;
  let action: TickResult['action'];

  if (leaves.length === 0) {
    if (!prior) {
      // Bootstrap heartbeat — no leaves ever, no prior checkpoint.
      // Root = sha256(canonical bundle with empty root placeholder); we
      // recurse once because the bundle contains its own root, so we use
      // a two-pass fixed-point: fill root with zeros, hash the bundle,
      // use that hash AS the root.
      const provisional: CheckpointBundle = {
        stream_id: stream.stream_id,
        epoch_index: 1,
        first_seq: 0,
        last_seq: 0,
        merkle_root: '0'.repeat(64),
        prev_checkpoint_id: '',
        is_heartbeat: true,
        created_at: nowIso,
      };
      const rootHex = createHash('sha256')
        .update(canonicalCheckpointV1(provisional))
        .digest('hex');
      bundle = { ...provisional, merkle_root: rootHex };
      action = 'no_prior_no_leaves_bootstrapped';
    } else {
      // Standard heartbeat — root = sha256(prev.merkle_root bytes).
      const priorRootBytes = Buffer.from(prior.merkle_root, 'hex');
      const rootHex = createHash('sha256').update(priorRootBytes).digest('hex');
      bundle = {
        stream_id: stream.stream_id,
        epoch_index: prior.epoch_index + 1,
        first_seq: prior.last_seq,
        last_seq: prior.last_seq,
        merkle_root: rootHex,
        prev_checkpoint_id: prior.checkpoint_id,
        is_heartbeat: true,
        created_at: nowIso,
      };
      action = 'wrote_heartbeat';
    }
  } else {
    const tree = buildBalancedMerkle(leaves.map((l) => l.leaf_hash));
    bundle = {
      stream_id: stream.stream_id,
      epoch_index: (prior?.epoch_index ?? 0) + 1,
      first_seq: leaves[0].tenant_seq,
      last_seq: leaves[leaves.length - 1].tenant_seq,
      merkle_root: tree.root,
      prev_checkpoint_id: prior?.checkpoint_id ?? '',
      is_heartbeat: false,
      created_at: nowIso,
    };
    action = 'wrote_checkpoint';
  }

  const bundleBytes = canonicalCheckpointV1(bundle);
  const sigHex = signCheckpointBytes(bundleBytes);
  const checkpointId = checkpointIdFromMerkleRootHex(bundle.merkle_root);

  conn()
    .prepare(
      `INSERT INTO log_checkpoints
         (checkpoint_id, stream_id, epoch_index, first_seq, last_seq,
          merkle_root, prev_checkpoint, witness_sig, witness_key_id,
          is_heartbeat, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      checkpointId,
      bundle.stream_id,
      bundle.epoch_index,
      bundle.first_seq,
      bundle.last_seq,
      bundle.merkle_root,
      bundle.prev_checkpoint_id || null,
      sigHex,
      WITNESS_KEY_ID,
      bundle.is_heartbeat ? 1 : 0,
      bundle.created_at,
    );

  return {
    stream_id: stream.stream_id,
    action,
    checkpoint_id: checkpointId,
    epoch_index: bundle.epoch_index,
    first_seq: bundle.first_seq,
    last_seq: bundle.last_seq,
  };
}

/** Convenience: tick every active stream once. */
export function tickAll(now: Date = new Date()): TickResult[] {
  const streams = listActiveStreams();
  return streams.map((s) => tickOne(s, now));
}
