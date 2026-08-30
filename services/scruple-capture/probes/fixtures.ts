// Two deployments to point the probes at, and neither of them is a mock.
//
// A conformance suite demonstrated against a stub of itself demonstrates
// nothing. Both fixtures below run the SHIPPED capture code — `Identity`, the
// real ratchet, `Submitter`, `QueueStore`, `FsWatchSurface`, `HttpGate`,
// `WsGate` — against the stub ComfyUI that WO-7 transcribed from
// /data/reference/ui-inspire/ComfyUI line by line. What differs between them is
// the TOPOLOGY, which is the thing under test.
//
// ---------------------------------------------------------------------------
// NON-CONFORMANT — "a filesystem watcher alone", the shape §2 names bypassable
// ---------------------------------------------------------------------------
//
// §2: "A filesystem watcher alone misses Path 2 entirely, because those bytes
// never exist as a file." So the non-conformant fixture is exactly that, and
// nothing more contrived: ComfyUI is the tenant's endpoint, an `FsWatchSurface`
// watches `output/` and only `output/`, and the ingest accepts whatever it is
// sent. Every hole the seven probes hunt for is present, and each one is
// present for a reason someone actually shipped:
//
//   probe 1  the workload IS the tenant's endpoint            (no gate at all)
//   probe 2  the ingest provisions for anyone who asks
//   probe 3  the state directory is in the tenant's mount
//   probe 4  temp/ and input/ are unwatched                   (§10 C-8)
//   probe 5  WS frames are pass-through                       (§2 path 2)
//   probe 6  the ingest records forged submissions
//   probe 7  egress is open                                   (§10 C-9)
//
// ---------------------------------------------------------------------------
// CONFORMANT — and one thing about it is a finding, not a fixture detail
// ---------------------------------------------------------------------------
//
// §10 C-8 requires `output/`, `temp/` and `input/` to be mounted and watched.
// `CaptureConfig.outputVolume` is SINGULAR — the shipped component takes one
// directory. The only way to satisfy C-8 against today's config is to mount the
// three as SUBDIRECTORIES of one watched root and rely on
// `fs.watch(..., {recursive: true})`, which is what this fixture does and what
// a vendor would have to do. It works, and it is worth writing down that it
// works by accident of the recursive flag rather than by design of the config.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import type { ObservationSink } from '../../../lib/capture/surface';
import type {
  DeploymentUnderTest,
  LeafOracle,
  ProbeContext,
  TenantVantage,
} from '../../../packages/scruple-conformance/src/types';
import { recordedLeafOracle } from '../../../packages/scruple-conformance/src/oracle';
import { OsVantage } from '../../../packages/scruple-conformance/src/vantage';
import { CaptureComponent } from '../src/component';
import { Correlator } from '../src/correlation';
import type { Identity } from '../src/identity';
import { QueueStore } from '../src/queue';
import { Submitter } from '../src/submitter';
import { FsWatchSurface } from '../src/surfaces/fs-watch';
import { startStubComfyUI, type StubComfyUI } from '../test-support/stub-comfyui';

export interface StubIngest {
  url: string;
  received: Array<Record<string, unknown>>;
  /** Non-conformant: records anything. Conformant: refuses what it cannot verify. */
  strict: boolean;
  close(): Promise<void>;
}

/**
 * The ingest half. `strict` is the difference probe 6 measures: a permissive
 * ingest records a forged submission as a component event, a strict one calls
 * the caller's verifier and refuses.
 */
