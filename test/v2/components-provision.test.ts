// Component provisioning and server-side ratchet verification (H-4 §4.2, §4.4).
//
// The four properties this file exists to demonstrate rather than assert:
//
//   * a replayed or equal counter is REJECTED;
//   * a GAP verifies and is RECORDED — because if a gap invalidated the
//     leaves around it, suppressing one event would become a way to
//     attack the vendor's whole record;
//   * a component cannot derive another component's IK from its own state;
//   * a provisioning token is single-use, short-lived, and tenant-bound.
//
// TEST ISOLATION. `npm run test:v2` runs every test/v2 file CONCURRENTLY
// against one shared SCRUPLE_DB_PATH, which races as soon as two files
// migrate or write. This file therefore takes its own private database:
// SCRUPLE_DB_PATH is reassigned at module top level and everything that
// reaches lib/db/sqlite is imported DYNAMICALLY inside before(), because
// static imports hoist above the assignment and would capture the shared
// path. tsx compiles these to CJS, so a top-level await import is not
// available — the dynamic import has to live inside the async hook.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Refuse to run against anything that might be real, the same guard
// test/v2/auth.test.ts applies.
if (!process.env.SCRUPLE_DB_PATH || !/tmp|test/i.test(process.env.SCRUPLE_DB_PATH)) {
  throw new Error('Refusing to run: set SCRUPLE_DB_PATH to a throwaway path. Use `npm run test:v2`.');
}
const OWN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'scruple-components-'));
process.env.SCRUPLE_DB_PATH = path.join(OWN_DIR, 'components.db');

// A test BDK, set before anything calls bdk(). lib/ratchet/bdk.ts reads
// the environment lazily, inside the function, precisely so this works.
process.env.SCRUPLE_BDK_HEX = 'a1'.repeat(32);

// Belt and braces on the standing safety rule: nothing in this file should
// reach the production witness server on 127.0.0.1:5799.
process.env.WITNESS_SERVER_URL = 'http://127.0.0.1:1';

type Mod = {
  conn: typeof import('../../lib/db/sqlite').conn;
  runMigrations: typeof import('../../lib/db/migrate').runMigrations;
  issueProvisioningToken: typeof import('../../lib/ratchet/provisioning').issueProvisioningToken;
  redeemProvisioningToken: typeof import('../../lib/ratchet/provisioning').redeemProvisioningToken;
  verifySubmission: typeof import('../../lib/ratchet/verify').verifySubmission;
  silentComponents: typeof import('../../lib/ratchet/verify').silentComponents;
  openGaps: typeof import('../../lib/ratchet/verify').openGaps;
  getComponent: typeof import('../../lib/ratchet/verify').getComponent;
  MAX_RATCHET_ADVANCE: number;
  deriveIk: typeof import('../../lib/ratchet/ratchet').deriveIk;
  canonicalPreimage: typeof import('../../lib/ratchet/ratchet').canonicalPreimage;
  Ratchet: typeof import('../../lib/ratchet/ratchet').Ratchet;
  bdk: typeof import('../../lib/ratchet/bdk').bdk;
  POST: (req: Request) => Promise<Response>;
};

let M: Mod;
const TENANT = 'vendor-1';
const OTHER_TENANT = 'vendor-2';
// §10 C-6: verifySubmission() takes an authenticated principal FIRST, so a
// caller with no API key cannot reach the ratchet at all. Every component
// in this file is provisioned under TENANT.
const PRINCIPAL = { userId: TENANT, keyId: 'key-vendor-1' };
const BUILD = 'sha256:' + 'ab'.repeat(32);

/** A component with a real IK, as the component itself would hold it. */
function component(componentId: string) {
  const ik = M.deriveIk(M.bdk(), componentId);
  return new M.Ratchet(ik, 0);
}

/** Mint an api_key the way test/v2/auth.test.ts does. */
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

