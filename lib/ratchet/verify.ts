// Server-side ratchet verification and counter reconciliation (§4.2, §10 C-3).
//
// The server holds the BDK, so it can derive any component's IK and
// ratchet to any counter. It caches (component_id -> chain_key_counter,
// K) and ratchets forward to the received counter.
//
// The rules, and why each is the way it is:
//
//   1. A counter is accepted once. Replay defence is component_events'
//      PRIMARY KEY (component_id, counter): a counter that has already
//      been recorded is refused on a STORED FACT rather than on an
//      inference from the high-water mark.
//
//      This used to be a strict-increase rule — n MUST exceed
//      last_verified_counter — and §10 C-3 retires it. §5 says a queued
//      event keeps its counter and drains later; strict increase says a
//      counter below the high-water mark is a replay. Those two reconcile
//      only if the component never submits n+1 while n is queued, which
//      is head-of-line blocking that §5 does not state — and if it does
//      not block, a genuinely captured event is REJECTED AS A REPLAY AND
//      LOST FROM THE RECORD. Head-of-line blocking is the wrong fix,
//      because one permanently undeliverable event would then silence a
//      component indefinitely, and silence is the specific thing this
//      design exists to make visible.
//
//      So: accept any UNSEEN counter within a bounded window below the
//      high-water mark (ACCEPTANCE_WINDOW_COUNTERS, per component).
//      Beyond the window in either direction the submission is refused as
//      `counter_too_far` — MAX_RATCHET_ADVANCE upward, the acceptance
//      window downward. Payments settles the same way: hosts derive any
//      key from the KSN independently and detect duplicates by
//      uniqueness, not by enforcing arrival order.
//
//      One thing the window does NOT do is admit a counter the record
//      says was already delivered. A counter below the high-water mark is
//      accepted only if some OPEN GAP claims it — and a gap row exists
//      for every counter that was ever skipped, written at the moment the
//      higher counter landed. For honest traffic "unseen and within the
//      window" and "claimed by an open gap" are the same set; they differ
//      only when the event ledger has been truncated, and there the gap
//      table is the second, independent record that says the counter was
//      spent. That is what keeps event 0 from being replayable exactly
//      once against a component whose event rows were deleted.
//
//   2. A GAP VERIFIES AND IS RECORDED. n = last + 4 means three events
//      were produced and not delivered; the leaf still verifies and the
//      gap becomes a row. This is load-bearing: if a gap invalidated the
//      leaves around it, suppressing one event would be a way to attack
//      the vendor's entire record, and the party best placed to suppress
//      is the tenant we already treat as the adversary (§1). A gap that
//      later drains is RESOLVED, never deleted.
//
//   3. An exact re-delivery — same (component_id, counter, mac) — is
//      dropped idempotently rather than treated as an attack (§5). A
//      retry out of queue.py re-sends the same bytes; that is the
//      designed behaviour, not a forgery.
//
//   4. THE CLAIMED BUILD IS CHECKED AGAINST THE PUBLISHED-BUILDS REGISTRY
//      AND NEVER REJECTED ON IT (§10 C-4, WO-15). Before the registry
//      existed, `build_changed` compared the leaf's measurement to the
//      value the same component provisioned with — drift detection, not
//      provenance. lib/builds/registry.ts is now the thing to compare
//      against, and the outcome lands on `VerifyOk.build_status` and on
//      `component_events.build_status` for every event.
//
//      An unrecognised build is RECORDED, for rule 2's reason exactly: if
//      it were fatal, moving one byte in the component would make every
//      subsequent leaf vanish with the server's cooperation, and the
//      party best placed to move that byte is the tenant §1 already
//      treats as the adversary. The full argument is in
//      lib/builds/registry.ts's header.
//
// THE COST OF LOOKING BACKWARDS. The chain is one-way: there is no
// un-ratchet. Verifying a counter below the high-water mark means
// re-deriving K from a checkpoint at or before it, one HKDF-Expand per
// step. From the IK that is `counter` HMACs — 400,000 of them for a
// long-running component, and MAX_RATCHET_ADVANCE would refuse it
// outright, so the window would silently stop working past 100,000
// events. Hence the window-floor checkpoint (migration 042): K at the
// window's lower edge, advanced by one HKDF-Expand per delivered event,
// which caps every backfill at `acceptance_window_counters` steps no
// matter how long the component has been running. It is a CACHE — with
// SCRUPLE_RATCHET_CACHE_CHAIN_KEY=0 the fallback is a from-IK derivation
// bounded by MAX_RATCHET_ADVANCE, and correctness does not change.