export async function startStubIngest(
  verify: ((submission: Record<string, unknown>) => boolean) | null,
): Promise<StubIngest> {
  const state: StubIngest = { url: '', received: [], strict: verify !== null, close: async () => undefined };

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      } catch {
        res.writeHead(400).end('bad json');
        return;
      }
      const url = req.url ?? '';

      // §4.4 provisioning. A deployment that provisions for anyone who asks is
      // §10 C-5's failure: the one-time token alone cannot say which tenant is
      // calling, so an API key carrying `component:provision` is required in
      // addition, and a tenant credential must not carry it.
      if (url.startsWith('/api/v2/components/provision')) {
        if (verify) {
          res.writeHead(403, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'component:provision scope required' }));
        } else {
          res.writeHead(201, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ component_id: 'granted-to-anyone', ik_hex: 'de'.repeat(32) }));
        }
        return;
      }

      if (verify && !verify(body)) {
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'mac_mismatch', component_verified: 0 }));
        return;
      }
      state.received.push(body);
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  state.url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  // closeAllConnections() before close(). Node's http.globalAgent and undici
  // both keep-alive by default, so `server.close()` alone waits on idle
  // sockets that nobody is going to use again — a fixture that hangs its own
  // teardown is a flaky suite waiting to happen, and this suite is meant to be
  // evidence.
  state.close = () =>
    new Promise<void>((r) => {
      server.closeAllConnections();
      server.close(() => r());
    });
  return state;
}

// ---------------------------------------------------------------------------
// TWO TEARDOWN HAZARDS, BOTH FOUND THE HARD WAY. Do not re-introduce either.
// ---------------------------------------------------------------------------
//
// 1. DO NOT destroy undici's global dispatcher to hurry a fixture down. It is
//    process-wide and permanent: every later `fetch()` in the process fails
//    with UND_ERR_DESTROYED. That is why `OsVantage` owns a private
//    `keepAlive: false` agent instead of borrowing the global pool — a vantage
//    models a network position, and a shared connection pool is the opposite
//    of one.
//
// 2. DO NOT destroy `http.globalAgent` either. `node:test` runs the suites in
//    a file CONCURRENTLY, and that agent is what the capture component uses to
//    reach its upstream. Destroying it from one fixture's teardown pulls the
//    socket out from under another fixture's in-flight proxy, and the request
//    neither completes nor errors — the test body finishes, the test promise
//    never settles, and the whole file hangs with every assertion already
//    passed. That failure looks exactly like a deadlock in the component and
//    is not one.
//
// What is left is enough: the stub ingest drops its own connections, and the
// only remaining keep-alive socket is the component's one to its upstream,
// which times out on its own.

export interface Deployment {
  kind: 'conformant' | 'non-conformant';
  /** Present only on the conformant fixture; the other has no gate by design. */
  component: CaptureComponent | null;
  comfy: StubComfyUI;
  ingest: StubIngest;
  gateUrl: string;
  stateDir: string;
  deployment: DeploymentUnderTest;
  oracle: LeafOracle;
  /** Await every capture currently in flight. The tests' quiescence point. */
  settled(): Promise<void>;
  stop(): Promise<void>;
}

export interface FixtureOptions {
  root: string;
  /** Provision against the real server-side ratchet. Supplied by the test so
   *  this module never imports lib/db. */
  makeIdentity: (stateDir: string) => Identity;
  /** Strict ingest verifier, for the conformant fixture. */
  verify?: (submission: Record<string, unknown>) => boolean;
  /** An external host probe 7 should not be able to reach. */
  egressTarget?: { host: string; port: number } | null;
  /** Probe 7's negative control: an endpoint this position IS expected to
   *  reach, so that "nothing got out" can be attributed to the policy rather
   *  than to the environment the probe happens to be running in. */
  egressControl?: { host: string; port: number } | null;
}

/* ────────────────────────────────────────────────────────────────────────
 * The non-conformant deployment.
 * ──────────────────────────────────────────────────────────────────────── */

