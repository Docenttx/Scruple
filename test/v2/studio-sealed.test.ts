// WO-25 — Studio's canvas path, as a registered deployment.
//
// WHAT THIS FILE EXISTS TO PROVE, and one thing it exists to REFUSE to
// prove:
//
//   1. CANVAS LEAVES CARRY A SEAL STATE AND A DEPLOYMENT ID. Before this
//      work order they carried `NULL` — docs/canon/INTEGRATION_LIFECYCLE.md
//      §10 item 6, "which is honest (the question was not asked) but is
//      not the re-grade the direction promises."
//
//   2. THE STATE IS A FOLD AS OF THE LEAF'S OWN INSTANT. A leaf written
//      while `integrating` still says `integrating` after the deployment
//      moves to `verifying`. That is the property the whole as-of design
//      exists for and the one a naive "read the state now" stamp loses.
//
//   3. CANVAS CONSUMES THE SHARED CHECK RATHER THAN REIMPLEMENTING IT.
//      There is one `checkDeploymentSeal` in the estate and the canvas
//      ingest path calls it — STUDIO_IS_AN_EXEMPLAR.md's "Studio consumes;
//      it does not donate", enforced by the fact that the stamp on a
//      canvas leaf moves when the shared registry moves.
//
//   4. THE PIPELINE BOUNDARY IS A SUPERSET OF THE TAMPER SURFACE, and is
//      partitioned so that a lockfile bump and a rewrite of the gate are
//      not the same event.
//
//   AND, THE REFUSAL: THIS FILE ASSERTS THAT CANVAS IS NOT SEALED, and
//   that a named, machine-readable blocking finding says why. A seal on an
//   unmeasured pipeline is the "paperwork checking paperwork" failure that
//   INTEGRATION_LIFECYCLE.md correction 3 was written to close, and the
//   worst possible thing to discover in front of C2PA. If someone ever
//   believes the gap is shut, they have to delete an entry from
//   CANVAS_SEAL_BLOCKERS and say why — they cannot do it by editing prose.
//
// TEST ISOLATION, as the other v2 files explain it: `npm run test:v2` runs
// every file CONCURRENTLY against one shared SCRUPLE_DB_PATH, so this file
// takes its own private database, assigned at module top level, with every
// module that reaches lib/db/sqlite imported DYNAMICALLY inside before().

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (!process.env.SCRUPLE_DB_PATH || !/tmp|test/i.test(process.env.SCRUPLE_DB_PATH)) {
  throw new Error('Refusing to run: set SCRUPLE_DB_PATH to a throwaway path. Use `npm run test:v2`.');
}
const OWN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-sealed-'));
process.env.SCRUPLE_DB_PATH = path.join(OWN_DIR, 'studio.db');
process.env.SCRUPLE_BUILD_REGISTRY_KEY_HEX = 'c9'.repeat(32);
// THE STANDING SAFETY RULE. 127.0.0.1:5799 is the PRODUCTION witness and a
// test that reaches it writes into a real audit log, which has happened
// once already. Port 1 refuses instantly; ingest swallows that by design
// (capture is non-blocking) and still writes the leaf row, which is all
// this file reads.
process.env.WITNESS_SERVER_URL = 'http://127.0.0.1:1';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

type Mod = {
  runMigrations: typeof import('../../lib/db/migrate').runMigrations;
  conn: typeof import('../../lib/db/sqlite').conn;
  seal: typeof import('../../lib/seal/registry');
  measure: typeof import('../../lib/seal/measure');
  materiality: typeof import('../../lib/seal/materiality');
  deployment: typeof import('../../lib/canvas/deployment');
  baseline: typeof import('../../lib/canvas/baseline');
  canvasWitness: typeof import('../../lib/canvas/witness');
  ingest: typeof import('../../lib/iterations/ingest');
  classes: typeof import('../../lib/capture/classes');
  conformanceSeal: typeof import('../../packages/scruple-conformance/src/seal');
};

let M: Mod;
const USER = 'u_studio_seal';
let PROJECT_ID = 0;
/** Artifact hashes this file wrote into the repo's content store. */
const WROTE: string[] = [];

