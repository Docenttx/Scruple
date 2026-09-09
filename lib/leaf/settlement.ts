// Settlement: when silence becomes a finding, and what a resolution attempt
// answers once the evidence is legitimately gone.
//
// WO-C3. SETTLED BY THE BLENDER×COMFYUI COUNCIL (artifact `1a978a6`, §1, §2
// Architect's and IT Expert's rulings, hand round 7 §2, round 11 §1,
// Appendix C). `docs/wo/2026-09-09-council-implementation.md` is the WO.
//
// ---------------------------------------------------------------------------
// THE PROBLEM, IN ARCHITECT'S WORDS
// ---------------------------------------------------------------------------
//
//   "unbounded is not tolerable, because an unresolved gap that never expires
//    is INDISTINGUISHABLE FROM A POLICY OF NEVER CHECKING — the verifier
//    defaults to accept by exhaustion. The bound must be CARRIED IN THE LEAF
//    as a declared `settlement_deadline` plus the retention policy digest in
//    force, so a verifier reading the leaf alone knows when silence becomes a
//    finding rather than having to fetch out-of-band policy; at deadline the
//    gap flips to a terminal `expired`, which is an assertion about the
//    COMPONENT'S DELIVERY, not about the leaf's validity."
//
// And IT Expert, closing: "downstream verifiers observe an explicit,
// timeout-driven `expired` absence at `settlement_deadline` rather than a hung
// queue."
//
// ---------------------------------------------------------------------------
// TWO CLASSES OF FACT, AND THEY ARE STORED SEPARATELY ON PURPOSE
// ---------------------------------------------------------------------------
//
//   SIGNED BY THE COMPONENT   `settlement_deadline`, `retention_policy_digest`
//                             — inside the MAC preimage (WO-C2's block), so a
//                             party in the middle can neither move a deadline
//                             nor swap a policy for a longer-lived one.
//
//   MEASURED BY THIS SERVER   the named clock, its authority, the instant it
//                             was read at ingest, and the derived
//                             `evidence_retained_until`.
//
// The component's deadline is a CLAIM. It has to be — the component is what
// knows its own settlement window — but it is derived from the component's own
// clock, and a claim derived from a locally-set timestamp is the
// config-inherited field class the council refused. So the claim is CHECKED
// against the named clock at ingest (`bindSettlement`), and the terminal
// verdict is computed only from the named clock (`evaluateSettlement`). A
// component with a two-hour-fast clock is refused rather than believed, and no
// component can produce a terminal `expired` at all.
//
// ---------------------------------------------------------------------------
// THREE STATES, AND THEY MAY NOT COLLAPSE
// ---------------------------------------------------------------------------
//
//   resolvable        the evidence should be there; go and fetch it
//   evidence_expired  it was there and the retention window has run out —
//                     a NAMED state, measured against the named clock
//   unresolvable      no such leaf, or a handle that does not match what was
//                     signed. The forged case, and its neighbours.
//
// Before this WO all three were one answer: a bare HTTP 404, byte-identical
// for a reaped leaf and for a leaf id nobody ever issued. That run is recorded
// at `/mnt/corpus/scruple-council-impl/wo-c3/01-controls-RED.txt`.

import {
  MAX_CLOCK_SKEW_S,
  NAMED_CLOCKS,
  readNamedClock,
  parseInstant,
} from '@/lib/leaf/namedClock';
import { RETENTION_DIGEST_RE } from '@/lib/leaf/retentionPolicy';
import {
  resolveRetentionPolicy,
  type EnrolledRetentionPolicy,
} from '@/lib/leaf/retentionRegistry';
import type { ResolutionHandles } from '@/lib/leaf/resolutionHandles';

/* ────────────────────────────────────────────────────────────────────────
 * INGEST — bind the signed claim to a named clock, or refuse it.
 * ──────────────────────────────────────────────────────────────────────── */

