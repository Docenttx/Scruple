// The pipeline seal, as the grader consumes it.
//
// ---------------------------------------------------------------------------
// THIS FILE DOES NOT BUILD A SEAL, AND MUST NOT
// ---------------------------------------------------------------------------
//
// `lib/seal/**` (WO-22) owns the measurement, the boundary classes and the
// material-change policy. What is here is the NARROW READING SURFACE the grade
// harness needs — the shape P2 asks about and nothing else — so the grader's
// dependency on the seal is one small reviewable file rather than an import of
// somebody else's module graph spread across eight branches.
//
// IT CONSUMES, IT DOES NOT RESTATE. The lifecycle fold (`sealStatus`), the
// materiality rule (`classifyManifestChange`) and the measurement formula
// (`pipelineMeasurement`) all come from `lib/seal/**`. A second copy of a
// materiality rule inside the grader is a second rule, and the first thing
// that happens to two copies of a rule is that they disagree in a case nobody
// tested.
//
// WHAT IT ADDS, AND IT IS THE ONE THING THE REGISTRY CANNOT DO FOR ITSELF.
// `sealStatus()` is a fold over events the vendor DECLARED: material changes
// they told us about, drift they recorded. It is a correct answer to "what has
// this deployment said about itself". P2 asks a different question — is the
// pipeline RUNNING NOW the approved one — and the gap between those is exactly
// the change nobody declared. So the grader takes an OBSERVED manifest
// alongside the fold and classifies it against the approved one itself. A seal
// state that can only be moved by the sealed party's own honesty is a seal that
// checks paperwork.
//
// ---------------------------------------------------------------------------
// WHY THIS EXISTS AT ALL — docs/canon/INTEGRATION_LIFECYCLE.md, 2026-08-30
// ---------------------------------------------------------------------------
//
// P2 had been implemented as a runtime completeness proof: a baseline over the
// capture files, coverage probes, and the ratchet's per-event counter showing
// no gaps. That measured the wrong thing twice over. It made canvas look
// unfixable — canvas has no ratchet, so the counter conjunct could not be
// satisfied at any level of effort — and it made §10 C-7's route enumeration a
// denylist that rots with every upstream release.
//
// The standard answer, from PCI PTS, P2PE, FIPS 140-3, Common Criteria, EMV
// L3, SLSA and measured boot alike, is:
//
//     DEFINE THE BOUNDARY, MEASURE THE WHOLE THING, AND MAKE ANY CHANGE TO IT
//     REQUIRE RE-APPROVAL.
//
// The approved artefact is the entire pipeline, not the capture files. The
// routes that exist are the routes in the measured image; a new upstream
// release is a new measurement and a new approval. Nobody enumerates routes,
// so nothing rots.
//
// THE ORDER IS THE POINT. Integrate, test end to end, THEN seal. You cannot
// hash a moving target: a measurement taken during integration is stale before
// it is recorded and teaches the vendor that the measurement is noise. Which
// is why `LifecycleState` is part of the evidence rather than inferred from
// whether an approval happens to exist.

import {
  CONSEQUENTIAL_CHANGE_BUDGET,
  classifyManifestChange,
  type ChangeVerdict,
} from '../../../lib/seal/materiality';
import { pipelineMeasurement, type PipelineManifest } from '../../../lib/seal/measure';
// TYPE-ONLY, DELIBERATELY. `lib/seal/registry.ts` opens the database at import
// time; the grade derivations read pinned source through `git show` and must
// never need one. The fold is computed by whoever calls the grader and handed
// in as evidence, which is also what makes a grade reproducible from a bundle
// months later with no live registry to ask.
import type { ResealCause, SealState, SealStatusReport } from '../../../lib/seal/registry';

export { CONSEQUENTIAL_CHANGE_BUDGET };
export type { ChangeVerdict, PipelineManifest, ResealCause, SealStatusReport };

/**
 * Where a deployment is in the sequence — `lib/seal/registry.ts`'s own four
 * states, not a fifth vocabulary for the same thing.
 *
 * `integrating` — building against the SDK. Failures here are ordinary.
 * `verifying`   — probes running end to end. Failures here are expected.
 * `sealed`      — measured and approved. Only here is the standard claimable.
 * `resealing`   — was sealed; something moved. Not a demotion to `verifying`
 *                 and not a rung on a ladder: it is the other side of the same
 *                 binary line, with a cause attached.
 */
export type LifecycleState = SealState;

export const LIFECYCLE_STATES: readonly LifecycleState[] = [
  'integrating',
  'verifying',
  'sealed',
  'resealing',
];

/**
 * What the grader is told about a deployment's seal.
 *
 * `observed` is the manifest of the pipeline RUNNING NOW, measured at grade
 * time. It is separate from the approved manifest on purpose: P2 is "is the
 * running pipeline sealed against an approved measurement, AND IS THE SEAL
 * CURRENT", and a model holding only what the vendor declared cannot answer
 * the second half against a vendor who declared nothing.
 *
 * What binds the running system to `observed` — hardware attestation, or the
 * vendor's own assertion — is P7/P8's question (`verified` vs `passthrough`),
 * not P2's. No new tier is required and none is introduced here.
 */
