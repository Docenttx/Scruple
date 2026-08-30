// The `scruple-vendor-baseline` predicate — P1–P8 posture, versioned on its
// own, carried inside a statement that does not know what it says.
//
// SCHEMA AND RATIONALE: docs/canon/PREDICATE_scruple-vendor-baseline.md
//
// ── EVERY NAME IN HERE IS SOMEONE ELSE'S ────────────────────────────────
//
// This file defines a payload, not a vocabulary. Placement, enforcement,
// surface, fidelity and attestation outcome are lib/capture/surface.ts's,
// imported rather than restated, and their meanings are
// docs/canon/PLACEMENT_AND_SURFACES.md's. The properties are P1–P8 from
// docs/architecture/SCRUPLE_INTEGRATION_REQUIREMENTS_v1.md §2. Component
// identity is migration 041's `components` columns, spelled the way the
// table spells them.
//
// If a second set of names ever starts growing here, that is the bug WO-2
// exists to prevent, and the right move is to delete the new names rather
// than reconcile them.
//
// ── P1 AND P3 ARE DERIVED, NOT DECLARED ─────────────────────────────────
//
// PLACEMENT_AND_SURFACES.md §5 is explicit that assurance is a pure
// function of effective placement and attestation outcome, and DEFECT-1
// records what happens without that: a host that declares its own tier
// grades itself. So a predicate does not get to state its own P1, P3,
// `can_claim` or leaf status — `buildVendorBaselinePredicate()` computes
// them and `validateVendorBaselinePredicate()` recomputes them and refuses
// a predicate whose stated posture is better (or worse) than its own axes
// yield. A forged posture is a schema error, not a judgement call.
//
// The other six properties ARE declarations. P2 (baseline covers the whole
// capture path), P4 (principal identity), P5 (immutable chain), P6 (zero
// content), P7 (attestation declared), P8 (import discipline) are facts
// about an integration's code that no function of two enums can decide.
// They are declared here so a self-grade harness (WO-9) has something to
// contradict, and DEFECT-2 is the standing reminder that a well-formed
// declaration is what to probe, never evidence that probing would pass.

import {
  PLACEMENTS,
  PLACEMENT_ENFORCEMENTS,
  CAPTURE_SURFACES,
  CAPTURE_HOOKS,
  OBSERVATION_FIDELITIES,
  ATTESTATION_OUTCOMES,
  resolvePlacement,
  assuranceFor,
  type Placement,
  type PlacementEnforcement,
  type CaptureSurfaceKind,
  type CaptureHook,
  type ObservationFidelity,
  type AttestationOutcome,
  type AttestationStatus,
  type PropertyDisposition,
} from '@/lib/capture/surface';

/* ── versioning ───────────────────────────────────────────────────────── */

export const VENDOR_BASELINE_PREDICATE_BASE =
  'https://scruple.ai/attestation/vendor-baseline/';

/** Bump this and nothing in pae.ts, dsse.ts or statement.ts changes. */
export const VENDOR_BASELINE_PREDICATE_VERSION = 1;

export function vendorBaselinePredicateType(
  version: number = VENDOR_BASELINE_PREDICATE_VERSION,
): string {
  return `${VENDOR_BASELINE_PREDICATE_BASE}v${version}`;
}

/* ── attestation provider — P7's axis, which is not the outcome axis ──── */

/**
 * `attestation.provider` from P7. Naming what hardware the compute offers.
 *
 * THIS IS NOT `AttestationOutcome`. P7's provider says which attestation
 * subsystem exists; PLACEMENT_AND_SURFACES.md §5's outcome says what
 * happened when H-5 tried to verify one. Both spell their empty case
 * 'none' and they mean different things — provider 'none' is "this compute
 * offers no hardware attestation, and P8 is not applicable"; outcome 'none'
 * is "this leaf carries no envelope". A configuration on SEV-SNP hardware
 * whose leaves carry nothing is provider 'amd-sev-snp' with outcome 'none',
 * and that combination is a P8 failure that the validator below catches.
 * Collapsing the two axes into one field would make it invisible.
 *
 * The list is the one Scruple maintains a built-in verifier for (§4.1 /
 * P8), plus 'none'. Any other string is permitted and requires a
 * `verifier_reference`, which is P8's passthrough rule verbatim.
 */