const provisionReq = (token: string | undefined, body: Record<string, unknown>) =>
  new Request('https://scruple.ai/api/v2/components/provision', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

before(async () => {
  const [sqlite, migrate, prov, verify, ratchet, bdkMod, route] = await Promise.all([
    import('../../lib/db/sqlite'),
    import('../../lib/db/migrate'),
    import('../../lib/ratchet/provisioning'),
    import('../../lib/ratchet/verify'),
    import('../../lib/ratchet/ratchet'),
    import('../../lib/ratchet/bdk'),
    import('../../app/api/v2/components/provision/route'),
  ]);
  M = {
    conn: sqlite.conn,
    runMigrations: migrate.runMigrations,
    issueProvisioningToken: prov.issueProvisioningToken,
    redeemProvisioningToken: prov.redeemProvisioningToken,
    verifySubmission: verify.verifySubmission,
    silentComponents: verify.silentComponents,
    openGaps: verify.openGaps,
    getComponent: verify.getComponent,
    MAX_RATCHET_ADVANCE: verify.MAX_RATCHET_ADVANCE,
    deriveIk: ratchet.deriveIk,
    canonicalPreimage: ratchet.canonicalPreimage,
    Ratchet: ratchet.Ratchet,
    bdk: bdkMod.bdk,
    POST: route.POST as unknown as (req: Request) => Promise<Response>,
  };
  M.runMigrations(false);
  M.conn().prepare(`INSERT INTO users (id, email) VALUES (?, 'v1@example.com')`).run(TENANT);
  M.conn().prepare(`INSERT INTO users (id, email) VALUES (?, 'v2@example.com')`).run(OTHER_TENANT);
});

after(() => {
  try {
    fs.rmSync(OWN_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// ---------------------------------------------------------------------------
describe('migration 041 — the schema reconciliation needs', () => {
  test('components, events and gaps all exist', () => {
    const names = new Set(
      (M.conn().prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]).map(
        (r) => r.name,
      ),
    );
    assert.ok(names.has('components'));
    assert.ok(names.has('component_events'));
    assert.ok(names.has('component_counter_gaps'));
  });

  test('(component_id, counter) is unique — §5 idempotence is a constraint, not a convention', () => {
    const cols = M.conn().prepare(`PRAGMA table_info(component_events)`).all() as { name: string; pk: number }[];
    const pk = cols.filter((c) => c.pk > 0).map((c) => c.name).sort();
    assert.deepEqual(pk, ['component_id', 'counter']);
  });

  test('last_verified_counter is nullable, so "never verified" differs from "verified event 0"', () => {
    const cols = M.conn().prepare(`PRAGMA table_info(components)`).all() as {
      name: string;
      notnull: number;
    }[];
    const c = cols.find((x) => x.name === 'last_verified_counter')!;
    assert.equal(c.notnull, 0);
  });
});

// ---------------------------------------------------------------------------
describe('§4.4 — provisioning', () => {
  test('the happy path returns an IK, burns the token, and records n=0', () => {
    const { componentId, token } = M.issueProvisioningToken({ tenantId: TENANT, label: 'comfy-a' });
    const r = M.redeemProvisioningToken({ token, tenantId: TENANT, buildMeasurement: BUILD });
    assert.ok(r.ok);
    assert.equal(r.componentId, componentId);
    assert.equal(r.counter, 0);
    // The IK returned is exactly HKDF(BDK, component_id) — the component
    // and the server must agree or nothing downstream verifies.
    assert.equal(r.ikHex, M.deriveIk(M.bdk(), componentId).toString('hex'));

    const row = M.getComponent(componentId)!;
    assert.equal(row.status, 'active');
    assert.equal(row.build_measurement, BUILD);
    assert.equal(row.last_verified_counter, null);
    assert.equal(row.chain_key_counter, 0);
  });

  test('a token is single use', () => {
    const { token } = M.issueProvisioningToken({ tenantId: TENANT });
    assert.ok(M.redeemProvisioningToken({ token, tenantId: TENANT, buildMeasurement: BUILD }).ok);
    const again = M.redeemProvisioningToken({ token, tenantId: TENANT, buildMeasurement: BUILD });
    assert.equal(again.ok, false);
    assert.equal((again as { reason: string }).reason, 'token_consumed');
  });

  test('a token is tenant-bound — one vendor cannot provision into another\'s estate', () => {
    const { token } = M.issueProvisioningToken({ tenantId: TENANT });
    const r = M.redeemProvisioningToken({ token, tenantId: OTHER_TENANT, buildMeasurement: BUILD });
    assert.equal(r.ok, false);
    assert.equal((r as { reason: string }).reason, 'wrong_tenant');
  });

  test('an expired token is refused', () => {
    const { token } = M.issueProvisioningToken({ tenantId: TENANT, ttlSeconds: -1 });
    const r = M.redeemProvisioningToken({ token, tenantId: TENANT, buildMeasurement: BUILD });
    assert.equal(r.ok, false);
    assert.equal((r as { reason: string }).reason, 'token_expired');
  });

  test('an unknown token is refused', () => {
    const r = M.redeemProvisioningToken({
      token: 'spt_not-a-real-token',
      tenantId: TENANT,
      buildMeasurement: BUILD,
    });
    assert.equal(r.ok, false);
    assert.equal((r as { reason: string }).reason, 'unknown_token');
  });

  test('an attestation is recorded as passthrough, never flattered to verified (§12.4 / H-5)', () => {
    const { componentId, token } = M.issueProvisioningToken({ tenantId: TENANT });
    const r = M.redeemProvisioningToken({
      token,
      tenantId: TENANT,
      buildMeasurement: BUILD,
      attestation: { provider: 'amd-sev-snp', quote_ref: 'quote-1' },
    });
    assert.ok(r.ok);
    assert.equal(r.attestationStatus, 'passthrough');
    assert.equal(M.getComponent(componentId)!.attestation_status, 'passthrough');
  });

  test('no attestation is honest absence, not a third tier', () => {
    const { componentId, token } = M.issueProvisioningToken({ tenantId: TENANT });
    M.redeemProvisioningToken({ token, tenantId: TENANT, buildMeasurement: BUILD });
    assert.equal(M.getComponent(componentId)!.attestation_status, null);
    assert.equal(M.getComponent(componentId)!.attestation_provider, 'none');
  });
});

// ---------------------------------------------------------------------------
describe('POST /api/v2/components/provision', () => {
  test('no credential is 401', async () => {
    const { token } = M.issueProvisioningToken({ tenantId: TENANT });
    const res = await M.POST(provisionReq(undefined, { token, build_measurement: BUILD }));
    assert.equal(res.status, 401);
  });

  test('a key without component:provision is 403 naming the scope', async () => {
    const key = issueKey(TENANT, ['read']);
    const { token } = M.issueProvisioningToken({ tenantId: TENANT });
    const res = await M.POST(provisionReq(key, { token, build_measurement: BUILD }));
    assert.equal(res.status, 403);
    const body = (await res.json()) as { error: { code: string; message: string } };
    assert.equal(body.error.code, 'forbidden_scope');
    // §10 C-5: the scope this route requires is its own, and the 403 names
    // the one that is missing rather than the one it used to borrow.
    assert.match(body.error.message, /component:provision/);
  });

  test('a legacy baseline:write key still provisions — C-5 must not revoke a live capability', async () => {
    // Every key issued before component:provision existed carried
    // baseline:write and could provision. Enforcing the new scope bare
    // would break those at the next component restart and the failure
    // would look like a bug in the component. V2_SCOPE_GRANTS is where the
    // grant is written down; this is the test that says it is load-bearing
    // rather than tidy.
    const key = issueKey(TENANT, ['baseline:write']);
    const { componentId, token } = M.issueProvisioningToken({ tenantId: TENANT });
    const res = await M.POST(provisionReq(key, { token, build_measurement: BUILD }));
    assert.equal(res.status, 201);
    assert.equal(((await res.json()) as { component_id: string }).component_id, componentId);
  });

  test('a key minted with component:provision alone provisions — the target state', async () => {
    const key = issueKey(TENANT, ['component:provision']);
    const { componentId, token } = M.issueProvisioningToken({ tenantId: TENANT });
    const res = await M.POST(provisionReq(key, { token, build_measurement: BUILD }));
    assert.equal(res.status, 201);
    assert.equal(((await res.json()) as { component_id: string }).component_id, componentId);
  });

  test('a scoped key plus a valid token returns 201 with the IK and the key schedule', async () => {
    const key = issueKey(TENANT, ['baseline:write']);
    const { componentId, token } = M.issueProvisioningToken({ tenantId: TENANT });
    const res = await M.POST(provisionReq(key, { token, build_measurement: BUILD }));
    assert.equal(res.status, 201);
    const body = (await res.json()) as Record<string, string & Record<string, string>>;
    assert.equal(body.component_id, componentId);
    assert.equal(body.ik_hex, M.deriveIk(M.bdk(), componentId).toString('hex'));
    assert.equal(Number(body.counter), 0);
    // The schedule ships in the response so an implementer never guesses
    // and a mismatch surfaces here rather than at the first rejected MAC.
    assert.match(body.key_schedule.ik, /HKDF-SHA256\(ikm=BDK, salt=component_id/);
    assert.match(body.key_schedule.mac_key, /HKDF-Expand\(K_n, "scruple\/mac\/v1", 32\)/);
    assert.match(body.key_schedule.order, /derive, MAC, ratchet, then enqueue/);
  });

  test('a malformed build_measurement is 400 — an uncomparable measurement is decoration', async () => {
    const key = issueKey(TENANT, ['baseline:write']);
    const { token } = M.issueProvisioningToken({ tenantId: TENANT });
    const res = await M.POST(provisionReq(key, { token, build_measurement: 'v1.2.3' }));
    assert.equal(res.status, 400);
  });

  test('another tenant\'s token is 404, not a distinguishable 403', async () => {
    // Same reasoning lib/v2/auth.ts applies to key lookup: the difference
    // is useful to someone probing for live tokens and useless to a
    // component, which must re-provision either way.
    const key = issueKey(OTHER_TENANT, ['baseline:write']);
    const { token } = M.issueProvisioningToken({ tenantId: TENANT });
    const res = await M.POST(provisionReq(key, { token, build_measurement: BUILD }));
    assert.equal(res.status, 404);
  });

  test('a consumed token is 409 and says why a lost seal needs a NEW component_id', async () => {
    const key = issueKey(TENANT, ['baseline:write']);
    const { token } = M.issueProvisioningToken({ tenantId: TENANT });
    assert.equal((await M.POST(provisionReq(key, { token, build_measurement: BUILD }))).status, 201);
    const res = await M.POST(provisionReq(key, { token, build_measurement: BUILD }));
    assert.equal(res.status, 409);
    const body = (await res.json()) as { error: { message: string } };
    assert.match(body.error.message, /NEW component_id/);
  });
});

// ---------------------------------------------------------------------------
describe('§4.2 — verification', () => {
  function provisioned(label = 'c') {
    const { componentId, token } = M.issueProvisioningToken({ tenantId: TENANT, label });
    const r = M.redeemProvisioningToken({ token, tenantId: TENANT, buildMeasurement: BUILD });
    assert.ok(r.ok);
    return { componentId, ratchet: component(componentId) };
  }

  const fields = (componentId: string, n: number) => ({
    component_id: componentId,
    counter: n,
    content_hash: crypto.createHash('sha256').update(`c${n}`).digest('hex'),
  });

  test('a genuine event verifies, with no gap', () => {
    const { componentId, ratchet } = provisioned();
    const f = fields(componentId, 0);
    const { counter, mac } = ratchet.mac(f);
    const r = M.verifySubmission(PRINCIPAL, { componentId, counter, mac, preimage: f, buildMeasurement: BUILD });
    assert.ok(r.ok);
    assert.equal(r.counter, 0);
    assert.equal(r.gap, 0);
    assert.equal(M.getComponent(componentId)!.last_verified_counter, 0);
  });

  test('a long run of consecutive events all verify', () => {
    const { componentId, ratchet } = provisioned();
    for (let n = 0; n < 25; n++) {
      const f = fields(componentId, n);
      const { counter, mac } = ratchet.mac(f);
      const r = M.verifySubmission(PRINCIPAL, { componentId, counter, mac, preimage: f });
      assert.ok(r.ok, `n=${n}`);
      assert.equal(r.gap, 0);
    }
    assert.equal(M.getComponent(componentId)!.last_verified_counter, 24);
  });

  test('a forged MAC does not verify', () => {
    const { componentId, ratchet } = provisioned();
    const f = fields(componentId, 0);
    ratchet.mac(f);
    const r = M.verifySubmission(PRINCIPAL, {
      componentId,
      counter: 0,
      mac: 'f'.repeat(64),
      preimage: f,
    });
    assert.equal(r.ok, false);
    assert.equal((r as { reason: string }).reason, 'bad_mac');
    // and a failed verification must not advance the high-water mark,
    // or a forgery attempt would burn a counter for the real component.
    assert.equal(M.getComponent(componentId)!.last_verified_counter, null);
  });

  test('a MAC over different bytes than were submitted does not verify', () => {
    const { componentId, ratchet } = provisioned();
    const f = fields(componentId, 0);
    const { counter, mac } = ratchet.mac(f);
    const tampered = { ...f, content_hash: 'e'.repeat(64) };
    const r = M.verifySubmission(PRINCIPAL, { componentId, counter, mac, preimage: tampered });
    assert.equal(r.ok, false);
    assert.equal((r as { reason: string }).reason, 'bad_mac');
  });

  test('one component\'s MAC does not verify under another\'s id', () => {
    const a = provisioned('a');
    const b = provisioned('b');
    const f = fields(a.componentId, 0);
    const { counter, mac } = a.ratchet.mac(f);
    const r = M.verifySubmission(PRINCIPAL, { componentId: b.componentId, counter, mac, preimage: f });
    assert.equal(r.ok, false);
    assert.equal((r as { reason: string }).reason, 'bad_mac');
  });

  test('an unprovisioned component cannot have produced a valid MAC', () => {
    const { componentId } = M.issueProvisioningToken({ tenantId: TENANT });
    const ratchet = component(componentId);
    const f = fields(componentId, 0);
    const { counter, mac } = ratchet.mac(f);
    const r = M.verifySubmission(PRINCIPAL, { componentId, counter, mac, preimage: f });
    assert.equal(r.ok, false);
    assert.equal((r as { reason: string }).reason, 'not_provisioned');
  });

  test('an unknown component is refused', () => {
    const r = M.verifySubmission(PRINCIPAL, {
      componentId: crypto.randomUUID(),
      counter: 0,
      mac: '0'.repeat(64),
      preimage: { a: 'b' },
    });
    assert.equal(r.ok, false);
    assert.equal((r as { reason: string }).reason, 'unknown_component');
  });
});

// ---------------------------------------------------------------------------
describe('§4.2 — replay and reuse are REJECTED, not merely noticed', () => {
  function running(events: number) {
    const { componentId, token } = M.issueProvisioningToken({ tenantId: TENANT });
    assert.ok(M.redeemProvisioningToken({ token, tenantId: TENANT, buildMeasurement: BUILD }).ok);
    const ratchet = component(componentId);
    const sent: Array<{
      counter: number;
      mac: string;
      preimage: Record<string, string | number | boolean | null>;
    }> = [];
    for (let n = 0; n < events; n++) {
      const f = { component_id: componentId, counter: n };
      const { counter, mac } = ratchet.mac(f);
      assert.ok(M.verifySubmission(PRINCIPAL, { componentId, counter, mac, preimage: f }).ok);
      sent.push({ counter, mac, preimage: f });
    }
    return { componentId, ratchet, sent };
  }

  test('re-sending the exact same event is dropped idempotently, not accepted twice', () => {
    // §5: a retry out of queue.py re-sends the same bytes. That is the
    // designed behaviour, so it is distinguished from an attack — but it
    // is still not a second verification.
    const { componentId, sent } = running(3);
    const again = M.verifySubmission(PRINCIPAL, { componentId, ...sent[1] });
    assert.equal(again.ok, false);
    assert.equal((again as { reason: string }).reason, 'duplicate');
    const rows = M.conn()
      .prepare(`SELECT COUNT(*) c FROM component_events WHERE component_id = ?`)
      .get(componentId) as { c: number };
    assert.equal(rows.c, 3, 'a duplicate must not create a second event row');
  });

  test('an EQUAL counter with a different MAC is rejected', () => {
    const { componentId, sent } = running(3);
    const r = M.verifySubmission(PRINCIPAL, {
      componentId,
      counter: sent[2].counter,
      mac: '1'.repeat(64),
      preimage: sent[2].preimage,
    });
    assert.equal(r.ok, false);
    assert.equal((r as { reason: string }).reason, 'replay');
  });

  test('a LOWER counter is rejected even with a MAC that would otherwise verify', () => {
    // The strongest form: the attacker replays a genuine, correctly MACed
    // event under a counter already consumed.
    //
    // AMENDED BY §10 C-3, and this is the exact case the amendment had to
    // be careful about. Strict increase used to be what stopped this, and
    // it is gone — a counter below the high-water mark is now acceptable
    // if it is unseen and inside the acceptance window, because that is a
    // queued event draining late (§5) rather than a replay. What stops
    // THIS one is that no open gap claims counter 1: these four events
    // were delivered consecutively, so nothing was ever outstanding. The
    // DELETE below is the point of the test — even with the event row
    // gone, the gap table is a second, independent record that says the
    // counter was spent, and it is believed.
    const { componentId, sent } = running(4);
    M.conn().prepare(`DELETE FROM component_events WHERE component_id = ? AND counter = 1`).run(componentId);
    const r = M.verifySubmission(PRINCIPAL, { componentId, ...sent[1] });
    assert.equal(r.ok, false);
    assert.equal((r as { reason: string }).reason, 'replay');
    assert.match((r as { message: string }).message, /no open gap claims it/);
  });

  test('event 0 cannot be replayed on a component that has verified event 0', () => {
    // NULL last_verified_counter must not be conflated with 0, or event 0
    // is replayable exactly once. This is that test.
    const { componentId, sent } = running(1);
    M.conn().prepare(`DELETE FROM component_events WHERE component_id = ?`).run(componentId);
    const r = M.verifySubmission(PRINCIPAL, { componentId, ...sent[0] });
    assert.equal(r.ok, false);
    assert.equal((r as { reason: string }).reason, 'replay');
  });

  test('a counter absurdly far ahead is refused rather than costing unbounded CPU', () => {
    // NOT IN THE SPEC. The counter travels in the clear and is therefore
    // attacker-chosen; "ratchet forward to the received counter" with no
    // bound is a free CPU-exhaustion primitive.
    const { componentId } = running(1);
    const r = M.verifySubmission(PRINCIPAL, {
      componentId,
      counter: M.MAX_RATCHET_ADVANCE + 10_000,
      mac: '0'.repeat(64),
      preimage: { a: 'b' },
    });
    assert.equal(r.ok, false);
    assert.equal((r as { reason: string }).reason, 'counter_too_far');
  });

  test('a negative or fractional counter is refused', () => {
    const { componentId } = running(1);
    for (const counter of [-1, 1.5, NaN]) {
      const r = M.verifySubmission(PRINCIPAL, { componentId, counter, mac: '0'.repeat(64), preimage: { a: 'b' } });
      assert.equal(r.ok, false);
      assert.equal((r as { reason: string }).reason, 'invalid_counter');
    }
  });
});

// ---------------------------------------------------------------------------
describe('§4.2 — a gap VERIFIES and is RECORDED', () => {
  test('n = last + 4 verifies, and three missing events become a first-class fact', () => {
    // Load-bearing: "a suppressed event must not be able to invalidate the
    // events around it, or suppression becomes an attack on the vendor."
    const { componentId, token } = M.issueProvisioningToken({ tenantId: TENANT });
    assert.ok(M.redeemProvisioningToken({ token, tenantId: TENANT, buildMeasurement: BUILD }).ok);
    const ratchet = component(componentId);

    const f0 = { component_id: componentId, counter: 0 };
    const e0 = ratchet.mac(f0);
    assert.ok(M.verifySubmission(PRINCIPAL, { componentId, counter: e0.counter, mac: e0.mac, preimage: f0 }).ok);

    // The component produces 1, 2, 3 — none of which are delivered.
    for (let n = 1; n <= 3; n++) ratchet.mac({ component_id: componentId, counter: n });

    const f4 = { component_id: componentId, counter: 4 };
    const e4 = ratchet.mac(f4);
    const r = M.verifySubmission(PRINCIPAL, { componentId, counter: e4.counter, mac: e4.mac, preimage: f4 });

    assert.ok(r.ok, 'the leaf must still VERIFY across a gap');
    assert.equal(r.counter, 4);
    assert.equal(r.gap, 3);
    assert.ok(r.gap_id !== null);

    const gaps = M.openGaps(componentId);
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0].from_counter, 0);
    assert.equal(gaps[0].to_counter, 4);
    assert.equal(gaps[0].missing_count, 3);
    assert.equal(M.getComponent(componentId)!.last_verified_counter, 4);
  });

  test('a gap before the very first delivered event is recorded with from_counter NULL', () => {
    const { componentId, token } = M.issueProvisioningToken({ tenantId: TENANT });
    assert.ok(M.redeemProvisioningToken({ token, tenantId: TENANT, buildMeasurement: BUILD }).ok);
    const ratchet = component(componentId);
    for (let n = 0; n < 2; n++) ratchet.mac({ component_id: componentId, counter: n });
    const f = { component_id: componentId, counter: 2 };
    const e = ratchet.mac(f);
    const r = M.verifySubmission(PRINCIPAL, { componentId, counter: e.counter, mac: e.mac, preimage: f });
    assert.ok(r.ok);
    assert.equal(r.gap, 2);
    const gaps = M.openGaps(componentId);
    assert.equal(gaps[0].from_counter, null);
    assert.equal(gaps[0].missing_count, 2);
  });

  test('a large gap still verifies — the server ratchets through it', () => {
    const { componentId, token } = M.issueProvisioningToken({ tenantId: TENANT });
    assert.ok(M.redeemProvisioningToken({ token, tenantId: TENANT, buildMeasurement: BUILD }).ok);
    const ratchet = component(componentId);
    for (let n = 0; n < 500; n++) ratchet.mac({ component_id: componentId, counter: n });
    const f = { component_id: componentId, counter: 500 };
    const e = ratchet.mac(f);
    const r = M.verifySubmission(PRINCIPAL, { componentId, counter: 500, mac: e.mac, preimage: f });
    assert.ok(r.ok);
    assert.equal(r.gap, 500);
  });

  test('gaps accumulate as separate rows — resolving one must not mean deleting it', () => {
    const { componentId, token } = M.issueProvisioningToken({ tenantId: TENANT });
    assert.ok(M.redeemProvisioningToken({ token, tenantId: TENANT, buildMeasurement: BUILD }).ok);
    const ratchet = component(componentId);
    let n = 0;
    const deliver = () => {
      const f = { component_id: componentId, counter: n };
      const e = ratchet.mac(f);
      const r = M.verifySubmission(PRINCIPAL, { componentId, counter: n, mac: e.mac, preimage: f });
      n++;
      return r;
    };
    const skip = (k: number) => {
      for (let i = 0; i < k; i++) {
        ratchet.mac({ component_id: componentId, counter: n });
        n++;
      }
    };
    assert.ok(deliver().ok);
    skip(2);
    assert.ok(deliver().ok);
    skip(5);
    assert.ok(deliver().ok);
    assert.equal(M.openGaps(componentId).length, 2);
    assert.deepEqual(
      M.openGaps(componentId).map((g) => g.missing_count).sort((a, b) => a - b),
      [2, 5],
    );
  });
});

// ---------------------------------------------------------------------------
describe('§4.3 — the build measurement rides with the event', () => {
  test('a leaf declaring a different build verifies and is flagged, not rejected', () => {
    // A vendor legitimately redeploys a newly published build without
    // re-provisioning. Recording the change is the point; rejecting it
    // would make publishing a new component version an outage.
    const { componentId, token } = M.issueProvisioningToken({ tenantId: TENANT });
    assert.ok(M.redeemProvisioningToken({ token, tenantId: TENANT, buildMeasurement: BUILD }).ok);
    const ratchet = component(componentId);
    const other = 'sha256:' + 'cd'.repeat(32);
    const f = { component_id: componentId, counter: 0, build_measurement: other };
    const e = ratchet.mac(f);
    const r = M.verifySubmission(PRINCIPAL, {
      componentId,
      counter: 0,
      mac: e.mac,
      preimage: f,
      buildMeasurement: other,
    });
    assert.ok(r.ok);
    assert.equal(r.build_changed, true);
    const row = M.conn()
      .prepare(`SELECT build_measurement FROM component_events WHERE component_id = ? AND counter = 0`)
      .get(componentId) as { build_measurement: string };
    assert.equal(row.build_measurement, other);
  });
});

// ---------------------------------------------------------------------------
describe('Missing 2 — silence is visible', () => {
  test('a component past its heartbeat window is reported silent', () => {
    const { componentId, token } = M.issueProvisioningToken({
      tenantId: TENANT,
      heartbeatWindowSeconds: 60,
    });
    assert.ok(M.redeemProvisioningToken({ token, tenantId: TENANT, buildMeasurement: BUILD }).ok);
    const old = new Date(Date.now() - 3600_000).toISOString();
    M.conn().prepare(`UPDATE components SET last_seen_at = ? WHERE component_id = ?`).run(old, componentId);
    const silent = M.silentComponents(TENANT).map((s) => s.component_id);
    assert.ok(silent.includes(componentId));
  });

  test('a component that provisioned and then produced NOTHING is silent, not healthy', () => {
    // The Kohya failure exactly: a capture path gone dark produced the
    // same observable as a quiet afternoon. A NULL last_seen_at must not
    // read as healthy.
    const { componentId, token } = M.issueProvisioningToken({
      tenantId: TENANT,
      heartbeatWindowSeconds: 1,
    });
    assert.ok(M.redeemProvisioningToken({ token, tenantId: TENANT, buildMeasurement: BUILD }).ok);
    M.conn()
      .prepare(`UPDATE components SET provisioned_at = ?, last_seen_at = NULL WHERE component_id = ?`)
      .run(new Date(Date.now() - 3600_000).toISOString(), componentId);
    assert.ok(M.silentComponents(TENANT).some((s) => s.component_id === componentId));
  });

  test('a component seen just now is not silent', () => {
    const { componentId, token } = M.issueProvisioningToken({
      tenantId: TENANT,
      heartbeatWindowSeconds: 3600,
    });
    assert.ok(M.redeemProvisioningToken({ token, tenantId: TENANT, buildMeasurement: BUILD }).ok);
    const ratchet = component(componentId);
    const f = { component_id: componentId, counter: 0 };
    const e = ratchet.mac(f);
    assert.ok(M.verifySubmission(PRINCIPAL, { componentId, counter: 0, mac: e.mac, preimage: f }).ok);
    assert.ok(!M.silentComponents(TENANT).some((s) => s.component_id === componentId));
  });
});

// ---------------------------------------------------------------------------
describe('the chain-key cache is a cache, not the source of truth', () => {
  test('clearing it changes nothing — the server re-derives from the BDK', () => {
    const { componentId, token } = M.issueProvisioningToken({ tenantId: TENANT });
    assert.ok(M.redeemProvisioningToken({ token, tenantId: TENANT, buildMeasurement: BUILD }).ok);
    const ratchet = component(componentId);
    for (let n = 0; n < 5; n++) {
      const f = { component_id: componentId, counter: n };
      const e = ratchet.mac(f);
      assert.ok(M.verifySubmission(PRINCIPAL, { componentId, counter: n, mac: e.mac, preimage: f }).ok);
    }
    M.conn()
      .prepare(`UPDATE components SET chain_key_hex = NULL, chain_key_counter = NULL WHERE component_id = ?`)
      .run(componentId);
    const f = { component_id: componentId, counter: 5 };
    const e = ratchet.mac(f);
    assert.ok(M.verifySubmission(PRINCIPAL, { componentId, counter: 5, mac: e.mac, preimage: f }).ok);
  });

  test('a cache from a different BDK is ignored rather than trusted', () => {
    // A rotated or mistyped BDK otherwise splits the estate in two, with
    // both halves looking healthy. bdk_fingerprint is what catches it.
    const { componentId, token } = M.issueProvisioningToken({ tenantId: TENANT });
    assert.ok(M.redeemProvisioningToken({ token, tenantId: TENANT, buildMeasurement: BUILD }).ok);
    M.conn()
      .prepare(
        `UPDATE components SET chain_key_hex = ?, chain_key_counter = 0, bdk_fingerprint = 'stale'
          WHERE component_id = ?`,
      )
      .run('99'.repeat(32), componentId);
    const ratchet = component(componentId);
    const f = { component_id: componentId, counter: 0 };
    const e = ratchet.mac(f);
    assert.ok(M.verifySubmission(PRINCIPAL, { componentId, counter: 0, mac: e.mac, preimage: f }).ok);
  });
});

// ---------------------------------------------------------------------------
describe('BDK custody — fail closed', () => {
  // Run in a child process, because the guard's whole behaviour is
  // process.exit(1) and asserting on that in-process would kill the
  // runner. Demonstrated, not asserted: the witness server's SECRET block
  // used to fall back to a constant published in the same file, so every
  // leaf it sealed was forgeable by anyone who had read the source and
  // nothing downstream could tell. A BDK with a default would be that,
  // once per component, forever.
  const child = (env: Record<string, string | undefined>) =>
    spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '-e',
        `import(${JSON.stringify(path.join(process.cwd(), 'lib', 'ratchet', 'bdk.ts'))})` +
          `.then(m => { const b = m.bdk(); console.log('OK ' + b.length); })`,
      ],
      { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, ...env } },
    );

  test('an unset SCRUPLE_BDK_HEX exits 1 rather than inventing a key', () => {
    const r = child({ SCRUPLE_BDK_HEX: undefined, SCRUPLE_BDK_ALLOW_DEV: undefined });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /FATAL: SCRUPLE_BDK_HEX is not set/);
    assert.doesNotMatch(r.stdout, /OK/);
  });

  test('a short BDK exits 1 rather than being padded or accepted', () => {
    const r = child({ SCRUPLE_BDK_HEX: 'ab'.repeat(8), SCRUPLE_BDK_ALLOW_DEV: undefined });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /decodes to 8 bytes/);
  });

  test('a non-hex BDK exits 1 rather than being coerced', () => {
    const r = child({ SCRUPLE_BDK_HEX: 'not-hex-at-all', SCRUPLE_BDK_ALLOW_DEV: undefined });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /not an even-length hex string/);
  });

  test('the dev BDK requires an explicit opt-in and says loudly what it costs', () => {
    const r = child({ SCRUPLE_BDK_HEX: undefined, SCRUPLE_BDK_ALLOW_DEV: '1' });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /OK 32/);
    assert.match(r.stderr, /PUBLISHED DEV BDK/);
  });

  test('a real BDK is accepted', () => {
    const r = child({ SCRUPLE_BDK_HEX: 'cd'.repeat(32), SCRUPLE_BDK_ALLOW_DEV: undefined });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /OK 32/);
  });
});
