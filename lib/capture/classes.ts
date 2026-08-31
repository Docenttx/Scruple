// The layer above `HostCaptureProfile`. docs/canon/CAPABILITY_CLASSES.md and
// docs/canon/CUSTODY_LOCUS.md, founder direction, 2026-08-30.
//
// ---------------------------------------------------------------------------
// SECURITY TARGET vs. PROTECTION PROFILE
// ---------------------------------------------------------------------------
//
// `CANON_HOST_PROFILES` in ./surface.ts describes SPECIFIC INTEGRATIONS —
// this product, these hooks, this placement. That is a Security Target in
// Common Criteria's sense. What was missing is the layer above: the CLASS of
// product, with the requirements every member must meet, that a specific
// profile is graded AGAINST.
//
// Without it every vendor is graded against one monolithic standard, and
// anything their shape does not have reads as a GAP rather than as OUT OF
// SCOPE. That is not hypothetical: it is why probe 4 read as a canvas failure
// when canvas has no filesystem surface at all, and it is the residue of
// WO-5's DEFECT-2 ("no axis carries coverage completeness").
//
// A CLASS CLOSES IT NOT BECAUSE A TYPE DOES THE WORK BUT BECAUSE THE
// DECLARATION DOES. Under the old rule the integrator declared "no filesystem
// surface here" in `surfaceAbsences` and the grader accepted it with a cite it
// could not check. Under a class the not-applicable is declared ONCE, BY THE
// CLASS, and CHECKED AGAINST THE PROFILE: probe 4 is not applicable to an
// inference host that declares no `filesystem-watch` surface, and it becomes
// applicable again the moment one is declared. The vendor can still lie — but
// now the lie has to be told in the `surfaces` list, which is the same list
// their required-surface check and their permitted claim wording are computed
// from. See `residualDefect2()` at the bottom, which says this in the code
// rather than only in a document.
//
// ---------------------------------------------------------------------------
// THE INVERSION, AND IT IS THE REASON THIS FILE EXISTS
// ---------------------------------------------------------------------------
//
// `authoring-application` INVERTS THE THREAT MODEL. On an inference host we
// prove what a machine did against a tenant who may lie. In Fusion or Blender
// the user WANTS to be bound, and the adversary is whoever disputes the claim
// later. Grading those hosts against inference-host probes — bypass the gate,
// reach the admin surface, retrieve over the WebSocket, escape the egress
// policy — produces nonsense, and it produced nonsense for three WOs running.
//
// Do not let inference-host assumptions leak back in. Every not-applicable
// below carries the sentence that justifies it, and the sentences are not
// interchangeable between classes.
//
// ---------------------------------------------------------------------------
// VOCABULARY NOTE
// ---------------------------------------------------------------------------
//
// `PItemId` and `ProbeId` are re-declared here structurally rather than
// imported from `packages/scruple-conformance/src/types.ts`, for the same
// reason `AttestationStatus` is re-declared in ./surface.ts: `lib/` must not
// depend on a package that depends on it. The conformance package asserts at
// COMPILE TIME that the two spellings are mutually assignable — see
// `packages/scruple-conformance/src/classes.ts`. There is no third copy.

import type {
  CaptureHook,
  CaptureSurfaceKind,
  HostCaptureProfile,
  Placement,
} from './surface';

/* ────────────────────────────────────────────────────────────────────────
 * The four classes. Named by WHAT THE VENDOR INSTALLS, never by which audit
 * they would prefer.
 * ──────────────────────────────────────────────────────────────────────── */

export const CAPABILITY_CLASSES = [
  'inference-host',
  'training-host',
  'authoring-application',
  'asset-custody',
] as const;

export type CapabilityClass = (typeof CAPABILITY_CLASSES)[number];

/**
 * WHICH CLASS IS "BROADER", ORDERED EXPLICITLY RATHER THAN BY ACCIDENT.
 *
 * CAPABILITY_CLASSES.md: "where it is ambiguous, the broader class applies."
 * That rule needs an ordering or it is advice. Breadth here means how much of
 * the standard a member has to answer for: `inference-host` requires all seven
 * probes and treats the tenant as the adversary; `authoring-application`
 * requires two and inverts the threat model.
 *
 * The ordering is also the anti-gaming incentive. A profile that declares NO
 * class is audited against the FIRST entry — the hardest one — rather than
 * against the easiest or against nothing.
 */
export const CLASS_BREADTH: readonly CapabilityClass[] = [
  'inference-host',
  'training-host',
  'asset-custody',
  'authoring-application',
];

/** The broadest of a set of candidates. Empty in, broadest overall out. */
export function broadestClass(candidates: readonly CapabilityClass[]): CapabilityClass {
  for (const c of CLASS_BREADTH) if (candidates.includes(c)) return c;
  return CLASS_BREADTH[0];
}

/* ────────────────────────────────────────────────────────────────────────
 * Custody locus — where files rest BETWEEN witnessed events.
 * docs/canon/CUSTODY_LOCUS.md.
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * The same shape as placement, and the fourth value exists for the same
 * reason: so the model can say no.
 *
 * WHAT CUSTODY PROTECTS IS NOT THE ARTIFACT HASH. A bait-and-switch on a
 * single artifact is already defeated — we witnessed hash(A), the user
 * presents B, the receipt does not match. Custody protects CONTINUITY BETWEEN
 * WITNESSED EVENTS: "this project passed through these states and nothing
 * happened in between that we did not see." It is the completeness problem
 * moved from across surfaces to across time.
 */
export const CUSTODY_LOCI = [
  'ephemeral',
  'vendor-custody',
  'shared-custody',
  'tenant-custody',
  'tenant-custody-corroborated',
] as const;

export type CustodyLocus = (typeof CUSTODY_LOCI)[number];

/* ────────────────────────────────────────────────────────────────────────
 * THE FIFTH VALUE, AND WHY IT IS NOT A SPECIAL CASE WEARING A GENERAL NAME.
 *
 * `docs/canon/custody-study/fusion.md` §6.3. CUSTODY_LOCUS.md gives four
 * values and Fusion fits none of them cleanly:
 *
 *   * its LOCAL file is `tenant-custody` — a plain store-compressed ZIP with
 *     no integrity field anywhere in it, on the artist's disk;
 *   * its CLOUD VERSION SEQUENCE is genuinely append-only IN FACT. Autodesk's
 *     8,289-line Data Management API v2 OpenAPI spec contains zero `delete:`
 *     operations, and Autodesk states that BIM 360's tombstone workaround does
 *     not apply to Fusion Team files, which cannot have a version deleted at
 *     all.
 *
 * Folding that into `tenant-custody` throws away a verified assurance gain.
 * Folding it into `vendor-custody` is worse and is the exact misrepresentation
 * this axis exists to prevent: `vendor-custody` means the INTEGRATOR's
 * boundary — a party to the standard, whose topology we can probe. Autodesk is
 * neither.
 *
 * THE SHAPE IS GENERAL, WHICH IS THE TEST IT HAD TO PASS. "Files rest in
 * tenant custody and an independent operator holds an append-only,
 * non-tenant-writable record of the state sequence" is not a description of
 * Fusion. It is equally a description of Drive or Dropbox version history, a
 * git remote the developer cannot force-push, or S3 with object lock — and we
 * will meet those.
 *
 * AND IT EARNS ITS PLACE BY BEING ABLE TO DEGRADE. A locus that could only be
 * declared would be DEFECT-1 again, one axis over: a vendor assigning
 * themselves a tier by naming it. So it works the way `resolvePlacement` does
 * — the value must be EARNED by naming the corroborating party and citing its
 * guarantee, and `resolveCustodyLocus()` reduces an unearned claim back to
 * plain `tenant-custody`.
 * ──────────────────────────────────────────────────────────────────────── */

/** How checkable the corroborating record is BY US, not by the operator. */
export const CORROBORATION_VERIFIABILITY = [
  /**
   * The operator asserts the guarantee and there is no hash, no signature and
   * no customer-verifiable log. Fusion is here: version `name` is PATCH-able
   * and descriptions are editable after the fact. Corroboration then means
   * "a second party would have to lie too", NEVER "the record is provable".
   */
  'asserted',
  /**
   * The record is checkable by a third party holding the artifact — a signed
   * log, a published digest, an object-lock receipt. Nothing we integrate is
   * here yet; fusion.md open question 2 asks whether Fusion can be.
   */
  'cryptographic',
] as const;

