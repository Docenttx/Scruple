// The self-grade harness. STUDIO_P1-P8_GRADE.md, produced by a program.
//
// WHY THIS EXISTS AT ALL. That grade's own §"What this grade says about the
// vendor strategy" makes the argument: "the grade is a document the vendor
// produces, and producing an unflattering one is normal." A grade only sets
// that norm if two vendors grading the same shape get the same answer, which
// means the grading rules have to be code rather than a careful reader.
//
// ---------------------------------------------------------------------------
// TWO SOURCES OF TRUTH, AND THE SPLIT IS THE DESIGN
// ---------------------------------------------------------------------------
//
// DERIVED — from `assuranceForHost()` in lib/capture/surface.ts. P1 and P3
// are functions of (placement, enforcement, attestation) and of nothing else,
// and that reduction is already written, already tested, and already the thing
// the canon means by those requirements. This harness does not re-decide it.
//
// DECLARED — everything the placement axes cannot see. Whether a baseline
// covers the capture path, where the credential physically lives, whether a
// leaf is created at all, whether prior rows are mutated. The integrator
// declares these AND names the file and line, because a grade whose inputs
// are unsourced booleans is a survey.
//
// ---------------------------------------------------------------------------
// P2 — WHAT IT MEASURES, AND WHAT IT USED TO MEASURE INSTEAD
// ---------------------------------------------------------------------------
//
// P2 IS: *is the running pipeline sealed against an approved measurement, and
// is the seal current?* (docs/canon/INTEGRATION_LIFECYCLE.md, 2026-08-30.)
//
// P2 WAS: a runtime completeness proof — a baseline over the declared capture
// files, coverage probes 4/5/7 blocked from an occupied tenant position, and
// the ratchet's per-event counter showing no gaps. Every one of those is a
// real check; together they were the wrong thing, and they were wrong in two
// ways that both looked like properties of the world:
//
//   * CANVAS LOOKED UNFIXABLE. It has no ratchet, so the counter conjunct
//     could not be satisfied "at any level of effort". That sentence was a
//     fact about this file, not about canvas.
//   * C-7's ROUTE ENUMERATION BECAME A DENYLIST that rots with every upstream
//     ComfyUI release, because a completeness proof over a named set of files
//     has to keep naming files.
//
// The standard answer — PCI PTS, P2PE, FIPS 140-3, Common Criteria, EMV L3,
// SLSA, measured boot — is to define the boundary, measure the whole thing,
// and make any change require re-approval. The approved artefact is the ENTIRE
// PIPELINE, not the capture files. Routes that exist are the routes in the
// measured image, so nothing is enumerated and nothing rots.
//
// THE COUNTER IS STILL WORTH HAVING and is still computed — as LIVENESS, on
// `PathGrade.liveness`: has this deployment gone dark or been suppressed. It
// is reported and it does NOT bear on compliance, because "no gaps in a
// counter" was never the completeness proof it was being used as.
//
// THREE MECHANISMS, THREE JOBS, EACH PREVIOUSLY DOING PART OF ANOTHER'S:
//
//   pipeline measurement  this is the approved configuration       → P2
//   attestation           the running thing IS that measurement    → P7/P8
//   counter (ratchet)     this deployment has not gone dark        → liveness
//
// ---------------------------------------------------------------------------
// THE OLD RULE IS KEPT, DELIBERATELY, AS A FROZEN PROFILE
// ---------------------------------------------------------------------------
//
// `STUDIO_P1-P8_GRADE.md` was written under the old rule. A conformance suite
// that cannot reproduce a known failure is not evidence of anything, so the
// old rule is not deleted: it is `RUNTIME_COMPLETENESS_PROFILE`, frozen, and
// the acceptance test reproduces the published grade under the rule that grade
// was actually issued under. The new rule is then run over the same pinned
// evidence and asserted to reach the same eight cells for a different, stated
// reason — which is the only honest way to show that a re-cut of the rules did
// not quietly launder a published failure.
//
// A GRADE THEREFORE NAMES ITS PROFILE, for the same reason it names its source
// ref: a grade of a moving tree is a grade of nothing, and a grade under an
// unnamed rule is an opinion about a moving standard.
//
// ---------------------------------------------------------------------------
// WHAT THE OLD RULE GOT RIGHT AND IS CARRIED FORWARD
// ---------------------------------------------------------------------------
//
// WO-5's DEFECT-2 is still open — nothing in the hook/surface/placement model
// can say that a set of surfaces COVERS every egress path of a host, so a
// profile naming only `filesystem-watch` is a well-formed sentence about
// coverage that carries no coverage claim. Under the new rule that stops being
// P2's problem: coverage is not established by enumerating surfaces, it is
// established by measuring the whole boundary the surfaces live in.
//
// WO-14's borrowed-run finding is carried forward VERBATIM, because it was
// never about which conjunct the run fed. A real, admissible, seven-of-seven
// run against the `scruple-capture` ComfyUI deployment was attached to
// canvas's grade; every fact in it was true and the conclusion was false. A
// run is evidence about the deployment it occupied and about no other, and a
// deployment cannot reach a seal on somebody else's step-2 evidence. So an
// attached run whose subject is another deployment fails P2 under BOTH
// profiles, and it is checked first, because nothing downstream of inadmissible
// evidence is worth computing.

import {
  assuranceForHost,
  type HostAssurance,
  type HostCaptureProfile,
} from '../../../lib/capture/surface';
import { probeVerdictsOf, scopeProfile, type ClassScopeReport } from './classes';
import {
  boundaryOmissions,
  sealCurrency,
  type LifecycleState,
  type SealEvidence,
} from './seal';
import type { ProbeRun } from './types';
import { P_ITEMS, type PItem } from './types';

export type Disposition = 'PASS' | 'PASS-CONDITIONAL' | 'FAIL' | 'n/a';

