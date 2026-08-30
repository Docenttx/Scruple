// The reconciliation view — what the settlement half of H-4 actually
// reports.
//
// L2_AS_THE_VENDOR_FLOOR.md's Missing 2 is that nothing in the estate
// ever noticed a vendor STOPPING. Migration 041 gave the facts a place to
// live; this is the surface that reads them back, per component:
//
//   * the last counter that verified, and how many events actually landed;
//   * the gaps — counters the component produced and never delivered —
//     open and resolved, because a gap that drained two hours late is a
//     different fact from a gap that never closed and from no gap at all;
//   * when it was last seen, and whether it is live or silent;
//   * its attestation posture, verbatim, because H-5 says the receipt
//     reports its own strength rather than flattening to pass/fail;
//   * the build measurement it CLAIMS against the one it provisioned with.
//
// ON THAT LAST FIELD, stated here rather than discovered by a reader:
// §10 C-4 records that §4.3's "the server can check the claimed build is
// one we shipped" presumes a published-builds registry that does not
// exist. So this reports DRIFT — claimed differs from provisioned — and
// says so in the payload. Drift detection is not provenance, and the view
// must not imply it is.

import { conn } from '@/lib/db/sqlite';
import {
  ACCEPTANCE_WINDOW_COUNTERS,
  acceptanceWindow,
  allGaps,
  windowFloor,
  type ComponentRow,
} from '@/lib/ratchet/verify';
import { assess, silenceHistory, type SilenceState } from './silence';

export interface ComponentStatus {
  component_id: string;
  label: string | null;
  status: 'pending' | 'active' | 'retired';
  provisioned_at: string | null;

  counters: {
    /** Highest counter whose MAC verified. NULL = nothing ever has, which
     *  is not the same as 0. */
    last_verified: number | null;
    last_verified_at: string | null;
    /** Events on record. Less than last_verified + 1 exactly when
     *  something never arrived. */
    delivered: number;
    /** Of those, ones that arrived BELOW the high-water mark — queued
     *  events draining after a later one (§5). */
    backfilled: number;
    /** §10 C-3's bound, and the lowest counter still acceptable. */
    acceptance_window_counters: number;
    window_floor: number;
  };

  gaps: {
    open: number;
    /** Counters currently outstanding across all open gaps. */
    missing: number;
    resolved: number;
    list: Array<{
      id: number;
      /** Inclusive range of counters this gap says are missing. */
      from_counter: number;
      to_counter: number;
      missing_count: number;
      observed_at: string;
      resolved_at: string | null;
    }>;
  };

  liveness: {
    state: SilenceState | 'not_provisioned';
    last_seen_at: string | null;
    seconds_since: number | null;
    heartbeat_window_seconds: number;
    /** When the window closed. NULL while live. */
    went_silent_at: string | null;
    /** False when the component provisioned and never witnessed anything. */
    ever_witnessed: boolean;
    /** Recorded silence episodes (scripts/reconcile-sweep.ts), newest
     *  first. Empty when the sweep has never run — which is why `state`
     *  above is computed on read and does not depend on it. */
    episodes: ReturnType<typeof silenceHistory>;
  };

  attestation: {
    provider: string;
    /** 'verified' — IK sealed to an attested measurement. 'passthrough' —
     *  software-protected, the binding is assertion. NULL — none was
     *  supplied, which is honest absence and not a third tier. */
    status: 'verified' | 'passthrough' | null;
    quote_ref: string | null;
  };

  build: {
    /** What it declared at provisioning. */
    provisioned: string | null;
    /** What its most recent event claimed. */
    claimed_latest: string | null;
    /** Every distinct measurement seen across its events. */
    claimed_distinct: string[];
    /** claimed_latest differs from provisioned. */
    changed: boolean;
    /**
     * §10 C-4. Until a published-builds registry exists, a claimed
     * measurement can only be compared to the one this component
     * provisioned with. That is drift detection, not provenance, and
     * saying so in the payload is cheaper than a customer inferring
     * otherwise from a green field.
     */
    check: 'drift_only';
  };
}

interface FullRow extends ComponentRow {
  label: string | null;
  attestation_quote_ref: string | null;
}

const SELECT = `
  SELECT component_id, tenant_id, label, status, build_measurement,
         attestation_provider, attestation_quote_ref, attestation_status,
         last_verified_counter, last_verified_at, last_seen_at,
         chain_key_counter, chain_key_hex, bdk_fingerprint,
         heartbeat_window_seconds, acceptance_window_counters,
         window_floor_counter, window_floor_key_hex, provisioned_at
    FROM components`;

