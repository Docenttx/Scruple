// Baseline DAO. Backs the /api/v1/tenants/[tenant]/baseline/* routes.
//
// Per Standard v1.2 §3 and Integration Requirements v1.2 §2 P7/P8.
//
// v1 keeps baseline events in the `baselines` table only; wiring them
// into the audit-log stream for public chain-lock happens in WO-15.
// `witness_leaf_id` is left NULL for now — populated in WO-15.

import { conn } from '@/lib/db/sqlite';
import { createHash } from 'node:crypto';

export interface BaselineRow {
  id: number;
  tenant_id: string;
  baseline_hash: string;
  prev_baseline_hash: string | null;
  manifest_json: string;
  attestation_provider: string;
  attestation_envelope_json: string | null;
  signer_pubkey_spki_sha256_hex: string;
  reason: string | null;
  submitted_at: string;
  activated_at: string;
  retired_at: string | null;
  witness_leaf_id: number | null;
}

export interface InsertBaselineArgs {
  tenant_id: string;
  baseline_hash: string;
  manifest_json: string;
  attestation_provider: string;
  attestation_envelope_json: string | null;
  signer_pubkey_spki_sha256_hex: string;
  submitted_at: string;
}

export interface InsertRebaselineArgs extends InsertBaselineArgs {
  prev_baseline_hash: string;
  reason: string | null;
}

export interface InsertResult {
  baseline_id: number;
  activated_at: string;
}

export class BaselineConflictError extends Error {
  code: 'active_baseline_exists' | 'prev_hash_mismatch' | 'no_baseline' | 'duplicate_hash';
  current_baseline_hash?: string;
  constructor(
    code: 'active_baseline_exists' | 'prev_hash_mismatch' | 'no_baseline' | 'duplicate_hash',
    message: string,
    current_baseline_hash?: string,
  ) {
    super(message);
    this.name = 'BaselineConflictError';
    this.code = code;
    this.current_baseline_hash = current_baseline_hash;
  }
}

function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/**
 * Insert a genesis baseline for a tenant that has none yet. Fails if the
 * tenant already has an active baseline.
 */
export function insertGenesis(args: InsertBaselineArgs): InsertResult {
  const db = conn();
  const now = args.submitted_at;
  const activated_at = new Date().toISOString();

  const existing = db
    .prepare(`SELECT baseline_id FROM tenant_current_baseline WHERE tenant_id = ?`)
    .get(args.tenant_id) as { baseline_id: number } | undefined;
  if (existing) {
    const row = db
      .prepare(`SELECT baseline_hash FROM baselines WHERE id = ?`)
      .get(existing.baseline_id) as { baseline_hash: string };
    throw new BaselineConflictError(
      'active_baseline_exists',
      'tenant already has active baseline',
      row.baseline_hash,
    );
  }

  const tx = db.transaction(() => {
    let baseline_id: number;
    try {
      const res = db
        .prepare(
          `INSERT INTO baselines
             (tenant_id, baseline_hash, prev_baseline_hash, manifest_json,
              attestation_provider, attestation_envelope_json,
              signer_pubkey_spki_sha256_hex, reason,
              submitted_at, activated_at, retired_at, witness_leaf_id)
           VALUES (?, ?, NULL, ?, ?, ?, ?, NULL, ?, ?, NULL, NULL)`,
        )
        .run(
          args.tenant_id,
          args.baseline_hash,
          args.manifest_json,
          args.attestation_provider,
          args.attestation_envelope_json,
          args.signer_pubkey_spki_sha256_hex,
          args.submitted_at,
          activated_at,
        );
      baseline_id = Number(res.lastInsertRowid);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('UNIQUE') && msg.includes('baseline_hash')) {
        throw new BaselineConflictError('duplicate_hash', 'baseline_hash already exists');
      }
      throw e;
    }
    db.prepare(
      `INSERT INTO tenant_current_baseline (tenant_id, baseline_id, updated_at)
       VALUES (?, ?, ?)`,
    ).run(args.tenant_id, baseline_id, activated_at);
    return baseline_id;
  });

  const baseline_id = tx();
  return { baseline_id, activated_at };
}

