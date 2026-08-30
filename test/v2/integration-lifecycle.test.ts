// The integration lifecycle (WO-22, docs/canon/INTEGRATION_LIFECYCLE.md).
//
// The five properties this file exists to DEMONSTRATE rather than assert:
//
//   * A LEAF WRITTEN WHILE `integrating` IS PERMANENTLY DISTINGUISHABLE
//     FROM ONE WRITTEN WHILE `sealed`. This is the load-bearing one. The
//     founder direction: "the moment a vendor seals, they hold a pile of
//     integration-era leaves indistinguishable from approved ones — and
//     the first audit cannot tell which configuration produced what."
//     Both halves are asserted, because either alone is the wrong design:
//     refusing the pre-seal leaf destroys evidence of an artifact that
//     already exists, and accepting it unmarked is the silence the whole
//     lifecycle exists to end.
//
//   * A MATERIAL CHANGE MOVES A SEALED DEPLOYMENT TO `resealing`, and it
//     cannot claim until it is sealed again.
//
//   * HISTORICAL LEAVES KEEP VERIFYING ACROSS A RESEAL. State is a fold
//     as of a time; a later event cannot reach backwards. The seal row is
//     immutable, so the manifest a superseded leaf was written under is
//     still there to check against.
//
//   * THE PIPELINE MEASUREMENT DOES NOT INHERIT build-measurement.ts's
//     THREE TRAPS. A stray file cannot move it, input order cannot move
//     it, and `src/x.ts` and `dist/x.js` are two manifests a reader can
//     tell apart.
//
//   * THE SIGNATURE IS WORTH SOMETHING: only a key-holder can produce a
//     seal that verifies, and an edited manifest fails both the signature
//     and the measurement recomputation.
//
// TEST ISOLATION, as test/v2/components-provision.test.ts explains it:
// `npm run test:v2` runs every file CONCURRENTLY against one shared
// SCRUPLE_DB_PATH, so this file takes its own private database, assigned
// at module top level, with every module that reaches lib/db/sqlite
// imported DYNAMICALLY inside before().

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (!process.env.SCRUPLE_DB_PATH || !/tmp|test/i.test(process.env.SCRUPLE_DB_PATH)) {
  throw new Error('Refusing to run: set SCRUPLE_DB_PATH to a throwaway path. Use `npm run test:v2`.');
}
const OWN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'scruple-seal-'));
process.env.SCRUPLE_DB_PATH = path.join(OWN_DIR, 'seal.db');
process.env.SCRUPLE_BDK_HEX = 'a7'.repeat(32);
process.env.SCRUPLE_BUILD_REGISTRY_KEY_HEX = 'b8'.repeat(32);
// STANDING SAFETY RULE. 127.0.0.1:5799 is the PRODUCTION witness and a
// test that reaches it writes into a real audit log, which has happened
// once already. Port 1 refuses instantly; the route swallows the failure
// by design (capture is non-blocking) and still writes the leaf row,
// which is all this file reads.
process.env.WITNESS_SERVER_URL = 'http://127.0.0.1:1';

type Mod = {
  conn: typeof import('../../lib/db/sqlite').conn;
  seal: typeof import('../../lib/seal/registry');
  measure: typeof import('../../lib/seal/measure');
  materiality: typeof import('../../lib/seal/materiality');
  signing: typeof import('../../lib/builds/signing');
  witnessRoute: (req: Request) => Promise<Response>;
  deploymentsRoute: (req: Request) => Promise<Response>;
  unsealedRoute: (req: Request) => Promise<Response>;
};

let M: Mod;

const TENANT = 'seal-vendor-1';
const OTHER = 'seal-vendor-2';
const SURFACE = crypto.createHash('sha256').update('seal tamper surface').digest('hex');
const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const iso = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString();
const DAY = 86_400_000;

let apiKey = '';

/** A manifest with the four boundary classes represented. */
function manifest(over: Partial<Record<string, string>> = {}) {
  return M.measure.normaliseManifest([
    { class: 'capture', id: 'src/capture.ts', source: 'content', sha256: over.capture ?? sha256('capture-v1') },
    { class: 'config', id: 'scruple.hooks.json', source: 'content', sha256: over.config ?? sha256('config-v1') },
    { class: 'dependency', id: 'package-lock.json', source: 'content', sha256: over.dep ?? sha256('lock-v1') },
    { class: 'host', id: 'host:comfyui@0.3.14', source: 'declared', sha256: over.host ?? sha256('comfyui-0.3.14') },
  ]);
}

