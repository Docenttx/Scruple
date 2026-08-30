// Reconciliation — §10 C-3's bounded acceptance window, silence, and the
// status view.
//
// The regression this file exists for has a name: an out-of-order drain.
// §5 says a queued event KEEPS its counter and drains later; §4.2 said a
// counter must strictly exceed the high-water mark. Under both rules at
// once, a genuinely captured event that drains after a later one is
// rejected as a replay and LOST FROM THE RECORD — evidence discarded to
// buy an ordering purity nothing needs, since the counter itself already
// carries the order. C-3 replaces strict increase with a bounded window
// and leaves replay defence where it already was: the PRIMARY KEY on
// (component_id, counter).
//
// Everything here is demonstrated against the real ratchet, from a real
// IK, through the same verifySubmission() the route calls.
//
// TEST ISOLATION, as in test/v2/components-provision.test.ts: `npm run
// test:v2` runs every file CONCURRENTLY against one shared
// SCRUPLE_DB_PATH, so this file takes its own private database and
// imports everything DB-touching dynamically inside before().

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (!process.env.SCRUPLE_DB_PATH || !/tmp|test/i.test(process.env.SCRUPLE_DB_PATH)) {
  throw new Error('Refusing to run: set SCRUPLE_DB_PATH to a throwaway path. Use `npm run test:v2`.');
}
const OWN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'scruple-reconcile-'));
process.env.SCRUPLE_DB_PATH = path.join(OWN_DIR, 'reconcile.db');

// A test BDK, set before anything calls bdk().
process.env.SCRUPLE_BDK_HEX = '11'.repeat(32);
delete process.env.SCRUPLE_BDK_ALLOW_DEV;

// The standing safety rule: nothing here reaches the production witness
// server on 127.0.0.1:5799.
process.env.WITNESS_SERVER_URL = 'http://127.0.0.1:1';

type Mod = {
  conn: typeof import('../../lib/db/sqlite').conn;
  runMigrations: typeof import('../../lib/db/migrate').runMigrations;
  issueProvisioningToken: typeof import('../../lib/ratchet/provisioning').issueProvisioningToken;
  redeemProvisioningToken: typeof import('../../lib/ratchet/provisioning').redeemProvisioningToken;
  verifySubmission: typeof import('../../lib/ratchet/verify').verifySubmission;
  getComponent: typeof import('../../lib/ratchet/verify').getComponent;
  openGaps: typeof import('../../lib/ratchet/verify').openGaps;
  allGaps: typeof import('../../lib/ratchet/verify').allGaps;
  windowFloor: typeof import('../../lib/ratchet/verify').windowFloor;
  ACCEPTANCE_WINDOW_COUNTERS: number;
  assess: typeof import('../../lib/reconcile/silence').assess;
  assessComponent: typeof import('../../lib/reconcile/silence').assessComponent;
  silentComponents: typeof import('../../lib/reconcile/silence').silentComponents;
  sweepSilence: typeof import('../../lib/reconcile/silence').sweepSilence;
  silenceHistory: typeof import('../../lib/reconcile/silence').silenceHistory;
  componentStatus: typeof import('../../lib/reconcile/status').componentStatus;
  reconcileTenant: typeof import('../../lib/reconcile/status').reconcileTenant;
  deriveIk: typeof import('../../lib/ratchet/ratchet').deriveIk;
  ratchetForward: typeof import('../../lib/ratchet/ratchet').ratchetForward;
  Ratchet: typeof import('../../lib/ratchet/ratchet').Ratchet;
  bdk: typeof import('../../lib/ratchet/bdk').bdk;
  GET: (req: Request) => Promise<Response>;
};

let M: Mod;
const TENANT = 'vendor-r1';
const OTHER_TENANT = 'vendor-r2';
const BUILD = 'sha256:' + 'ab'.repeat(32);

