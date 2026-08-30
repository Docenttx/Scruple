// Placement and surface axes — CANON_SKELETON.md §4, PLACEMENT_AND_SURFACES.md.
//
// PURE LOGIC. This file opens no database, reads no environment, and makes no
// network call. Do not add one — the point of the assurance function is that
// it depends on placement and attestation and nothing else, and a test that
// needed a DB would be evidence it had grown a dependency it must not have.
//
// Three things are pinned here:
//   1. the assurance function is TOTAL — every placement x attestation resolves
//   2. `unattested-client` NEVER yields a compliant result, not even holding a
//      genuine root-verified attestation
//   3. the six mapped hosts each resolve to the tier PLACEMENT_AND_SURFACES.md
//      §7.7 claims for them

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  PLACEMENTS,
  PLACEMENT_ENFORCEMENTS,
  ATTESTATION_OUTCOMES,
  CAPTURE_HOOKS,
  CAPTURE_SURFACES,
  OBSERVATION_FIDELITIES,
  CANON_HOST_PROFILES,
  assuranceFor,
  assuranceForHost,
  allAssuranceCells,
  resolvePlacement,
  attestationOutcomeOf,
  registerCaptureSurface,
  registeredSurfaces,
  _resetSurfaceRegistryForTests,
  type Placement,
  type AttestationOutcome,
  type CaptureSurface,
} from '../../lib/capture/surface';

describe('the assurance function is total', () => {
  test('every placement x attestation combination resolves', () => {
    const cells = allAssuranceCells();
    assert.equal(cells.length, PLACEMENTS.length * ATTESTATION_OUTCOMES.length);
    assert.equal(cells.length, 12);

    for (const c of cells) {
      // No undefined dispositions, no thrown branches, no default fall-through.
      assert.ok(['holds', 'conditional', 'fails'].includes(c.p1), `p1 ${c.placement}/${c.attestation}`);
      assert.ok(['holds', 'conditional', 'fails'].includes(c.p3), `p3 ${c.placement}/${c.attestation}`);
      assert.ok(c.leaf === 'verified' || c.leaf === 'passthrough' || c.leaf === null);
      assert.equal(typeof c.canClaim, 'boolean');
      assert.ok(c.reason.length > 0, 'every cell explains itself');
    }

    // Every pair is present exactly once.
    const seen = new Set(cells.map((c) => `${c.placement}|${c.attestation}`));
    assert.equal(seen.size, 12);
  });

  test('it is a pure function — same inputs, same output, no hidden state', () => {
    for (const p of PLACEMENTS) {
      for (const a of ATTESTATION_OUTCOMES) {
        assert.deepEqual(assuranceFor(p, a), assuranceFor(p, a));
      }
    }
  });

  test('a conditional disposition always names its conditions', () => {
    for (const c of allAssuranceCells()) {
      if (c.p1 === 'conditional' || c.p3 === 'conditional') {
        assert.ok(
          c.conditions.length > 0,
          `${c.placement}/${c.attestation} is conditional on nothing stated`,
        );
      }
    }
  });

  test('placement resolution is total over 4 placements x 4 enforcements', () => {
    let n = 0;
    for (const declared of PLACEMENTS) {
      for (const enforcement of PLACEMENT_ENFORCEMENTS) {
        const r = resolvePlacement(declared, enforcement);
        assert.ok(PLACEMENTS.includes(r.effective));
        assert.equal(typeof r.honoured, 'boolean');
        assert.ok(r.reason.length > 0);
        // An unhonoured declaration NEVER lands on an intermediate tier.
        if (!r.honoured) assert.equal(r.effective, 'unattested-client');
        n++;
      }
    }
    assert.equal(n, 16);
  });
});