export interface ItemGrade {
  item: PItem;
  disposition: Disposition;
  /**
   * A three-or-four-word qualifier that rides in the summary table cell —
   * `**FAIL** (derived from P3)`, `**FAIL** (no chain exists)`.
   *
   * The published grade carries these and they earn their place: a reader
   * scanning eight rows needs to know that Kohya's P4 falls because P3 fell,
   * not independently, or they will count four failures where there are two
   * causes. Keep it to the cause, never the remedy.
   */
  qualifier?: string;
  /** Why, in the grade document's voice. */
  reason: string;
  /** Conditions on a PASS-CONDITIONAL. Empty otherwise. */
  conditions: string[];
  /** File:line pointers the reader can check. */
  citations: string[];
  /**
   * 'derived' when assuranceForHost decided it; 'declared+checked' otherwise.
   * 'class-scope' when the item does not bind this profile's capability class
   * at all — an OUT OF SCOPE, which is neither a pass nor a failure and must
   * not read as either.
   */
  basis:
    | 'derived'
    | 'declared+checked'
    | 'derived-from-P2'
    | 'derived-from-P3'
    | 'class-scope';
}

/** A citation is a fact plus where to look. An uncited fact is not evidence. */
export interface Cited<T> {
  value: T;
  /** `path/to/file.ts:12-18`. Required. */
  cite: string;
  note?: string;
}

export interface DeclaredEvidence {
  /**
   * P2. The files the integrator says capture runs in.
   *
   * Under `sealed-pipeline` this is a DECLARATION ABOUT the boundary, checked
   * for containment inside it — not an enumeration that has to be complete.
   * Under `runtime-completeness` it was the thing the baseline had to cover
   * exactly, which is what made it a list somebody had to keep re-writing.
   */
  capturePathFiles: Cited<string[]>;
  /**
   * P2, `runtime-completeness` only. What the baseline manifest covers.
   *
   * Still read under `sealed-pipeline`, but only by P7, which needs SOMEWHERE
   * an attestation provider could be declared. The seal is that somewhere now;
   * a baseline manifest is the legacy vehicle and still counts as one.
   */
  baseline: Cited<{ ref: string; covers: string[] }> | null;
  /**
   * The pipeline seal — P2 under `sealed-pipeline`. Null when nothing in the
   * evidence describes this deployment's seal state at all, which is itself a
   * FAIL and not a neutral absence.
   */
  seal: Cited<SealEvidence> | null;
  /**
   * LIVENESS, and no longer P2. Ratchet gap accounting from a live component:
   * has this deployment gone dark or been suppressed.
   *
   * `runtime-completeness` consumed this as P2's third conjunct. It is still
   * consumed there, frozen, so the old profile keeps grading the way it did.
   */
  ratchetGapAccounting: Cited<{ accounted: boolean; gaps: number }> | null;
  /**
   * A declared, cited absence of any ratchet on this path — canvas, whose sink
   * is `ingestIteration` rather than a ratcheted component.
   *
   * WITHOUT THIS FIELD THE GRADER CANNOT TELL TWO DIFFERENT FACTS APART:
   * "this deployment has a counter chain and nobody accounted for its gaps"
   * (a real liveness finding) and "there is no counter chain here" (nothing to
   * account for). Reporting both as a missing completeness proof is exactly
   * the mistake that made canvas look unfixable.
   */
  ratchetAbsence?: Cited<string> | null;
  /**
   * P2. Egress surfaces this integration DOES NOT HAVE, keyed by the probe id
   * that would otherwise cover them. See the header's named hole: this is the
   * one place the grader accepts a declaration in place of a probe, and it is
   * recorded as such in the reason string.
   */
  surfaceAbsences: Record<string, Cited<string>>;
  /**
   * P3. Where the credential the leaf is authenticated with physically lives.
   *
   * `dischargesSealCondition` answers the one condition `assuranceFor` attaches
   * to P3 at `sidecar-gate` — "the sealed key is 0600 and owned by a principal
   * the measured party is not (H-4 §4.4)". That condition assumes the key is a
   * FILE on a host the measured party can reach. When the credential is an
   * environment variable in a process the measured party has no code execution
   * in at all — canvas's browser user against scruple-web's own server — there
   * is no file, no shared host, and nothing left for the condition to be about.
   * Set it true only in that case, and cite the process boundary.
   */
  keyCustody: Cited<{
    reachableByMeasuredParty: boolean;
    where: string;
    dischargesSealCondition?: boolean;
  }>;
  /** P4. */
  principalIdentity: Cited<{ suppliedByMeasuredParty: boolean; source: string }>;
  /** P5. */
  eventChain: Cited<{ leavesCreated: boolean; mutatesPriorRows: boolean }>;
  /** P6. */
  zeroContent: Cited<{ carriesPayloadBytes: boolean; fields: string[] }>;
  /** P7. Where the attestation provider is declared. Null when nowhere. */
  attestationDeclaration: Cited<{ declaredIn: string; provider: string }> | null;
  /** P8. Null when this integration imports no external attestations. */
  attestationImport: Cited<{ imports: boolean; rejectsUnverifiable: boolean }> | null;
  /**
   * Conditions the INTEGRATOR attaches to their own P1 claim — upstream
   * behaviours they depend on and do not control. Studio's canvas grade has
   * three; they are the reason its P1 reads "PASS (conditional)" rather than
   * "PASS", and no placement axis could have produced them.
   */
  declaredP1Conditions: string[];
  /** Failures that are not P-items but belong in the grade. Standard §7, etc. */
  separateFindings: Array<{ title: string; detail: string; cite: string }>;
}

export interface GradeInput {
  /** 'Canvas / ComfyUI'. The column heading in the summary table. */
  path: string;
  profile: HostCaptureProfile;
  evidence: DeclaredEvidence;
  /** Required for P2. Absent is not neutral — see the header. */
  probes: ProbeRun | null;
}

/**
 * Has this deployment gone dark or been suppressed?
 *
 * SEPARATED FROM P2 BY docs/canon/INTEGRATION_LIFECYCLE.md. The counter proves
 * a deployment is still emitting; it never proved that everything which
 * happened was captured, and using it as the completeness test is what made a
 * componentless path look permanently non-compliant. It is reported on every
 * grade and it bears on `compliant` nowhere.
 */
export type LivenessVerdict =
  /** A counter chain exists and its gaps are accounted for. */
  | 'live'
  /** Accounted for, and there are gaps — the deployment went quiet, visibly. */
  | 'gaps-accounted'
  /** A counter chain exists and nobody accounted for it. Silence, unexplained. */
  | 'unaccounted'
  /** No counter chain on this path. Nothing to be silent with. */
  | 'not-applicable';