export interface SealEvidence {
  /** The fold. `sealStatus(deployment_id, asOf)`. */
  status: SealStatusReport;
  /** The manifest of the seal in force, parsed from the signed row. */
  approvedManifest: PipelineManifest | null;
  /** That row's recorded measurement, so the grader can recompute rather than trust. */
  approvedMeasurement: string | null;
  /** The pipeline as measured at grade time. Null when nobody measured it. */
  observed: PipelineManifest | null;
}

export type SealCurrency =
  /** The running pipeline is inside the approval that stands over it. */
  | { state: 'current'; verdict: ChangeVerdict | null; consequentialSpent: number }
  /** The fold says this deployment may not claim the standard. */
  | { state: 'not-sealed'; lifecycle: LifecycleState; cause: ResealCause | null }
  /** The fold says sealed and there is no manifest to read. */
  | { state: 'no-approved-manifest' }
  /** The seal row's recorded number is not the measurement of its own manifest. */
  | { state: 'self-inconsistent'; detail: string }
  /** The pipeline moved and nobody declared it. The check the fold cannot make. */
  | { state: 'undeclared-drift'; verdict: ChangeVerdict; detail: string };

/**
 * Is the seal current?
 *
 * FIVE WAYS IT IS NOT, and each is a different sentence to the vendor: the
 * lifecycle says not yet (or not any more); the seal row has no manifest; the
 * row contradicts itself; the running pipeline is not the approved one and
 * nobody said so; and — the passing case — it is, with whatever drift budget
 * has been spent named. One undifferentiated "stale" would tell a vendor to
 * re-measure when what they need is a re-approval, or the reverse.
 */
export function sealCurrency(seal: SealEvidence | null): SealCurrency {
  if (!seal) return { state: 'not-sealed', lifecycle: 'integrating', cause: null };
  const st = seal.status;

  // `claims_standard` is the registry spelling out the one question the
  // lifecycle exists to answer, rather than leaving every caller to derive it
  // from `state === 'sealed'` and get it subtly wrong somewhere. Read it.
  if (!st.claims_standard) {
    return { state: 'not-sealed', lifecycle: st.state, cause: st.reseal_cause };
  }
  if (!seal.approvedManifest || !seal.approvedMeasurement) {
    return { state: 'no-approved-manifest' };
  }
  const recomputed = pipelineMeasurement(seal.approvedManifest);
  if (recomputed !== seal.approvedMeasurement) {
    return {
      state: 'self-inconsistent',
      detail:
        `the seal records ${shorten(seal.approvedMeasurement)} and its own manifest measures ` +
        `${shorten(recomputed)}. One side was produced by different code from the other — which ` +
        'is what `build-measurement.ts` did when it digested `.ts` under tsx and the emitted ' +
        '`.js` under `dist` and called both the same component.',
    };
  }

  if (!seal.observed) {
    return { state: 'current', verdict: null, consequentialSpent: st.drift_since_seal };
  }
  const verdict = classifyManifestChange(seal.approvedManifest, seal.observed);
  const spent = st.drift_since_seal + (verdict.class === 'consequential' ? 1 : 0);
  if (verdict.requires_reseal || spent > st.drift_budget) {
    return {
      state: 'undeclared-drift',
      verdict,
      detail: verdict.requires_reseal
        ? verdict.reasons.join('; ')
        : `${spent} consequential changes against a budget of ${st.drift_budget}: ` +
          verdict.reasons.join('; '),
    };
  }
  return { state: 'current', verdict, consequentialSpent: spent };
}

/**
 * Does the approved boundary contain every file the integrator names on the
 * capture path?
 *
 * THIS IS NOT THE OLD CONJUNCT WEARING A NEW NAME. The old rule asked whether
 * a baseline enumerated the capture files and treated that enumeration as the
 * completeness claim — which is the denylist shape C-7 rots into. Here the
 * boundary is the whole pipeline and the capture path is a declaration ABOUT
 * it, so the check is containment: a declared capture file sitting outside the
 * measurement is a finding, because the seal does not cover it.
 *
 * THE CONVERSE IS DELIBERATELY NOT CHECKED. A file inside the boundary that
 * nobody declared is covered anyway, silently, the way a measured image covers
 * a route nobody wrote down. That asymmetry is the entire reason this stops
 * being a list somebody has to keep current.
 */
export function boundaryOmissions(
  manifest: PipelineManifest,
  capturePathFiles: readonly string[],
): string[] {
  const inside = new Set(manifest.entries.map((e) => e.id));
  return capturePathFiles.filter((f) => !inside.has(f));
}

function shorten(digest: string): string {
  return digest.length > 20 ? `${digest.slice(0, 20)}…` : digest;
}