export type CorroborationVerifiability = (typeof CORROBORATION_VERIFIABILITY)[number];

/**
 * THE CORROBORATOR MUST BE NAMED AND ITS GUARANTEE CITED, NEVER ASSUMED.
 *
 * That requirement is the whole finding of the Fusion study restated as a
 * type. "Fusion is tamper-resistant" is FALSE in general — the parametric
 * timeline is fully rewritable through Fusion's own published scripting API
 * and `design.designType = DirectDesignType` destroys the entire history in
 * one assignment, recorded nowhere — and TRUE in one specific place, the cloud
 * version sequence. A modifier that let a vendor say "our host tracks
 * versions" without saying WHICH record, held by WHOM, under WHAT documented
 * guarantee, would launder the false general claim on the true specific one.
 */
export interface CustodyCorroborator {
  /** WHO. A named operator. 'Autodesk (Fusion Team / Data Management API v2)'. */
  party: string;
  /** WHAT they guarantee, in their words where possible. */
  guarantee: string;
  /** WHERE it is documented. A grade whose inputs are unsourced is a survey. */
  cite: string;
  /**
   * TRUE if the tenant can delete or rewrite entries in the record. A record
   * the measured party can edit corroborates nothing, and the claim degrades.
   */
  tenantWritable: boolean;
  verifiable: CorroborationVerifiability;
}

export interface CustodyLocusResolution {
  declared: CustodyLocus;
  effective: CustodyLocus;
  honoured: boolean;
  reason: string;
}

/**
 * Reduce a declared locus + its corroboration evidence to the locus the
 * custody assurance function is allowed to see. Total over all inputs.
 *
 * Only `tenant-custody-corroborated` has anything to earn; every other value
 * is honoured as declared, because the other four are claims about topology
 * that `custodyAssuranceFor` already reads against placement.
 */
export function resolveCustodyLocus(
  declared: CustodyLocus,
  corroborator?: CustodyCorroborator | null,
): CustodyLocusResolution {
  if (declared !== 'tenant-custody-corroborated') {
    return { declared, effective: declared, honoured: true, reason: 'nothing to earn' };
  }
  if (!corroborator) {
    return {
      declared,
      effective: 'tenant-custody',
      honoured: false,
      reason:
        'no corroborating party is named. The modifier is earned by naming the operator and ' +
        'citing its guarantee; an unnamed corroborator is a declaration, not a second party. ' +
        'Degraded to `tenant-custody`.',
    };
  }
  if (corroborator.tenantWritable) {
    return {
      declared,
      effective: 'tenant-custody',
      honoured: false,
      reason:
        `${corroborator.party}'s record is writable by the measured party, so it corroborates ` +
        'nothing: the same hand writes the claim and the check. Degraded to `tenant-custody`.',
    };
  }
  return {
    declared,
    effective: declared,
    honoured: true,
    reason:
      `${corroborator.party} holds an append-only record the measured party cannot rewrite: ` +
      `${corroborator.guarantee} (${corroborator.cite})`,
  };
}

/** What a locus + placement pair actually entitles a vendor to say. */
export const CUSTODY_CLAIMS = [
  /** vendor-custody: every mutation crosses a path the pipeline sees. */
  'complete-history',
  /** shared-custody: complete UNLESS someone worked around the pipeline. */
  'detectable-gaps',
  /**
   * tenant-custody + a named, non-tenant-writable third-party sequence record.
   * Between `witnessed-moments` and `complete-history`, and it stops short of
   * the second for three reasons the class states rather than implies.
   */
  'corroborated-moments',
  /** tenant-custody: notarial. These states, at these times. Nothing more. */
  'witnessed-moments',
  /** ephemeral: nothing was retained that could be altered between events. */
  'nothing-at-rest',
  /** Refused. */
  'none',
] as const;

export type CustodyClaim = (typeof CUSTODY_CLAIMS)[number];

export interface CustodyAssurance {
  /** EFFECTIVE locus, already through `resolveCustodyLocus`. */
  locus: CustodyLocus;
  /** How the declared locus reduced to that. Carried so a degrade is visible. */
  resolution: CustodyLocusResolution;
  /** EFFECTIVE placement, already through `resolvePlacement`. */
  placement: Placement;
  claim: CustodyClaim;
  /** The permitted sentence, verbatim. This is the trademark clause's teeth. */
  sentence: string;
  /** Sentences this pair MUST NOT be allowed to imply. */
  mustNotImply: readonly string[];
  conditions: readonly string[];
  canClaim: boolean;
  reason: string;
}

const HISTORY_CONDITION =
  'no path the measured party can reach writes into the custody store without crossing the ' +
  'pipeline — evidenced by probe 4 from an occupied tenant position, or by the class-checked ' +
  'absence of a filesystem egress path';

/**
 * LOCUS AND PLACEMENT TOGETHER DECIDE WHAT MAY BE CLAIMED, AND NEITHER ALONE
 * IS SUFFICIENT. Total over 4 loci x 4 placements.
 *
 * THE CAVEAT THAT MADE THIS A FUNCTION RATHER THAN A LOOKUP. CUSTODY_LOCUS.md:
 * "`ephemeral` means nothing rests where it can be altered BETWEEN events. It
 * does not mean memory is beyond reach — if the tenant has code execution in
 * the same process, memory is theirs. `ephemeral` is a claim about
 * PERSISTENCE, not about ISOLATION; placement still decides the second."
 *
 * So `ephemeral` + `unattested-client` does NOT resolve to the strongest
 * claim. It resolves to no claim at all, exactly as `assuranceFor` refuses
 * that placement regardless of attestation — and the two refusals agree by
 * construction, which is asserted in test/v2/capability-classes.test.ts.
 */