before(async () => {
  M = {
    runMigrations: (await import('../../lib/db/migrate')).runMigrations,
    conn: (await import('../../lib/db/sqlite')).conn,
    seal: await import('../../lib/seal/registry'),
    measure: await import('../../lib/seal/measure'),
    materiality: await import('../../lib/seal/materiality'),
    deployment: await import('../../lib/canvas/deployment'),
    baseline: await import('../../lib/canvas/baseline'),
    canvasWitness: await import('../../lib/canvas/witness'),
    ingest: await import('../../lib/iterations/ingest'),
    classes: await import('../../lib/capture/classes'),
    conformanceSeal: await import('../../packages/scruple-conformance/src/seal'),
  };

  M.runMigrations();
  const db = M.conn();
  db.prepare(`INSERT OR IGNORE INTO users (id, email) VALUES (?, ?)`).run(USER, 'studio@test');
  PROJECT_ID = Number(
    db
      .prepare(
        `INSERT INTO projects (user_id, name, is_active, created_at)
         VALUES (?, 'studio-seal', 1, datetime('now'))`,
      )
      .run(USER).lastInsertRowid,
  );
});

after(() => {
  // The content-addressed store is `process.cwd()/artifacts`, which is the
  // repo. Only the files this file put there are removed — a blanket wipe
  // would delete a developer's working artifacts for a test's convenience.
  for (const h of WROTE) {
    try {
      fs.rmSync(path.join(REPO_ROOT, 'artifacts', h.slice(0, 2), h), { force: true });
    } catch {
      /* the store is gitignored either way */
    }
  }
  try {
    fs.rmSync(OWN_DIR, { recursive: true, force: true });
  } catch {
    /* the tmpdir outlives the assertion */
  }
});

/** One real canvas-shaped ingest. Not a stand-in: the whole point is the
 *  row the REAL path writes. */
async function ingestOne(bytes: Buffer) {
  const r = await M.ingest.ingestIteration({
    userId: USER,
    projectId: PROJECT_ID,
    provider: 'comfydeploy',
    providerJobId: `p-${bytes.length}-${Math.random().toString(16).slice(2)}`,
    prompt: '(canvas workflow / modal)',
    spec: { prompt: '(canvas workflow)' } as never,
    imageBytes: bytes,
    imageContentType: 'image/png',
    imageFilename: 'x.png',
    deployment: M.deployment.canvasDeploymentRef(),
  });
  if (r.iteration.output_hash) WROTE.push(r.iteration.output_hash);
  return r;
}

function leafRow(id: number) {
  return M.conn()
    .prepare(`SELECT deployment_id, seal_state, seal_ref, timestamp FROM iterations WHERE id = ?`)
    .get(id) as {
    deployment_id: string | null;
    seal_state: string | null;
    seal_ref: string | null;
    timestamp: string;
  };
}

/* ────────────────────────────────────────────────────────────────────── */

describe('WO-25 — canvas is a registered deployment', () => {
  test('migration 047 registers the deployment as a NAME, with no unsigned claim beside it', () => {
    const dep = M.seal.getDeployment(M.deployment.CANVAS_DEPLOYMENT_ID);
    assert.ok(dep, 'migration 047 should have registered the canvas deployment');
    assert.equal(dep.tenant_id, M.deployment.CANVAS_DEPLOYMENT_TENANT);
    assert.equal(dep.created_at, M.deployment.CANVAS_DEPLOYMENT_CREATED_AT);

    // AND NOTHING SIGNED. A migration has no key; a row in
    // deployment_lifecycle_events that nobody signed would be a claim
    // nobody made. "Write access to the database is not publication."
    assert.equal(M.seal.lifecycleEvents(M.deployment.CANVAS_DEPLOYMENT_ID).length, 0);

    // The fold over zero events is `integrating`, and it does not claim.
    const st = M.seal.sealStatus(M.deployment.CANVAS_DEPLOYMENT_ID);
    assert.equal(st.known, true);
    assert.equal(st.state, 'integrating');
    assert.equal(st.claims_standard, false);
  });

  test('the platform tenant is not a spelling any request can carry', () => {
    // `checkDeploymentSeal` compares the deployment's owner against the
    // CALLING tenant. Canvas's owner is Scruple-as-vendor, so a leaf
    // ingested for an ordinary user id must not resolve it by accident.
    const asUser = M.seal.checkDeploymentSeal(USER, M.deployment.CANVAS_DEPLOYMENT_ID);
    assert.equal(asUser.state, 'unregistered');
    const asOwner = M.deployment.canvasSealStamp();
    assert.equal(asOwner.state, 'integrating');
  });
});

