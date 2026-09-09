// The retention-policy registry — the half of `retentionPolicy.ts` that
// touches the database.
//
// WO-C3. Split out because the capture sidecar imports `retentionPolicyDigest`
// to build its leaf, and a sidecar container that pulled `better-sqlite3` in
// behind a hash function would be paying for a database it never opens.

import { conn } from '@/lib/db/sqlite';
import {
  canonicalRetentionPolicy,
  retentionPolicyDigest,
  validateRetentionPolicy,
  RETENTION_DIGEST_RE,
  RETENTION_POLICY_VERSION,
  type RetentionPolicy,
} from '@/lib/leaf/retentionPolicy';

export interface EnrolledRetentionPolicy extends RetentionPolicy {
  digest: string;
  enrolled_at: string;
}

/**
 * Record a policy so a leaf may name it.
 *
 * ⚑ ENROLMENT IS NOT DONE AT INGEST, and that is the load-bearing half. If the
 * route enrolled whatever policy a submission described, every digest would
 * resolve — including a fabricated one — and the forged-handle state would
 * collapse back into the resolvable state on the way in. A digest is a pointer
 * at something a deployment already decided; a component chooses among
 * enrolled policies, it does not write them.
 */
export function enrollRetentionPolicy(p: RetentionPolicy): EnrolledRetentionPolicy {
  const v = validateRetentionPolicy(p);
  if (!v.ok) throw new Error(`refusing to enrol an invalid retention policy: ${v.reason}`);
  const digest = retentionPolicyDigest(p);
  const enrolled_at = new Date().toISOString();
  conn()
    .prepare(
      `INSERT INTO retention_policies
         (digest, policy_id, clock, retention_duration_s, settlement_window_s,
          policy_version, canonical_json, enrolled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(digest) DO NOTHING`,
    )
    .run(
      digest,
      p.policy_id,
      p.clock,
      p.retention_duration_s,
      p.settlement_window_s,
      p.version,
      canonicalRetentionPolicy(p),
      enrolled_at,
    );
  return { ...p, digest, enrolled_at };
}

interface PolicyRow {
  digest: string;
  policy_id: string;
  clock: string;
  retention_duration_s: number;
  settlement_window_s: number;
  policy_version: number;
  canonical_json: string;
  enrolled_at: string;
}

/**
 * Resolve a digest to the durations it binds, or null.
 *
 * NULL IS THE FORGED-HANDLE ANSWER, and it is also the answer for a policy
 * this deployment never enrolled. Those are the same fact from here: a digest
 * naming a duration nobody recorded binds no duration at all.
 *
 * ⚑ THE ROW IS RE-DIGESTED BEFORE IT IS TRUSTED. A row whose columns were
 * edited after enrolment would otherwise answer to its original digest with
 * different durations — the exact substitution the digest exists to prevent,
 * performed on our own side of it.
 */
export function resolveRetentionPolicy(digest: string): EnrolledRetentionPolicy | null {
  if (!RETENTION_DIGEST_RE.test(digest)) return null;
  const row = conn()
    .prepare(
      `SELECT digest, policy_id, clock, retention_duration_s, settlement_window_s,
              policy_version, canonical_json, enrolled_at
         FROM retention_policies WHERE digest = ?`,
    )
    .get(digest) as PolicyRow | undefined;
  if (!row) return null;
  if (row.policy_version !== RETENTION_POLICY_VERSION) return null;
  const policy: RetentionPolicy = {
    version: RETENTION_POLICY_VERSION,
    policy_id: row.policy_id,
    clock: row.clock,
    retention_duration_s: row.retention_duration_s,
    settlement_window_s: row.settlement_window_s,
  };
  if (retentionPolicyDigest(policy) !== digest) return null;
  return { ...policy, digest, enrolled_at: row.enrolled_at };
}
