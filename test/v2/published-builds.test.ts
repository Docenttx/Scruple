// The published-builds registry (H-4 §4.3, §10 C-4 — WO-15).
//
// The four properties this file exists to demonstrate rather than assert:
//
//   * A LEAF FROM AN UNPUBLISHED BUILD IS DISTINGUISHABLE AT INGEST — and
//     is NOT rejected. Both halves are asserted, because either alone is
//     the wrong design: rejecting destroys evidence of an artifact that
//     already exists, and accepting quietly is the silence H-4 exists to
//     end.
//   * A WITHDRAWN BUILD STILL VERIFIES LEAVES SIGNED BEFORE WITHDRAWAL.
//     Status is a fold as of a time; a later event cannot reach backwards.
//   * Withdrawal is not deletion and publication is not mutation — the
//     publication row and its signature are byte-identical after a
//     withdrawal.
//   * The signature is worth something: only a key-holder can create an
//     entry that verifies, so DB write access alone is not publication.
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
const OWN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'scruple-builds-'));
process.env.SCRUPLE_DB_PATH = path.join(OWN_DIR, 'builds.db');
process.env.SCRUPLE_BDK_HEX = 'c3'.repeat(32);
// The registry signing key. Publishing FAILS CLOSED without one, which
// one test below asserts by unsetting it.
process.env.SCRUPLE_BUILD_REGISTRY_KEY_HEX = 'd4'.repeat(32);
// Standing safety rule: nothing here reaches the production witness.
process.env.WITNESS_SERVER_URL = 'http://127.0.0.1:1';

type Mod = {
  conn: typeof import('../../lib/db/sqlite').conn;
  runMigrations: typeof import('../../lib/db/migrate').runMigrations;
  reg: typeof import('../../lib/builds/registry');
  signing: typeof import('../../lib/builds/signing');
  issueProvisioningToken: typeof import('../../lib/ratchet/provisioning').issueProvisioningToken;
  redeemProvisioningToken: typeof import('../../lib/ratchet/provisioning').redeemProvisioningToken;
  verifySubmission: typeof import('../../lib/ratchet/verify').verifySubmission;
  deriveIk: typeof import('../../lib/ratchet/ratchet').deriveIk;
  Ratchet: typeof import('../../lib/ratchet/ratchet').Ratchet;
  bdk: typeof import('../../lib/ratchet/bdk').bdk;
  buildMeasurement: typeof import('../../services/scruple-capture/src/build-measurement').buildMeasurement;
  listRoute: (req: Request) => Promise<Response>;
  oneRoute: (req: Request, ctx: { params: Promise<{ measurement: string }> }) => Promise<Response>;
  unrecognisedRoute: (req: Request) => Promise<Response>;
};

let M: Mod;
const TENANT = 'builds-vendor-1';
const OTHER = 'builds-vendor-2';
const PRINCIPAL = { userId: TENANT, keyId: 'key-builds-1' };
const OTHER_PRINCIPAL = { userId: OTHER, keyId: 'key-builds-2' };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const measurement = (seed: string) =>
  'sha256:' + crypto.createHash('sha256').update(seed).digest('hex');

function issueKey(userId: string, scopes: string[]): string {
  const plaintext = `sk_test_${crypto.randomBytes(32).toString('base64url')}`;
  M.conn()
    .prepare(
      `INSERT INTO api_keys (id, user_id, key_hash, key_prefix, scopes_json, label)
       VALUES (?, ?, ?, ?, ?, 'test')`,
    )
    .run(
      crypto.randomUUID(),
      userId,
      crypto.createHash('sha256').update(plaintext).digest('hex'),
      plaintext.slice(0, 12),
      JSON.stringify(scopes),
    );
  return plaintext;
}

/** Provision a component and hand back the ratchet it would itself hold. */
function provisioned(build: string, tenant = TENANT) {
  const { componentId, token } = M.issueProvisioningToken({ tenantId: tenant });
  const r = M.redeemProvisioningToken({ token, tenantId: tenant, buildMeasurement: build });
  assert.ok(r.ok);
  return { componentId, ratchet: new M.Ratchet(M.deriveIk(M.bdk(), componentId), 0) };
}