export const BUILTIN_ATTESTATION_PROVIDERS = [
  'none',
  'amd-sev-snp',
  'intel-tdx',
  'aws-nitro-enclave',
  'gcp-confidential-space',
  'azure-attestation-service',
  'nvidia-h100-cc',
  'tpm-2.0-quote',
] as const;

export type AttestationProvider = (typeof BUILTIN_ATTESTATION_PROVIDERS)[number] | string;

/* ── the predicate ────────────────────────────────────────────────────── */

/** Migration 041 `components`, spelled as that table spells it. */
export interface ComponentIdentity {
  component_id: string;
  tenant_id: string;
  /** 'sha256:...' of the published image. NULL until the component declares one. */
  build_measurement: string | null;
}

/** One declared observation position. lib/capture/surface.ts's CaptureSurface, as data. */
export interface DeclaredSurface {
  /** The surface's stable id, e.g. "comfyui-http-gate". */
  name: string;
  surface: CaptureSurfaceKind;
  fidelity: ObservationFidelity;
  hooks: CaptureHook[];
  /**
   * Required when fidelity is 'induced'. DEFECT-3's consequence: a surface
   * that manufactures a serialization, hashes it and deletes it emits a
   * leaf only Scruple can ever read.
   */
  induced_artifact_ref?: string;
}

/** P2, P4, P5, P6, P7, P8 — the six that cannot be computed. */
export interface DeclaredProperties {
  p2: PropertyDisposition;
  p4: PropertyDisposition;
  p5: PropertyDisposition;
  p6: PropertyDisposition;
  p7: PropertyDisposition;
  p8: PropertyDisposition;
}

export interface VendorBaselinePredicate {
  /** Mirrors the version in the predicateType URI. Belt and braces, on purpose. */
  predicate_version: number;
  component: ComponentIdentity;
  placement: {
    declared: Placement;
    enforcement: PlacementEnforcement;
    /** DERIVED by resolvePlacement(). Never a declaration. */
    effective: Placement;
    honoured: boolean;
    reason: string;
  };
  attestation: {
    provider: AttestationProvider;
    /** P7's "stable reference to the attestation". Null when provider is 'none'. */
    quote_ref: string | null;
    /** P8: required when `provider` is outside BUILTIN_ATTESTATION_PROVIDERS. */
    verifier_reference?: string;
    outcome: AttestationOutcome;
  };
  surfaces: DeclaredSurface[];
  properties: DeclaredProperties & {
    /** DERIVED from (effective placement, outcome). */
    p1: PropertyDisposition;
    /** DERIVED from (effective placement, outcome). */
    p3: PropertyDisposition;
  };
  /** DERIVED. null means NO LEAF MAY BE ISSUED for this configuration. */
  leaf_status: AttestationStatus | null;
  /** DERIVED. False at unattested-client, whatever else is true. */
  can_claim: boolean;
  /** DERIVED. What must be evidenced for each 'conditional' above. */
  conditions: string[];
}

export interface VendorBaselineInput {
  component: ComponentIdentity;
  declared_placement: Placement;
  enforcement: PlacementEnforcement;
  attestation: {
    provider: AttestationProvider;
    quote_ref?: string | null;
    verifier_reference?: string;
    outcome: AttestationOutcome;
  };
  surfaces: DeclaredSurface[];
  declared_properties: DeclaredProperties;
}

export class PredicateError extends Error {}

/**
 * Build a predicate, deriving everything that is derivable.
 *
 * The caller supplies axes and declarations. It cannot supply a posture.
 */
