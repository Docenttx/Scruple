// Generate test/vectors/vendor-baseline-predicate-vectors.json.
//
//   node --import tsx scripts/gen-predicate-vectors.mjs
//   npm run gen:predicate-vectors
//
// WHY THIS FILE EXISTS. WO-2 implemented the `scruple-vendor-baseline`
// predicate in TypeScript (lib/envelope/predicate.ts). WO-6's
// `server-library` placement runs in a vendor's PYTHON backend and needs
// the same predicate, which means a second implementation
// (packages/scruple-host-sdk/scruple_host_sdk/envelope.py) — and two
// implementations that each pass their own tests and disagree on the wire
// is the exact failure test/vectors/ratchet-vectors.json exists to prevent
// for the key schedule. This is that file, for the predicate.
//
// WHAT IS PINNED, AND WHY EACH
//
//   enums            The vocabulary. If Python grows a value TypeScript
//                    does not have, a parallel vocabulary has started and
//                    the predicate doc says the fix is to delete the new
//                    name, not reconcile it.
//   schema           The published JSON Schema, emitted from those same
//                    constants. A third party reads this.
//   assurance_table  All 12 (placement, attestation) cells, including the
//                    four that say NO LEAF MAY BE ISSUED. An assurance
//                    function that agrees on the happy path and disagrees
//                    on the refusals is worse than one that disagrees
//                    everywhere, because only the refusals are load-bearing.
//   cases            build/validate cases with the exact error strings,
//                    so the two validators refuse the same documents for
//                    the same stated reasons.
//
// TypeScript is the generator and Python is the checker, matching the
// direction of the ratchet vectors (Python generated those; TypeScript
// checks them). Neither language gets to be right about both.

import fs from 'node:fs';
import path from 'node:path';
import {
  PLACEMENTS,
  PLACEMENT_ENFORCEMENTS,
  CAPTURE_SURFACES,
  CAPTURE_HOOKS,
  OBSERVATION_FIDELITIES,
  ATTESTATION_OUTCOMES,
  assuranceFor,
  resolvePlacement,
} from '../lib/capture/surface.ts';
import {
  BUILTIN_ATTESTATION_PROVIDERS,
  VENDOR_BASELINE_PREDICATE_VERSION,
  buildVendorBaselinePredicate,
  validateVendorBaselinePredicate,
  vendorBaselinePredicateSchema,
  vendorBaselinePredicateType,
} from '../lib/envelope/predicate.ts';

const OUT = path.join(process.cwd(), 'test', 'vectors', 'vendor-baseline-predicate-vectors.json');

const COMPONENT = {
  component_id: '0b0c9f4a-7e21-4b0d-9a3e-2c5d8f1a6b74',
  tenant_id: 'vendor-acme',
  build_measurement: 'sha256:' + 'ab'.repeat(32),
};

const SERVER_LIBRARY_SURFACE = {
  name: 'server-library-inference-handler',
  surface: 'in-process-callback',
  fidelity: 'as-delivered',
  hooks: ['graph.execute', 'artifact.produced'],
};

const DECLARED = { p2: 'conditional', p4: 'conditional', p5: 'conditional', p6: 'conditional', p7: 'conditional', p8: 'conditional' };

/** Every build case: input in, whole predicate out. */
const buildCases = [
  {
    name: 'server-library, no attestation — the honest tier',
    note:
      'PLACEMENT_AND_SURFACES.md §5.2, top-right cell. P1 is free here and it buys NOTHING ' +
      'toward a verified leaf; only a root-chained attestation does, and no verifier plugin ' +
      'in the estate can produce one. A reference integration on non-attestable compute can ' +
      'therefore only ever demonstrate its second-strongest tier, and it must say so.',
    input: {
      component: COMPONENT,
      declared_placement: 'server-library',
      enforcement: 'no-tenant-code',
      attestation: { provider: 'none', outcome: 'none' },
      surfaces: [SERVER_LIBRARY_SURFACE],
      declared_properties: DECLARED,
    },
  },
  {
    name: 'server-library on attestable compute — verified',
    input: {
      component: COMPONENT,
      declared_placement: 'server-library',
      enforcement: 'no-tenant-code',
      attestation: { provider: 'amd-sev-snp', quote_ref: 'quote://surrogate/1', outcome: 'verified' },
      surfaces: [SERVER_LIBRARY_SURFACE],
      declared_properties: DECLARED,
    },
  },
  {
    name: 'server-library with a custom-handler feature — resolves to unattested-client',
    note:
      'PLACEMENT_AND_SURFACES.md §7.3, the single most commercially important line in that ' +
      'document. trust_remote_code, a custom handler.py or a customer-supplied image all mean ' +
      'tenant code runs in the capture process. A vendor is not a placement; a CONFIGURATION ' +
      'is, and this one may issue no leaf at all.',
    input: {
      component: COMPONENT,
      declared_placement: 'server-library',
      enforcement: 'none',
      attestation: { provider: 'none', outcome: 'none' },
      surfaces: [SERVER_LIBRARY_SURFACE],
      declared_properties: DECLARED,
    },
  },
  {
    name: 'browser JS holding a genuine root-verified quote — still refused',
    note:
      '§7.6, pinned deliberately because it is the case an implementer would be tempted to ' +
      '"improve". A page can relay a real SEV-SNP quote from a server it does not run; that ' +
      'quote proves something about a machine and nothing about the capture.',
    input: {
      component: COMPONENT,
      declared_placement: 'unattested-client',
      enforcement: 'none',
      attestation: { provider: 'amd-sev-snp', quote_ref: 'quote://relayed', outcome: 'verified' },
      surfaces: [{ name: 'browser-js', surface: 'in-process-callback', fidelity: 'as-delivered', hooks: ['document.save'] }],
      declared_properties: DECLARED,
    },
  },
  {
    name: 'sidecar-gate, passthrough — the ComfyUI shape',
    input: {
      component: COMPONENT,
      declared_placement: 'sidecar-gate',
      enforcement: 'isolated-namespace',
      attestation: { provider: 'tpm-2.0-quote', quote_ref: 'quote://tpm/1', outcome: 'passthrough' },
      surfaces: [
        { name: 'comfyui-http-gate', surface: 'network-gate', fidelity: 'as-delivered', hooks: ['graph.execute'] },
        { name: 'comfyui-output-watch', surface: 'filesystem-watch', fidelity: 'as-written', hooks: ['artifact.produced'] },
      ],
      declared_properties: DECLARED,
    },
  },
];

