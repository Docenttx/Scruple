// The class layer, as the grader consumes it.
//
// ---------------------------------------------------------------------------
// THIS FILE DOES NOT DEFINE A CLASS, AND MUST NOT
// ---------------------------------------------------------------------------
//
// `lib/capture/classes.ts` owns the four Protection Profiles, the custody
// locus axis and the scope computation. What is here is the NARROW READING
// SURFACE the grade harness needs: the re-export the rest of the package
// imports from, the reduction of a `ProbeRun` to the verdict map `scopeProfile`
// consumes, and the compile-time proof that the two copies of the P-item and
// probe vocabularies have not drifted.
//
// A second copy of a class definition inside the grader is a second definition,
// and the first thing that happens to two copies of a rule is that they
// disagree in a case nobody tested. (`seal.ts` says the same thing about
// materiality, for the same reason.)

import {
  CAPABILITY_CLASSES,
  CLASS_DEFINITIONS,
  CLASS_BREADTH,
  CUSTODY_CLAIMS,
  CUSTODY_LOCI,
  PROBE_IDS,
  P_ITEM_IDS,
  broadestClass,
  classDefinition,
  custodyAssuranceFor,
  probeTitle,
  residualDefect2,
  scopeProfile,
  type CapabilityClass,
  type ClassDefinition,
  type ClassFinding,
  type ClassScopeReport,
  type CustodyAssurance,
  type CustodyClaim,
  type CustodyLocus,
  type ItemOutcome,
  type NotApplicable,
  type PItemId,
  type ProbeId,
  type ProbeVerdictMap,
  type ScopeStatus,
  type ScopedItem,
} from '../../../lib/capture/classes';
import type { PItem, ProbeRun } from './types';

export {
  CAPABILITY_CLASSES,
  CLASS_DEFINITIONS,
  CLASS_BREADTH,
  CUSTODY_CLAIMS,
  CUSTODY_LOCI,
  PROBE_IDS,
  P_ITEM_IDS,
  broadestClass,
  classDefinition,
  custodyAssuranceFor,
  probeTitle,
  residualDefect2,
  scopeProfile,
};
export type {
  CapabilityClass,
  ClassDefinition,
  ClassFinding,
  ClassScopeReport,
  CustodyAssurance,
  CustodyClaim,
  CustodyLocus,
  ItemOutcome,
  NotApplicable,
  PItemId,
  ProbeId,
  ProbeVerdictMap,
  ScopeStatus,
  ScopedItem,
};

/* ────────────────────────────────────────────────────────────────────────
 * THE TWO VOCABULARIES ARE ONE VOCABULARY, PROVED AT COMPILE TIME.
 *
 * `lib/capture/classes.ts` re-declares `PItemId` rather than importing
 * `PItem` from ./types, because `lib/` must not depend on a package that
 * depends on it. That is the same trade `surface.ts` makes for
 * `AttestationStatus`, and it has the same failure mode: two spellings that
 * drift, and a grade that silently stops covering an item.
 *
 * A runtime test would catch it late and only if someone ran it. These two
 * lines catch it in `tsc --noEmit`: they fail to compile the moment either
 * union gains or loses a member the other does not have.
 * ──────────────────────────────────────────────────────────────────────── */
type Assert<T extends true> = T;
type Extends<A, B> = [A] extends [B] ? true : false;
export type PItemVocabulariesAgree = [
  Assert<Extends<PItemId, PItem>>,
  Assert<Extends<PItem, PItemId>>,
];

/**
 * Reduce a probe run to the verdict map `scopeProfile` consumes.
 *
 * TWO REFUSALS ARE BUILT IN, AND BOTH ARE OLD LESSONS.
 *
 * 1. A RUN OF ANOTHER DEPLOYMENT SUPPLIES NOTHING (WO-14). If the run's
 *    subject is not this path, the whole map is `undefined` — every applicable
 *    probe becomes `unmeasured` rather than borrowing somebody else's result.
 *    P2 already fails such a grade; class scope must not be quietly satisfied
 *    by the same evidence P2 refused.
 * 2. AN INADMISSIBLE PASS IS NOT A PASS. `verdictOf` already downgrades a
 *    blocked-but-inadmissible probe to `inconclusive`; this re-checks it,
 *    because a result that says `pass` with `admissible:false` is a
 *    contradiction and the safe reading of a contradiction is the one that
 *    does not hand out a pass.
 */
export function probeVerdictsOf(
  run: ProbeRun | null | undefined,
  subject: string,
): ProbeVerdictMap | undefined {
  if (!run) return undefined;
  if (run.subject !== subject) return undefined;
  const out: ProbeVerdictMap = {};
  const known = new Set<string>(PROBE_IDS);
  for (const r of run.results) {
    if (!known.has(r.id)) continue;
    const id = r.id as ProbeId;
    if (r.verdict === 'pass' && r.admissible) out[id] = 'pass';
    else if (r.verdict === 'fail') out[id] = 'fail';
    else out[id] = 'inconclusive';
  }
  return out;
}