/** One genuine, MACed submission through the real ingest path. */
function submit(
  c: { componentId: string; ratchet: InstanceType<Mod['Ratchet']> },
  n: number,
  build?: string | null,
  principal = PRINCIPAL,
) {
  const f = {
    component_id: c.componentId,
    counter: n,
    content_hash: crypto.createHash('sha256').update(`e${n}`).digest('hex'),
  };
  const { counter, mac } = c.ratchet.mac(f);
  return M.verifySubmission(principal, {
    componentId: c.componentId,
    counter,
    mac,
    preimage: f,
    buildMeasurement: build,
  });
}

before(async () => {
  const [sqlite, migrate, reg, signing, prov, verify, ratchet, bdkMod, bm, listR, oneR, unrecR] =
    await Promise.all([
      import('../../lib/db/sqlite'),
      import('../../lib/db/migrate'),
      import('../../lib/builds/registry'),
      import('../../lib/builds/signing'),
      import('../../lib/ratchet/provisioning'),
      import('../../lib/ratchet/verify'),
      import('../../lib/ratchet/ratchet'),
      import('../../lib/ratchet/bdk'),
      import('../../services/scruple-capture/src/build-measurement'),
      import('../../app/api/v2/builds/route'),
      import('../../app/api/v2/builds/[measurement]/route'),
      import('../../app/api/v2/builds/unrecognised/route'),
    ]);
  M = {
    conn: sqlite.conn,
    runMigrations: migrate.runMigrations,
    reg,
    signing,
    issueProvisioningToken: prov.issueProvisioningToken,
    redeemProvisioningToken: prov.redeemProvisioningToken,
    verifySubmission: verify.verifySubmission,
    deriveIk: ratchet.deriveIk,
    Ratchet: ratchet.Ratchet,
    bdk: bdkMod.bdk,
    buildMeasurement: bm.buildMeasurement,
    listRoute: listR.GET as unknown as Mod['listRoute'],
    oneRoute: oneR.GET as unknown as Mod['oneRoute'],
    unrecognisedRoute: unrecR.GET as unknown as Mod['unrecognisedRoute'],
  };
  M.runMigrations(false);
  M.conn().prepare(`INSERT INTO users (id, email) VALUES (?, 'b1@example.com')`).run(TENANT);
  M.conn().prepare(`INSERT INTO users (id, email) VALUES (?, 'b2@example.com')`).run(OTHER);
});