describe('WO-25 — a canvas leaf carries the state it was written under', () => {
  let earlyLeafId = 0;
  let earlyAt = '';

  test('a canvas ingest writes deployment_id and seal_state, not NULL', async () => {
    const r = await ingestOne(Buffer.from('canvas-bytes-one'));
    earlyLeafId = r.iteration.id;
    const row = leafRow(earlyLeafId);
    earlyAt = row.timestamp;

    assert.equal(row.deployment_id, M.deployment.CANVAS_DEPLOYMENT_ID);
    assert.equal(row.seal_state, 'integrating');
    // `seal_ref` is NULL unless the state is `sealed`. Migration 046: a
    // leaf not written under an approval must not read as approved under
    // one.
    assert.equal(row.seal_ref, null);
    // And the result says so, so a caller cannot report success
    // identically either way — `witnessed`'s own argument, one field over.
    assert.equal(r.seal.state, 'integrating');
  });

  test('a caller that names no deployment gets `undeclared`, which is a different fact', async () => {
    const r = await M.ingest.ingestIteration({
      userId: USER,
      projectId: PROJECT_ID,
      provider: 'comfydeploy',
      providerJobId: `p-undeclared-${Math.random().toString(16).slice(2)}`,
      prompt: 'no deployment',
      spec: { prompt: 'no deployment' } as never,
      imageBytes: Buffer.from('no-deployment-bytes'),
      imageContentType: 'image/png',
    });
    if (r.iteration.output_hash) WROTE.push(r.iteration.output_hash);
    const row = leafRow(r.iteration.id);
    assert.equal(row.deployment_id, null);
    assert.equal(row.seal_state, 'undeclared');
    // NOT NULL. NULL now means only "written before the question existed".
    assert.notEqual(row.seal_state, null);
  });

  test('moving to `verifying` does not reach backwards', async () => {
    // The signed event an operator records with `lib/seal/cli.ts
    // verifying`. It is signed here because signing is what makes it a
    // claim; migration 047 deliberately could not.
    M.seal.enterVerification(
      M.deployment.CANVAS_DEPLOYMENT_ID,
      'WO-25 — real leaves flowing from an unsealed pipeline; probes outstanding',
    );
    assert.equal(M.seal.sealStatus(M.deployment.CANVAS_DEPLOYMENT_ID).state, 'verifying');

    const later = await ingestOne(Buffer.from('canvas-bytes-two'));
    assert.equal(leafRow(later.iteration.id).seal_state, 'verifying');

    // THE LOAD-BEARING HALF. The earlier leaf still says what was true
    // when it was written.
    assert.equal(leafRow(earlyLeafId).seal_state, 'integrating');
    assert.ok(earlyAt.length > 0);
    // And the registry agrees when asked as of that instant.
    assert.equal(
      M.seal.sealStatus(M.deployment.CANVAS_DEPLOYMENT_ID, earlyAt).state,
      'integrating',
    );
  });

  test('both unsealed canvas leaves are visible on the estate-wide report', () => {
    const rows = M.seal.unsealedLeaves(50);
    const mine = rows.filter((r) => r.deployment_id === M.deployment.CANVAS_DEPLOYMENT_ID);
    assert.ok(mine.length >= 2, 'canvas leaves should appear on GET /api/v2/seal/unsealed');
    assert.ok(mine.every((r) => r.seal_state !== 'sealed'));
  });

  test('canvas consumes the shared check — the stamp moves when the registry moves', () => {
    // If canvas had kept a parallel implementation of the fold, an event
    // appended through lib/seal/registry.ts would not be visible to it.
    const before = M.deployment.canvasSealStamp().state;
    assert.equal(before, 'verifying');
    assert.equal(
      before,
      M.seal.checkDeploymentSeal(
        M.deployment.CANVAS_DEPLOYMENT_TENANT,
        M.deployment.CANVAS_DEPLOYMENT_ID,
      ).state,
      'canvasSealStamp must BE checkDeploymentSeal, not resemble it',
    );
  });
});

