// Capability classes and the custody locus — lib/capture/classes.ts.
//
// docs/canon/CAPABILITY_CLASSES.md and docs/canon/CUSTODY_LOCUS.md, founder
// direction. Four things are pinned here and they are the four the WO exists
// to make true:
//
//   1. THE FOUR CLASSES PARTITION THE AXES. For each class, required ∪
//      permitted ∪ not-applicable is exactly CAPTURE_HOOKS and exactly
//      CAPTURE_SURFACES, with no overlap. A hook that falls through the
//      partition is a hook nobody decided about, and "nobody decided" is the
//      state this whole layer exists to end.
//   2. LOCUS x PLACEMENT IS TOTAL, and `ephemeral` + `unattested-client` does
//      NOT resolve to something strong. `ephemeral` is a claim about
//      persistence, not about isolation; placement decides the second.
//   3. THE THREE-WAY DISTINCTION HOLDS. not-applicable, failed, and unmeasured
//      are three different answers and the grader never collapses them into
//      two. WO-14 established inconclusive-is-never-a-pass for probes; this is
//      the same discipline at class scope.
//   4. THE ANTI-GAMING RULE IS CHECKABLE. A profile carrying a hook or surface
//      that belongs to a class it did not declare is a FINDING, and adding the
//      second class does not dilute the first — it takes the union.
//
// PURE LOGIC, ALMOST. `lib/capture/classes.ts` opens no database and makes no
// network call. The private SCRUPLE_DB_PATH and the dynamic imports below are
// the house rule for this directory anyway (`npm run test:v2` runs every file
// CONCURRENTLY against one shared path, which races the moment two files
// migrate), and they cost nothing here.

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (!process.env.SCRUPLE_DB_PATH || !/tmp|test/i.test(process.env.SCRUPLE_DB_PATH)) {
  throw new Error('Refusing to run: set SCRUPLE_DB_PATH to a throwaway path. Use `npm run test:v2`.');
}
const OWN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'scruple-classes-'));
process.env.SCRUPLE_DB_PATH = path.join(OWN_DIR, 'classes.db');
// The standing safety rule. Nothing here goes near the production witness
// server on 127.0.0.1:5799.
process.env.WITNESS_SERVER_URL = 'http://127.0.0.1:1';

type Mod = {
  K: typeof import('../../lib/capture/classes');
  S: typeof import('../../lib/capture/surface');
  C: typeof import('../../packages/scruple-conformance/src/classes');
};
let M: Mod;

before(async () => {
  const [K, S, C] = await Promise.all([
    import('../../lib/capture/classes'),
    import('../../lib/capture/surface'),
    import('../../packages/scruple-conformance/src/classes'),
  ]);
  M = { K, S, C };
});

type Profile = import('../../lib/capture/surface').HostCaptureProfile;

/** A minimal well-formed member of a class, for the checks to bend. */
function profileFor(
  over: Partial<Profile> & Pick<Profile, 'hooks' | 'surfaces'>,
): Profile {
  return {
    host: 'fixture',
    fidelity: 'as-delivered',
    declaredPlacement: 'sidecar-gate',
    enforcement: 'isolated-namespace',
    attestation: 'none',
    ...over,
  };
}

/** An inference host that meets its class's floor and nothing more. */
function conformantInferenceHost(over: Partial<Profile> = {}): Profile {
  return profileFor({
    hooks: ['graph.execute', 'artifact.produced'],
    surfaces: ['network-gate'],
    capabilityClasses: ['inference-host'],
    ...over,
  });
}

