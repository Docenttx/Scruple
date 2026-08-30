// Silence detection — Missing 2, and the whole point of the design.
//
// STUDIO_P1-P8_GRADE.md records the two shapes the estate already had:
// Kohya's pod hook no-ops when an env var is absent, and the canvas
// path's ingest failure is swallowed. In both, a capture path that had
// gone completely dark produced exactly the same observable as a quiet
// afternoon — nobody was witnessing and nothing said so. A component that
// stops witnessing has to become VISIBLE, and that is this file.
//
// READ-COMPUTED, NOT SWEPT — the decision, and why.
//
// Silence is a pure function of (last_seen_at, heartbeat_window_seconds,
// now). Computing it on read means it is never stale: the answer is
// correct the instant it is asked, with no dependency on whether a job
// ran, and it cannot be wrong in the one direction that matters — a
// component that went dark five minutes ago cannot read healthy because
// the sweeper is behind. A stored `is_silent` column would be a cache of
// a computation cheaper than the read that fetched it.
//
// So `assess()` is the source of truth and every surface calls it.
//
// The sweep exists for the one thing a predicate cannot do: say WHEN it
// went dark and whether anyone ever noticed. component_silence_events is
// that record — a durable, idempotent transition log an alert can hang
// off. It is written by `sweepSilence()`, invoked explicitly from
// scripts/reconcile-sweep.ts (cron, or an operator at a terminal), and
// NEVER by a timer inside the Next.js process: a setInterval in a route
// module runs once per warm serverless instance, zero times on a cold
// one, and N times on N replicas, which would make the evidence record
// depend on which instance happened to be alive. Missing the sweep costs
// the transition log; it never makes a silent component read live.
//
// THE HEARTBEAT DEFAULT is 900 seconds (migration 041's column default,
// named here so both halves agree). §9 flags the window as a
// tenant-visible parameter with a real tradeoff and does not pick a
// number: short windows make silence a fast signal and make ordinary
// idleness noisy. 15 minutes is chosen against the failure it has to
// catch — a component container that dies, or a gate that stops being
// reachable, is worth knowing about within a coffee break, while an
// artist who spends 15 minutes composing a prompt is not worth paging
// anyone about. It is per component because a batch trainer witnessing
// every few hours and an interactive canvas witnessing every few seconds
// cannot share a threshold: set it above the component's real idle
// period, and treat a component with no natural rhythm as one that must
// send an explicit heartbeat rather than one with a huge window.

import { conn } from '@/lib/db/sqlite';

/** Migration 041's column default, named. See the note above. */
export const DEFAULT_HEARTBEAT_WINDOW_SECONDS = 900;

export type SilenceState = 'live' | 'silent';

export interface SilenceAssessment {
  component_id: string;
  tenant_id: string;
  state: SilenceState;
  /** False when the component provisioned and never witnessed anything at
   *  all — the most complete form of the failure, and the one a NULL
   *  last_seen_at must never be allowed to read as healthy. */
  ever_witnessed: boolean;
  last_seen_at: string | null;
  provisioned_at: string | null;
  heartbeat_window_seconds: number;
  /** Seconds since the last leaf, or since provisioning if there has
   *  never been one. */
  seconds_since: number;
  /** When silence became true — the moment the window closed, not the
   *  moment anyone looked. NULL while live. */
  went_silent_at: string | null;
}

interface Row {
  component_id: string;
  tenant_id: string;
  last_seen_at: string | null;
  provisioned_at: string | null;
  heartbeat_window_seconds: number | null;
}

/**
 * The predicate. Pure — no clock of its own, so a test can ask what the
 * answer will be in an hour without waiting one.
 */
export function assess(row: Row, nowMs: number = Date.now()): SilenceAssessment | null {
  const since = row.last_seen_at ?? row.provisioned_at;
  const window =
    row.heartbeat_window_seconds === null || !Number.isFinite(row.heartbeat_window_seconds)
      ? DEFAULT_HEARTBEAT_WINDOW_SECONDS
      : row.heartbeat_window_seconds;
  // A component with neither a last_seen nor a provisioned_at has not
  // finished provisioning; it has no clock to be measured against and is
  // reported by status as pending rather than judged here.
  if (!since) return null;

  const sinceMs = Date.parse(since);
  const seconds = Math.floor((nowMs - sinceMs) / 1000);
  const silent = seconds > window;
  return {
    component_id: row.component_id,
    tenant_id: row.tenant_id,
    state: silent ? 'silent' : 'live',
    ever_witnessed: row.last_seen_at !== null,
    last_seen_at: row.last_seen_at,
    provisioned_at: row.provisioned_at,
    heartbeat_window_seconds: window,
    seconds_since: seconds,
    went_silent_at: silent ? new Date(sinceMs + window * 1000).toISOString() : null,
  };
}