export function custodyAssuranceFor(
  declaredLocus: CustodyLocus,
  placement: Placement,
  corroborator?: CustodyCorroborator | null,
): CustodyAssurance {
  const resolution = resolveCustodyLocus(declaredLocus, corroborator);
  const locus = resolution.effective;
  // Rule 1 — the refusal, and it is unconditional, and the locus is ignored.
  //
  // A vendor whose capture code the measured party can edit has no custody
  // claim to make, because the thing that would report a mutation is itself
  // in the mutating party's hands. `ephemeral` is the tempting exception and
  // it is not one: "we keep nothing" is a statement about a store, made by
  // code the tenant can rewrite, about memory the tenant may share.
  if (placement === 'unattested-client') {
    return {
      locus,
      resolution,
      placement,
      claim: 'none',
      sentence: '',
      mustNotImply: [
        'this is the complete history of the project',
        'these states were witnessed at these times',
        'nothing was retained that could be altered between events',
      ],
      canClaim: false,
      conditions: [],
      reason:
        `unattested-client + ${locus}: the measured party can modify the code that would report ` +
        'a mutation. No custody claim survives that, and `ephemeral` least of all — it is a claim ' +
        'about persistence, not about isolation, and isolation is what this placement lacks. ' +
        'Events may be RECORDED as declared, never as witnessed (D-8).',
    };
  }

  // Whether the measured party is kept out of the CAPTURE PROCESS. Custody
  // claims about a vendor-side store need this; notarial claims do not.
  const vendorSideBoundary = placement === 'server-library' || placement === 'sidecar-gate';

  switch (locus) {
    case 'ephemeral':
      if (!vendorSideBoundary) {
        // attested-client: the host application is on the measured party's own
        // machine. "Nothing rests in our store" is true and vacuous — there is
        // no store of ours for it to be about — and it must not be allowed to
        // stand in for "nothing rests anywhere."
        return {
          locus,
          resolution,
          placement,
          claim: 'witnessed-moments',
          sentence: 'these states were witnessed at these times',
          mustNotImply: [
            'nothing was retained that could be altered between events',
            'this is the complete history of the project',
          ],
          canClaim: true,
          conditions: [
            'the claim is notarial: it is about the moments we saw, not about what rests between them',
          ],
          reason:
            'ephemeral + attested-client: there is no vendor store for "we keep nothing" to be ' +
            'about. The files rest on a machine the measured party owns, whatever our process ' +
            'retains, so the honest claim is the notarial one.',
        };
      }
      return {
        locus,
        resolution,
        placement,
        claim: 'nothing-at-rest',
        sentence: 'nothing was retained that could be altered between events',
        mustNotImply: [
          'this is the complete history of the project',
          'the measured party could not read the bytes while they existed',
        ],
        canClaim: true,
        conditions: [
          'the measured party has no code execution in the process the bytes pass through — ' +
            'ephemeral is a claim about persistence, not about isolation (CUSTODY_LOCUS.md)',
        ],
        reason:
          `ephemeral + ${placement}: generate, hash, deliver, keep nothing. Strongest, and ` +
          'narrow — it says there is nothing to tamper with, and says nothing at all about who ' +
          'could read the bytes in flight.',
      };

    case 'vendor-custody':
      if (!vendorSideBoundary) {
        return {
          locus,
          resolution,
          placement,
          claim: 'witnessed-moments',
          sentence: 'these states were witnessed at these times',
          mustNotImply: ['this is the complete history of the project'],
          canClaim: true,
          conditions: [
            'a completeness claim needs a placement where the measured party has no code ' +
              'execution in the capture process; this one does not have that',
          ],
          reason:
            'vendor-custody + attested-client: files rest inside the vendor boundary and the ' +
            'code that watches them runs where the measured party does. A complete-history claim ' +
            'rests on the watcher, and the watcher is not out of reach.',
        };
      }
      return {
        locus,
        resolution,
        placement,
        claim: 'complete-history',
        sentence: 'this is the complete history of the project',
        mustNotImply: [],
        canClaim: true,
        conditions: [HISTORY_CONDITION],
        reason:
          `vendor-custody + ${placement}: the measured party reaches the files only through ` +
          'vendor APIs, so every mutation crosses a path the pipeline sees and the history is ' +
          'complete rather than sampled.',
      };

    case 'shared-custody':
      return {
        locus,
        resolution,
        placement,
        claim: 'detectable-gaps',
        sentence:
          'the history is complete unless someone worked around the pipeline, and a gap is ' +
          'visible as a gap',
        mustNotImply: ['this is the complete history of the project'],
        canClaim: true,
        conditions: [
          'the record shows THAT a gap exists even when it cannot show what happened inside it',
          HISTORY_CONDITION,
        ],
        reason:
          `shared-custody + ${placement}: the tenant has direct reach into vendor space — a ` +
          'mounted volume, a shell, object-store credentials. Mutation outside the pipeline is ' +
          'DETECTABLE, NOT PREVENTABLE, and the two are not the same sentence.',
      };

    case 'tenant-custody-corroborated':
      // THE THREE REASONS IT STOPS SHORT OF `complete-history`, carried as
      // conditions rather than left in the study. Each is a finding in
      // docs/canon/custody-study/fusion.md §6.3, and each is a STATED LIMIT of
      // the value rather than a caveat on one integration.
      return {
        locus,
        resolution,
        placement,
        claim: 'corroborated-moments',
        sentence:
          'these states were witnessed at these times, and an independent operator\'s ' +
          'append-only version record corroborates the sequence',
        mustNotImply: [
          'this is the complete history of the project',
          'the files could not have changed between these events',
        ],
        canClaim: true,
        conditions: [
          // 1 — the gaps are real and unclosable.
          'the corroborating record says THAT a state was saved, never what happened between ' +
            'saves. In this locus the measured party may roll back, reorder, re-parameterise or ' +
            'destroy the working history between two witnessed events, and no amount of ' +
            'engineering here produces a complete history',
          // 2 — the corroborator is uncheckable (unless it is not).
          ...(corroborator?.verifiable === 'cryptographic'
            ? []
            : [
                'the corroborating record is ASSERTED, not proved: no hash, no signature, no ' +
                  'customer-verifiable log, and metadata that may be editable after the fact. ' +
                  'Corroboration here means "a second party would have to lie too", never "the ' +
                  'record is provable"',
              ]),
          // 3 — the corroborator is intermittent.
          'corroboration is only as dense as the connection. Work done offline reaches the ' +
            'record as a single entry on reconnect, so the sequence is a record of syncs rather ' +
            'than of sessions',
          // And whose guarantee it is.
          `the guarantee is the corroborating operator's architecture and not the integrator's: ` +
            `${resolution.reason}`,
        ],
        reason:
          `tenant-custody-corroborated + ${placement}: the files rest on the measured party's own ` +
          'machine AND a named third party holds an append-only record of the state sequence that ' +
          'the measured party cannot delete. That is strictly more than a notary and strictly ' +
          'less than a complete history, and it is the corroborating operator that earned it.',
      };

    case 'tenant-custody':
      return {
        locus,
        resolution,
        placement,
        claim: 'witnessed-moments',
        sentence: 'these states were witnessed at these times',
        mustNotImply: [
          'this is the complete history of the project',
          'the files could not have changed between these events',
        ],
        canClaim: true,
        conditions: [
          'custody between events is ASSERTED, not enforced — the files are outside the boundary ' +
            'entirely',
        ],
        reason:
          `tenant-custody + ${placement}: the files rest on the user's own machine or storage. ` +
          'That is what a notary does and it is worth something; it is a DIFFERENT claim from a ' +
          'complete history, and a vendor must not be able to imply the first while holding the ' +
          'second.',
      };
  }
}

/** Every (locus, placement) pair, for exhaustiveness testing. */
export function allCustodyCells(placements: readonly Placement[]): CustodyAssurance[] {
  const out: CustodyAssurance[] = [];
  for (const l of CUSTODY_LOCI) for (const p of placements) out.push(custodyAssuranceFor(l, p));
  return out;
}

/* ────────────────────────────────────────────────────────────────────────
 * Probe and P-item identifiers. Re-declared; see the vocabulary note.
 * ──────────────────────────────────────────────────────────────────────── */

export const PROBE_IDS = ['P-01', 'P-02', 'P-03', 'P-04', 'P-05', 'P-06', 'P-07'] as const;
export type ProbeId = (typeof PROBE_IDS)[number];

export const P_ITEM_IDS = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8'] as const;
export type PItemId = (typeof P_ITEM_IDS)[number];

const PROBE_TITLES: Record<ProbeId, string> = {
  'P-01': 'reach the workload bypassing the gate',
  'P-02': 'reach the component admin/provisioning surface',
  'P-03': 'read the sealed identity key from the tenant position',
  'P-04': 'write into the output volume without producing a leaf',
  'P-05': 'retrieve output over the non-file path without producing a leaf',
  'P-06': 'replay or forge a counter against the ingest',
  'P-07': 'open an egress the deployment policy should deny',
};

export function probeTitle(id: ProbeId): string {
  return PROBE_TITLES[id];
}

/* ────────────────────────────────────────────────────────────────────────
 * NOT-APPLICABLE, AS A DECLARED AND CHECKED PROPERTY.
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * A class's declaration that some item does not bind its members, WITH THE
 * SENTENCE THAT JUSTIFIES IT.
 *
 * `contingentOnAbsentSurface` is what makes a not-applicable checkable rather
 * than merely stated. Probe 4 is not applicable to a member that declares no
 * `filesystem-watch` surface — and it is applicable the moment one appears in
 * the profile. An unconditional entry (no contingency) is a property of the
 * SHAPE of the class, not of one deployment's topology: a training host has no
 * interactive retrieval channel no matter what it declares.
 */
export interface NotApplicable<T extends string> {
  item: T;
  reason: string;
  contingentOnAbsentSurface?: CaptureSurfaceKind;
}

export type ScopeStatus = 'required' | 'permitted' | 'not-applicable';

/**
 * THE THREE OUTCOMES THE GRADER USED TO CONFLATE, plus the one it got right.
 *
 *   'not-applicable' declared by the class AND checked against the profile
 *   'satisfied'      applicable, and the evidence says so
 *   'failed'         applicable, and the evidence says it failed
 *   'unmeasured'     applicable, and NOBODY LOOKED. Never a pass.
 *
 * WO-14 established inconclusive-is-never-a-pass for probes. This is the same
 * discipline at class scope: a probe the class requires and the run did not
 * attempt is `unmeasured`, and `unmeasured` aggregates as not-satisfied
 * everywhere. There is no configuration in which a skip becomes a pass.
 */
export type ItemOutcome = 'not-applicable' | 'satisfied' | 'failed' | 'unmeasured';

