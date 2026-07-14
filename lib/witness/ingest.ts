// Core ingest logic for the Continuous Audit API's write path.
//
// Called by app/api/v1/log/[stream_name]/route.ts (single) and
// .../batch/route.ts. Keeps the routes thin — validation, canonicalization,
// contiguity, idempotency, and chain-hash computation all live here so
// the same rules apply to both entry points.
//
// Steps per leaf (canonical design §6.2):
//   1. Resolve stream row for (tenant_id, stream_name).
//   2. Validate principal delegation per stream.principal_mode.
//   3. Field-level validation (payload_hash format, dims values, meta PII
//      denylist, reserved-stream lint, payload_bytes rejection).
//   4. Idempotency lookup (stream_id, idempotency_key).
//   5. Contiguity check against MAX(tenant_seq) — accept gaps, reject
//      replays.
//   6. Compute leaf_hash via canonicalLeafV23.
//   7. Compute chain_hash = sha256(prev_chain_hash || leaf_hash).
//   8. INSERT log_leaves row.
//   9. Compute pending_checkpoint_epoch.

import { canonicalLeafV23, leafHashV23, chainHashV23, CHAIN_HASH_ZERO } from './canonicalLeafV23';
import { leafHashV24 } from './canonicalLeafV24';
import { conn } from '@/lib/db/sqlite';

const HEX64 = /^[0-9a-f]{64}$/;

const PII_DENYLIST_KEY = /^(name|email|phone|ssn|dob|password|address|first_name|last_name)$/i;
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const RESERVED_STREAM_PREFIX = /^(?:_scruple\.|scruple\.)/;

export interface LeafInput {
  tenant_seq: number;
  idempotency_key: string;
  principal_id?: string;
  event_time: string;
  payload_hash: string;
  payload_bytes?: string | null;
  dims?: Record<string, string>;
  meta?: Record<string, unknown>;
  /** v2.4 — SHA-256 of the canonical workflow_api_json. Bare 64-hex string
   *  (no `sha256:` prefix). Presence promotes the leaf to leaf_scheme='v2.4'. */
  workflow_hash?: string;
  /** v2.4 — SHA-256 of the canonical machine manifest. Bare 64-hex string. */
  machine_manifest_hash?: string;
  /** Watermark derivative fields (WATERMARK_DESIGN_v1.md v1.2). When
   *  present, this leaf represents a watermarked derivative of a clean
   *  master (identified by `master_hash` + `ingredient_master_leaf_hash`).
   *  Verifier uses these to establish the master↔derivative lineage. */
  master_hash?: string;
  watermark_payload_hex?: string;
  ingredient_master_leaf_hash?: string;
}

export interface StreamRow {
  stream_id: string;
  tenant_id: string;
  name: string;
  checkpoint_secs: number;
  principal_mode: 'none' | 'fixed' | 'per_leaf';
  fixed_principal: string | null;
  created_at: string;
}

export interface IngestSuccess {
  ok: true;
  stream_id: string;
  tenant_seq: number;
  leaf_hash: string;
  chain_hash: string;
  pending_checkpoint_epoch: number;
  leaf_scheme: 'v2.3' | 'v2.4';
  duplicate?: true;
  gap?: true;
  gap_from?: number;
}

export interface IngestError {
  ok: false;
  code:
    | 'stream_not_found'
    | 'stream_reserved'
    | 'delegation_required'
    | 'delegation_inactive'
    | 'invalid_body'
    | 'invalid_payload_hash'
    | 'invalid_dims_value'
    | 'invalid_master_hash'
    | 'invalid_watermark_payload'
    | 'invalid_ingredient_leaf_hash'
    | 'invalid_workflow_hash'
    | 'invalid_machine_manifest_hash'
    | 'pii_key_in_meta'
    | 'payload_bytes_not_allowed'
    | 'seq_replay';
  detail?: string;
  latest_seq?: number;
}

export type IngestResult = IngestSuccess | IngestError;

