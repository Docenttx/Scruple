// scruple-capture — the acceptance H-4 §2 asks for, against a stub ComfyUI.
//
// THE CLAIM UNDER TEST is §2's, and it is a coverage claim rather than a
// cryptographic one: ComfyUI produces retrievable output through TWO
// independent paths, and a gate on either alone is bypassable.
//
//   * an image retrieved over the WEBSOCKET produces a leaf — the path that
//     never becomes a file, which a filesystem watcher structurally cannot
//     see (script_examples/websockets_api_example_ws_images.py exists to use
//     it: "get images directly without them being saved to disk");
//   * a file written DIRECTLY INTO THE OUTPUT VOLUME produces a leaf — the
//     path a tenant with a shell takes, which a network gate cannot see;
//   * neither path can hand the tenant a retrievable artifact with no leaf;
//   * a submission failure enqueues and drains with its counter intact (§5);
//   * and the MAC the component produced verifies on the server that holds
//     the BDK (§4.2), over a preimage both sides derive with ONE function.
//
// TEST ISOLATION. `npm run test:v2` runs every test/v2 file CONCURRENTLY
// against one shared SCRUPLE_DB_PATH, which races as soon as two files
// migrate or write. This file therefore takes its own private database:
// SCRUPLE_DB_PATH is reassigned at module top level and everything that
// reaches lib/db/sqlite is imported DYNAMICALLY inside before(), because
// static imports hoist above the assignment. tsx compiles these to CJS, so a
// top-level await import is not available.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

if (!process.env.SCRUPLE_DB_PATH || !/tmp|test/i.test(process.env.SCRUPLE_DB_PATH)) {
  throw new Error('Refusing to run: set SCRUPLE_DB_PATH to a throwaway path. Use `npm run test:v2`.');
}
const OWN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'scruple-capture-'));
process.env.SCRUPLE_DB_PATH = path.join(OWN_DIR, 'capture.db');
process.env.SCRUPLE_BDK_HEX = 'c3'.repeat(32);
// The standing safety rule. Nothing here goes near the production witness
// server on 127.0.0.1:5799 — a previous session polluted its audit log.
process.env.WITNESS_SERVER_URL = 'http://127.0.0.1:1';

type Mod = {
  runMigrations: typeof import('../../lib/db/migrate').runMigrations;
  conn: typeof import('../../lib/db/sqlite').conn;
  issueProvisioningToken: typeof import('../../lib/ratchet/provisioning').issueProvisioningToken;
  redeemProvisioningToken: typeof import('../../lib/ratchet/provisioning').redeemProvisioningToken;
  verifySubmission: typeof import('../../lib/ratchet/verify').verifySubmission;
  Identity: typeof import('../../services/scruple-capture/src/identity').Identity;
  CaptureComponent: typeof import('../../services/scruple-capture/src/component').CaptureComponent;
  startStubComfyUI: typeof import('../../services/scruple-capture/test-support/stub-comfyui').startStubComfyUI;
  PNG_1x1: Buffer;
  preimageOf: typeof import('../../services/scruple-capture/src/leaf').preimageOf;
  decodeBinaryFrame: typeof import('../../services/scruple-capture/src/surfaces/ws-gate').decodeBinaryFrame;
  extractUploadedFile: typeof import('../../services/scruple-capture/src/surfaces/http-gate').extractUploadedFile;
  buildMeasurement: typeof import('../../services/scruple-capture/src/build-measurement').buildMeasurement;
  backoffSeconds: typeof import('../../services/scruple-capture/src/queue').backoffSeconds;
  BACKOFF_SCHEDULE: number[];
  WebSocket: typeof import('ws').WebSocket;
};

let M: Mod;
const TENANT = 'vendor-capture';
// §10 C-6 (WO-6): verifySubmission() takes an authenticated principal as
// its first argument so that no ratcheting is reachable without one. This
// file's components are all provisioned under TENANT.
const PRINCIPAL = { userId: TENANT, keyId: 'key-vendor-capture' };
const BASELINE = 'ab'.repeat(32);

type StubComfy = Awaited<ReturnType<Mod['startStubComfyUI']>>;
type Component = Awaited<ReturnType<Mod['CaptureComponent']['start']>>;

/** A stub scruple-web ingest. Records what arrived and can be told to fail,
 *  which is how §5's queue-and-drain becomes testable at all. */