export interface ScopedItem<T extends string> {
  item: T;
  status: ScopeStatus;
  outcome: ItemOutcome;
  /** One sentence. Why this status and this outcome. */
  reason: string;
  /**
   * Set when the class declared this not-applicable AND THE PROFILE
   * CONTRADICTED IT. The n/a does not hold; the item is graded.
   */
  voidedBy?: string;
}

/* ────────────────────────────────────────────────────────────────────────
 * The class definition.
 * ──────────────────────────────────────────────────────────────────────── */

export type ThreatModel =
  /** The party whose behaviour is measured runs code inside the boundary. */
  | 'tenant-is-the-adversary'
  /** The user attests their OWN work; the adversary disputes it later. */
  | 'third-party-disputes-later'
  /** Nobody is attacking; the question is whether a gap in time is visible. */
  | 'continuity-between-events';

export interface ClassDefinition {
  id: CapabilityClass;
  title: string;
  /** What the vendor INSTALLS. Class follows from this, never from preference. */
  installs: string;
  exampleVendors: readonly string[];
  threatModel: ThreatModel;
  adversary: string;

  /** Hooks. required ∪ permitted ∪ notApplicable partitions CAPTURE_HOOKS. */
  requiredHooks: readonly CaptureHook[];
  permittedHooks: readonly CaptureHook[];
  notApplicableHooks: readonly NotApplicable<CaptureHook>[];

  /**
   * Surfaces. required ∪ flatten(requiredAnyOf) ∪ permitted ∪ notApplicable
   * partitions CAPTURE_SURFACES.
   *
   * `requiredSurfacesAnyOf` is a disjunction and it is not softness. An
   * inference host must observe the delivery path, and whether that position
   * is a gate in front of the process or a call inside it depends on whether
   * the vendor owns the handler — both are real coverage of the same path.
   * WHICH ONE IT IS SAYS NOTHING ABOUT ASSURANCE (surface.ts: "SURFACE DOES
   * NOT AFFECT ASSURANCE"); a surface requirement that tried to do placement's
   * job would be the category error that file exists to prevent.
   */
  requiredSurfaces: readonly CaptureSurfaceKind[];
  requiredSurfacesAnyOf: readonly (readonly CaptureSurfaceKind[])[];
  permittedSurfaces: readonly CaptureSurfaceKind[];
  notApplicableSurfaces: readonly NotApplicable<CaptureSurfaceKind>[];

  requiredProbes: readonly ProbeId[];
  permittedProbes: readonly ProbeId[];
  notApplicableProbes: readonly NotApplicable<ProbeId>[];

  applicablePItems: readonly PItemId[];
  notApplicablePItems: readonly NotApplicable<PItemId>[];

  /** The sentence a member of this class is entitled to. */
  permittedClaim: string;
  /** Sentences a member MUST NOT be able to imply. The trademark mechanism. */
  forbiddenClaims: readonly string[];

  /** True when the class turns on a custody locus and a member must declare one. */
  requiresCustodyLocus: boolean;
  /** Loci that contradict being a member of this class at all. */
  incompatibleLoci: readonly NotApplicable<CustodyLocus>[];
}

/* ────────────────────────────────────────────────────────────────────────
 * THE FOUR.
 * ──────────────────────────────────────────────────────────────────────── */

const INFERENCE_HOST: ClassDefinition = {
  id: 'inference-host',
  title: 'Inference host',
  installs:
    'a capture position in front of, or inside, a workload that serves generation requests for ' +
    'tenants who supply the graph',
  exampleVendors: ['Hugging Face', 'RunPod', 'hosted ComfyUI', 'Modal-backed canvas'],
  threatModel: 'tenant-is-the-adversary',
  adversary:
    'the tenant, who submits the workload and would prefer some of what it produced not to be ' +
    'witnessed',

  requiredHooks: ['graph.execute', 'artifact.produced'],
  permittedHooks: ['attach', 'detach'],
  notApplicableHooks: [
    {
      item: 'document.open',
      reason:
        'there is no document model. A request arrives, bytes are returned, and nothing is ' +
        'opened that could later be closed.',
    },
    {
      item: 'document.close',
      reason: 'as document.open: nothing is opened, so nothing closes.',
    },
    {
      item: 'document.save',
      reason:
        'nothing is saved. The unit of work is a request, and its output is delivered rather ' +
        'than persisted into a document the user returns to.',
    },
    {
      item: 'model.write',
      reason:
        'serving inference does not produce a checkpoint. A host that writes one is ALSO a ' +
        'training-host and is audited against both classes, which is the spanning rule and not ' +
        'an exception to it.',
    },
    {
      item: 'idle.tick',
      reason:
        'nothing rests between requests for a timer to notice. The tick exists to close gaps in ' +
        'time for a store, and an inference host has no store to have gaps in.',
    },
  ],

  requiredSurfaces: [],
  // The delivery path must be observed. Gate in front, or call inside.
  requiredSurfacesAnyOf: [['network-gate', 'in-process-callback']],
  permittedSurfaces: ['filesystem-watch'],
  notApplicableSurfaces: [
    {
      item: 'host-api-callback',
      reason:
        'there is no third-party host application publishing an event API across a boundary it ' +
        'enforces. The vendor\'s own server is the host, so a "host API" here would be the ' +
        'vendor handing events to themselves.',
    },
  ],

  requiredProbes: ['P-01', 'P-02', 'P-03', 'P-04', 'P-05', 'P-06', 'P-07'],
  permittedProbes: [],
  notApplicableProbes: [
    {
      item: 'P-04',
      contingentOnAbsentSurface: 'filesystem-watch',
      reason:
        'this deployment declares no filesystem surface, so there is no output volume for a ' +
        'watcher to watch or a tenant to write into. THE CANVAS CASE, EXACTLY: the Modal volume ' +
        'is not mountable into scruple-web. Absent a filesystem surface the question was not ' +
        'asked; scoring the ABSENCE of a surface as a pass would be scoring a gap as a success, ' +
        'and scoring it as a failure is what made canvas look broken for three WOs.',
    },
  ],

  applicablePItems: [...P_ITEM_IDS],
  notApplicablePItems: [],

  permittedClaim: 'Scruple-witnessed inference',
  forbiddenClaims: [
    'Scruple-witnessed authorship',
    'Scruple-witnessed training',
    'this is the complete history of the project',
  ],

  requiresCustodyLocus: false,
  incompatibleLoci: [],
};

const TRAINING_HOST: ClassDefinition = {
  id: 'training-host',
  title: 'Training host',
  installs: 'a capture position around a training run that writes checkpoints',
  exampleVendors: ['anyone hosting Kohya, torch or Diffusers'],
  threatModel: 'tenant-is-the-adversary',
  adversary:
    'the tenant, who owns the run and typically owns a shell in the container it runs in',

  requiredHooks: ['model.write'],
  permittedHooks: ['attach', 'detach', 'artifact.produced', 'idle.tick'],
  notApplicableHooks: [
    {
      item: 'graph.execute',
      reason:
        'the unit of work is a RUN, not a prompt. There is no per-request graph to fire on, and ' +
        'a hook that fired once per training job would be `attach` under another name.',
    },
    {
      item: 'document.open',
      reason: 'there is no document model; the inputs are a dataset and a config.',
    },
    {
      item: 'document.close',
      reason:
        'as document.open: a run ends, and an ending run is `detach`, not the closing of ' +
        'something a user had open.',
    },
    {
      item: 'document.save',
      reason:
        'a checkpoint is not a document save; it is `model.write`, and conflating the two is how ' +
        'a training host ends up graded as an authoring one.',
    },
  ],

  // A CHECKPOINT IS A FILE, AND THERE IS NO FAIL-CLOSED POINT (the founder's
  // parenthetical, and it is the whole reason this is a separate class).
  // Nothing has to cross a gate for the weights to exist, so the observation
  // has to be of the file itself. An in-process patch on `save_file` covers
  // only the saves that go through the function you patched, which is a
  // COVERAGE claim and not an assurance one.
  requiredSurfaces: ['filesystem-watch'],
  requiredSurfacesAnyOf: [],
  permittedSurfaces: ['network-gate', 'in-process-callback'],
  notApplicableSurfaces: [
    {
      item: 'host-api-callback',
      reason:
        'there is no host application. A trainer is a script, and a script does not publish an ' +
        'event API across a boundary it enforces.',
    },
  ],

  requiredProbes: ['P-01', 'P-02', 'P-03', 'P-04', 'P-06', 'P-07'],
  permittedProbes: [],
  notApplicableProbes: [
    {
      item: 'P-05',
      reason:
        'there is no interactive retrieval channel. Probe 5 attacks the path where output is ' +
        'delivered over a socket and never becomes a file; a checkpoint IS a file, fetched as ' +
        'one or not at all. CAPABILITY_CLASSES.md names this one directly: "Probe 5 (WebSocket ' +
        'retrieval) is meaningless for a training host."',
    },
  ],

  applicablePItems: [...P_ITEM_IDS],
  notApplicablePItems: [],

  permittedClaim: 'Scruple-witnessed training',
  forbiddenClaims: [
    'Scruple-witnessed inference',
    'Scruple-witnessed authorship',
    'every artifact this model produces is witnessed',
  ],

  requiresCustodyLocus: false,
  incompatibleLoci: [],
};