describe('WO-25 — the pipeline boundary', () => {
  const HOST_HASH = 'ab'.repeat(32);

  const manifest = () =>
    M.deployment.canvasPipelineManifest({
      hostManifestHash: HOST_HASH,
      witnessEndpoint: 'https://witness.example/',
      root: REPO_ROOT,
    });

  test('all four boundary classes are populated, and each earns its place', () => {
    const m = manifest();
    const byClass = new Map<string, number>();
    for (const e of m.entries) byClass.set(e.class, (byClass.get(e.class) ?? 0) + 1);
    for (const c of M.measure.BOUNDARY_CLASSES) {
      assert.ok((byClass.get(c) ?? 0) > 0, `boundary class \`${c}\` is empty`);
    }
    // The measurement is reproducible from the manifest alone.
    assert.equal(
      M.measure.pipelineMeasurement(M.measure.parseManifestJson(M.measure.manifestJson(m))),
      M.measure.pipelineMeasurement(m),
    );
  });

  test('the boundary is a SUPERSET of the 23-file tamper surface', () => {
    // `boundaryOmissions` is the grader's own containment check: a
    // declared capture file sitting outside the measurement is a finding,
    // because the seal does not cover it.
    const omitted = M.conformanceSeal.boundaryOmissions(manifest(), M.baseline.TRACKED);
    assert.deepEqual(omitted, [], 'every tamper-surface file must be inside the pipeline boundary');
  });

  test('it contains the one file the tamper surface CANNOT contain', () => {
    // baseline.ts excludes itself because it carries its own recorded
    // hash — a fixpoint, not a measurement. The pipeline manifest is
    // stored on the seal row instead of in the file, so no fixpoint
    // arises, and baseline.ts is where canvas's placement, enforcement,
    // surfaces and `attestation: none` are DECLARED.
    const ids = new Set(manifest().entries.map((e) => e.id));
    assert.ok(ids.has('lib/canvas/baseline.ts'));
    assert.ok(
      M.baseline.EXCLUDED.some((e) => e.path === 'lib/canvas/baseline.ts'),
      'and it is still, correctly, excluded from its own tamper surface',
    );
  });

  test('the host image is inside the boundary as a DECLARED digest', () => {
    // The tamper surface excludes `modal/**` on the grounds that the image
    // is "measured separately and better". Separately is what a pipeline
    // measurement exists to end: a new upstream release is a new
    // measurement and a new approval.
    const host = manifest().entries.filter((e) => e.class === 'host');
    assert.equal(host.length, 1);
    assert.equal(host[0].source, 'declared');
    assert.equal(host[0].sha256, HOST_HASH);
  });

  test('the credential entry digests WHERE the secret comes from, never the secret', () => {
    const cred = manifest().entries.find((e) => e.id === 'config:upstream-credential-source')!;
    assert.equal(cred.source, 'declared');
    assert.equal(cred.sha256, M.measure.declaredDigest('env:SCRUPLE_CANVAS_SHARED_SECRET'));
    // A manifest is stored in full on a signed row and read by auditors.
    // A digest of a secret would be an offline oracle against it.
    const secret = 'a-real-looking-shared-secret';
    process.env.SCRUPLE_CANVAS_SHARED_SECRET = secret;
    try {
      assert.notEqual(cred.sha256, M.measure.declaredDigest(secret));
    } finally {
      delete process.env.SCRUPLE_CANVAS_SHARED_SECRET;
    }
  });

  test('a lockfile bump and a gate rewrite are NOT the same event', () => {
    const approved = manifest();
    const bump = M.measure.normaliseManifest(
      approved.entries.map((e) =>
        e.id === 'package-lock.json' ? { ...e, sha256: 'cd'.repeat(32) } : e,
      ),
    );
    const rewrite = M.measure.normaliseManifest(
      approved.entries.map((e) =>
        e.id === 'lib/canvas/gate.ts' ? { ...e, sha256: 'cd'.repeat(32) } : e,
      ),
    );
    assert.equal(M.materiality.classifyManifestChange(approved, bump).class, 'consequential');
    assert.equal(M.materiality.classifyManifestChange(approved, rewrite).class, 'material');
    assert.equal(M.materiality.classifyManifestChange(approved, rewrite).requires_reseal, true);

    // And the endpoint. Kohya is the standing proof that a configuration
    // change turns capture off while looking like a quiet afternoon.
    const moved = M.deployment.canvasPipelineManifest({
      hostManifestHash: HOST_HASH,
      witnessEndpoint: 'https://somewhere.else/',
      root: REPO_ROOT,
    });
    assert.equal(M.materiality.classifyManifestChange(approved, moved).class, 'material');
  });

  test('a host upgrade is a new measurement and a new approval', () => {
    const approved = manifest();
    const upgraded = M.deployment.canvasPipelineManifest({
      hostManifestHash: 'ef'.repeat(32),
      witnessEndpoint: 'https://witness.example/',
      root: REPO_ROOT,
    });
    assert.equal(M.materiality.classifyManifestChange(approved, upgraded).class, 'material');
  });

  test('every exclusion carries a reason a reader can check', () => {
    assert.ok(M.deployment.PIPELINE_EXCLUDED.length >= 4);
    for (const e of M.deployment.PIPELINE_EXCLUDED) {
      assert.ok(e.reason.length > 60, `${e.id} needs a reason, not a label`);
    }
    // The one that is a FINDING and not merely a scoping choice.
    assert.ok(
      M.deployment.PIPELINE_EXCLUDED.some((e) => e.id === 'app/api/v2/witness/route.ts'),
      'canvas not traversing /v2/witness must be recorded, not omitted',
    );
  });
});

