// §10 C-6 — authenticate before ratcheting, proved rather than asserted.
//
// C-2 bounded the forward ratchet at MAX_RATCHET_ADVANCE = 100,000. C-4's
// sibling, C-6, priced that bound: at the ~5.8 µs per step WO-4 measured,
// 100,000 steps is ~584 ms of CPU spent BEFORE the MAC is checked, on a
// counter that travels in the clear and is therefore attacker-chosen. C-6's
// finding is that the fix is not a smaller number — lowering the cap trades
// a DoS window for a legitimate-backlog ceiling, and refusing a deep drain
// destroys exactly the evidence the queue exists to preserve (§5, C-3).
// The fix is that the UNAUTHENTICATED cost must be zero.
//
// HOW THAT IS PROVED HERE. `lib/ratchet/verify.ts` counts the HKDF-Expand
// steps it performs. The tests below reset the counter, fire a submission
// claiming counter 99,999 — one below the cap, so the maximum work the
// bound permits — and assert the delta is EXACTLY ZERO, first with no
// credential and then with a valid credential belonging to another tenant.
// A third test then fires the same shape at the owning tenant and asserts
// the delta is non-zero, which is what stops the first two passing
// vacuously: a verifier that never ratcheted at all would satisfy them.
//
// Timing was the obvious alternative and it is the wrong instrument. A
// wall-clock assertion on a shared CI box is flaky in the direction that
// matters (it passes when the machine is quiet) and it measures the
// harness as much as the code. Counting the actual work is neither.
//
// This file also covers the two things WO-6 wired alongside C-6:
//   * /api/v2/witness now CALLS verifySubmission() — WO-3 built the ratchet
//     and nothing on the ingest path used it, which made the gap accounting
//     that makes suppression visible decorative;
//   * an absent MIME is accepted and recorded as absent (H-4 §7 probe 4),
//     rather than 400'd or filled with a placeholder.
//
// TEST ISOLATION follows test/v2/components-provision.test.ts: `npm run
// test:v2` runs every file concurrently against one shared
// SCRUPLE_DB_PATH, so this file takes a private database assigned at module
// top level, and everything reaching lib/db/sqlite is imported DYNAMICALLY
// inside before() because static imports hoist above the assignment.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

if (!process.env.SCRUPLE_DB_PATH || !/tmp|test/i.test(process.env.SCRUPLE_DB_PATH)) {
  throw new Error('Refusing to run: set SCRUPLE_DB_PATH to a throwaway path. Use `npm run test:v2`.');
}
const OWN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'scruple-component-auth-'));
process.env.SCRUPLE_DB_PATH = path.join(OWN_DIR, 'component-auth.db');
process.env.SCRUPLE_BDK_HEX = 'c3'.repeat(32);
// The standing rule: never the production witness on 127.0.0.1:5799.
process.env.WITNESS_SERVER_URL = 'http://127.0.0.1:1';

type Mod = {
  conn: typeof import('../../lib/db/sqlite').conn;
  runMigrations: typeof import('../../lib/db/migrate').runMigrations;
  issueProvisioningToken: typeof import('../../lib/ratchet/provisioning').issueProvisioningToken;
  redeemProvisioningToken: typeof import('../../lib/ratchet/provisioning').redeemProvisioningToken;
  ratchetStepsPerformed: typeof import('../../lib/ratchet/verify').ratchetStepsPerformed;
  ratchetInvocations: typeof import('../../lib/ratchet/verify').ratchetInvocations;
  resetRatchetCounters: typeof import('../../lib/ratchet/verify').resetRatchetCounters;
  MAX_RATCHET_ADVANCE: number;
  deriveIk: typeof import('../../lib/ratchet/ratchet').deriveIk;
  Ratchet: typeof import('../../lib/ratchet/ratchet').Ratchet;
  bdk: typeof import('../../lib/ratchet/bdk').bdk;
  componentPreimage: typeof import('../../lib/leaf/componentPreimage').componentPreimage;
  preimageOf: typeof import('../../services/scruple-capture/src/leaf').preimageOf;
  POST: (req: Request) => Promise<Response>;
};

let M: Mod;
const TENANT = 'vendor-ca1';
const OTHER_TENANT = 'vendor-ca2';
const BUILD = 'sha256:' + 'ef'.repeat(32);
// One baseline per tenant: `baselines.baseline_hash` is UNIQUE across the
// table, so two tenants cannot share one.
const BASELINE: Record<string, string> = { [TENANT]: 'b'.repeat(64), [OTHER_TENANT]: 'c'.repeat(64) };

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