const AUTHORING_APPLICATION: ClassDefinition = {
  id: 'authoring-application',
  title: 'Authoring application',
  installs:
    'a plugin or add-in inside a host application the vendor does not run, on a machine the ' +
    'vendor does not own',
  exampleVendors: ['Fusion 360', 'Blender', 'Toon Boom', 'Adobe'],
  // THE INVERSION. Do not let inference-host assumptions leak in here.
  threatModel: 'third-party-disputes-later',
  adversary:
    'not the user — the user WANTS to be bound. The adversary is whoever disputes the claim ' +
    'later and whose argument will be "the author could have made this up."',

  requiredHooks: ['document.save', 'artifact.produced'],
  permittedHooks: ['attach', 'detach', 'document.open', 'document.close', 'idle.tick'],
  notApplicableHooks: [
    {
      item: 'graph.execute',
      reason:
        'there is no server-side graph execution. The compute is the artist\'s own machine and ' +
        'the unit of work is a document, not a prompt.',
    },
    {
      item: 'model.write',
      reason: 'no checkpoints are produced; a rendered frame is an artifact, not a model.',
    },
  ],

  requiredSurfaces: ['host-api-callback'],
  requiredSurfacesAnyOf: [],
  permittedSurfaces: ['filesystem-watch', 'in-process-callback'],
  notApplicableSurfaces: [
    {
      item: 'network-gate',
      reason:
        'there is no network chokepoint to install one on. The artist\'s application writes to ' +
        'the artist\'s disk; nothing crosses a boundary the vendor controls, and a gate would ' +
        'have to be placed on a machine the vendor does not own — where it would be ' +
        'unattested-client by construction.',
    },
  ],

  // PROBES 1, 2, 5 AND 7 ARE MEANINGLESS WHERE THERE IS NO TENANT/VENDOR SPLIT.
  // P-03 IS THE ONE OF THE FIRST THREE THAT SURVIVES THE INVERSION, and the
  // founder direction lumps it with 1 and 2. It should not be: the disputant's
  // entire case is "the author forged it", so where the signing key lives is
  // the question the class exists to answer, not one it is exempt from.
  requiredProbes: ['P-03', 'P-06'],
  permittedProbes: ['P-04'],
  notApplicableProbes: [
    {
      item: 'P-01',
      reason:
        'there is no gate to bypass. The capture position is a callback inside an application ' +
        'the vendor does not run; there is no route "around" it because there is no route ' +
        '"through" it.',
    },
    {
      item: 'P-02',
      reason:
        'there is no vendor-side component admin surface reachable from the measured party\'s ' +
        'position, because the measured party IS the operator of the machine. The provisioning ' +
        'boundary here is the account, not the network, and P-04/P-06 are where that is tested.',
    },
    {
      item: 'P-05',
      reason:
        'there is no server and no retrieval channel. The artifact is written by the host ' +
        'application to local disk; there is no socket down which it could arrive instead.',
    },
    {
      item: 'P-07',
      reason:
        'the artist\'s machine has ordinary internet access by design. There is no vendor ' +
        'network policy to measure, and a probe reporting open egress here would be reporting ' +
        'that a laptop is a laptop.',
    },
  ],

  applicablePItems: [...P_ITEM_IDS],
  notApplicablePItems: [],

  permittedClaim: 'Scruple-witnessed authorship',
  forbiddenClaims: [
    // The inversion in one line: an authoring vendor must not be able to imply
    // that a machine's behaviour was witnessed against a party who may lie.
    'Scruple-witnessed inference',
    'Scruple-witnessed training',
    'this is the complete history of the project',
    'this work contains no AI-generated content',
  ],

  requiresCustodyLocus: false,
  incompatibleLoci: [
    {
      item: 'ephemeral',
      reason:
        'a project-based application IS persistence. CUSTODY_LOCUS.md: "telling an authoring ' +
        'vendor to hold nothing at rest is telling them not to be the product they are." ' +
        '`ephemeral` fits inference; declaring it here is a category error, not a strong result.',
    },
  ],
};

const ASSET_CUSTODY: ClassDefinition = {
  id: 'asset-custody',
  title: 'Asset custody',
  installs: 'a watcher over a store of files that must stay continuous between witnessed events',
  exampleVendors: ['project folders', 'a DAM', 'an asset store'],
  threatModel: 'continuity-between-events',
  adversary:
    'nobody in particular. The question is not "who tampered" but "is what I stored still what ' +
    'I stored, and would a gap be visible as a gap."',

  // THE TICK IS REQUIRED AND IT IS THE POINT OF THE CLASS. Capture answers
  // "what happened at this moment"; custody answers "is what I stored still
  // what I stored". An event-driven watcher sees mutations it is present for;
  // the tick is what closes the interval between them.
  requiredHooks: ['document.save', 'idle.tick'],
  permittedHooks: ['attach', 'detach', 'document.open', 'document.close', 'artifact.produced'],
  notApplicableHooks: [
    {
      item: 'graph.execute',
      reason: 'nothing is executed here. A store holds files; it does not run workloads.',
    },
    {
      item: 'model.write',
      reason: 'nothing is trained here. A checkpoint arriving in the store is a document.save.',
    },
  ],

  requiredSurfaces: ['filesystem-watch'],
  requiredSurfacesAnyOf: [],
  permittedSurfaces: ['in-process-callback', 'host-api-callback'],
  notApplicableSurfaces: [
    {
      item: 'network-gate',
      reason:
        'a gate answers "did these bytes leave witnessed". Custody asks "is what I stored still ' +
        'what I stored" — a question about files at rest between events, which no observation ' +
        'of bytes in transit can answer. A store fronted by an HTTP API still resolves every ' +
        'write onto the watched volume, where the watcher sees it.',
    },
  ],

  requiredProbes: ['P-03', 'P-04', 'P-06'],
  permittedProbes: ['P-01', 'P-02', 'P-07'],
  notApplicableProbes: [
    {
      item: 'P-05',
      reason:
        'there is no interactive retrieval channel to witness. Reads out of a store are reads; ' +
        'custody is a claim about what the store CONTAINS between events, not about how it was ' +
        'handed out.',
    },
  ],

  applicablePItems: [...P_ITEM_IDS],
  notApplicablePItems: [],

  permittedClaim: 'Scruple-witnessed custody',
  forbiddenClaims: ['Scruple-witnessed inference', 'Scruple-witnessed authorship'],

  // THE CLASS THAT TURNS ON THE LOCUS. CUSTODY_LOCUS.md: "`asset-custody`
  // declares a locus the way a capture class declares a placement."
  requiresCustodyLocus: true,
  incompatibleLoci: [
    {
      item: 'ephemeral',
      reason:
        'a custody class with nothing in custody is not a member of it. `ephemeral` says nothing ' +
        'rests anywhere; this class exists to say what is true of things that do.',
    },
  ],
};

export const CLASS_DEFINITIONS: Record<CapabilityClass, ClassDefinition> = {
  'inference-host': INFERENCE_HOST,
  'training-host': TRAINING_HOST,
  'authoring-application': AUTHORING_APPLICATION,
  'asset-custody': ASSET_CUSTODY,
};

export function classDefinition(c: CapabilityClass): ClassDefinition {
  return CLASS_DEFINITIONS[c];
}