interface Ingest {
  url: string;
  received: Array<Record<string, unknown>>;
  fail: boolean;
  close(): Promise<void>;
}

async function startIngest(): Promise<Ingest> {
  const state: Ingest = {
    url: '',
    received: [],
    fail: false,
    close: async () => undefined,
  };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (state.fail) {
        res.writeHead(503, { 'content-type': 'text/plain' });
        res.end('ingest down');
        return;
      }
      try {
        state.received.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        /* recorded as nothing; the assertion will notice */
      }
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  state.url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  state.close = () => new Promise<void>((r) => server.close(() => r()));
  return state;
}

/** Provision a real component against the real server-side ratchet, then hand
 *  the IK to the component the way §4.4 step 3 does. */
function provisionedIdentity(stateDir: string) {
  const { componentId, token } = M.issueProvisioningToken({ tenantId: TENANT, label: 'comfy-stub' });
  const measurement = M.buildMeasurement();
  const r = M.redeemProvisioningToken({ token, tenantId: TENANT, buildMeasurement: measurement });
  assert.ok(r.ok, 'provisioning must succeed');
  return M.Identity.fromSealed(stateDir, {
    component_id: componentId,
    chain_key_hex: r.ikHex, // K_0 = IK, n = 0
    counter: 0,
    build_measurement: measurement,
    attestation_status: null,
    provisioned_at: r.provisionedAt,
  });
}

interface Harness {
  comfy: StubComfy;
  ingest: Ingest;
  component: Component;
  stateDir: string;
  gate: string;
  stop(): Promise<void>;
}

async function harness(opts: { outputVolumeMime?: string | null } = {}): Promise<Harness> {
  const root = fs.mkdtempSync(path.join(OWN_DIR, 'run-'));
  const comfy = await M.startStubComfyUI(root);
  const ingest = await startIngest();
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });

  const component = await M.CaptureComponent.start(
    {
      upstreamUrl: comfy.url,
      listenHost: '127.0.0.1',
      listenPort: 0,
      outputVolume: comfy.dirs.output,
      stateDir,
      apiBaseUrl: ingest.url,
      apiKey: 'sk_test_capture',
      provisioningToken: null,
      baselineRef: BASELINE,
      outputVolumeDeclaredMime: opts.outputVolumeMime ?? null,
      settleMs: 40,
      correlationTtlMs: 60_000,
      heartbeatWindowSeconds: 900,
    },
    { identity: provisionedIdentity(stateDir), log: () => undefined },
  );

  return {
    comfy,
    ingest,
    component,
    stateDir,
    gate: `http://127.0.0.1:${component.port}`,
    async stop() {
      await component.stop();
      await comfy.close();
      await ingest.close();
    },
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitFor(fn: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await sleep(15);
  }
  throw new Error('timed out waiting for condition');
}

const sha256 = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

/** A graph with a float in it — cfg: 8.0 — because floats must never reach
 *  the MAC preimage (§10 C-1: Python repr and JS Number#toString disagree). */
const saveImageGraph = {
  '1': { class_type: 'KSampler', inputs: { cfg: 8.0, denoise: 1.0, seed: 42 } },
  '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'Acceptance', images: ['1', 0] } },
};

const wsOnlyGraph = {
  '1': { class_type: 'KSampler', inputs: { cfg: 7.5, seed: 7 } },
  '9': { class_type: 'SaveImageWebsocket', inputs: { images: ['1', 0] } },
};