function provision(tenantId: string) {
  const { componentId, token } = M.issueProvisioningToken({ tenantId, label: 'server-library' });
  assert.ok(M.redeemProvisioningToken({ token, tenantId, buildMeasurement: BUILD }).ok);
  return componentId;
}

/** The capture block a `server-library` component sends. */
const CAPTURE = {
  surface: 'in-process-callback',
  hook: 'artifact.produced',
  fidelity: 'as-delivered',
  size_bytes: 17,
  mime_source: 'caller-declared',
  correlation_id: null,
  correlation_method: null,
  egress: null,
  close_detection: null,
  workflow_hash: null,
  observed_at: '2026-08-30T00:00:00.000Z',
  attestation_status: 'passthrough' as const,
};

/**
 * Build a submission body, MACed at `counter` by a ratchet positioned
 * there. `honest: false` positions the ratchet at 0 and lies about the
 * counter — the shape an attacker sends, and the one that must cost
 * nothing before authentication.
 */
function submission(
  componentId: string,
  counter: number,
  opts: { honest?: boolean; mime?: string | null; contentHash?: string; tenant?: string } = {},
) {
  const contentHash = opts.contentHash ?? crypto.randomBytes(32).toString('hex');
  const mime = opts.mime === undefined ? 'image/png' : opts.mime;
  const body: Record<string, unknown> = {
    baseline_ref: BASELINE[opts.tenant ?? TENANT],
    kind: 'artifact',
    content_hash: contentHash,
    capture: CAPTURE,
    component: {
      component_id: componentId,
      build_measurement: BUILD,
      counter,
      attestation: { provider: 'none', quote_ref: null },
    },
  };
  if (mime !== null) body.mime = mime;

  const preimage = M.componentPreimage(body as never);
  const start = opts.honest === false ? 0 : counter;
  const ik = M.deriveIk(M.bdk(), componentId);
  const r = new M.Ratchet(ik, start);
  if (opts.honest !== false && counter > 0) {
    // Position the component's own chain at `counter` the way it would
    // arrive there: by having spent every counter below it.
    r.destroy();
    const r2 = new M.Ratchet(M.deriveIk(M.bdk(), componentId), 0);
    r2.skip(counter);
    const { mac } = r2.mac(preimage);
    r2.destroy();
    body.mac = mac;
    return body;
  }
  const { mac } = r.mac(preimage);
  r.destroy();
  body.mac = mac;
  return body;
}

const witnessReq = (key: string | undefined, body: unknown) =>
  new Request('https://scruple.ai/api/v2/witness', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify(body),
  });

before(async () => {
  const [sqlite, migrate, prov, verify, ratchet, bdkMod, preimage, sidecarLeaf, route] =
    await Promise.all([
      import('../../lib/db/sqlite'),
      import('../../lib/db/migrate'),
      import('../../lib/ratchet/provisioning'),
      import('../../lib/ratchet/verify'),
      import('../../lib/ratchet/ratchet'),
      import('../../lib/ratchet/bdk'),
      import('../../lib/leaf/componentPreimage'),
      import('../../services/scruple-capture/src/leaf'),
      import('../../app/api/v2/witness/route'),
    ]);
  M = {
    conn: sqlite.conn,
    runMigrations: migrate.runMigrations,
    issueProvisioningToken: prov.issueProvisioningToken,
    redeemProvisioningToken: prov.redeemProvisioningToken,
    ratchetStepsPerformed: verify.ratchetStepsPerformed,
    ratchetInvocations: verify.ratchetInvocations,
    resetRatchetCounters: verify.resetRatchetCounters,
    MAX_RATCHET_ADVANCE: verify.MAX_RATCHET_ADVANCE,
    deriveIk: ratchet.deriveIk,
    Ratchet: ratchet.Ratchet,
    bdk: bdkMod.bdk,
    componentPreimage: preimage.componentPreimage,
    preimageOf: sidecarLeaf.preimageOf,
    POST: route.POST as unknown as (req: Request) => Promise<Response>,
  };
  M.runMigrations(false);
  for (const [id, email] of [
    [TENANT, 'ca1@example.com'],
    [OTHER_TENANT, 'ca2@example.com'],
  ]) {
    M.conn().prepare(`INSERT INTO users (id, email) VALUES (?, ?)`).run(id, email);
  }
  // Every witness call needs a live baseline for the tenant (D-3).
  const now = new Date().toISOString();
  for (const id of [TENANT, OTHER_TENANT]) {
    M.conn()
      .prepare(
        `INSERT INTO baselines
           (tenant_id, baseline_hash, manifest_json, attestation_provider,
            signer_pubkey_spki_sha256_hex, submitted_at, activated_at)
         VALUES (?, ?, '{}', 'none', ?, ?, ?)`,
      )
      .run(id, BASELINE[id], crypto.createHash('sha256').update('pubkey').digest('hex'), now, now);
  }
});