/* ────────────────────────────────────────────────────────────────────────
 * FINDINGS — TWO_PHASES.md's first-class object, at class scope.
 * ──────────────────────────────────────────────────────────────────────── */

export interface ClassFinding {
  /** Stable across releases. A report from 2027 must read against today's spec. */
  id: string;
  /**
   * TRUE when the finding means the grade is against the WRONG THING. A
   * blocking finding is not "this deployment failed an item"; it is "this
   * deployment is not a member of the class it asked to be graded as, or does
   * not meet that class's floor", and nothing computed under the wrong scope
   * is worth reporting.
   */
  blocking: boolean;
  title: string;
  detail: string;
  /** The class the evidence points to, when the evidence points to one. */
  impliedClass?: CapabilityClass;
}

export interface ClassScopeReport {
  /** What the profile said. */
  declared: readonly CapabilityClass[];
  /** What it is actually audited against. Differs when ambiguity was resolved. */
  audited: readonly CapabilityClass[];
  /** True when `audited` was widened because the declaration was absent. */
  ambiguityResolved: boolean;
  hooks: ScopedItem<CaptureHook>[];
  surfaces: ScopedItem<CaptureSurfaceKind>[];
  probes: ScopedItem<ProbeId>[];
  pItems: Record<PItemId, ScopeStatus>;
  /** Null when the profile declares no locus and no audited class requires one. */
  custody: CustodyAssurance | null;
  permittedClaims: string[];
  forbiddenClaims: string[];
  findings: ClassFinding[];
  /** Applicable probes nobody measured. Never a pass, listed so it cannot hide. */
  unmeasured: ProbeId[];
  /**
   * FALSE when a blocking finding stands. The grade's `compliant` is
   * conjoined with this: you cannot be compliant with a standard you were
   * measured against the wrong part of.
   */
  inScope: boolean;
}

/** What the caller knows about a probe run, reduced to what scope needs. */
export type ProbeVerdictMap = Partial<Record<ProbeId, 'pass' | 'fail' | 'inconclusive'>>;

export interface ScopeOptions {
  /**
   * Verdicts by probe id. A probe ABSENT from this map is `unmeasured` —
   * which is the same aggregation as `inconclusive` and is never a pass.
   * Pass `undefined` when no run is attached at all; every applicable probe is
   * then unmeasured, which is the honest reading of "nobody looked".
   */
  probeVerdicts?: ProbeVerdictMap;
  /** EFFECTIVE placement, for the custody resolution. */
  effectivePlacement?: Placement;
}

function firstReason<T extends string>(
  entries: readonly NotApplicable<T>[],
  item: T,
): NotApplicable<T> | undefined {
  return entries.find((e) => e.item === item);
}

/**
 * Grade a profile's SCOPE against its class, before anything grades its
 * evidence.
 *
 * THE UNION RULE, AND IT IS THE ANTI-GAMING RULE MADE MECHANICAL. Where a
 * profile declares two classes it is audited against BOTH: required items are
 * the UNION of the classes' requirements, and an item is not-applicable only
 * when EVERY audited class says so. A vendor cannot add a second class to
 * dilute the first, and cannot drop one to escape a requirement — dropping it
 * leaves the hook or surface in the profile, which is a finding.
 */
