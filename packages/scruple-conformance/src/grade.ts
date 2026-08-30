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
// DEFECT-2 (WO-5, STILL OPEN) AND WHAT IT COSTS P2
// ---------------------------------------------------------------------------
//
// lib/capture/surface.ts says it plainly: "nothing in this type — or in the
// three axes — can say that a set of surfaces COVERS every egress path of a
// host. ComfyUI needs two surfaces and a config naming one is expressible and
// wrong."
//
// So a profile is a well-formed sentence about coverage that carries no
// coverage claim. If P2 could be satisfied by reading one, the harness would
// hand a clean P2 to a vendor who watched `output/` and missed every
// `PreviewImage` in `temp/` (C-8) and every byte leaving through
// `comfy_api_nodes/` (C-9) — the two findings that produced this WO.
//
// THEREFORE: P2 IS NEVER SATISFIED BY A DECLARATION. It requires
//   (a) a baseline that covers every file the integrator names on the capture
//       path — nothing declared, everything compared; AND
//   (b) evidence from a RUNNING system: an admissible probe run in which the
//       coverage probes (4, 5, 7) were attempted from an occupied tenant
//       position and blocked; AND
//   (c) ratchet gap accounting, because a coverage claim with no account of
//       missing counters cannot distinguish "captured nothing" from
//       "captured everything" (H-4 §4.2).
//
// (a) alone is the paperwork half. (b) and (c) are the half DEFECT-2 leaves
// out of the model, and until DEFECT-2 closes they have to be carried here.
//
// ONE EXPLICIT HOLE, NAMED RATHER THAN PAPERED OVER. A coverage probe can come
// back `not-attempted` because the surface it probes DOES NOT EXIST in this
// integration — canvas has no filesystem surface, because the Modal volume is
// not mountable into scruple-web. That is not a pass and it is not a failure;
// nothing was gated, and nothing could leak. The grader accepts it ONLY when
// the integrator declares the absence in `surfaceAbsences` with a citation,
// and it says in the P2 reason that the acceptance rests on a declaration
// DEFECT-2 gives it no way to check. A vendor who falsely declares "no
// filesystem surface" gets a P2 pass they did not earn. That is the residual
// hole; closing it needs a coverage axis, which is the WO-5 defect itself.

import {
  assuranceForHost,
  type HostAssurance,
  type HostCaptureProfile,
} from '../../../lib/capture/surface';
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
  /** 'derived' when assuranceForHost decided it; 'declared+checked' otherwise. */
  basis: 'derived' | 'declared+checked' | 'derived-from-P2' | 'derived-from-P3';
}

/** A citation is a fact plus where to look. An uncited fact is not evidence. */
export interface Cited<T> {
  value: T;
  /** `path/to/file.ts:12-18`. Required. */
  cite: string;
  note?: string;
}

export interface DeclaredEvidence {
  /** P2. The files the integrator says capture runs in. */
  capturePathFiles: Cited<string[]>;
  /** P2. What the baseline manifest actually covers. Null when none exists. */
  baseline: Cited<{ ref: string; covers: string[] }> | null;
  /** P2. Ratchet gap accounting from a live component. */
  ratchetGapAccounting: Cited<{ accounted: boolean; gaps: number }> | null;
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

export interface PathGrade {
  path: string;
  assurance: HostAssurance;
  items: Record<PItem, ItemGrade>;
  /** Standard §5: compliance is binary. */
  compliant: boolean;
}

export interface Grade {
  gradedAt: string;
  /** The commit the evidence was derived from. Named, because a grade of a
   *  moving tree is a grade of nothing. */
  sourceRef: string;
  paths: PathGrade[];
}

const COVERAGE_PROBES = ['P-04', 'P-05', 'P-07'];

export function gradePath(input: GradeInput): PathGrade {
  const a = assuranceForHost(input.profile);
  const e = input.evidence;
  const items = {} as Record<PItem, ItemGrade>;

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

  // ---- P2 · baseline coverage of the capture path ------------------------
  // The DEFECT-2 gate. Three conjuncts, all required, none declarable.
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
    items.P2 = {
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
    items.P2 = {
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
  } else if (!input.probes || !coverageProbesPass) {
    items.P2 = {
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
    items.P2 = {
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
    items.P2 = {
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
  // because there is no baseline manifest in which to declare it.
  if (items.P2.disposition === 'FAIL' && !e.attestationDeclaration) {
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
  } else if (!e.attestationDeclaration) {
    items.P7 = {
      item: 'P7',
      disposition: 'FAIL',
      basis: 'declared+checked',
      reason: 'A baseline exists but declares no attestation provider.',
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

  // Standard §5 — compliance is binary. A conditional PASS is still a pass on
  // the item and still not a third compliance state; a single FAIL is the end
  // of the question.
  const compliant = P_ITEMS.every((p) => items[p].disposition !== 'FAIL');

  return { path: input.path, assurance: a, items, compliant };
}

export function grade(sourceRef: string, inputs: readonly GradeInput[]): Grade {
  return {
    gradedAt: new Date().toISOString(),
    sourceRef,
    paths: inputs.map(gradePath),
  };
}
