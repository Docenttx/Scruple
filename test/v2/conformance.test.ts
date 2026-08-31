// @scruple/conformance — the seven probes, the bundle, and the acceptance test
// that matters: reproducing a grade we already published, including its FAILs.
//
// WHY THE ACCEPTANCE TEST IS THE POINT. A conformance suite that cannot
// reproduce a known failure is not evidence of anything. STUDIO_P1-P8_GRADE.md
// is a grade of Scruple's own reference implementation that was arrived at by
// a careful reader, and it says canvas fails P2/P7 and Kohya fails P1–P5. If
// the harness grades that clean, the harness is broken and not Studio — so the
// test below derives Studio's evidence FROM SOURCE, grades it, and compares
// the result cell-for-cell against the summary table parsed out of the
// published document. The document is the oracle; nothing here restates it.
//
// PINNED TO A COMMIT. Two other agents are editing app/canvas-proxy/**,
// lib/canvas/**, app/api/apps/** and lib/apps/** in this round, and grading a
// tree that is moving underneath is grading nothing. Every file the derivation
// reads comes from `git show <GRADED_COMMIT>:<path>` — the working tree is
// never consulted, so a retrofit landing mid-run cannot change this result and
// cannot make it flaky. When the retrofit lands, this pin is what says which
// grade was reproduced.
//
// TEST ISOLATION — the same reason capture-component.test.ts gives. `npm run
// test:v2` runs every file in this directory CONCURRENTLY against one shared
// SCRUPLE_DB_PATH, which races as soon as two files migrate. This file takes
// its own database, assigned at module top level, with every db-touching
// import done DYNAMICALLY inside before() because static imports hoist above
// the assignment.

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

if (!process.env.SCRUPLE_DB_PATH || !/tmp|test/i.test(process.env.SCRUPLE_DB_PATH)) {
  throw new Error('Refusing to run: set SCRUPLE_DB_PATH to a throwaway path. Use `npm run test:v2`.');
}
const OWN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'scruple-conformance-'));
process.env.SCRUPLE_DB_PATH = path.join(OWN_DIR, 'conformance.db');
process.env.SCRUPLE_BDK_HEX = 'd4'.repeat(32);
// The standing safety rule. Nothing here goes near the production witness
// server on 127.0.0.1:5799.
process.env.WITNESS_SERVER_URL = 'http://127.0.0.1:1';

const REPO = path.resolve(__dirname, '../..');

// EVERY ASSERTION IN THIS FILE CARRIES A MESSAGE, and it is not a style rule.
//
// `assert.ok(x)` with no message asks Node to reconstruct the failing
// expression from source: it reads the file and parses it with acorn, binary-
// searching for the call site. In a transpiled file this size that reconstruction
// took long enough, on enough failing assertions, to starve the event loop
// completely — no timers fired, no sockets progressed, and the suite looked
// like a deadlock in the component with every assertion already evaluated.
// Passing a message skips the whole path. Do not remove them.

/**
 * The commit this grade is OF. Recorded, not inferred: a grade with no source
 * ref is an opinion with line numbers.
 */
const GRADED_COMMIT = 'fd0bb956a1e29badd8f3f4cdda170005b371b545';

type Mod = {
  runMigrations: typeof import('../../lib/db/migrate').runMigrations;
  issueProvisioningToken: typeof import('../../lib/ratchet/provisioning').issueProvisioningToken;
  redeemProvisioningToken: typeof import('../../lib/ratchet/provisioning').redeemProvisioningToken;
  Identity: typeof import('../../services/scruple-capture/src/identity').Identity;
  buildMeasurement: typeof import('../../services/scruple-capture/src/build-measurement').buildMeasurement;
  canonicalPreimage: typeof import('../../lib/ratchet/ratchet').canonicalPreimage;
  C: typeof import('../../packages/scruple-conformance/src/index');
  CFG: typeof import('../../services/scruple-capture/src/config');
  preimageOf: typeof import('../../services/scruple-capture/src/leaf').preimageOf;
  F: typeof import('../../services/scruple-capture/probes/fixtures');
  P: typeof import('../../services/scruple-capture/probes/index');
  SEAL: typeof import('../../lib/seal/measure');
};

let M: Mod;
const TENANT = 'vendor-conformance';

before(async () => {
  const [migrate, prov, identity, bm, ratchet, C, F, P, CFG, LEAF] = await Promise.all([
    import('../../lib/db/migrate'),
    import('../../lib/ratchet/provisioning'),
    import('../../services/scruple-capture/src/identity'),
    import('../../services/scruple-capture/src/build-measurement'),
    import('../../lib/ratchet/ratchet'),
    import('../../packages/scruple-conformance/src/index'),
    import('../../services/scruple-capture/probes/fixtures'),
    import('../../services/scruple-capture/probes/index'),
    import('../../services/scruple-capture/src/config'),
    import('../../services/scruple-capture/src/leaf'),
  ]);
  const SEAL = await import('../../lib/seal/measure');
  M = {
    runMigrations: migrate.runMigrations,
    issueProvisioningToken: prov.issueProvisioningToken,
    redeemProvisioningToken: prov.redeemProvisioningToken,
    Identity: identity.Identity,
    buildMeasurement: bm.buildMeasurement,
    canonicalPreimage: ratchet.canonicalPreimage,
    C,
    F,
    P,
    CFG,
    preimageOf: LEAF.preimageOf,
    SEAL,
  };
  M.runMigrations();
});

/** A real provisioned identity, against the real server-side ratchet. */
function makeIdentity(stateDir: string) {
  const { componentId, token } = M.issueProvisioningToken({ tenantId: TENANT, label: 'probe-fixture' });
  const measurement = M.buildMeasurement();
  const r = M.redeemProvisioningToken({ token, tenantId: TENANT, buildMeasurement: measurement });
  assert.ok(r.ok, 'provisioning must succeed');
  return M.Identity.fromSealed(stateDir, {
    component_id: componentId,
    chain_key_hex: r.ikHex,
    counter: 0,
    build_measurement: measurement,
    attestation_status: null,
    provisioned_at: r.provisionedAt,
  });
}

/** A port with nothing on it. Bound then released, so it is genuinely closed
 *  rather than merely unlikely. */