export function scopeProfile(
  profile: HostCaptureProfile,
  opts: ScopeOptions = {},
): ClassScopeReport {
  const findings: ClassFinding[] = [];
  const declared = profile.capabilityClasses ?? [];

  // ---- Which classes are we auditing against? -----------------------------
  let audited: readonly CapabilityClass[] = declared;
  let ambiguityResolved = false;
  if (declared.length === 0) {
    ambiguityResolved = true;
    audited = [broadestClass([])];
    findings.push({
      id: 'CF-01',
      blocking: true,
      title: 'no capability class declared',
      detail:
        'This profile names no capability class, so there is no Protection Profile to grade the ' +
        `Security Target against. CAPABILITY_CLASSES.md: "where it is ambiguous, the broader ` +
        `class applies" — so it is audited as \`${audited[0]}\`, the broadest, which is the ` +
        'incentive that keeps the rule honest. Declare the class that matches what is installed.',
      impliedClass: audited[0],
    });
  }
  const defs = audited.map(classDefinition);

  // ---- Hooks --------------------------------------------------------------
  const requiredHooks = new Set(defs.flatMap((d) => d.requiredHooks));
  const permittedHooks = new Set(defs.flatMap((d) => d.permittedHooks));
  // NOT-APPLICABLE ONLY WHEN EVERY AUDITED CLASS SAYS SO.
  const naHooks = defs
    .map((d) => new Set(d.notApplicableHooks.map((n) => n.item)))
    .reduce<Set<CaptureHook>>(
      (acc, s) => new Set([...acc].filter((h) => s.has(h))),
      new Set(defs[0]?.notApplicableHooks.map((n) => n.item) ?? []),
    );
  const declaredHooks = new Set(profile.hooks);

  const hooks: ScopedItem<CaptureHook>[] = [];
  for (const h of new Set<CaptureHook>([...requiredHooks, ...permittedHooks, ...naHooks, ...declaredHooks])) {
    if (requiredHooks.has(h)) {
      const present = declaredHooks.has(h);
      hooks.push({
        item: h,
        status: 'required',
        outcome: present ? 'satisfied' : 'failed',
        reason: present
          ? `required by ${auditedRequiring(defs, (d) => d.requiredHooks.includes(h))} and declared`
          : `required by ${auditedRequiring(defs, (d) => d.requiredHooks.includes(h))} and NOT declared`,
      });
      if (!present) {
        findings.push({
          id: 'CF-05',
          blocking: true,
          title: `required hook '${h}' is not declared`,
          detail:
            `Every member of ${audited.join(' + ')} fires \`${h}\`; this profile does not declare ` +
            'it. That is a floor the class sets, not an item this deployment failed — a member ' +
            'that cannot fire the hook is not covering what the class exists to cover.',
        });
      }
      continue;
    }
    if (naHooks.has(h)) {
      const na = defs.map((d) => firstReason(d.notApplicableHooks, h)).find(Boolean)!;
      if (declaredHooks.has(h)) {
        // THE ANTI-GAMING CHECK. The profile has a hook its own class says
        // cannot apply to it. If another class REQUIRES that hook, the profile
        // is telling us which class it is really in.
        const implied = (Object.values(CLASS_DEFINITIONS) as ClassDefinition[])
          .filter((d) => d.requiredHooks.includes(h))
          .map((d) => d.id)
          .filter((c) => !audited.includes(c));
        hooks.push({
          item: h,
          status: 'required',
          outcome: 'failed',
          voidedBy: `declared by the profile although ${audited.join(' + ')} says it cannot apply`,
          reason: `not-applicable claim VOID: the profile declares '${h}'. ${na.reason}`,
        });
        findings.push({
          id: 'CF-02',
          blocking: true,
          title: implied.length
            ? `hook '${h}' belongs to a class this profile did not declare`
            : `hook '${h}' contradicts the declared class`,
          detail:
            `\`${audited.join(' + ')}\` declares \`${h}\` not applicable — ${na.reason} — and ` +
            'the profile declares it anyway. ' +
            (implied.length
              ? `\`${h}\` is a required hook of \`${broadestClass(implied)}\`. A class may not be ` +
                'chosen to avoid a requirement that genuinely applies: a deployment spanning two ' +
                'classes is audited against both. Declare the second class, or stop firing the hook.'
              : 'One of the two is wrong. Either the profile is in a different class, or the hook ' +
                'is declared and never fires — and a hook nobody fires is a coverage claim with ' +
                'nothing behind it.'),
          ...(implied.length ? { impliedClass: broadestClass(implied) } : {}),
        });
      } else {
        hooks.push({
          item: h,
          status: 'not-applicable',
          outcome: 'not-applicable',
          reason: na.reason,
        });
      }
      continue;
    }
    hooks.push({
      item: h,
      status: 'permitted',
      outcome: declaredHooks.has(h) ? 'satisfied' : 'not-applicable',
      reason: declaredHooks.has(h)
        ? 'permitted by the class and declared by the profile'
        : 'permitted by the class and not declared; nothing turns on it',
    });
  }
  hooks.sort((a, b) => a.item.localeCompare(b.item));

  // ---- Surfaces -----------------------------------------------------------
  const declaredSurfaces = new Set(profile.surfaces);
  const requiredSurfaces = new Set(defs.flatMap((d) => d.requiredSurfaces));
  const anyOfGroups = defs.flatMap((d) => d.requiredSurfacesAnyOf);
  const anyOfMembers = new Set(anyOfGroups.flat());
  const permittedSurfaces = new Set(defs.flatMap((d) => d.permittedSurfaces));
  const naSurfaces = defs
    .map((d) => new Set(d.notApplicableSurfaces.map((n) => n.item)))
    .reduce<Set<CaptureSurfaceKind>>(
      (acc, s) => new Set([...acc].filter((x) => s.has(x))),
      new Set(defs[0]?.notApplicableSurfaces.map((n) => n.item) ?? []),
    );

  const surfaces: ScopedItem<CaptureSurfaceKind>[] = [];
  const allSurfaces = new Set<CaptureSurfaceKind>([
    ...requiredSurfaces,
    ...anyOfMembers,
    ...permittedSurfaces,
    ...naSurfaces,
    ...declaredSurfaces,
  ]);
  for (const s of allSurfaces) {
    if (requiredSurfaces.has(s)) {
      const present = declaredSurfaces.has(s);
      surfaces.push({
        item: s,
        status: 'required',
        outcome: present ? 'satisfied' : 'failed',
        reason: present
          ? `required by ${auditedRequiring(defs, (d) => d.requiredSurfaces.includes(s))} and declared`
          : `required by ${auditedRequiring(defs, (d) => d.requiredSurfaces.includes(s))} and NOT declared`,
      });
      if (!present) {
        findings.push({
          id: 'CF-05',
          blocking: true,
          title: `required surface '${s}' is not declared`,
          detail:
            `\`${audited.join(' + ')}\` requires the \`${s}\` observation position and this ` +
            'profile declares none. This is a COVERAGE floor, not an assurance one: the class ' +
            'names the position because that is where members of it leak, and a different ' +
            'position may be perfectly well placed and still not be watching that path.',
        });
      }
      continue;
    }
    if (naSurfaces.has(s)) {
      const na = defs.map((d) => firstReason(d.notApplicableSurfaces, s)).find(Boolean)!;
      if (declaredSurfaces.has(s)) {
        const implied = (Object.values(CLASS_DEFINITIONS) as ClassDefinition[])
          .filter((d) => d.requiredSurfaces.includes(s) || d.requiredSurfacesAnyOf.some((g) => g.includes(s)))
          .map((d) => d.id)
          .filter((c) => !audited.includes(c));
        surfaces.push({
          item: s,
          status: 'required',
          outcome: 'failed',
          voidedBy: `declared by the profile although ${audited.join(' + ')} says it cannot apply`,
          reason: `not-applicable claim VOID: the profile declares '${s}'. ${na.reason}`,
        });
        findings.push({
          id: 'CF-03',
          blocking: true,
          title: implied.length
            ? `surface '${s}' belongs to a class this profile did not declare`
            : `surface '${s}' contradicts the declared class`,
          detail:
            `\`${audited.join(' + ')}\` declares \`${s}\` not applicable — ${na.reason} — and the ` +
            'profile declares it anyway. ' +
            (implied.length
              ? `\`${s}\` is a required observation position of \`${broadestClass(implied)}\`. ` +
                'A deployment spanning two classes is audited against both; declare the second.'
              : 'One of the two is wrong, and a surface nobody observes through is a coverage ' +
                'claim with nothing behind it.'),
          ...(implied.length ? { impliedClass: broadestClass(implied) } : {}),
        });
      } else {
        surfaces.push({
          item: s,
          status: 'not-applicable',
          outcome: 'not-applicable',
          reason: na.reason,
        });
      }
      continue;
    }
    // A member of one or more any-of disjunctions, or plainly permitted.
    const inAnyOf = anyOfMembers.has(s);
    surfaces.push({
      item: s,
      status: inAnyOf ? 'required' : 'permitted',
      outcome: declaredSurfaces.has(s) ? 'satisfied' : inAnyOf ? 'unmeasured' : 'not-applicable',
      reason: inAnyOf
        ? declaredSurfaces.has(s)
          ? 'satisfies a required disjunction (at least one of the group must be declared)'
          : 'a member of a required disjunction that this profile does not declare; another ' +
            'member of the group may satisfy it'
        : declaredSurfaces.has(s)
          ? 'permitted by the class and declared by the profile'
          : 'permitted by the class and not declared; nothing turns on it',
    });
  }
  for (const group of anyOfGroups) {
    if (!group.some((s) => declaredSurfaces.has(s))) {
      findings.push({
        id: 'CF-05',
        blocking: true,
        title: `no observation position from {${group.join(', ')}}`,
        detail:
          `\`${audited.join(' + ')}\` requires at least one of \`${group.join('`, `')}\` — the ` +
          'delivery path has to be observed somewhere — and this profile declares none of them. ' +
          'Which one it is says nothing about assurance (surface.ts: SURFACE DOES NOT AFFECT ' +
          'ASSURANCE); having none says everything about coverage.',
      });
    }
  }
  surfaces.sort((a, b) => a.item.localeCompare(b.item));

  // ---- Probes — THE THREE-WAY DISTINCTION --------------------------------
  const requiredProbes = new Set(defs.flatMap((d) => d.requiredProbes));
  const permittedProbes = new Set(defs.flatMap((d) => d.permittedProbes));
  const verdicts = opts.probeVerdicts;
  const probes: ScopedItem<ProbeId>[] = [];
  const unmeasured: ProbeId[] = [];

  for (const id of PROBE_IDS) {
    // A not-applicable holds only when EVERY audited class declares it AND
    // the contingency (when there is one) is true of THIS profile.
    const naEntries = defs.map((d) => firstReason(d.notApplicableProbes, id));
    const everyClassSaysNa = naEntries.every(Boolean);
    let na: NotApplicable<ProbeId> | undefined;
    let voidedBy: string | undefined;
    if (everyClassSaysNa) {
      na = naEntries[0]!;
      for (const entry of naEntries as NotApplicable<ProbeId>[]) {
        if (entry.contingentOnAbsentSurface && declaredSurfaces.has(entry.contingentOnAbsentSurface)) {
          // THE DECLARATION IS CHECKED AGAINST THE PROFILE. This is the whole
          // difference between a class and the old `surfaceAbsences` hole.
          voidedBy =
            `the profile declares a '${entry.contingentOnAbsentSurface}' surface, so the class's ` +
            'not-applicable does not hold for this deployment';
          na = undefined;
          break;
        }
        na = entry;
      }
    }

    // AN OBSERVATION ALWAYS BEATS A DECLARATION, and this is the one place
    // DEFECT-2 genuinely closes rather than narrowing.
    //
    // A class declares probe 4 not applicable to a member with no filesystem
    // surface. That rests on the profile's own `surfaces` list, which is a
    // declaration — until somebody RUNS the probe. Probe 4 against a
    // deployment with no volumes returns `not-attempted`, which reads as
    // `inconclusive`; a `pass` or a `fail` means the probe found a volume to
    // write into and got an answer. Either way the run has observed something
    // the declaration says does not exist.
    //
    // Applied to unconditional not-applicables too, for the same reason: if
    // probe 5 retrieves bytes over a socket from a training host, that host
    // has an interactive retrieval channel whatever its class assumed.
    const observed = verdicts?.[id];
    if (na && !voidedBy && (observed === 'pass' || observed === 'fail')) {
      voidedBy =
        `the attached run reports '${observed}' for ${id}. The class declares it not applicable ` +
        'and the probe got an answer, so the surface it attacks exists on this deployment.';
      findings.push({
        id: 'CF-04',
        blocking: true,
        title: `${id} is declared out of scope and the run measured it anyway`,
        detail:
          `\`${audited.join(' + ')}\` declares ${id} not applicable — ${na.reason} — and the ` +
          `attached run reports '${observed}'. An observation beats a declaration: whatever ` +
          'the class assumed about members of it, this member has the surface that probe ' +
          'attacks. Re-declare the profile, or the class is wrong about this deployment.',
      });
      na = undefined;
    }

    if (na && !voidedBy) {
      probes.push({
        item: id,
        status: 'not-applicable',
        outcome: 'not-applicable',
        reason: `${probeTitle(id)} — ${na.reason}`,
      });
      continue;
    }

    const isRequired = requiredProbes.has(id) || Boolean(voidedBy);
    if (!isRequired && !permittedProbes.has(id)) {
      // Not required, not permitted, not declared n/a by every class: it is
      // required by at least one audited class through the union above, or it
      // is simply outside this class's probe set. Treat as permitted.
      probes.push({
        item: id,
        status: 'permitted',
        outcome: verdicts?.[id] === 'pass' ? 'satisfied' : 'not-applicable',
        reason: `${probeTitle(id)} — outside the required set for ${audited.join(' + ')}`,
      });
      continue;
    }

    const v = observed;
    const outcome: ItemOutcome =
      v === 'pass' ? 'satisfied' : v === 'fail' ? 'failed' : isRequired ? 'unmeasured' : 'not-applicable';
    if (outcome === 'unmeasured') unmeasured.push(id);
    probes.push({
      item: id,
      status: isRequired ? 'required' : 'permitted',
      outcome,
      ...(voidedBy ? { voidedBy } : {}),
      reason:
        `${probeTitle(id)} — ` +
        (outcome === 'satisfied'
          ? 'attacked and blocked from an admissible vantage'
          : outcome === 'failed'
            ? 'the attack succeeded, or the run says it failed'
            : 'APPLICABLE AND NOT MEASURED. Nobody looked, or the vantage could not support the ' +
              'claim. This is not a pass and never aggregates as one (WO-14).') +
        (voidedBy ? ` [${voidedBy}]` : ''),
    });
  }
  if (unmeasured.length) {
    findings.push({
      id: 'CF-08',
      // NON-BLOCKING BY DESIGN. `inScope` is about whether we are grading the
      // right thing; missing evidence is P2's business, not scope's. Recording
      // it as blocking would conflate "you are in the wrong class" with "you
      // have not run the probes yet", which is where every integration starts.
      blocking: false,
      title: `${unmeasured.length} applicable probe(s) not measured`,
      detail:
        `${unmeasured.join(', ')} are required by \`${audited.join(' + ')}\` and no admissible ` +
        'result is attached. Recorded as unmeasured, which aggregates as NOT PASSED everywhere. ' +
        'There is no configuration in which a skip becomes a pass.',
    });
  }

  // ---- P-items ------------------------------------------------------------
  const pItems = {} as Record<PItemId, ScopeStatus>;
  for (const p of P_ITEM_IDS) {
    const everyClassSaysNa = defs.every((d) => d.notApplicablePItems.some((n) => n.item === p));
    pItems[p] = everyClassSaysNa ? 'not-applicable' : 'required';
  }

  // ---- Custody ------------------------------------------------------------
  const needsLocus = defs.some((d) => d.requiresCustodyLocus);
  let custody: CustodyAssurance | null = null;
  const locus = profile.custodyLocus;
  if (!locus && needsLocus) {
    findings.push({
      id: 'CF-07',
      blocking: true,
      title: 'no custody locus declared',
      detail:
        `\`${audited.filter((c) => classDefinition(c).requiresCustodyLocus).join(', ')}\` turns on ` +
        'a custody locus the way a capture class turns on a placement, and this profile declares ' +
        'none. Without it the grade cannot say whether the vendor holds a complete history or ' +
        'witnessed moments, and those are different claims (CUSTODY_LOCUS.md).',
    });
  }
  if (locus) {
    for (const d of defs) {
      const bad = d.incompatibleLoci.find((n) => n.item === locus);
      if (bad) {
        findings.push({
          id: 'CF-06',
          blocking: true,
          title: `locus '${locus}' contradicts class '${d.id}'`,
          detail: bad.reason,
        });
      }
    }
    if (opts.effectivePlacement) {
      custody = custodyAssuranceFor(locus, opts.effectivePlacement, profile.custodyCorroborator);
      if (!custody.resolution.honoured) {
        // NON-BLOCKING, AND VISIBLE, which is the same treatment
        // `resolvePlacement` gets one axis over: an unearned declaration
        // degrades rather than failing the grade, and the degrade is printed
        // so a reader is never told a claim was honoured when it was reduced.
        findings.push({
          id: 'CF-10',
          blocking: false,
          title: `custody locus '${custody.resolution.declared}' degraded to '${custody.locus}'`,
          detail: custody.resolution.reason,
        });
      }
      if (!custody.canClaim) {
        findings.push({
          id: 'CF-09',
          blocking: false,
          title: `custody claim refused at placement '${opts.effectivePlacement}'`,
          detail: custody.reason,
        });
      }
    }
  }

  // ---- Claim wording ------------------------------------------------------
  //
  // THE PERMITTED SET IS BUILT FIRST AND THE FORBIDDEN SET IS FILTERED
  // AGAINST ALL OF IT, and the ordering is not a detail. A class forbids
  // "this is the complete history of the project" because most of its members
  // cannot say it; a `vendor-custody` locus is precisely the determination
  // that THIS member can. Filtering against the class sentences alone put
  // canvas's own custody sentence in both columns — a report that permits and
  // forbids the same words tells a vendor nothing.
  //
  // The specific determination wins over the class default in both
  // directions: a sentence one audited class forbids and another permits is
  // permitted (the vendor genuinely installed both), and a sentence the
  // custody resolution grants is permitted whatever the class default says.
  const permittedClaims = defs.map((d) => d.permittedClaim);
  if (custody?.sentence) permittedClaims.push(custody.sentence);
  const forbiddenClaims = [
    ...new Set(
      defs
        .flatMap((d) => d.forbiddenClaims)
        .concat(custody ? [...custody.mustNotImply] : [])
        .filter((c) => !permittedClaims.includes(c)),
    ),
  ];

  return {
    declared,
    audited,
    ambiguityResolved,
    hooks,
    surfaces,
    probes,
    pItems,
    custody,
    permittedClaims,
    forbiddenClaims,
    findings,
    unmeasured,
    inScope: !findings.some((f) => f.blocking),
  };
}