before(async () => {
  const [sqlite, migrate, prov, verify, silence, status, ratchet, bdkMod, route] = await Promise.all([
    import('../../lib/db/sqlite'),
    import('../../lib/db/migrate'),
    import('../../lib/ratchet/provisioning'),
    import('../../lib/ratchet/verify'),
    import('../../lib/reconcile/silence'),
    import('../../lib/reconcile/status'),
    import('../../lib/ratchet/ratchet'),
    import('../../lib/ratchet/bdk'),
    import('../../app/api/v2/components/status/route'),
  ]);
  M = {
    conn: sqlite.conn,
    runMigrations: migrate.runMigrations,
    issueProvisioningToken: prov.issueProvisioningToken,
    redeemProvisioningToken: prov.redeemProvisioningToken,
    verifySubmission: verify.verifySubmission,
    getComponent: verify.getComponent,
    openGaps: verify.openGaps,
    allGaps: verify.allGaps,
    windowFloor: verify.windowFloor,
    ACCEPTANCE_WINDOW_COUNTERS: verify.ACCEPTANCE_WINDOW_COUNTERS,
    assess: silence.assess,
    assessComponent: silence.assessComponent,
    silentComponents: silence.silentComponents,
    sweepSilence: silence.sweepSilence,
    silenceHistory: silence.silenceHistory,
    componentStatus: status.componentStatus,
    reconcileTenant: status.reconcileTenant,
    deriveIk: ratchet.deriveIk,
    ratchetForward: ratchet.ratchetForward,
    Ratchet: ratchet.Ratchet,
    bdk: bdkMod.bdk,
    GET: route.GET as unknown as (req: Request) => Promise<Response>,
  };
  M.runMigrations(false);
  M.conn().prepare(`INSERT INTO users (id, email) VALUES (?, 'r1@example.com')`).run(TENANT);
  M.conn().prepare(`INSERT INTO users (id, email) VALUES (?, 'r2@example.com')`).run(OTHER_TENANT);
});