// ===========================================================================
describe('the four classes partition the axes', () => {
  test('required, permitted and not-applicable hooks cover CAPTURE_HOOKS exactly once', () => {
    for (const id of M.K.CAPABILITY_CLASSES) {
      const d = M.K.classDefinition(id);
      const all = [
        ...d.requiredHooks,
        ...d.permittedHooks,
        ...d.notApplicableHooks.map((n) => n.item),
      ];
      assert.equal(
        new Set(all).size,
        all.length,
        `${id}: a hook appears in two of required/permitted/not-applicable. Those are three ` +
          'different sentences and a hook cannot be two of them.',
      );
      assert.deepEqual(
        [...all].sort(),
        [...M.S.CAPTURE_HOOKS].sort(),
        `${id}: the hook axis is not partitioned. A hook nobody classified is a hook nobody ` +
          'decided about, which is the state this layer exists to end.',
      );
    }
  });

  test('surfaces are partitioned too, with the required disjunction counted in', () => {
    for (const id of M.K.CAPABILITY_CLASSES) {
      const d = M.K.classDefinition(id);
      const all = [
        ...d.requiredSurfaces,
        ...d.requiredSurfacesAnyOf.flat(),
        ...d.permittedSurfaces,
        ...d.notApplicableSurfaces.map((n) => n.item),
      ];
      assert.equal(new Set(all).size, all.length, `${id}: a surface is classified twice`);
      assert.deepEqual([...all].sort(), [...M.S.CAPTURE_SURFACES].sort(), `${id}: surfaces`);
    }
  });

  test('every class declares not-applicable items AND the reason for each', () => {
    // The founder's requirement in one assertion: "not-applicable becomes a
    // DECLARED PROPERTY of the class, checkable, rather than a hole a grader
    // has to guess at." A declaration with no reason is a hole with a name.
    for (const id of M.K.CAPABILITY_CLASSES) {
      const d = M.K.classDefinition(id);
      assert.ok(d.notApplicableHooks.length > 0, `${id}: no hook declared not applicable`);
      assert.ok(d.notApplicableSurfaces.length > 0, `${id}: no surface declared not applicable`);
      assert.ok(d.notApplicableProbes.length > 0, `${id}: no probe declared not applicable`);
      for (const n of [
        ...d.notApplicableHooks,
        ...d.notApplicableSurfaces,
        ...d.notApplicableProbes,
        ...d.notApplicablePItems,
        ...d.incompatibleLoci,
      ]) {
        assert.ok(n.reason.length > 40, `${id}/${n.item}: the reason is not a sentence`);
      }
      assert.ok(d.permittedClaim.length > 0, `${id}: no permitted claim wording`);
      assert.ok(d.forbiddenClaims.length > 0, `${id}: nothing this class must not imply`);
    }
  });

  test('the four required-probe sets are four different sets', () => {
    // If two classes required the same probes, one of them is not a class —
    // it is the same Protection Profile with a different name, and the whole
    // point of the layer is that grading a plugin against inference-host
    // probes produces nonsense.
    const sets = M.K.CAPABILITY_CLASSES.map((c) =>
      [...M.K.classDefinition(c).requiredProbes].sort().join(','),
    );
    assert.equal(new Set(sets).size, sets.length, `two classes require the same probes: ${sets}`);
  });

  test('the founder doc names probe 5 for training hosts, and the class says so', () => {
    // CAPABILITY_CLASSES.md: "Probe 5 (WebSocket retrieval) is meaningless for
    // a training host." Pinned verbatim as a scope decision so it cannot be
    // quietly re-added by a future required-probe list.
    const d = M.K.classDefinition('training-host');
    assert.ok(!d.requiredProbes.includes('P-05'));
    const na = d.notApplicableProbes.find((n) => n.item === 'P-05');
    assert.ok(na, 'P-05 must be DECLARED not applicable, not merely omitted');
    assert.match(na!.reason, /checkpoint IS a file|retrieval channel/i);
  });

  test('authoring-application inverts the threat model and does not borrow inference probes', () => {
    const a = M.K.classDefinition('authoring-application');
    assert.equal(a.threatModel, 'third-party-disputes-later');
    assert.match(a.adversary, /not the user/i);
    for (const id of ['P-01', 'P-02', 'P-05', 'P-07'] as const) {
      assert.ok(
        a.notApplicableProbes.some((n) => n.item === id),
        `${id} must be out of scope for an authoring application — there is no tenant/vendor split`,
      );
      assert.ok(!a.requiredProbes.includes(id), `${id} must not be required`);
    }
    // AND THE ONE OF THE FIRST THREE THAT SURVIVES THE INVERSION. The founder
    // direction lumps probes 1-3; P-03 does not belong with 1 and 2, because
    // the disputant's whole case is "the author forged it" and that is a
    // question about where the signing key lives.
    assert.ok(a.requiredProbes.includes('P-03'), 'key custody survives the inversion');
    assert.ok(a.requiredProbes.includes('P-06'));
  });
});