after(() => {
  try {
    fs.rmSync(OWN_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// ---------------------------------------------------------------------------
describe('migration 045 — the shape C-4 said was missing', () => {
  test('published_builds and published_build_events both exist', () => {
    const names = new Set(
      (M.conn().prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as {
        name: string;
      }[]).map((r) => r.name),
    );
    assert.ok(names.has('published_builds'));
    assert.ok(names.has('published_build_events'));
  });

  test('component_events.build_status exists and is NULLABLE — "not asked" is not "unpublished"', () => {
    const cols = M.conn().prepare(`PRAGMA table_info(component_events)`).all() as {
      name: string;
      notnull: number;
      dflt_value: string | null;
    }[];
    const c = cols.find((x) => x.name === 'build_status');
    assert.ok(c, 'build_status column missing');
    assert.equal(c!.notnull, 0);
    // No default. A default would give every pre-045 row an answer to a
    // question nobody asked of it.
    assert.equal(c!.dflt_value, null);
  });

  test('the measurement CHECK refuses anything that is not sha256:<64 hex>', () => {
    assert.throws(() =>
      M.conn()
        .prepare(
          `INSERT INTO published_builds
             (measurement, component_name, version, published_at,
              signing_key_id, signature, entry_sha256)
           VALUES ('sha256:NOTHEX', 'x', '1', '2026-01-01T00:00:00Z', 'k', 's', 'h')`,
        )
        .run(),
    );
  });
});

// ---------------------------------------------------------------------------
describe('publication — immutable, append-only, signed', () => {
  const B = measurement('publication-1');

  test('publishing writes a signed entry that verifies under the public key', () => {
    const entry = M.reg.publishBuild({
      measurement: B,
      componentName: 'scruple-capture',
      version: '0.1.0-test',
    });
    const pub = M.signing.registryPublicKey()!;
    assert.equal(entry.signing_key_id, pub.keyId);
    assert.equal(entry.signature_alg, 'ed25519');
    assert.ok(M.reg.verifyPublicationSignature(entry, pub.publicKeyHex));
  });

  test('a row edited in the database no longer verifies — write access is not publication', () => {
    const stored = M.reg.getBuild(B)!;
    const forged = { ...stored, version: '9.9.9' };
    assert.equal(
      M.reg.verifyPublicationSignature(forged, M.signing.registryPublicKey()!.publicKeyHex),
      false,
    );
  });

  test('and it does not verify under a different key either', () => {
    const other = M.signing.generateSeedHex();
    const saved = process.env.SCRUPLE_BUILD_REGISTRY_KEY_HEX;
    process.env.SCRUPLE_BUILD_REGISTRY_KEY_HEX = other;
    const otherPub = M.signing.registryPublicKey()!.publicKeyHex;
    process.env.SCRUPLE_BUILD_REGISTRY_KEY_HEX = saved;
    assert.equal(M.reg.verifyPublicationSignature(M.reg.getBuild(B)!, otherPub), false);
  });

  test('publishing the same measurement twice is refused — the table is append-only', () => {
    assert.throws(
      () => M.reg.publishBuild({ measurement: B, componentName: 'scruple-capture', version: '0.2.0' }),
      /already published/,
    );
  });

  test('a malformed measurement is refused', () => {
    assert.throws(
      () => M.reg.publishBuild({ measurement: 'sha256:zz', componentName: 'x', version: '1' }),
      /Not a measurement/,
    );
  });

  test('a publication dated in the future is refused, so "never shipped" and "ships Tuesday" cannot collide', () => {
    assert.throws(
      () =>
        M.reg.publishBuild({
          measurement: measurement('future'),
          componentName: 'x',
          version: '1',
          publishedAt: new Date(Date.now() + 86_400_000).toISOString(),
        }),
      /future/,
    );
  });

  test('publishing FAILS CLOSED with no signing key — and only publishing does', () => {
    const saved = process.env.SCRUPLE_BUILD_REGISTRY_KEY_HEX;
    delete process.env.SCRUPLE_BUILD_REGISTRY_KEY_HEX;
    try {
      assert.throws(
        () => M.reg.publishBuild({ measurement: measurement('nokey'), componentName: 'x', version: '1' }),
        /SCRUPLE_BUILD_REGISTRY_KEY_HEX/,
      );
      // Reading, and therefore INGEST, is unaffected. Failing closed on a
      // write path costs no evidence; failing closed on ingest would.
      assert.equal(M.reg.checkClaimedBuild(B), 'published');
    } finally {
      process.env.SCRUPLE_BUILD_REGISTRY_KEY_HEX = saved;
    }
  });
});

// ---------------------------------------------------------------------------
describe('withdrawal — not deletion, and it does not reach backwards', () => {
  const B = measurement('withdrawn-1');
  const T0 = '2026-08-01T00:00:00.000Z';
  const T_WITHDRAW = '2026-08-10T00:00:00.000Z';

  before(() => {
    M.reg.publishBuild({
      measurement: B,
      componentName: 'scruple-capture',
      version: '0.0.9',
      publishedAt: T0,
    });
  });

  test('before withdrawal it is published', () => {
    assert.equal(M.reg.buildRegistryStatus(B).status, 'published');
  });

  test('withdrawal leaves the publication row and its signature byte-identical', () => {
    const before = M.reg.getBuild(B)!;
    M.reg.withdrawBuild(B, 'a dependency CVE', { effectiveAt: T_WITHDRAW });
    const after = M.reg.getBuild(B)!;
    assert.deepEqual(after, before);
    assert.ok(
      M.reg.verifyPublicationSignature(after, M.signing.registryPublicKey()!.publicKeyHex),
    );
  });

  test('the build is still IN the registry — withdrawal is a fact appended, never a row removed', () => {
    assert.ok(M.reg.listBuilds().some((b) => b.measurement === B));
    assert.equal(M.reg.buildRegistryStatus(B).known, true);
  });

  test('AS OF a moment before the withdrawal it is still published', () => {
    assert.equal(M.reg.buildRegistryStatus(B, '2026-08-05T00:00:00.000Z').status, 'published');
    assert.equal(M.reg.buildRegistryStatus(B, T_WITHDRAW).status, 'withdrawn');
    assert.equal(M.reg.buildRegistryStatus(B).status, 'withdrawn');
  });

  test('as of a moment before PUBLICATION it is unpublished, and the entry still says why', () => {
    const st = M.reg.buildRegistryStatus(B, '2026-07-01T00:00:00.000Z');
    assert.equal(st.status, 'unpublished');
    assert.equal(st.known, true);
    assert.equal(st.entry!.published_at, T0);
  });

  test('the withdrawal event is itself signed', () => {
    const [e] = M.reg.buildEvents(B);
    assert.equal(e.event, 'withdrawn');
    assert.ok(M.reg.verifyLifecycleSignature(e, M.signing.registryPublicKey()!.publicKeyHex));
  });

  test('a superseding event does NOT quietly un-withdraw it', () => {
    const newer = measurement('withdrawn-1-successor');
    M.reg.publishBuild({ measurement: newer, componentName: 'scruple-capture', version: '0.1.1' });
    M.reg.supersedeBuild(B, newer, { effectiveAt: '2026-08-20T00:00:00.000Z' });
    const st = M.reg.buildRegistryStatus(B);
    assert.equal(st.status, 'withdrawn', 'withdrawal must outrank a later housekeeping event');
    assert.equal(st.superseded_by, newer);
  });

  test('only an explicit reinstatement undoes a withdrawal, and it is appended too', () => {
    M.reg.reinstateBuild(B, 'CVE did not apply to the shipped path', {
      effectiveAt: '2026-08-25T00:00:00.000Z',
    });
    const st = M.reg.buildRegistryStatus(B);
    assert.equal(st.status, 'superseded');
    assert.equal(st.withdrawn_at, null);
    // and the withdrawal is still on the record. History is corrected by
    // appending, never by editing.
    assert.ok(M.reg.buildEvents(B).some((e) => e.event === 'withdrawn'));
  });

  test('supersession must name its successor — "superseded by nothing" is a withdrawal in softer words', () => {
    assert.throws(
      () => M.reg.appendBuildEvent({ measurement: B, event: 'superseded' }),
      /must name the build/,
    );
  });

  test('a lifecycle event on a build that was never published is refused', () => {
    assert.throws(() => M.reg.withdrawBuild(measurement('never'), 'x'), /never published/);
  });

  test('a withdrawal dated in the future is refused — it would be a no-op that reads as an action', () => {
    assert.throws(
      () =>
        M.reg.withdrawBuild(B, 'typo', {
          effectiveAt: new Date(Date.now() + 86_400_000).toISOString(),
        }),
      /future/,
    );
  });

  test('a withdrawal backdated before publication is refused — that is the retroactivity the fold prevents', () => {
    assert.throws(
      () => M.reg.withdrawBuild(B, 'backdated', { effectiveAt: '2026-07-01T00:00:00.000Z' }),
      /before this build was published/,
    );
  });

  test('instants are normalised, so a differently-spelled date cannot sort wrong', () => {
    const m = measurement('instant-normalisation');
    const e = M.reg.publishBuild({
      measurement: m,
      componentName: 'x',
      version: '1',
      publishedAt: '2026-08-03T00:00:00Z',
    });
    assert.equal(e.published_at, '2026-08-03T00:00:00.000Z');
    const ev = M.reg.withdrawBuild(m, 'x', { effectiveAt: '2026-08-04T00:00:00+00:00' });
    assert.equal(ev.effective_at, '2026-08-04T00:00:00.000Z');
    // And the as-of query accepts the loose spelling too, because the
    // comparison is lexicographic and would otherwise be spelling-sensitive.
    assert.equal(M.reg.buildRegistryStatus(m, '2026-08-03T12:00:00Z').status, 'published');
    assert.equal(M.reg.buildRegistryStatus(m, '2026-08-05T00:00:00Z').status, 'withdrawn');
  });

  test('an unparseable instant is refused rather than stored as a string that sorts arbitrarily', () => {
    assert.throws(
      () => M.reg.publishBuild({ measurement: measurement('bad-date'), componentName: 'x', version: '1', publishedAt: 'last Tuesday' }),
      /not a parseable instant/,
    );
  });
});

// ---------------------------------------------------------------------------
describe('ingest — an unpublished build is DISTINGUISHABLE and NOT rejected', () => {
  const UNPUBLISHED = measurement('ingest-unpublished');
  const PUBLISHED = measurement('ingest-published');
  let cUnknown: ReturnType<typeof provisioned>;
  let cKnown: ReturnType<typeof provisioned>;

  before(() => {
    M.reg.publishBuild({
      measurement: PUBLISHED,
      componentName: 'scruple-capture',
      version: '1.0.0',
    });
    cUnknown = provisioned(UNPUBLISHED);
    cKnown = provisioned(PUBLISHED);
  });

  test('a leaf from an unpublished build VERIFIES — rejecting it would suppress the event', () => {
    const r = submit(cUnknown, 0, UNPUBLISHED);
    assert.ok(r.ok, 'an unrecognised build must not cost the vendor the leaf');
  });

  test('…and is distinguishable at ingest, on the result', () => {
    const r = submit(cUnknown, 1, UNPUBLISHED);
    assert.ok(r.ok);
    assert.equal(r.build_status, 'unpublished');
    // The pre-registry field is unchanged and says nothing useful here:
    // the component provisioned with this same string, so drift detection
    // sees nothing wrong. That gap IS C-4.
    assert.equal(r.build_changed, false);
  });

  test('…and DURABLY, on the event row, not only in the response', () => {
    const row = M.conn()
      .prepare(`SELECT build_status FROM component_events WHERE component_id = ? AND counter = 1`)
      .get(cUnknown.componentId) as { build_status: string };
    assert.equal(row.build_status, 'unpublished');
  });

  test('a leaf from a published build is recorded as published', () => {
    const r = submit(cKnown, 0, PUBLISHED);
    assert.ok(r.ok);
    assert.equal(r.build_status, 'published');
  });

  test('the two are distinguishable BY QUERY, which is what "recorded" has to mean', () => {
    const rows = M.reg.unrecognisedBuildEvents(500, TENANT);
    assert.ok(rows.some((r) => r.component_id === cUnknown.componentId));
    assert.ok(!rows.some((r) => r.component_id === cKnown.componentId));
  });

  test('publishing the build later makes subsequent events published — no re-provisioning', () => {
    const late = measurement('ingest-late-rollout');
    const c = provisioned(late);
    assert.ok(submit(c, 0, late).ok);
    const before = M.conn()
      .prepare(`SELECT build_status FROM component_events WHERE component_id = ? AND counter = 0`)
      .get(c.componentId) as { build_status: string };
    assert.equal(before.build_status, 'unpublished');

    M.reg.publishBuild({ measurement: late, componentName: 'scruple-capture', version: '1.0.1' });

    const r = submit(c, 1, late);
    assert.ok(r.ok);
    assert.equal(r.build_status, 'published');
    // The earlier row is NOT rewritten. What was true at ingest stays on
    // the record; a later publication does not retro-bless it, exactly as
    // a later withdrawal does not retro-condemn it.
    const still = M.conn()
      .prepare(`SELECT build_status FROM component_events WHERE component_id = ? AND counter = 0`)
      .get(c.componentId) as { build_status: string };
    assert.equal(still.build_status, 'unpublished');
  });

  test('a withdrawn build STILL VERIFIES, and its earlier leaves keep their standing', async () => {
    const b = measurement('ingest-withdrawn');
    M.reg.publishBuild({ measurement: b, componentName: 'scruple-capture', version: '1.0.2' });
    const c = provisioned(b);

    const early = submit(c, 0, b);
    assert.ok(early.ok);
    assert.equal(early.build_status, 'published');
    const earlyAt = M.conn()
      .prepare(`SELECT verified_at, build_status FROM component_events WHERE component_id = ? AND counter = 0`)
      .get(c.componentId) as { verified_at: string; build_status: string };

    // Real elapsed time on both sides of the withdrawal. Publishing,
    // ingesting and withdrawing inside one millisecond is not a scenario,
    // and `effective_at <= as_of` means a withdrawal IS in force at its own
    // effective instant — a boundary worth stating rather than leaving to
    // the resolution of the clock.
    await sleep(5);
    M.reg.withdrawBuild(b, 'superseded by a security fix');
    await sleep(5);

    // 1. The already-signed leaf keeps the status it was ingested with.
    const afterRow = M.conn()
      .prepare(`SELECT build_status FROM component_events WHERE component_id = ? AND counter = 0`)
      .get(c.componentId) as { build_status: string };
    assert.equal(afterRow.build_status, 'published');

    // 2. And asking the registry the question a verifier would ask —
    //    "was this build published when that leaf was signed?" — still
    //    answers yes.
    assert.equal(M.reg.buildRegistryStatus(b, earlyAt.verified_at).status, 'published');

    // 3. A NEW event on the withdrawn build still verifies. It is flagged,
    //    not refused: the artifact exists either way, and the only thing
    //    rejection would change is whether we have a record of it.
    const later = submit(c, 1, b);
    assert.ok(later.ok);
    assert.equal(later.build_status, 'withdrawn');
  });

  test('a registry fault is `unchecked`, never a silent pass — an inconclusive is not a pass (§7)', () => {
    // Force the check to fail the only way it can from the outside: an
    // as-of instant it cannot parse.
    assert.equal(M.reg.checkClaimedBuild(PUBLISHED, 'not a date'), 'unchecked');
  });

  test('a component that declared no measurement at all is `undeclared`, never `unpublished`', () => {
    assert.equal(M.reg.checkClaimedBuild(null), 'undeclared');
    assert.equal(M.reg.checkClaimedBuild(undefined), 'undeclared');
    // A garbage string is not a build we published, and saying so is not
    // the same as saying nothing was declared.
    assert.equal(M.reg.checkClaimedBuild('not-a-measurement'), 'unpublished');
  });
});

// ---------------------------------------------------------------------------
describe('end to end with the ACTUAL shipped component build', () => {
  test('measure services/scruple-capture/src, publish it, and ingest a leaf that claims it', () => {
    // The real function over the real tree — not a fixture. If
    // build-measurement.ts changes shape, this fails.
    const src = path.resolve(__dirname, '../../services/scruple-capture/src');
    const m = M.buildMeasurement(src);
    assert.match(m, /^sha256:[0-9a-f]{64}$/);

    // Before publication the estate's own component is unrecognised, which
    // is exactly the state the whole repo was in until this work order.
    assert.equal(M.reg.checkClaimedBuild(m), 'unpublished');

    M.reg.publishBuild({
      measurement: m,
      componentName: 'scruple-capture',
      version: '0.1.0',
      measurementKind: 'source-tree',
      notes: 'Source-tree digest of services/scruple-capture/src, per build-measurement.ts.',
    });

    const c = provisioned(m);
    const r = submit(c, 0, m);
    assert.ok(r.ok);
    assert.equal(r.build_status, 'published');
    assert.equal(r.build_measurement, m);
  });
});

// ---------------------------------------------------------------------------
describe('the read surface', () => {
  const B = measurement('route-1');
  const T0 = '2026-08-02T00:00:00.000Z';

  before(() => {
    M.reg.publishBuild({
      measurement: B,
      componentName: 'route-component',
      version: '3.0.0',
      publishedAt: T0,
    });
    M.reg.withdrawBuild(B, 'routes test', { effectiveAt: '2026-08-12T00:00:00.000Z' });
  });

  test('GET /api/v2/builds lists the entry with its signature and the public key', async () => {
    const res = await M.listRoute(new Request('https://scruple.ai/api/v2/builds?component=route-component'));
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      signing_key: { publicKeyHex: string } | null;
      builds: { measurement: string; status: string; signature: { value: string } }[];
      limit: string;
    };
    const found = body.builds.find((b) => b.measurement === B)!;
    assert.equal(found.status, 'withdrawn');
    assert.ok(body.signing_key);
    assert.ok(found.signature.value.length > 0);
    // The claim we are permitted to make travels with the list.
    assert.match(body.limit, /cannot do is produce a valid MAC/);
  });

  test('GET /api/v2/builds/{m}?at= answers as of that instant, which is the verifier question', async () => {
    const at = '2026-08-05T00:00:00.000Z';
    const res = await M.oneRoute(
      new Request(`https://scruple.ai/api/v2/builds/${encodeURIComponent(B)}?at=${at}`),
      { params: Promise.resolve({ measurement: encodeURIComponent(B) }) },
    );
    const body = (await res.json()) as { status: string; known: boolean; events: unknown[] };
    assert.equal(body.status, 'published');
    assert.equal(body.known, true);
    assert.equal(body.events.length, 0);
  });

  test('…and now, it is withdrawn, with the signed event attached', async () => {
    const res = await M.oneRoute(
      new Request(`https://scruple.ai/api/v2/builds/${encodeURIComponent(B)}`),
      { params: Promise.resolve({ measurement: encodeURIComponent(B) }) },
    );
    const body = (await res.json()) as {
      status: string;
      events: { event: string; signature: { value: string } }[];
    };
    assert.equal(body.status, 'withdrawn');
    assert.equal(body.events[0].event, 'withdrawn');
    assert.ok(body.events[0].signature.value.length > 0);
  });

  test('an unpublished measurement answers 200 with status unpublished, not 404', async () => {
    const m = measurement('never-published');
    const res = await M.oneRoute(
      new Request(`https://scruple.ai/api/v2/builds/${encodeURIComponent(m)}`),
      { params: Promise.resolve({ measurement: encodeURIComponent(m) }) },
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { known: boolean; status: string };
    assert.equal(body.known, false);
    assert.equal(body.status, 'unpublished');
  });

  test('a malformed measurement is a 400 about the shape, not a 404 about the URL', async () => {
    const res = await M.oneRoute(new Request('https://scruple.ai/api/v2/builds/nope'), {
      params: Promise.resolve({ measurement: 'nope' }),
    });
    assert.equal(res.status, 400);
  });

  test('the unrecognised report needs a key and shows only the caller\'s own components', async () => {
    const anon = await M.unrecognisedRoute(
      new Request('https://scruple.ai/api/v2/builds/unrecognised'),
    );
    assert.equal(anon.status, 401);

    // Another tenant with an unrecognised build of their own.
    const theirs = measurement('other-tenant-unpublished');
    const c = provisioned(theirs, OTHER);
    assert.ok(submit(c, 0, theirs, OTHER_PRINCIPAL).ok);

    const key = issueKey(TENANT, ['read']);
    const res = await M.unrecognisedRoute(
      new Request('https://scruple.ai/api/v2/builds/unrecognised', {
        headers: { authorization: `Bearer ${key}` },
      }),
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      count: number;
      events: { component_id: string; build_status: string }[];
      note: string;
    };
    assert.ok(body.count > 0, 'the whole point is that these are visible');
    assert.ok(!body.events.some((e) => e.component_id === c.componentId));
    assert.ok(body.events.every((e) => e.build_status !== 'published'));
    assert.match(body.note, /suppressed event is worse than a flagged one/);
  });
});