function findStream(tenantId: string, streamName: string): StreamRow | null {
  const row = conn()
    .prepare(
      `SELECT stream_id, tenant_id, name, checkpoint_secs, principal_mode,
              fixed_principal, created_at
         FROM streams
        WHERE tenant_id = ? AND name = ?`,
    )
    .get(tenantId, streamName) as StreamRow | undefined;
  return row ?? null;
}

function hasActiveDelegation(principalId: string, tenantId: string): boolean {
  const row = conn()
    .prepare(
      `SELECT 1 FROM delegations
        WHERE principal_id = ? AND tenant_id = ? AND status = 'active'`,
    )
    .get(principalId, tenantId);
  return row !== undefined;
}

function findDuplicate(streamId: string, idempotencyKey: string): IngestSuccess | null {
  const row = conn()
    .prepare(
      `SELECT tenant_seq, leaf_hash, chain_hash, leaf_scheme
         FROM log_leaves
        WHERE stream_id = ? AND idempotency_key = ?`,
    )
    .get(streamId, idempotencyKey) as
    | { tenant_seq: number; leaf_hash: string; chain_hash: string; leaf_scheme: 'v2.3' | 'v2.4' }
    | undefined;
  if (!row) return null;
  return {
    ok: true,
    stream_id: streamId,
    tenant_seq: row.tenant_seq,
    leaf_hash: row.leaf_hash,
    chain_hash: row.chain_hash,
    pending_checkpoint_epoch: 0, // filler; caller may recompute
    leaf_scheme: row.leaf_scheme ?? 'v2.3',
    duplicate: true,
  };
}

function latestSeqAndChain(streamId: string): { seq: number; chain: string } {
  const row = conn()
    .prepare(
      `SELECT tenant_seq, chain_hash FROM log_leaves
        WHERE stream_id = ?
        ORDER BY tenant_seq DESC LIMIT 1`,
    )
    .get(streamId) as { tenant_seq: number; chain_hash: string } | undefined;
  if (!row) return { seq: 0, chain: CHAIN_HASH_ZERO };
  return { seq: row.tenant_seq, chain: row.chain_hash };
}

function pendingCheckpointEpoch(stream: StreamRow, nowMs: number = Date.now()): number {
  // stream.created_at is stored as an ISO-ish string (SQLite strftime with fractional ms).
  const startMs = Date.parse(stream.created_at);
  if (!Number.isFinite(startMs)) return 1;
  const elapsedSecs = Math.max(0, Math.floor((nowMs - startMs) / 1000));
  return Math.floor(elapsedSecs / stream.checkpoint_secs) + 1;
}

/**
 * Ingest a single leaf. All auth (bearer + HMAC + rate limit) is expected
 * to have been checked by the caller (route handler). This function
 * enforces the schema + business rules and writes the row.
 */
