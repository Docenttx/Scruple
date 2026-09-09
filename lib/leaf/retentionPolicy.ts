// The retention policy, and the rule that its digest binds a DURATION.
//
// WO-C3. SETTLED BY THE BLENDER×COMFYUI COUNCIL (artifact `1a978a6`, §2
// Architect's ruling, Appendix C). `docs/wo/2026-09-09-council-implementation.md`
// is the work order.
//
// ---------------------------------------------------------------------------
// ARCHITECT'S SECOND SETTLE CONDITION, VERBATIM
// ---------------------------------------------------------------------------
//
//   "the `retention_policy_digest` must bind evidence RETENTION DURATION, not
//    just policy identity, so a resolution attempt after the evidence is
//    legitimately gone yields a named `evidence_expired` state rather than
//    being INDISTINGUISHABLE FROM A FORGED HANDLE."
//
// The claims-versus-evidence split (WO-C2) took the Merkle path and the raw
// quote out of the leaf and left a handle pointing at them. That is only
// tenable while the thing pointed at is there. Evidence is reaped on a
// schedule, legitimately, and the day after it is reaped a verifier following
// the handle gets exactly what an attacker's fabricated handle gets: nothing.
// Measured on this estate before the change and recorded in
// `/mnt/corpus/scruple-council-impl/wo-c3/01-controls-RED.txt` — the two
// answers were BYTE-IDENTICAL.
//
// A digest over a policy NAME cannot fix that. `sha256("vendor-default")`
// tells a verifier which document applied and nothing about when the evidence
// stops existing, so the verifier still cannot tell the two apart; it has
// merely learned the name of the policy under which it cannot tell.
//
// So the digest is taken over an object that CONTAINS the durations. Two
// policies with the same `policy_id` and different `retention_duration_s` have
// different digests, by construction — `test/v2/retention-settlement.test.ts`
// asserts exactly that, and asserts the identity half stays equal so the test
// is measuring the duration and not the object.
//
// ---------------------------------------------------------------------------
// WHY THE POLICY NAMES THE CLOCK
// ---------------------------------------------------------------------------
//
// Because a duration is not a time. "Thirty days" becomes "gone at 14:00 on
// the eighth" only against some clock, and Architect's other half of the same
// ruling is that the clock must be NAMED (`lib/leaf/namedClock.ts`). Putting
// the clock name inside the digested object means the leaf's single signed
// handle binds the duration AND the clock it is counted on, and neither can be
// swapped for a friendlier one without changing the digest the component MACed.
//
// ---------------------------------------------------------------------------
// ⚑ THE POLICY GOVERNS THE EVIDENCE, NOT THE LEAF RECORD
// ---------------------------------------------------------------------------
//
// `retention_duration_s` is how long the CHECKPOINT EVIDENCE — the Merkle
// inclusion path, the quote — is kept. The leaf record itself must outlive it,
// because the leaf record is what answers `evidence_expired`. A deployment
// that reaps the row as well destroys the distinction this whole file exists
// to create, and is back to a 404 that means either "legitimately gone" or
// "you made that up". That is a deployment requirement and it is stated in
// `docs/canon/council-impl/WO-C3.md` §7 rather than enforced here, because
// nothing in this process can stop an operator running a DELETE.

// ⚑ THIS MODULE IS PURE ON PURPOSE. The enrolment registry — the half that
// touches the database — is `lib/leaf/retentionRegistry.ts`, because the
// capture sidecar imports the digest function to build its leaf and a sidecar
// container must not pull `better-sqlite3` in behind it. Same separation
// `componentPreimage.ts` keeps from the route.

import crypto from 'node:crypto';
import { canonicalize } from '@/lib/leaf/canonicalJson';
import { isRefusedClockName, NAMED_CLOCKS } from '@/lib/leaf/namedClock';

/** The digested object. Every field is inside the digest; there is no
 *  un-digested half, because a half nobody hashes is a half anybody edits. */
export interface RetentionPolicy {
  /** Bumped when the SHAPE changes. A version inside the digest is what makes
   *  a future field addition a new digest rather than a silent reinterpretation
   *  of an old one — the same versioning discipline WO-C6 requires of the
   *  Merkle root, applied before it is needed rather than after. */
  version: 1;
  /** WHICH policy. Identity — necessary, and on its own exactly what
   *  Architect refused. */
  policy_id: string;
  /** The clock the two durations are counted on. Named, never local. */
  clock: string;
  /** HOW LONG THE EVIDENCE IS KEPT, from the moment the witness received the
   *  leaf. This is the field whose absence made the digest useless. */
  retention_duration_s: number;
  /** How long an unresolved gap stays open before it is a finding. Bounded by
   *  the retention duration: a deadline that falls after the evidence is gone
   *  is a deadline nobody can ever check. */
  settlement_window_s: number;
}