/** What the route stores beside the two signed handles. All measured. */
export interface SettlementBinding {
  /** The signed claim, verbatim. */
  deadline: string;
  /** The signed digest, verbatim. */
  retention_policy_digest: string;
  /** The policy that digest RESOLVED to — durations, not a name. */
  policy: EnrolledRetentionPolicy;
  /** The clock this server read, and who answers for the reading. */
  clock: string;
  clock_authority: string;
  /** The instant the named clock reported at ingest. */
  observed_at: string;
  /** observed_at + retention_duration_s. When the EVIDENCE stops existing. */
  evidence_retained_until: string;
}

export type SettlementRefusalCode =
  | 'retention_policy_unresolvable'
  | 'settlement_deadline_unbound';

export type SettlementBindResult =
  | { ok: true; binding: SettlementBinding | null }
  | { ok: false; code: SettlementRefusalCode; message: string; detail: Record<string, unknown> };

/**
 * Called by POST /api/v2/witness after the handles validate. Returns
 * `binding: null` for a leaf that carries no deadline — a legacy leaf, or a
 * component-less caller. `validateResolutionHandles()` has already refused a
 * capture-bearing leaf that carries neither, so "null" here means "this leaf
 * predates the design", not "this leaf skipped the rule".
 */
export function bindSettlement(
  handles: Pick<ResolutionHandles, 'settlement_deadline' | 'retention_policy_digest'> | null,
  atMs: number = Date.now(),
): SettlementBindResult {
  const deadline = handles?.settlement_deadline ?? null;
  const digest = handles?.retention_policy_digest ?? null;
  if (deadline === null && digest === null) return { ok: true, binding: null };

  // Shape is the validator's job and it has run; this is the belt.
  if (deadline === null || digest === null || !RETENTION_DIGEST_RE.test(digest)) {
    return {
      ok: false,
      code: 'retention_policy_unresolvable',
      message:
        'A settlement deadline and a retention policy digest are one fact and must arrive ' +
        'together. A deadline with no policy is a deadline against nothing.',
      detail: { settlement_deadline: deadline, retention_policy_digest: digest },
    };
  }

  // ---- The digest must resolve to DURATIONS, not to a name.
  //
  // Architect's second settle condition, enforced where a caller meets it: a
  // digest this deployment cannot resolve binds no retention duration, so a
  // resolution attempt against this leaf could never distinguish "the evidence
  // was reaped on schedule" from "you invented this handle". Accepting it
  // would store a leaf that is unresolvable-by-construction and looks exactly
  // like one that is fine.
  const policy = resolveRetentionPolicy(digest);
  if (!policy) {
    return {
      ok: false,
      code: 'retention_policy_unresolvable',
      message:
        '`resolution.retention_policy_digest` names no retention policy this deployment has ' +
        'enrolled, so it binds no evidence retention DURATION — only, at best, a policy ' +
        'identity. That is the shape the council refused: a verifier who follows this leaf ' +
        'after the evidence is legitimately gone cannot tell that from a forged handle. Enrol ' +
        'the policy (lib/leaf/retentionPolicy.ts) and send the digest of the enrolled object.',
      detail: { retention_policy_digest: digest },
    };
  }

  // ---- The clock the policy names must be one THIS SERVER CAN READ.
  //
  // Otherwise the deadline below is checked against nothing and the terminal
  // `expired` at query time is computed from a clock we invented — which is
  // the config-inherited field with an extra step. A partner's timestamp
  // authority is a legitimate future entry in NAMED_CLOCKS; until it is one,
  // a leaf counted on it is refused rather than half-checked.
  const clock = readNamedClock(policy.clock, atMs);
  if (!clock) {
    return {
      ok: false,
      code: 'settlement_deadline_unbound',
      message:
        `The retention policy counts its durations on the clock \`${policy.clock}\`, and this ` +
        'server is not an authority for that clock. It cannot read it, so it cannot check this ' +
        'leaf\'s deadline against it and could not later measure an expiry against it either. ' +
        'A deadline nobody named a readable clock for is exactly the config-inherited field ' +
        'class this design refuses.',
      detail: { clock: policy.clock, readable_clocks: Object.keys(NAMED_CLOCKS) },
    };
  }

  const deadlineMs = parseInstant(deadline);
  if (deadlineMs === null) {
    return {
      ok: false,
      code: 'settlement_deadline_unbound',
      message:
        '`resolution.settlement_deadline` must be an RFC 3339 UTC instant ending in `Z`.',
      detail: { settlement_deadline: deadline },
    };
  }

  // ---- THE BAND. This is the check that catches a locally-set deadline.
  //
  // The policy says how long a settlement window is. The named clock says what
  // time it is now. A component whose clock agrees with the named clock
  // therefore lands its deadline within a few seconds of
  // `now + settlement_window_s`; a component whose clock is two hours fast
  // lands it two hours out, in perfect good faith, and its "deadline" is a
  // statement about its own machine rather than about the clock the policy
  // names. MAX_CLOCK_SKEW_S is the NTP-sane band either side.
  const expectedMs = clock.read_at_ms + policy.settlement_window_s * 1000;
  const skewMs = deadlineMs - expectedMs;
  if (Math.abs(skewMs) > MAX_CLOCK_SKEW_S * 1000) {
    return {
      ok: false,
      code: 'settlement_deadline_unbound',
      message:
        `\`resolution.settlement_deadline\` is ${Math.round(skewMs / 1000)}s from where the ` +
        `named clock \`${clock.name}\` puts the end of this policy's ${policy.settlement_window_s}s ` +
        'settlement window. A deadline that far out was derived from a clock nobody named — the ' +
        'config-inherited field class the council refused — and a terminal `expired` measured ' +
        'against it would be an assertion about the emitter\'s own machine.',
      detail: {
        settlement_deadline: deadline,
        named_clock: clock.name,
        clock_authority: clock.authority,
        clock_read_at: clock.read_at,
        settlement_window_s: policy.settlement_window_s,
        skew_s: Math.round(skewMs / 1000),
        max_skew_s: MAX_CLOCK_SKEW_S,
      },
    };
  }

  const retainedUntilMs = clock.read_at_ms + policy.retention_duration_s * 1000;
  // ---- And the deadline may not fall after the evidence is gone.
  //
  // `validateRetentionPolicy` already refuses a policy whose window exceeds
  // its retention, so this catches the other route to the same state: a
  // deadline pushed out by clock skew inside the band, on a policy whose two
  // durations are close together. A gap that becomes terminal after the
  // evidence needed to settle it has been reaped is a finding nobody can ever
  // check.
  if (deadlineMs > retainedUntilMs) {
    return {
      ok: false,
      code: 'settlement_deadline_unbound',
      message:
        'The settlement deadline falls AFTER this policy\'s evidence retention window closes. ' +
        'The gap would become terminal at a moment when the evidence needed to settle it is ' +
        'legitimately gone, which is a finding nobody can ever check.',
      detail: {
        settlement_deadline: deadline,
        evidence_retained_until: new Date(retainedUntilMs).toISOString(),
        retention_duration_s: policy.retention_duration_s,
      },
    };
  }

  return {
    ok: true,
    binding: {
      deadline,
      retention_policy_digest: digest,
      policy,
      clock: clock.name,
      clock_authority: clock.authority,
      observed_at: clock.read_at,
      evidence_retained_until: new Date(retainedUntilMs).toISOString(),
    },
  };
}