describe('WO-25 — the class, the locus, and what they do NOT yet permit', () => {
  test('canvas declares `inference-host`, and P-04 is exempt only because it declares no filesystem-watch', () => {
    const profile = M.canvasWitness.canvasCaptureProfile();
    assert.deepEqual(profile.capabilityClasses, ['inference-host']);
    assert.ok(!profile.surfaces.includes('filesystem-watch'));

    const scope = M.classes.scopeProfile(profile);
    const p4 = scope.probes.find((p) => p.item === 'P-04')!;
    assert.equal(p4.status, 'not-applicable');
    // CONTINGENT, not absolute. Declare the surface and probe 4 is
    // required again — an item nobody decided about is the state the class
    // layer exists to end.
    const withFs = M.classes.scopeProfile({
      ...profile,
      surfaces: [...profile.surfaces, 'filesystem-watch'],
    });
    assert.equal(withFs.probes.find((p) => p.item === 'P-04')!.status, 'required');
  });

  test('with no probe run, every required probe is `unmeasured` — which is not passed', () => {
    const scope = M.classes.scopeProfile(M.canvasWitness.canvasCaptureProfile());
    const required = scope.probes.filter((p) => p.status === 'required');
    assert.ok(required.length >= 5);
    assert.ok(
      required.every((p) => p.outcome === 'unmeasured'),
      'a required probe with no admissible result is `unmeasured`, never `satisfied`',
    );
  });

  test('the locus is `vendor-custody`, and the sentence it unlocks is CONDITIONAL', () => {
    const a = M.canvasWitness.canvasAssurance();
    assert.ok(a.custody);
    assert.equal(a.custody!.locus, 'vendor-custody');
    assert.equal(a.custody!.resolution.honoured, true);
    assert.equal(a.custody!.claim, 'complete-history');
    // The condition is the whole point: `complete-history` is permitted
    // ONLY while no path the measured party can reach writes into the
    // custody store without crossing the pipeline, evidenced by probe 4
    // from an occupied position or by the class-checked absence of a
    // filesystem egress path. Canvas has neither.
    assert.ok(
      a.custody!.conditions.some((c) => /probe 4 from an occupied tenant position/.test(c)),
      'the history condition must be carried, not implied',
    );
  });

  test('and the conditional sentence is WITHHELD, not printed with an asterisk', () => {
    // scopeProfile promotes "this is the complete history of the project"
    // into canvas's permitted list the moment vendor-custody is declared —
    // correct as a rule, premature as a fact. A conditions array nobody
    // evaluates is a caveat, and a caveat beside a permitted sentence is
    // how a true specific claim launders a false general one.
    const scoped = M.classes.scopeProfile(M.canvasWitness.canvasCaptureProfile(), {
      effectivePlacement: M.canvasWitness.canvasAssurance().custody!.placement,
    });
    assert.ok(scoped.permittedClaims.includes('this is the complete history of the project'));

    const today = M.canvasWitness.canvasClaimsToday();
    assert.ok(
      !today.permitted.includes('this is the complete history of the project'),
      'canvas must not be able to say this while the history condition is unevidenced',
    );
    assert.equal(today.withheld.length, 1);
    assert.equal(today.withheld[0].blocker, 'CSB-03');
    // A subtraction only: it can never permit what the class did not.
    for (const c of today.permitted) assert.ok(scoped.permittedClaims.includes(c));
    // What canvas CAN say is still worth something, and is what
    // CANVAS_BASELINE.md §7 already words narrowly.
    assert.ok(today.permitted.includes('Scruple-witnessed inference'));
  });
});