export const RETENTION_POLICY_VERSION = 1 as const;

/** One year. Longer than this and `settlement_window_s` is not a window. */
const MAX_DURATION_S = 366 * 24 * 3600;

export function validateRetentionPolicy(p: unknown): { ok: true } | { ok: false; reason: string } {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return { ok: false, reason: 'not an object' };
  const o = p as Record<string, unknown>;
  if (o.version !== RETENTION_POLICY_VERSION) {
    return { ok: false, reason: `version must be ${RETENTION_POLICY_VERSION}` };
  }
  if (typeof o.policy_id !== 'string' || o.policy_id.trim() === '') {
    return { ok: false, reason: 'policy_id must be a non-empty string' };
  }
  if (typeof o.clock !== 'string' || o.clock.trim() === '') {
    return { ok: false, reason: 'clock must be a non-empty string' };
  }
  if (isRefusedClockName(o.clock)) {
    return {
      ok: false,
      reason:
        `clock \`${o.clock}\` is the emitter's own clock under an institutional-sounding name. ` +
        'A deadline counted on it is the config-inherited field class this design refuses.',
    };
  }
  for (const k of ['retention_duration_s', 'settlement_window_s'] as const) {
    const v = o[k];
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v <= 0) {
      return { ok: false, reason: `${k} must be a positive safe integer number of seconds` };
    }
    if ((v as number) > MAX_DURATION_S) return { ok: false, reason: `${k} exceeds one year` };
  }
  if ((o.settlement_window_s as number) > (o.retention_duration_s as number)) {
    return {
      ok: false,
      reason:
        'settlement_window_s exceeds retention_duration_s: the gap would become terminal after ' +
        'the evidence needed to settle it is gone, which is a deadline nobody can ever check',
    };
  }
  const extra = Object.keys(o).filter(
    (k) => !['version', 'policy_id', 'clock', 'retention_duration_s', 'settlement_window_s'].includes(k),
  );
  if (extra.length) return { ok: false, reason: `unknown keys: ${extra.join(', ')}` };
  return { ok: true };
}

/** The canonical bytes. `jcs-2`, the same profile every other digest on this
 *  estate is taken under — a second canonicalisation rule for one small object
 *  is a second answer to "what is the digest". */
export function canonicalRetentionPolicy(p: RetentionPolicy): string {
  const v = validateRetentionPolicy(p);
  if (!v.ok) throw new Error(`refusing to digest an invalid retention policy: ${v.reason}`);
  return canonicalize({
    version: p.version,
    policy_id: p.policy_id,
    clock: p.clock,
    retention_duration_s: p.retention_duration_s,
    settlement_window_s: p.settlement_window_s,
  });
}

export const RETENTION_DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

/** `sha256:<hex>` over the canonical bytes — durations included, which is the
 *  entire point of the field. */
export function retentionPolicyDigest(p: RetentionPolicy): string {
  return 'sha256:' + crypto.createHash('sha256').update(canonicalRetentionPolicy(p), 'utf8').digest('hex');
}

/**
 * THE DEFAULT POLICY, and the digest a component gets when a deployment has
 * not enrolled its own. Thirty days of evidence, one day to settle.
 *
 * ⚑ THE DIGEST IS A LITERAL IN MIGRATION 055 AND A COMPUTED VALUE HERE, and
 * `test/v2/retention-settlement.test.ts` asserts the two agree. A seeded row
 * whose digest was computed by a different version of this function would
 * resolve for nobody, and would look like a policy that was simply never
 * enrolled.
 */
export const DEFAULT_RETENTION_POLICY: RetentionPolicy = {
  version: RETENTION_POLICY_VERSION,
  policy_id: 'scruple-default-v1',
  clock: Object.keys(NAMED_CLOCKS)[0],
  retention_duration_s: 30 * 24 * 3600,
  settlement_window_s: 24 * 3600,
};

export const DEFAULT_RETENTION_POLICY_DIGEST = retentionPolicyDigest(DEFAULT_RETENTION_POLICY);