function activeRows(tenantId?: string): Row[] {
  return conn()
    .prepare(
      `SELECT component_id, tenant_id, last_seen_at, provisioned_at, heartbeat_window_seconds
         FROM components
        WHERE status = 'active' ${tenantId ? 'AND tenant_id = ?' : ''}`,
    )
    .all(...(tenantId ? [tenantId] : [])) as Row[];
}

/** Every active component, live and silent alike. */
export function assessAll(tenantId?: string, nowMs: number = Date.now()): SilenceAssessment[] {
  const out: SilenceAssessment[] = [];
  for (const r of activeRows(tenantId)) {
    const a = assess(r, nowMs);
    if (a) out.push(a);
  }
  return out;
}

/** One component, or null if it does not exist or has not provisioned. */
export function assessComponent(
  componentId: string,
  nowMs: number = Date.now(),
): SilenceAssessment | null {
  const r = conn()
    .prepare(
      `SELECT component_id, tenant_id, last_seen_at, provisioned_at, heartbeat_window_seconds
         FROM components WHERE component_id = ?`,
    )
    .get(componentId) as Row | undefined;
  return r ? assess(r, nowMs) : null;
}

/**
 * The components that have gone quiet. Kept at this call signature
 * because lib/ratchet/verify.ts re-exports it and the H-4 tests are
 * written against it.
 */
export function silentComponents(
  tenantId?: string,
  nowMs: number = Date.now(),
): Array<{
  component_id: string;
  tenant_id: string;
  last_seen_at: string | null;
  heartbeat_window_seconds: number;
  seconds_since: number;
  went_silent_at: string | null;
  ever_witnessed: boolean;
}> {
  return assessAll(tenantId, nowMs)
    .filter((a) => a.state === 'silent')
    .map((a) => ({
      component_id: a.component_id,
      tenant_id: a.tenant_id,
      last_seen_at: a.last_seen_at,
      heartbeat_window_seconds: a.heartbeat_window_seconds,
      seconds_since: a.seconds_since,
      went_silent_at: a.went_silent_at,
      ever_witnessed: a.ever_witnessed,
    }));
}

export interface SweepResult {
  checked: number;
  /** Components that crossed into silence on this sweep. */
  opened: Array<{ component_id: string; went_silent_at: string; last_seen_at: string | null }>;
  /** Components whose open silence ended because a leaf arrived. */
  recovered: Array<{ component_id: string; silence_id: number; last_seen_at: string | null }>;
  /** Still silent, already recorded. Reported so an idempotent re-run is
   *  visibly a no-op rather than indistinguishable from nothing wrong. */
  still_silent: string[];
}

/**
 * Record silence transitions. Idempotent: a component that is still
 * silent on the tenth run has one row, not ten.
 *
 * Invoked explicitly — see the header. This function never schedules
 * itself.
 */
export function sweepSilence(opts: { tenantId?: string; nowMs?: number } = {}): SweepResult {
  const nowMs = opts.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const db = conn();
  const result: SweepResult = { checked: 0, opened: [], recovered: [], still_silent: [] };

  const openFor = db.prepare(
    `SELECT id FROM component_silence_events
      WHERE component_id = ? AND recovered_at IS NULL
      ORDER BY id DESC LIMIT 1`,
  );

  const tx = db.transaction((rows: SilenceAssessment[]) => {
    for (const a of rows) {
      result.checked++;
      const open = openFor.get(a.component_id) as { id: number } | undefined;
      if (a.state === 'silent') {
        if (open) {
          result.still_silent.push(a.component_id);
          continue;
        }
        db.prepare(
          `INSERT INTO component_silence_events
             (component_id, went_silent_at, last_seen_at, heartbeat_window_seconds, observed_at)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(a.component_id, a.went_silent_at, a.last_seen_at, a.heartbeat_window_seconds, nowIso);
        result.opened.push({
          component_id: a.component_id,
          went_silent_at: a.went_silent_at!,
          last_seen_at: a.last_seen_at,
        });
      } else if (open) {
        db.prepare(`UPDATE component_silence_events SET recovered_at = ? WHERE id = ?`).run(
          nowIso,
          open.id,
        );
        result.recovered.push({
          component_id: a.component_id,
          silence_id: open.id,
          last_seen_at: a.last_seen_at,
        });
      }
    }
  });
  tx(assessAll(opts.tenantId, nowMs));
  return result;
}

export interface SilenceEpisode {
  id: number;
  went_silent_at: string;
  last_seen_at: string | null;
  heartbeat_window_seconds: number;
  recovered_at: string | null;
  observed_at: string;
}

/** The recorded episodes for one component, newest first. */
export function silenceHistory(componentId: string, limit = 10): SilenceEpisode[] {
  return conn()
    .prepare(
      `SELECT id, went_silent_at, last_seen_at, heartbeat_window_seconds, recovered_at, observed_at
         FROM component_silence_events
        WHERE component_id = ?
        ORDER BY id DESC
        LIMIT ?`,
    )
    .all(componentId, limit) as SilenceEpisode[];
}