export function buildVendorBaselinePredicate(
  input: VendorBaselineInput,
  version: number = VENDOR_BASELINE_PREDICATE_VERSION,
): VendorBaselinePredicate {
  const resolution = resolvePlacement(input.declared_placement, input.enforcement);
  const assurance = assuranceFor(resolution.effective, input.attestation.outcome);

  const predicate: VendorBaselinePredicate = {
    predicate_version: version,
    component: input.component,
    placement: {
      declared: resolution.declared,
      enforcement: resolution.enforcement,
      effective: resolution.effective,
      honoured: resolution.honoured,
      reason: resolution.reason,
    },
    attestation: {
      provider: input.attestation.provider,
      quote_ref: input.attestation.quote_ref ?? null,
      outcome: input.attestation.outcome,
    },
    surfaces: input.surfaces,
    properties: { ...input.declared_properties, p1: assurance.p1, p3: assurance.p3 },
    leaf_status: assurance.leaf,
    can_claim: assurance.canClaim,
    conditions: assurance.conditions,
  };
  if (input.attestation.verifier_reference !== undefined) {
    predicate.attestation.verifier_reference = input.attestation.verifier_reference;
  }
  return predicate;
}

/**
 * Check a predicate that arrived from somewhere else.
 *
 * Returns every problem rather than the first, because a producer fixing a
 * baseline wants the list. An empty array means valid — including the
 * `unattested-client` case, which is VALID AND REFUSED: §4.1 of
 * PLACEMENT_AND_SURFACES.md exists so the standard can say no to a shape
 * rather than fail to describe it, so a predicate whose `can_claim` is
 * false is well-formed and must not be a schema error.
 */