describe('unattested-client is never compliant', () => {
  test('no attestation outcome lifts it — including a root-verified one', () => {
    for (const a of ATTESTATION_OUTCOMES) {
      const r = assuranceFor('unattested-client', a);
      assert.equal(r.canClaim, false, `attestation:${a} must not make it claimable`);
      assert.equal(r.p1, 'fails');
      assert.equal(r.p3, 'fails');
      assert.equal(r.leaf, null, 'no leaf may be issued at this placement');
    }
  });

  test('a genuine verified quote relayed by page JS still refuses', () => {
    // The temptation this test exists to block: a browser page CAN present a
    // real root-chained SEV-SNP quote it fetched from a server it does not run.
    // The quote proves something about a machine and nothing about the capture.
    const r = assuranceForHost(CANON_HOST_PROFILES.browser_js);
    assert.equal(r.attestation, 'verified');
    assert.equal(r.canClaim, false);
    assert.equal(r.leaf, null);
  });

  test('every declared placement without its enforcement degrades to it', () => {
    const required: Record<Placement, string> = {
      'server-library': 'no-tenant-code',
      'sidecar-gate': 'isolated-namespace',
      'attested-client': 'host-enforced-signature',
      'unattested-client': 'none',
    };
    for (const declared of PLACEMENTS) {
      for (const enforcement of PLACEMENT_ENFORCEMENTS) {
        const r = resolvePlacement(declared, enforcement);
        if (enforcement !== required[declared]) {
          assert.equal(r.effective, 'unattested-client');
          assert.equal(assuranceFor(r.effective, 'verified').canClaim, false);
        }
      }
    }
  });

  test('no cell anywhere produces a verified leaf without a verified attestation', () => {
    for (const c of allAssuranceCells()) {
      if (c.leaf === 'verified') assert.equal(c.attestation, 'verified');
    }
  });
});

describe('leaf status uses H-5 vocabulary and nothing else', () => {
  test('attestationOutcomeOf reduces a VerifyResult correctly', () => {
    assert.equal(attestationOutcomeOf({ ok: true, status: 'verified' }), 'verified');
    assert.equal(attestationOutcomeOf({ ok: true, status: 'passthrough' }), 'passthrough');
    // ok:true with no status is NOT verified. verifier.ts: "`ok` ALONE IS NOT
    // A VERIFICATION CLAIM."
    assert.equal(attestationOutcomeOf({ ok: true }), 'passthrough');
    assert.equal(attestationOutcomeOf({ ok: false }), 'none');
    assert.equal(attestationOutcomeOf(null), 'none');
    assert.equal(attestationOutcomeOf(undefined), 'none');
  });

  test('server-library with no attestation is still only passthrough', () => {
    // P1 being free does not buy a verified attestation. Nothing does except
    // chaining to a vendor root. This is H-4 §9's open question answered.
    const r = assuranceFor('server-library', 'none');
    assert.equal(r.p1, 'holds');
    assert.equal(r.leaf, 'passthrough');
  });

  test('a verified attestation is what moves P3 from conditional to holds', () => {
    for (const p of ['sidecar-gate', 'attested-client'] as const) {
      assert.equal(assuranceFor(p, 'verified').p3, 'holds');
      assert.equal(assuranceFor(p, 'passthrough').p3, 'conditional');
      assert.equal(assuranceFor(p, 'none').p3, 'conditional');
    }
  });
});