before(async () => {
  const [sqlite, migrate, seal, measure, materiality, signing, wr, dr, ur] = await Promise.all([
    import('../../lib/db/sqlite'),
    import('../../lib/db/migrate'),
    import('../../lib/seal/registry'),
    import('../../lib/seal/measure'),
    import('../../lib/seal/materiality'),
    import('../../lib/builds/signing'),
    import('../../app/api/v2/witness/route'),
    import('../../app/api/v2/seal/deployments/route'),
    import('../../app/api/v2/seal/unsealed/route'),
  ]);
  migrate.runMigrations(false);
  M = {
    conn: sqlite.conn,
    seal,
    measure,
    materiality,
    signing,
    witnessRoute: wr.POST as unknown as (req: Request) => Promise<Response>,
    deploymentsRoute: dr.GET as unknown as (req: Request) => Promise<Response>,
    unsealedRoute: ur.GET as unknown as (req: Request) => Promise<Response>,
  };

  for (const t of [TENANT, OTHER]) {
    M.conn().prepare(`INSERT INTO users (id, email) VALUES (?, ?)`).run(t, `${t}@example.com`);
  }
  apiKey = `sk_test_${crypto.randomBytes(32).toString('base64url')}`;
  M.conn()
    .prepare(
      `INSERT INTO api_keys (id, user_id, key_hash, key_prefix, scopes_json, label)
       VALUES (?, ?, ?, ?, ?, 'seal')`,
    )
    .run(
      crypto.randomUUID(),
      TENANT,
      sha256(apiKey),
      apiKey.slice(0, 12),
      JSON.stringify(['witness:write', 'read']),
    );
  const now = new Date().toISOString();
  M.conn()
    .prepare(
      `INSERT INTO baselines
         (tenant_id, baseline_hash, manifest_json, attestation_provider,
          signer_pubkey_spki_sha256_hex, submitted_at, activated_at)
       VALUES (?, ?, '{}', 'none', ?, ?, ?)`,
    )
    .run(TENANT, SURFACE, sha256('pubkey'), now, now);
});