import crypto from 'node:crypto';
import { conn } from '@/lib/db/sqlite';
import { bdk, bdkFingerprint } from './bdk';
import { checkClaimedBuild, type BuildCheck } from '@/lib/builds/registry';
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
 * NOT IN §4.2 AS WRITTEN, and §10 C-2 now records why it must be: §4.2
 * said "the server ratchets forward to the received counter" with no
 * bound, so an unauthenticated claim of n = 2^40 buys a trillion HMACs of
 * server CPU before the MAC is even checked. The counter travels in the
 * clear and is therefore attacker-chosen; work proportional to it must be
 * capped. Beyond this, the submission is refused and the component needs
 * an operator to re-baseline it, which is the correct amount of friction
 * for a component that has genuinely produced a hundred thousand
 * undelivered events.
 *
 * LEFT AS THE RATCHET WORK ORDER SET IT, with the measurement recorded
 * rather than acted on: 100,000 steps is ~584 ms of CPU on the dev box,
 * spent BEFORE the MAC is checked, on an attacker-chosen counter. That is
 * ~40x the worst case the downward acceptance window admits, so the cap
 * that most deserves a second look is this one and not C-3's. Lowering it
 * is a decision about how large a genuine undelivered backlog may be,
 * which belongs with whoever owns the component's queue depth, not here.
 */
export const MAX_RATCHET_ADVANCE = 100_000;

/**
 * §10 C-3's bound, applied DOWNWARD: how far below the high-water mark a
 * late drain may still be accepted. Per component
 * (`components.acceptance_window_counters`); this is the default and the
 * fallback for a row that predates migration 042.
 *
 * WHY 1000. §5's BACKOFF_SCHEDULE = [5, 30, 120, 600, 1800] retries a
 * single held event for roughly 43 minutes, and the component keeps
 * capturing throughout — the held event's counter falls further behind
 * the high-water mark the whole time it is held. The window has to be
 * larger than what a component produces during its longest retry, or the
 * design's own offline behaviour would be rejected on arrival. 1000
 * covers that with margin for a busy ComfyUI, and it is simultaneously
 * the cap on backfill derivation cost.
 *
 * THAT COST, MEASURED rather than asserted: one ratchet step is a
 * createHmac + digest, ~5.8 us on the dev box, so a full-window backfill
 * is at most ~15 ms of CPU and the ordinary one-step case is ~6 us. For
 * scale, re-deriving from the IK for a component at counter 400,000 —
 * what this window costs if the floor checkpoint is unavailable and the
 * bound is absent — is ~2.3 s, and MAX_RATCHET_ADVANCE would refuse it
 * outright. Bigger windows buy tolerance for longer outages at linear
 * CPU cost; smaller ones start discarding evidence, which is the trade
 * C-3 rejected.
 */
export const ACCEPTANCE_WINDOW_COUNTERS = 1_000;

/**
 * §10 C-6 — AUTHENTICATE BEFORE RATCHETING, expressed as a parameter.
 *
 * C-2 bounded the ratchet at MAX_RATCHET_ADVANCE and C-6 priced it: at the
 * ~5.8 µs per step WO-4 measured, 100,000 steps is ~584 ms of CPU spent
 * BEFORE the MAC is checked, on a counter that travels in the clear and is
 * therefore attacker-chosen. C-6's finding is that the fix is not a smaller
 * number — lowering the cap trades a DoS window for a legitimate-backlog
 * ceiling, and refusing a deep drain destroys exactly the evidence the
 * queue exists to preserve (§5, C-3).
 *
 * The fix is that unauthenticated cost must be ZERO. So verification takes
 * an authenticated principal as its FIRST ARGUMENT rather than reading one
 * out of a request, and the only way to obtain one is `principalFrom()` in
 * lib/v2/auth.ts, which is a hashed-key lookup against `api_keys`. A caller
 * that has not authenticated cannot construct the call, which is a stronger
 * statement than a caller that has not authenticated should not make it.
 *
 * `MAX_RATCHET_ADVANCE` then bounds only AUTHENTICATED abuse, where a
 * tenant burning their own quota is a billing question rather than a
 * denial-of-service one. Reconsidering the number is C-6's second step and
 * takes backlog depth as its only input; it is deliberately not done here.
 */
export interface AuthenticatedTenant {
  /** api_keys.user_id — the tenant boundary, not a display name. */
  userId: string;
  /** api_keys.id. Carried for audit, never used as an authorisation input. */
  keyId: string;
}

