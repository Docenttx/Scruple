// What counts as a MATERIAL CHANGE (WO-22).
//
// INTEGRATION_LIFECYCLE.md left this open on purpose: "Too strict and a
// vendor reseals on every dependency bump and stops bothering. Too loose
// and the seal means nothing. This is EMV L3's question and it has a
// documented answer there; ours must be documented too, not left to
// judgement." This file is the answer, and it is a judgement made
// explicitly rather than deferred to whoever reads the code next.
//
// ═══════════════════════════════════════════════════════════════════════
// THE DEFINITION
//
//   A CHANGE IS MATERIAL IF IT COULD CHANGE WHAT A LEAF SAYS, OR WHETHER
//   A LEAF IS PRODUCED AT ALL.
//
// "Could", not "did". The vendor does not get to argue that their edit
// happened not to matter; the question is whether the class of thing they
// edited is capable of mattering. That asymmetry is deliberate — the
// party making the judgement is the party who benefits from the answer
// being "no".
// ═══════════════════════════════════════════════════════════════════════
//
// WHAT WAS TAKEN FROM PCI P2PE AND EMV, AND WHAT WAS NOT
//
// 1. FROM PCI P2PE — SCOPE BY SECURITY IMPACT, NOT BY FILE CHURN.
//    P2PE (and the PCI change-management programme generally) classifies
//    a change to a listed solution by whether it touches the parts that
//    carry the security property — POI firmware, the applications inside
//    the POI, key management, the decryption environment — and routes
//    only those to a delta assessment. Documentation, branding and
//    non-cryptographic feature work are attested by the solution provider
//    and do not re-open the listing.
//
//    TAKEN: the trigger is the CLASS of the thing that moved, not the
//    number of bytes. `capture` and `config` carry the property here;
//    `dependency` does not carry it directly.
//
//    NOT TAKEN: P2PE's "the assessor decides" step. We have no assessor
//    in the loop, so the classification is computed from the manifest
//    diff by `classifyManifestChange()` below, and it is recorded on a
//    signed event so the judgement is attributable rather than implicit.
//
// 2. FROM EMV TYPE APPROVAL — AN EXPIRY THAT DOES NOT DEPEND ON CHANGE.
//    EMVCo approvals lapse on a fixed term whether or not anything
//    changed, and a maintenance change (a fix that does not affect
//    approved functionality) renews an approval rather than requiring a
//    new one.
//
//    TAKEN, AND IT IS THE LOAD-BEARING BORROWING. A materiality rule
//    permissive enough to let dependency bumps through is only defensible
//    if the seal cannot sit untouched forever. So `SEAL_TERM_DAYS` puts a
//    horizon on every seal, and re-sealing to the SAME measurement is
//    legal at renewal — EMV's maintenance approval — while being illegal
//    as a way to clear a declared material change, which would be
//    re-asserting the configuration you just told us you changed.
//
//    This is deliberately at odds with one line of
//    docs/canon/PUBLISHED_BUILDS.md §1, which refuses a future-dated
//    lifecycle event on the grounds that "scheduled withdrawal, if it is
//    ever wanted, should be a named concept with its own surface, not a
//    side effect of a date field". Agreed — and this is that named
//    concept. The term is a constant of the scheme, `seal_expires_at` is
//    on the status report, and it is not smuggled in as an operator-typed
//    date on an event.
//
// 3. FROM BOTH — THE VENDOR DECLARES, AND THE DECLARATION IS RECORDED.
//    Delta assessment in both programmes starts with the vendor's impact
//    analysis. Ours does too, and `change_class` on the signed event is
//    where that analysis lives. A vendor who classifies a capture rewrite
//    as `consequential` has signed a statement that is checkable against
//    the two manifests.
//
// ───────────────────────────────────────────────────────────────────────
// THE THREE CLASSES
//
//   `material`       Mandatory reseal. The deployment moves to
//                    `resealing` and CANNOT CLAIM THE STANDARD until it
//                    is sealed again.
//
//                    - any `capture` or `config` entry's digest changed
//                    - any `host` entry changed. INTEGRATION_LIFECYCLE.md
//                      is explicit: "A new upstream release is a new
//                      measurement and a new approval." A host upgrade is
//                      the ordinary way a hook stops firing, and Kohya is
//                      this estate's proof that when it does, the
//                      observable is a quiet afternoon.
//                    - ANY entry added or removed, in any class. The
//                      boundary itself moved, and a boundary that can be
//                      narrowed without re-approval is not a boundary. A
//                      removal is the one a permissive rule would miss:
//                      deleting the config entry that names the endpoint
//                      is how you stop sending leaves.
//
//   `consequential`  Recorded, COUNTED, and not an immediate reseal.
//                    A `dependency` entry's digest changed — a lockfile
//                    bump. This is the case the definition has to get
//                    right, because forcing a reseal here is exactly the
//                    "vendor stops bothering" failure, and waving it
//                    through is exactly the "seal means nothing" failure.
//
//                    THE ANSWER IS A BUDGET. Each one is a signed `drift`
//                    event on the record, and
//                    `CONSEQUENTIAL_CHANGE_BUDGET` of them forces a
//                    reseal. So an individual bump costs the vendor
//                    nothing, and a pipeline that has been quietly
//                    rebuilt out from under its seal one dependency at a
//                    time cannot keep claiming. Without the budget, the
//                    exemption is unbounded and "not material" becomes a
//                    way to replace the whole tree.
//
//   `administrative` No effect. A label, a note, a contact — anything
//                    outside the declared manifest. Named as a class
//                    rather than left as an absence, so that "we decided
//                    this does not matter" is a recordable judgement and
//                    not a silence.
//
// WHAT THIS DEFINITION IS DELIBERATELY NOT
//
// It is not a source-diff rule. Two `capture` trees differing only in a
// comment are a material change here, and that is the correct trade: a
// rule that has to decide whether a diff is semantically inert is a rule
// that has to be right about a program's behaviour, and it will be wrong
// silently. A digest is right or it is not.
//
// It is not a claim that a non-material change is a safe change. It is a
// claim about who has to re-approve what, which is the only question a
// lifecycle state can answer.