after(() => {
  try {
    fs.rmSync(OWN_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// ---------------------------------------------------------------------------
// A simulated component: it holds a real ratchet, produces events in
// order, and lets the test choose which ones reach the server and when.
// That is the whole subject matter — the component's ordering and the
// server's arrival order are not the same thing.
// ---------------------------------------------------------------------------

interface Produced {
  counter: number;
  mac: string;
  preimage: Record<string, string | number | boolean | null>;
}

function simulate(opts: { tenantId?: string; heartbeat?: number; window?: number; label?: string } = {}) {
  const tenantId = opts.tenantId ?? TENANT;
  const { componentId, token } = M.issueProvisioningToken({
    tenantId,
    label: opts.label ?? 'comfy',
    heartbeatWindowSeconds: opts.heartbeat ?? 900,
  });
  assert.ok(M.redeemProvisioningToken({ token, tenantId, buildMeasurement: BUILD }).ok);
  if (opts.window !== undefined) {
    M.conn()
      .prepare(`UPDATE components SET acceptance_window_counters = ? WHERE component_id = ?`)
      .run(opts.window, componentId);
  }
  const ik = M.deriveIk(M.bdk(), componentId);
  const ratchet = new M.Ratchet(ik, 0);
  // §10 C-6: verification takes an authenticated principal as its first
  // argument, so the simulated component carries the tenant it was
  // provisioned under. A principal from another tenant gets
  // `unknown_component`, which is what the ownership check is for.
  const principal = { userId: tenantId, keyId: `key-${tenantId}` };

  /** Capture one event. The counter is spent here — derive, MAC, ratchet,
   *  THEN enqueue (§5) — whether or not it is ever delivered. */
  const produce = (): Produced => {
    const preimage = {
      component_id: componentId,
      counter: ratchet.counter,
      content_hash: crypto.createHash('sha256').update(`${componentId}:${ratchet.counter}`).digest('hex'),
    };
    const { counter, mac } = ratchet.mac(preimage);
    return { counter, mac, preimage };
  };
  const deliver = (e: Produced) =>
    M.verifySubmission(principal, { componentId, counter: e.counter, mac: e.mac, preimage: e.preimage, buildMeasurement: BUILD });
  const send = () => deliver(produce());

  return { componentId, tenantId, principal, produce, deliver, send };
}

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

const statusReq = (token: string | undefined, qs = '') =>
  new Request(`https://scruple.ai/api/v2/components/status${qs}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });

// ---------------------------------------------------------------------------
describe('migration 042 — the window, the checkpoint, and silence as a record', () => {
  test('the acceptance window and backfill checkpoint columns exist', () => {
    const cols = new Map(
      (M.conn().prepare(`PRAGMA table_info(components)`).all() as Array<{
        name: string;
        dflt_value: string | null;
      }>).map((c) => [c.name, c]),
    );
    assert.ok(cols.has('acceptance_window_counters'));
    assert.ok(cols.has('window_floor_counter'));
    assert.ok(cols.has('window_floor_key_hex'));
    assert.equal(cols.get('acceptance_window_counters')!.dflt_value, '1000');
  });

  test('component_events records whether an event arrived late', () => {
    const cols = (M.conn().prepare(`PRAGMA table_info(component_events)`).all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    assert.ok(cols.includes('backfilled'));
  });

  test('component_silence_events exists — a transition log, not a cached flag', () => {
    const names = (
      M.conn().prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]
    ).map((r) => r.name);
    assert.ok(names.includes('component_silence_events'));
  });
});

// ---------------------------------------------------------------------------
describe('§10 C-3 — the bounded acceptance window', () => {
  test('AN OUT-OF-ORDER DRAIN — counter n arriving after n+1 — IS ACCEPTED AND CLOSES THE GAP', () => {
    // THE regression. Under strict increase this event was refused as a
    // replay and a genuinely captured artifact vanished from the record.
    const c = simulate({ label: 'drain' });
    for (let i = 0; i < 3; i++) assert.ok(c.send().ok, `warm-up ${i}`);

    // Event 3 is captured and enqueued; the network is down, so it sits
    // in queue.py holding counter 3. Event 4 is captured next and the
    // link comes back in time for it.
    const held = c.produce();
    const later = c.produce();

    const r4 = c.deliver(later);
    assert.ok(r4.ok);
    assert.equal(r4.counter, 4);
    assert.equal(r4.gap, 1, 'counter 3 is outstanding and must be recorded as such');
    assert.equal(M.openGaps(c.componentId).length, 1);

    // The drain. This is the assertion the whole work order exists for.
    const r3 = c.deliver(held);
    assert.ok(r3.ok, 'a queued event draining after a later one MUST be accepted (§10 C-3)');
    assert.equal(r3.counter, 3);
    assert.equal(r3.backfilled, true);
    assert.equal(r3.gap, 0, 'a late drain fills a gap; it does not open one');
    assert.equal(r3.gaps_closed.length, 1);

    // The gap is closed, not deleted: "three events were held for two
    // hours and then drained" is a different fact from "nothing ever
    // went wrong", and the record has to keep both.
    assert.equal(M.openGaps(c.componentId).length, 0);
    const all = M.allGaps(c.componentId);
    assert.equal(all.length, 1);
    assert.ok(all[0].resolved_at !== null);

    // Five events captured, five events on record. Nothing lost.
    const n = M.conn()
      .prepare(`SELECT COUNT(*) c FROM component_events WHERE component_id = ?`)
      .get(c.componentId) as { c: number };
    assert.equal(n.c, 5);
  });

  test('a backfill does not drag the high-water mark or the chain-key cache backwards', () => {
    const c = simulate();
    for (let i = 0; i < 2; i++) assert.ok(c.send().ok);
    const held = c.produce();
    assert.ok(c.deliver(c.produce()).ok); // counter 3
    const before = M.getComponent(c.componentId)!;
    assert.equal(before.last_verified_counter, 3);

    assert.ok(c.deliver(held).ok);
    const after = M.getComponent(c.componentId)!;
    assert.equal(after.last_verified_counter, 3, 'a late arrival is not the newest event');
    assert.equal(after.chain_key_counter, before.chain_key_counter);
    assert.equal(after.chain_key_hex, before.chain_key_hex);
    // last_seen_at DOES move: the component is demonstrably alive.
    assert.ok(after.last_seen_at !== null);

    // And the forward path is undamaged — the next ordinary event still
    // verifies against the cache the backfill left alone.
    assert.ok(c.send().ok);
    assert.equal(M.getComponent(c.componentId)!.last_verified_counter, 4);
  });

  test('several held events drain in any order and all land', () => {
    const c = simulate();
    assert.ok(c.send().ok); // 0
    const a = c.produce(); // 1
    const b = c.produce(); // 2
    const d = c.produce(); // 3
    assert.ok(c.deliver(c.produce()).ok); // 4 arrives first
    assert.equal(M.openGaps(c.componentId)[0].missing_count, 3);

    for (const e of [d, a, b]) {
      const r = c.deliver(e);
      assert.ok(r.ok, `held counter ${e.counter} must land`);
      assert.equal(r.backfilled, true);
    }
    assert.equal(M.openGaps(c.componentId).length, 0, 'the gap closes only when the LAST one lands');
    const rows = M.conn()
      .prepare(`SELECT COUNT(*) c, SUM(backfilled) b FROM component_events WHERE component_id = ?`)
      .get(c.componentId) as { c: number; b: number };
    assert.equal(rows.c, 5);
    assert.equal(rows.b, 3);
  });

  test('a counter BELOW the window is refused as counter_too_far, not silently verified', () => {
    // The downward half of C-2's bound. Re-deriving the chain key that
    // far back is unbounded work on an attacker-chosen counter, and an
    // event held that long is an outage to re-provision after rather
    // than a leaf to accept.
    const c = simulate({ window: 4 });
    assert.ok(c.send().ok); // 0
    const ancient = c.produce(); // 1 — captured, never delivered
    for (let i = 0; i < 18; i++) assert.ok(c.send().ok); // 2..19

    const row = M.getComponent(c.componentId)!;
    assert.equal(row.last_verified_counter, 19);
    assert.equal(M.windowFloor(row), 16);

    const r = c.deliver(ancient);
    assert.equal(r.ok, false);
    assert.equal((r as { reason: string }).reason, 'counter_too_far');
    assert.match((r as { message: string }).message, /below this component's high-water mark/);

    // Refused, and still visible: the gap stays open, so the evidence
    // that something was produced and never arrived does not disappear
    // along with the rejected submission.
    assert.ok(M.openGaps(c.componentId).some((g) => g.missing_count === 1));
  });

  test('a late drain just inside a narrow window is still accepted', () => {
    const c = simulate({ window: 4 });
    for (let i = 0; i < 18; i++) assert.ok(c.send().ok); // 0..17
    const held = c.produce(); // 18
    assert.ok(c.deliver(c.produce()).ok); // 19
    assert.equal(M.windowFloor(M.getComponent(c.componentId)!), 16);
    const r = c.deliver(held);
    assert.ok(r.ok, 'counter 18 is inside the window and must land');
    assert.equal(r.backfilled, true);
  });

  test('exact re-delivery is still `duplicate` and still idempotent', () => {
    // §5's retry. Unchanged by C-3, and it has to be: the queue re-sends
    // the same bytes on every backoff step.
    const c = simulate();
    const e = c.produce();
    assert.ok(c.deliver(e).ok);
    for (let i = 0; i < 3; i++) {
      const again = c.deliver(e);
      assert.equal(again.ok, false);
      assert.equal((again as { reason: string }).reason, 'duplicate');
    }
    const n = M.conn()
      .prepare(`SELECT COUNT(*) c FROM component_events WHERE component_id = ?`)
      .get(c.componentId) as { c: number };
    assert.equal(n.c, 1, 'three retries must not become three events');
  });

  test('re-delivering a BACKFILLED event is a duplicate too', () => {
    const c = simulate();
    assert.ok(c.send().ok);
    const held = c.produce();
    assert.ok(c.deliver(c.produce()).ok);
    assert.ok(c.deliver(held).ok);
    const again = c.deliver(held);
    assert.equal(again.ok, false);
    assert.equal((again as { reason: string }).reason, 'duplicate');
  });

  test('the same counter with DIFFERENT bytes is refused however it arrives', () => {
    const c = simulate();
    assert.ok(c.send().ok);
    const held = c.produce();
    assert.ok(c.deliver(c.produce()).ok);
    assert.ok(c.deliver(held).ok);
    const forged = { ...held, mac: 'a'.repeat(64) };
    const r = c.deliver(forged);
    assert.equal(r.ok, false);
    assert.equal((r as { reason: string }).reason, 'replay');
  });

  test('a counter inside the window that no gap claims is refused — the window is not an amnesty', () => {
    // Delivered consecutively, so nothing was ever outstanding. Deleting
    // the event row leaves the gap table as the second record, and it
    // says counter 1 was spent.
    const c = simulate();
    const sent: Produced[] = [];
    for (let i = 0; i < 4; i++) {
      const e = c.produce();
      assert.ok(c.deliver(e).ok);
      sent.push(e);
    }
    M.conn()
      .prepare(`DELETE FROM component_events WHERE component_id = ? AND counter = 1`)
      .run(c.componentId);
    const r = c.deliver(sent[1]);
    assert.equal(r.ok, false);
    assert.equal((r as { reason: string }).reason, 'replay');
  });

  test('a forged MAC on a backfilled counter does not verify', () => {
    const c = simulate();
    assert.ok(c.send().ok);
    const held = c.produce();
    assert.ok(c.deliver(c.produce()).ok);
    const r = M.verifySubmission(c.principal, {
      componentId: c.componentId,
      counter: held.counter,
      mac: 'b'.repeat(64),
      preimage: held.preimage,
    });
    assert.equal(r.ok, false);
    assert.equal((r as { reason: string }).reason, 'bad_mac');
    // and the gap is still open, because nothing verified.
    assert.equal(M.openGaps(c.componentId).length, 1);
  });
});

// ---------------------------------------------------------------------------
describe('the backfill checkpoint — what looking backwards costs', () => {
  test('the window floor tracks the high-water mark and holds the RIGHT key', () => {
    // The chain is one-way, so a backfill re-derives forward from a
    // checkpoint at or before the target. Without one that is `counter`
    // HMACs — and past MAX_RATCHET_ADVANCE it would be refused outright,
    // so the window would quietly stop working on a long-lived
    // component. The floor caps it at the window size.
    const c = simulate({ window: 8 });
    for (let i = 0; i < 30; i++) assert.ok(c.send().ok); // 0..29
    const row = M.getComponent(c.componentId)!;
    assert.equal(row.last_verified_counter, 29);
    assert.equal(row.window_floor_counter, 22, 'floor = high-water + 1 - window');

    const ik = M.deriveIk(M.bdk(), c.componentId);
    const expected = M.ratchetForward(ik, 22).toString('hex');
    assert.equal(row.window_floor_key_hex, expected, 'the cached floor key must be K_22 exactly');
  });

  test('no floor key is stored while the floor is 0 — K_0 is the IK', () => {
    const c = simulate();
    for (let i = 0; i < 3; i++) assert.ok(c.send().ok);
    const row = M.getComponent(c.componentId)!;
    assert.equal(row.window_floor_counter, null);
    assert.equal(row.window_floor_key_hex, null);
  });

  test('the floor checkpoint is a cache — deleting it changes only CPU', () => {
    const c = simulate({ window: 8 });
    for (let i = 0; i < 12; i++) assert.ok(c.send().ok); // 0..11
    const held = c.produce(); // 12
    assert.ok(c.deliver(c.produce()).ok); // 13
    M.conn()
      .prepare(
        `UPDATE components SET window_floor_counter = NULL, window_floor_key_hex = NULL
          WHERE component_id = ?`,
      )
      .run(c.componentId);
    const r = c.deliver(held);
    assert.ok(r.ok, 'the server re-derives from the IK when no checkpoint is usable');
    assert.equal(r.backfilled, true);
  });
});

// ---------------------------------------------------------------------------
describe('§4.2 — a suppressed event must not invalidate the leaves around it', () => {
  test('the neighbours of a suppressed counter verify, and keep verifying', () => {
    // The tenant is the adversary (§1) and is the party best placed to
    // suppress. If suppressing one event invalidated its neighbours,
    // suppression would be an attack on the vendor's whole record.
    const c = simulate();
    assert.ok(c.send().ok); // 0
    assert.ok(c.send().ok); // 1
    c.produce(); // 2 — captured, suppressed, never delivered
    const r3 = c.deliver(c.produce());
    assert.ok(r3.ok, 'the event after the suppressed one still verifies');
    assert.equal(r3.gap, 1);
    const r4 = c.send();
    assert.ok(r4.ok, 'and so does the one after that');
    assert.equal(r4.gap, 0);

    // The gap is a fact on the record, and it stays open because the
    // event genuinely never arrived.
    const gaps = M.openGaps(c.componentId);
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0].missing_count, 1);

    // Every leaf that did arrive is still there, none of them marked
    // late, none of them rejected.
    const rows = M.conn()
      .prepare(`SELECT counter, backfilled FROM component_events WHERE component_id = ? ORDER BY counter`)
      .all(c.componentId) as Array<{ counter: number; backfilled: number }>;
    assert.deepEqual(rows.map((r) => r.counter), [0, 1, 3, 4]);
    assert.deepEqual(rows.map((r) => r.backfilled), [0, 0, 0, 0]);

    // And the view says what happened rather than hiding it: four
    // delivered, one missing, still reconcilable at a glance.
    const st = M.componentStatus(TENANT, c.componentId)!;
    assert.equal(st.counters.delivered, 4);
    assert.equal(st.counters.last_verified, 4);
    assert.equal(st.gaps.open, 1);
    assert.equal(st.gaps.missing, 1);
    assert.deepEqual(
      st.gaps.list.map((g) => [g.from_counter, g.to_counter]),
      [[2, 2]],
    );
  });
});

// ---------------------------------------------------------------------------
describe('silence — a component that stops must become visible', () => {
  const backdate = (componentId: string, seconds: number) =>
    M.conn()
      .prepare(`UPDATE components SET last_seen_at = ? WHERE component_id = ?`)
      .run(new Date(Date.now() - seconds * 1000).toISOString(), componentId);

  test('a component that stops mid-stream is silent within its window', () => {
    const c = simulate({ heartbeat: 60, label: 'stops' });
    for (let i = 0; i < 3; i++) assert.ok(c.send().ok);
    assert.equal(M.assessComponent(c.componentId)!.state, 'live');

    // It dies. The tenant sees nothing different — this is exactly the
    // Kohya observable — but the server does.
    backdate(c.componentId, 61);
    const a = M.assessComponent(c.componentId)!;
    assert.equal(a.state, 'silent');
    assert.ok(a.went_silent_at !== null);
    assert.ok(M.silentComponents(TENANT).some((s) => s.component_id === c.componentId));
  });

  test('silence is computed on read, so it is never stale — the sweep only records it', () => {
    // assess() is pure and takes the clock as an argument: the same row
    // is live now and silent later with nothing having run in between.
    const c = simulate({ heartbeat: 60 });
    assert.ok(c.send().ok);
    const row = M.conn()
      .prepare(
        `SELECT component_id, tenant_id, last_seen_at, provisioned_at, heartbeat_window_seconds
           FROM components WHERE component_id = ?`,
      )
      .get(c.componentId) as never;
    assert.equal(M.assess(row, Date.now())!.state, 'live');
    assert.equal(M.assess(row, Date.now() + 61_000)!.state, 'silent');
  });

  test('a component that provisioned and never witnessed anything is silent, not healthy', () => {
    const c = simulate({ heartbeat: 1, label: 'never' });
    M.conn()
      .prepare(`UPDATE components SET provisioned_at = ?, last_seen_at = NULL WHERE component_id = ?`)
      .run(new Date(Date.now() - 3600_000).toISOString(), c.componentId);
    const a = M.assessComponent(c.componentId)!;
    assert.equal(a.state, 'silent');
    assert.equal(a.ever_witnessed, false);
  });

  test('the sweep records the transition once, however many times it runs', () => {
    const c = simulate({ heartbeat: 60, label: 'sweep' });
    assert.ok(c.send().ok);
    backdate(c.componentId, 3600);

    const first = M.sweepSilence({ tenantId: TENANT });
    assert.ok(first.opened.some((o) => o.component_id === c.componentId));
    const second = M.sweepSilence({ tenantId: TENANT });
    assert.ok(!second.opened.some((o) => o.component_id === c.componentId));
    assert.ok(second.still_silent.includes(c.componentId));

    const history = M.silenceHistory(c.componentId);
    assert.equal(history.length, 1, 'a component still silent on the second run has ONE episode');
    assert.equal(history[0].recovered_at, null);
    // The recorded moment is when the window closed, not when the sweep
    // happened to run — otherwise the record describes cron.
    assert.ok(Date.parse(history[0].went_silent_at) < Date.now() - 3000_000);
  });

  test('a component that comes back is recorded as recovered, and the episode is kept', () => {
    const c = simulate({ heartbeat: 60, label: 'returns' });
    assert.ok(c.send().ok);
    backdate(c.componentId, 3600);
    assert.ok(M.sweepSilence({ tenantId: TENANT }).opened.some((o) => o.component_id === c.componentId));

    assert.ok(c.send().ok, 'the component starts witnessing again');
    const r = M.sweepSilence({ tenantId: TENANT });
    assert.ok(r.recovered.some((x) => x.component_id === c.componentId));

    const history = M.silenceHistory(c.componentId);
    assert.equal(history.length, 1);
    assert.ok(history[0].recovered_at !== null, 'resolving a silence never means deleting it');
    assert.equal(M.assessComponent(c.componentId)!.state, 'live');
  });

  test('the heartbeat window is per component — a batch trainer and a canvas cannot share one', () => {
    const slow = simulate({ heartbeat: 86_400, label: 'trainer' });
    const fast = simulate({ heartbeat: 60, label: 'canvas' });
    assert.ok(slow.send().ok);
    assert.ok(fast.send().ok);
    backdate(slow.componentId, 3600);
    backdate(fast.componentId, 3600);
    assert.equal(M.assessComponent(slow.componentId)!.state, 'live');
    assert.equal(M.assessComponent(fast.componentId)!.state, 'silent');
  });
});

// ---------------------------------------------------------------------------
describe('GET /api/v2/components/status', () => {
  test('no key is 401, and a key without `read` is 403 naming the scope', async () => {
    const anon = await M.GET(statusReq(undefined));
    assert.equal(anon.status, 401);
    const wrong = await M.GET(statusReq(issueKey(TENANT, ['mark:write'])));
    assert.equal(wrong.status, 403);
    const body = (await wrong.json()) as { error: { message: string } };
    assert.match(body.error.message, /"read"/);
  });

  test('the view reports counters, gaps, liveness, attestation and build drift', async () => {
    const c = simulate({ heartbeat: 60, label: 'reported' });
    assert.ok(c.send().ok); // 0
    c.produce(); // 1 suppressed
    assert.ok(c.deliver(c.produce()).ok); // 2

    // A redeploy: the component now claims a build it did not provision
    // with. Recorded and flagged, never rejected.
    const other = 'sha256:' + 'cd'.repeat(32);
    const e = c.produce();
    assert.ok(
      M.verifySubmission(c.principal, {
        componentId: c.componentId,
        counter: e.counter,
        mac: e.mac,
        preimage: e.preimage,
        buildMeasurement: other,
      }).ok,
    );

    const res = await M.GET(statusReq(issueKey(TENANT, ['read']), `?component_id=${c.componentId}`));
    assert.equal(res.status, 200);
    const { component } = (await res.json()) as { component: any };

    assert.equal(component.counters.last_verified, 3);
    assert.equal(component.counters.delivered, 3);
    assert.equal(component.counters.acceptance_window_counters, M.ACCEPTANCE_WINDOW_COUNTERS);
    assert.equal(component.gaps.open, 1);
    assert.equal(component.gaps.missing, 1);
    assert.equal(component.liveness.state, 'live');
    assert.ok(component.liveness.last_seen_at);
    assert.equal(component.liveness.heartbeat_window_seconds, 60);
    assert.equal(component.attestation.status, null);
    assert.equal(component.attestation.provider, 'none');
    assert.equal(component.build.provisioned, BUILD);
    assert.equal(component.build.claimed_latest, other);
    assert.equal(component.build.changed, true);
    // §10 C-4 — there is no published-builds registry, so this is drift
    // detection and the payload says so rather than implying provenance.
    assert.equal(component.build.check, 'drift_only');
  });

  test('a silent component is reported silent, with the estate summary counting it', async () => {
    const c = simulate({ heartbeat: 60, label: 'dark', tenantId: OTHER_TENANT });
    assert.ok(c.send().ok);
    M.conn()
      .prepare(`UPDATE components SET last_seen_at = ? WHERE component_id = ?`)
      .run(new Date(Date.now() - 3600_000).toISOString(), c.componentId);

    const res = await M.GET(statusReq(issueKey(OTHER_TENANT, ['read'])));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { components: any[]; summary: any };
    const mine = body.components.find((x) => x.component_id === c.componentId);
    assert.equal(mine.liveness.state, 'silent');
    assert.ok(mine.liveness.went_silent_at);
    assert.ok(body.summary.silent >= 1);
    assert.equal(body.summary.total, body.components.length);
  });

  test('one tenant cannot read another tenant\'s components', async () => {
    const c = simulate({ label: 'private' });
    assert.ok(c.send().ok);
    const res = await M.GET(statusReq(issueKey(OTHER_TENANT, ['read']), `?component_id=${c.componentId}`));
    assert.equal(res.status, 404);
    const listed = await M.GET(statusReq(issueKey(OTHER_TENANT, ['read'])));
    const body = (await listed.json()) as { components: Array<{ component_id: string }> };
    assert.ok(!body.components.some((x) => x.component_id === c.componentId));
  });

  test('the drained gap shows as resolved rather than vanishing', async () => {
    const c = simulate({ label: 'drained' });
    assert.ok(c.send().ok);
    const held = c.produce();
    assert.ok(c.deliver(c.produce()).ok);
    assert.ok(c.deliver(held).ok);

    const res = await M.GET(statusReq(issueKey(TENANT, ['read']), `?component_id=${c.componentId}`));
    const { component } = (await res.json()) as { component: any };
    assert.equal(component.gaps.open, 0);
    assert.equal(component.gaps.resolved, 1);
    assert.equal(component.counters.backfilled, 1, 'the late drain is still visible as late');
    assert.ok(component.gaps.list[0].resolved_at);
  });
});
