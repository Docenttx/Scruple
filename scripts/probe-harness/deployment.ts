// The DEPLOYMENT half of the tenant-position harness — everything the vendor
// operates, standing in the "host" network namespace.
//
// ---------------------------------------------------------------------------
// WHAT THIS IS AND, MORE IMPORTANTLY, WHAT IT IS NOT
// ---------------------------------------------------------------------------
//
// H-4 §7 says the probes run from inside the tenant container. There is no
// Docker on this host, so `topology.sh` builds the tenant position out of
// namespaces instead: a user namespace we are root in, a network namespace for
// this process, and a SECOND network + mount + (optionally) PID namespace for
// the tenant, joined by veth pairs. That is a real network boundary and a real
// mount boundary. It is NOT a container, and the difference is written down in
// `docs/canon/CONFORMANCE.md` rather than left for a reader to discover.
//
// This process owns:
//
//   * the stub ComfyUI, bound to the DEPLOYMENT namespace's loopback — the
//     tenant has its own loopback, so 127.0.0.1 here is unreachable there, and
//     that is exactly §2 obligation 1's "binds loopback or a private namespace"
//   * `scruple-capture`, listening on the shared link, which is the tenant's
//     ONLY sanctioned route
//   * a stand-in for scruple-web: /api/v2/witness backed by the REAL
//     `verifySubmission` (lib/ratchet/verify.ts) rather than a shape check, so
//     probe 6 measures the shipped ratchet; plus the two read endpoints the
//     leaf oracle needs
//   * probe 7's negative control, deliberately on a DIFFERENT subnet from the
//     gate, so a reachable control proves routing works to somewhere other than
//     the one link the tenant obviously has
//
// ONE HONEST LIMIT, STATED HERE BECAUSE THE CODE CANNOT STATE IT ELSEWHERE.
// The ingest below authenticates by declaration: it trusts the tenant id the
// harness gives it instead of resolving an API key. Probe 6 therefore measures
// the ratchet's refusal of a forged MAC and an out-of-window counter, and says
// nothing about the authentication layer C-6 requires in front of it. The real
// route (`app/api/v2/witness`) does both; this harness owns only the second.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import type { Submission } from '../../services/scruple-capture/src/leaf';
import { preimageOf } from '../../services/scruple-capture/src/leaf';
import type { WatchedVolume } from '../../services/scruple-capture/src/config';

const ROOT = must('HARNESS_ROOT');
const PROFILE = must('HARNESS_PROFILE');
const LINK_IP = must('HARNESS_LINK_IP');       // shared link, deployment side
const CTL_IP = must('HARNESS_CTL_IP');         // negative-control link
const GATE_PORT = Number(must('HARNESS_GATE_PORT'));
const API_PORT = Number(must('HARNESS_API_PORT'));
const CTL_PORT = Number(must('HARNESS_CTL_PORT'));
const EGRESS_IP = must('HARNESS_EGRESS_IP');
const EGRESS_PORT = Number(must('HARNESS_EGRESS_PORT'));