before(async () => {
  const [migrate, sqlite, prov, verify, identity, component, stub, leaf, wsGate, httpGate, bm, queue, ws] =
    await Promise.all([
      import('../../lib/db/migrate'),
      import('../../lib/db/sqlite'),
      import('../../lib/ratchet/provisioning'),
      import('../../lib/ratchet/verify'),
      import('../../services/scruple-capture/src/identity'),
      import('../../services/scruple-capture/src/component'),
      import('../../services/scruple-capture/test-support/stub-comfyui'),
      import('../../services/scruple-capture/src/leaf'),
      import('../../services/scruple-capture/src/surfaces/ws-gate'),
      import('../../services/scruple-capture/src/surfaces/http-gate'),
      import('../../services/scruple-capture/src/build-measurement'),
      import('../../services/scruple-capture/src/queue'),
      import('ws'),
    ]);
  M = {
    runMigrations: migrate.runMigrations,
    conn: sqlite.conn,
    issueProvisioningToken: prov.issueProvisioningToken,
    redeemProvisioningToken: prov.redeemProvisioningToken,
    verifySubmission: verify.verifySubmission,
    Identity: identity.Identity,
    CaptureComponent: component.CaptureComponent,
    startStubComfyUI: stub.startStubComfyUI,
    PNG_1x1: stub.PNG_1x1,
    preimageOf: leaf.preimageOf,
    decodeBinaryFrame: wsGate.decodeBinaryFrame,
    extractUploadedFile: httpGate.extractUploadedFile,
    buildMeasurement: bm.buildMeasurement,
    backoffSeconds: queue.backoffSeconds,
    BACKOFF_SCHEDULE: queue.BACKOFF_SCHEDULE,
    WebSocket: ws.WebSocket,
  };
  M.runMigrations(false);
  M.conn().prepare(`INSERT INTO users (id, email) VALUES (?, 'capture@example.com')`).run(TENANT);
});