describe('the six mapped hosts resolve to the tiers the doc claims', () => {
  // These expectations mirror PLACEMENT_AND_SURFACES.md §7.7 exactly. If the
  // table and this block ever disagree, one of them is wrong and the WO's
  // acceptance criterion is not met.
  const expected: Record<
    string,
    {
      effective: Placement;
      p1: string;
      p3: string;
      leaf: string | null;
      canClaim: boolean;
    }
  > = {
    comfyui: {
      effective: 'sidecar-gate',
      p1: 'conditional',
      p3: 'conditional',
      leaf: 'passthrough',
      canClaim: true,
    },
    kohya_today: {
      // Server-side, on hardware the tenant does not own, and classified
      // identically to browser JS. Reproduces STUDIO_P1-P8_GRADE.md's Kohya
      // column from the axes alone.
      effective: 'unattested-client',
      p1: 'fails',
      p3: 'fails',
      leaf: null,
      canClaim: false,
    },
    kohya_target: {
      effective: 'sidecar-gate',
      p1: 'conditional',
      p3: 'conditional',
      leaf: 'passthrough',
      canClaim: true,
    },
    vendor_managed: {
      effective: 'server-library',
      p1: 'holds',
      p3: 'holds',
      leaf: 'verified',
      canClaim: true,
    },
    vendor_custom_handler: {
      // Same vendor, same surface, same SDK call. trust_remote_code / BYO
      // container puts tenant code in the capture process and revokes the
      // free P1.
      effective: 'unattested-client',
      p1: 'fails',
      p3: 'fails',
      leaf: null,
      canClaim: false,
    },
    fusion_today: {
      // editEnabled:true over readable .py, plaintext key in %APPDATA%.
      effective: 'unattested-client',
      p1: 'fails',
      p3: 'fails',
      leaf: null,
      canClaim: false,
    },
    fusion_attested: {
      effective: 'attested-client',
      p1: 'conditional',
      p3: 'conditional',
      leaf: 'passthrough',
      canClaim: true,
    },
    blender: {
      effective: 'unattested-client',
      p1: 'fails',
      p3: 'fails',
      leaf: null,
      canClaim: false,
    },
    browser_js: {
      effective: 'unattested-client',
      p1: 'fails',
      p3: 'fails',
      leaf: null,
      canClaim: false,
    },
  };

  for (const [key, want] of Object.entries(expected)) {
    test(`${key} → ${want.effective}, leaf ${want.leaf ?? 'NONE'}`, () => {
      const profile = CANON_HOST_PROFILES[key];
      assert.ok(profile, `no profile for ${key}`);
      const got = assuranceForHost(profile);
      assert.equal(got.resolution.effective, want.effective);
      assert.equal(got.p1, want.p1);
      assert.equal(got.p3, want.p3);
      assert.equal(got.leaf, want.leaf);
      assert.equal(got.canClaim, want.canClaim);
    });
  }

  test('every profile uses only declared axis values', () => {
    for (const p of Object.values(CANON_HOST_PROFILES)) {
      for (const h of p.hooks) assert.ok(CAPTURE_HOOKS.includes(h), `hook ${h}`);
      for (const s of p.surfaces) assert.ok(CAPTURE_SURFACES.includes(s), `surface ${s}`);
      assert.ok(OBSERVATION_FIDELITIES.includes(p.fidelity), `fidelity ${p.fidelity}`);
      assert.ok(PLACEMENTS.includes(p.declaredPlacement));
      assert.ok(PLACEMENT_ENFORCEMENTS.includes(p.enforcement));
      assert.ok(ATTESTATION_OUTCOMES.includes(p.attestation));
    }
  });

  test('ComfyUI declares both surfaces — neither is sufficient alone (H-4 §2)', () => {
    const s = CANON_HOST_PROFILES.comfyui.surfaces;
    assert.ok(s.includes('network-gate'));
    assert.ok(s.includes('filesystem-watch'));
  });

  test('surface does not determine assurance — Kohya and the vendor share one', () => {
    // Both are in-process-callback. One cannot claim the standard; the other
    // gets P1 for free. If this ever stops being true, the axes have collapsed
    // into each other.
    assert.ok(CANON_HOST_PROFILES.kohya_today.surfaces.includes('in-process-callback'));
    assert.ok(CANON_HOST_PROFILES.vendor_managed.surfaces.includes('in-process-callback'));
    assert.equal(assuranceForHost(CANON_HOST_PROFILES.kohya_today).canClaim, false);
    assert.equal(assuranceForHost(CANON_HOST_PROFILES.vendor_managed).canClaim, true);
  });

  test('Fusion as shipped is induced fidelity — the hash is over a deleted tempfile', () => {
    // DEFECT-3. Recorded so the fix (retain/address the export, or move the
    // observation to as-written) cannot be lost.
    assert.equal(CANON_HOST_PROFILES.fusion_today.fidelity, 'induced');
  });

  test('attested-client is fully expressed for a host nothing implements yet', () => {
    // The WO requirement: if the model only fits hosts we have built, it
    // describes our code rather than designing a skeleton.
    const got = assuranceForHost(CANON_HOST_PROFILES.fusion_attested);
    assert.equal(got.resolution.effective, 'attested-client');
    assert.equal(got.resolution.honoured, true);
    assert.ok(got.conditions.some((c) => c.includes('signature')));
    assert.ok(got.conditions.some((c) => c.includes('build measurement')));
  });
});

describe('surface registration is explicit and static', () => {
  const stub = (name: string, hooks: readonly (typeof CAPTURE_HOOKS)[number][]): CaptureSurface => ({
    name: () => name,
    evidenceType: () => `scruple.dev/evidence/${name}/v1`,
    surface: () => 'network-gate',
    fidelity: () => 'as-delivered',
    hooks: () => hooks,
    placement: () => 'sidecar-gate',
    enforcement: () => 'isolated-namespace',
    schema: () => ({}),
    open: async () => {},
    observe: async () => {},
    close: async () => {},
  });

  test('a surface declaring no hooks is refused', () => {
    _resetSurfaceRegistryForTests();
    assert.throws(() => registerCaptureSurface(stub('hookless', [])), /declares no hooks/);
    _resetSurfaceRegistryForTests();
  });

  test('duplicate registration is refused, not silently overwritten', () => {
    _resetSurfaceRegistryForTests();
    registerCaptureSurface(stub('gate', ['graph.execute']));
    assert.throws(() => registerCaptureSurface(stub('gate', ['graph.execute'])), /already registered/);
    assert.deepEqual(registeredSurfaces(), ['gate']);
    _resetSurfaceRegistryForTests();
  });
});