import type { BoundaryClass, PipelineManifest, ManifestEntry } from './measure';

export const CHANGE_CLASSES = ['material', 'consequential', 'administrative'] as const;
export type ChangeClass = (typeof CHANGE_CLASSES)[number];

/**
 * How long an approval stands with nothing changing at all.
 *
 * One year, EMV's shape. It is not a guess dressed as a constant: it is
 * the counterweight that makes exempting dependency bumps defensible, and
 * if it were removed the `consequential` class would have to become
 * `material`.
 */
export const SEAL_TERM_DAYS = 365;

/**
 * How many `consequential` changes a seal absorbs before it must be
 * renewed.
 *
 * Eight, and the number is arguable — what is not arguable is that there
 * has to be one. An unbounded exemption for "changes that cannot alter
 * what a leaf says" lets a vendor replace every pinned dependency in the
 * pipeline while holding a seal taken over the previous set.
 */
export const CONSEQUENTIAL_CHANGE_BUDGET = 8;

const SEVERITY: Record<ChangeClass, number> = {
  administrative: 0,
  consequential: 1,
  material: 2,
};

/** Which class a digest change in this boundary class raises. */
const CLASS_OF_EDIT: Record<BoundaryClass, ChangeClass> = {
  capture: 'material',
  config: 'material',
  host: 'material',
  dependency: 'consequential',
};

export interface ChangeVerdict {
  class: ChangeClass;
  /** One line per difference, in the words an auditor would want. */
  reasons: string[];
  /** True when this verdict forces a reseal. */
  requires_reseal: boolean;
}

const keyOf = (e: ManifestEntry) => `${e.class} ${e.id}`;

/**
 * Classify the difference between the approved manifest and a new one.
 *
 * The verdict is the MAXIMUM over every difference, not a summary: one
 * material edit inside a hundred dependency bumps is a material change,
 * and any rule that averaged would be a rule that a vendor could dilute.
 */
export function classifyManifestChange(
  approved: PipelineManifest,
  proposed: PipelineManifest,
): ChangeVerdict {
  const before = new Map(approved.entries.map((e) => [keyOf(e), e]));
  const after = new Map(proposed.entries.map((e) => [keyOf(e), e]));
  const reasons: string[] = [];
  // Held on an object rather than in a `let`: the assignment happens
  // inside `raise`, and TypeScript's control-flow analysis does not follow
  // a closure, so a bare local would narrow to its initialiser and make
  // the comparison below look unreachable.
  const acc: { worst: ChangeClass } = { worst: 'administrative' };
  const raise = (c: ChangeClass, why: string) => {
    reasons.push(why);
    if (SEVERITY[c] > SEVERITY[acc.worst]) acc.worst = c;
  };

  for (const [k, e] of after) {
    if (!before.has(k)) {
      // Additions and removals are material IN EVERY CLASS, including
      // `dependency`. A digest change to a pinned dependency is a
      // different version of a thing that was approved; ADDING one is a
      // thing that was never approved, and REMOVING one narrows the
      // boundary. The budget exemption is for the former only.
      raise('material', `added to the boundary: ${e.class} ${e.id}`);
    }
  }
  for (const [k, e] of before) {
    if (!after.has(k)) {
      raise('material', `removed from the boundary: ${e.class} ${e.id}`);
    }
  }
  for (const [k, e] of after) {
    const prev = before.get(k);
    if (!prev) continue;
    if (prev.sha256 !== e.sha256) {
      raise(CLASS_OF_EDIT[e.class], `${e.class} ${e.id} changed`);
    } else if (prev.source !== e.source) {
      // `content` → `declared` means we stopped measuring it and started
      // taking the vendor's word for the same digest. The bytes did not
      // move; who is vouching for them did.
      raise(
        'material',
        `${e.class} ${e.id} changed from ${prev.source} to ${e.source} — same digest, ` +
          'different party vouching for it',
      );
    }
  }

  if (reasons.length === 0) reasons.push('no difference inside the declared boundary');
  return { class: acc.worst, reasons, requires_reseal: acc.worst === 'material' };
}

/** `sealed_at` plus the term. */
export function sealExpiry(sealedAt: string): string {
  return new Date(Date.parse(sealedAt) + SEAL_TERM_DAYS * 86_400_000).toISOString();
}
