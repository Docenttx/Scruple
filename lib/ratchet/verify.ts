// Server-side ratchet verification and counter reconciliation (§4.2).
//
// The server holds the BDK, so it can derive any component's IK and
// ratchet to any counter. It caches (component_id -> chain_key_counter,
// K) and ratchets forward to the received counter.
//
// The three rules, and why each is the way it is:
//
//   1. n MUST be strictly greater than last_verified_counter. Replay and
//      reuse are REJECTED, not merely noticed. A ratchet whose counters
//      may repeat is a shared secret with extra steps.
//
//   2. A GAP VERIFIES AND IS RECORDED. n = last + 4 means three events
//      were produced and not delivered; the leaf still verifies and the
//      gap becomes a row. This is load-bearing: if a gap invalidated the
//      leaves around it, suppressing one event would be a way to attack
//      the vendor's entire record, and the party best placed to suppress
//      is the tenant we already treat as the adversary (§1).
//
//   3. An exact re-delivery — same (component_id, counter, mac) — is
//      dropped idempotently rather than treated as an attack (§5). A
//      retry out of queue.py re-sends the same bytes; that is the
//      designed behaviour, not a forgery.
//
// SPEC TENSION, flagged rather than silently resolved. §5 says a queued
// event keeps its counter and drains later, and §4.2 says n must exceed
// the high-water mark. Those two are only compatible if the component
// never submits event n+1 while n is still queued — head-of-line
// blocking. If it does, the drained event n arrives below the high-water
// mark and is rejected here as a replay, and a genuinely captured event
// is lost from the record. This implementation follows §4.2 as written
// (strict increase) and reports the case distinctly as `late` so it is
// countable rather than invisible. The component must drain strictly
// FIFO with head-of-line blocking, or §4.2 needs a bounded acceptance
// window; the spec picks neither.

import crypto from 'node:crypto';
import { conn } from '@/lib/db/sqlite';
import { bdk, bdkFingerprint } from './bdk';
import {
  Ratchet,
  canonicalPreimage,
  deriveIk,
  macEquals,
  macFor,
  ratchetForward,
  zeroize,
  type PreimageFields,
} from './ratchet';

/**
 * How far the server will ratchet forward in one request.
 *
 * NOT IN THE SPEC, and it needs to be: §4.2 says "the server ratchets
 * forward to the received counter" with no bound, so an unauthenticated
 * claim of n = 2^40 buys a trillion HMACs of server CPU before the MAC is
 * even checked. The counter travels in the clear and is therefore
 * attacker-chosen; work proportional to it must be capped. Beyond this,
 * the submission is refused and the component needs an operator to
 * re-baseline it, which is the correct amount of friction for a component
 * that has genuinely produced a hundred thousand undelivered events.
 */
export const MAX_RATCHET_ADVANCE = 100_000;

export interface ComponentRow {
  component_id: string;
  tenant_id: string;
  status: 'pending' | 'active' | 'retired';
  build_measurement: string | null;
  attestation_provider: string;
  attestation_status: 'verified' | 'passthrough' | null;
  last_verified_counter: number | null;
  chain_key_counter: number | null;
  chain_key_hex: string | null;
  bdk_fingerprint: string | null;
  heartbeat_window_seconds: number;
  provisioned_at: string | null;
}

export type VerifyFailure =
  | 'unknown_component'
  | 'not_provisioned'
  | 'retired'
  | 'replay'
  | 'duplicate'
  | 'counter_too_far'
  | 'bad_mac'
  | 'invalid_counter';

export interface VerifyOk {
  ok: true;
  component_id: string;
  tenant_id: string;
  counter: number;
  /** Number of counters produced by the component and never delivered.
   *  0 is the ordinary case. */
  gap: number;
  gap_id: number | null;
  /** H-5. What backed this leaf, per the component's provisioning posture. */
  attestation_status: 'verified' | 'passthrough' | null;
  /** True when the leaf declares a different build than the component
   *  provisioned with. Recorded, never fatal: a vendor legitimately
   *  redeploys a new published build without re-provisioning. */
  build_changed: boolean;
  build_measurement: string | null;
}

export interface VerifyFail {
  ok: false;
  reason: VerifyFailure;
  message: string;
  detail?: Record<string, unknown>;
}

export type VerifyResult = VerifyOk | VerifyFail;

export interface VerifyInput {
  componentId: string;
  counter: number;
  mac: string;
  /** Either the exact bytes MACed, or the fields to canonicalise. */
  preimage: Buffer | PreimageFields;
  /** From the wire envelope's component.build_measurement (§4.3). */
  buildMeasurement?: string | null;
}

const cacheEnabled = () => process.env.SCRUPLE_RATCHET_CACHE_CHAIN_KEY !== '0';

const nowIso = () => new Date().toISOString();