function must(k: string): string {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is not set; topology.sh is what sets it`);
  return v;
}

/** The seven deliberate breaks the audit pass uses. `none` is conformant. */
type Break =
  | 'none'
  | 'p1-second-route'
  | 'p2-open-provisioning'
  | 'p3-state-mounted'
  | 'p3-shared-pid'
  | 'p4-singular-volume'
  | 'p5-passthrough-ws'
  | 'p6-permissive-ingest'
  | 'p7-open-egress';
const BREAK = PROFILE as Break;

// Two of the breaks are topology, not code: `p3-state-mounted` and
// `p3-shared-pid` are applied by topology.sh (it declines to overlay the state
// directory, or declines to give the tenant its own PID namespace), and
// `p7-open-egress` is a route. They appear in this union so that one list names
// all nine profiles and a typo is a type error rather than a silent conformant
// run.

const TENANT = 'harness-tenant';
const VOLUME_ROOT = path.join(ROOT, 'volume');
// The state directory lives under a directory topology.sh replaces with an
// empty tmpfs in the tenant's mount namespace. Modelling "not mounted into the
// tenant container" as an absent path rather than as a 0600 file is deliberate:
// see the P-03 note in CONFORMANCE.md for what a user namespace cannot model.
const PRIVATE_ROOT = path.join(ROOT, 'private');
const STATE_DIR = path.join(PRIVATE_ROOT, 'state');

process.env.SCRUPLE_DB_PATH = path.join(PRIVATE_ROOT, 'harness.db');
process.env.SCRUPLE_BDK_HEX = process.env.SCRUPLE_BDK_HEX ?? 'd4'.repeat(32);
// The standing safety rule: nothing in this harness may address the production
// witness server on 127.0.0.1:5799.
process.env.WITNESS_SERVER_URL = 'http://127.0.0.1:1';

async function main(): Promise<void> {
  fs.mkdirSync(PRIVATE_ROOT, { recursive: true, mode: 0o700 });
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  fs.mkdirSync(VOLUME_ROOT, { recursive: true });

  const [migrate, prov, identityMod, bm, verify, capture, comp, corr, queueMod, submitterMod, fsw] =
    await Promise.all([
      import('../../lib/db/migrate'),
      import('../../lib/ratchet/provisioning'),
      import('../../services/scruple-capture/src/identity'),
      import('../../services/scruple-capture/src/build-measurement'),
      import('../../lib/ratchet/verify'),
      import('../../services/scruple-capture/test-support/stub-comfyui'),
      import('../../services/scruple-capture/src/component'),
      import('../../services/scruple-capture/src/correlation'),
      import('../../services/scruple-capture/src/queue'),
      import('../../services/scruple-capture/src/submitter'),
      import('../../services/scruple-capture/src/surfaces/fs-watch'),
    ]);
  migrate.runMigrations();

  const comfy = await capture.startStubComfyUI(VOLUME_ROOT);
  const tempDir = path.join(VOLUME_ROOT, 'temp');
  fs.mkdirSync(tempDir, { recursive: true });

  // ── the ingest / oracle ────────────────────────────────────────────────
  const accepted: Submission[] = [];
  const api = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', `http://${LINK_IP}`);

      if (url.pathname === '/api/v2/verify') {
        const h = url.searchParams.get('content_hash') ?? '';
        const hits = accepted.filter((s) => s.content_hash === h);
        json(res, 200, {
          found: hits.length > 0,
          counter: hits[0]?.component.counter ?? null,
          surfaces: [...new Set(hits.map((s) => s.capture.surface))],
          // §10 C-8 — `file:<volume type>:<path>`, so the oracle can say WHICH
          // of the three directories produced the leaf rather than only that
          // one did.
          egresses: [...new Set(hits.map((s) => s.capture.egress).filter(Boolean))],
        });
        return;
      }

      if (url.pathname === '/api/v2/components/status') {
        const id = url.searchParams.get('component_id') ?? '';
        const cs = accepted.filter((s) => s.component.component_id === id).map((s) => s.component.counter);
        json(res, 200, { high_water_counter: cs.length ? Math.max(...cs) : null });
        return;
      }

      if (url.pathname === '/api/v2/components/provision') {
        // §10 C-5. The one-time token cannot say WHICH tenant is calling, so an
        // API key carrying `component:provision` is required in addition — and
        // a tenant credential must not carry it. The break hands out an
        // identity to anyone who asks, which is the deployment C-5 names.
        if (BREAK === 'p2-open-provisioning') {
          json(res, 201, { component_id: 'granted-to-anyone', ik_hex: 'de'.repeat(32) });
        } else {
          json(res, 403, { error: 'component:provision scope required' });
        }
        return;
      }

      if (url.pathname !== '/api/v2/witness') {
        json(res, 404, { error: 'no such route' });
        return;
      }

      let body: Submission;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Submission;
      } catch {
        json(res, 400, { error: 'bad json' });
        return;
      }

      if (BREAK === 'p6-permissive-ingest') {
        accepted.push(body);
        json(res, 201, { ok: true, component_verified: 1 });
        return;
      }

      // A SUBMISSION THAT WILL NOT CANONICALISE IS REFUSED, NOT CRASHED ON.
      // Found by running probe 6 against the first cut of this file: the
      // forgery omits `component.attestation` (a tenant without the chain key
      // has no reason to get the envelope right), `preimageOf` dereferenced it,
      // and the ingest died mid-probe. The real route validates with zod before
      // anything reaches the ratchet; this is that check in the shape this stub
      // can carry, and a malformed body is a refusal — which is the outcome
      // probe 6 hunts for, reached honestly.
      let preimage;
      try {
        preimage = preimageOf(body);
      } catch (e) {
        json(res, 400, {
          error: 'malformed_submission',
          component_verified: 0,
          detail: e instanceof Error ? e.message : String(e),
        });
        return;
      }

      // THE REAL VERIFIER. Not a shape check: lib/ratchet/verify.ts, the same
      // function app/api/v2/witness calls, over the same preimage the component
      // MACed (leaf.ts#preimageOf is called by both sides for that reason).
      const r = verify.verifySubmission(
        { userId: TENANT, keyId: 'harness' },
        {
          componentId: body.component?.component_id ?? '',
          counter: body.component?.counter ?? -1,
          mac: body.mac ?? '',
          preimage,
          buildMeasurement: body.component?.build_measurement ?? null,
        },
      );
      if (!r.ok) {
        json(res, 403, { error: r.reason, component_verified: 0 });
        return;
      }
      accepted.push(body);
      json(res, 201, { ok: true, component_verified: 1 });
    });
  });
  await listen(api, API_PORT, LINK_IP);

  // ── probe 7's negative control, on its own subnet ──────────────────────
  const control = http.createServer((_q, s) => s.writeHead(204).end());
  await listen(control, CTL_PORT, CTL_IP);

  // ── probe 7's target, reachable ONLY under the p7 break ────────────────
  // Under every other profile nothing listens on EGRESS_IP and the tenant has
  // no route to it either, so the denial is the route rather than a closed port.
  let egress: http.Server | null = null;
  if (BREAK === 'p7-open-egress') {
    egress = http.createServer((_q, s) => s.writeHead(204).end());
    await listen(egress, EGRESS_PORT, EGRESS_IP);
  }

  // ── a second route to ComfyUI, for the p1 break ────────────────────────
  // A workload that binds 0.0.0.0, or a host-network sibling, or a second
  // interface. The declared upstream is the SAME address:port in every profile
  // so that only the topology differs between the conformant run and the break.
  let bypass: http.Server | null = null;
  if (BREAK === 'p1-second-route') {
    bypass = http.createServer((q, s) => {
      const up = http.request(
        { host: '127.0.0.1', port: comfy.port, path: q.url, method: q.method, headers: q.headers },
        (r) => {
          s.writeHead(r.statusCode ?? 502, r.headers);
          r.pipe(s);
        },
      );
      up.on('error', () => s.writeHead(502).end());
      q.pipe(up);
    });
    await listen(bypass, comfy.port, LINK_IP);
  }

  // ── the component ──────────────────────────────────────────────────────
  const { componentId, token } = prov.issueProvisioningToken({ tenantId: TENANT, label: 'probe-harness' });
  const measurement = bm.buildMeasurement();
  const redeemed = prov.redeemProvisioningToken({ token, tenantId: TENANT, buildMeasurement: measurement });
  if (!redeemed.ok) throw new Error('provisioning failed');
  const identity = identityMod.Identity.fromSealed(STATE_DIR, {
    component_id: componentId,
    chain_key_hex: redeemed.ikHex,
    counter: 0,
    build_measurement: measurement,
    attestation_status: null,
    provisioned_at: redeemed.provisionedAt,
  });

  // §10 C-8. The conformant profile declares the three directories with their
  // types; `p4-singular-volume` is the pre-C-8 configuration this WO replaced —
  // one root, no type, temp/ and input/ unwatched.
  const volumes: WatchedVolume[] =
    BREAK === 'p4-singular-volume'
      ? []
      : [
          { type: 'output', path: comfy.dirs.output },
          { type: 'temp', path: tempDir },
          { type: 'input', path: comfy.dirs.input },
        ];

  const cfg = {
    upstreamUrl: comfy.url,
    listenHost: LINK_IP,
    listenPort: GATE_PORT,
    ...(BREAK === 'p4-singular-volume'
      ? { outputVolume: comfy.dirs.output }
      : { watchedVolumes: volumes }),
    stateDir: STATE_DIR,
    apiBaseUrl: `http://${LINK_IP}:${API_PORT}`,
    apiKey: 'sk_harness_component',
    provisioningToken: null,
    baselineRef: 'ab'.repeat(32),
    outputVolumeDeclaredMime: 'image/png',
    settleMs: 40,
    correlationTtlMs: 60_000,
    heartbeatWindowSeconds: 900,
  };

  let component: Awaited<ReturnType<typeof comp.CaptureComponent.start>> | null = null;
  let passthrough: { close(): Promise<void> } | null = null;

  if (BREAK === 'p5-passthrough-ws') {
    // §2's first bullet, as shipped by somebody: "a network gate alone (today's
    // canvas proxy — HTTP only, WS handed to a pass-through sidecar)". The HTTP
    // gate and the watcher run as normal; only the WebSocket is unowned, so the
    // one path whose bytes never become a file is the one path with no leaf.
    const built = await startHttpOnlyGate({
      cfg,
      identity,
      correlator: corr.Correlator,
      QueueStore: queueMod.QueueStore,
      Submitter: submitterMod.Submitter,
      FsWatchSurface: fsw.FsWatchSurface,
      QuiescenceSource: fsw.QuiescenceSource,
      volumes,
      comfyUrl: comfy.url,
    });
    passthrough = built;
  } else {
    component = await comp.CaptureComponent.start(cfg, { identity, log: () => undefined });
  }

  // The deployment's own namespace inodes, written where the tenant can read
  // them. §10 C-11 asks a run to record which position it occupied; two inode
  // numbers a reader can compare is that recorded mechanically, and it does not
  // depend on the tenant being able to see /proc/<component pid> — which, under
  // PID isolation, it deliberately cannot.
  const namespaces: Record<string, string> = {};
  for (const ns of ['net', 'mnt', 'pid', 'user']) {
    try {
      namespaces[ns] = fs.readlinkSync(`/proc/self/ns/${ns}`);
    } catch {
      namespaces[ns] = 'unreadable';
    }
  }

  const descriptor = {
    profile: BREAK,
    deploymentNamespaces: namespaces,
    gateUrl: `http://${LINK_IP}:${GATE_PORT}`,
    apiBaseUrl: `http://${LINK_IP}:${API_PORT}`,
    // GIVEN BY THE OPERATOR, NEVER DISCOVERED. A probe that had to find the
    // upstream would be testing our port scanner.
    declaredUpstream: { host: LINK_IP, port: comfy.port },
    volumes: { output: comfy.dirs.output, temp: tempDir, input: comfy.dirs.input },
    stateDir: STATE_DIR,
    componentId,
    componentPid: process.pid,
    tenantId: TENANT,
    dbPath: process.env.SCRUPLE_DB_PATH,
    egressTarget: { host: EGRESS_IP, port: EGRESS_PORT },
    egressControl: { host: CTL_IP, port: CTL_PORT },
    drainWindowMs: 2500,
  };
  fs.writeFileSync(path.join(ROOT, 'deployment.json'), JSON.stringify(descriptor, null, 2));
  fs.writeFileSync(path.join(ROOT, 'READY'), 'ready\n');

  const shutdown = async () => {
    try {
      if (component) {
        component.server.closeAllConnections();
        await component.stop();
      }
      await passthrough?.close();
      await comfy.close();
      api.closeAllConnections();
      await new Promise<void>((r) => api.close(() => r()));
      control.closeAllConnections();
      await new Promise<void>((r) => control.close(() => r()));
      if (egress) {
        egress.closeAllConnections();
        await new Promise<void>((r) => egress!.close(() => r()));
      }
      if (bypass) {
        bypass.closeAllConnections();
        await new Promise<void>((r) => bypass!.close(() => r()));
      }
    } finally {
      // The gap ledger is P2's third conjunct and it lives in the database, so
      // it is written out before this process goes away.
      try {
        fs.writeFileSync(
          path.join(ROOT, 'gaps.json'),
          JSON.stringify(
            { componentId, gaps: verify.allGaps(componentId), open: verify.openGaps(componentId) },
            null,
            2,
          ),
        );
      } catch {
        /* the run's value does not hinge on the ledger dump */
      }
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
  setInterval(() => undefined, 1 << 30);
}

/** The p5 break: HTTP gate + watcher, and a WebSocket nobody owns. */
async function startHttpOnlyGate(a: {
  cfg: Record<string, unknown>;
  identity: import('../../services/scruple-capture/src/identity').Identity;
  correlator: typeof import('../../services/scruple-capture/src/correlation').Correlator;
  QueueStore: typeof import('../../services/scruple-capture/src/queue').QueueStore;
  Submitter: typeof import('../../services/scruple-capture/src/submitter').Submitter;
  FsWatchSurface: typeof import('../../services/scruple-capture/src/surfaces/fs-watch').FsWatchSurface;
  QuiescenceSource: typeof import('../../services/scruple-capture/src/surfaces/fs-watch').QuiescenceSource;
  volumes: WatchedVolume[];
  comfyUrl: string;
}): Promise<{ close(): Promise<void> }> {
  const { HttpGate } = await import('../../services/scruple-capture/src/surfaces/http-gate');
  const { WebSocketServer, WebSocket } = await import('ws');

  const correlator = new a.correlator(60_000);
  const queue = new a.QueueStore(path.join(STATE_DIR, 'queue.jsonl'));
  const submitter = new a.Submitter({
    identity: a.identity,
    queue,
    apiBaseUrl: a.cfg.apiBaseUrl as string,
    apiKey: 'sk_harness_component',
    baselineRef: 'ab'.repeat(32),
    log: () => undefined,
  });
  const gate = new HttpGate({
    upstreamUrl: a.comfyUrl,
    correlator,
    outputVolumeDeclaredMime: 'image/png',
    log: () => undefined,
  });
  const watch = new a.FsWatchSurface({
    watchedVolumes: a.volumes,
    correlator,
    outputVolumeDeclaredMime: 'image/png',
    sourceFactory: () => new a.QuiescenceSource(40),
    log: () => undefined,
  });

  const server = http.createServer((q, s) => {
    void gate.handle(q, s).catch(() => {
      if (!s.headersSent) s.writeHead(502);
      s.end();
    });
  });
  await gate.open({ sink: submitter, placement: 'sidecar-gate', config: {} });
  await watch.open({ sink: submitter, placement: 'sidecar-gate', config: {} });

  // THE HOLE, and it is the whole point of this profile: frames are relayed
  // byte for byte and nothing observes them.
  const wss = new WebSocketServer({ server });
  wss.on('connection', (down, req) => {
    const up = new WebSocket(`${a.comfyUrl.replace(/^http/, 'ws')}${req.url ?? '/ws'}`);
    const bytes = (d: unknown): Buffer =>
      Array.isArray(d) ? Buffer.concat(d as Buffer[]) : Buffer.from(d as Buffer);
    up.on('message', (d, bin: boolean) => down.send(bytes(d), { binary: bin }));
    down.on('message', (d, bin: boolean) => {
      if (up.readyState === WebSocket.OPEN) up.send(bytes(d), { binary: bin });
    });
    down.on('close', () => up.close());
    up.on('close', () => down.close());
    up.on('error', () => down.close());
  });

  await listen(server, Number(a.cfg.listenPort), a.cfg.listenHost as string);
  return {
    async close() {
      wss.close();
      await gate.close?.();
      await watch.close();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

function listen(s: http.Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    s.once('error', reject);
    s.listen(port, host, () => resolve());
  });
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

void main().catch((e) => {
  process.stderr.write(`deployment failed: ${e instanceof Error ? e.stack : String(e)}\n`);
  process.exit(1);
});