after(() => {
  try {
    fs.rmSync(OWN_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// ---------------------------------------------------------------------------
describe('§10 C-6 — no ratcheting before authentication', () => {
  test('an unauthenticated submission claiming counter 99,999 performs ZERO ratchet steps', async () => {
    const componentId = provision(TENANT);
    const body = submission(componentId, M.MAX_RATCHET_ADVANCE - 1, { honest: false });

    M.resetRatchetCounters();
    const res = await M.POST(witnessReq(undefined, body));

    assert.equal(res.status, 401);
    // The whole of C-6 in one line. 99,999 steps is ~584 ms of CPU that
    // an unauthenticated caller could previously buy for one request.
    assert.equal(M.ratchetStepsPerformed(), 0);
    assert.equal(M.ratchetInvocations(), 0);
  });

  test('a valid key belonging to another tenant also performs ZERO steps', async () => {
    // Authentication alone is not the boundary — the component has an
    // owner. Ratcheting on someone else's component would make every
    // API key in the estate a DoS primitive against every component.
    const componentId = provision(TENANT);
    const intruder = issueKey(OTHER_TENANT, ['witness:write']);
    // The intruder's OWN baseline, so the request clears the D-3 gate and
    // actually reaches the component check. (That gate is also above the
    // ratchet, which is a second free win and not the one under test.)
    const body = submission(componentId, M.MAX_RATCHET_ADVANCE - 1, {
      honest: false,
      tenant: OTHER_TENANT,
    });

    M.resetRatchetCounters();
    const res = await M.POST(witnessReq(intruder, body));

    assert.equal(res.status, 422);
    const b = (await res.json()) as { error: { code: string; detail: { reason: string } } };
    assert.equal(b.error.code, 'component_unverified');
    // A component in another tenant's estate answers exactly as one that
    // does not exist.
    assert.equal(b.error.detail.reason, 'unknown_component');
    assert.equal(M.ratchetStepsPerformed(), 0);
  });

  test('a key without witness:write performs ZERO steps — the scope gate is also above the ratchet', async () => {
    const componentId = provision(TENANT);
    const readOnly = issueKey(TENANT, ['read']);
    const body = submission(componentId, M.MAX_RATCHET_ADVANCE - 1, { honest: false });

    M.resetRatchetCounters();
    const res = await M.POST(witnessReq(readOnly, body));

    assert.equal(res.status, 403);
    assert.equal(M.ratchetStepsPerformed(), 0);
  });

  test('the owning tenant DOES ratchet — so the three assertions above are not vacuous', async () => {
    // The control. If verification never ratcheted at all, every test
    // above would pass and prove nothing.
    const componentId = provision(TENANT);
    const key = issueKey(TENANT, ['witness:write']);
    const DEPTH = 250;
    const body = submission(componentId, DEPTH);

    M.resetRatchetCounters();
    const res = await M.POST(witnessReq(key, body));

    assert.equal(res.status, 201);
    assert.ok(
      M.ratchetStepsPerformed() >= DEPTH,
      `expected at least ${DEPTH} steps, got ${M.ratchetStepsPerformed()}`,
    );
  });

  test('MAX_RATCHET_ADVANCE is unchanged — C-6 explicitly does not lower it', async () => {
    // Lowering the cap would trade a DoS window for a legitimate-backlog
    // ceiling: a component offline through the full §5 backoff
    // accumulates a deep queue, and refusing its drain destroys the
    // evidence the queue exists to preserve. Pinned so that "fixing" C-6
    // by shrinking the number fails here and has to be argued for.
    assert.equal(M.MAX_RATCHET_ADVANCE, 100_000);
  });
});

// ---------------------------------------------------------------------------
describe('POST /api/v2/witness — the component envelope', () => {
  test('a verified component submission is recorded against the component', async () => {
    const componentId = provision(TENANT);
    const key = issueKey(TENANT, ['witness:write']);
    const res = await M.POST(witnessReq(key, submission(componentId, 0)));

    assert.equal(res.status, 201);
    const b = (await res.json()) as {
      leaf_id: string;
      component: { component_id: string; counter: number; verified: boolean; gap: number };
      component_verified: boolean;
    };
    assert.equal(b.component.verified, true);
    assert.equal(b.component.component_id, componentId);
    assert.equal(b.component.gap, 0);

    const row = M.conn()
      .prepare(`SELECT component_id, component_counter, component_verified, mime_declared FROM iterations WHERE id = ?`)
      .get(Number(b.leaf_id)) as Record<string, unknown>;
    assert.equal(row.component_id, componentId);
    assert.equal(row.component_counter, 0);
    assert.equal(row.component_verified, 1);
    assert.equal(row.mime_declared, 1);
  });

  test('a bad MAC is refused and no leaf is written', async () => {
    const componentId = provision(TENANT);
    const key = issueKey(TENANT, ['witness:write']);
    const body = submission(componentId, 0) as Record<string, unknown>;
    body.mac = 'a'.repeat(64);

    const before = (M.conn().prepare(`SELECT COUNT(*) AS c FROM iterations`).get() as { c: number }).c;
    const res = await M.POST(witnessReq(key, body));
    assert.equal(res.status, 422);
    const after = (M.conn().prepare(`SELECT COUNT(*) AS c FROM iterations`).get() as { c: number }).c;
    assert.equal(after, before);
  });

  test('an exact re-delivery is deduplicated, not treated as an attack (§5)', async () => {
    const componentId = provision(TENANT);
    const key = issueKey(TENANT, ['witness:write']);
    const body = submission(componentId, 0);

    assert.equal((await M.POST(witnessReq(key, body))).status, 201);
    const res = await M.POST(witnessReq(key, body));
    assert.equal(res.status, 200);
    const b = (await res.json()) as { deduplicated: boolean; witnessed: boolean };
    assert.equal(b.deduplicated, true);
    // 200 does not mean witnessed. It means "this event is already in the
    // record", which is what a queue drain needs to hear.
    assert.equal(b.witnessed, false);
  });

  test('reusing a counter with different bytes is a replay and is refused', async () => {
    const componentId = provision(TENANT);
    const key = issueKey(TENANT, ['witness:write']);
    assert.equal((await M.POST(witnessReq(key, submission(componentId, 0)))).status, 201);

    const res = await M.POST(witnessReq(key, submission(componentId, 0)));
    assert.equal(res.status, 422);
    const b = (await res.json()) as { error: { detail: { reason: string } } };
    assert.equal(b.error.detail.reason, 'replay');
  });

  test('a gap is recorded on the leaf and does NOT invalidate it', async () => {
    // §4.2. If a gap invalidated the leaves around it, suppressing one
    // event would be a way to attack the vendor's entire record — and the
    // party best placed to suppress is the tenant we already treat as the
    // adversary.
    const componentId = provision(TENANT);
    const key = issueKey(TENANT, ['witness:write']);
    assert.equal((await M.POST(witnessReq(key, submission(componentId, 0)))).status, 201);

    const res = await M.POST(witnessReq(key, submission(componentId, 4)));
    assert.equal(res.status, 201);
    const b = (await res.json()) as { component: { gap: number } };
    assert.equal(b.component.gap, 3);
  });

  test('an envelope with no MAC is refused, and a MAC with no envelope too', async () => {
    const componentId = provision(TENANT);
    const key = issueKey(TENANT, ['witness:write']);
    const body = submission(componentId, 0) as Record<string, unknown>;
    delete body.mac;
    assert.equal((await M.POST(witnessReq(key, body))).status, 400);

    const orphan = submission(componentId, 1) as Record<string, unknown>;
    delete orphan.component;
    assert.equal((await M.POST(witnessReq(key, orphan))).status, 400);
  });

  test('a submission with no component is accepted and recorded as UNVERIFIED', async () => {
    // Canvas and the plugins have no component and must keep working.
    // What must not happen is "we did not check" reading like "we checked
    // and it passed".
    const key = issueKey(TENANT, ['witness:write']);
    const res = await M.POST(
      witnessReq(key, {
        baseline_ref: BASELINE[TENANT],
        kind: 'artifact',
        content_hash: crypto.randomBytes(32).toString('hex'),
        mime: 'image/png',
      }),
    );
    assert.equal(res.status, 201);
    const b = (await res.json()) as { leaf_id: string; component: null; component_verified: boolean };
    assert.equal(b.component, null);
    assert.equal(b.component_verified, false);
    const row = M.conn()
      .prepare(`SELECT component_id, component_verified FROM iterations WHERE id = ?`)
      .get(Number(b.leaf_id)) as Record<string, unknown>;
    assert.equal(row.component_id, null);
    assert.equal(row.component_verified, 0);
  });
});

// ---------------------------------------------------------------------------
describe('H-4 §7 probe 4 — an unattributed write has no MIME to declare', () => {
  test('a submission with no mime is accepted and recorded as undeclared', async () => {
    const componentId = provision(TENANT);
    const key = issueKey(TENANT, ['witness:write']);
    const res = await M.POST(witnessReq(key, submission(componentId, 0, { mime: null })));

    assert.equal(res.status, 201);
    const b = (await res.json()) as { leaf_id: string; mime: string | null; mime_declared: boolean };
    assert.equal(b.mime, null);
    assert.equal(b.mime_declared, false);

    const row = M.conn()
      .prepare(`SELECT output_content_type, mime_declared FROM iterations WHERE id = ?`)
      .get(Number(b.leaf_id)) as Record<string, unknown>;
    // NULL, never 'application/octet-stream'. The placeholder is a
    // declaration that is false, and it silently gates the image-only
    // watermarker shut while looking exactly like a real type.
    assert.equal(row.output_content_type, null);
    assert.equal(row.mime_declared, 0);
  });

  test('the MAC covers the ABSENCE of a mime, so it cannot be added in flight', async () => {
    const componentId = provision(TENANT);
    const key = issueKey(TENANT, ['witness:write']);
    const body = submission(componentId, 0, { mime: null }) as Record<string, unknown>;
    body.mime = 'image/png'; // a proxy "helpfully" filling one in
    const res = await M.POST(witnessReq(key, body));
    assert.equal(res.status, 422);
  });
});

// ---------------------------------------------------------------------------
describe('one preimage, three implementations', () => {
  test('the server and the sidecar component build the same MAC preimage', () => {
    // §10 C-1 fixed the ENCODING of canonical_preimage and left the FIELD
    // SET open, which is how two conforming implementations disagree. The
    // sidecar's preimageOf() is the original; lib/leaf/componentPreimage.ts
    // is what the route calls, because a Next route importing out of
    // services/ would couple the web build to a container's source tree.
    // Copying a field list is exactly the thing that goes wrong quietly,
    // so this compares them over one submission.
    //
    // On failure: the two have drifted. Reconcile them — do not update
    // one side's expectations.
    const sample = {
      baseline_ref: BASELINE[TENANT],
      kind: 'artifact' as const,
      content_hash: 'c'.repeat(64),
      mime: 'image/png',
      input_hash: 'd'.repeat(64),
      model_fingerprints_hash: 'e'.repeat(64),
      machine_manifest_hash: 'f'.repeat(64),
      capture: { ...CAPTURE },
      component: {
        component_id: 'cid',
        build_measurement: BUILD,
        counter: 3,
        attestation: { provider: 'none', quote_ref: null },
      },
    };
    assert.deepEqual(M.componentPreimage(sample), M.preimageOf(sample as never));
  });

  test('the committed cross-language preimage vectors are current', () => {
    // The Python implementation is checked against
    // test/vectors/component-preimage-vectors.json and cannot notice that
    // the file has gone stale. Without this, a change to the TypeScript
    // field set leaves both suites green while the two languages agree
    // about different things — which is the exact failure the vectors
    // exist to prevent, reintroduced one level up.
    const VEC = path.join(process.cwd(), 'test', 'vectors', 'component-preimage-vectors.json');
    const committed = fs.readFileSync(VEC, 'utf8');
    try {
      execFileSync(process.execPath, ['--import', 'tsx', 'scripts/gen-component-preimage-vectors.mjs'], {
        cwd: process.cwd(),
        stdio: 'pipe',
      });
      const regenerated = fs.readFileSync(VEC, 'utf8');
      assert.equal(
        regenerated,
        committed,
        'test/vectors/component-preimage-vectors.json is stale. Run ' +
          '`npm run gen:preimage-vectors` and re-run `npm run test:sdk` — a regenerated ' +
          'file is a changed contract and the Python side is entitled to disagree with it.',
      );
    } finally {
      fs.writeFileSync(VEC, committed);
    }
  });

  test('an absent capture block is nulls in a stable shape, not a different shape', () => {
    // A key dropped from the object changes the canonical JSON and
    // therefore the MAC. The `server-library` placement has no separate
    // observer, so it legitimately fills less of this block than a sidecar
    // does, and the difference has to be a value and not a shape.
    const withNone = M.componentPreimage({
      content_hash: 'c'.repeat(64),
      component: { component_id: 'cid', counter: 0 },
    });
    const withEmpty = M.componentPreimage({
      content_hash: 'c'.repeat(64),
      capture: {},
      component: { component_id: 'cid', counter: 0 },
    });
    assert.deepEqual(withNone, withEmpty);
    assert.equal(withNone.surface, null);
  });
});