async function closedPort(): Promise<number> {
  const net = await import('node:net');
  const srv = net.createServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const addr = srv.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

type ProbeResult = import('../../packages/scruple-conformance/src/types').ProbeResult;
const byId = (run: { results: ProbeResult[] }, id: string): ProbeResult =>
  run.results.find((r) => r.id === id)!;

/** A deployment with nothing in it, for probes exercised one at a time. */
function bareDeployment(): import('../../packages/scruple-conformance/src/types').DeploymentUnderTest {
  return {
    integration: 'bare fixture',
    gateUrl: 'http://127.0.0.1:1',
    declaredUpstream: null,
    volumes: { output: OWN_DIR, temp: null, input: null },
    stateDir: OWN_DIR,
    apiBaseUrl: 'http://127.0.0.1:1',
    tenantApiKey: null,
    componentId: null,
    drainWindowMs: 200,
    egressTarget: null,
    egressControl: null,
  };
}

/** A listener standing in for a host outside the workload's policy. */
async function startExternalHost(): Promise<{ port: number; close(): Promise<void> }> {
  const http = await import('node:http');
  const srv = http.createServer((_req, res) => res.writeHead(200).end('outside'));
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const addr = srv.address();
  return {
    port: typeof addr === 'object' && addr ? addr.port : 0,
    close: () =>
      new Promise<void>((r) => {
        srv.closeAllConnections();
        srv.close(() => r());
      }),
  };
}

// ===========================================================================
// ONE OUTER SUITE, SEQUENTIAL, AND IT IS NOT STYLE.
//
// `node:test` runs the suites in a file CONCURRENTLY. Every fixture below
// stands up a real component, a real stub ComfyUI and a real ingest, binds
// ports, and watches directories under one shared temp root; two of them alive
// at once is not the deployment either of them is modelling, and the
// interleaving made the file hang with every assertion already passed — which
// is the worst possible failure for a suite whose whole job is to be evidence.
describe('H-4 §7 — the probe suite', { concurrency: 1 }, () => {
describe('H-4 §7 — the seven probes against a deliberately non-conformant deployment', { concurrency: 1 }, () => {
  test('every probe detects its hole; nothing about the run is admissible', async () => {
    // Probe 7's target is a LOCAL listener standing in for an external host.
    // The alternative — naming a real internet host — makes the assertion a
    // statement about the CI sandbox's route table rather than about the
    // deployment, and this sandbox has no egress at all. The stand-in is
    // labelled as one in the evidence; what the probe is measuring is whether
    // the tenant position can open an outbound connection the deployment's
    // policy does not cover, and a loopback listener is exactly that here.
    const outside = await startExternalHost();
    const d = await M.F.startNonConformant({
      root: OWN_DIR,
      makeIdentity,
      egressTarget: { host: '127.0.0.1', port: outside.port },
      egressControl: { host: '127.0.0.1', port: outside.port },
    });
    try {
      const run = await M.C.runProbes(M.P.COMFYUI_PROBES, M.F.probeContext(d));

      // 1 — the workload IS the tenant's endpoint.
      assert.equal(byId(run, 'P-01').outcome, 'succeeded');
      assert.equal(byId(run, 'P-01').verdict, 'fail');
      // 2 — provisioning is granted to whoever asks (§10 C-5).
      assert.equal(byId(run, 'P-02').outcome, 'succeeded');
      // 3 — the sealed state is in the tenant's own mount, chain key and all.
      assert.equal(byId(run, 'P-03').outcome, 'succeeded');
      assert.equal(byId(run, 'P-03').evidence.chain_key_recovered, true);
      // 4 — §10 C-8. temp/ and input/ are unwatched, so PreviewImage leaks.
      assert.equal(byId(run, 'P-04').outcome, 'succeeded');
      assert.match(String(byId(run, 'P-04').evidence.unwatched), /temp/);
      assert.match(String(byId(run, 'P-04').evidence.unwatched), /input/);
      // 5 — §2 path 2. WS bytes never become a file, so the watcher-only
      //     deployment misses them entirely.
      assert.equal(byId(run, 'P-05').outcome, 'succeeded');
      assert.ok(Number(byId(run, 'P-05').evidence.unwitnessed_payloads) > 0);
      // 6 — the ingest records a forgery as a component event.
      assert.equal(byId(run, 'P-06').outcome, 'succeeded');
      // 7 — §10 C-9. Egress is open, so comfy_api_nodes/ can post anywhere.
      assert.equal(byId(run, 'P-07').outcome, 'succeeded');

      assert.equal(run.summary.failed, 7, run.summary.line);
      assert.equal(run.summary.passed, 0, run.summary.line);
      assert.equal(run.admissible, false, 'a run with seven failures is not a submission');
      assert.match(run.summary.line, /^FAILURE/);
    } finally {
      await d.stop();
      await outside.close();
    }
  });

  test('probe 7 refuses to call an unreachable environment a conformant policy', async () => {
    // THE FAILURE MODE THIS PROBE HAS TO AVOID, and the one it was written
    // with: an air-gapped runner makes every egress target unreachable, and a
    // probe that reported that as a pass would hand a clean §2-obligation-4
    // receipt to a deployment with no policy at all. The negative control is
    // what separates the two, and its absence is inconclusive — not a pass.
    const closed = await closedPort();
    // A position with no route to anything — an air-gapped runner, a sandbox,
    // a lab bench. Note the DNS half has to be closed too: on this machine a
    // resolver answers NXDOMAIN for the canary, which IS an open egress
    // channel and which the probe correctly reports as one.
    const nowhere = new M.C.SimulatedVantage({
      allowTcp: [],
      visibleRoots: [],
      writableRoots: [],
      dnsOpen: false,
      describe: 'a position with no route to anything',
    });
    const ctx = {
      vantage: nowhere,
      deployment: {
        ...bareDeployment(),
        egressTarget: { host: '127.0.0.1', port: closed },
        egressControl: { host: '127.0.0.1', port: closed },
      },
      leaves: M.C.recordedLeafOracle(() => [], 'none'),
      log: () => undefined,
    };
    const r = await M.P.probeEgress.run(ctx);
    assert.equal(r.outcome, 'not-attempted', r.detail);
    assert.equal(r.evidence.tcp_reachable, false, 'the target must be unreachable for this case');
    assert.equal(r.evidence.negative_control_reachable, false, 'and so must the control');
    assert.match(r.detail, /cannot tell egress denied by the deployment's policy from/);

    const run = await M.C.runProbes([M.P.probeEgress], ctx);
    assert.equal(run.results[0].verdict, 'inconclusive', run.summary.line);
    assert.equal(run.admissible, false, 'an inconclusive run is not a submission');
  });

  test('probe 4 refuses to call a missing surface a pass', async () => {
    // Canvas is the live case: no filesystem surface exists, because the Modal
    // volume is not mountable into scruple-web. Nothing was gated and nothing
    // leaked, and reporting either as the other would be wrong in a different
    // direction each time.
    const r = await M.P.probeOutputVolume.run({
      vantage: new M.C.OsVantage(),
      deployment: { ...bareDeployment(), volumes: null },
      leaves: M.C.recordedLeafOracle(() => [], 'none'),
      log: () => undefined,
    });
    assert.equal(r.outcome, 'not-attempted', r.detail);
    assert.equal(r.evidence.surface_present, false, 'the absence must be recorded as an absence');
    assert.match(r.detail, /the question was not asked/);
  });

  test('probe 4 fails a deployment watching output/ alone — the C-8 finding as a test', async () => {
    const d = await M.F.startNonConformant({ root: OWN_DIR, makeIdentity, egressTarget: null });
    try {
      const ctx = M.F.probeContext(d);
      const r = await M.P.probeOutputVolume.run(ctx);
      // The write into output/ IS witnessed. A probe that only watched output/
      // would have called this a pass — which is precisely the deployment C-8
      // says leaks every PreviewImage.
      assert.equal(r.evidence.directories_written, 3);
      assert.equal(r.evidence.directories_witnessed, 1);
      assert.equal(r.outcome, 'succeeded');
    } finally {
      await d.stop();
    }
  });
});

// ===========================================================================
describe('H-4 §7 — the same probes against a conformant deployment', { concurrency: 1 }, () => {
  test('the behavioural probes (4, 5, 6) pass, from a real OS vantage', async () => {
    const d = await M.F.startConformant({
      root: OWN_DIR,
      makeIdentity,
      // Strict ingest: a submission whose MAC is not 32 bytes of something the
      // ratchet could have produced is refused. The probe's forgery is 32
      // random bytes, which is the right shape and the wrong value.
      verify: (body) => {
        const c = body.component as { counter?: number } | undefined;
        return typeof c?.counter === 'number' && body.mac !== undefined && !/probe-06-forged/.test(JSON.stringify(body));
      },
      egressTarget: null,
    });
    try {
      const ctx = M.F.probeContext(d);

      // 4 — all three directories are under one recursively watched root.
      const p4 = await M.P.probeOutputVolume.run(ctx);
      assert.equal(p4.evidence.directories_written, 3, JSON.stringify(p4.evidence));
      assert.equal(p4.evidence.directories_witnessed, 3, p4.detail);
      assert.equal(p4.outcome, 'blocked');

      // 5 — the gate owns the WebSocket, so the frame that never becomes a
      //     file is still covered.
      const p5 = await M.P.probeWebsocketRetrieval.run(ctx);
      assert.equal(p5.outcome, 'blocked', p5.detail);
      assert.ok(Number(p5.evidence.preview_payloads) > 0, 'the stub must have delivered a PREVIEW_IMAGE frame');
      assert.equal(p5.evidence.unwitnessed_payloads, 0);

      // 6 — forged submissions at, below and above the high-water mark are
      //     all refused.
      const p6 = await M.P.probeCounterReplay.run(ctx);
      assert.equal(p6.outcome, 'blocked', p6.detail);
      assert.equal(p6.evidence.accepted, 0);

      await d.settled();
    } finally {
      await d.stop();
    }
  });

  test('§10 C-8 — a temp/ write produces a leaf that says temp/', async () => {
    // THE POINT OF C-8, AS A TEST. `PreviewImage` (nodes.py:1684-1690) is a
    // `SaveImage` subclass whose output_dir is get_temp_directory(): it writes
    // FULL IMAGES to temp/. Before WO-14 the component took ONE volume, so the
    // only way to watch all three was a recursive watch on a shared parent —
    // and every leaf then said `file:<relpath>`, which cannot distinguish a
    // PreviewImage in temp/ from a SaveImage in output/. "A leaf exists for
    // these bytes" was never the claim C-8 is about.
    const d = await M.F.startConformant({ root: OWN_DIR, makeIdentity, egressTarget: null });
    try {
      const vols = d.deployment.volumes!;
      const written: Record<string, string> = {};
      for (const [type, dir] of Object.entries({
        output: vols.output,
        temp: vols.temp!,
        input: vols.input!,
      })) {
        const bytes = Buffer.from(`c8 ${type} ${crypto.randomUUID()}`, 'utf8');
        fs.writeFileSync(path.join(dir, `c8-${type}.bin`), bytes);
        written[type] = crypto.createHash('sha256').update(bytes).digest('hex');
      }
      // The watcher's settle timer, then every capture it started.
      await new Promise((r) => setTimeout(r, 300));
      await d.settled();

      for (const [type, hash] of Object.entries(written)) {
        const leaf = d.ingest.received.find((s) => s.content_hash === hash) as
          | { capture?: { egress?: string; surface?: string } }
          | undefined;
        assert.ok(leaf, `no leaf for the ${type}/ write`);
        assert.equal(leaf!.capture?.surface, 'filesystem-watch', `${type}/ leaf came from the wrong surface`);
        assert.equal(
          leaf!.capture?.egress,
          `file:${type}:c8-${type}.bin`,
          `the ${type}/ leaf must name the volume it came from — otherwise a PreviewImage in ` +
            'temp/ and a SaveImage in output/ are the same record, which is the confusion C-8 exists to end',
        );
      }
    } finally {
      await d.stop();
    }
  });

  test('§10 C-8 — nested watched roots are refused rather than double-counted', async () => {
    // The pre-C-8 shape: three directories under one recursively watched root.
    // It satisfied the obligation and could not evidence it, and it also makes
    // one write two observations with two volume types. Refused at config time
    // so a deployment cannot arrive in it by accident.
    const parent = fs.mkdtempSync(path.join(OWN_DIR, 'nested-'));
    const child = path.join(parent, 'temp');
    fs.mkdirSync(child, { recursive: true });
    assert.throws(
      () =>
        M.CFG.resolveWatchedVolumes({
          watchedVolumes: [
            { type: 'output', path: parent },
            { type: 'temp', path: child },
          ],
        }),
      /Nested watched roots/,
      'a root inside another root must not be accepted',
    );
    assert.throws(
      () => M.CFG.resolveWatchedVolumes({ watchedVolumes: [{ type: 'output', path: parent }], outputVolume: parent }),
      /watchedVolumes and outputVolume are both set/,
      'the two config forms mean different things and must not be silently merged',
    );
  });

  test('probe 6 reaches the ratchet — a 400 from the field validator is NOT a pass', async () => {
    // WRITTEN BY A BUG, AND THE BUG IS THE FIRST TENANT-POSITION RUN (WO-14).
    // The probe's forged submission used to be a plausible sketch rather than a
    // real `Submission`: no `component.attestation`, no `kind`, a three-field
    // `capture`. An ingest that canonicalises before it verifies rejected all
    // three attempts at the JSON layer, the probe recorded a clean PASS, and a
    // deployment with NO replay defence whatsoever would have scored
    // identically. The probe was measuring our own malformed request.
    const seen: Array<{ status: number; body: string }> = [];
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        if (!(req.url ?? '').startsWith('/api/v2/witness')) {
          res.writeHead(404, { 'content-type': 'application/json' }).end('{}');
          return;
        }
        let status = 403;
        let body = JSON.stringify({ error: 'mac_mismatch', component_verified: 0 });
        try {
          // The same canonicalisation the real route performs before the
          // ratchet ever sees the counter. A submission that will not
          // canonicalise never reaches the replay defence.
          M.preimageOf(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (e) {
          status = 400;
          body = JSON.stringify({ error: 'malformed_submission', detail: String(e) });
        }
        seen.push({ status, body });
        res.writeHead(status, { 'content-type': 'application/json' }).end(body);
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    try {
      const r = await M.P.probeCounterReplay.run({
        vantage: new M.C.OsVantage(),
        deployment: {
          ...bareDeployment(),
          apiBaseUrl: `http://127.0.0.1:${port}`,
          componentId: 'c-under-test',
        },
        leaves: M.C.recordedLeafOracle(() => [], 'none'),
        log: () => undefined,
      });
      assert.equal(seen.length, 3, 'all three forgeries must reach the ingest');
      assert.deepEqual(
        seen.map((x) => x.status),
        [403, 403, 403],
        'every forgery must canonicalise — a 400 means the probe never reached the ratchet',
      );
      assert.equal(r.evidence.refused_as_malformed, 0, r.detail);
      assert.equal(r.outcome, 'blocked', r.detail);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  test('a malformed-refusal run is INCONCLUSIVE, not a pass', async () => {
    // The other half of the same lesson: when the submissions do not reach the
    // ratchet, the probe must say so rather than bank the refusal.
    const server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () =>
        res.writeHead(400, { 'content-type': 'application/json' }).end('{"error":"malformed_submission"}'),
      );
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    try {
      const r = await M.P.probeCounterReplay.run({
        vantage: new M.C.OsVantage(),
        deployment: { ...bareDeployment(), apiBaseUrl: `http://127.0.0.1:${port}`, componentId: 'c' },
        leaves: M.C.recordedLeafOracle(() => [], 'none'),
        log: () => undefined,
      });
      assert.equal(r.outcome, 'not-attempted', r.detail);
      assert.match(r.detail, /never reached the ratchet/);
      const run = await M.C.runProbes([M.P.probeCounterReplay], {
        vantage: new M.C.OsVantage(),
        deployment: { ...bareDeployment(), apiBaseUrl: `http://127.0.0.1:${port}`, componentId: 'c' },
        leaves: M.C.recordedLeafOracle(() => [], 'none'),
        log: () => undefined,
      });
      assert.equal(run.results[0].verdict, 'inconclusive');
      assert.equal(run.admissible, false);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  test('probe 1 blocks for real when the upstream is genuinely closed', async () => {
    const port = await closedPort();
    const r = await M.P.probeBypassGate.run({
      vantage: new M.C.OsVantage(),
      deployment: { ...bareDeployment(), declaredUpstream: { host: '127.0.0.1', port } },
      leaves: M.C.recordedLeafOracle(() => [], 'none'),
      log: () => undefined,
    });
    assert.equal(r.outcome, 'blocked');
    assert.equal(r.evidence.tcp_reachable, false);
    // And it says what it did NOT prove, which is the whole of H-4 §6.
    assert.match(String(r.evidence.proves), /NOT that no route exists/);
  });

  test('probe 3 blocks for real when the state directory is genuinely unreadable', async () => {
    const dir = fs.mkdtempSync(path.join(OWN_DIR, 'sealed-'));
    fs.writeFileSync(
      path.join(dir, 'identity.json'),
      JSON.stringify({ component_id: 'c', chain_key_hex: 'ab'.repeat(32), counter: 3 }),
      { mode: 0o600 },
    );
    // Same uid, no search permission. This is the ONLY in-process way to make
    // §4.4 step 4's boundary real, and it is real: the read genuinely fails.
    fs.chmodSync(dir, 0o000);
    try {
      const r = await M.P.probeSealedIk.run({
        vantage: new M.C.OsVantage(),
        deployment: { ...bareDeployment(), volumes: { output: dir, temp: null, input: null }, stateDir: dir },
        leaves: M.C.recordedLeafOracle(() => [], 'none'),
        log: () => undefined,
      });
      assert.equal(r.outcome, 'blocked');
      assert.equal(r.evidence.chain_key_recovered, false);
      assert.equal(r.evidence.files_read, 0);
    } finally {
      fs.chmodSync(dir, 0o700);
    }
  });

  test('a modelled conformant topology satisfies the probes and STILL is not a pass', async () => {
    const closed = await closedPort();
    const outside = await startExternalHost();
    const d = await M.F.startConformant({
      root: OWN_DIR,
      makeIdentity,
      verify: () => false,
      // The target is denied by the modelled policy; the control is not, so
      // "nothing got out" is attributable to the policy rather than to the
      // machine the probe is running on.
      egressTarget: { host: '127.0.0.1', port: closed },
      egressControl: { host: '127.0.0.1', port: outside.port },
    });
    try {
      // A policy describing the topology H-4 §2 requires: the tenant reaches
      // the gate and nothing else, the state directory is not in its mounts,
      // and egress — TCP and DNS both — is denied.
      const vantage = new M.C.SimulatedVantage({
        allowTcp: [
          { host: '127.0.0.1', port: Number(new URL(d.gateUrl).port) },
          { host: '127.0.0.1', port: outside.port },
        ],
        visibleRoots: [d.deployment.volumes!.output],
        writableRoots: [d.deployment.volumes!.output],
        dnsOpen: false,
        describe: '§2 obligations 1-4 as the vendor declares them',
      });
      const run = await M.C.runProbes(M.P.COMFYUI_PROBES, M.F.probeContext(d, vantage));

      for (const id of ['P-01', 'P-02', 'P-03', 'P-07']) {
        const r = byId(run, id);
        // The probe's LOGIC is right: it looked, and found nothing.
        assert.equal(r.outcome, 'blocked', `${id}: ${r.detail}`);
        // And the run refuses to call that a pass, because a policy answered
        // the question rather than the deployment. sonobuoy-conformance.md
        // §5.2 from the other end: P1 and P3 are the irreducible cases.
        assert.equal(r.admissible, false, id);
        assert.equal(r.verdict, 'inconclusive', id);
      }
      assert.equal(run.admissible, false);
      assert.ok(run.summary.inconclusive >= 4, run.summary.line);
      await d.settled();
    } finally {
      await d.stop();
      await outside.close();
    }
  });
});
});

// ===========================================================================
describe('the submission bundle', () => {
  function sampleBundle() {
    const run: import('../../packages/scruple-conformance/src/types').ProbeRun = {
      runId: 'run-1',
      subject: 'sample integration',
      startedAt: '2026-08-30T00:00:00.000Z',
      finishedAt: '2026-08-30T00:00:01.000Z',
      vantages: ['os'],
      results: [],
      summary: { passed: 7, failed: 0, inconclusive: 0, line: 'SUCCESS! -- 7 Passed | 0 Failed | 0 Inconclusive' },
      admissible: true,
    };
    const g = M.C.grade('fd0bb95', []);
    return M.C.buildBundle({
      integration: {
        vendor: 'Example Inference Co',
        name: 'Example Hosted ComfyUI',
        version: 'v1.2.3',
        website_url: 'https://example.invalid',
        documentation_url: 'https://example.invalid/docs',
        contact_email_address: 'conformance@example.invalid',
        type: 'hosted platform',
        description: 'A hosted ComfyUI with the Scruple capture component in front of it.',
        standard_version: 'v1.7',
        declared_placement: 'sidecar-gate',
        enforcement: 'isolated-namespace',
        attestation_provider: 'none',
        probe_vantage: 'os',
      },
      run,
      grade: g,
      reproduction: 'docker exec -it <workload> npx scruple-conformance run --config /etc/scruple/conformance.json',
    });
  }

  test('carries exactly the five required files, in the k8s-conformance shape', () => {
    const b = sampleBundle();
    assert.deepEqual(Object.keys(b.files).sort(), [...M.C.REQUIRED_FILES].sort());
    // PRODUCT.yaml's eight fields survive by name so a reviewer who has read
    // one submission can read the other.
    for (const k of ['vendor', 'name', 'version', 'website_url', 'documentation_url', 'contact_email_address', 'type', 'description']) {
      assert.match(b.files['INTEGRATION.yaml'], new RegExp(`^${k}:`, 'm'), k);
    }
    // The K8s FAQ bans links in submission READMEs; link rot defeats
    // reproducibility, and that lesson is free to copy.
    assert.match(b.files['README.md'], /NO LINKS IN THIS FILE/);
  });

  test('signs, verifies, and refuses a bundle whose files were swapped after signing', () => {
    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    const signed = M.C.signBundle(sampleBundle(), privateKey);
    assert.equal(M.C.verifyBundle(signed).ok, true);

    const swapped = {
      manifest: signed.manifest,
      files: { ...signed.files, 'GRADE.md': signed.files['GRADE.md'] + '\n(everything is fine)\n' },
    };
    const v = M.C.verifyBundle(swapped);
    assert.equal(v.ok, false);
    assert.ok(v.failures.some((f) => f.reason === 'file-hash-mismatch'), 'a swapped file must be caught');

    // And a manifest edited to match the swapped file still fails, on the
    // signature — which is the whole reason the manifest is signed rather than
    // merely hashed.
    const forgedManifest = M.C.buildBundle_forTest_rehash(swapped);
    assert.ok(
      M.C.verifyBundle(forgedManifest).failures.some((f) => f.reason === 'bad-signature'),
      'repairing the manifest to match the swap must fail on the signature',
    );
  });

  test('an unsigned bundle and a stray file are both refused', () => {
    const b = sampleBundle();
    assert.ok(M.C.verifyBundle(b).failures.some((f) => f.reason === 'no-signature'), 'unsigned must be refused');

    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    const signed = M.C.signBundle(b, privateKey);
    const stray = { manifest: signed.manifest, files: { ...signed.files, 'notes.txt': 'hi' } };
    assert.ok(M.C.verifyBundle(stray).failures.some((f) => f.reason === 'stray-file'), 'a stray file must be refused');
  });

  test('canonical JSON agrees byte for byte with the ratchet preimage on flat objects', () => {
    // If these two ever diverge, a signature computed by one and checked by
    // the other fails in the field and nowhere else — the exact failure mode
    // §10 C-1 exists to prevent.
    const flat = { z: 'last', a: 'first', n: 42, nil: null, '\u{1F600}': 'astral', A: 'upper' };
    assert.equal(M.C.canonicalJson(flat), M.canonicalPreimage(flat).toString('utf8'));
    // And the two C-1 traps stay closed.
    assert.throws(() => M.C.canonicalJson({ cfg: 8.5 }), /float/i);
    assert.throws(() => M.C.canonicalJson({ x: Number.MAX_SAFE_INTEGER + 2 }), /exactly-representable/);
  });
});

// ===========================================================================
describe('the self-grade harness — the FROZEN profile, WO-5 DEFECT-2 as it was graded', () => {
  // EVERY TEST IN THIS BLOCK GRADES UNDER `RUNTIME_COMPLETENESS_PROFILE`.
  //
  // It is not the rule in force. It is the rule STUDIO_P1-P8_GRADE.md and
  // every grade issued before 2026-08-30 was written under, and it is kept
  // executable because a suite that cannot re-derive a published failure is
  // not evidence of anything (WO-23). Deleting these would have been the
  // cheap way to make the re-cut pass.
  const FROZEN = () => M.C.RUNTIME_COMPLETENESS_PROFILE;

  const wellFormedButWrong = () => ({
    path: 'A vendor who watches output/ and says so',
    profile: {
      host: 'comfyui',
      hooks: ['artifact.produced'] as const,
      // EXPRESSIBLE AND WRONG. lib/capture/surface.ts DEFECT-2: nothing in the
      // three axes can say a set of surfaces COVERS every egress path.
      surfaces: ['filesystem-watch'] as const,
      fidelity: 'as-written' as const,
      declaredPlacement: 'sidecar-gate' as const,
      enforcement: 'isolated-namespace' as const,
      attestation: 'none' as const,
    },
    evidence: {
      capturePathFiles: { value: ['services/scruple-capture/src/component.ts'], cite: 'declared' },
      // A PERFECT baseline. Covers every file they named.
      baseline: {
        value: { ref: 'baseline:abc', covers: ['services/scruple-capture/src/component.ts'] },
        cite: 'declared',
      },
      ratchetGapAccounting: { value: { accounted: true, gaps: 0 }, cite: 'declared' },
      seal: null,
      keyCustody: { value: { reachableByMeasuredParty: false, where: 'sealed 0600' }, cite: 'declared' },
      principalIdentity: { value: { suppliedByMeasuredParty: false, source: 'server session' }, cite: 'declared' },
      eventChain: { value: { leavesCreated: true, mutatesPriorRows: false }, cite: 'declared' },
      zeroContent: { value: { carriesPayloadBytes: false, fields: ['content_hash'] }, cite: 'declared' },
      attestationDeclaration: { value: { declaredIn: 'baseline', provider: 'none' }, cite: 'declared' },
      attestationImport: null,
      surfaceAbsences: {},
      declaredP1Conditions: [],
      separateFindings: [],
    },
    probes: null,
  });

  test('a well-formed profile with a perfect baseline is NOT a P2 pass', () => {
    const g = M.C.gradePath(wellFormedButWrong(), FROZEN());
    assert.equal(g.items.P2.disposition, 'FAIL');
    assert.match(g.items.P2.reason, /DEFECT-2/);
    assert.match(g.items.P2.reason, /filesystem-watch/);
    assert.equal(g.compliant, false);
  });

  test('P2 needs probes 4, 5 and 7 blocked from an occupied position, and gap accounting', async () => {
    const base = wellFormedButWrong();

    // Probes present but inconclusive (a simulated vantage) is still not a pass.
    const inconclusiveRun = {
      runId: 'r',
      // WO-14: a run says what it is a run OF, and the grader refuses to let
      // one integration's run satisfy another's P2.
      subject: 'A vendor who watches output/ and says so',
      startedAt: 'a', finishedAt: 'b', vantages: ['simulated'],
      results: ['P-04', 'P-05', 'P-07'].map((id) => ({
        id, spec: '', title: '', attempt: '', requirement: '', evidenceFor: [] as never[],
        topological: true, verdict: 'inconclusive' as const, vantage: 'simulated', admissible: false,
        startedAt: 'a', durationMs: 1, outcome: 'blocked' as const, detail: '', evidence: {},
      })),
      summary: { passed: 0, failed: 0, inconclusive: 3, line: '' },
      admissible: false,
    };
    assert.equal(M.C.gradePath({ ...base, probes: inconclusiveRun }, FROZEN()).items.P2.disposition, 'FAIL');

    const passingRun = {
      ...inconclusiveRun,
      vantages: ['os'],
      results: inconclusiveRun.results.map((r) => ({ ...r, verdict: 'pass' as const, vantage: 'os', admissible: true })),
      summary: { passed: 3, failed: 0, inconclusive: 0, line: '' },
      admissible: true,
    };
    assert.equal(M.C.gradePath({ ...base, probes: passingRun }, FROZEN()).items.P2.disposition, 'PASS');

    // Drop the gap accounting and it goes back to FAIL: a coverage claim with
    // no account of missing counters cannot tell "captured nothing" from
    // "captured everything".
    const noGaps = { ...base, evidence: { ...base.evidence, ratchetGapAccounting: null }, probes: passingRun };
    assert.equal(M.C.gradePath(noGaps, FROZEN()).items.P2.disposition, 'FAIL');
    assert.match(M.C.gradePath(noGaps, FROZEN()).items.P2.reason, /gap accounting/);
  });

  test("a probe run of ANOTHER deployment does not satisfy this one's P2", async () => {
    // FOUND BY DOING IT (WO-14). The namespace harness produced a real,
    // admissible, seven-of-seven run from an occupied tenant position against
    // the scruple-capture ComfyUI deployment. Attached to CANVAS's grade — a
    // different integration, a different tenant, a different boundary — it
    // carried canvas past P2's coverage conjunct. Nothing in the run was false;
    // it was simply about somewhere else, and the grader had no way to notice.
    //
    // Certification is per configuration (H-4 §7). A run is evidence about the
    // deployment it occupied and about no other, so `ProbeRun.subject` now says
    // which, and this is the test that keeps it saying it.
    const base = wellFormedButWrong();
    const good = {
      runId: 'r', subject: base.path, startedAt: 'a', finishedAt: 'b', vantages: ['os'],
      results: ['P-04', 'P-05', 'P-07'].map((id) => ({
        id, spec: '', title: '', attempt: '', requirement: '', evidenceFor: [] as never[],
        topological: false, verdict: 'pass' as const, vantage: 'os', admissible: true,
        startedAt: 'a', durationMs: 1, outcome: 'blocked' as const, detail: '', evidence: {},
      })),
      summary: { passed: 3, failed: 0, inconclusive: 0, line: '' },
      admissible: true,
    };
    assert.equal(M.C.gradePath({ ...base, probes: good }, FROZEN()).items.P2.disposition, 'PASS');

    const borrowed = { ...good, subject: 'somebody else entirely' };
    const g = M.C.gradePath({ ...base, probes: borrowed }, FROZEN());
    assert.equal(g.items.P2.disposition, 'FAIL', 'a borrowed run must not satisfy P2');
    assert.match(g.items.P2.reason, /performed against 'somebody else entirely'/);
    assert.equal(g.items.P2.qualifier, 'probe run is of another deployment');
  });

  test('a baseline that misses one capture-path file is not a partial pass', () => {
    const base = wellFormedButWrong();
    const short = {
      ...base,
      evidence: {
        ...base.evidence,
        capturePathFiles: { value: ['a.ts', 'b.ts'], cite: 'declared' },
        baseline: { value: { ref: 'baseline:abc', covers: ['a.ts'] }, cite: 'declared' },
      },
    };
    const g = M.C.gradePath(short, FROZEN());
    assert.equal(g.items.P2.disposition, 'FAIL');
    assert.match(g.items.P2.reason, /does not cover 1 of 2/);
  });
});

// ===========================================================================
describe('the self-grade harness — P2 as SEAL CURRENCY, the rule in force', () => {
  // docs/canon/INTEGRATION_LIFECYCLE.md, 2026-08-30. P2 is "is the running
  // pipeline sealed against an approved measurement, and is the seal current?"
  // — not "does a counter show no gaps". The counter moved to liveness and
  // bears on compliance nowhere, which is the assertion at the bottom of this
  // block and the one that the whole WO exists to make true.

  const CAPTURE = ['services/scruple-capture/src/component.ts'];

  function manifest(entries: Array<{ class: string; id: string; sha256: string }>) {
    return M.SEAL.normaliseManifest(
      entries.map((e) => ({
        class: e.class as 'capture' | 'config' | 'dependency' | 'host',
        id: e.id,
        source: 'content' as const,
        sha256: e.sha256,
      })),
    );
  }
  const H = (n: string) => crypto.createHash('sha256').update(n).digest('hex');

  const approvedManifest = () =>
    manifest([
      { class: 'capture', id: 'services/scruple-capture/src/component.ts', sha256: H('capture-v1') },
      { class: 'config', id: 'etc/scruple/capture.json', sha256: H('config-v1') },
      { class: 'dependency', id: 'services/scruple-capture/package-lock.json', sha256: H('lock-v1') },
    ]);

  function status(over: Record<string, unknown> = {}) {
    const sealedAt = '2026-08-01T00:00:00.000Z';
    return {
      deployment_id: 'dep-1',
      known: true,
      state: 'sealed',
      as_of: '2026-08-30T00:00:00.000Z',
      seal_ref: 'sha256:' + H('seal'),
      sealed_at: sealedAt,
      // The registry's own term. Recomputed here rather than imported so the
      // fixture cannot silently follow a change to SEAL_TERM_DAYS.
      seal_expires_at: new Date(Date.parse(sealedAt) + 365 * 86_400_000).toISOString(),
      reseal_cause: null,
      drift_since_seal: 0,
      drift_budget: 8,
      claims_standard: true,
      events: [],
      ...over,
    } as import('../../lib/seal/registry').SealStatusReport;
  }

  function sealed(over: Record<string, unknown> = {}) {
    const m = approvedManifest();
    return {
      value: {
        status: status(),
        approvedManifest: m,
        approvedMeasurement: M.SEAL.pipelineMeasurement(m),
        observed: m,
        ...over,
      },
      cite: 'lib/seal/registry.ts#sealStatus(dep-1)',
    };
  }

  /**
   * A well-formed `inference-host` member, for the class-scope tests below.
   * Widely typed on purpose: `base()`'s inline profile is narrowed by `as
   * const` and cannot take a different surface list.
   */
  type HP = import('../../lib/capture/surface').HostCaptureProfile;
  const inferenceHostProfile = (over: Partial<HP> = {}): HP => ({
    host: 'comfyui',
    hooks: ['graph.execute', 'artifact.produced'],
    surfaces: ['network-gate'],
    fidelity: 'as-delivered',
    declaredPlacement: 'sidecar-gate',
    enforcement: 'isolated-namespace',
    attestation: 'none',
    capabilityClasses: ['inference-host'],
    ...over,
  });

  const base = (sealOver: Record<string, unknown> | null = {}) => ({
    path: 'A vendor who sealed their pipeline',
    profile: {
      host: 'comfyui',
      hooks: ['artifact.produced'] as const,
      // STILL EXPRESSIBLE AND STILL WRONG (WO-5 DEFECT-2), and under this rule
      // it is no longer P2's business: coverage is not established by
      // enumerating surfaces, it is established by measuring the boundary the
      // surfaces live in.
      surfaces: ['filesystem-watch'] as const,
      fidelity: 'as-written' as const,
      declaredPlacement: 'sidecar-gate' as const,
      enforcement: 'isolated-namespace' as const,
      attestation: 'none' as const,
    },
    evidence: {
      capturePathFiles: { value: [...CAPTURE], cite: 'declared' },
      baseline: null as import('../../packages/scruple-conformance/src/grade').DeclaredEvidence['baseline'],
      seal: sealOver === null ? null : sealed(sealOver),
      ratchetGapAccounting:
        null as import('../../packages/scruple-conformance/src/grade').DeclaredEvidence['ratchetGapAccounting'],
      ratchetAbsence:
        null as import('../../packages/scruple-conformance/src/grade').DeclaredEvidence['ratchetAbsence'],
      keyCustody: { value: { reachableByMeasuredParty: false, where: 'sealed 0600' }, cite: 'declared' },
      principalIdentity: { value: { suppliedByMeasuredParty: false, source: 'server session' }, cite: 'declared' },
      eventChain: { value: { leavesCreated: true, mutatesPriorRows: false }, cite: 'declared' },
      zeroContent: { value: { carriesPayloadBytes: false, fields: ['content_hash'] }, cite: 'declared' },
      attestationDeclaration: {
        value: { declaredIn: 'seal', provider: 'none' },
        cite: 'declared',
      } as import('../../packages/scruple-conformance/src/grade').DeclaredEvidence['attestationDeclaration'],
      attestationImport: null,
      surfaceAbsences: {},
      declaredP1Conditions: [],
      separateFindings: [],
    },
    probes: null,
  });

  test('a current seal over a boundary containing the capture path passes P2', () => {
    const g = M.C.gradePath(base());
    assert.equal(g.items.P2.disposition, 'PASS-CONDITIONAL', g.items.P2.reason);
    assert.match(g.items.P2.reason, /is the configuration approved by seal/);
    assert.equal(g.lifecycle, 'sealed');
    // The conditions are about the evidence attached, never about the counter.
    assert.ok(g.items.P2.conditions.some((c: string) => /step-2 conformance run/.test(c)));
    assert.ok(!g.items.P2.conditions.some((c: string) => /counter|ratchet/i.test(c)));
  });

  test('THE CORRECTION: no ratchet, no gap accounting, and P2 still passes', () => {
    // This is the assertion the whole WO exists to make true. Under the old
    // rule this exact input failed P2 on its third conjunct, and canvas — which
    // has no ratchet at all — was recorded as unable to satisfy it "at any
    // level of effort". That was a fact about the grader.
    const noCounter = base();
    noCounter.evidence.ratchetGapAccounting = null;
    const g = M.C.gradePath(noCounter);
    assert.notEqual(g.items.P2.disposition, 'FAIL', g.items.P2.reason);
    assert.doesNotMatch(g.items.P2.reason, /gap accounting/);

    // And the same input under the FROZEN rule still fails, on the conjunct
    // that was removed — which is how we know the two rules are different and
    // that the old one has not been quietly repaired.
    const old = M.C.gradePath(
      { ...noCounter, evidence: { ...noCounter.evidence, baseline: { value: { ref: 'b', covers: [...CAPTURE] }, cite: 'declared' } } },
      M.C.RUNTIME_COMPLETENESS_PROFILE,
    );
    assert.equal(old.items.P2.disposition, 'FAIL');
  });

  test('the counter is reported as liveness and reaches `compliant` nowhere', () => {
    const withGaps = base();
    withGaps.evidence.ratchetGapAccounting = { value: { accounted: true, gaps: 3 }, cite: 'declared' };
    const g1 = M.C.gradePath(withGaps);
    assert.equal(g1.liveness.verdict, 'gaps-accounted');
    assert.equal(g1.liveness.gaps, 3);

    const unaccounted = base();
    unaccounted.evidence.ratchetGapAccounting = { value: { accounted: false, gaps: 0 }, cite: 'declared' };
    const g2 = M.C.gradePath(unaccounted);
    assert.equal(g2.liveness.verdict, 'unaccounted');

    const noRatchet = base();
    noRatchet.evidence.ratchetAbsence = { value: 'no counter chain on this path', cite: 'declared' };
    const g3 = M.C.gradePath(noRatchet);
    assert.equal(g3.liveness.verdict, 'not-applicable');

    // Three different liveness answers, one compliance answer. If any of these
    // diverged, the counter would still be gating compliance under a new name.
    assert.equal(g1.compliant, g2.compliant);
    assert.equal(g2.compliant, g3.compliant);
    assert.equal(g1.items.P2.disposition, g2.items.P2.disposition);
    assert.equal(g2.items.P2.disposition, g3.items.P2.disposition);
  });

  test('integrating and verifying cannot claim the standard, and say which side they are on', () => {
    for (const state of ['integrating', 'verifying'] as const) {
      const g = M.C.gradePath(base({ status: status({ state, claims_standard: false, seal_ref: null }) }));
      assert.equal(g.items.P2.disposition, 'FAIL', state);
      assert.equal(g.items.P2.qualifier, `${state}, not yet sealed`);
      assert.equal(g.lifecycle, state);
      assert.equal(g.compliant, false);
      // Binary, not a third state: the reason says so rather than hedging.
      assert.match(g.items.P2.reason, /not a third compliance state/);
    }
  });

  test('resealing names its cause — material change, drift budget, or an expired term', () => {
    const causes = {
      material_change: /MATERIAL change/,
      drift_budget: /accumulated drift/,
      term_expired: /term ran out/,
    } as const;
    for (const [cause, re] of Object.entries(causes)) {
      const g = M.C.gradePath(
        base({
          status: status({
            state: 'resealing',
            claims_standard: false,
            seal_ref: null,
            reseal_cause: cause,
            drift_since_seal: cause === 'drift_budget' ? 8 : 0,
          }),
        }),
      );
      assert.equal(g.items.P2.disposition, 'FAIL', cause);
      assert.match(g.items.P2.reason, re, cause);
      assert.match(g.items.P2.qualifier!, /^resealing/);
    }
  });

  test('a seal whose recorded measurement is not its own manifest is refused', () => {
    // The `build-measurement.ts` trap, one level up: two sides of an approval
    // measured by different code. Nothing downstream of that is worth asking.
    const g = M.C.gradePath(base({ approvedMeasurement: 'sha256:' + '0'.repeat(64) }));
    assert.equal(g.items.P2.disposition, 'FAIL');
    assert.equal(g.items.P2.qualifier, 'seal record contradicts itself');
  });

  test('THE CHECK THE FOLD CANNOT MAKE: the pipeline moved and nobody declared it', () => {
    // `sealStatus()` folds events the vendor declared. It is correct about
    // what was said, and it cannot see a change nobody reported — so the
    // grader measures the running pipeline itself and classifies the
    // difference with the estate's own materiality rule.
    const moved = manifest([
      { class: 'capture', id: 'services/scruple-capture/src/component.ts', sha256: H('capture-v2') },
      { class: 'config', id: 'etc/scruple/capture.json', sha256: H('config-v1') },
      { class: 'dependency', id: 'services/scruple-capture/package-lock.json', sha256: H('lock-v1') },
    ]);
    const g = M.C.gradePath(base({ observed: moved }));
    assert.equal(g.items.P2.disposition, 'FAIL');
    assert.equal(g.items.P2.qualifier, 'running pipeline is not the approved one');
    assert.match(g.items.P2.reason, /NOBODY DECLARED THIS/);

    // A DEPENDENCY bump is consequential, not material: it passes, and the
    // budget it spends is named as a condition rather than swallowed.
    const bumped = manifest([
      { class: 'capture', id: 'services/scruple-capture/src/component.ts', sha256: H('capture-v1') },
      { class: 'config', id: 'etc/scruple/capture.json', sha256: H('config-v1') },
      { class: 'dependency', id: 'services/scruple-capture/package-lock.json', sha256: H('lock-v2') },
    ]);
    const ok = M.C.gradePath(base({ observed: bumped }));
    assert.equal(ok.items.P2.disposition, 'PASS-CONDITIONAL', ok.items.P2.reason);
    assert.ok(ok.items.P2.conditions.some((c: string) => /consequential changes are spent/.test(c)));

    // And past the budget it is refused, because the exemption is bounded.
    const spent = M.C.gradePath(
      base({ observed: bumped, status: status({ drift_since_seal: 8 }) }),
    );
    assert.equal(spent.items.P2.disposition, 'FAIL');
  });

  test('a capture-path file outside the measured boundary is not sealed', () => {
    const g = M.C.gradePath({
      ...base(),
      evidence: {
        ...base().evidence,
        capturePathFiles: { value: [...CAPTURE, 'services/scruple-capture/src/ws-gate.ts'], cite: 'declared' },
      },
    });
    assert.equal(g.items.P2.disposition, 'FAIL');
    assert.equal(g.items.P2.qualifier, 'capture path outside the boundary');
    assert.match(g.items.P2.reason, /ws-gate\.ts/);
  });

  test('the boundary covers what nobody declared, and that is the point', () => {
    // The asymmetry that stops C-7 rotting: a route inside the measured image
    // that no capture-path declaration names is covered anyway. If this ever
    // became a two-way check, the declaration would be a denylist again.
    const wide = base();
    const g = M.C.gradePath(wide);
    assert.notEqual(g.items.P2.disposition, 'FAIL');
    assert.ok(
      wide.evidence.seal!.value.approvedManifest!.entries.length > wide.evidence.capturePathFiles.value.length,
      'the fixture must have more in the boundary than on the declared path, or this proves nothing',
    );
  });

  test("WO-14 survives the re-cut: a borrowed run cannot carry a deployment into step 3", () => {
    const run = {
      runId: 'r', subject: 'somebody else entirely', startedAt: 'a', finishedAt: 'b', vantages: ['os'],
      results: [], summary: { passed: 7, failed: 0, inconclusive: 0, line: '' }, admissible: true,
    };
    const g = M.C.gradePath({ ...base(), probes: run });
    assert.equal(g.items.P2.disposition, 'FAIL');
    assert.equal(g.items.P2.qualifier, 'probe run is of another deployment');
    assert.match(g.items.P2.reason, /per configuration/);
  });

  test('an unregistered deployment is not the same fact as an unsealed one', () => {
    const g = M.C.gradePath(base({ status: status({ known: false, claims_standard: false }) }));
    assert.equal(g.items.P2.qualifier, 'deployment not registered');
    const never = M.C.gradePath(base(null));
    assert.equal(never.items.P2.qualifier, 'never sealed');
  });

  test('a deployment that passes every item is still refused when it is out of scope', () => {
    // The assertion the two published paths cannot make, because both fail
    // items anyway. `inScope` has to be load-bearing somewhere or the class
    // layer is decoration.
    const clean = M.C.gradePath({ ...base(), profile: inferenceHostProfile() });
    assert.equal(clean.classScope.inScope, true);
    assert.equal(clean.compliant, true, 'a sealed, in-scope deployment with no FAIL is compliant');

    // Same evidence, same items, one hook that belongs to a class it did not
    // declare. Every P-item still passes and the grade is refused.
    const g = M.C.gradePath({
      ...base(),
      profile: inferenceHostProfile({ hooks: ['graph.execute', 'artifact.produced', 'model.write'] }),
    });
    assert.ok(M.C.P_ITEMS.every((i) => g.items[i].disposition !== 'FAIL'), 'no item fails');
    assert.equal(g.classScope.inScope, false);
    assert.equal(g.compliant, false, 'you cannot be compliant with the wrong part of the standard');
    const f = g.classScope.findings.find((x) => x.id === 'CF-02')!;
    assert.equal(f.impliedClass, 'training-host');
  });

  test('a borrowed run cannot satisfy class scope either', () => {
    // WO-14 one level up. P2 already refuses a run of another deployment; if
    // class scope quietly accepted the same run's verdicts, a vendor could
    // satisfy their required probes with somebody else's evidence and only the
    // P2 cell would notice.
    const results = ['P-01', 'P-02', 'P-03', 'P-04', 'P-05', 'P-06', 'P-07'].map((id) => ({
      id, spec: '', title: '', attempt: '', requirement: '', evidenceFor: [] as never[],
      topological: false, verdict: 'pass' as const, vantage: 'os', admissible: true,
      startedAt: 'a', durationMs: 1, outcome: 'blocked' as const, detail: '', evidence: {},
    }));
    const b = {
      ...base(),
      profile: inferenceHostProfile({ surfaces: ['network-gate', 'filesystem-watch'] }),
    };

    const own = M.C.gradePath({
      ...b,
      probes: { runId: 'r', subject: b.path, startedAt: 'a', finishedAt: 'b', vantages: ['os'], results, summary: { passed: 7, failed: 0, inconclusive: 0, line: '' }, admissible: true },
    });
    assert.equal(own.classScope.unmeasured.length, 0, 'its own run satisfies its own probes');

    const borrowed = M.C.gradePath({
      ...b,
      probes: { runId: 'r', subject: 'somebody else entirely', startedAt: 'a', finishedAt: 'b', vantages: ['os'], results, summary: { passed: 7, failed: 0, inconclusive: 0, line: '' }, admissible: true },
    });
    assert.equal(borrowed.classScope.unmeasured.length, 7, 'a borrowed run supplies nothing');
    assert.equal(borrowed.items.P2.qualifier, 'probe run is of another deployment');
  });

  test('a sealed deployment can declare its attestation provider in the seal', () => {
    // P7's vehicle is no longer only a baseline manifest. `none` is a correct
    // VALUE; what P7 needs is somewhere durable that says so.
    const g = M.C.gradePath(base());
    assert.equal(g.items.P7.disposition, 'PASS');
    const undeclared = base();
    undeclared.evidence.attestationDeclaration = null;
    const g2 = M.C.gradePath(undeclared);
    assert.equal(g2.items.P7.disposition, 'FAIL');
    assert.match(g2.items.P7.reason, /approved configuration/);
  });
});

// ===========================================================================
// THE ACCEPTANCE TEST.
// ===========================================================================

/** Read a file as it was at the graded commit. Never the working tree. */
function readPinned(rel: string): string | null {
  try {
    return execFileSync('git', ['show', `${GRADED_COMMIT}:${rel}`], {
      cwd: REPO,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

/** The published grade's summary table, parsed out of the document itself.
 *  The document is the oracle; the harness must match it, not the other way. */
function publishedTable(doc: string): Record<string, Record<string, string>> {
  const rows = doc.split('\n').filter((l) => /^\| \*\*P[1-8]\*\*/.test(l));
  assert.ok(rows.length === 8, `expected 8 P-item rows in the published table, got ${rows.length}`);
  const out: Record<string, Record<string, string>> = {};
  for (const row of rows) {
    const cells = row.split('|').map((c) => c.trim());
    const item = /\*\*(P[1-8])\*\*/.exec(cells[1])![1];
    out[item] = { 'Canvas / ComfyUI': cells[2], Kohya: cells[3] };
  }
  return out;
}

describe(`THE ACCEPTANCE TEST — reproduce STUDIO_P1-P8_GRADE.md at ${GRADED_COMMIT.slice(0, 7)}`, () => {
  test('the pinned commit is readable, or this whole exercise is fiction', () => {
    assert.ok(readPinned('docs/canon/STUDIO_P1-P8_GRADE.md'), `${GRADED_COMMIT} is not reachable`);
  });

  test('the harness reproduces the published grade cell for cell, including both FAILs', () => {
    const doc = readPinned('docs/canon/STUDIO_P1-P8_GRADE.md');
    assert.ok(doc, 'the published grade must be readable at the pinned commit');
    const expected = publishedTable(doc);

    const inputs = M.C.deriveStudio(readPinned);
    // GRADED UNDER THE RULE THE PUBLISHED GRADE WAS ISSUED UNDER, and that is
    // the deliberate choice WO-23 had to make rather than delete this test.
    // STUDIO_P1-P8_GRADE.md's P2 cells were decided by the runtime-completeness
    // rule; reproducing them under a rule that did not exist when they were
    // written would prove nothing about either. The rule in force is checked
    // against the same pinned evidence in the test below.
    const g = M.C.grade(GRADED_COMMIT, inputs, M.C.RUNTIME_COMPLETENESS_PROFILE);
    const canvas = g.paths.find((p) => p.path === 'Canvas / ComfyUI')!;
    const kohya = g.paths.find((p) => p.path === 'Kohya')!;

    for (const item of M.C.P_ITEMS) {
      assert.equal(
        M.C.renderCell(canvas.items[item].disposition, canvas.items[item].qualifier),
        expected[item]['Canvas / ComfyUI'],
        `canvas ${item}: ${canvas.items[item].reason}`,
      );
      assert.equal(
        M.C.renderCell(kohya.items[item].disposition, kohya.items[item].qualifier),
        expected[item].Kohya,
        `kohya ${item}: ${kohya.items[item].reason}`,
      );
    }

    // And the headline the table alone does not carry.
    assert.equal(canvas.compliant, false);
    assert.equal(kohya.compliant, false);
  });

  test('the two FAILs are reached for the reasons the document gives, not by coincidence', () => {
    const g = M.C.grade(GRADED_COMMIT, M.C.deriveStudio(readPinned), M.C.RUNTIME_COMPLETENESS_PROFILE);
    const canvas = g.paths.find((p) => p.path === 'Canvas / ComfyUI')!;
    const kohya = g.paths.find((p) => p.path === 'Kohya')!;

    // Canvas P2 — the only tamper surface in the estate covers four files of
    // the witness server, none of which is on the canvas capture path.
    assert.match(canvas.items.P2.reason, /No baseline covers/);
    assert.match(canvas.items.P2.reason, /lib\/canvas\/witness\.ts/);
    // Canvas P7 — fails FOR FREE from P2, and the distinction matters:
    // `provider: none` is the correct value and P7 permits it.
    assert.equal(canvas.items.P7.basis, 'derived-from-P2');
    assert.match(canvas.items.P7.reason, /closes for free the moment P2 does/);
    // Canvas P1 is a CONDITIONAL pass and the conditions are the document's.
    assert.equal(canvas.items.P1.disposition, 'PASS-CONDITIONAL');
    // The conditions come from two places and both must be there: the four
    // H-4 §7 probe conditions that `assuranceFor` attaches to every
    // sidecar-gate, and the three the published grade names for canvas
    // specifically — which no placement axis could have produced.
    assert.ok(
      canvas.items.P1.conditions.some((c) => /probe 1/.test(c)),
      'the derived probe conditions must survive',
    );
    assert.ok(
      canvas.items.P1.conditions.some((c) => /WebSocket sidecar/.test(c)),
      'declared condition 1 (WS pass-through) missing',
    );
    assert.ok(
      canvas.items.P1.conditions.some((c) => /personal machines/i.test(c)),
      'declared condition 2 (WO-7 personal machines) missing',
    );
    assert.ok(
      canvas.items.P1.conditions.some((c) => /user_id IS NULL/.test(c)),
      'declared condition 3 (null manifest fallback) missing',
    );
    // The §7 silent drop is carried as a separate finding, not as a P-item.
    assert.ok(
      M.C.deriveCanvas(readPinned).evidence.separateFindings.some((f) => /§7/.test(f.title)),
    );

    // Kohya P1 — a declared sidecar-gate with nothing enforcing it degrades to
    // unattested-client, where P1 and P3 fail by construction.
    assert.equal(kohya.assurance.resolution.effective, 'unattested-client');
    assert.equal(kohya.assurance.canClaim, false);
    // Kohya P3 — the secret is a pod environment variable, which P3 names
    // verbatim as unacceptable.
    assert.match(kohya.items.P3.reason, /environment variable/);
    assert.match(kohya.items.P3.reason, /custody, not scope/);
    // Kohya P4 — derived from P3, exactly as the document says.
    assert.equal(kohya.items.P4.basis, 'derived-from-P3');
    // Kohya P5 — the headline. No leaf is ever created.
    assert.match(kohya.items.P5.reason, /no event chain/i);
    // Kohya P6 — the one property it gets right.
    assert.equal(kohya.items.P6.disposition, 'PASS');
    // The finding the document leads with, which is still true at this commit.
    const findings = M.C.deriveKohya(readPinned).evidence.separateFindings;
    assert.ok(
      findings.some((f) => /docstring claims a leaf is signed/i.test(f.title)),
      'the hook still tells the operator a leaf is signed and the route still does not sign one',
    );
  });

  test('ONE DIVERGENCE from the published grade, and the harness is right', () => {
    // STUDIO_P1-P8_GRADE.md's Kohya P2 leads with "two divergent copies of the
    // hook exist" — public/pod-hooks/ at 167 lines never computing
    // header_hash, research/scruple-kohya-image/ at 176 lines computing it —
    // and concludes "you cannot baseline a file that ships in two versions."
    //
    // At the commit graded here they are BYTE-IDENTICAL. Commits 89cfafd and
    // 1f0ef22 reconciled them between the grade being written and this commit.
    // So the harness does not report that finding, and it is right not to: it
    // grades the tree, not the document. The P-item table is unaffected —
    // Kohya's P2 still fails, on the baseline that does not exist — which is
    // why the reproduction above is cell-for-cell exact even though this one
    // supporting finding has closed underneath it.
    const a = readPinned('public/pod-hooks/kohya_safetensors_hook.py');
    const b = readPinned('research/scruple-kohya-image/scruple_safetensors_hook.py');
    assert.ok(a && b, 'both hook copies must be readable at the pinned commit');
    assert.equal(
      crypto.createHash('sha256').update(a!).digest('hex'),
      crypto.createHash('sha256').update(b!).digest('hex'),
      'the two hook copies have diverged again; the published finding is live once more',
    );
    const findings = M.C.deriveKohya(readPinned).evidence.separateFindings;
    assert.equal(
      findings.some((f) => /two divergent copies/i.test(f.title)),
      false,
      'the harness must not report a finding the tree no longer supports',
    );
  });

  test('a bracket in a route path does not truncate the baseline it parses', () => {
    // A real bug in this harness, found by pointing it at a real baseline.
    // `lib/canvas/baseline.ts`'s first tracked file is
    // 'app/canvas-proxy/[sessionId]/[[...path]]/route.ts'; a lazy match to the
    // first `]` stopped inside `[sessionId]` and returned ONE covered file out
    // of twenty-three, so the grader reported P2 FAIL against a baseline that
    // covered the whole path. Next.js route segments will keep putting
    // brackets in paths.
    const fake =
      "export const TRACKED: readonly string[] = [\n" +
      "  'app/canvas-proxy/[sessionId]/[[...path]]/route.ts',\n" +
      "  'lib/canvas/gate.ts',\n" +
      "  'lib/canvas/witness.ts',\n" +
      '];\n';
    const got = M.C.deriveBaselineCoverage((rel) =>
      rel === 'lib/canvas/baseline.ts'
        ? fake
        : rel === 'services/witness-server/tamper-surface.mjs'
          ? "export const TRACKED = [\n  'server.js',\n];\n"
          : null,
    );
    assert.deepEqual(got!.covers, [
      'services/witness-server/server.js',
      'app/canvas-proxy/[sessionId]/[[...path]]/route.ts',
      'lib/canvas/gate.ts',
      'lib/canvas/witness.ts',
    ]);
  });

  test('the derivation refuses to grade a file it cannot read', () => {
    // The failure mode that would make all of the above worthless: a
    // derivation that silently returns the benign value when its anchor moves.
    assert.throws(() => M.C.deriveCanvas(() => null), /could not be read/);
    assert.throws(
      () => M.C.deriveBaselineCoverage((p) => (p.endsWith('tamper-surface.mjs') ? '// nothing here' : null)),
      /TRACKED/,
    );
  });


  test('THE RE-CUT DOES NOT LAUNDER THE PUBLISHED FAILURE — same eight cells, new rule', () => {
    // The other half of the acceptance property, and the reason the frozen
    // profile is not enough on its own. WO-23 re-cut P2 from a runtime
    // completeness proof to seal currency. A re-cut that quietly turned a
    // published FAIL into a PASS would be indistinguishable, from inside the
    // suite, from a re-cut that fixed something — so the SAME pinned evidence
    // is graded under the rule in force and compared to the SAME published
    // table.
    //
    // The table is unchanged. What changed is the sentence under it, and the
    // difference is worth stating precisely:
    //
    //   OLD: canvas fails P2 because no baseline covers its capture path.
    //   NEW: canvas fails P2 because its pipeline has never been measured and
    //        no configuration has ever been approved. Its ratchet — the thing
    //        the old rule said it could not have "at any level of effort" — is
    //        not mentioned, because it was never the question.
    const doc = readPinned('docs/canon/STUDIO_P1-P8_GRADE.md');
    assert.ok(doc);
    const expected = publishedTable(doc!);
    const g = M.C.grade(GRADED_COMMIT, M.C.deriveStudio(readPinned)); // DEFAULT profile
    assert.equal(g.profile, M.C.SEALED_PIPELINE_PROFILE.id);

    // EVERY DISPOSITION IS UNCHANGED. This is the load-bearing comparison: the
    // dispositions are what compliance is computed from, and if the re-cut had
    // moved one of them, the re-cut would have rewritten a published grade.
    const divergences: string[] = [];
    for (const path of ['Canvas / ComfyUI', 'Kohya'] as const) {
      const p = g.paths.find((x) => x.path === path)!;
      for (const item of M.C.P_ITEMS) {
        const wasFail = /\*\*FAIL\*\*/.test(expected[item][path]);
        const wasNa = expected[item][path] === 'n/a';
        const nowFail = p.items[item].disposition === 'FAIL';
        const nowNa = p.items[item].disposition === 'n/a';
        assert.equal(nowFail, wasFail, `${path} ${item}: ${p.items[item].reason}`);
        assert.equal(nowNa, wasNa, `${path} ${item}: ${p.items[item].reason}`);
        const cell = M.C.renderCell(p.items[item].disposition, p.items[item].qualifier);
        if (cell !== expected[item][path]) divergences.push(`${path} ${item}: ${expected[item][path]} → ${cell}`);
      }
      assert.equal(p.compliant, false);
      // Both are pre-seal, which is where every integration starts.
      assert.equal(p.lifecycle, 'integrating');
    }

    // AND THE ONE RENDERED DIFFERENCE, NAMED RATHER THAN TOLERATED. Both P2
    // cells gain a qualifier they did not have, because under the old rule
    // there was one way to fail P2 and under the new rule there are several —
    // never sealed, still verifying, resealing on a material change, a stale
    // seal, a boundary that does not contain the capture path. A reader
    // scanning the row has to know which, exactly as they have to know that
    // Kohya's P4 falls because P3 fell. Nothing else in the table moves.
    assert.deepEqual(divergences, [
      'Canvas / ComfyUI P2: **FAIL** → **FAIL** (never sealed)',
      'Kohya P2: **FAIL** → **FAIL** (never sealed)',
    ]);

    const canvas = g.paths.find((p) => p.path === 'Canvas / ComfyUI')!;
    assert.equal(canvas.items.P2.qualifier, 'never sealed');
    assert.match(canvas.items.P2.reason, /never been measured/);
    assert.doesNotMatch(canvas.items.P2.reason, /No baseline covers/);
    // AND THE SENTENCE THAT WAS AN ARTEFACT IS GONE. The old grade said
    // canvas could not satisfy P2 "at any level of effort" because it has no
    // ratchet. The counter now reports as liveness and says the honest thing.
    assert.doesNotMatch(canvas.items.P2.reason, /ratchet|counter/i);
    assert.equal(canvas.liveness.verdict, 'not-applicable');
    assert.match(canvas.liveness.reason, /no counter chain/i);

    // P7 still falls out of P2 for free, and for the reason it always did.
    assert.equal(canvas.items.P7.basis, 'derived-from-P2');
    assert.match(canvas.items.P7.reason, /closes for free the moment P2 does/);
  });

  test('CLASS-SCOPING MOVES NO PUBLISHED CELL, and the divergence list still says so', () => {
    // WO-24. The grader now scores a profile against its capability class
    // rather than against the union of everything. A re-cut that quietly
    // turned a published FAIL into a PASS — or a published FAIL into an `n/a`
    // — would be indistinguishable from inside the suite from a re-cut that
    // fixed something, which is the same trap WO-23 had to walk out of.
    //
    // So the SAME pinned evidence is graded under the rule in force with class
    // scoping live, and compared to the SAME published table. The divergence
    // list is asserted EXACTLY, and it is still the two P2 qualifiers WO-23
    // named. Nothing about the class layer reaches a cell.
    const doc = readPinned('docs/canon/STUDIO_P1-P8_GRADE.md');
    const expected = publishedTable(doc!);
    const g = M.C.grade(GRADED_COMMIT, M.C.deriveStudio(readPinned));
    const divergences: string[] = [];
    for (const path of ['Canvas / ComfyUI', 'Kohya'] as const) {
      const p = g.paths.find((x) => x.path === path)!;
      for (const item of M.C.P_ITEMS) {
        const cell = M.C.renderCell(p.items[item].disposition, p.items[item].qualifier);
        if (cell !== expected[item][path]) divergences.push(`${path} ${item}: ${expected[item][path]} → ${cell}`);
        // AND NO ITEM BECAME `n/a` BY CLASS SCOPE. The mechanism exists and
        // nothing triggers it; if that ever changes for a published path, this
        // is the assertion that forces the divergence to be stated.
        assert.notEqual(p.items[item].basis, 'class-scope', `${path} ${item} went out of scope`);
      }
    }
    assert.deepEqual(divergences, [
      'Canvas / ComfyUI P2: **FAIL** → **FAIL** (never sealed)',
      'Kohya P2: **FAIL** → **FAIL** (never sealed)',
    ]);
  });

  test('canvas is an inference host, and probe 4 stops reading as its failure', () => {
    // THE FINDING THIS WO EXISTS TO CLOSE. Canvas has no filesystem surface —
    // the Modal volume is not mountable into scruple-web — and for three WOs
    // that read as a canvas failure rather than as out of scope.
    //
    // It used to be handled by `surfaceAbsences`: the integrator declared the
    // absence with a cite, the grader accepted it, and the accepting branch
    // said so in as many words ("that acceptance rests on a DECLARATION the
    // model cannot check"). Now the CLASS declares probe 4 not applicable to a
    // member with no `filesystem-watch` surface, and the declaration is
    // CHECKED against the profile's own surface list.
    const g = M.C.grade(GRADED_COMMIT, M.C.deriveStudio(readPinned));
    const canvas = g.paths.find((p) => p.path === 'Canvas / ComfyUI')!;
    const c = canvas.classScope;
    assert.deepEqual([...c.audited], ['inference-host']);
    assert.equal(c.ambiguityResolved, false, 'canvas declares its class rather than defaulting');
    const p4 = c.probes.find((x) => x.item === 'P-04')!;
    assert.equal(p4.status, 'not-applicable');
    assert.equal(p4.outcome, 'not-applicable');
    assert.ok(!c.unmeasured.includes('P-04'), 'out of scope is not the same fact as unmeasured');
    // And the six that ARE in scope are unmeasured, not passed. No run is
    // attached to this grade, and nobody looked is never a pass.
    assert.equal(c.unmeasured.length, 6);
    assert.equal(c.inScope, true, 'canvas is a member of the class it declared');

    // Canvas's custody: vendor-custody at an effective sidecar-gate is the one
    // configuration in the estate entitled to the complete-history sentence,
    // and the conditions say what it rests on.
    assert.equal(canvas.assurance.custody!.claim, 'complete-history');
    assert.ok(c.permittedClaims.includes('this is the complete history of the project'));
    assert.equal(
      c.permittedClaims.filter((x) => c.forbiddenClaims.includes(x)).length,
      0,
      'nothing may be both permitted and forbidden',
    );
    assert.ok(c.forbiddenClaims.includes('Scruple-witnessed authorship'));
  });

  test('Kohya is a training host: probe 5 leaves its scope, and a floor it misses appears', () => {
    const g = M.C.grade(GRADED_COMMIT, M.C.deriveStudio(readPinned));
    const kohya = g.paths.find((p) => p.path === 'Kohya')!;
    const c = kohya.classScope;
    assert.deepEqual([...c.audited], ['training-host']);

    // WHAT LEAVES. CAPABILITY_CLASSES.md: "Probe 5 (WebSocket retrieval) is
    // meaningless for a training host." A checkpoint is a file, fetched as one
    // or not at all.
    assert.equal(c.probes.find((x) => x.item === 'P-05')!.status, 'not-applicable');

    // WHAT ARRIVES, AND IT IS THE MORE INTERESTING HALF. `training-host`
    // requires a `filesystem-watch` position BECAUSE a checkpoint is a file
    // and there is no fail-closed point; Kohya as shipped has only an
    // in-process patch on `safetensors.save_file`, which covers the saves that
    // go through the function it patched and no others. That is a COVERAGE
    // finding the P-item table never carried, and it is independent of the
    // placement failure that already sinks P1 and P3.
    const f = c.findings.find((x) => x.id === 'CF-05');
    assert.ok(f, 'the class floor Kohya misses must be visible');
    assert.match(f!.title, /filesystem-watch/);
    assert.equal(c.inScope, false);

    // And `compliant` is conjoined with scope. Kohya was already
    // non-compliant on five items, so no published cell moves — but a
    // deployment that passed every item and was graded against a class it is
    // not a member of must not come out compliant.
    assert.equal(kohya.compliant, false);
  });

  test('a grade says which rule issued it, in the document and in the manifest', () => {
    // Beside the source ref, for the same reason. Two submissions six months
    // apart can be graded by different rules, and a reviewer has to see that
    // before they compare the tables.
    const frozen = M.C.grade(GRADED_COMMIT, M.C.deriveStudio(readPinned), M.C.RUNTIME_COMPLETENESS_PROFILE);
    const current = M.C.grade(GRADED_COMMIT, M.C.deriveStudio(readPinned));
    assert.notEqual(frozen.profile, current.profile);
    assert.match(M.C.renderGradeMarkdown(frozen), new RegExp(M.C.RUNTIME_COMPLETENESS_PROFILE.id));
    assert.match(M.C.renderGradeMarkdown(current), new RegExp(M.C.SEALED_PIPELINE_PROFILE.id));
    // The row heading follows the rule: `baseline coverage` is what the
    // published document called P2 and is not what the rule in force measures.
    assert.match(M.C.renderGradeTable(frozen), /\*\*P2\*\* baseline coverage/);
    assert.match(M.C.renderGradeTable(current), /\*\*P2\*\* pipeline seal/);
  });

  test('the derivation refuses to guess a seal state it cannot see', () => {
    // A lifecycle state is a fold over signed events, not a fact in a file.
    // The derivation returns "nothing was said" for canvas and Kohya — which
    // is true, and which migration 046 says in as many words — and THROWS the
    // moment a capture path names a deployment id, because reporting a
    // pre-seal state for a deployment that may be sealed is the flattering
    // direction and the one direction this harness refuses to fail in.
    assert.equal(M.C.deriveSealEvidence(readPinned, ['lib/canvas/witness.ts']), null);
    assert.throws(
      () => M.C.deriveSealEvidence(() => 'const x = { deploymentId: dep };', ['x.ts']),
      /sealStatus/,
    );
  });

  test('the rendered grade is the document\'s shape, and says which commit it graded', () => {
    const g = M.C.grade(GRADED_COMMIT, M.C.deriveStudio(readPinned), M.C.RUNTIME_COMPLETENESS_PROFILE);
    const md = M.C.renderGradeMarkdown(g);
    assert.match(md, /## Summary table/);
    assert.match(md, /\| \*\*P1\*\* runtime boundary integrity \|/);
    assert.match(md, new RegExp(GRADED_COMMIT));
    assert.match(md, /non-compliant/);
  });
});