/**
 * Insert a re-baseline that supersedes the tenant's current baseline.
 * Fails if the tenant has no current baseline, or if `prev_baseline_hash`
 * doesn't match the current active baseline.
 */
export function insertRebaseline(args: InsertRebaselineArgs): InsertResult {
  const db = conn();
  const activated_at = new Date().toISOString();

  const currentRow = db
    .prepare(
      `SELECT b.id AS baseline_id, b.baseline_hash
         FROM tenant_current_baseline t
         JOIN baselines b ON b.id = t.baseline_id
        WHERE t.tenant_id = ?`,
    )
    .get(args.tenant_id) as { baseline_id: number; baseline_hash: string } | undefined;

  if (!currentRow) {
    throw new BaselineConflictError(
      'no_baseline',
      'tenant has no current baseline; use /baseline to submit genesis',
    );
  }
  if (currentRow.baseline_hash !== args.prev_baseline_hash) {
    throw new BaselineConflictError(
      'prev_hash_mismatch',
      `prev_baseline_hash does not match current`,
      currentRow.baseline_hash,
    );
  }

  const tx = db.transaction(() => {
    let baseline_id: number;
    try {
      const res = db
        .prepare(
          `INSERT INTO baselines
             (tenant_id, baseline_hash, prev_baseline_hash, manifest_json,
              attestation_provider, attestation_envelope_json,
              signer_pubkey_spki_sha256_hex, reason,
              submitted_at, activated_at, retired_at, witness_leaf_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
        )
        .run(
          args.tenant_id,
          args.baseline_hash,
          args.prev_baseline_hash,
          args.manifest_json,
          args.attestation_provider,
          args.attestation_envelope_json,
          args.signer_pubkey_spki_sha256_hex,
          args.reason,
          args.submitted_at,
          activated_at,
        );
      baseline_id = Number(res.lastInsertRowid);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('UNIQUE') && msg.includes('baseline_hash')) {
        throw new BaselineConflictError('duplicate_hash', 'baseline_hash already exists');
      }
      throw e;
    }
    db.prepare(`UPDATE baselines SET retired_at = ? WHERE id = ?`).run(
      activated_at,
      currentRow.baseline_id,
    );
    db.prepare(
      `UPDATE tenant_current_baseline SET baseline_id = ?, updated_at = ?
        WHERE tenant_id = ?`,
    ).run(baseline_id, activated_at, args.tenant_id);
    return baseline_id;
  });

  const baseline_id = tx();
  return { baseline_id, activated_at };
}

export function getCurrent(tenant_id: string): BaselineRow | null {
  const row = conn()
    .prepare(
      `SELECT b.*
         FROM tenant_current_baseline t
         JOIN baselines b ON b.id = t.baseline_id
        WHERE t.tenant_id = ?`,
    )
    .get(tenant_id) as BaselineRow | undefined;
  return row ?? null;
}

export function getHistory(
  tenant_id: string,
  opts: { limit?: number; before?: string } = {},
): BaselineRow[] {
  const limit = Math.min(Math.max(1, opts.limit ?? 50), 200);
  const params: (string | number)[] = [tenant_id];
  let sql = `SELECT * FROM baselines WHERE tenant_id = ?`;
  if (opts.before) {
    // Cursor: return rows activated_at STRICTLY before the given hash's row
    const cursor = conn()
      .prepare(`SELECT activated_at FROM baselines WHERE tenant_id = ? AND baseline_hash = ?`)
      .get(tenant_id, opts.before) as { activated_at: string } | undefined;
    if (cursor) {
      sql += ` AND activated_at < ?`;
      params.push(cursor.activated_at);
    }
  }
  sql += ` ORDER BY activated_at DESC LIMIT ?`;
  params.push(limit);
  return conn().prepare(sql).all(...params) as BaselineRow[];
}

export function verifyMatchesCurrent(
  tenant_id: string,
  candidate_hash: string,
): { matches_current: boolean; current_baseline_hash: string | null } {
  const current = getCurrent(tenant_id);
  return {
    matches_current: current !== null && current.baseline_hash === candidate_hash,
    current_baseline_hash: current?.baseline_hash ?? null,
  };
}