export function getComponent(componentId: string): ComponentRow | undefined {
  return conn()
    .prepare(
      `SELECT component_id, tenant_id, status, build_measurement,
              attestation_provider, attestation_status,
              last_verified_counter, chain_key_counter, chain_key_hex,
              bdk_fingerprint, heartbeat_window_seconds, provisioned_at
         FROM components WHERE component_id = ?`,
    )
    .get(componentId) as ComponentRow | undefined;
}

/**
 * Recover K at the counter we need, from the cache where it is usable and
 * from the BDK where it is not. Returns a Ratchet positioned AT `target`.
 *
 * The cache is never trusted past a BDK change: if bdk_fingerprint does
 * not match the BDK this process holds, the cached key was derived from a
 * different root and re-deriving is the only correct move.
 */
function ratchetTo(row: ComponentRow, target: number): Ratchet | VerifyFail {
  const fp = bdkFingerprint();
  const cacheUsable =
    cacheEnabled() &&
    row.chain_key_hex !== null &&
    row.chain_key_counter !== null &&
    row.chain_key_counter <= target &&
    row.bdk_fingerprint === fp;

  let start: number;
  let key: Buffer;
  if (cacheUsable) {
    start = row.chain_key_counter!;
    key = Buffer.from(row.chain_key_hex!, 'hex');
  } else {
    start = 0;
    key = deriveIk(bdk(), row.component_id);
  }

  const steps = target - start;
  if (steps < 0) {
    zeroize(key);
    return {
      ok: false,
      reason: 'invalid_counter',
      message: 'Cached chain key is ahead of the requested counter.',
      detail: { cached_at: start, requested: target },
    };
  }
  if (steps > MAX_RATCHET_ADVANCE) {
    zeroize(key);
    return {
      ok: false,
      reason: 'counter_too_far',
      message:
        `Counter ${target} is more than ${MAX_RATCHET_ADVANCE} ahead of this component's ` +
        'verified state. Refusing to ratchet that far in one request — the counter ' +
        'travels in the clear and is attacker-chosen, so work proportional to it is ' +
        'capped. Re-provision the component if this is genuine.',
      detail: { from: start, to: target, max_advance: MAX_RATCHET_ADVANCE },
    };
  }

  const advanced = ratchetForward(key, steps);
  zeroize(key);
  return new Ratchet(advanced, target);
}

/**
 * Verify one submission and reconcile the component's counter state.
 *
 * Writes on success: the event row, any gap row, the component's
 * high-water mark, chain-key cache and last_seen_at — in one transaction,
 * because a verified event whose high-water mark did not advance is a
 * counter that can be replayed.
 */