function auditedRequiring(
  defs: readonly ClassDefinition[],
  pred: (d: ClassDefinition) => boolean,
): string {
  return defs.filter(pred).map((d) => `\`${d.id}\``).join(' + ');
}

/* ────────────────────────────────────────────────────────────────────────
 * WHAT THIS DOES NOT CLOSE. Stated in the code, because a residual defect
 * that lives only in a document is a defect nobody re-reads.
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * DEFECT-2, NARROWED AND NOT CLOSED.
 *
 * A class turns "this surface is absent" from an unchecked declaration in the
 * evidence (`surfaceAbsences`, accepted on a cite the grader could not verify)
 * into a declaration CHECKED AGAINST THE PROFILE'S OWN SURFACE LIST. Probe 4
 * is not applicable to an inference host that declares no `filesystem-watch`,
 * and it becomes applicable the instant one is declared.
 *
 * THE RESIDUE. `profile.surfaces` is still a declaration. A vendor who has a
 * filesystem egress path and does not list it gets probe 4 scored
 * not-applicable, exactly as they used to get it scored away by
 * `surfaceAbsences`. What changed is the COST of the lie, not its
 * availability:
 *
 *   * the same list decides their required-surface check, so omitting a
 *     surface can put them below their class's floor;
 *   * the same list decides which class they are in, so omitting one can
 *     trigger CF-02/CF-03 against a class they did not declare;
 *   * the same list is what the permitted claim wording is computed from.
 *
 * A declaration that is load-bearing in four places is harder to shade than
 * one that is load-bearing in a footnote. That is a narrowing, and it is the
 * third narrowing DEFECT-2 has had. Only an observation from the tenant
 * position closes it: nothing a vendor writes down can prove what a vendor did
 * not write down.
 */
export function residualDefect2(): string {
  return (
    'A class checks not-applicable against the profile\'s own surface list rather than against ' +
    'an unchecked evidence declaration. The list is still a declaration; what changed is that it ' +
    'is now load-bearing for the class floor, the class identity and the claim wording as well, ' +
    'so shading it costs something. Closing DEFECT-2 outright still requires an observation from ' +
    'the tenant position — nothing a vendor writes down can prove what a vendor did not write down.'
  );
}