// ===========================================================================
describe('locus x placement decides what may be claimed', () => {
  test('the custody function is total over 5 loci x 4 placements', () => {
    const cells = M.K.allCustodyCells(M.S.PLACEMENTS);
    assert.equal(cells.length, M.K.CUSTODY_LOCI.length * M.S.PLACEMENTS.length);
    assert.equal(cells.length, 20);
    for (const c of cells) {
      assert.ok(M.K.CUSTODY_CLAIMS.includes(c.claim), `${c.locus}/${c.placement}`);
      assert.ok(c.reason.length > 0, 'every cell explains itself');
      assert.equal(typeof c.canClaim, 'boolean');
      // A claim you may make has words; a claim you may not, does not.
      assert.equal(c.sentence.length > 0, c.canClaim, `${c.locus}/${c.placement}: sentence`);
    }
    // Keyed by the DECLARED locus, because two declared loci can resolve to
    // one effective locus and the cells would otherwise collide.
    assert.equal(
      new Set(cells.map((c) => `${c.resolution.declared}|${c.placement}`)).size,
      20,
    );
  });

  test('THE CAVEAT: ephemeral + unattested-client does not resolve to something strong', () => {
    // CUSTODY_LOCUS.md, carried into the code rather than left in the doc:
    // "`ephemeral` means nothing rests where it can be altered BETWEEN events.
    // It does not mean memory is beyond reach — if the tenant has code
    // execution in the same process, memory is theirs. `ephemeral` is a claim
    // about persistence, not about isolation; PLACEMENT STILL DECIDES THE
    // SECOND."
    const weak = M.K.custodyAssuranceFor('ephemeral', 'unattested-client');
    assert.equal(weak.claim, 'none');
    assert.equal(weak.canClaim, false);
    assert.equal(weak.sentence, '');
    assert.match(weak.reason, /persistence, not about isolation/);
    assert.notEqual(weak.claim, 'nothing-at-rest');

    // And the same locus at a placement that HAS the isolation is the
    // strongest cell there is. The locus did not change; the placement did.
    const strong = M.K.custodyAssuranceFor('ephemeral', 'server-library');
    assert.equal(strong.claim, 'nothing-at-rest');
    assert.equal(strong.canClaim, true);
  });

  test('no locus lifts unattested-client, and the two refusals agree', () => {
    for (const locus of M.K.CUSTODY_LOCI) {
      const c = M.K.custodyAssuranceFor(locus, 'unattested-client');
      assert.equal(c.canClaim, false, locus);
      assert.equal(c.claim, 'none', locus);
    }
    // `assuranceFor` refuses that placement regardless of attestation, and the
    // custody function refuses it regardless of locus. If those two ever
    // disagreed, a deployment would be refused by one half of the model and
    // permitted by the other.
    for (const p of M.S.PLACEMENTS) {
      for (const l of M.K.CUSTODY_LOCI) {
        assert.equal(
          M.K.custodyAssuranceFor(l, p).canClaim,
          M.S.assuranceFor(p, 'none').canClaim,
          `${l}/${p}: the custody refusal and the assurance refusal must agree`,
        );
      }
    }
  });

  test('perfect capture plus tenant-custody is witnessed moments, NOT a history', () => {
    // The sentence CUSTODY_LOCUS.md ends on, as an assertion.
    const vendor = M.K.custodyAssuranceFor('vendor-custody', 'server-library');
    const tenant = M.K.custodyAssuranceFor('tenant-custody', 'server-library');
    assert.equal(vendor.claim, 'complete-history');
    assert.equal(tenant.claim, 'witnessed-moments');
    assert.notEqual(vendor.sentence, tenant.sentence);
    assert.ok(
      tenant.mustNotImply.includes(vendor.sentence),
      'a tenant-custody vendor must not be able to imply the complete-history sentence',
    );
    assert.match(tenant.reason, /notary|notarial/i);

    // shared-custody sits between: detectable, not preventable.
    const shared = M.K.custodyAssuranceFor('shared-custody', 'sidecar-gate');
    assert.equal(shared.claim, 'detectable-gaps');
    assert.match(shared.reason, /DETECTABLE, NOT PREVENTABLE/);
    assert.ok(shared.mustNotImply.includes(vendor.sentence));
  });

  test('a complete-history claim needs a placement the measured party is out of', () => {
    // vendor-custody is not sufficient on its own: at attested-client the code
    // that watches the store runs where the measured party does.
    assert.equal(M.K.custodyAssuranceFor('vendor-custody', 'attested-client').claim, 'witnessed-moments');
    assert.equal(M.K.custodyAssuranceFor('vendor-custody', 'sidecar-gate').claim, 'complete-history');
  });

  test('assuranceForHost resolves custody against the EFFECTIVE placement', () => {
    // A degraded placement must not be rescued by a strong locus. The custom
    // handler declares `server-library` + `ephemeral` and enforces nothing.
    const p = M.S.CANON_HOST_PROFILES.vendor_custom_handler;
    assert.equal(p.custodyLocus, 'ephemeral');
    const a = M.S.assuranceForHost(p);
    assert.equal(a.resolution.effective, 'unattested-client');
    assert.equal(a.custody!.claim, 'none');
    assert.equal(a.custody!.canClaim, false);

    // Its managed sibling is the same locus and the same SDK call, and it
    // keeps the claim, because the configuration is different.
    const managed = M.S.assuranceForHost(M.S.CANON_HOST_PROFILES.vendor_managed);
    assert.equal(managed.custody!.claim, 'nothing-at-rest');
  });

  test('the plugins land in tenant custody, and that is not a deficiency', () => {
    assert.equal(M.S.CANON_HOST_PROFILES.blender.custodyLocus, 'tenant-custody');
    for (const key of ['fusion_today', 'fusion_attested'] as const) {
      assert.equal(
        M.S.CANON_HOST_PROFILES[key].custodyLocus,
        'tenant-custody-corroborated',
        key,
      );
    }
    // Fusion signed is the strongest thing available in that locus, and it is
    // STILL not a complete history. "We did not build this guarantee, Autodesk
    // did" is an honest sentence; "this is the complete history of the
    // project" is not, and the assurance says so in `mustNotImply`.
    const signed = M.S.assuranceForHost(M.S.CANON_HOST_PROFILES.fusion_attested);
    assert.equal(signed.resolution.effective, 'attested-client');
    assert.equal(signed.custody!.claim, 'corroborated-moments');
    assert.ok(signed.custody!.mustNotImply.includes('this is the complete history of the project'));
    // Blender has no such record, and the two must not read the same.
    const blender = M.S.assuranceForHost({
      ...M.S.CANON_HOST_PROFILES.blender,
      enforcement: 'host-enforced-signature',
    });
    assert.equal(blender.custody!.claim, 'witnessed-moments');
    assert.notEqual(blender.custody!.sentence, signed.custody!.sentence);
  });
});