function statusFor(row: FullRow, nowMs: number): ComponentStatus {
  const db = conn();

  const counts = db
    .prepare(
      `SELECT COUNT(*) AS delivered,
              COALESCE(SUM(backfilled), 0) AS backfilled
         FROM component_events WHERE component_id = ?`,
    )
    .get(row.component_id) as { delivered: number; backfilled: number };

  const gaps = allGaps(row.component_id);
  const open = gaps.filter((g) => g.resolved_at === null);

  const live = assess(row, nowMs);
  const episodes = silenceHistory(row.component_id, 5);

  const claimed = db
    .prepare(
      `SELECT DISTINCT build_measurement FROM component_events
        WHERE component_id = ? AND build_measurement IS NOT NULL`,
    )
    .all(row.component_id) as Array<{ build_measurement: string }>;
  const latest = db
    .prepare(
      `SELECT build_measurement FROM component_events
        WHERE component_id = ? AND build_measurement IS NOT NULL
        ORDER BY counter DESC LIMIT 1`,
    )
    .get(row.component_id) as { build_measurement: string } | undefined;

  return {
    component_id: row.component_id,
    label: row.label,
    status: row.status,
    provisioned_at: row.provisioned_at,

    counters: {
      last_verified: row.last_verified_counter,
      last_verified_at: row.last_verified_at,
      delivered: counts.delivered,
      backfilled: Number(counts.backfilled),
      acceptance_window_counters: acceptanceWindow(row) || ACCEPTANCE_WINDOW_COUNTERS,
      window_floor: windowFloor(row),
    },

    gaps: {
      open: open.length,
      missing: open.reduce((n, g) => n + g.missing_count, 0),
      resolved: gaps.length - open.length,
      list: gaps.map((g) => ({
        id: g.id,
        // Reported as the INCLUSIVE range of missing counters. The stored
        // row is a pair of delivered bookends, which is the right shape
        // for the writer and the wrong one for a reader asking "which
        // events am I missing".
        from_counter: (g.from_counter ?? -1) + 1,
        to_counter: g.to_counter - 1,
        missing_count: g.missing_count,
        observed_at: g.observed_at,
        resolved_at: g.resolved_at,
      })),
    },

    liveness: {
      state: live ? live.state : 'not_provisioned',
      last_seen_at: row.last_seen_at,
      seconds_since: live ? live.seconds_since : null,
      heartbeat_window_seconds: row.heartbeat_window_seconds,
      went_silent_at: live ? live.went_silent_at : null,
      ever_witnessed: row.last_seen_at !== null,
      episodes,
    },

    attestation: {
      provider: row.attestation_provider,
      status: row.attestation_status,
      quote_ref: row.attestation_quote_ref,
    },

    build: {
      provisioned: row.build_measurement,
      claimed_latest: latest?.build_measurement ?? null,
      claimed_distinct: claimed.map((c) => c.build_measurement),
      changed:
        !!latest?.build_measurement &&
        !!row.build_measurement &&
        latest.build_measurement !== row.build_measurement,
      check: 'drift_only',
    },
  };
}

/** Every component belonging to one tenant. Tenant-scoped by argument,
 *  never by a filter the caller may forget to pass. */
export function tenantStatus(
  tenantId: string,
  opts: { includeRetired?: boolean; nowMs?: number } = {},
): ComponentStatus[] {
  const nowMs = opts.nowMs ?? Date.now();
  const rows = conn()
    .prepare(
      `${SELECT} WHERE tenant_id = ? ${opts.includeRetired ? '' : "AND status != 'retired'"}
        ORDER BY created_at ASC`,
    )
    .all(tenantId) as FullRow[];
  return rows.map((r) => statusFor(r, nowMs));
}

/** One component, scoped to its tenant so an id from another estate reads
 *  as absent rather than as someone else's evidence. */
export function componentStatus(
  tenantId: string,
  componentId: string,
  nowMs: number = Date.now(),
): ComponentStatus | null {
  const row = conn()
    .prepare(`${SELECT} WHERE tenant_id = ? AND component_id = ?`)
    .get(tenantId, componentId) as FullRow | undefined;
  return row ? statusFor(row, nowMs) : null;
}

export interface TenantReconciliation {
  components: ComponentStatus[];
  summary: {
    total: number;
    live: number;
    silent: number;
    not_provisioned: number;
    /** Components with at least one unclosed gap. */
    with_open_gaps: number;
    /** Counters outstanding across the estate. */
    missing_counters: number;
    /** Components whose latest claimed build differs from the provisioned
     *  one. §10 C-4: drift, not provenance. */
    build_drift: number;
  };
}

export function reconcileTenant(
  tenantId: string,
  opts: { includeRetired?: boolean; nowMs?: number } = {},
): TenantReconciliation {
  const components = tenantStatus(tenantId, opts);
  return {
    components,
    summary: {
      total: components.length,
      live: components.filter((c) => c.liveness.state === 'live').length,
      silent: components.filter((c) => c.liveness.state === 'silent').length,
      not_provisioned: components.filter((c) => c.liveness.state === 'not_provisioned').length,
      with_open_gaps: components.filter((c) => c.gaps.open > 0).length,
      missing_counters: components.reduce((n, c) => n + c.gaps.missing, 0),
      build_drift: components.filter((c) => c.build.changed).length,
    },
  };
}
