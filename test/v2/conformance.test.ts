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
  F: typeof import('../../services/scruple-capture/probes/fixtures');
  P: typeof import('../../services/scruple-capture/probes/index');
};

let M: Mod;
const TENANT = 'vendor-conformance';

before(async () => {
  const [migrate, prov, identity, bm, ratchet, C, F, P] = await Promise.all([
    import('../../lib/db/migrate'),
    import('../../lib/ratchet/provisioning'),
    import('../../services/scruple-capture/src/identity'),
    import('../../services/scruple-capture/src/build-measurement'),
    import('../../lib/ratchet/ratchet'),
    import('../../packages/scruple-conformance/src/index'),
    import('../../services/scruple-capture/probes/fixtures'),
    import('../../services/scruple-capture/probes/index'),
  ]);
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
describe('the self-grade harness — WO-5 DEFECT-2 is honoured', () => {
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
    const g = M.C.gradePath(wellFormedButWrong());
    assert.equal(g.items.P2.disposition, 'FAIL');
    assert.match(g.items.P2.reason, /DEFECT-2/);
    assert.match(g.items.P2.reason, /filesystem-watch/);
    assert.equal(g.compliant, false);
  });

  test('P2 needs probes 4, 5 and 7 blocked from an occupied position, and gap accounting', async () => {
    const base = wellFormedButWrong();

    // Probes present but inconclusive (a simulated vantage) is still not a pass.
    const inconclusiveRun = {
      runId: 'r', startedAt: 'a', finishedAt: 'b', vantages: ['simulated'],
      results: ['P-04', 'P-05', 'P-07'].map((id) => ({
        id, spec: '', title: '', attempt: '', requirement: '', evidenceFor: [] as never[],
        topological: true, verdict: 'inconclusive' as const, vantage: 'simulated', admissible: false,
        startedAt: 'a', durationMs: 1, outcome: 'blocked' as const, detail: '', evidence: {},
      })),
      summary: { passed: 0, failed: 0, inconclusive: 3, line: '' },
      admissible: false,
    };
    assert.equal(M.C.gradePath({ ...base, probes: inconclusiveRun }).items.P2.disposition, 'FAIL');

    const passingRun = {
      ...inconclusiveRun,
      vantages: ['os'],
      results: inconclusiveRun.results.map((r) => ({ ...r, verdict: 'pass' as const, vantage: 'os', admissible: true })),
      summary: { passed: 3, failed: 0, inconclusive: 0, line: '' },
      admissible: true,
    };
    assert.equal(M.C.gradePath({ ...base, probes: passingRun }).items.P2.disposition, 'PASS');

    // Drop the gap accounting and it goes back to FAIL: a coverage claim with
    // no account of missing counters cannot tell "captured nothing" from
    // "captured everything".
    const noGaps = { ...base, evidence: { ...base.evidence, ratchetGapAccounting: null }, probes: passingRun };
    assert.equal(M.C.gradePath(noGaps).items.P2.disposition, 'FAIL');
    assert.match(M.C.gradePath(noGaps).items.P2.reason, /gap accounting/);
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
    const g = M.C.gradePath(short);
    assert.equal(g.items.P2.disposition, 'FAIL');
    assert.match(g.items.P2.reason, /does not cover 1 of 2/);
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
    const g = M.C.grade(GRADED_COMMIT, inputs);
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
    const g = M.C.grade(GRADED_COMMIT, M.C.deriveStudio(readPinned));
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

  test('the rendered grade is the document\'s shape, and says which commit it graded', () => {
    const g = M.C.grade(GRADED_COMMIT, M.C.deriveStudio(readPinned));
    const md = M.C.renderGradeMarkdown(g);
    assert.match(md, /## Summary table/);
    assert.match(md, /\| \*\*P1\*\* runtime boundary integrity \|/);
    assert.match(md, new RegExp(GRADED_COMMIT));
    assert.match(md, /non-compliant/);
  });
});