export function ingestLeaf(
  tenant: { tenant_id: string; is_internal: boolean },
  streamName: string,
  input: LeafInput,
): IngestResult {
  // Stream-name lint — only internal tenant may write to reserved
  // namespaces.
  if (!tenant.is_internal && RESERVED_STREAM_PREFIX.test(streamName)) {
    return { ok: false, code: 'stream_reserved', detail: `stream name "${streamName}" is reserved` };
  }

  const stream = findStream(tenant.tenant_id, streamName);
  if (!stream) {
    return { ok: false, code: 'stream_not_found', detail: `no stream ${streamName} for tenant` };
  }

  // Basic field validation.
  if (!Number.isInteger(input.tenant_seq) || input.tenant_seq <= 0) {
    return { ok: false, code: 'invalid_body', detail: 'tenant_seq must be positive integer' };
  }
  if (!input.idempotency_key || input.idempotency_key.length > 255) {
    return { ok: false, code: 'invalid_body', detail: 'idempotency_key length 1..255' };
  }
  if (Number.isNaN(Date.parse(input.event_time))) {
    return { ok: false, code: 'invalid_body', detail: 'event_time must parse as ISO 8601' };
  }
  if (!HASH_PATTERN.test(input.payload_hash)) {
    return { ok: false, code: 'invalid_payload_hash' };
  }
  if (input.payload_bytes !== undefined && input.payload_bytes !== null) {
    // Zero-content posture: no stream in Sprint 1 accepts payload_bytes.
    return { ok: false, code: 'payload_bytes_not_allowed' };
  }
  if (input.dims) {
    for (const [k, v] of Object.entries(input.dims)) {
      if (typeof v !== 'string' || !HASH_PATTERN.test(v)) {
        return { ok: false, code: 'invalid_dims_value', detail: `dims.${k} must match sha256:<64hex>` };
      }
    }
  }
  // v2.4 first-class fields. Bare 64-hex; leaf preimage folds them in
  // verbatim without the sha256: prefix. Empty string means absent.
  if (input.workflow_hash !== undefined && input.workflow_hash !== '' && !HEX64.test(input.workflow_hash)) {
    return { ok: false, code: 'invalid_workflow_hash', detail: 'workflow_hash must be 64 lowercase hex chars (no sha256: prefix)' };
  }
  if (input.machine_manifest_hash !== undefined && input.machine_manifest_hash !== '' && !HEX64.test(input.machine_manifest_hash)) {
    return { ok: false, code: 'invalid_machine_manifest_hash', detail: 'machine_manifest_hash must be 64 lowercase hex chars' };
  }
  // Watermark derivative fields (WATERMARK_DESIGN_v1.md v1.2 §7.4).
  // When any one is present, all three must be present and valid — the
  // whole point is establishing the master↔derivative lineage cleanly.
  const hasWmField =
    input.master_hash !== undefined ||
    input.watermark_payload_hex !== undefined ||
    input.ingredient_master_leaf_hash !== undefined;
  if (hasWmField) {
    if (!input.master_hash || !HEX64.test(input.master_hash)) {
      return { ok: false, code: 'invalid_master_hash', detail: 'master_hash must be 64 lowercase hex chars' };
    }
    if (!input.watermark_payload_hex || !/^[0-9a-f]{32}$/.test(input.watermark_payload_hex)) {
      return { ok: false, code: 'invalid_watermark_payload', detail: 'watermark_payload_hex must be 32 lowercase hex chars (128 bits)' };
    }
    // Payload magic + version gate (per WATERMARK_DESIGN §3)
    if (input.watermark_payload_hex.slice(0, 2) !== '5c') {
      return { ok: false, code: 'invalid_watermark_payload', detail: 'watermark_payload_hex first byte must be magic 0x5c' };
    }
    const versionNibble = parseInt(input.watermark_payload_hex.charAt(2), 16);
    if (versionNibble !== 1) {
      return { ok: false, code: 'invalid_watermark_payload', detail: `unsupported watermark version: ${versionNibble}` };
    }
    if (!input.ingredient_master_leaf_hash || !HEX64.test(input.ingredient_master_leaf_hash)) {
      return { ok: false, code: 'invalid_ingredient_leaf_hash', detail: 'ingredient_master_leaf_hash must be 64 lowercase hex chars' };
    }
  }
  if (input.meta) {
    for (const k of Object.keys(input.meta)) {
      if (PII_DENYLIST_KEY.test(k)) {
        return { ok: false, code: 'pii_key_in_meta', detail: `meta.${k} is on the PII denylist` };
      }
    }
  }

  // Principal resolution per stream.principal_mode.
  let principalId: string;
  if (stream.principal_mode === 'none') {
    if (input.principal_id) {
      return { ok: false, code: 'invalid_body', detail: 'stream principal_mode=none but principal_id supplied' };
    }
    principalId = '';
  } else if (stream.principal_mode === 'fixed') {
    principalId = stream.fixed_principal ?? '';
    if (!principalId) {
      return { ok: false, code: 'invalid_body', detail: 'stream has principal_mode=fixed but no fixed_principal' };
    }
    // Ignore body-provided principal_id in fixed mode.
  } else {
    // per_leaf
    if (!input.principal_id) {
      return { ok: false, code: 'delegation_required', detail: 'stream requires principal_id on every leaf' };
    }
    principalId = input.principal_id;
    if (!hasActiveDelegation(principalId, tenant.tenant_id)) {
      return { ok: false, code: 'delegation_inactive' };
    }
  }

  // Idempotency: existing row wins, we return the prior correlation.
  const dup = findDuplicate(stream.stream_id, input.idempotency_key);
  if (dup) {
    dup.pending_checkpoint_epoch = pendingCheckpointEpoch(stream);
    return dup;
  }

  // Contiguity.
  const latest = latestSeqAndChain(stream.stream_id);
  if (input.tenant_seq <= latest.seq) {
    return { ok: false, code: 'seq_replay', latest_seq: latest.seq };
  }
  const isGap = input.tenant_seq > latest.seq + 1;

  // Hash the leaf. `principal_id` empty string when absent, per canonical
  // module. When workflow_hash OR machine_manifest_hash is present, use
  // v2.4 which folds them into the preimage as first-class fields. Otherwise
  // fall back to v2.3 for backward compatibility with existing tenants.
  const workflowHash = input.workflow_hash ?? '';
  const manifestHash = input.machine_manifest_hash ?? '';
  const leafScheme: 'v2.3' | 'v2.4' = (workflowHash || manifestHash) ? 'v2.4' : 'v2.3';
  const leafHash = leafScheme === 'v2.4'
    ? leafHashV24({
        tenant_id: tenant.tenant_id,
        principal_id: principalId,
        stream_id: stream.stream_id,
        tenant_seq: input.tenant_seq,
        event_time: input.event_time,
        payload_hash: input.payload_hash,
        workflow_hash: workflowHash,
        machine_manifest_hash: manifestHash,
        dims: input.dims,
      })
    : leafHashV23({
        tenant_id: tenant.tenant_id,
        principal_id: principalId,
        stream_id: stream.stream_id,
        tenant_seq: input.tenant_seq,
        event_time: input.event_time,
        payload_hash: input.payload_hash,
        dims: input.dims,
      });
  // chainHashV23 and V24 are byte-identical (chain hash is not version-scoped);
  // we call the v2.3 export as the canonical name.
  const chainHash = chainHashV23(latest.chain, leafHash);

  // Fold gap flag into meta before persisting.
  const metaOut: Record<string, unknown> = { ...(input.meta ?? {}) };
  if (isGap) {
    metaOut.gap = true;
    metaOut.gap_from = latest.seq + 1;
  }

  conn()
    .prepare(
      `INSERT INTO log_leaves
         (stream_id, principal_id, tenant_seq, leaf_hash, prev_chain_hash,
          chain_hash, event_time, idempotency_key, payload_hash, dims_json, meta_json,
          workflow_hash, machine_manifest_hash, leaf_scheme)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      stream.stream_id,
      principalId || null,
      input.tenant_seq,
      leafHash,
      latest.chain,
      chainHash,
      input.event_time,
      input.idempotency_key,
      input.payload_hash,
      input.dims ? JSON.stringify(input.dims) : null,
      Object.keys(metaOut).length ? JSON.stringify(metaOut) : null,
      workflowHash || null,
      manifestHash || null,
      leafScheme,
    );

  const result: IngestSuccess = {
    ok: true,
    stream_id: stream.stream_id,
    tenant_seq: input.tenant_seq,
    leaf_hash: leafHash,
    chain_hash: chainHash,
    pending_checkpoint_epoch: pendingCheckpointEpoch(stream),
    leaf_scheme: leafScheme,
  };
  if (isGap) {
    result.gap = true;
    result.gap_from = latest.seq + 1;
  }
  return result;
}