/* ────────────────────────────────────────────────────────────────────────
 * RESOLUTION — the three states, from one query path.
 * ──────────────────────────────────────────────────────────────────────── */

export type EvidenceState = 'resolvable' | 'evidence_expired' | 'unresolvable';

/** Why, when the state is `unresolvable`. The STATE is one; the reasons are
 *  three, and flattening them would hide a legacy leaf inside the forged
 *  bucket. */
export type UnresolvableReason =
  | 'unknown_leaf'
  | 'handle_mismatch'
  | 'no_retention_binding';

/** What a leaf row has to carry for any of this to be answerable. */
export interface SettlementRow {
  resolution_settlement_deadline: string | null;
  resolution_retention_policy_digest: string | null;
  settlement_clock: string | null;
  settlement_clock_authority: string | null;
  settlement_observed_at: string | null;
  evidence_retained_until: string | null;
  resolution_checkpoint_id: string | null;
}

export type SettlementState = 'settled' | 'pending' | 'expired' | 'unknown';

export interface SettlementVerdict {
  state: SettlementState;
  /** Terminal means: this will not change again. Only `expired` and
   *  `settled` are terminal. */
  terminal: boolean;
  /** THE FIELD ARCHITECT ASKED FOR. `expired` is only ever 'measured', and
   *  only ever against the named clock below. A row with no clock reads
   *  'unknown' and can never read 'expired'. */
  source: 'measured' | 'unknown';
  deadline: string | null;
  clock: { name: string; authority: string; read_at: string; caveat: string } | null;
  /** Plain English, for the person reading a receipt. */
  says: string;
}