export interface LivenessReport {
  verdict: LivenessVerdict;
  reason: string;
  /** Unaccounted counter gaps, when a chain exists and was accounted for. */
  gaps: number | null;
  citations: string[];
}

export interface PathGrade {
  path: string;
  assurance: HostAssurance;
  /**
   * WHICH PROTECTION PROFILE THIS SECURITY TARGET WAS GRADED AGAINST, and
   * whether it is a member of it. See docs/canon/CAPABILITY_CLASSES.md.
   *
   * Reported BEFORE the items, because a grade against the wrong class is a
   * grade of nothing: probe 4 read as a canvas failure for three WOs on
   * exactly that mistake. `classScope.inScope` is false when a blocking class
   * finding stands, and `compliant` is conjoined with it.
   */
  classScope: ClassScopeReport;
  items: Record<PItem, ItemGrade>;
  /** Standard §5: compliance is binary. */
  compliant: boolean;
  /**
   * Which side of the line the deployment is on when it is not compliant.
   * `integrating` and `verifying` cannot claim the standard, and saying so is
   * not a third compliance state — it is the reason for the same FAIL.
   */
  lifecycle: LifecycleState;
  /** Reported, never aggregated into `compliant`. */
  liveness: LivenessReport;
}

/**
 * Which P2 rule a grade was issued under.
 *
 * Named and carried on the grade for the same reason `sourceRef` is: a grade
 * of a moving tree is a grade of nothing, and a grade under an unnamed rule is
 * an opinion about a moving standard. Two vendors grading the same shape get
 * the same answer only if they can both say which rule produced it.
 */
export interface GradeProfile {
  /** Stable. Appears in GRADE.md and in the submission manifest. */
  id: string;
  p2: 'sealed-pipeline' | 'runtime-completeness';
  summary: string;
}

/**
 * The rule in force. INTEGRATION_LIFECYCLE.md, 2026-08-30.
 */
export const SEALED_PIPELINE_PROFILE: GradeProfile = {
  id: 'scruple.dev/grade/p2-sealed-pipeline/2026-08-30',
  p2: 'sealed-pipeline',
  summary:
    'P2 is seal currency: the running pipeline is measured against an approved measurement of ' +
    'the WHOLE pipeline, and any change to it requires re-approval. The ratchet counter is ' +
    'reported as liveness and does not bear on compliance.',
};

/**
 * FROZEN. The rule `STUDIO_P1-P8_GRADE.md` and every grade issued before
 * 2026-08-30 was written under: baseline coverage of the declared capture
 * path, coverage probes 4/5/7 blocked from an occupied tenant position, and
 * ratchet gap accounting.
 *
 * KEPT SO A KNOWN FAILURE STAYS REPRODUCIBLE. Deleting it would leave the
 * suite unable to re-derive a published grade, which is the one property that
 * makes the suite evidence of anything. It is not selectable by a vendor for a
 * live submission; it exists to re-read history under the rules history had.
 */
export const RUNTIME_COMPLETENESS_PROFILE: GradeProfile = {
  id: 'scruple.dev/grade/p2-runtime-completeness/wo9-2026-08-30',
  p2: 'runtime-completeness',
  summary:
    'Superseded. P2 as a runtime completeness proof: baseline over the declared capture path, ' +
    'coverage probes 4/5/7 blocked from an occupied tenant position, and ratchet gap ' +
    'accounting. Retained so grades issued under it remain reproducible.',
};

export const DEFAULT_PROFILE = SEALED_PIPELINE_PROFILE;

export interface Grade {
  gradedAt: string;
  /** The commit the evidence was derived from. Named, because a grade of a
   *  moving tree is a grade of nothing. */
  sourceRef: string;
  /** The P2 rule this grade was issued under. */
  profile: string;
  paths: PathGrade[];
}

const COVERAGE_PROBES = ['P-04', 'P-05', 'P-07'];