export function validateVendorBaselinePredicate(value: unknown): string[] {
  const errs: string[] = [];
  const p = value as VendorBaselinePredicate;

  if (!p || typeof p !== 'object' || Array.isArray(p)) return ['predicate must be a JSON object'];

  if (typeof p.predicate_version !== 'number' || !Number.isInteger(p.predicate_version)) {
    errs.push('predicate_version must be an integer');
  }

  // component identity
  const c = p.component;
  if (!c || typeof c !== 'object') {
    errs.push('component is required');
  } else {
    if (typeof c.component_id !== 'string' || !c.component_id) {
      errs.push('component.component_id is required — it is the HKDF salt for the IK, not a label');
    }
    if (typeof c.tenant_id !== 'string' || !c.tenant_id) errs.push('component.tenant_id is required');
    if (c.build_measurement !== null && typeof c.build_measurement !== 'string') {
      errs.push('component.build_measurement must be a string or null');
    }
  }

  // placement axes
  const pl = p.placement;
  if (!pl || typeof pl !== 'object') {
    errs.push('placement is required');
  } else {
    if (!(PLACEMENTS as readonly string[]).includes(pl.declared)) {
      errs.push(`placement.declared must be one of ${PLACEMENTS.join(', ')}`);
    }
    if (!(PLACEMENT_ENFORCEMENTS as readonly string[]).includes(pl.enforcement)) {
      errs.push(`placement.enforcement must be one of ${PLACEMENT_ENFORCEMENTS.join(', ')}`);
    }
    if (!errs.length) {
      const r = resolvePlacement(pl.declared, pl.enforcement);
      if (pl.effective !== r.effective) {
        errs.push(
          `placement.effective is declared '${pl.effective}' but ` +
            `resolvePlacement('${pl.declared}', '${pl.enforcement}') yields '${r.effective}'. ` +
            'Effective placement is derived; a self-declared one is DEFECT-1 reopened.',
        );
      }
      if (pl.honoured !== r.honoured) errs.push('placement.honoured disagrees with resolvePlacement()');
    }
  }

  // attestation — two axes, checked against each other (P7 x P8)
  const at = p.attestation;
  if (!at || typeof at !== 'object') {
    errs.push('attestation is required');
  } else {
    if (typeof at.provider !== 'string' || !at.provider) {
      errs.push("attestation.provider is required ('none' when the compute offers none)");
    }
    if (!(ATTESTATION_OUTCOMES as readonly string[]).includes(at.outcome)) {
      errs.push(`attestation.outcome must be one of ${ATTESTATION_OUTCOMES.join(', ')}`);
    }
    const builtin = (BUILTIN_ATTESTATION_PROVIDERS as readonly string[]).includes(at.provider);
    if (!builtin && !at.verifier_reference) {
      errs.push(
        `attestation.provider '${at.provider}' has no built-in verifier, so P8 requires a ` +
          'verifier_reference naming an independent verifier the customer trusts.',
      );
    }
    if (at.provider === 'none' && at.outcome !== 'none') {
      errs.push(
        "attestation.provider is 'none' (P7: no hardware attestation, P8 not applicable) but " +
          `outcome is '${at.outcome}'. A leaf cannot carry an envelope from a subsystem the baseline says does not exist.`,
      );
    }
    if (at.provider !== 'none' && at.outcome === 'none') {
      errs.push(
        `attestation.provider is '${at.provider}', so P8 requires EVERY leaf to carry a ` +
          'platform_attestation envelope; outcome \'none\' means none do.',
      );
    }
    if (at.provider === 'none' && at.quote_ref) {
      errs.push("attestation.quote_ref is set but provider is 'none'");
    }
  }

  // surfaces
  if (!Array.isArray(p.surfaces) || p.surfaces.length === 0) {
    errs.push('surfaces must name at least one observation position — a baseline claiming none observes nothing');
  } else {
    p.surfaces.forEach((s, i) => {
      if (typeof s?.name !== 'string' || !s.name) errs.push(`surfaces[${i}].name is required`);
      if (!(CAPTURE_SURFACES as readonly string[]).includes(s?.surface)) {
        errs.push(`surfaces[${i}].surface must be one of ${CAPTURE_SURFACES.join(', ')}`);
      }
      if (!(OBSERVATION_FIDELITIES as readonly string[]).includes(s?.fidelity)) {
        errs.push(`surfaces[${i}].fidelity must be one of ${OBSERVATION_FIDELITIES.join(', ')}`);
      }
      if (!Array.isArray(s?.hooks) || s.hooks.length === 0) {
        errs.push(`surfaces[${i}].hooks must name at least one hook`);
      } else {
        for (const h of s.hooks) {
          if (!(CAPTURE_HOOKS as readonly string[]).includes(h)) {
            errs.push(`surfaces[${i}] declares unknown hook '${h}'`);
          }
        }
      }
      if (s?.fidelity === 'induced' && !s.induced_artifact_ref) {
        errs.push(
          `surfaces[${i}] is 'induced' fidelity with no induced_artifact_ref. The hashed ` +
            'serialization has to be obtainable again or the leaf is evidence only Scruple can read.',
        );
      }
    });
  }

  // properties — six declared, two derived
  const pr = p.properties;
  if (!pr || typeof pr !== 'object') {
    errs.push('properties is required');
  } else {
    for (const k of ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'] as const) {
      const v = (pr as unknown as Record<string, unknown>)[k];
      if (v !== 'holds' && v !== 'conditional' && v !== 'fails') {
        errs.push(`properties.${k} must be holds | conditional | fails`);
      }
    }
  }

  // the derived block, recomputed
  if (pl && at && pr && errs.length === 0) {
    const a = assuranceFor(pl.effective, at.outcome);
    if (pr.p1 !== a.p1) errs.push(`properties.p1 says '${pr.p1}'; the assurance function says '${a.p1}'`);
    if (pr.p3 !== a.p3) errs.push(`properties.p3 says '${pr.p3}'; the assurance function says '${a.p3}'`);
    if (p.can_claim !== a.canClaim) {
      errs.push(`can_claim says ${p.can_claim}; the assurance function says ${a.canClaim}`);
    }
    if (p.leaf_status !== a.leaf) {
      errs.push(`leaf_status says '${String(p.leaf_status)}'; the assurance function says '${String(a.leaf)}'`);
    }
  }

  return errs;
}