export function verifySubmission(input: VerifyInput): VerifyResult {
  const { componentId, counter, mac } = input;

  if (!Number.isInteger(counter) || counter < 0 || !Number.isSafeInteger(counter)) {
    return {
      ok: false,
      reason: 'invalid_counter',
      message: 'Counter must be a non-negative integer within the exact-integer range.',
      detail: { counter },
    };
  }

  const row = getComponent(componentId);
  if (!row) {
    return {
      ok: false,
      reason: 'unknown_component',
      message: 'No such component. Provision it via POST /api/v2/components/provision.',
    };
  }
  if (row.status === 'retired') {
    return { ok: false, reason: 'retired', message: 'This component has been retired.' };
  }
  if (row.status !== 'active' || row.provisioned_at === null) {
    return {
      ok: false,
      reason: 'not_provisioned',
      message:
        'This component exists but has never redeemed its provisioning token, so it ' +
        'holds no IK and cannot have produced a valid MAC.',
    };
  }

  const preimage = Buffer.isBuffer(input.preimage)
    ? input.preimage
    : canonicalPreimage(input.preimage);
  const preimageSha = crypto.createHash('sha256').update(preimage).digest('hex');

  // Rule 3 before rule 1: an exact re-delivery is the designed retry, not
  // an attack, and must not be logged as one.
  const seen = conn()
    .prepare(`SELECT mac FROM component_events WHERE component_id = ? AND counter = ?`)
    .get(componentId, counter) as { mac: string } | undefined;
  if (seen) {
    return {
      ok: false,
      reason: macEquals(seen.mac, mac) ? 'duplicate' : 'replay',
      message: macEquals(seen.mac, mac)
        ? `Counter ${counter} has already been recorded with this exact MAC. Dropped ` +
          'idempotently — this is a queue retry (§5), not a new event.'
        : `Counter ${counter} has already been used by this component with a different ` +
          'MAC. Counters are never reused; this submission is refused.',
      detail: { counter, last_verified_counter: row.last_verified_counter },
    };
  }

  // Rule 1. NULL last_verified_counter means nothing has ever verified,
  // which is not the same as 0 — conflating them would let event 0 be
  // replayed exactly once.
  const last = row.last_verified_counter;
  if (last !== null && counter <= last) {
    return {
      ok: false,
      reason: 'replay',
      message:
        `Counter ${counter} is not greater than this component's last verified counter ` +
        `(${last}). Replay and reuse are rejected, not merely noticed (§4.2). If this ` +
        'is a queued event draining late, the component is not draining strictly FIFO.',
      detail: { counter, last_verified_counter: last },
    };
  }

  const positioned = ratchetTo(row, counter);
  if (!(positioned instanceof Ratchet)) return positioned;

  // K_n is what MACs event n; K_n+1 is what we cache for next time.
  let expected: string;
  let nextKey: Buffer;
  try {
    const chainKey = positioned.chainKey();
    expected = macFor(chainKey, preimage);
    zeroize(chainKey);
    positioned.skip(1);
    nextKey = positioned.chainKey();
  } finally {
    positioned.destroy();
  }

  if (!macEquals(expected, mac)) {
    zeroize(nextKey);
    return {
      ok: false,
      reason: 'bad_mac',
      message:
        'MAC does not verify against the key this component would hold at that counter. ' +
        'Either the submission was not produced by this component, or the preimage ' +
        'canonicalisation differs from the server\'s.',
      detail: { counter, preimage_sha256: preimageSha },
    };
  }

  // Rule 2 — the gap verifies and is recorded.
  const expectedNext = last === null ? 0 : last + 1;
  const missing = counter - expectedNext;
  const ts = nowIso();
  const fp = bdkFingerprint();
  let gapId: number | null = null;

  const db = conn();
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO component_events
         (component_id, counter, mac, preimage_sha256, build_measurement, verified_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(componentId, counter, mac, preimageSha, input.buildMeasurement ?? null, ts);

    if (missing > 0) {
      const r = db
        .prepare(
          `INSERT INTO component_counter_gaps
             (component_id, from_counter, to_counter, missing_count, observed_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(componentId, last, counter, missing, ts);
      gapId = Number(r.lastInsertRowid);
    }

    db.prepare(
      `UPDATE components
          SET last_verified_counter = ?,
              last_verified_at      = ?,
              last_seen_at          = ?,
              chain_key_counter     = ?,
              chain_key_hex         = ?,
              bdk_fingerprint       = ?,
              updated_at            = ?
        WHERE component_id = ?`,
    ).run(
      counter,
      ts,
      ts,
      cacheEnabled() ? counter + 1 : null,
      cacheEnabled() ? nextKey.toString('hex') : null,
      fp,
      ts,
      componentId,
    );
  });
  tx();
  zeroize(nextKey);

  const buildChanged =
    !!input.buildMeasurement &&
    !!row.build_measurement &&
    input.buildMeasurement !== row.build_measurement;

  return {
    ok: true,
    component_id: componentId,
    tenant_id: row.tenant_id,
    counter,
    gap: missing,
    gap_id: gapId,
    attestation_status: row.attestation_status,
    build_changed: buildChanged,
    build_measurement: input.buildMeasurement ?? row.build_measurement,
  };
}

/**
 * Components that have gone quiet (§4.2, Missing 2). A component with no
 * leaf for longer than its heartbeat window is SILENT — the state Kohya's
 * design made indistinguishable from a quiet afternoon.
 *
 * Never having been seen counts as silent from provisioning: a component
 * that provisioned and then produced nothing at all is the most complete
 * form of the failure, and a NULL last_seen_at must not read as healthy.
 */
export function silentComponents(tenantId?: string): Array<{
  component_id: string;
  tenant_id: string;
  last_seen_at: string | null;
  heartbeat_window_seconds: number;
  seconds_since: number;
}> {
  const rows = conn()
    .prepare(
      `SELECT component_id, tenant_id, last_seen_at, provisioned_at, heartbeat_window_seconds
         FROM components
        WHERE status = 'active' ${tenantId ? 'AND tenant_id = ?' : ''}`,
    )
    .all(...(tenantId ? [tenantId] : [])) as Array<{
    component_id: string;
    tenant_id: string;
    last_seen_at: string | null;
    provisioned_at: string | null;
    heartbeat_window_seconds: number;
  }>;

  const now = Date.now();
  const out = [];
  for (const r of rows) {
    const since = r.last_seen_at ?? r.provisioned_at;
    if (!since) continue;
    const seconds = Math.floor((now - Date.parse(since)) / 1000);
    if (seconds > r.heartbeat_window_seconds) {
      out.push({
        component_id: r.component_id,
        tenant_id: r.tenant_id,
        last_seen_at: r.last_seen_at,
        heartbeat_window_seconds: r.heartbeat_window_seconds,
        seconds_since: seconds,
      });
    }
  }
  return out;
}

/** Open gaps for a component — the reconciliation report's raw material. */
export function openGaps(componentId: string) {
  return conn()
    .prepare(
      `SELECT id, from_counter, to_counter, missing_count, observed_at
         FROM component_counter_gaps
        WHERE component_id = ? AND resolved_at IS NULL
        ORDER BY observed_at DESC`,
    )
    .all(componentId) as Array<{
    id: number;
    from_counter: number | null;
    to_counter: number;
    missing_count: number;
    observed_at: string;
  }>;
}