export function gradePath(
  input: GradeInput,
  profile: GradeProfile = DEFAULT_PROFILE,
): PathGrade {
  const a = assuranceForHost(input.profile);
  const e = input.evidence;
  const items = {} as Record<PItem, ItemGrade>;

  // ---- CLASS SCOPE, BEFORE ANY ITEM IS GRADED ----------------------------
  //
  // WHAT IS THIS DEPLOYMENT, AND WHAT DOES THE STANDARD ASK OF THAT? Under the
  // old rule the answer was "everything", so anything a vendor's shape did not
  // have read as a gap. Probe 4 read as a canvas failure when canvas has no
  // filesystem surface at all; the plugin hosts were graded against
  // inference-host probes when their threat model runs the other way.
  //
  // The verdict map is derived from the SAME run P2 will look at, through
  // `probeVerdictsOf`, which refuses a run whose subject is another deployment
  // (WO-14) and refuses an inadmissible pass. Class scope must never be
  // satisfied by evidence P2 is about to reject.
  const classScope = scopeProfile(input.profile, {
    probeVerdicts: probeVerdictsOf(input.probes, input.path),
    effectivePlacement: a.resolution.effective,
  });

  // ---- P1 · runtime boundary integrity -----------------------------------
  // Derived. `assuranceFor` is total over placement x attestation and this
  // harness has no business second-guessing it.
  if (a.p1 === 'fails') {
    items.P1 = {
      item: 'P1',
      disposition: 'FAIL',
      basis: 'derived',
      reason: a.reason,
      conditions: [],
      citations: [`placement resolution: ${a.resolution.reason}`],
    };
  } else {
    const conditions = [...a.conditions, ...e.declaredP1Conditions];
    items.P1 = {
      item: 'P1',
      disposition: conditions.length ? 'PASS-CONDITIONAL' : 'PASS',
      basis: 'derived',
      reason: a.reason,
      conditions,
      citations: [`placement resolution: ${a.resolution.reason}`],
    };
  }

  items.P2 = gradeP2(input, profile);

  // ---- P3 · key custody ---------------------------------------------------
  const custody = e.keyCustody.value;
  if (a.p3 === 'fails' || custody.reachableByMeasuredParty) {
    items.P3 = {
      item: 'P3',
      disposition: 'FAIL',
      basis: custody.reachableByMeasuredParty ? 'declared+checked' : 'derived',
      reason: custody.reachableByMeasuredParty
        ? `The credential lives at ${custody.where}, which the measured party reaches. P3 is ` +
          'about custody, not scope: narrowing the blast radius of a secret in a shell the ' +
          'witnessed party controls does not move it out of that shell.'
        : a.reason,
      conditions: [],
      citations: [e.keyCustody.cite],
    };
  } else {
    const discharged = custody.dischargesSealCondition === true;
    items.P3 = {
      item: 'P3',
      disposition: a.p3 === 'conditional' && !discharged ? 'PASS-CONDITIONAL' : 'PASS',
      basis: 'derived',
      reason: `${custody.where}. ${a.reason}`,
      conditions:
        a.p3 === 'conditional' && !discharged ? a.conditions.filter((c) => /key|seal/i.test(c)) : [],
      citations: [e.keyCustody.cite],
    };
  }

  // ---- P4 · principal identity -------------------------------------------
  const pid = e.principalIdentity.value;
  const p3Failed = items.P3.disposition === 'FAIL';
  if (pid.suppliedByMeasuredParty && p3Failed) {
    items.P4 = {
      item: 'P4',
      disposition: 'FAIL',
      qualifier: 'derived from P3',
      basis: 'derived-from-P3',
      reason:
        `Identity arrives as ${pid.source}, and the only thing preventing forgery is a MAC ` +
        'whose key P3 already found in the measured party\'s hands. They can supply the ' +
        'value AND the signature over it.',
      conditions: [],
      citations: [e.principalIdentity.cite, e.keyCustody.cite],
    };
  } else if (pid.suppliedByMeasuredParty) {
    items.P4 = {
      item: 'P4',
      disposition: 'PASS-CONDITIONAL',
      basis: 'declared+checked',
      reason:
        `Identity arrives as ${pid.source} and is cross-checked server-side; it holds only ` +
        'for as long as the authenticator stays out of the measured party\'s reach.',
      conditions: ['the authenticator over the supplied identity remains unreachable by the measured party'],
      citations: [e.principalIdentity.cite],
    };
  } else {
    items.P4 = {
      item: 'P4',
      disposition: 'PASS',
      basis: 'declared+checked',
      reason: `Identity is ${pid.source}. The end user supplies neither the value nor its authenticator.`,
      conditions: [],
      citations: [e.principalIdentity.cite],
    };
  }

  // ---- P5 · immutable event chain ----------------------------------------
  const chain = e.eventChain.value;
  if (!chain.leavesCreated) {
    items.P5 = {
      item: 'P5',
      disposition: 'FAIL',
      qualifier: 'no chain exists',
      basis: 'declared+checked',
      reason: 'There is no event chain to be immutable. No leaf is ever created on this path.',
      conditions: [],
      citations: [e.eventChain.cite],
    };
  } else if (chain.mutatesPriorRows) {
    items.P5 = {
      item: 'P5',
      disposition: 'FAIL',
      basis: 'declared+checked',
      reason: 'Prior rows are updated in place, which is the mutation pattern P5 forbids.',
      conditions: [],
      citations: [e.eventChain.cite],
    };
  } else {
    items.P5 = {
      item: 'P5',
      disposition: 'PASS',
      basis: 'declared+checked',
      reason: 'Nothing mutates or deletes prior leaves.',
      conditions: [],
      citations: [e.eventChain.cite],
    };
  }

  // ---- P6 · zero-content posture -----------------------------------------
  items.P6 = {
    item: 'P6',
    disposition: e.zeroContent.value.carriesPayloadBytes ? 'FAIL' : 'PASS',
    basis: 'declared+checked',
    reason: e.zeroContent.value.carriesPayloadBytes
      ? 'Payload bytes leave the vendor boundary.'
      : `Hashes and small metadata only (${e.zeroContent.value.fields.join(', ')}). No payload bytes leave.`,
    conditions: [],
    citations: [e.zeroContent.cite],
  };

  // ---- P7 · attestation declaration --------------------------------------
  // P7 fails FOR FREE when P2 fails, and the reason matters: not because
  // attestation is absent — `provider: none` is a compliant value — but
  // because there is nowhere to declare it.
  // WO-14: THE "FOR FREE" BRANCH USED TO STATE A FACT IT HAD NOT CHECKED.
  // It said "no baseline manifest exists" whenever P2 failed and no provider
  // was declared — which was true while the only way to fail P2 was to have no
  // baseline. Once P2 could fail for OTHER reasons (an unattached or borrowed
  // probe run, missing gap accounting), the sentence became a false statement
  // about a file the grader had already read. A derived reason has to be
  // derived from the same inputs as the thing it is derived from.
  //
  // WO-23: AND THE VEHICLE IS NO LONGER ONLY A BASELINE MANIFEST. Under the
  // sealed-pipeline rule the provider is declared in the APPROVED
  // CONFIGURATION; a baseline manifest is the legacy vehicle and still counts
  // as one. P7 asks whether a declaration exists somewhere durable, so the
  // branch names whichever vehicle this deployment actually has rather than
  // the one the old rule assumed. The attestation itself is what binds the
  // running system to the measurement — `verified` vs `passthrough` — which is
  // exactly the job P2 stopped trying to do.
  const declarationVehicle = e.baseline
    ? { kind: 'baseline manifest', ref: e.baseline.value.ref, cite: e.baseline.cite }
    : e.seal?.value.status.seal_ref
      ? {
          kind: 'approved configuration',
          ref: e.seal.value.status.seal_ref,
          cite: e.seal.cite,
        }
      : null;
  if (items.P2.disposition === 'FAIL' && !e.attestationDeclaration && !declarationVehicle) {
    items.P7 = {
      item: 'P7',
      disposition: 'FAIL',
      basis: 'derived-from-P2',
      reason:
        'No baseline manifest exists, so nothing declares a provider. `none` would be the ' +
        'correct VALUE and P7 explicitly permits it; the item fails only because there is ' +
        'no manifest to declare it in. It closes for free the moment P2 does.',
      conditions: [],
      citations: [],
    };
  } else if (items.P2.disposition === 'FAIL' && !e.attestationDeclaration) {
    items.P7 = {
      item: 'P7',
      disposition: 'FAIL',
      basis: 'derived-from-P2',
      reason:
        `A ${declarationVehicle!.kind} (${declarationVehicle!.ref}) exists and declares no ` +
        'attestation provider. `none` is a correct VALUE and P7 permits it; what is missing is ' +
        'the declaration itself. P2 is failing for a separate reason, so this one does NOT ' +
        'close for free when P2 does.',
      conditions: [],
      citations: [declarationVehicle!.cite],
    };
  } else if (!e.attestationDeclaration) {
    items.P7 = {
      item: 'P7',
      disposition: 'FAIL',
      basis: 'declared+checked',
      reason: `A ${declarationVehicle?.kind ?? 'declaration vehicle'} exists but declares no attestation provider.`,
      conditions: [],
      citations: [],
    };
  } else {
    const declared = e.attestationDeclaration.value.provider;
    const expected = a.attestation === 'none' ? 'none' : a.leaf ?? 'none';
    items.P7 = {
      item: 'P7',
      disposition: declared === expected ? 'PASS' : 'FAIL',
      basis: 'declared+checked',
      reason:
        declared === expected
          ? `Declares provider '${declared}' in ${e.attestationDeclaration.value.declaredIn}, which matches what this configuration measured.`
          : `Declares '${declared}' but this configuration measured '${expected}'. A declaration that overstates the tier is worse than no declaration.`,
      conditions: [],
      citations: [e.attestationDeclaration.cite],
    };
  }

  // ---- P8 · attestation import -------------------------------------------
  if (!e.attestationImport || !e.attestationImport.value.imports) {
    items.P8 = {
      item: 'P8',
      disposition: 'n/a',
      basis: 'declared+checked',
      reason: 'This integration imports no external attestations.',
      conditions: [],
      citations: e.attestationImport ? [e.attestationImport.cite] : [],
    };
  } else {
    items.P8 = {
      item: 'P8',
      disposition: e.attestationImport.value.rejectsUnverifiable ? 'PASS' : 'FAIL',
      basis: 'declared+checked',
      reason: e.attestationImport.value.rejectsUnverifiable
        ? 'Imported attestations that cannot be chained are refused rather than stored as verified.'
        : 'Unverifiable imported attestations are accepted. Standard §12.4: "Stored" MUST NOT read as "verified".',
      conditions: [],
      citations: [e.attestationImport.cite],
    };
  }

  // ---- ITEMS THE CLASS DOES NOT BIND -------------------------------------
  //
  // OUT OF SCOPE IS NOT A PASS AND IS NOT A FAILURE, and keeping the three
  // apart is the whole of this WO. An item the class declares not-applicable
  // is overwritten to `n/a` with its class's reason — the same disposition P8
  // already uses for an integration that imports no attestations, so a reader
  // needs no new vocabulary.
  //
  // NOTHING TRIGGERS THIS TODAY, AND THE MECHANISM IS STILL LOAD-BEARING.
  // CAPABILITY_CLASSES.md expected some of the eight to drop out per class
  // ("Not all eight bind every class"). Working through the four, none does:
  // what differs between classes is the EVIDENCE each can offer, which is the
  // probe set, not which requirements bind. See the note on
  // `applicablePItems` in lib/capture/classes.ts. The code path stays because
  // a fifth class will need it and because a rule that only exists in prose
  // is a rule nobody re-reads.
  for (const p of P_ITEMS) {
    if (classScope.pItems[p] === 'not-applicable') {
      items[p] = {
        item: p,
        disposition: 'n/a',
        basis: 'class-scope',
        reason:
          `${p} does not bind \`${classScope.audited.join(' + ')}\`. Out of scope is not a pass ` +
          'and not a failure: the class declares which requirements bind its members, and this ' +
          'one is not among them.',
        conditions: [],
        citations: [`capability class: ${classScope.audited.join(' + ')}`],
      };
    }
  }

  // Standard §5 — compliance is binary. A conditional PASS is still a pass on
  // the item and still not a third compliance state; a single FAIL is the end
  // of the question.
  //
  // AND `inScope` IS A CONJUNCT, NOT AN OBSERVATION. A blocking class finding
  // means the deployment is not a member of the class it was graded as, or
  // does not meet that class's floor. You cannot be compliant with a standard
  // you were measured against the wrong part of, and a vendor who could pick
  // the profile that grades easiest and still claim the name is the
  // gradations-of-certification problem the trademark terms exist to forbid.
  const compliant =
    P_ITEMS.every((p) => items[p].disposition !== 'FAIL') && classScope.inScope;

  return {
    path: input.path,
    assurance: a,
    classScope,
    items,
    compliant,
    // Which side of the binary line, when it is not compliant. `integrating`
    // and `verifying` are not a third compliance state; they are the reason.
    lifecycle: e.seal?.value.status.state ?? 'integrating',
    // REPORTED, NEVER AGGREGATED. Nothing in here reaches `compliant`, which
    // is the whole of the WO-23 correction: the counter says whether this
    // deployment went dark, and it never said whether capture was complete.
    liveness: gradeLiveness(e),
  };
}