/**
 * The settlement verdict, computed from the NAMED CLOCK at the moment of the
 * query — never from a stored state column.
 *
 * ⚑ THERE IS NO `settlement_state` COLUMN AND THAT IS DELIBERATE. A stored
 * state would be written by a reaper on a schedule, and would then be wrong
 * for exactly as long as the reaper was down — which is the failure mode this
 * whole mechanism exists to make visible, reintroduced inside the mechanism.
 * The deadline is a fact; the state is a comparison; the comparison is done
 * when somebody asks.
 */
export function evaluateSettlement(row: SettlementRow, atMs: number = Date.now()): SettlementVerdict {
  if (row.resolution_checkpoint_id) {
    return {
      state: 'settled',
      terminal: true,
      source: 'measured',
      deadline: row.resolution_settlement_deadline,
      clock: null,
      says: 'this leaf names a checkpoint, so the gap closed before its deadline.',
    };
  }
  const deadline = row.resolution_settlement_deadline;
  const clockName = row.settlement_clock;
  if (!deadline || !clockName) {
    // A leaf written before this design, or by a component-less caller. It
    // never declared when silence becomes a finding, so nothing here may
    // decide that it has.
    return {
      state: 'unknown',
      terminal: false,
      source: 'unknown',
      deadline: null,
      clock: null,
      says:
        'this leaf declared no settlement deadline, so there is no moment at which its silence ' +
        'becomes a finding. It is not pending and it is not expired: the question was never asked.',
    };
  }
  const clock = readNamedClock(clockName, atMs);
  if (!clock) {
    // The clock was readable at ingest and is not readable now — a clock
    // withdrawn from NAMED_CLOCKS. `expired` would have to be measured against
    // something, and there is nothing.
    return {
      state: 'unknown',
      terminal: false,
      source: 'unknown',
      deadline,
      clock: null,
      says:
        `this leaf's deadline is counted on the clock \`${clockName}\`, which this server can no ` +
        'longer read. A terminal `expired` requires a measurement against a named clock, and ' +
        'there is none to make.',
    };
  }
  const deadlineMs = parseInstant(deadline);
  if (deadlineMs === null) {
    return {
      state: 'unknown', terminal: false, source: 'unknown', deadline, clock: null,
      says: 'this leaf\'s stored deadline is not a readable instant.',
    };
  }
  const past = clock.read_at_ms >= deadlineMs;
  return {
    state: past ? 'expired' : 'pending',
    terminal: past,
    // MEASURED, and this is the whole of Architect's condition: the clock was
    // read by a named authority at a recorded instant, and the comparison is
    // against that reading rather than against anything the emitter said.
    source: 'measured',
    deadline,
    clock: {
      name: clock.name,
      authority: clock.authority,
      read_at: clock.read_at,
      caveat: clock.caveat,
    },
    says: past
      ? 'the settlement deadline has passed with no checkpoint naming this leaf. The gap is ' +
        'TERMINAL: this is an assertion about the component\'s delivery, not about the leaf\'s ' +
        'validity.'
      : 'the settlement deadline has not passed. Silence is not yet a finding.',
  };
}