export async function startNonConformant(opts: FixtureOptions): Promise<Deployment> {
  const root = fs.mkdtempSync(path.join(opts.root, 'nonconf-'));
  const comfy = await startStubComfyUI(root);
  const tempDir = path.join(root, 'temp');
  fs.mkdirSync(tempDir, { recursive: true });

  const ingest = await startStubIngest(null);
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });

  const identity = opts.makeIdentity(stateDir);
  const queue = new QueueStore(path.join(stateDir, 'queue.jsonl'));
  const submitter = new Submitter({
    identity,
    queue,
    apiBaseUrl: ingest.url,
    apiKey: 'sk_test_nonconformant',
    baselineRef: 'ab'.repeat(32),
    log: () => undefined,
  });

  // THE ONE SURFACE. §2's "a filesystem watcher alone", pointed at output/
  // and nothing else.
  const fsWatch = new FsWatchSurface({
    outputVolume: comfy.dirs.output,
    correlator: new Correlator(60_000),
    outputVolumeDeclaredMime: 'image/png',
    log: () => undefined,
  });
  await fsWatch.open({
    sink: submitter as ObservationSink,
    placement: 'unattested-client',
    config: {},
  });

  const gateUrl = comfy.url; // there is no gate; the workload is the endpoint

  return {
    kind: 'non-conformant',
    component: null,
    comfy,
    ingest,
    gateUrl,
    stateDir,
    oracle: recordedLeafOracle(() => ingest.received, 'non-conformant stub ingest'),
    deployment: {
      gateUrl,
      declaredUpstream: { host: '127.0.0.1', port: comfy.port },
      volumes: { output: comfy.dirs.output, temp: tempDir, input: comfy.dirs.input },
      stateDir,
      apiBaseUrl: ingest.url,
      tenantApiKey: 'sk_test_tenant',
      componentId: identity.componentId,
      drainWindowMs: 600,
      egressTarget: opts.egressTarget ?? null,
      egressControl: opts.egressControl ?? null,
    },
    settled: () => fsWatch.settled(),
    async stop() {
      await fsWatch.close();
      await comfy.close();
      await ingest.close();
      identity.destroy();
    },
  };
}

/* ────────────────────────────────────────────────────────────────────────
 * The conformant deployment.
 * ──────────────────────────────────────────────────────────────────────── */

export async function startConformant(opts: FixtureOptions): Promise<Deployment> {
  const root = fs.mkdtempSync(path.join(opts.root, 'conf-'));
  // The workload's three directories live under ONE root, because
  // CaptureConfig.outputVolume is singular and fs.watch is recursive. See the
  // header — this is the only shape that satisfies §10 C-8 today.
  const volumeRoot = path.join(root, 'volume');
  const comfy = await startStubComfyUI(volumeRoot);
  const tempDir = path.join(volumeRoot, 'temp');
  fs.mkdirSync(tempDir, { recursive: true });

  const ingest = await startStubIngest(opts.verify ?? (() => true));
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });

  const component = await CaptureComponent.start(
    {
      upstreamUrl: comfy.url,
      listenHost: '127.0.0.1',
      listenPort: 0,
      outputVolume: volumeRoot,
      stateDir,
      apiBaseUrl: ingest.url,
      apiKey: 'sk_test_conformant',
      provisioningToken: null,
      baselineRef: 'ab'.repeat(32),
      outputVolumeDeclaredMime: 'image/png',
      settleMs: 40,
      correlationTtlMs: 60_000,
      heartbeatWindowSeconds: 900,
    },
    { identity: opts.makeIdentity(stateDir), log: () => undefined },
  );

  const gateUrl = `http://127.0.0.1:${component.port}`;

  return {
    kind: 'conformant',
    component,
    comfy,
    ingest,
    gateUrl,
    stateDir,
    oracle: recordedLeafOracle(() => ingest.received, 'conformant stub ingest'),
    deployment: {
      gateUrl,
      declaredUpstream: { host: '127.0.0.1', port: comfy.port },
      volumes: {
        output: comfy.dirs.output,
        temp: tempDir,
        input: comfy.dirs.input,
      },
      stateDir,
      apiBaseUrl: ingest.url,
      tenantApiKey: 'sk_test_tenant',
      componentId: component.identity.componentId,
      drainWindowMs: 1500,
      egressTarget: opts.egressTarget ?? null,
      egressControl: opts.egressControl ?? null,
    },
    settled: () => component.fsWatch.settled(),
    async stop() {
      component.server.closeAllConnections();
      await component.stop();
      await comfy.close();
      await ingest.close();
    },
  };
}

/** Bind a deployment to a vantage. */
export function probeContext(d: Deployment, vantage: TenantVantage = new OsVantage()): ProbeContext {
  return { vantage, deployment: d.deployment, leaves: d.oracle, log: () => undefined };
}