/* ────────────────────────────────────────────────────────────────────────
 * P2, FROZEN — the runtime-completeness rule, exactly as WO-9 and WO-14 left
 * it. Three conjuncts, all required, none declarable: a baseline covering
 * every declared capture-path file, coverage probes 4/5/7 blocked from an
 * occupied tenant position, and ratchet gap accounting.
 *
 * NOT DEAD CODE AND NOT NOSTALGIA. `STUDIO_P1-P8_GRADE.md` was issued under
 * this rule, and a suite that cannot re-derive a published failure is not
 * evidence of anything. Every grade issued before 2026-08-30 reads under this
 * function and must keep reading the same way, so it takes no new inputs and
 * gains no new behaviour — including the hole it names below, which stays
 * named rather than quietly repaired in a frozen rule.
 *
 * THE HOLE, PRESERVED: a coverage probe can come back `not-attempted` because
 * the surface it probes does not exist in this integration. The grader accepts
 * that only on a cited `surfaceAbsences` declaration and says so in the reason.
 * A vendor who falsely declares 'no filesystem surface' gets a P2 pass they did
 * not earn. Closing it needed a coverage axis — DEFECT-2 itself — which is one
 * of the reasons the rule was re-cut rather than patched.
 * ──────────────────────────────────────────────────────────────────────── */