export interface EvidenceVerdict {
  state: EvidenceState;
  reason: UnresolvableReason | null;
  retained_until: string | null;
  /** Measured only when a named clock was read to decide it. */
  source: 'measured' | 'unknown';
  clock: { name: string; authority: string; read_at: string; caveat: string } | null;
  says: string;
}

/**
 * Is this leaf's EVIDENCE still there to be fetched?
 *
 * `supplied` is what the verifier read off the leaf it is holding and passed
 * back on the query — following a handle means going to the address it names
 * with the values it carries. When it does not match what was signed, the
 * verifier is holding a leaf this server did not issue, and the answer is
 * `unresolvable`, not a resolvable leaf that happens to disagree.
 */
export function evaluateEvidence(
  row: SettlementRow | null,
  supplied: { retention_policy_digest?: string | null; checkpoint_id?: string | null } = {},
  atMs: number = Date.now(),
): EvidenceVerdict {
  const noClock = { source: 'unknown' as const, clock: null, retained_until: null };
  if (!row) {
    return {
      state: 'unresolvable',
      reason: 'unknown_leaf',
      ...noClock,
      says: 'no leaf with this identifier was ever issued here.',
    };
  }
  if (
    supplied.retention_policy_digest != null &&
    supplied.retention_policy_digest !== row.resolution_retention_policy_digest
  ) {
    return {
      state: 'unresolvable',
      reason: 'handle_mismatch',
      ...noClock,
      says:
        'the retention policy digest on the leaf you are holding is not the one this leaf was ' +
        'signed with. Following it would resolve evidence against a policy nobody signed.',
    };
  }
  if (supplied.checkpoint_id != null && supplied.checkpoint_id !== row.resolution_checkpoint_id) {
    return {
      state: 'unresolvable',
      reason: 'handle_mismatch',
      ...noClock,
      says: 'the checkpoint id on the leaf you are holding is not the one this leaf was signed with.',
    };
  }
  if (!row.evidence_retained_until || !row.settlement_clock) {
    return {
      state: 'unresolvable',
      reason: 'no_retention_binding',
      ...noClock,
      says:
        'this leaf carries no retention binding, so nothing here knows whether its evidence is ' +
        'still kept. It was written before the design required one — which is a different fact ' +
        'from a forged handle, and is why this reason is reported beside the state.',
    };
  }
  const clock = readNamedClock(row.settlement_clock, atMs);
  if (!clock) {
    return {
      state: 'unresolvable',
      reason: 'no_retention_binding',
      ...noClock,
      retained_until: row.evidence_retained_until,
      says:
        `this leaf's retention is counted on \`${row.settlement_clock}\`, which this server can ` +
        'no longer read. Whether the evidence is still there is not measurable from here.',
    };
  }
  const untilMs = parseInstant(row.evidence_retained_until);
  const expired = untilMs !== null && clock.read_at_ms >= untilMs;
  const clockOut = {
    name: clock.name,
    authority: clock.authority,
    read_at: clock.read_at,
    caveat: clock.caveat,
  };
  if (expired) {
    return {
      state: 'evidence_expired',
      reason: null,
      retained_until: row.evidence_retained_until,
      // MEASURED. The named state exists precisely so that this is not a 404.
      source: 'measured',
      clock: clockOut,
      says:
        'the evidence for this leaf was retained for the duration its signed retention policy ' +
        'binds, and that duration has elapsed. It is LEGITIMATELY GONE. This is not a forged ' +
        'handle and not a missing leaf: the claim stands, and the material that would let you ' +
        'check it independently is no longer kept.',
    };
  }
  return {
    state: 'resolvable',
    reason: null,
    retained_until: row.evidence_retained_until,
    source: 'measured',
    clock: clockOut,
    says: 'the evidence for this leaf is within its retention window. Fetch it from the witness ' +
      'endpoint the leaf names, against the authority it names.',
  };
}