after(() => {
  try {
    fs.rmSync(OWN_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// ---------------------------------------------------------------------------
describe('§2 path 2 — the WebSocket, which never becomes a file', () => {
  test('an image retrieved over WS produces a leaf, and the tenant gets the same bytes', async () => {
    const h = await harness();
    try {
      const client = new M.WebSocket(`ws://127.0.0.1:${h.component.port}/ws?clientId=acceptance`);
      const binary: Buffer[] = [];
      client.on('message', (data, isBinary) => {
        if (isBinary) binary.push(data as Buffer);
      });
      await new Promise<void>((r) => client.on('open', () => r()));

      const res = await fetch(`${h.gate}/prompt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(wsOnlyGraph),
      });
      assert.equal(res.status, 200);

      await waitFor(() => binary.length > 0);
      await waitFor(() => h.component.submitter.emitted.length > 0);

      // The tenant received the artifact...
      const decoded = M.decodeBinaryFrame(binary[0])!;
      assert.equal(decoded.payload.toString('base64'), M.PNG_1x1.toString('base64'));

      // ...and a leaf covers exactly those bytes.
      const ev = h.component.submitter.emitted.find((e) => e.contentHash === sha256(M.PNG_1x1));
      assert.ok(ev, 'no leaf for the bytes the tenant received over WS');

      const sub = h.ingest.received.find((s) => s.content_hash === sha256(M.PNG_1x1))!;
      assert.ok(sub, 'the leaf was never submitted');
      const cap = sub.capture as Record<string, unknown>;
      assert.equal(cap.surface, 'network-gate');
      assert.equal(cap.fidelity, 'as-delivered');
      // MIME came from the frame's own image_type field, not from a sniff.
      assert.equal(sub.mime, 'image/png');
      assert.equal(cap.mime_source, 'frame');
      // Correlated to the prompt by ComfyUI's own `executing` message.
      assert.equal(cap.correlation_method, 'ws-executing');
      assert.equal(cap.correlation_id, h.comfy.prompts[0].promptId);

      client.close();
    } finally {
      await h.stop();
    }
  });

  test('the framing is decoded from server.py, not guessed', () => {
    // PREVIEW_IMAGE: >I event(1), >I image_type(2 = PNG), then the image.
    const png = Buffer.concat([
      u32(1),
      u32(2),
      Buffer.from('IMAGEBYTES'),
    ]);
    const d1 = M.decodeBinaryFrame(png)!;
    assert.equal(d1.payload.toString(), 'IMAGEBYTES');
    assert.equal(d1.mime?.mime, 'image/png');
    assert.equal(d1.mime?.source, 'frame');

    // PREVIEW_IMAGE_WITH_METADATA: >I event(4), >I metalen, metadata, image.
    // ComfyUI writes metadata.image_type as a MIME string (server.py:1170).
    const meta = Buffer.from(JSON.stringify({ image_type: 'image/jpeg' }), 'utf8');
    const withMeta = Buffer.concat([u32(4), u32(meta.length), meta, Buffer.from('JPEGBYTES')]);
    const d2 = M.decodeBinaryFrame(withMeta)!;
    assert.equal(d2.payload.toString(), 'JPEGBYTES');
    assert.equal(d2.mime?.mime, 'image/jpeg');

    // TEXT frames carry no artifact and must not spend a counter.
    assert.equal(M.decodeBinaryFrame(Buffer.concat([u32(3), u32(0)])), null);
  });
});

// ---------------------------------------------------------------------------
describe('§2 path 1 — the output volume, which a network gate cannot see', () => {
  test('a file written directly into the volume produces a leaf', async () => {
    const h = await harness({ outputVolumeMime: 'image/png' });
    try {
      // No prompt, no /view, no WS. This is the tenant with a shell, which is
      // H-4 §7 probe 4 and the case a network gate misses entirely.
      const bytes = Buffer.from('a tenant wrote this by hand');
      fs.writeFileSync(path.join(h.comfy.dirs.output, 'by-hand.bin'), bytes);

      await waitFor(() => h.ingest.received.some((s) => s.content_hash === sha256(bytes)));
      const sub = h.ingest.received.find((s) => s.content_hash === sha256(bytes))!;
      assert.ok(sub);
      const cap = sub.capture as Record<string, unknown>;
      assert.equal(cap.surface, 'filesystem-watch');
      // as-WRITTEN, not as-delivered: these are the bytes the host wrote, and
      // hashing on close is tamper-EVIDENT only (§6).
      assert.equal(cap.fidelity, 'as-written');
      assert.equal(cap.correlation_method, 'none');
      // The vendor declared what their own output volume holds. An
      // accountable party's declaration, recorded as such.
      assert.equal(sub.mime, 'image/png');
      assert.equal(cap.mime_source, 'vendor-config');
    } finally {
      await h.stop();
    }
  });

  test('a SaveImage run is correlated to its prompt by filename prefix', async () => {
    const h = await harness();
    try {
      await fetch(`${h.gate}/prompt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(saveImageGraph),
      });
      await waitFor(() => h.ingest.received.length > 0);
      const sub = h.ingest.received[0];
      const cap = sub.capture as Record<string, unknown>;
      assert.equal(cap.surface, 'filesystem-watch');
      // get_save_image_path writes `{prefix}_{counter:05}_.png`, so the
      // basename is a real link and not a timing guess.
      assert.equal(cap.correlation_method, 'filename-prefix');
      assert.equal(cap.correlation_id, h.comfy.prompts[0].promptId);
      // Declared by the writing node's class. Not by the .png extension.
      assert.equal(sub.mime, 'image/png');
      assert.equal(cap.mime_source, 'node');
      assert.ok(cap.workflow_hash, 'the graph the gate teed is folded in');
      assert.equal(cap.close_detection, 'fs-watch-quiescence');
    } finally {
      await h.stop();
    }
  });

  test('undeclared MIME is left undeclared, never defaulted', async () => {
    const h = await harness({ outputVolumeMime: null });
    try {
      const bytes = Buffer.from('nobody was entitled to type these bytes');
      fs.writeFileSync(path.join(h.comfy.dirs.output, 'orphan.dat'), bytes);
      await waitFor(() => h.ingest.received.some((s) => s.content_hash === sha256(bytes)));

      const ev = h.component.submitter.emitted.find((e) => e.contentHash === sha256(bytes))!;
      assert.equal(ev.mimeDeclared, false);
      const sub = h.ingest.received.find((s) => s.content_hash === sha256(bytes))!;
      // The key is ABSENT — no 'application/octet-stream', no extension
      // lookup. CANON_SKELETON §5 property 1: emit without a MIME and let the
      // SDK refuse, rather than supply a placeholder.
      assert.equal('mime' in sub, false);
      // The counter was still spent, because §7 probe 4 asks for a LEAF and
      // an undeclared type is not a reason to have witnessed nothing.
      assert.equal(typeof ev.counter, 'number');
    } finally {
      await h.stop();
    }
  });
});

// ---------------------------------------------------------------------------
describe('neither path delivers a retrievable artifact with no leaf', () => {
  test('GET /view hands over bytes only after the counter is spent', async () => {
    const h = await harness();
    try {
      await fetch(`${h.gate}/prompt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(saveImageGraph),
      });
      await waitFor(() => fs.existsSync(path.join(h.comfy.dirs.output, 'Acceptance_00001_.png')));

      const before = h.component.submitter.emitted.length;
      const res = await fetch(`${h.gate}/view?filename=Acceptance_00001_.png&type=output`);
      const body = Buffer.from(await res.arrayBuffer());

      assert.equal(res.status, 200);
      assert.equal(body.toString('base64'), M.PNG_1x1.toString('base64'));
      // The gate BUFFERS and captures before it writes a byte, so by the time
      // the response is complete the leaf already exists. Streaming and
      // hashing in flight would deliver artifact and leaf concurrently, and a
      // crash between them leaves an artifact with no leaf.
      const gateLeaf = h.component.submitter.emitted
        .slice(before)
        .find((e) => e.contentHash === sha256(M.PNG_1x1));
      assert.ok(gateLeaf, 'GET /view delivered bytes with no leaf of its own');
    } finally {
      await h.stop();
    }
  });

  test('a gate that cannot MAC refuses to deliver the bytes', async () => {
    const h = await harness();
    try {
      await fetch(`${h.gate}/prompt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(saveImageGraph),
      });
      await waitFor(() => fs.existsSync(path.join(h.comfy.dirs.output, 'Acceptance_00001_.png')));

      // Destroy the ratchet: the counter can no longer be spent. This is the
      // only failure the component is allowed to break a tenant workflow for,
      // and it is the one where not breaking it means shipping an unwitnessed
      // artifact.
      h.component.identity.destroy();

      const res = await fetch(`${h.gate}/view?filename=Acceptance_00001_.png&type=output`);
      assert.equal(res.status, 502);
      const body = Buffer.from(await res.arrayBuffer());
      assert.notEqual(body.toString('base64'), M.PNG_1x1.toString('base64'));
      // The upstream URL is never in what the tenant sees.
      assert.equal(body.toString('utf8').includes('127.0.0.1:' + h.comfy.port), false);
    } finally {
      await h.comfy.close();
      await h.ingest.close();
      await new Promise<void>((r) => h.component.server.close(() => r()));
    }
  });

  test('the third byte path — GET /userdata — is captured too, though §3 does not list it', async () => {
    const h = await harness({ outputVolumeMime: null });
    try {
      // app/user_manager.py:342 writes arbitrary bytes into the user
      // directory and :334 reads them back with web.FileResponse. It touches
      // neither `output/` nor /view, so it is a complete store-and-retrieve
      // path that H-4 §3's two-row table does not cover. The gate captures it
      // because BYTE_EGRESS is broader than the spec's enumeration.
      const bytes = Buffer.from('exfiltrated through userdata');
      fs.writeFileSync(path.join(h.comfy.dirs.user, 'stash.bin'), bytes);

      const res = await fetch(`${h.gate}/userdata/stash.bin`);
      assert.equal(res.status, 200);
      const got = Buffer.from(await res.arrayBuffer());
      assert.equal(got.toString(), bytes.toString());

      const ev = h.component.submitter.emitted.find((e) => e.contentHash === sha256(bytes));
      assert.ok(ev, 'GET /userdata delivered bytes with no leaf');
    } finally {
      await h.stop();
    }
  });

  test('frontend static assets are logged as unenumerated, not captured', async () => {
    const h = await harness();
    try {
      const res = await fetch(`${h.gate}/logo.png`);
      assert.equal(res.status, 200);
      // ComfyUI serves its own frontend from web.static('/', web_root)
      // (server.py:1104). Capturing every UI icon would burn a ratchet
      // counter each; the tripwire exists so a NEW artifact route shows up as
      // a log line rather than as a silence.
      assert.equal(h.component.submitter.emitted.length, 0);
      assert.ok(h.component.httpGate.unenumeratedEgress.some((u) => u.path === '/logo.png'));
    } finally {
      await h.stop();
    }
  });
});

// ---------------------------------------------------------------------------
describe('§5 — derive, MAC, ratchet, then enqueue', () => {
  test('a submission failure enqueues and drains, preserving its counter', async () => {
    const h = await harness({ outputVolumeMime: 'image/png' });
    try {
      h.ingest.fail = true;

      const bytes = Buffer.from('captured while the ingest was down');
      fs.writeFileSync(path.join(h.comfy.dirs.output, 'offline.png'), bytes);
      await waitFor(() => h.component.submitter.emitted.some((e) => e.contentHash === sha256(bytes)));
      // ---------------------------------------------------------------------
      // THE BARRIER, AND WHY IT IS NOT DECORATION.
      //
      // `emitted` is pushed at submitter.ts step 5 — AFTER the MAC and the
      // enqueue, but BEFORE step 6's best-effort drain. Waiting on `emitted`
      // therefore lands inside a window in which the component's OWN failed
      // send may or may not have been recorded yet, and the two outcomes are
      // not equivalent: a recorded failure sets attempts=1 and
      // last_attempt_at=now, which makes the entry not due for
      // BACKOFF_SCHEDULE[0] = 5s, so a bare drain() below returns sent=0.
      //
      // That is the flake — a race between the component's internal drain and
      // the test's, not a watcher-timing problem. The watcher is the thing
      // that HOLDS the promise: FsWatchSurface.open() keeps every in-flight
      // onCloseWrite (which awaits sink.emit(), which awaits capture(), which
      // awaits the internal drain) in `inflight`, and settled() is the
      // deterministic point at which all of it has finished. Sleeping would
      // only make the window wider, not closed.
      await h.component.fsWatch.settled();
      // ---------------------------------------------------------------------

      const ev = h.component.submitter.emitted.find((e) => e.contentHash === sha256(bytes))!;
      assert.equal(h.ingest.received.length, 0, 'nothing should have been accepted');

      // The counter was spent when the MAC was computed, NOT when the
      // submission succeeded. The event is on disk, with its number.
      const queued = h.component.queue.loadAll();
      assert.equal(queued.length, 1);
      assert.equal(queued[0].counter, ev.counter);
      assert.equal((queued[0].body as { mac?: string }).mac, ev.mac);
      // Past the barrier this is now an assertion rather than a coin toss:
      // the component tried, was refused, and wrote the refusal down. An
      // enqueue with attempts=0 here would mean the failure path never ran.
      assert.equal(queued[0].attempts, 1);
      assert.ok(queued[0].last_attempt_at !== null);
      // And the ratchet moved on regardless: the next event gets the next
      // number, so there is no head-of-line blocking (§10 C-3).
      assert.equal(h.component.identity.counter, ev.counter + 1);

      // Recovery. The entry is genuinely not due for backoffSeconds(1) after
      // that recorded attempt, so the drain is asked for a clock past it
      // rather than the suite being asked to wait five real seconds. The
      // backoff is behaviour under test, not an obstacle to it: draining at
      // `now` must still return nothing.
      h.ingest.fail = false;
      const tooSoon = await h.component.submitter.drain();
      assert.equal(tooSoon.sent, 0, 'backoff must hold the entry, not release it');
      assert.equal(h.component.queue.count(), 1);

      const drained = await h.component.submitter.drain(Date.now() + M.backoffSeconds(1) * 1000);
      assert.equal(drained.sent, 1);
      assert.equal(h.component.queue.count(), 0);

      const sub = h.ingest.received[0];
      assert.equal((sub.component as { counter: number }).counter, ev.counter);
      assert.equal(sub.mac, ev.mac);
    } finally {
      await h.stop();
    }
  });

  test('backoff is the same schedule the Python queue uses, and never gives up', () => {
    assert.deepEqual(M.BACKOFF_SCHEDULE, [5, 30, 120, 600, 1800]);
    assert.equal(M.backoffSeconds(0), 0);
    assert.equal(M.backoffSeconds(1), 5);
    assert.equal(M.backoffSeconds(5), 1800);
    // Saturates rather than expiring: dropping a captured event to tidy the
    // queue is data loss dressed as cleanup (§10 C-3).
    assert.equal(M.backoffSeconds(99), 1800);
  });

  test('counters are unique and strictly increasing across BOTH surfaces', async () => {
    const h = await harness({ outputVolumeMime: 'image/png' });
    try {
      const client = new M.WebSocket(`ws://127.0.0.1:${h.component.port}/ws?clientId=mix`);
      await new Promise<void>((r) => client.on('open', () => r()));

      await fetch(`${h.gate}/prompt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(wsOnlyGraph),
      });
      await fetch(`${h.gate}/prompt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(saveImageGraph),
      });
      await waitFor(() => h.component.submitter.emitted.length >= 2);
      await sleep(150);

      const counters = h.component.submitter.emitted.map((e) => e.counter);
      assert.deepEqual(counters, [...counters].sort((a, b) => a - b));
      assert.equal(new Set(counters).size, counters.length);
      assert.equal(counters[0], 0);
      // Both surfaces are represented — the point of owning both.
      const surfaces = new Set(
        h.ingest.received.map((s) => (s.capture as { surface: string }).surface),
      );
      assert.ok(surfaces.has('network-gate'));
      assert.ok(surfaces.has('filesystem-watch'));
      client.close();
    } finally {
      await h.stop();
    }
  });
});

// ---------------------------------------------------------------------------
describe('§4.2 — the MAC verifies on the server that holds the BDK', () => {
  test('every submission verifies, and one flipped byte does not', async () => {
    const h = await harness({ outputVolumeMime: 'image/png' });
    try {
      const bytes = Buffer.from('round trip');
      fs.writeFileSync(path.join(h.comfy.dirs.output, 'round-trip.png'), bytes);
      await waitFor(() => h.ingest.received.length > 0);

      const sub = h.ingest.received[0] as unknown as import('../../services/scruple-capture/src/leaf').Submission;
      const componentId = sub.component.component_id;

      // ONE function builds the preimage, and the server calls the same one.
      // §4.1 wrote `HMAC(M_n, canonical_preimage)` and never said what the
      // preimage contained; a component that MACs fields the server cannot
      // reconstruct has a MAC that verifies nothing about the leaf.
      const ok = M.verifySubmission(PRINCIPAL, {
        componentId,
        counter: sub.component.counter,
        mac: sub.mac!,
        preimage: M.preimageOf(sub),
        buildMeasurement: sub.component.build_measurement,
      });
      assert.equal(ok.ok, true, JSON.stringify(ok));
      if (ok.ok) {
        assert.equal(ok.gap, 0);
        assert.equal(ok.build_changed, false);
      }

      // Tamper with the content hash the leaf commits to. Same MAC, different
      // preimage, and the server must not accept it.
      const tampered = { ...sub, content_hash: 'ff'.repeat(32), component: { ...sub.component, counter: 1 } };
      const bad = M.verifySubmission(PRINCIPAL, {
        componentId,
        counter: 1,
        mac: sub.mac!,
        preimage: M.preimageOf(tampered),
      });
      assert.equal(bad.ok, false);
      if (!bad.ok) assert.equal(bad.reason, 'bad_mac');
    } finally {
      await h.stop();
    }
  });

  test('the graph is carried but its floats never reach the preimage', async () => {
    const h = await harness();
    try {
      await fetch(`${h.gate}/prompt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(saveImageGraph),
      });
      await waitFor(() => h.ingest.received.length > 0);
      const sub = h.ingest.received[0] as unknown as import('../../services/scruple-capture/src/leaf').Submission;

      // The route recomputes workflow_hash from `graph` with
      // lib/leaf/hashes.ts, so a verifier can check ours against theirs.
      assert.ok(sub.graph, 'the teed graph rides along');
      assert.equal((sub.graph as Record<string, { inputs?: { cfg?: number } }>)['1'].inputs?.cfg, 8);

      // But only its HASH is MACed. canonicalPreimage refuses floats outright
      // (§10 C-1) — Python repr and JS Number#toString disagree on doubles,
      // and a format-dependent MAC fails unreproducibly and only sometimes.
      const fields = M.preimageOf(sub);
      for (const [k, v] of Object.entries(fields)) {
        if (typeof v === 'number') {
          assert.ok(Number.isInteger(v), `preimage field ${k} is not an integer`);
        }
      }
      assert.equal(typeof fields.workflow_hash, 'string');
    } finally {
      await h.stop();
    }
  });
});

// ---------------------------------------------------------------------------
describe('the gate tees inputs, and the upstream never leaks', () => {
  test('POST /upload/image is teed, so input_hash is real rather than assumed', async () => {
    const h = await harness();
    try {
      const boundary = '----scruple';
      const file = Buffer.from('input image bytes');
      const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="in.png"\r\nContent-Type: image/png\r\n\r\n`),
        file,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      const up = await fetch(`${h.gate}/upload/image`, {
        method: 'POST',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        body,
      });
      assert.equal(up.status, 200);

      await fetch(`${h.gate}/prompt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          '1': { class_type: 'LoadImage', inputs: { image: 'uploaded.png' } },
          '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'Acceptance' } },
        }),
      });
      await waitFor(() => h.ingest.received.length > 0);
      const sub = h.ingest.received[0];
      // input_hash is present because the gate HELD the input bytes. Had it
      // not, it would be null rather than the hash of `[]` — which would
      // assert "we enumerated the inputs and there were none".
      assert.equal(typeof sub.input_hash, 'string');
    } finally {
      await h.stop();
    }
  });

  test('a graph referencing an input the gate never saw yields NO input_hash', async () => {
    const h = await harness();
    try {
      await fetch(`${h.gate}/prompt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          '1': { class_type: 'LoadImage', inputs: { image: 'placed-by-hand.png' } },
          '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'Acceptance' } },
        }),
      });
      await waitFor(() => h.ingest.received.length > 0);
      const sub = h.ingest.received[0];
      assert.equal('input_hash' in sub, false);
    } finally {
      await h.stop();
    }
  });

  test('the multipart extractor takes the file part and nothing else', () => {
    const boundary = 'B';
    const file = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="type"\r\n\r\ninput\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="x.png"\r\n\r\n`),
      file,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const got = M.extractUploadedFile(`multipart/form-data; boundary=${boundary}`, body);
    assert.equal(got?.toString('hex'), file.toString('hex'));
    // Not multipart at all: null, so input_hash goes null rather than
    // committing to bytes we did not hold.
    assert.equal(M.extractUploadedFile('application/json', body), null);
  });
});

// ---------------------------------------------------------------------------
describe('§4.3 — what the build measurement is worth today', () => {
  test('it is shaped for the provisioning route and rides on every event', async () => {
    const h = await harness({ outputVolumeMime: 'image/png' });
    try {
      assert.match(M.buildMeasurement(), /^sha256:[0-9a-f]{64}$/);
      fs.writeFileSync(path.join(h.comfy.dirs.output, 'measured.png'), Buffer.from('m'));
      await waitFor(() => h.ingest.received.length > 0);
      const sub = h.ingest.received[0];
      // §10 C-4: the published-builds registry DOES NOT EXIST, so the server
      // records this per event and flags build_changed against the value the
      // component provisioned with. Drift detection, not provenance — and
      // §4.3's "the first time P1 is checkable at ingest" cannot be claimed
      // in customer material until the registry lands.
      assert.equal((sub.component as { build_measurement: string }).build_measurement, M.buildMeasurement());
    } finally {
      await h.stop();
    }
  });

  test('the component reports passthrough, because a 0600 file is an assertion', async () => {
    const h = await harness();
    try {
      // No attestable compute, so the IK↔build binding is an assertion and
      // the leaf says so (§4.3). `verified` must be earned, never declared.
      assert.equal(h.component.assurance.leaf, 'passthrough');
      assert.equal(h.component.assurance.placement, 'sidecar-gate');
      assert.equal(h.component.assurance.canClaim, true);
      // P1 is conditional at this placement and the conditions are H-4 §7's
      // probes — checkable, never provable from inside (§6).
      assert.equal(h.component.assurance.p1, 'conditional');
      assert.ok(h.component.assurance.conditions.some((c) => c.includes('probe 4')));
      assert.ok(h.component.assurance.conditions.some((c) => c.includes('probe 5')));
    } finally {
      await h.stop();
    }
  });

  test('the sealed identity is 0600 and a lost seal is a NEW component, not a guessed counter', async () => {
    const h = await harness();
    try {
      const seal = path.join(h.stateDir, 'identity.json');
      assert.equal(fs.statSync(seal).mode & 0o777, 0o600);
      // §4.4: "If the seal cannot be restored on restart, the component
      // re-provisions as a NEW component_id starting at n=0. Never reuse a
      // counter under an existing id."
      fs.writeFileSync(seal, 'not json');
      const reopened = await M.Identity.open(
        {
          ...h.component.cfg,
          provisioningToken: null,
        },
        (async () => {
          throw new Error('should not be called');
        }) as unknown as typeof fetch,
      ).then(
        () => null,
        (e: Error) => e,
      );
      assert.ok(reopened instanceof Error);
      assert.match(reopened.message, /provisioning[ _]token/i);
    } finally {
      await h.stop();
    }
  });
});

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n, 0);
  return b;
}