export function p2RuntimeCompleteness(input: GradeInput): ItemGrade {
  const e = input.evidence;
  const capturePath = e.capturePathFiles.value;
  const covered = new Set(e.baseline?.value.covers ?? []);
  const uncovered = capturePath.filter((f) => !covered.has(f));
  const coverageProbes = (input.probes?.results ?? []).filter((r) => COVERAGE_PROBES.includes(r.id));
  const absences = e.surfaceAbsences ?? {};
  // A coverage probe counts as satisfied when it PASSED, or when it was
  // not-attempted AND the integrator declared that surface absent with a cite.
  const satisfied = coverageProbes.filter(
    (r) => r.verdict === 'pass' || (r.outcome === 'not-attempted' && absences[r.id] !== undefined),
  );
  const declaredAway = coverageProbes.filter(
    (r) => r.verdict !== 'pass' && r.outcome === 'not-attempted' && absences[r.id] !== undefined,
  );
  const coverageProbesPass =
    coverageProbes.length === COVERAGE_PROBES.length && satisfied.length === COVERAGE_PROBES.length;
  const gaps = e.ratchetGapAccounting?.value;

  if (!e.baseline) {
    return {
      item: 'P2',
      disposition: 'FAIL',
      basis: 'declared+checked',
      reason:
        `No baseline covers ${capturePath.join(', ')}. The capture path is unmeasured, so ` +
        'everything true of it is true by reading the source and unprovable to a third ' +
        'party — which is precisely the gap P2 exists to close.',
      conditions: [],
      citations: [e.capturePathFiles.cite],
    };
  } else if (uncovered.length) {
    return {
      item: 'P2',
      disposition: 'FAIL',
      basis: 'declared+checked',
      reason:
        `Baseline ${e.baseline.value.ref} exists but does not cover ${uncovered.length} of ` +
        `${capturePath.length} capture-path files: ${uncovered.join(', ')}. A partially ` +
        'measured capture path is an unmeasured one — the unmeasured file is where the ' +
        'change goes.',
      conditions: [],
      citations: [e.baseline.cite, e.capturePathFiles.cite],
    };
  } else if (input.probes && input.probes.subject !== input.path) {
    // A RUN IS EVIDENCE ABOUT THE DEPLOYMENT IT RAN AGAINST AND NO OTHER.
    // Found in WO-14: an admissible seven-of-seven run against the
    // scruple-capture ComfyUI deployment was attached to canvas's grade and
    // moved canvas's P2 past its coverage conjunct. Nothing in the run was
    // false; it was simply about somewhere else. This is the borrowed-evidence
    // shape the leaf oracle's `surfaces` already closes one level down.
    return {
      item: 'P2',
      disposition: 'FAIL',
      qualifier: 'probe run is of another deployment',
      basis: 'declared+checked',
      reason:
        `Baseline covers the declared capture path, but the attached probe run was performed ` +
        `against '${input.probes.subject}', not against '${input.path}'. A conformance run is ` +
        'evidence about the deployment it occupied and about no other, and certification is per ' +
        'configuration (H-4 §7). Run the probes from THIS integration\'s tenant position.',
      conditions: [],
      citations: [e.baseline.cite],
    };
  } else if (!input.probes || !coverageProbesPass) {
    return {
      item: 'P2',
      disposition: 'FAIL',
      basis: 'declared+checked',
      reason:
        'Baseline covers the declared capture path, but no admissible probe run establishes ' +
        'that the declared path IS the whole path. WO-5 DEFECT-2 is open: nothing in the ' +
        'hook/surface/placement model carries coverage completeness, so a well-formed ' +
        'profile naming only `filesystem-watch` is expressible and wrong. P2 therefore ' +
        'requires probes 4, 5 and 7 blocked from an occupied tenant position, and this run ' +
        (input.probes
          ? `has ${satisfied.length}/${COVERAGE_PROBES.length}.`
          : 'has none.'),
      conditions: [],
      citations: [e.baseline.cite],
    };
  } else if (!gaps || !gaps.accounted) {
    return {
      item: 'P2',
      disposition: 'FAIL',
      basis: 'declared+checked',
      reason:
        'Baseline and coverage probes hold, but there is no ratchet gap accounting. Without ' +
        'it a run that captured nothing and a run that captured everything produce the same ' +
        'report, and silence is the specific thing H-4 §4.2 exists to make visible.',
      conditions: [],
      citations: [e.baseline.cite],
    };
  } else {
    return {
      item: 'P2',
      disposition: 'PASS',
      basis: 'declared+checked',
      reason:
        `Baseline ${e.baseline.value.ref} covers all ${capturePath.length} capture-path files; ` +
        `${satisfied.length - declaredAway.length} of ${COVERAGE_PROBES.length} coverage probes ` +
        `blocked from an ${input.probes.vantages.join('/')} vantage; ` +
        `${gaps.gaps} unaccounted counter gaps.` +
        (declaredAway.length
          ? ` ${declaredAway.length} coverage probe(s) not applicable — ` +
            declaredAway.map((r) => `${r.id}: ${absences[r.id].value} (${absences[r.id].cite})`).join('; ') +
            '. That acceptance rests on a DECLARATION the model cannot check (WO-5 DEFECT-2), ' +
            'not on an observation.'
          : ''),
      conditions: [],
      citations: [e.baseline.cite, e.ratchetGapAccounting?.cite ?? ''].filter(Boolean),
    };
  }
}

/* ────────────────────────────────────────────────────────────────────────
 * P2, THE RULE IN FORCE — seal currency.
 *
 * "Is the running pipeline sealed against an approved measurement, and is the
 * seal current?" Nothing here enumerates a route, a surface or an egress path,
 * because the approved artefact is the whole pipeline: the routes that exist
 * are the routes in the measured image, and a new upstream release is a new
 * measurement and a new approval rather than four more entries in a denylist.
 * ──────────────────────────────────────────────────────────────────────── */