/* ── C-6 instrumentation ──────────────────────────────────────────────────
 *
 * A claim that no ratcheting happens before authentication is only worth
 * what proves it, and a timing assertion proves it flakily. These counters
 * make the claim mechanical: `test/v2/component-auth.test.ts` resets them,
 * fires an unauthenticated submission carrying counter 99,999, and asserts
 * the delta is exactly zero — then repeats with a valid key belonging to
 * another tenant, and finally with the owning tenant, where the delta is
 * non-zero and the same test therefore cannot pass vacuously.
 *
 * Kept in production code rather than in a test double on purpose: an
 * instrument that only exists in the test harness measures the harness.
 * Two integers and an increment cost nothing.
 */
let ratchetStepsTotal = 0;
let ratchetCallsTotal = 0;

/** HKDF-Expand steps performed by this process since the last reset. */
export function ratchetStepsPerformed(): number {
  return ratchetStepsTotal;
}

/** Times a chain key has been positioned at a counter. */
export function ratchetInvocations(): number {
  return ratchetCallsTotal;
}

export function resetRatchetCounters(): void {
  ratchetStepsTotal = 0;
  ratchetCallsTotal = 0;
}

export interface ComponentRow {
  component_id: string;
  tenant_id: string;
  status: 'pending' | 'active' | 'retired';
  build_measurement: string | null;
  attestation_provider: string;
  attestation_status: 'verified' | 'passthrough' | null;
  last_verified_counter: number | null;
  last_verified_at: string | null;
  last_seen_at: string | null;
  chain_key_counter: number | null;
  chain_key_hex: string | null;
  bdk_fingerprint: string | null;
  heartbeat_window_seconds: number;
  acceptance_window_counters: number;
  window_floor_counter: number | null;
  window_floor_key_hex: string | null;
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
   *  0 is the ordinary case, and always 0 for a backfill — a late drain
   *  fills a gap, it does not open one. */
  gap: number;
  gap_id: number | null;
  /** True when this event arrived BELOW the high-water mark: a queued
   *  event draining after a later one (§5). Evidence either way; only
   *  this one says the component's transport was interrupted. */
  backfilled: boolean;
  /** Gap rows fully filled by this event. */
  gaps_closed: number[];
  /** H-5. What backed this leaf, per the component's provisioning posture. */
  attestation_status: 'verified' | 'passthrough' | null;
  /** True when the leaf declares a different build than the component
   *  provisioned with. Recorded, never fatal: a vendor legitimately
   *  redeploys a new published build without re-provisioning. */
  build_changed: boolean;
  build_measurement: string | null;
  /**
   * §4.3 / §10 C-4, WO-15. What the PUBLISHED-BUILDS REGISTRY said about
   * the claimed measurement at the moment this event was ingested.
   *
   * This is the field that turns `build_measurement` from drift detection
   * into provenance: `build_changed` compares the leaf to what the same
   * component provisioned with — it notices that a component changed and
   * cannot tell a build we shipped from a string somebody typed — whereas
   * this compares it to what Scruple published.
   *
   * NEVER FATAL, and lib/builds/registry.ts carries the five-point
   * argument for that. In one line: refusing the leaf does not un-produce
   * the artifact, it produces an artifact with no leaf, which hands a
   * suppression primitive to anyone who can move a byte in the component.
   * `unpublished` is recorded, returned, indexed and served at
   * GET /api/v2/builds/unrecognised. It is visible; it is not fine.
   *
   * The honest limit is unchanged by any of this and is stated in the
   * spec rather than discovered later: a modified build can claim a
   * PUBLISHED measurement just as easily as an unpublished one. What it
   * cannot do is produce a valid MAC without the IK, and where the vendor
   * has attestable compute the IK is sealed to the measurement so a
   * modified build cannot unseal it. Registry plus key, not registry
   * alone.
   */
  build_status: BuildCheck;
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

/** The per-component window, defaulting for rows written before 042. */
export function acceptanceWindow(row: ComponentRow): number {
  const w = row.acceptance_window_counters;
  return Number.isInteger(w) && w >= 0 ? w : ACCEPTANCE_WINDOW_COUNTERS;
}

/** Lowest counter this component will still accept as a late drain. */
export function windowFloor(row: ComponentRow): number {
  const last = row.last_verified_counter;
  if (last === null) return 0;
  return Math.max(0, last + 1 - acceptanceWindow(row));
}

export function getComponent(componentId: string): ComponentRow | undefined {
  return conn()
    .prepare(
      `SELECT component_id, tenant_id, status, build_measurement,
              attestation_provider, attestation_status,
              last_verified_counter, last_verified_at, last_seen_at,
              chain_key_counter, chain_key_hex,
              bdk_fingerprint, heartbeat_window_seconds,
              acceptance_window_counters, window_floor_counter, window_floor_key_hex,
              provisioned_at
         FROM components WHERE component_id = ?`,
    )
    .get(componentId) as ComponentRow | undefined;
}

/**
 * The best chain key at or before `target` that this row already holds.
 *
 * Two checkpoints are candidates and the nearer one wins: the forward
 * cache (K at the high-water mark + 1) for ordinary traffic, and the
 * window floor for a backfill, where the forward cache is AHEAD of the
 * target and therefore useless — the chain does not run backwards.
 * Neither is trusted across a BDK change: if bdk_fingerprint does not
 * match the BDK this process holds, the cached key was derived from a
 * different root and re-deriving from the IK is the only correct move.
 */
function checkpointFor(row: ComponentRow, target: number, fp: string): { start: number; key: Buffer } {
  if (cacheEnabled() && row.bdk_fingerprint === fp) {
    const candidates: Array<{ start: number; hex: string }> = [];
    if (row.chain_key_hex !== null && row.chain_key_counter !== null && row.chain_key_counter <= target) {
      candidates.push({ start: row.chain_key_counter, hex: row.chain_key_hex });
    }
    if (
      row.window_floor_key_hex !== null &&
      row.window_floor_counter !== null &&
      row.window_floor_counter <= target
    ) {
      candidates.push({ start: row.window_floor_counter, hex: row.window_floor_key_hex });
    }
    let best: { start: number; hex: string } | null = null;
    for (const c of candidates) if (!best || c.start > best.start) best = c;
    if (best) {
      const key = Buffer.from(best.hex, 'hex');
      if (key.length === 32) return { start: best.start, key };
      zeroize(key);
    }
  }
  return { start: 0, key: deriveIk(bdk(), row.component_id) };
}

/**
 * Recover K at the counter we need, from a checkpoint where one is usable
 * and from the BDK where none is. Returns a Ratchet positioned AT
 * `target`.
 */
function ratchetTo(row: ComponentRow, target: number): Ratchet | VerifyFail {
  const fp = bdkFingerprint();
  const { start, key } = checkpointFor(row, target, fp);

  const steps = target - start;
  if (steps < 0) {
    // Unreachable by construction — checkpointFor only returns starts at
    // or before target — but a chain that ran backwards would be a silent
    // key-reuse bug, so it fails loudly rather than being assumed away.
    zeroize(key);
    return {
      ok: false,
      reason: 'invalid_counter',
      message: 'Chain-key checkpoint is ahead of the requested counter.',
      detail: { checkpoint_at: start, requested: target },
    };
  }
  if (steps > MAX_RATCHET_ADVANCE) {
    zeroize(key);
    return {
      ok: false,
      reason: 'counter_too_far',
      message:
        `Counter ${target} is more than ${MAX_RATCHET_ADVANCE} steps beyond the nearest ` +
        'chain-key checkpoint for this component. Refusing to ratchet that far in one ' +
        'request — the counter travels in the clear and is attacker-chosen, so work ' +
        'proportional to it is capped. Re-provision the component if this is genuine.',
      detail: { from: start, to: target, max_advance: MAX_RATCHET_ADVANCE },
    };
  }

  ratchetCallsTotal += 1;
  ratchetStepsTotal += steps;
  const advanced = ratchetForward(key, steps);
  zeroize(key);
  return new Ratchet(advanced, target);
}

interface GapRow {
  id: number;
  from_counter: number | null;
  to_counter: number;
}

/**
 * Open gap rows whose missing range claims `counter`.
 *
 * A gap row [from, to] means counters from+1 .. to-1 were produced and
 * never arrived; from_counter NULL means the gap precedes the component's
 * first delivered event and starts at 0.
 */
function gapsClaiming(componentId: string, counter: number): GapRow[] {
  return conn()
    .prepare(
      `SELECT id, from_counter, to_counter
         FROM component_counter_gaps
        WHERE component_id = ?
          AND resolved_at IS NULL
          AND to_counter > ?
          AND (from_counter IS NULL OR from_counter < ?)`,
    )
    .all(componentId, counter, counter) as GapRow[];
}

/**
 * Verify one submission and reconcile the component's counter state.
 *
 * Writes on success: the event row, any gap row or gap resolution, the
 * component's high-water mark, chain-key checkpoints and last_seen_at —
 * in one transaction, because a verified event whose high-water mark did
 * not advance is a counter that can be replayed.
 *
 * `principal` is first because ORDER IS THE POINT (§10 C-6). Everything
 * before `ratchetTo()` below is a hashed-key lookup, an indexed row read
 * and two integer comparisons; the only work proportional to the
 * attacker-supplied counter happens after all of them. A caller with no
 * API key cannot reach this function at all, and a caller with someone
 * else's key stops at the tenant check.
 */
export function verifySubmission(
  principal: AuthenticatedTenant,
  input: VerifyInput,
): VerifyResult {
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
  // C-6, second half. A component in another tenant's estate answers
  // EXACTLY as one that does not exist — the same reasoning
  // principalFrom() applies to key lookup and /components/status applies
  // to component ids: the difference is useful to someone enumerating ids
  // and useless to the owner. Placed here, above every other check, so
  // that an authenticated caller still cannot make this process ratchet on
  // a component that is not theirs.
  if (row.tenant_id !== principal.userId) {
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

  // Rule 1, first half — the stored fact. An exact re-delivery is the
  // designed retry, not an attack, and must not be logged as one; the
  // same counter with different bytes is a counter being reused, which
  // never happens honestly.
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

  // Rule 1, second half — the bounded acceptance window (§10 C-3).
  //
  // NULL last_verified_counter means nothing has ever verified, which is
  // not the same as 0: conflating them would make event 0 the one counter
  // with no high-water mark to be measured against.
  const last = row.last_verified_counter;
  const isBackfill = last !== null && counter <= last;
  let claimingGaps: GapRow[] = [];

  if (isBackfill) {
    const floor = windowFloor(row);
    if (counter < floor) {
      return {
        ok: false,
        reason: 'counter_too_far',
        message:
          `Counter ${counter} is more than ${acceptanceWindow(row)} below this component's ` +
          `high-water mark (${last}). Late drains are accepted inside that window (§10 C-3); ` +
          'beyond it the event is refused rather than verified, because re-deriving the ' +
          'chain key that far back is unbounded work on an attacker-chosen counter. If ' +
          'this is a genuine event held for that long, it is evidence of an outage the ' +
          'component should be re-provisioned after.',
        detail: {
          counter,
          last_verified_counter: last,
          window_floor: floor,
          acceptance_window_counters: acceptanceWindow(row),
        },
      };
    }

    claimingGaps = gapsClaiming(componentId, counter);
    if (claimingGaps.length === 0) {
      // Inside the window, unseen in component_events, and yet no gap
      // claims it. For honest traffic that combination cannot arise —
      // every skipped counter gets a gap row the moment a higher counter
      // lands — so it means the event ledger no longer holds a row it
      // once did. The gap table is the second record that says the
      // counter was spent, and it is believed.
      return {
        ok: false,
        reason: 'replay',
        message:
          `Counter ${counter} is at or below this component's high-water mark (${last}) and ` +
          'no open gap claims it, so it was already delivered. Counters are spent once. ' +
          'A queued event draining late (§5) is accepted, because the gap recorded when ' +
          'the later counter landed says it is still outstanding.',
        detail: { counter, last_verified_counter: last },
      };
    }
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

  const ts = nowIso();
  const fp = bdkFingerprint();
  const db = conn();

  // Rule 2 — the gap verifies and is recorded. Forward only: a backfill
  // fills a gap rather than opening one.
  const expectedNext = last === null ? 0 : last + 1;
  const missing = isBackfill ? 0 : counter - expectedNext;
  let gapId: number | null = null;
  const gapsClosed: number[] = [];

  // The window floor for the state this event leaves behind, and the key
  // at it. Best-effort: a checkpoint that cannot be built costs CPU on a
  // future backfill and nothing else, so it must never fail a
  // verification that has already MACed correctly.
  let floorCounter: number | null = null;
  let floorHex: string | null = null;
  if (!isBackfill && cacheEnabled()) {
    const nf = Math.max(0, counter + 1 - acceptanceWindow(row));
    if (nf > 0) {
      const at = ratchetTo(row, nf);
      if (at instanceof Ratchet) {
        const k = at.chainKey();
        floorCounter = nf;
        floorHex = k.toString('hex');
        zeroize(k);
        at.destroy();
      }
    }
    // nf === 0 stays NULL: K_0 is the IK, and the server derives that
    // from the BDK in two HMACs. Persisting a component's root to save
    // two HMACs is a bad trade in exactly one direction.
  }

  // §10 C-4, WO-15 — the registry check, at ingest.
  //
  // The measurement checked is the one this EVENT declared, falling back
  // to the one the component PROVISIONED with. The fallback is not a
  // guess: both are declarations by the same component under the same IK,
  // and the provisioned one is its standing statement about itself. It is
  // the same resolution the returned `build_measurement` has always used,
  // kept identical so a receipt and a status can never name two different
  // builds for one event.
  //
  // Evaluated AS OF `ts`, not as of "now-at-read-time", and written down
  // here rather than derived later. That is what makes withdrawal safe: a
  // build withdrawn tomorrow does not reach backwards and restate what
  // this event was ingested under. A late drain (§5) carries the ts at
  // which it was VERIFIED, which is the only time the server can honestly
  // claim to know — the component's capture time is the component's
  // assertion and is not in the preimage.
  const claimedBuild = input.buildMeasurement ?? row.build_measurement;
  const buildStatus: BuildCheck = checkClaimedBuild(claimedBuild, ts);

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO component_events
         (component_id, counter, mac, preimage_sha256, build_measurement, build_status,
          backfilled, verified_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      componentId,
      counter,
      mac,
      preimageSha,
      input.buildMeasurement ?? null,
      buildStatus,
      isBackfill ? 1 : 0,
      ts,
    );

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

    // A gap whose every missing counter has now arrived is RESOLVED, not
    // deleted: "three events went undelivered for two hours and then
    // drained" is a different fact from "nothing ever went wrong", and
    // the reconciliation view has to be able to tell them apart.
    for (const g of claimingGaps) {
      const lo = (g.from_counter ?? -1) + 1;
      const hi = g.to_counter - 1;
      if (hi < lo) continue;
      const have = db
        .prepare(
          `SELECT COUNT(*) AS c FROM component_events
            WHERE component_id = ? AND counter >= ? AND counter <= ?`,
        )
        .get(componentId, lo, hi) as { c: number };
      if (have.c >= hi - lo + 1) {
        db.prepare(`UPDATE component_counter_gaps SET resolved_at = ? WHERE id = ?`).run(ts, g.id);
        gapsClosed.push(g.id);
      }
    }

    if (isBackfill) {
      // The high-water mark and the forward chain-key cache belong to a
      // LATER counter and must not be dragged backwards by a late
      // arrival. Only liveness moves.
      db.prepare(`UPDATE components SET last_seen_at = ?, updated_at = ? WHERE component_id = ?`).run(
        ts,
        ts,
        componentId,
      );
    } else {
      db.prepare(
        `UPDATE components
            SET last_verified_counter = ?,
                last_verified_at      = ?,
                last_seen_at          = ?,
                chain_key_counter     = ?,
                chain_key_hex         = ?,
                window_floor_counter  = ?,
                window_floor_key_hex  = ?,
                bdk_fingerprint       = ?,
                updated_at            = ?
          WHERE component_id = ?`,
      ).run(
        counter,
        ts,
        ts,
        cacheEnabled() ? counter + 1 : null,
        cacheEnabled() ? nextKey.toString('hex') : null,
        floorCounter,
        floorHex,
        fp,
        ts,
        componentId,
      );
    }
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
    backfilled: isBackfill,
    gaps_closed: gapsClosed,
    attestation_status: row.attestation_status,
    build_changed: buildChanged,
    build_measurement: input.buildMeasurement ?? row.build_measurement,
    build_status: buildStatus,
  };
}

/**
 * Components that have gone quiet (§4.2, Missing 2). Implemented in
 * lib/reconcile/silence.ts, which owns the predicate so the reconciliation
 * view and this module cannot drift into two definitions of silent.
 */
export { silentComponents } from '@/lib/reconcile/silence';

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

/** Every gap, resolved or not — what the status view reports. */
export function allGaps(componentId: string) {
  return conn()
    .prepare(
      `SELECT id, from_counter, to_counter, missing_count, observed_at, resolved_at
         FROM component_counter_gaps
        WHERE component_id = ?
        ORDER BY to_counter ASC`,
    )
    .all(componentId) as Array<{
    id: number;
    from_counter: number | null;
    to_counter: number;
    missing_count: number;
    observed_at: string;
    resolved_at: string | null;
  }>;
}