after(() => {
  try { fs.rmSync(OWN_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

/** One leaf through the real route handler. */
async function witnessLeaf(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await M.witnessRoute(
    new Request('https://scruple.ai/api/v2/witness', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ baseline_ref: SURFACE, ...body }),
    }),
  );
  const json = (await res.json()) as Record<string, unknown>;
  assert.equal(res.status, 201, `witness returned ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

function leafRow(leafId: string) {
  return M.conn()
    .prepare(`SELECT deployment_id, seal_state, seal_ref FROM iterations WHERE id = ?`)
    .get(Number(leafId)) as { deployment_id: string | null; seal_state: string | null; seal_ref: string | null };
}

/* ═══════════════════════════════════════════════════════════════════════
   1. THE PIPELINE MEASUREMENT
   ═══════════════════════════════════════════════════════════════════ */

describe('the pipeline measurement does not inherit build-measurement.ts\'s traps', () => {
  test('trap 3 — a stray file cannot move it, because nothing is walked', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scruple-walk-'));
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'capture.ts'), 'export const x = 1;\n');
    const declared = () =>
      M.measure.pipelineMeasurement(
        M.measure.declareManifest({ root, content: [{ class: 'capture', path: 'src/capture.ts' }] }),
      );
    const before = declared();
    // The exact thing that moves build-measurement.ts: a colleague's
    // scratch file landing in the source tree. Its walk matches
    // /\.(ts|mts|cts|js|mjs|json)$/ and would fold this in.
    fs.writeFileSync(path.join(root, 'src', 'scratch.ts'), '// left here by mistake\n');
    assert.equal(declared(), before, 'a file nobody declared moved a declared measurement');
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('trap 2 — the sort key is the relative id, by code point, not the input order', () => {
    const entries = [
      { class: 'capture' as const, id: 'src/z.ts', source: 'content' as const, sha256: sha256('z') },
      { class: 'capture' as const, id: 'src/a.ts', source: 'content' as const, sha256: sha256('a') },
      { class: 'config' as const, id: 'b.json', source: 'content' as const, sha256: sha256('b') },
    ];
    const forwards = M.measure.pipelineMeasurement(M.measure.normaliseManifest(entries));
    const backwards = M.measure.pipelineMeasurement(
      M.measure.normaliseManifest([...entries].reverse()),
    );
    assert.equal(forwards, backwards);
    assert.deepEqual(
      M.measure.normaliseManifest(entries).entries.map((e) => e.id),
      ['src/a.ts', 'src/z.ts', 'b.json'],
      'entries sort by "class id", code point order',
    );
  });

  test('trap 2 — an absolute path is refused rather than sorted', () => {
    assert.throws(
      () =>
        M.measure.normaliseManifest([
          { class: 'capture', id: '/opt/app/src/capture.ts', source: 'content', sha256: sha256('x') },
        ]),
      /not a relative POSIX path/,
    );
  });

  test('trap 1 — src/x.ts and dist/x.js are two manifests, and it is legible which', () => {
    const src = M.measure.normaliseManifest([
      { class: 'capture', id: 'src/capture.ts', source: 'content', sha256: sha256('same bytes') },
    ]);
    const dist = M.measure.normaliseManifest([
      { class: 'capture', id: 'dist/capture.js', source: 'content', sha256: sha256('same bytes') },
    ]);
    assert.notEqual(M.measure.pipelineMeasurement(src), M.measure.pipelineMeasurement(dist));
    // And the difference is READABLE, which is the half 045's
    // `measurement_kind` column could only label from the outside.
    assert.equal(src.entries[0].id, 'src/capture.ts');
    assert.equal(dist.entries[0].id, 'dist/capture.js');
  });

  test('a manifest with no capture entry is refused', () => {
    assert.throws(
      () =>
        M.measure.normaliseManifest([
          { class: 'config', id: 'a.json', source: 'content', sha256: sha256('a') },
        ]),
      /No `capture` entry/,
    );
  });

  test('an empty manifest, a duplicate entry and a non-normalised id are all refused', () => {
    assert.throws(() => M.measure.normaliseManifest([]), /no entries/);
    assert.throws(
      () =>
        M.measure.normaliseManifest([
          { class: 'capture', id: 'a.ts', source: 'content', sha256: sha256('1') },
          { class: 'capture', id: 'a.ts', source: 'content', sha256: sha256('2') },
        ]),
      /Duplicate manifest entry/,
    );
    assert.throws(
      () =>
        M.measure.normaliseManifest([
          { class: 'capture', id: 'src/../src/a.ts', source: 'content', sha256: sha256('1') },
        ]),
      /not normalised/,
    );
  });

  test('a missing declared file is an error, not a MISSING placeholder', () => {
    assert.throws(
      () =>
        M.measure.declareManifest({
          root: OWN_DIR,
          content: [{ class: 'capture', path: 'nope/gone.ts' }],
        }),
      /is not present under/,
    );
  });
});

/* ═══════════════════════════════════════════════════════════════════════
   2. MATERIALITY
   ═══════════════════════════════════════════════════════════════════ */

describe('what counts as a material change', () => {
  test('a capture or config edit is material; a dependency bump is not', () => {
    const base = manifest();
    assert.equal(
      M.materiality.classifyManifestChange(base, manifest({ capture: sha256('capture-v2') })).class,
      'material',
    );
    assert.equal(
      M.materiality.classifyManifestChange(base, manifest({ config: sha256('config-v2') })).class,
      'material',
    );
    assert.equal(
      M.materiality.classifyManifestChange(base, manifest({ dep: sha256('lock-v2') })).class,
      'consequential',
    );
  });

  test('a host upgrade is material — "a new upstream release is a new approval"', () => {
    const upgraded = M.measure.normaliseManifest([
      ...manifest().entries.filter((e) => e.class !== 'host'),
      {
        class: 'host',
        id: 'host:comfyui@0.3.14',
        source: 'declared',
        sha256: sha256('comfyui-0.3.15'),
      },
    ]);
    assert.equal(M.materiality.classifyManifestChange(manifest(), upgraded).class, 'material');
  });

  test('adding or removing an entry moves the boundary, so it is material in every class', () => {
    const withExtra = M.measure.normaliseManifest([
      ...manifest().entries,
      { class: 'dependency', id: 'poetry.lock', source: 'content', sha256: sha256('poetry') },
    ]);
    const added = M.materiality.classifyManifestChange(manifest(), withExtra);
    assert.equal(added.class, 'material');
    assert.match(added.reasons.join(' '), /added to the boundary/);

    // The one a permissive rule would miss: deleting the config entry
    // that names the endpoint is how you stop sending leaves.
    const narrowed = M.measure.normaliseManifest(
      manifest().entries.filter((e) => e.class !== 'config'),
    );
    const removed = M.materiality.classifyManifestChange(manifest(), narrowed);
    assert.equal(removed.class, 'material');
    assert.match(removed.reasons.join(' '), /removed from the boundary/);
  });

  test('content -> declared is material even at an identical digest', () => {
    const asserted = M.measure.normaliseManifest(
      manifest().entries.map((e) =>
        e.class === 'dependency' ? { ...e, source: 'declared' as const } : e,
      ),
    );
    const v = M.materiality.classifyManifestChange(manifest(), asserted);
    assert.equal(v.class, 'material');
    assert.match(v.reasons.join(' '), /different party vouching/);
  });

  test('an identical manifest is administrative, and the verdict is the MAXIMUM', () => {
    assert.equal(M.materiality.classifyManifestChange(manifest(), manifest()).class, 'administrative');
    // One material edit inside a pile of dependency churn is a material
    // change. A rule that averaged would be a rule a vendor could dilute.
    const mixed = manifest({ capture: sha256('capture-v2'), dep: sha256('lock-v2') });
    assert.equal(M.materiality.classifyManifestChange(manifest(), mixed).class, 'material');
  });
});

/* ═══════════════════════════════════════════════════════════════════════
   3. THE LIFECYCLE
   ═══════════════════════════════════════════════════════════════════ */

describe('the order of the lifecycle is a mechanism, not a suggestion', () => {
  const D = 'dep-order';

  before(() => {
    M.seal.registerDeployment({ deploymentId: D, tenantId: TENANT, label: 'order' });
  });

  test('a fresh deployment is integrating and cannot claim the standard', () => {
    const st = M.seal.sealStatus(D);
    assert.equal(st.state, 'integrating');
    assert.equal(st.claims_standard, false);
    assert.equal(st.seal_ref, null);
  });

  test('integrating -> sealed is REFUSED: step 2 is not optional', () => {
    const seal = M.seal.issueSeal({ deploymentId: D, manifest: manifest() });
    assert.throws(
      () => M.seal.applySeal(D, seal.seal_ref),
      /cannot go from `integrating` straight to `sealed`/,
    );
    // And the deployment did not move, because a refused transition that
    // half-applied would be worse than one that was allowed.
    assert.equal(M.seal.sealStatus(D).state, 'integrating');
  });

  test('verifying -> sealed is allowed, and only then may it claim', () => {
    M.seal.enterVerification(D, 'conformance probes');
    assert.equal(M.seal.sealStatus(D).state, 'verifying');
    assert.equal(M.seal.sealStatus(D).claims_standard, false);

    const seal = M.seal.listSeals(D)[0];
    M.seal.applySeal(D, seal.seal_ref);
    const st = M.seal.sealStatus(D);
    assert.equal(st.state, 'sealed');
    assert.equal(st.claims_standard, true);
    assert.equal(st.seal_ref, seal.seal_ref);
  });

  test('a second `integrating` is refused — it would erase the fold', () => {
    assert.throws(
      () => M.seal.appendLifecycleEvent({ deploymentId: D, event: 'integrating' }),
      /begins integrating once/,
    );
  });

  test('a future-dated event is refused', () => {
    assert.throws(
      () => M.seal.enterVerification(D, 'later', { effectiveAt: iso(10 * 60_000) }),
      /effective_at is in the future/,
    );
  });

  test('an event predating the deployment itself is refused', () => {
    assert.throws(
      () => M.seal.enterVerification(D, 'earlier', { effectiveAt: iso(-10 * DAY) }),
      /predates the deployment's registration/,
    );
  });

  test('and so is one inserted BEHIND the newest event — that would re-order the fold', () => {
    // Backdating INTO THE GAP is fine (a decision taken at 09:00 and
    // recorded at 11:00 must be able to say 09:00); backdating BEHIND an
    // event already on the record is not, because these are a sequence
    // and re-ordering it can make an already-recorded transition illegal
    // after the fact.
    const B = 'dep-backdate';
    M.seal.registerDeployment({ deploymentId: B, tenantId: TENANT, at: iso(-5 * DAY) });
    M.seal.enterVerification(B, 'probes', { effectiveAt: iso(-4 * DAY) });
    // Into the gap: allowed.
    const ok = M.seal.enterVerification(B, 'more probes', { effectiveAt: iso(-2 * DAY) });
    assert.ok(ok.id);
    // Behind the newest: refused.
    assert.throws(
      () => M.seal.enterVerification(B, 'reordered', { effectiveAt: iso(-3 * DAY) }),
      /before the most recent lifecycle event/,
    );
  });
});

describe('a material change moves a sealed deployment to resealing', () => {
  const D = 'dep-material';
  let sealA = '';
  let sealedAtA = '';

  before(() => {
    M.seal.registerDeployment({ deploymentId: D, tenantId: TENANT });
    M.seal.enterVerification(D);
    sealA = M.seal.issueSeal({ deploymentId: D, manifest: manifest() }).seal_ref;
    sealedAtA = M.seal.applySeal(D, sealA).effective_at;
  });

  test('a dependency bump is recorded as drift and does NOT stop the claim', () => {
    const { verdict, event } = M.seal.declareManifestChange({
      deploymentId: D,
      proposed: manifest({ dep: sha256('lock-v2') }),
    });
    assert.equal(verdict.class, 'consequential');
    assert.equal(event?.event, 'drift');
    const st = M.seal.sealStatus(D);
    assert.equal(st.state, 'sealed');
    assert.equal(st.claims_standard, true);
    assert.equal(st.drift_since_seal, 1);
  });

  test('a capture edit moves it to resealing, and it cannot claim', () => {
    const { verdict, event } = M.seal.declareManifestChange({
      deploymentId: D,
      proposed: manifest({ capture: sha256('capture-v2') }),
    });
    assert.equal(verdict.class, 'material');
    assert.equal(event?.event, 'material_change');
    const st = M.seal.sealStatus(D);
    assert.equal(st.state, 'resealing');
    assert.equal(st.reseal_cause, 'material_change');
    assert.equal(st.claims_standard, false);
    // NOT stamped with the last approval: `resealing` means the
    // configuration moved AWAY from it.
    assert.equal(st.seal_ref, null);
  });

  test('re-asserting the seal already in force does not clear a declared material change', () => {
    assert.throws(
      () => M.seal.applySeal(D, sealA),
      /already the seal in force.*material change/s,
    );
    assert.equal(M.seal.sealStatus(D).state, 'resealing');
  });

  test('a seal over the changed configuration clears it', () => {
    const sealB = M.seal.issueSeal({
      deploymentId: D,
      manifest: manifest({ capture: sha256('capture-v2') }),
    }).seal_ref;
    assert.notEqual(sealB, sealA);
    M.seal.applySeal(D, sealB);
    const st = M.seal.sealStatus(D);
    assert.equal(st.state, 'sealed');
    assert.equal(st.seal_ref, sealB);
    // The drift counter resets with the new approval: those bumps are
    // inside what was just approved.
    assert.equal(st.drift_since_seal, 0);
  });

  test('HISTORICAL: as of the first seal, the fold still says sealed under seal A', () => {
    const then = M.seal.sealStatus(D, sealedAtA);
    assert.equal(then.state, 'sealed');
    assert.equal(then.seal_ref, sealA);
    assert.equal(then.claims_standard, true);
    // And seal A's row is untouched — immutable-append, so a leaf
    // written under it can still be checked against the manifest that
    // was approved at the time.
    const a = M.seal.getSeal(sealA)!;
    assert.equal(M.seal.verifySealMeasurement(a), true);
    assert.equal(
      M.seal.verifySealSignature(a, M.signing.registryPublicKey()!.publicKeyHex),
      true,
      'the first seal must still verify after the reseal',
    );
  });

  test('a material_change against an unsealed deployment is refused', () => {
    const U = 'dep-unsealed';
    M.seal.registerDeployment({ deploymentId: U, tenantId: TENANT });
    assert.throws(
      () => M.seal.declareMaterialChange(U, 'nothing to change'),
      /only meaningful against an approved configuration/,
    );
  });
});

describe('the two bounds that keep the seal honest', () => {
  test('the drift budget forces a reseal once consequential change accumulates', () => {
    const D = 'dep-drift';
    M.seal.registerDeployment({ deploymentId: D, tenantId: TENANT });
    M.seal.enterVerification(D);
    const s = M.seal.issueSeal({ deploymentId: D, manifest: manifest() });
    M.seal.applySeal(D, s.seal_ref);

    for (let i = 0; i < M.materiality.CONSEQUENTIAL_CHANGE_BUDGET - 1; i++) {
      M.seal.recordDrift(D, `lockfile bump ${i}`);
      assert.equal(M.seal.sealStatus(D).state, 'sealed', `bump ${i} should not force a reseal`);
    }
    M.seal.recordDrift(D, 'the one that tips it');
    const st = M.seal.sealStatus(D);
    assert.equal(st.state, 'resealing');
    assert.equal(st.reseal_cause, 'drift_budget');
    assert.equal(st.claims_standard, false);
  });

  test('the term expires a seal nothing touched, and renewal to the SAME seal is legal', () => {
    const D = 'dep-term';
    const long = M.materiality.SEAL_TERM_DAYS + 30;
    M.seal.registerDeployment({ deploymentId: D, tenantId: TENANT, at: iso(-long * DAY) });
    M.seal.enterVerification(D, 'probes', { effectiveAt: iso(-(long - 1) * DAY) });
    const s = M.seal.issueSeal({
      deploymentId: D,
      manifest: manifest(),
      sealedAt: iso(-(long - 2) * DAY),
    });
    M.seal.applySeal(D, s.seal_ref, { effectiveAt: iso(-(long - 2) * DAY) });

    // Sealed the day after it was approved…
    assert.equal(M.seal.sealStatus(D, iso(-(long - 3) * DAY)).state, 'sealed');
    // …and expired by now.
    const now = M.seal.sealStatus(D);
    assert.equal(now.state, 'resealing');
    assert.equal(now.reseal_cause, 'term_expired');
    assert.equal(now.claims_standard, false);
    assert.ok(now.seal_expires_at && now.seal_expires_at < now.as_of);

    // EMV's maintenance approval: nothing changed, so re-applying the
    // same seal is a renewal rather than a fresh approval. This is the
    // case the material-change rule is NOT allowed to block, and the
    // reason the same act IS blocked after a declared material change.
    M.seal.applySeal(D, s.seal_ref, { reason: 'annual renewal, configuration unchanged' });
    const renewed = M.seal.sealStatus(D);
    assert.equal(renewed.state, 'sealed');
    assert.equal(renewed.claims_standard, true);
  });
});

describe('the signature is worth something', () => {
  const D = 'dep-sig';
  let ref = '';

  before(() => {
    M.seal.registerDeployment({ deploymentId: D, tenantId: TENANT });
    M.seal.enterVerification(D);
    ref = M.seal.issueSeal({ deploymentId: D, manifest: manifest(), notes: 'first' }).seal_ref;
    M.seal.applySeal(D, ref);
  });

  test('seals and lifecycle events verify under the registry public key', () => {
    const pub = M.signing.registryPublicKey()!.publicKeyHex;
    assert.equal(M.seal.verifySealSignature(M.seal.getSeal(ref)!, pub), true);
    for (const e of M.seal.lifecycleEvents(D)) {
      assert.equal(M.seal.verifyLifecycleSignature(e, pub), true, `${e.event} did not verify`);
    }
  });

  test('another key does not verify — DB write access is not approval', () => {
    const other = crypto.randomBytes(32).toString('hex');
    const before = process.env.SCRUPLE_BUILD_REGISTRY_KEY_HEX;
    process.env.SCRUPLE_BUILD_REGISTRY_KEY_HEX = other;
    const otherPub = M.signing.registryPublicKey()!.publicKeyHex;
    process.env.SCRUPLE_BUILD_REGISTRY_KEY_HEX = before;
    assert.equal(M.seal.verifySealSignature(M.seal.getSeal(ref)!, otherPub), false);
  });

  test('an edited manifest fails BOTH the recomputation and the signature', () => {
    const tampered = {
      ...M.seal.getSeal(ref)!,
      manifest_json: M.measure.manifestJson(manifest({ capture: sha256('smuggled') })),
    };
    assert.equal(M.seal.verifySealMeasurement(tampered), false, 'the measurement must not reproduce');
    assert.equal(
      M.seal.verifySealSignature(tampered, M.signing.registryPublicKey()!.publicKeyHex),
      false,
    );
  });

  test('the seal ref IS the digest of the signed bytes, so an edited row loses its identity', () => {
    const s = M.seal.getSeal(ref)!;
    const moved = { ...s, sealed_at: new Date(Date.parse(s.sealed_at) + 1000).toISOString() };
    assert.equal(
      M.seal.verifySealSignature(moved, M.signing.registryPublicKey()!.publicKeyHex),
      false,
    );
  });
});

/* ═══════════════════════════════════════════════════════════════════════
   4. THE LOAD-BEARING ONE: LEAVES ARE STAMPED WITH THE STATE THEY WERE
      WRITTEN UNDER
   ═══════════════════════════════════════════════════════════════════ */

describe('a pre-seal leaf is permanently distinguishable from an approved one', () => {
  const D = 'dep-leaves';
  let integratingLeaf = '';
  let verifyingLeaf = '';
  let sealedLeaf = '';
  let resealingLeaf = '';
  let sealA = '';

  before(async () => {
    M.seal.registerDeployment({ deploymentId: D, tenantId: TENANT, label: 'the vendor' });

    // Step 1. Real leaves, from an unsealed pipeline. This is the case
    // INTEGRATION_LIFECYCLE.md exists to make visible.
    integratingLeaf = String(
      (await witnessLeaf({
        kind: 'artifact',
        content_hash: sha256('output-integrating'),
        mime: 'image/png',
        deployment_id: D,
      })).leaf_id,
    );

    // Step 2.
    M.seal.enterVerification(D, 'end-to-end');
    verifyingLeaf = String(
      (await witnessLeaf({
        kind: 'artifact',
        content_hash: sha256('output-verifying'),
        mime: 'image/png',
        deployment_id: D,
      })).leaf_id,
    );

    // Step 3.
    sealA = M.seal.issueSeal({ deploymentId: D, manifest: manifest() }).seal_ref;
    M.seal.applySeal(D, sealA);
    sealedLeaf = String(
      (await witnessLeaf({
        kind: 'artifact',
        content_hash: sha256('output-sealed'),
        mime: 'image/png',
        deployment_id: D,
      })).leaf_id,
    );

    // And a material change afterwards.
    M.seal.declareMaterialChange(D, 'capture rewritten');
    resealingLeaf = String(
      (await witnessLeaf({
        kind: 'artifact',
        content_hash: sha256('output-resealing'),
        mime: 'image/png',
        deployment_id: D,
      })).leaf_id,
    );
  });

  test('every leaf carries the state it was written under', () => {
    assert.equal(leafRow(integratingLeaf).seal_state, 'integrating');
    assert.equal(leafRow(verifyingLeaf).seal_state, 'verifying');
    assert.equal(leafRow(sealedLeaf).seal_state, 'sealed');
    assert.equal(leafRow(resealingLeaf).seal_state, 'resealing');
  });

  test('only the sealed leaf carries a seal_ref', () => {
    assert.equal(leafRow(integratingLeaf).seal_ref, null);
    assert.equal(leafRow(verifyingLeaf).seal_ref, null);
    assert.equal(leafRow(sealedLeaf).seal_ref, sealA);
    // The resealing leaf has a LAST-approved seal and is not stamped with
    // it: `resealing` means the configuration moved away from it, and
    // stamping it would read as "approved under A".
    assert.equal(leafRow(resealingLeaf).seal_ref, null);
  });

  test('and it is PERMANENT — a later reseal does not rewrite earlier leaves', async () => {
    const sealB = M.seal.issueSeal({
      deploymentId: D,
      manifest: manifest({ capture: sha256('capture-v2') }),
    }).seal_ref;
    M.seal.applySeal(D, sealB);
    const after = String(
      (await witnessLeaf({
        kind: 'artifact',
        content_hash: sha256('output-after-reseal'),
        mime: 'image/png',
        deployment_id: D,
      })).leaf_id,
    );

    // This is the acceptance criterion, stated as one assertion: the
    // integration-era leaf and the approved one are still telling two
    // different stories after the vendor sealed twice.
    assert.equal(leafRow(integratingLeaf).seal_state, 'integrating');
    assert.equal(leafRow(integratingLeaf).seal_ref, null);
    assert.equal(leafRow(sealedLeaf).seal_state, 'sealed');
    assert.equal(leafRow(sealedLeaf).seal_ref, sealA, 'the old leaf must keep the OLD seal');
    assert.equal(leafRow(after).seal_ref, sealB);
    assert.notEqual(leafRow(sealedLeaf).seal_ref, leafRow(after).seal_ref);

    // And the manifest the old leaf was written under is still fetchable
    // and still verifies. The fold moved; the evidence did not.
    const a = M.seal.getSeal(sealA)!;
    assert.equal(M.seal.verifySealMeasurement(a), true);
    assert.equal(
      M.seal.verifySealSignature(a, M.signing.registryPublicKey()!.publicKeyHex),
      true,
    );
  });

  test('the response says which side of the line the leaf is on', async () => {
    const r = (await witnessLeaf({
      kind: 'artifact',
      content_hash: sha256('output-response'),
      mime: 'image/png',
      deployment_id: D,
    })).seal as Record<string, unknown>;
    assert.equal(r.deployment_id, D);
    assert.equal(r.state, 'sealed');
    assert.equal(r.claims_standard, true);
  });
});

describe('a leaf is stamped, never refused', () => {
  test('a deployment we do not have is `unregistered`, and the leaf is still written', async () => {
    const r = await witnessLeaf({
      kind: 'artifact',
      content_hash: sha256('output-typo'),
      mime: 'image/png',
      deployment_id: 'dep-that-does-not-exist',
    });
    const seal = r.seal as Record<string, unknown>;
    assert.equal(seal.state, 'unregistered');
    assert.equal(seal.claims_standard, false);
    assert.equal(leafRow(String(r.leaf_id)).seal_state, 'unregistered');
    // Declared, and recorded, so the typo is investigable rather than
    // silent.
    assert.equal(leafRow(String(r.leaf_id)).deployment_id, 'dep-that-does-not-exist');
  });

  test('another tenant\'s sealed deployment is `unregistered`, not `sealed`', async () => {
    const D = 'dep-other-tenant';
    M.seal.registerDeployment({ deploymentId: D, tenantId: OTHER });
    M.seal.enterVerification(D);
    const s = M.seal.issueSeal({ deploymentId: D, manifest: manifest() });
    M.seal.applySeal(D, s.seal_ref);
    assert.equal(M.seal.sealStatus(D).claims_standard, true);

    // A deployment id is a bare string on the wire. Without the tenant
    // check inside checkDeploymentSeal() this would stamp somebody
    // else's `sealed` on this tenant's leaf.
    const r = await witnessLeaf({
      kind: 'artifact',
      content_hash: sha256('output-borrowed'),
      mime: 'image/png',
      deployment_id: D,
    });
    assert.equal((r.seal as Record<string, unknown>).state, 'unregistered');
  });

  test('a leaf that declared nothing is `undeclared` — canvas and the plugins', async () => {
    const r = await witnessLeaf({
      kind: 'artifact',
      content_hash: sha256('output-plain'),
      mime: 'image/png',
    });
    const seal = r.seal as Record<string, unknown>;
    assert.equal(seal.state, 'undeclared');
    assert.equal(seal.deployment_id, null);
    assert.equal(leafRow(String(r.leaf_id)).seal_state, 'undeclared');
    assert.equal(leafRow(String(r.leaf_id)).deployment_id, null);
  });

  test('checkDeploymentSeal never throws', () => {
    assert.doesNotThrow(() => M.seal.checkDeploymentSeal(TENANT, null));
    assert.doesNotThrow(() => M.seal.checkDeploymentSeal(TENANT, 'nope'));
    assert.doesNotThrow(() => M.seal.checkDeploymentSeal(TENANT, 'dep-leaves', 'not-a-date'));
    assert.equal(M.seal.checkDeploymentSeal(TENANT, 'dep-leaves', 'not-a-date').state, 'unchecked');
  });
});

describe('the visibility surfaces', () => {
  const get = (url: string) =>
    new Request(url, { headers: { authorization: `Bearer ${apiKey}` } });

  test('GET /api/v2/seal/deployments lists only this tenant\'s, with the binary note', async () => {
    const res = await M.deploymentsRoute(get('https://scruple.ai/api/v2/seal/deployments'));
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      deployments: { deployment_id: string; state: string; claims_standard: boolean }[];
      note: string;
    };
    const ids = body.deployments.map((d) => d.deployment_id);
    assert.ok(ids.includes('dep-leaves'));
    assert.ok(!ids.includes('dep-other-tenant'), 'another tenant\'s deployment leaked');
    assert.match(body.note, /Compliance is binary/);
    for (const d of body.deployments) {
      assert.equal(d.claims_standard, d.state === 'sealed');
    }
  });

  test('GET /api/v2/seal/unsealed reports the pre-seal leaves and excludes the sealed ones', async () => {
    const res = await M.unsealedRoute(get('https://scruple.ai/api/v2/seal/unsealed'));
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      leaves: { seal_state: string; deployment_id: string | null }[];
    };
    const states = new Set(body.leaves.map((l) => l.seal_state));
    assert.ok(states.has('integrating'));
    assert.ok(states.has('verifying'));
    assert.ok(states.has('resealing'));
    assert.ok(states.has('unregistered'));
    assert.ok(states.has('undeclared'));
    assert.ok(!states.has('sealed'), 'a sealed leaf must not appear on the unsealed report');
  });
});