describe('WO-25 — the refusal: canvas is NOT sealed, and the reason is machine-readable', () => {
  test('there are named blocking findings, and the probe gap is one of them', () => {
    const blockers = M.deployment.CANVAS_SEAL_BLOCKERS;
    assert.ok(blockers.length > 0, 'if this is ever empty, say why in the commit');
    for (const b of blockers) {
      assert.match(b.id, /^CSB-\d\d$/);
      assert.ok(b.finding.length > 80, `${b.id} needs a finding, not a label`);
      assert.ok(b.clears_when.length > 40, `${b.id} must say what would clear it`);
    }
    assert.ok(
      blockers.some((b) => /probe/i.test(b.finding) && /tenant position/i.test(b.finding)),
      'the probe-position gap is the blocking finding and must be named as such',
    );
    // The custody condition and the probe gap are the SAME gap on two
    // axes; both are recorded so neither can be closed by forgetting.
    assert.ok(blockers.some((b) => b.id === 'CSB-03'));
  });

  test('canvas has not claimed the standard, and the grader agrees', () => {
    const st = M.seal.sealStatus(M.deployment.CANVAS_DEPLOYMENT_ID);
    assert.equal(st.claims_standard, false);
    const currency = M.conformanceSeal.sealCurrency({
      status: st,
      approvedManifest: null,
      approvedMeasurement: null,
      observed: null,
    });
    assert.equal(currency.state, 'not-sealed');
    assert.equal(M.seal.listSeals(M.deployment.CANVAS_DEPLOYMENT_ID).length, 0);
  });

  test('and the lifecycle itself refuses the shortcut', () => {
    // Not canvas-specific, and asserted here because it is the mechanism
    // this work order was most tempted to route around: step 2 is not
    // optional, and a deployment that has never verified cannot seal.
    const other = 'wo25-shortcut-probe';
    M.seal.registerDeployment({ deploymentId: other, tenantId: 'platform:scruple-studio' });
    const s = M.seal.issueSeal({
      deploymentId: other,
      manifest: M.measure.normaliseManifest([
        { class: 'capture', id: 'x.ts', source: 'content', sha256: '00'.repeat(32) },
      ]),
    });
    assert.throws(
      () => M.seal.applySeal(other, s.seal_ref),
      /cannot go from `integrating` straight to `sealed`/,
    );
  });
});
