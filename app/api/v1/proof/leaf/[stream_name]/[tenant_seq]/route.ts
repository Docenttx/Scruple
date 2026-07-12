// GET /api/v1/proof/leaf/{stream_name}/{tenant_seq}
//
// Returns the full proof bundle for one leaf: canonical leaf fields,
// leaf_hash, inclusion path up to the checkpoint's merkle_root, the
// signed canonical checkpoint bundle, and (when landed) the anchor
// super-root inclusion. Sprint 1 stops at the checkpoint layer —
// anchor fields are null until WO-12 (super-root scheduler) lands.
//
// Auth: PUBLIC. Proof bundles are inherently public — the whole point
// is third-party verifiability. No rate limit at this layer either;
// verifiers of a single receipt shouldn't get throttled.

import { NextRequest, NextResponse } from 'next/server';
import { conn } from '@/lib/db/sqlite';
import { buildBalancedMerkle } from '@/lib/witness/merkle';

export const dynamic = 'force-dynamic';

interface StreamRow {
  stream_id: string;
  tenant_id: string;
  name: string;
}

interface LeafRow {
  tenant_seq: number;
  leaf_hash: string;
  chain_hash: string;
  event_time: string;
  idempotency_key: string;
  payload_hash: string;
  dims_json: string | null;
  meta_json: string | null;
  principal_id: string | null;
}

interface CheckpointRow {
  checkpoint_id: string;
  stream_id: string;
  epoch_index: number;
  first_seq: number;
  last_seq: number;
  merkle_root: string;
  prev_checkpoint: string | null;
  witness_sig: string;
  witness_key_id: string;
  tsa_token_b64: string | null;
  is_heartbeat: number;
  created_at: string;
  anchored_in: string | null;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { stream_name: string; tenant_seq: string } },
) {
  const seq = Number(params.tenant_seq);
  if (!Number.isFinite(seq) || seq <= 0) {
    return NextResponse.json({ error: 'invalid_tenant_seq' }, { status: 400 });
  }

  const db = conn();
  // Look up stream — the stream_name in the URL is the human name.
  const stream = db
    .prepare(`SELECT stream_id, tenant_id, name FROM streams WHERE name = ?`)
    .get(params.stream_name) as StreamRow | undefined;
  if (!stream) return NextResponse.json({ error: 'stream_not_found' }, { status: 404 });

  const leaf = db
    .prepare(
      `SELECT tenant_seq, leaf_hash, chain_hash, event_time, idempotency_key,
              payload_hash, dims_json, meta_json, principal_id
         FROM log_leaves
        WHERE stream_id = ? AND tenant_seq = ?`,
    )
    .get(stream.stream_id, seq) as LeafRow | undefined;
  if (!leaf) return NextResponse.json({ error: 'leaf_not_found' }, { status: 404 });

  // Find the smallest checkpoint whose range covers this leaf.
  const ckpt = db
    .prepare(
      `SELECT *
         FROM log_checkpoints
        WHERE stream_id = ? AND first_seq <= ? AND last_seq >= ? AND is_heartbeat = 0
        ORDER BY epoch_index ASC LIMIT 1`,
    )
    .get(stream.stream_id, seq, seq) as CheckpointRow | undefined;

  if (!ckpt) {
    // Leaf is later than the last non-heartbeat checkpoint — return the
    // leaf + latest checkpoint metadata so the caller knows to poll.
    const latest = db
      .prepare(
        `SELECT epoch_index, is_heartbeat FROM log_checkpoints WHERE stream_id = ? ORDER BY epoch_index DESC LIMIT 1`,
      )
      .get(stream.stream_id) as { epoch_index: number; is_heartbeat: number } | undefined;
    return NextResponse.json(
      {
        error: 'leaf_pending_checkpoint',
        leaf: publicLeaf(stream, leaf),
        latest_epoch: latest?.epoch_index ?? 0,
      },
      { status: 202 },
    );
  }

  // Fetch ALL leaves in this checkpoint range to rebuild the tree +
  // extract the inclusion path.
  const rangeLeaves = db
    .prepare(
      `SELECT tenant_seq, leaf_hash FROM log_leaves
        WHERE stream_id = ? AND tenant_seq >= ? AND tenant_seq <= ?
        ORDER BY tenant_seq`,
    )
    .all(stream.stream_id, ckpt.first_seq, ckpt.last_seq) as Array<{ tenant_seq: number; leaf_hash: string }>;

  const leafIdx = rangeLeaves.findIndex((l) => l.tenant_seq === leaf.tenant_seq);
  const tree = buildBalancedMerkle(rangeLeaves.map((l) => l.leaf_hash));
  const inclusion = tree.inclusionPath(leafIdx);

  return NextResponse.json({
    leaf: publicLeaf(stream, leaf),
    inclusion,
    checkpoint: {
      bundle: {
        stream_id: ckpt.stream_id,
        epoch_index: ckpt.epoch_index,
        first_seq: ckpt.first_seq,
        last_seq: ckpt.last_seq,
        merkle_root: ckpt.merkle_root,
        prev_checkpoint_id: ckpt.prev_checkpoint ?? '',
        is_heartbeat: ckpt.is_heartbeat === 1,
        created_at: ckpt.created_at,
      },
      checkpoint_id: ckpt.checkpoint_id,
      witness_sig: ckpt.witness_sig,
      witness_key_id: ckpt.witness_key_id,
      tsa_token_b64: ckpt.tsa_token_b64,
    },
    anchor: ckpt.anchored_in
      ? {
          anchor_id: ckpt.anchored_in,
          // Populated once WO-12 (super-root anchoring) ships.
          super_root: null,
          rvn_txid: null,
          ipfs_cid: null,
          arweave_id: null,
        }
      : null,
  });
}

function publicLeaf(stream: StreamRow, leaf: LeafRow) {
  return {
    tenant_id: stream.tenant_id,
    principal_id: leaf.principal_id ?? '',
    stream_id: stream.stream_id,
    tenant_seq: leaf.tenant_seq,
    event_time: leaf.event_time,
    payload_hash: leaf.payload_hash,
    dims: leaf.dims_json ? JSON.parse(leaf.dims_json) : {},
    meta: leaf.meta_json ? JSON.parse(leaf.meta_json) : {},
    leaf_hash: leaf.leaf_hash,
    chain_hash: leaf.chain_hash,
  };
}