export function p2SealedPipeline(input: GradeInput): ItemGrade {
  const e = input.evidence;
  const capturePath = e.capturePathFiles.value;
  const seal = e.seal?.value ?? null;
  const sealCite = e.seal?.cite ?? '';

  // (0) EVIDENCE ADMISSIBILITY, BEFORE ANYTHING ELSE. WO-14: a real,
  // admissible, seven-of-seven run against another deployment was attached to
  // canvas's grade and every fact in it was true. A run is evidence about the
  // deployment it occupied and about no other (H-4 §7 — certification is per
  // configuration), and a deployment cannot reach a seal on somebody else's
  // step-2 evidence. Checked first because nothing computed downstream of
  // borrowed evidence is worth reporting.
  if (input.probes && input.probes.subject !== input.path) {
    return {
      item: 'P2',
      disposition: 'FAIL',
      qualifier: 'probe run is of another deployment',
      basis: 'declared+checked',
      reason:
        `The probe run attached to this grade was performed against '${input.probes.subject}', ` +
        `not against '${input.path}'. A conformance run is evidence about the deployment it ` +
        'occupied and about no other, and certification is per configuration (H-4 §7). The ' +
        "seal is granted at the end of a run from THIS integration's tenant position; a " +
        'borrowed one cannot carry a deployment into step 3.',
      conditions: [],
      citations: [e.capturePathFiles.cite],
    };
  }

  // (1) Is there a seal state at all? `undeclared`, in the registry's word:
  // nothing was said. Canvas and the plugins are here today.
  if (!seal) {
    return {
      item: 'P2',
      disposition: 'FAIL',
      qualifier: 'never sealed',
      basis: 'declared+checked',
      reason:
        'Nothing in this evidence describes a seal state for this deployment. The pipeline has ' +
        'never been measured and no configuration has been approved, so everything true of it ' +
        'is true by reading the source and unprovable to a third party — which is the gap P2 ' +
        'exists to close. This is an ordinary state to be in: it is where every integration ' +
        'starts, and the sequence is integrate, test end to end, THEN seal.',
      conditions: [],
      citations: [e.capturePathFiles.cite],
    };
  }

  const st = seal.status;
  const fail = (qualifier: string, reason: string): ItemGrade => ({
    item: 'P2',
    disposition: 'FAIL',
    qualifier,
    basis: 'declared+checked',
    reason,
    conditions: [],
    citations: [sealCite],
  });

  // (2) DECLARED AND NOT OURS. The registry's `unregistered`: a deployment id
  // was given and there is no record of it under this tenant. Distinct from
  // (1), which is nothing having been said at all — and the two must not share
  // a spelling, because one is an ordinary starting state and the other is a
  // claim about a seal nobody can find.
  if (!st.known) {
    return fail(
      'deployment not registered',
      `Deployment '${st.deployment_id}' is declared and there is no record of it under this ` +
        'tenant. A seal claim that cannot be resolved to a registered deployment is not a weak ' +
        'seal claim, it is a claim about somebody else — and refusing to resolve it here is the ' +
        'same refusal `checkDeploymentSeal` makes when it stamps `unregistered` on a leaf.',
    );
  }

  // (3) THE LIFECYCLE, from the registry's own fold. `claims_standard` is the
  // one question the lifecycle exists to answer, spelled out by the registry
  // rather than re-derived here from `state === 'sealed'` and got subtly wrong.
  const currency = sealCurrency(seal);
  if (currency.state === 'not-sealed') {
    const cause = currency.cause;
    const where =
      currency.lifecycle === 'integrating'
        ? 'building against the SDK (step 1). Failures here are ordinary and expected, and ' +
          'they are supposed to happen before anything is measured: you cannot hash a moving ' +
          'target, and a measurement taken during step 1 is stale before it is recorded.'
        : currency.lifecycle === 'verifying'
          ? 'running conformance end to end (step 2). Failures here are exactly where they are ' +
            'supposed to happen. Real leaves flow from here and are honest records of what ' +
            'happened rather than claims to the standard.'
          : cause === 'material_change'
            ? 'back in re-approval after a MATERIAL change inside the boundary. The seal did ' +
              'not survive the change to what it sealed, which is the mechanism working.'
            : cause === 'drift_budget'
              ? `back in re-approval on accumulated drift: ${st.drift_since_seal} consequential ` +
                `changes against a budget of ${st.drift_budget}. No one of them could alter what ` +
                'a leaf says; together they are a different pipeline under an old approval.'
              : cause === 'term_expired'
                ? `back in re-approval because the term ran out (sealed ${st.sealed_at}, expired ` +
                  `${st.seal_expires_at}). The term is the counterweight that makes exempting ` +
                  'non-material changes defensible at all.'
                : 'back in re-approval.';
    return fail(
      currency.lifecycle === 'resealing'
        ? `resealing${cause ? ` — ${cause.replace(/_/g, ' ')}` : ''}`
        : `${currency.lifecycle}, not yet sealed`,
      `This deployment is \`${currency.lifecycle}\` — ${where} The standard is not claimable ` +
        'from here. That is not a third compliance state: compliance stays binary, and the ' +
        'lifecycle says which side of the line this deployment is on.',
    );
  }
  if (currency.state === 'no-approved-manifest') {
    return fail(
      'seal carries no manifest',
      `The fold says sealed (${st.seal_ref}) and no approved manifest came with it. A ` +
        'measurement nobody can reproduce is a number rather than evidence, which is why the ' +
        'seal row stores the manifest in full; a grade cannot check a boundary it was not given.',
    );
  }
  if (currency.state === 'self-inconsistent') {
    return fail(
      'seal record contradicts itself',
      `The seal record disagrees with itself: ${currency.detail} Nothing downstream of that is ` +
        'worth computing — whether the running pipeline matches an approval cannot be asked ' +
        'until the approval agrees with its own manifest.',
    );
  }
  if (currency.state === 'undeclared-drift') {
    return fail(
      'running pipeline is not the approved one',
      `The fold says sealed and the pipeline measured at grade time is not the approved one: ` +
        `${currency.detail}. NOBODY DECLARED THIS. The lifecycle fold is a record of what the ` +
        'vendor said about themselves and it is correct as such; a seal state that can only be ' +
        'moved by the sealed party\'s own honesty checks paperwork. Re-measure, declare the ' +
        'change, and re-approve.',
    );
  }

  // (4) CONTAINMENT, NOT ENUMERATION. See `boundaryOmissions`: a declared
  // capture file outside the measurement is not sealed, and a route inside the
  // measurement that nobody declared is covered anyway.
  const approved = seal.approvedManifest!;
  const outside = boundaryOmissions(approved, capturePath);
  if (outside.length) {
    return {
      item: 'P2',
      disposition: 'FAIL',
      qualifier: 'capture path outside the boundary',
      basis: 'declared+checked',
      reason:
        `${outside.length} of ${capturePath.length} declared capture-path files lie outside the ` +
        `approved boundary: ${outside.join(', ')}. The seal covers what it measured, and a ` +
        'capture file the measurement does not contain is the file a change goes into. Either ' +
        'the boundary is drawn too small or the declaration names something that is not part ' +
        'of this pipeline, and both are answers the integrator has to give.',
      conditions: [],
      citations: [sealCite, e.capturePathFiles.cite],
    };
  }

  // (5) PASS — with conditions naming whatever the claim still rests on. A
  // conditional PASS is still a pass (Standard §5); it says what makes the
  // claim checkable.
  const conditions: string[] = [];
  if (!seal.observed) {
    conditions.push(
      'nothing measured the running pipeline at grade time, so the seal state rests entirely on ' +
        'the fold of events the vendor declared. That fold is correct about what was said; it ' +
        'cannot see a change nobody reported. Measure the running pipeline and hand it in.',
    );
  }
  if (currency.consequentialSpent > 0) {
    conditions.push(
      `${currency.consequentialSpent} of ${st.drift_budget} consequential changes are spent ` +
        'against this seal. They are exempt from re-approval one at a time and not in aggregate; ' +
        'at the budget the seal is renewed rather than extended.',
    );
  }
  if (!input.probes) {
    conditions.push(
      'no step-2 conformance run is attached to this grade, so the claim that this pipeline was ' +
        'tested end to end before it was sealed rests on a declaration. Attach the run the seal ' +
        'was granted at the end of.',
    );
  }
  const classes = new Map<string, number>();
  for (const entry of approved.entries) {
    classes.set(entry.class, (classes.get(entry.class) ?? 0) + 1);
  }
  return {
    item: 'P2',
    disposition: conditions.length ? 'PASS-CONDITIONAL' : 'PASS',
    basis: 'declared+checked',
    reason:
      `The running pipeline is the configuration approved by seal ${st.seal_ref}, sealed ` +
      `${st.sealed_at} and current until ${st.seal_expires_at}. The approved boundary holds ` +
      `${approved.entries.length} entries (` +
      [...classes.entries()].map(([c, n]) => `${n} ${c}`).join(', ') +
      `), and all ${capturePath.length} declared capture-path files are inside it. ` +
      (seal.observed
        ? `The pipeline measured at grade time differs by: ${
            currency.verdict ? currency.verdict.reasons.join('; ') : 'nothing'
          }.`
        : 'The running pipeline was not re-measured at grade time.'),
    conditions,
    citations: [sealCite, e.capturePathFiles.cite],
  };
}