/**
 * JSON Schema for the predicate, emitted from the same enums the validator
 * uses so the two cannot describe different documents.
 *
 * Published for third parties. It is deliberately weaker than
 * `validateVendorBaselinePredicate()`: JSON Schema can state the shape and
 * the enums, and it cannot state "p1 equals assuranceFor(effective,
 * outcome)". Anything cross-field lives in the validator, and this schema
 * says so in its own description rather than letting a consumer conclude
 * schema-valid means sound.
 */
export function vendorBaselinePredicateSchema(
  version: number = VENDOR_BASELINE_PREDICATE_VERSION,
): Record<string, unknown> {
  const disposition = { type: 'string', enum: ['holds', 'conditional', 'fails'] };
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: vendorBaselinePredicateType(version),
    title: 'scruple-vendor-baseline',
    description:
      'P1-P8 posture for one Scruple integration CONFIGURATION (not one vendor). ' +
      'Shape only: the cross-field rules — effective placement derived from ' +
      '(declared, enforcement), p1/p3/can_claim/leaf_status derived from ' +
      '(effective, outcome), and the P7/P8 provider-outcome agreement — are not ' +
      'expressible here and are enforced by validateVendorBaselinePredicate(). ' +
      'Schema-valid does not mean sound.',
    type: 'object',
    additionalProperties: false,
    required: [
      'predicate_version',
      'component',
      'placement',
      'attestation',
      'surfaces',
      'properties',
      'leaf_status',
      'can_claim',
      'conditions',
    ],
    properties: {
      predicate_version: { type: 'integer', const: version },
      component: {
        type: 'object',
        additionalProperties: false,
        required: ['component_id', 'tenant_id', 'build_measurement'],
        properties: {
          component_id: { type: 'string', minLength: 1 },
          tenant_id: { type: 'string', minLength: 1 },
          build_measurement: { type: ['string', 'null'] },
        },
      },
      placement: {
        type: 'object',
        additionalProperties: false,
        required: ['declared', 'enforcement', 'effective', 'honoured', 'reason'],
        properties: {
          declared: { type: 'string', enum: [...PLACEMENTS] },
          enforcement: { type: 'string', enum: [...PLACEMENT_ENFORCEMENTS] },
          effective: { type: 'string', enum: [...PLACEMENTS] },
          honoured: { type: 'boolean' },
          reason: { type: 'string' },
        },
      },
      attestation: {
        type: 'object',
        additionalProperties: false,
        required: ['provider', 'quote_ref', 'outcome'],
        properties: {
          provider: { type: 'string', minLength: 1 },
          quote_ref: { type: ['string', 'null'] },
          verifier_reference: { type: 'string' },
          outcome: { type: 'string', enum: [...ATTESTATION_OUTCOMES] },
        },
      },
      surfaces: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'surface', 'fidelity', 'hooks'],
          properties: {
            name: { type: 'string', minLength: 1 },
            surface: { type: 'string', enum: [...CAPTURE_SURFACES] },
            fidelity: { type: 'string', enum: [...OBSERVATION_FIDELITIES] },
            hooks: {
              type: 'array',
              minItems: 1,
              items: { type: 'string', enum: [...CAPTURE_HOOKS] },
            },
            induced_artifact_ref: { type: 'string' },
          },
        },
      },
      properties: {
        type: 'object',
        additionalProperties: false,
        required: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'],
        properties: {
          p1: disposition,
          p2: disposition,
          p3: disposition,
          p4: disposition,
          p5: disposition,
          p6: disposition,
          p7: disposition,
          p8: disposition,
        },
      },
      leaf_status: { type: ['string', 'null'], enum: ['verified', 'passthrough', null] },
      can_claim: { type: 'boolean' },
      conditions: { type: 'array', items: { type: 'string' } },
    },
  };
}