/** Validation cases: a mutation applied to a built predicate, and the errors it must produce. */
const base = buildVendorBaselinePredicate(buildCases[0].input);
const mutate = (fn) => {
  const p = JSON.parse(JSON.stringify(base));
  fn(p);
  return p;
};

const validateCases = [
  { name: 'a well-formed predicate has no errors', predicate: base },
  {
    name: 'unattested-client is VALID and refused, never a schema error',
    note: '§4.2 — making it a schema error would delete the refusal.',
    predicate: buildVendorBaselinePredicate(buildCases[3].input),
  },
  {
    name: 'a self-declared effective placement is DEFECT-1 reopened',
    predicate: mutate((p) => {
      p.placement.declared = 'server-library';
      p.placement.enforcement = 'none';
    }),
  },
  {
    name: 'a forged p1 disagrees with the assurance function',
    predicate: mutate((p) => {
      p.properties.p1 = 'fails';
    }),
  },
  {
    name: 'a forged can_claim disagrees with the assurance function',
    predicate: mutate((p) => {
      p.can_claim = false;
    }),
  },
  {
    name: "provider 'none' with a non-none outcome — the §5.1 collision",
    predicate: mutate((p) => {
      p.attestation.outcome = 'passthrough';
    }),
  },
  {
    name: 'a real provider whose leaves carry nothing is a P8 failure',
    predicate: mutate((p) => {
      p.attestation.provider = 'amd-sev-snp';
    }),
  },
  {
    name: 'an unknown provider with no verifier_reference fails P8',
    predicate: mutate((p) => {
      p.attestation.provider = 'acme-secure-enclave';
      p.attestation.outcome = 'passthrough';
    }),
  },
  {
    name: 'induced fidelity with no induced_artifact_ref',
    predicate: mutate((p) => {
      p.surfaces[0].fidelity = 'induced';
    }),
  },
  {
    name: 'a baseline claiming no surfaces observes nothing',
    predicate: mutate((p) => {
      p.surfaces = [];
    }),
  },
  {
    name: 'an unknown hook is refused',
    predicate: mutate((p) => {
      p.surfaces[0].hooks = ['stream.complete'];
    }),
  },
];

const doc = {
  $schema_note:
    'Shared cross-language vectors for the scruple-vendor-baseline predicate. Generated from ' +
    'lib/envelope/predicate.ts and lib/capture/surface.ts; consumed by test/v2/predicate-vectors.test.ts ' +
    '(which regenerates and asserts this file is current) and by ' +
    'packages/scruple-host-sdk/tests/test_server_library.py (which checks the Python implementation ' +
    'against it). Regenerate with `npm run gen:predicate-vectors`.',
  spec: 'docs/canon/PREDICATE_scruple-vendor-baseline.md',
  generated_by: 'scripts/gen-predicate-vectors.mjs',
  predicate_version: VENDOR_BASELINE_PREDICATE_VERSION,
  predicate_type: vendorBaselinePredicateType(),
  enums: {
    placements: [...PLACEMENTS],
    placement_enforcements: [...PLACEMENT_ENFORCEMENTS],
    capture_surfaces: [...CAPTURE_SURFACES],
    capture_hooks: [...CAPTURE_HOOKS],
    observation_fidelities: [...OBSERVATION_FIDELITIES],
    attestation_outcomes: [...ATTESTATION_OUTCOMES],
    property_dispositions: ['holds', 'conditional', 'fails'],
    builtin_attestation_providers: [...BUILTIN_ATTESTATION_PROVIDERS],
  },
  schema: vendorBaselinePredicateSchema(),
  placement_resolution: PLACEMENTS.flatMap((declared) =>
    PLACEMENT_ENFORCEMENTS.map((enforcement) => {
      const r = resolvePlacement(declared, enforcement);
      return { declared, enforcement, effective: r.effective, honoured: r.honoured };
    }),
  ),
  assurance_table: PLACEMENTS.flatMap((p) =>
    ATTESTATION_OUTCOMES.map((a) => {
      const x = assuranceFor(p, a);
      return { placement: p, attestation: a, p1: x.p1, p3: x.p3, leaf: x.leaf, can_claim: x.canClaim, conditions: x.conditions };
    }),
  ),
  build_cases: buildCases.map((c) => ({
    name: c.name,
    ...(c.note ? { note: c.note } : {}),
    input: c.input,
    predicate: buildVendorBaselinePredicate(c.input),
  })),
  validate_cases: validateCases.map((c) => ({
    name: c.name,
    ...(c.note ? { note: c.note } : {}),
    predicate: c.predicate,
    errors: validateVendorBaselinePredicate(c.predicate),
  })),
};

fs.writeFileSync(OUT, JSON.stringify(doc, null, 2) + '\n');
console.log(`[gen] wrote ${OUT}`);