/** Which P2 rule applies, and the one place that decides it. */
export function gradeP2(input: GradeInput, profile: GradeProfile): ItemGrade {
  return profile.p2 === 'sealed-pipeline'
    ? p2SealedPipeline(input)
    : p2RuntimeCompleteness(input);
}

/* ────────────────────────────────────────────────────────────────────────
 * LIVENESS — the counter, reported for what it actually proves.
 *
 * Removed from P2 by docs/canon/INTEGRATION_LIFECYCLE.md. Nothing here reaches
 * `compliant`, and that is the correction: a deployment with no counter chain
 * is not thereby non-compliant, and a deployment whose counter is unaccounted
 * for has an operational problem rather than a coverage one.
 * ──────────────────────────────────────────────────────────────────────── */
export function gradeLiveness(e: DeclaredEvidence): LivenessReport {
  const acct = e.ratchetGapAccounting;
  if (acct) {
    if (!acct.value.accounted) {
      return {
        verdict: 'unaccounted',
        gaps: null,
        reason:
          'A counter chain exists and nobody accounted for its gaps, so a deployment that ' +
          'captured nothing and one that captured everything produce the same report. Silence ' +
          'is the specific thing H-4 §4.2 exists to make visible. This is an operational ' +
          'finding, not a compliance one.',
        citations: [acct.cite],
      };
    }
    return {
      verdict: acct.value.gaps > 0 ? 'gaps-accounted' : 'live',
      gaps: acct.value.gaps,
      reason:
        acct.value.gaps > 0
          ? `${acct.value.gaps} counter gap(s), accounted for. The deployment went quiet and the ` +
            'record says where — a hole you can see is evidence.'
          : 'The counter chain is accounted for with no gaps: this deployment has not gone dark ' +
            'and nothing suppressed it over the accounted window.',
      citations: [acct.cite],
    };
  }
  if (e.ratchetAbsence) {
    return {
      verdict: 'not-applicable',
      gaps: null,
      reason:
        `No counter chain on this path: ${e.ratchetAbsence.value}. There is nothing to be silent ` +
        'with, so liveness is unavailable here and that is not a coverage failure. Reading it as ' +
        'one is what made a componentless path look permanently non-compliant.',
      citations: [e.ratchetAbsence.cite],
    };
  }
  return {
    verdict: 'unaccounted',
    gaps: null,
    reason:
      'No gap accounting and no declared absence of a ratchet. The grader cannot tell a ' +
      'deployment that has gone dark from one that never had a counter, and those are ' +
      'different findings. Declare one or the other.',
    citations: [],
  };
}

export function grade(
  sourceRef: string,
  inputs: readonly GradeInput[],
  profile: GradeProfile = DEFAULT_PROFILE,
): Grade {
  return {
    gradedAt: new Date().toISOString(),
    sourceRef,
    profile: profile.id,
    paths: inputs.map((i) => gradePath(i, profile)),
  };
}
