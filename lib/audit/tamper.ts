// Tamper-audit core (Pivot polish — Layer 1 + scaffolding for Layer 2).
//
// For a given iteration, re-fetch its bytes via the user's storage
// provider, SHA-256 them, and compare against the leaf_hash recorded
// at ingest time. Records every check in tamper_audit_log.
//
// Manual single-iteration verification is exposed via
//   POST /api/audit/iteration/:id
// Layer 2 (the nightly cron sweep) iterates this for every iteration
// with a storage_pointer.

import { conn } from '@/lib/db/sqlite';
import { sha256Hex } from '@/lib/scruple/hash';
import { getActiveProvider } from '@/lib/storage/dispatch';
import { StorageError } from '@/lib/storage/types';

interface IterationRow {
  id: number;
  leaf_hash: string;
  storage_pointer: string | null;
  project_id: number;
}

interface ProjectOwner {
  user_id: string;
}

export interface AuditResult {
  ok: boolean;
  status: 'ok' | 'mismatch' | 'missing' | 'unreachable';
  expectedHash: string;
  observedHash?: string;
  detail?: string;
  durationMs: number;
  sizeBytes?: number;
}

export async function auditIteration(iterationId: number): Promise<AuditResult> {
  const started = Date.now();

  const iter = conn()
    .prepare(`SELECT id, leaf_hash, storage_pointer, project_id FROM iterations WHERE id = ?`)
    .get(iterationId) as IterationRow | undefined;

  if (!iter) {
    return {
      ok: false,
      status: 'missing',
      expectedHash: '',
      detail: 'Iteration not found',
      durationMs: Date.now() - started,
    };
  }
  if (!iter.storage_pointer) {
    return {
      ok: false,
      status: 'missing',
      expectedHash: iter.leaf_hash,
      detail: 'No storage_pointer recorded — iteration was never uploaded to BYOS',
      durationMs: Date.now() - started,
    };
  }
  const owner = conn()
    .prepare(`SELECT user_id FROM projects WHERE id = ?`)
    .get(iter.project_id) as ProjectOwner | undefined;
  if (!owner) {
    return {
      ok: false,
      status: 'unreachable',
      expectedHash: iter.leaf_hash,
      detail: 'Project owner not found',
      durationMs: Date.now() - started,
    };
  }

  const provider = getActiveProvider(owner.user_id);
  if (!provider) {
    return {
      ok: false,
      status: 'unreachable',
      expectedHash: iter.leaf_hash,
      detail: 'User has no storage provider connected',
      durationMs: Date.now() - started,
    };
  }

  let pointer;
  try {
    pointer = JSON.parse(iter.storage_pointer);
  } catch {
    return {
      ok: false,
      status: 'unreachable',
      expectedHash: iter.leaf_hash,
      detail: 'storage_pointer JSON malformed',
      durationMs: Date.now() - started,
    };
  }

  let bytes: Buffer;
  try {
    bytes = await provider.readFile(owner.user_id, pointer);
  } catch (e) {
    const detail = e instanceof StorageError ? e.message : e instanceof Error ? e.message : String(e);
    const status = e instanceof StorageError && e.code === 'not_found' ? 'missing' : 'unreachable';
    recordAudit(iter, owner.user_id, status, undefined, detail, undefined, Date.now() - started);
    return {
      ok: false,
      status,
      expectedHash: iter.leaf_hash,
      detail,
      durationMs: Date.now() - started,
    };
  }

  const observed = sha256Hex(bytes);
  const ok = observed === iter.leaf_hash;
  const status: 'ok' | 'mismatch' = ok ? 'ok' : 'mismatch';

  recordAudit(iter, owner.user_id, status, observed, undefined, bytes.length, Date.now() - started);

  return {
    ok,
    status,
    expectedHash: iter.leaf_hash,
    observedHash: observed,
    sizeBytes: bytes.length,
    durationMs: Date.now() - started,
  };
}

function recordAudit(
  iter: IterationRow,
  userId: string,
  status: 'ok' | 'mismatch' | 'missing' | 'unreachable',
  observedHash: string | undefined,
  detail: string | undefined,
  sizeBytes: number | undefined,
  durationMs: number,
): void {
  try {
    conn()
      .prepare(
        `INSERT INTO tamper_audit_log
           (iteration_id, user_id, expected_hash, observed_hash, storage_pointer, status, detail, size_bytes, duration_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        iter.id,
        userId,
        iter.leaf_hash,
        observedHash ?? null,
        iter.storage_pointer ?? '',
        status,
        detail ?? null,
        sizeBytes ?? null,
        durationMs,
      );
  } catch (e) {
    console.error('[tamper-audit] could not record entry:', e);
  }
}

export interface AuditSummary {
  iterationId: number;
  leafHash: string;
  lastAuditedAt: string | null;
  lastStatus: 'ok' | 'mismatch' | 'missing' | 'unreachable' | 'never' | null;
  recentEntries: Array<{
    auditedAt: string;
    status: string;
    detail: string | null;
  }>;
}

/** Read-only — surface the audit history for a specific iteration so
 *  the receipt page can render a verification badge. */
export function getAuditSummary(iterationId: number): AuditSummary | null {
  const iter = conn()
    .prepare(`SELECT id, leaf_hash FROM iterations WHERE id = ?`)
    .get(iterationId) as { id: number; leaf_hash: string } | undefined;
  if (!iter) return null;

  const rows = conn()
    .prepare(
      `SELECT audited_at, status, detail FROM tamper_audit_log
         WHERE iteration_id = ? ORDER BY audited_at DESC LIMIT 10`,
    )
    .all(iter.id) as Array<{ audited_at: string; status: string; detail: string | null }>;

  return {
    iterationId: iter.id,
    leafHash: iter.leaf_hash,
    lastAuditedAt: rows[0]?.audited_at ?? null,
    lastStatus: rows[0]
      ? (rows[0].status as 'ok' | 'mismatch' | 'missing' | 'unreachable')
      : 'never',
    recentEntries: rows.map(r => ({ auditedAt: r.audited_at, status: r.status, detail: r.detail })),
  };
}