// ===========================================================================
describe('the fifth locus — tenant custody with a third-party corroborator', () => {
  // docs/canon/custody-study/fusion.md §6.3. Fusion fits none of the original
  // four: its LOCAL file is `tenant-custody` (a plain store-compressed ZIP
  // with no integrity field), and its CLOUD VERSION SEQUENCE is append-only in
  // fact — zero delete operations across an 8,289-line OpenAPI spec, and
  // Autodesk stating that BIM 360's tombstone route does not apply to Fusion
  // Team at all.
  //
  // IT IS NOT `vendor-custody`, AND THAT IS THE LOAD-BEARING DISTINCTION.
  // `vendor-custody` means the INTEGRATOR's boundary — a party to the
  // standard, whose topology we can probe. Autodesk is neither, and calling
  // Autodesk's guarantee ours would be the misrepresentation the axis exists
  // to prevent.

  const corroborator = () => ({
    party: 'A Named Operator',
    guarantee: 'versions cannot be deleted',
    cite: 'their spec §1',
    tenantWritable: false,
    verifiable: 'asserted' as const,
  });

  test('it sits strictly between witnessed-moments and complete-history', () => {
    const c = M.K.custodyAssuranceFor('tenant-custody-corroborated', 'attested-client', corroborator());
    assert.equal(c.claim, 'corroborated-moments');
    assert.equal(c.canClaim, true);
    assert.match(c.sentence, /append-only version record corroborates the sequence/);
    assert.notEqual(c.sentence, M.K.custodyAssuranceFor('tenant-custody', 'attested-client').sentence);
    assert.ok(c.mustNotImply.includes('this is the complete history of the project'));
  });

  test('it states its three limits rather than implying them away', () => {
    const c = M.K.custodyAssuranceFor('tenant-custody-corroborated', 'attested-client', corroborator());
    const all = c.conditions.join(' | ');
    // 1 — the gaps between saves are real and unclosable in this locus.
    assert.match(all, /never what happened between\s+saves|between two witnessed events/);
    // 2 — the corroborator is asserted, not proved.
    assert.match(all, /a second party would have to lie too/);
    // 3 — corroboration is only as dense as the connection.
    assert.match(all, /as dense as the connection/);
    // And whose architecture earned it.
    assert.match(all, /not the integrator's/);

    // A cryptographic corroborator drops limit 2 and only limit 2. Nothing we
    // integrate is there yet; fusion.md open question 2 asks whether Fusion
    // can be, and this is where the answer lands when it arrives.
    const proved = M.K.custodyAssuranceFor('tenant-custody-corroborated', 'attested-client', {
      ...corroborator(),
      verifiable: 'cryptographic',
    });
    assert.ok(!proved.conditions.join(' | ').includes('a second party would have to lie too'));
    assert.equal(proved.claim, 'corroborated-moments', 'a checkable record is not a complete history');
    assert.ok(proved.conditions.some((x) => /as dense as the connection/.test(x)));
  });

  test('IT EARNS ITS PLACE BY BEING ABLE TO DEGRADE — DEFECT-1, one axis over', () => {
    // A locus a vendor could hold by naming it would be the self-assigned tier
    // `resolvePlacement` exists to refuse. The corroborating party must be
    // NAMED and its guarantee CITED.
    const unnamed = M.K.custodyAssuranceFor('tenant-custody-corroborated', 'attested-client');
    assert.equal(unnamed.resolution.honoured, false);
    assert.equal(unnamed.locus, 'tenant-custody');
    assert.equal(unnamed.claim, 'witnessed-moments');
    assert.match(unnamed.resolution.reason, /no corroborating party is named/);

    // And a record the measured party can rewrite corroborates nothing: the
    // same hand writes the claim and the check.
    const writable = M.K.custodyAssuranceFor('tenant-custody-corroborated', 'attested-client', {
      ...corroborator(),
      tenantWritable: true,
    });
    assert.equal(writable.resolution.honoured, false);
    assert.equal(writable.claim, 'witnessed-moments');
    assert.match(writable.resolution.reason, /same hand writes the claim and the check/);
  });

  test('the degrade is reported, never silent', () => {
    const r = M.K.scopeProfile(
      profileFor({
        hooks: ['document.save', 'artifact.produced'],
        surfaces: ['host-api-callback'],
        capabilityClasses: ['authoring-application'],
        custodyLocus: 'tenant-custody-corroborated',
      }),
      { effectivePlacement: 'attested-client' },
    );
    const f = r.findings.find((x) => x.id === 'CF-10');
    assert.ok(f, 'a claim that was reduced must not read as a claim that was honoured');
    assert.equal(f!.blocking, false, 'degrading is not being in the wrong class');
    assert.ok(!r.permittedClaims.some((c) => /corroborates the sequence/.test(c)));
  });

  test('placement still refuses it, because corroboration is not isolation', () => {
    const c = M.K.custodyAssuranceFor(
      'tenant-custody-corroborated',
      'unattested-client',
      corroborator(),
    );
    assert.equal(c.canClaim, false);
    assert.equal(c.claim, 'none');
  });

  test('the corroborator on Fusion is named, cited, and scoped to the version sequence', () => {
    // The whole finding is that "Fusion is tamper-resistant" is FALSE of the
    // timeline (rewritable through Fusion's own scripting API) and of the
    // local file (a ZIP with no integrity field), and TRUE only of the cloud
    // version sequence. A corroborator record that did not say WHICH would
    // launder the false general claim on the true specific one.
    const c = M.S.CANON_HOST_PROFILES.fusion_attested.custodyCorroborator!;
    assert.match(c.party, /Autodesk/);
    assert.match(c.guarantee, /version cannot be deleted/i);
    assert.match(c.cite, /custody-study\/fusion\.md/);
    assert.equal(c.tenantWritable, false);
    // NOT cryptographic: no hash, no signature, no customer-verifiable log,
    // and a version `name` that is PATCH-able after the fact.
    assert.equal(c.verifiable, 'asserted');
  });

  test('signing the add-in changes PLACEMENT, not FIDELITY', () => {
    // `fusion_attested` read `as-written` until 2026-08-31 and that quietly
    // coupled two axes the model keeps apart. Autodesk will not hand an add-in
    // the bytes it saved — `DataFile.download` is documented as "Only
    // DataFiles that represent non-Fusion data can be downloaded" — so the
    // export path is `induced` whether or not the host checked our signature.
    assert.equal(M.S.CANON_HOST_PROFILES.fusion_today.fidelity, 'induced');
    assert.equal(
      M.S.CANON_HOST_PROFILES.fusion_attested.fidelity,
      'induced',
      'DEFECT-3\'s repair (move to as-written over the saved file) is UNAVAILABLE for Fusion',
    );
    // The axis that DOES move is placement, and it moves for the whole reason
    // the enforcement axis exists.
    assert.equal(
      M.S.assuranceForHost(M.S.CANON_HOST_PROFILES.fusion_today).resolution.effective,
      'unattested-client',
    );
    assert.equal(
      M.S.assuranceForHost(M.S.CANON_HOST_PROFILES.fusion_attested).resolution.effective,
      'attested-client',
    );
  });
});

// ===========================================================================
describe('not-applicable / failed / unmeasured are three answers, not two', () => {
  const probe = (r: import('../../lib/capture/classes').ClassScopeReport, id: string) =>
    r.probes.find((p) => p.item === id)!;

  test('an applicable probe with no result is UNMEASURED and never satisfied', () => {
    const r = M.K.scopeProfile(conformantInferenceHost(), { probeVerdicts: {} });
    const p1 = probe(r, 'P-01');
    assert.equal(p1.status, 'required');
    assert.equal(p1.outcome, 'unmeasured');
    assert.notEqual(p1.outcome, 'satisfied');
    assert.ok(r.unmeasured.includes('P-01'));
    assert.match(p1.reason, /APPLICABLE AND NOT MEASURED/);
    // WO-14's rule, restated at class scope: there is no configuration in
    // which a skip becomes a pass.
    assert.ok(r.findings.some((f) => f.id === 'CF-08' && !f.blocking));
  });

  test('no run at all is unmeasured for every APPLICABLE probe — and only those', () => {
    // Six, not seven, and the missing one is the whole point: this fixture
    // declares no `filesystem-watch`, so P-04 is out of scope rather than
    // unlooked-at. The two answers coexist in one report and are spelled
    // differently, which is what the grader could not do before.
    const r = M.K.scopeProfile(conformantInferenceHost());
    assert.equal(r.unmeasured.length, 6);
    assert.ok(!r.unmeasured.includes('P-04'));
    assert.equal(probe(r, 'P-04').outcome, 'not-applicable');
    for (const id of r.unmeasured) assert.equal(probe(r, id).outcome, 'unmeasured');

    // With the surface declared, all seven are applicable and all seven are
    // unmeasured. Same run (none), different scope.
    const withFs = M.K.scopeProfile(
      conformantInferenceHost({ surfaces: ['network-gate', 'filesystem-watch'] }),
    );
    assert.equal(withFs.unmeasured.length, 7);
  });

  test('the same probe reads failed, satisfied, unmeasured and not-applicable', () => {
    const withFs = conformantInferenceHost({ surfaces: ['network-gate', 'filesystem-watch'] });
    assert.equal(probe(M.K.scopeProfile(withFs, { probeVerdicts: { 'P-04': 'fail' } }), 'P-04').outcome, 'failed');
    assert.equal(probe(M.K.scopeProfile(withFs, { probeVerdicts: { 'P-04': 'pass' } }), 'P-04').outcome, 'satisfied');
    assert.equal(probe(M.K.scopeProfile(withFs, { probeVerdicts: {} }), 'P-04').outcome, 'unmeasured');
    assert.equal(
      probe(M.K.scopeProfile(withFs, { probeVerdicts: { 'P-04': 'inconclusive' } }), 'P-04').outcome,
      'unmeasured',
      'an inconclusive probe is unmeasured, never a pass (WO-14)',
    );

    // And the fourth answer, which the grader used to spell as one of the
    // other three: canvas has no filesystem surface, so the question was not
    // asked and nobody should read that as either an attack that held or an
    // attack that got through.
    const noFs = M.K.scopeProfile(conformantInferenceHost(), { probeVerdicts: {} });
    assert.equal(probe(noFs, 'P-04').status, 'not-applicable');
    assert.equal(probe(noFs, 'P-04').outcome, 'not-applicable');
    assert.ok(!noFs.unmeasured.includes('P-04'), 'out of scope is not unmeasured either');
  });

  test('AN OBSERVATION BEATS A DECLARATION — and this is where DEFECT-2 closes', () => {
    // The class says probe 4 is out of scope because this profile declares no
    // filesystem surface. Probe 4 against a deployment with no volumes returns
    // `not-attempted`, which reads as `inconclusive`. A `pass` or a `fail`
    // means the probe FOUND A VOLUME and got an answer — so the surface the
    // declaration denies is there, and the declaration loses.
    //
    // Everywhere else in this file the class narrows DEFECT-2. Here it closes
    // it, because a run from an occupied tenant position is not a declaration.
    for (const observed of ['pass', 'fail'] as const) {
      const r = M.K.scopeProfile(conformantInferenceHost(), {
        probeVerdicts: { 'P-04': observed },
      });
      assert.equal(probe(r, 'P-04').status, 'required', observed);
      assert.ok(probe(r, 'P-04').voidedBy, observed);
      const f = r.findings.find((x) => x.id === 'CF-04');
      assert.ok(f, `a measured result on an out-of-scope probe must be a finding (${observed})`);
      assert.equal(f!.blocking, true);
      assert.match(f!.detail, /An observation beats a declaration/);
      assert.equal(r.inScope, false);
    }

    // An INCONCLUSIVE result is exactly what a genuine absence produces, and
    // it must not fire this. Otherwise every honest deployment with no
    // filesystem surface would be accused of hiding one.
    const honest = M.K.scopeProfile(conformantInferenceHost(), {
      probeVerdicts: { 'P-04': 'inconclusive' },
    });
    assert.equal(probe(honest, 'P-04').status, 'not-applicable');
    assert.ok(!honest.findings.some((x) => x.id === 'CF-04'));

    // It applies to unconditional not-applicables too: if probe 5 retrieves
    // bytes over a socket from a training host, that host has an interactive
    // retrieval channel whatever its class assumed about members of it.
    const training = M.K.scopeProfile(
      profileFor({
        hooks: ['model.write'],
        surfaces: ['filesystem-watch'],
        capabilityClasses: ['training-host'],
      }),
      { probeVerdicts: { 'P-05': 'fail' } },
    );
    assert.equal(probe(training, 'P-05').status, 'required');
    assert.ok(training.findings.some((x) => x.id === 'CF-04'));
  });

  test('THE DECLARATION IS CHECKED: adding the surface voids the not-applicable', () => {
    // This is the difference between a class and the old `surfaceAbsences`
    // hole. The class says "P-04 does not apply to a member with no filesystem
    // surface" — and the profile's own surface list decides whether that is
    // this member.
    const withFs = conformantInferenceHost({ surfaces: ['network-gate', 'filesystem-watch'] });
    const r = M.K.scopeProfile(withFs, { probeVerdicts: {} });
    const p4 = probe(r, 'P-04');
    assert.equal(p4.status, 'required');
    assert.equal(p4.outcome, 'unmeasured');
    assert.ok(p4.voidedBy, 'the void must be recorded, not silently applied');
    assert.match(p4.voidedBy!, /declares a 'filesystem-watch' surface/);
  });

  test('an inadmissible pass is not a pass, and a borrowed run supplies nothing', () => {
    const result = (id: string, verdict: string, admissible: boolean) => ({
      id, spec: '', title: '', attempt: '', requirement: '', evidenceFor: [] as never[],
      topological: false, verdict: verdict as 'pass', vantage: 'simulated', admissible,
      startedAt: 'a', durationMs: 1, outcome: 'blocked' as const, detail: '', evidence: {},
    });
    const run = {
      runId: 'r', subject: 'this deployment', startedAt: 'a', finishedAt: 'b', vantages: ['simulated'],
      results: [result('P-01', 'pass', false), result('P-02', 'pass', true)],
      summary: { passed: 1, failed: 0, inconclusive: 1, line: '' },
      admissible: false,
    };
    const v = M.C.probeVerdictsOf(run, 'this deployment')!;
    assert.equal(v['P-01'], 'inconclusive', 'a pass from a vantage that cannot support it is not a pass');
    assert.equal(v['P-02'], 'pass');

    // WO-14, carried into class scope: a run of another deployment is evidence
    // about that deployment and about no other.
    assert.equal(M.C.probeVerdictsOf(run, 'somebody else entirely'), undefined);
    assert.equal(M.C.probeVerdictsOf(null, 'this deployment'), undefined);
  });
});

// ===========================================================================
describe('the anti-gaming rule is checkable, not merely written down', () => {
  test('a hook belonging to an undeclared class is a FINDING that names the class', () => {
    // An inference host that also writes checkpoints. CAPABILITY_CLASSES.md:
    // "a class may not be chosen to avoid a requirement that genuinely
    // applies... where a deployment spans two classes it is audited against
    // both."
    const r = M.K.scopeProfile(
      conformantInferenceHost({ hooks: ['graph.execute', 'artifact.produced', 'model.write'] }),
    );
    const f = r.findings.find((x) => x.id === 'CF-02');
    assert.ok(f, 'declaring a hook the class says cannot apply must be a finding');
    assert.equal(f!.blocking, true);
    assert.equal(f!.impliedClass, 'training-host');
    assert.equal(r.inScope, false);
    assert.match(f!.detail, /audited against both/);
    // And the not-applicable is void rather than quietly honoured.
    const h = r.hooks.find((x) => x.item === 'model.write')!;
    assert.equal(h.outcome, 'failed');
    assert.match(h.reason, /VOID/);
  });

  test('a surface belonging to an undeclared class is a finding too', () => {
    // An authoring application that has installed a network gate is not an
    // authoring application any more.
    const r = M.K.scopeProfile(
      profileFor({
        hooks: ['document.save', 'artifact.produced'],
        surfaces: ['host-api-callback', 'network-gate'],
        capabilityClasses: ['authoring-application'],
      }),
    );
    const f = r.findings.find((x) => x.id === 'CF-03');
    assert.ok(f, 'a gate on a machine the vendor does not own must not pass silently');
    assert.equal(f!.impliedClass, 'inference-host');
    assert.equal(r.inScope, false);
  });

  test('declaring the second class clears the finding AND takes the union', () => {
    // The rule that keeps it honest: a second class cannot be used to dilute
    // the first. `training-host` says probe 5 is meaningless; `inference-host`
    // requires it; a deployment declaring both is audited against both, so
    // probe 5 is required.
    const spanning = conformantInferenceHost({
      hooks: ['graph.execute', 'artifact.produced', 'model.write'],
      surfaces: ['network-gate', 'filesystem-watch'],
      capabilityClasses: ['inference-host', 'training-host'],
    });
    const r = M.K.scopeProfile(spanning, { probeVerdicts: {} });
    assert.ok(!r.findings.some((f) => f.blocking), JSON.stringify(r.findings.map((f) => f.title)));
    assert.equal(r.inScope, true);
    const p5 = r.probes.find((p) => p.item === 'P-05')!;
    assert.equal(p5.status, 'required', 'the union of requirements, not the intersection');
    assert.equal(p5.outcome, 'unmeasured');

    // And the reverse: training-host ALONE does not require probe 5.
    const trainingOnly = M.K.scopeProfile(
      profileFor({
        hooks: ['model.write'],
        surfaces: ['filesystem-watch'],
        capabilityClasses: ['training-host'],
      }),
      { probeVerdicts: {} },
    );
    assert.equal(trainingOnly.probes.find((p) => p.item === 'P-05')!.status, 'not-applicable');
  });

  test('declaring NO class is a finding and buys the BROADEST audit, not the easiest', () => {
    const r = M.K.scopeProfile(
      profileFor({ hooks: ['document.save', 'artifact.produced'], surfaces: ['host-api-callback'] }),
    );
    const f = r.findings.find((x) => x.id === 'CF-01');
    assert.ok(f, 'an unclassified profile has no Protection Profile to be graded against');
    assert.equal(f!.blocking, true);
    assert.equal(r.ambiguityResolved, true);
    assert.deepEqual([...r.audited], ['inference-host'], 'the broader class applies');
    assert.equal(M.K.broadestClass(['authoring-application', 'training-host']), 'training-host');
    assert.equal(M.K.broadestClass([]), 'inference-host');
    assert.equal(r.inScope, false);
  });

  test('a class floor that is not met is a finding, independent of placement', () => {
    // Kohya as shipped: `training-host` requires a filesystem position because
    // a checkpoint is a file, and this profile has only an in-process patch.
    // That is a COVERAGE finding and it holds whatever the placement resolves
    // to — the same profile with perfect enforcement still fails it.
    const shipped = M.S.CANON_HOST_PROFILES.kohya_today;
    const r = M.K.scopeProfile(shipped);
    const f = r.findings.find((x) => x.id === 'CF-05');
    assert.ok(f, 'a member that cannot cover what the class covers is not a member');
    assert.match(f!.title, /filesystem-watch/);

    const enforced = M.K.scopeProfile({ ...shipped, enforcement: 'isolated-namespace' });
    assert.ok(
      enforced.findings.some((x) => x.id === 'CF-05'),
      'surface coverage is not an assurance question and placement cannot answer it',
    );

    // And the re-placed target, which WO-11 describes, meets the floor.
    assert.ok(!M.K.scopeProfile(M.S.CANON_HOST_PROFILES.kohya_target).findings.some((x) => x.blocking));
  });

  test('a locus that contradicts the class, and a class that needs one and has none', () => {
    const ephemeralAuthoring = M.K.scopeProfile(
      profileFor({
        hooks: ['document.save', 'artifact.produced'],
        surfaces: ['host-api-callback'],
        capabilityClasses: ['authoring-application'],
        custodyLocus: 'ephemeral',
      }),
    );
    const f = ephemeralAuthoring.findings.find((x) => x.id === 'CF-06');
    assert.ok(f, 'a project-based application IS persistence');
    assert.match(f!.detail, /the product they are/);
    assert.equal(ephemeralAuthoring.inScope, false);

    const custodyNoLocus = M.K.scopeProfile(
      profileFor({
        hooks: ['document.save', 'idle.tick'],
        surfaces: ['filesystem-watch'],
        capabilityClasses: ['asset-custody'],
      }),
    );
    assert.ok(
      custodyNoLocus.findings.some((x) => x.id === 'CF-07'),
      'asset-custody declares a locus the way a capture class declares a placement',
    );
  });

  test('claim wording: the specific determination wins over the class default', () => {
    // A class forbids the complete-history sentence because most of its
    // members cannot say it. A `vendor-custody` locus is exactly the
    // determination that this member can — and a report that both permits and
    // forbids the same words tells a vendor nothing.
    const r = M.K.scopeProfile(conformantInferenceHost({ custodyLocus: 'vendor-custody' }), {
      effectivePlacement: 'sidecar-gate',
    });
    assert.ok(r.permittedClaims.includes('this is the complete history of the project'));
    assert.ok(!r.forbiddenClaims.includes('this is the complete history of the project'));
    assert.ok(r.forbiddenClaims.includes('Scruple-witnessed authorship'));
    assert.equal(
      r.permittedClaims.filter((c) => r.forbiddenClaims.includes(c)).length,
      0,
      'nothing may be both permitted and forbidden',
    );

    // The same class at tenant-custody keeps the class sentence and loses the
    // custody one.
    const tenant = M.K.scopeProfile(conformantInferenceHost({ custodyLocus: 'tenant-custody' }), {
      effectivePlacement: 'sidecar-gate',
    });
    assert.ok(!tenant.permittedClaims.includes('this is the complete history of the project'));
    assert.ok(tenant.forbiddenClaims.includes('this is the complete history of the project'));
  });
});

// ===========================================================================
describe('what a class does NOT close — DEFECT-2, narrowed for the third time', () => {
  test('a vendor who omits a surface they have still gets the probe scored away', () => {
    // THE RESIDUE, REPRODUCED SO IT CANNOT BE CLAIMED CLOSED. `profile.surfaces`
    // is still a declaration. Two profiles that differ ONLY in whether they
    // admit to a filesystem surface get two different probe-4 scopes, and
    // nothing in the model can tell which one is lying.
    const honest = conformantInferenceHost({ surfaces: ['network-gate', 'filesystem-watch'] });
    const shading = conformantInferenceHost({ surfaces: ['network-gate'] });
    assert.equal(
      M.K.scopeProfile(honest, { probeVerdicts: {} }).probes.find((p) => p.item === 'P-04')!.status,
      'required',
    );
    assert.equal(
      M.K.scopeProfile(shading, { probeVerdicts: {} }).probes.find((p) => p.item === 'P-04')!.status,
      'not-applicable',
    );
    assert.match(M.K.residualDefect2(), /still a declaration/);
    assert.match(M.K.residualDefect2(), /observation from the tenant position/);
  });

  test('but the same declaration is now load-bearing in three other places', () => {
    // Which is the narrowing. A vendor who drops `filesystem-watch` to escape
    // probe 4 keeps their inference-host floor (the gate satisfies it) — but a
    // TRAINING host that drops it falls below the floor, and any class that
    // declares the surface not-applicable turns the omission into a
    // contradiction finding instead.
    const trainingShading = profileFor({
      hooks: ['model.write'],
      surfaces: ['in-process-callback'],
      capabilityClasses: ['training-host'],
    });
    assert.ok(M.K.scopeProfile(trainingShading).findings.some((f) => f.id === 'CF-05'));
    const authoringOverreach = profileFor({
      hooks: ['document.save', 'artifact.produced'],
      surfaces: ['host-api-callback', 'network-gate'],
      capabilityClasses: ['authoring-application'],
    });
    assert.ok(M.K.scopeProfile(authoringOverreach).findings.some((f) => f.id === 'CF-03'));
  });

  test('all eight P-items bind all four classes, and the doc expected otherwise', () => {
    // CAPABILITY_CLASSES.md: "Applicable P-items. Not all eight bind every
    // class." Working through the four, none drops out — including for the
    // inverted threat model, where P4 binds HARDER rather than less: an
    // authoring vendor whose user supplies both the identity and its
    // authenticator hands the later disputant their entire argument.
    //
    // The mechanism is kept and exercised below, because a fifth class will
    // need it. Recorded here so the divergence from the founder direction is
    // a decision on the record rather than an omission.
    for (const c of M.K.CAPABILITY_CLASSES) {
      const d = M.K.classDefinition(c);
      assert.equal(d.notApplicablePItems.length, 0, c);
      assert.deepEqual([...d.applicablePItems].sort(), [...M.K.P_ITEM_IDS].sort(), c);
    }
    const r = M.K.scopeProfile(conformantInferenceHost());
    for (const p of M.K.P_ITEM_IDS) assert.equal(r.pItems[p], 'required', p);
  });
});
