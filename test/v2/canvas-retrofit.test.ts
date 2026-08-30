// WO-10 — canvas, re-platformed onto the capture component.
//
// WHAT IS UNDER TEST, and it is deliberately not "does canvas still work":
//
//   1. THE FIVE BEHAVIOURS THAT MAY NOT BE DROPPED. WO-7's report names
//      them: per-session routing, the X-Scruple-Shared-Secret upstream
//      header, NextAuth ownership, the `?t=` legacy-token strip, and the
//      30s bidirectional keepalive. Each has a test named after it. The
//      keepalive is proved by starting the real sidecar against a real
//      upstream and counting pings ON BOTH LEGS, because that is the one
//      whose absence looks like a provenance bug rather than a timeout.
//
//   2. THE §7 SILENT DROP IS GONE. An ingest failure must produce a
//      durable, retryable, visible record — and must NOT produce silence.
//      A test asserts the row, the header, the retained bytes and the
//      recovery. A second test asserts the ONE case that fails closed.
//
//   3. THE GATE IS NOT NARROWER THAN THE COMPONENT'S. C-7's four extra
//      byte-egress routes are gated, and the route table is compared
//      BYTE-FOR-BYTE against the component's own BYTE_EGRESS by reading it
//      out of http-gate.ts's source — so the copy in lib/canvas/egress.ts
//      cannot drift silently.
//
//   4. THE WS LEG IS A GATE. A ComfyUI binary frame decoded with the
//      COMPONENT's decoder, correlated against the executing prompt, and
//      witnessed when the graph declares a WebSocket writer.
//
//   5. THE BASELINE EXISTS AND BITES. A covered file changing without the
//      manifest changing fails a test.
//
// TEST ISOLATION. `npm run test:v2` runs every test/v2 file CONCURRENTLY
// against one shared SCRUPLE_DB_PATH, which races as soon as two files
// migrate or write. This file therefore takes its own private database:
// SCRUPLE_DB_PATH is reassigned at module top level and everything that
// reaches lib/db/sqlite is imported DYNAMICALLY inside before(), because
// static imports hoist above the assignment.

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
const OWN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-retrofit-'));
process.env.SCRUPLE_DB_PATH = path.join(OWN_DIR, 'canvas.db');
// The standing safety rule. Nothing here goes near the production witness
// server on 127.0.0.1:5799 — a previous session polluted its audit log.
process.env.WITNESS_SERVER_URL = 'http://127.0.0.1:1';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const WS_PROXY_PATH = path.join(REPO_ROOT, 'scripts', 'canvas-ws-proxy.mjs');

type Mod = {
  runMigrations: typeof import('../../lib/db/migrate').runMigrations;
  conn: typeof import('../../lib/db/sqlite').conn;
  gate: typeof import('../../lib/canvas/gate');
  egress: typeof import('../../lib/canvas/egress');
  correlate: typeof import('../../lib/canvas/correlate');
  witness: typeof import('../../lib/canvas/witness');
  wsCapture: typeof import('../../lib/canvas/ws-capture');
  baseline: typeof import('../../lib/canvas/baseline');
  wsProxy: { startWsProxy: (o?: Record<string, unknown>) => {
    httpServer: http.Server;
    listening: Promise<number>;
    close(): Promise<void>;
  } };
  WebSocket: typeof import('ws').WebSocket;
  WebSocketServer: typeof import('ws').WebSocketServer;
};

let M: Mod;

const USER = 'u_canvas';
const OTHER_USER = 'u_someone_else';
let PROJECT_ID = 0;

/** An ingestIteration stand-in. The real one uploads to a storage provider
 *  and calls the witness server; neither belongs in a unit test, and the
 *  point under test is what canvas does with the RESULT either way. */
let RUN_SEQ = 0;
function fakeIngest(opts: { fail?: Error } = {}) {
  const calls: Array<Record<string, unknown>> = [];
  const fn = (async (p: Record<string, unknown>) => {
    calls.push(p);
    if (opts.fail) throw opts.fail;
    const n = ++RUN_SEQ;
    const id = 1000 + n;
    M.conn()
      .prepare(
        `INSERT INTO iterations (project_id, run_sequence, timestamp, leaf_hash, output_hash)
         VALUES (?, ?, datetime('now'), ?, ?)`,
      )
      .run(
        p.projectId,
        n,
        `leaf${n}`.padEnd(64, '0'),
        crypto.createHash('sha256').update(p.imageBytes as Buffer).digest('hex'),
      );
    return {
      iteration: { id },
      leafHash: `leaf${n}`.padEnd(64, '0'),
      runSequence: n,
      storagePointer: null,
      inputArtifacts: [],
      witnessed: false,
      leafScheme: 'v1',
    };
  }) as never;
  return { fn, calls };
}

function seedSession(id: string, modalUrl: string, userId = USER): void {
  M.conn()
    .prepare(
      `INSERT OR REPLACE INTO canvas_sessions
         (id, user_id, machine_id, modal_url, signed_token, status, expires_at)
       VALUES (?, ?, 't4-free', ?, 'not-a-credential', 'active', datetime('now', '+1 hour'))`,
    )
    .run(id, userId, modalUrl);
}

/** A ComfyUI API-format graph. `filename_prefix` is what makes
 *  filename-prefix attribution — a real link — possible at all. */
function graph(classType: string, prefix = 'ScrupleTest'): Record<string, unknown> {
  return {
    '3': { class_type: 'KSampler', inputs: { seed: 1 } },
    '9': { class_type: classType, inputs: { filename_prefix: prefix, images: ['3', 0] } },
  };
}

before(async () => {
  M = {
    runMigrations: (await import('../../lib/db/migrate')).runMigrations,
    conn: (await import('../../lib/db/sqlite')).conn,
    gate: await import('../../lib/canvas/gate'),
    egress: await import('../../lib/canvas/egress'),
    correlate: await import('../../lib/canvas/correlate'),
    witness: await import('../../lib/canvas/witness'),
    wsCapture: await import('../../lib/canvas/ws-capture'),
    baseline: await import('../../lib/canvas/baseline'),
    // Non-literal specifier: the sidecar is .mjs and tsconfig has
    // allowJs:false, so a literal import would not typecheck. The runtime
    // module is the one production runs, which is the whole point of
    // testing it rather than a copy.
    wsProxy: await import(WS_PROXY_PATH),
    WebSocket: (await import('ws')).WebSocket,
    WebSocketServer: (await import('ws')).WebSocketServer,
  } as Mod;

  M.runMigrations();
  const db = M.conn();
  db.prepare(`INSERT OR IGNORE INTO users (id, email) VALUES (?, ?)`).run(USER, 'canvas@test');
  db.prepare(`INSERT OR IGNORE INTO users (id, email) VALUES (?, ?)`).run(OTHER_USER, 'other@test');
  const proj = db
    .prepare(
      `INSERT INTO projects (user_id, name, is_active, created_at)
       VALUES (?, 'canvas', 1, datetime('now'))`,
    )
    .run(USER);
  PROJECT_ID = Number(proj.lastInsertRowid);
});

after(() => {
  try {
    fs.rmSync(OWN_DIR, { recursive: true, force: true });
  } catch {
    /* the tmpdir outlives the assertion either way */
  }
});

// ═══════════════════════════════════════════════════════════════════════
// 1. The five behaviours that may not be dropped
// ═══════════════════════════════════════════════════════════════════════

describe('the five preserved behaviours (WO-7 report)', () => {
  test('(1) per-session routing — the upstream comes from THIS session row', () => {
    seedSession('cs_route_a', 'https://alpha--comfy.modal.run/');
    seedSession('cs_route_b', 'https://beta--comfy.modal.run/');

    const a = M.gate.getSessionRow('cs_route_a');
    const b = M.gate.getSessionRow('cs_route_b');
    assert.ok(a && b);
    assert.notEqual(a.modal_url, b.modal_url);

    assert.equal(
      M.gate.buildUpstreamUrl(a.modal_url, 'api/view', new URLSearchParams('filename=x.png')),
      'https://alpha--comfy.modal.run/api/view?filename=x.png',
    );
    assert.equal(
      M.gate.buildUpstreamUrl(b.modal_url, 'api/view', new URLSearchParams('filename=x.png')),
      'https://beta--comfy.modal.run/api/view?filename=x.png',
    );

    // The component is single-upstream by construction — its config module
    // resolves SCRUPLE_CAPTURE_UPSTREAM_URL once and refuses to start
    // without it. This is the behaviour canvas has that it does not.
    const expired = M.conn()
      .prepare(
        `INSERT OR REPLACE INTO canvas_sessions
           (id, user_id, machine_id, modal_url, signed_token, status, expires_at)
         VALUES ('cs_expired', ?, 't4-free', 'https://x.modal.run/', 'x', 'active',
                 datetime('now', '-1 hour'))`,
      )
      .run(USER);
    assert.ok(expired.changes === 1);
    assert.equal(M.gate.getSessionRow('cs_expired'), null, 'an expired session routes nowhere');
  });

  test('(2) the X-Scruple-Shared-Secret upstream header — and what it strips', () => {
    const incoming = new Headers({
      host: 'canvas.scruple.ai',
      cookie: 'next-auth.session-token=abc',
      authorization: 'Bearer scruple-web-token',
      'x-scruple-shared-secret': 'SMUGGLED-BY-THE-BROWSER',
      'accept-encoding': 'gzip, br',
      'x-keep-me': 'yes',
    });
    const out = M.gate.upstreamHeaders(incoming, 'THE-REAL-SECRET');

    assert.equal(out.get('x-scruple-shared-secret'), 'THE-REAL-SECRET');
    assert.equal(out.get('host'), null, 'host must not cross to Modal');
    assert.equal(out.get('cookie'), null, "scruple-web's own cookies must not cross to Modal");
    assert.equal(out.get('authorization'), null);
    assert.equal(out.get('accept-encoding'), 'identity', 'as-delivered fidelity needs unencoded bytes');
    assert.equal(out.get('x-keep-me'), 'yes');

    // P3: the browser is upstream of this function, so a request arriving
    // with the header already set must not be able to choose its value.
    const noSecret = M.gate.upstreamHeaders(incoming, undefined);
    assert.equal(noSecret.get('x-scruple-shared-secret'), null);
  });

  test('(3) NextAuth session ownership — P4', () => {
    seedSession('cs_owned', 'https://x.modal.run/', USER);
    const row = M.gate.getSessionRow('cs_owned');

    assert.equal(M.gate.authorizeSession(row, USER), 'ok');
    assert.equal(M.gate.authorizeSession(row, OTHER_USER), 'forbidden');
    assert.equal(M.gate.authorizeSession(row, undefined), 'forbidden');
    // A session that exists but is not yours is `forbidden`, never
    // `not-found`: hiding an ownership violation inside an expiry would
    // make P4 unobservable in the logs.
    assert.equal(M.gate.authorizeSession(null, USER), 'not-found');
  });

  test('(4) the `?t=` legacy-token strip', () => {
    const url = M.gate.buildUpstreamUrl(
      'https://x.modal.run/?leftover=1',
      'api/view',
      new URLSearchParams('t=legacy-session-token&filename=out_00001_.png&type=temp'),
    );
    assert.ok(!url.includes('legacy-session-token'), 'the legacy token must not reach Modal logs');
    assert.ok(!url.includes('leftover=1'), "the modal_url's own query is dropped, not merged");
    assert.ok(url.includes('filename=out_00001_.png'));
    assert.ok(url.includes('type=temp'));
  });

  test('(5) the 30s bidirectional keepalive — pings leave on BOTH legs', async () => {
    assert.equal(
      M.gate.KEEPALIVE_INTERVAL_MS,
      30_000,
      'the default is 30s: Cloudflare/Modal close an idle tunnel at ~100-125s',
    );

    // A stub ComfyUI WS upstream that counts the pings it receives.
    let upstreamPings = 0;
    const upstreamHttp = http.createServer();
    const upstreamWss = new M.WebSocketServer({ server: upstreamHttp });
    upstreamWss.on('connection', (ws) => {
      ws.on('ping', () => {
        upstreamPings++;
      });
    });
    await new Promise<void>((r) => upstreamHttp.listen(0, '127.0.0.1', r));
    const upstreamPort = (upstreamHttp.address() as { port: number }).port;

    seedSession('cs_keepalive', `http://127.0.0.1:${upstreamPort}/`);

    const proxy = M.wsProxy.startWsProxy({ port: 0, keepaliveMs: 40, sharedSecret: 'shh' });
    const proxyPort = await proxy.listening;

    let clientPings = 0;
    const client = new M.WebSocket(`ws://127.0.0.1:${proxyPort}/cs_keepalive/ws?clientId=abc`);
    client.on('ping', () => {
      clientPings++;
    });
    await new Promise<void>((resolve, reject) => {
      client.on('open', () => resolve());
      client.on('error', reject);
    });

    await new Promise((r) => setTimeout(r, 300));

    assert.ok(
      clientPings >= 2,
      `browser leg must be pinged (got ${clientPings}) — the ws library answers pings, it does not originate them`,
    );
    assert.ok(
      upstreamPings >= 2,
      `Modal leg must be pinged (got ${upstreamPings}) — the tunnel needs traffic in BOTH directions`,
    );

    client.close();
    await proxy.close();
    upstreamWss.close();
    await new Promise<void>((r) => upstreamHttp.close(() => r()));
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 2. Canvas produces leaves, through the component's decision layer
// ═══════════════════════════════════════════════════════════════════════

describe('capture — canvas on the component', () => {
  test('a /view artifact is witnessed and correlated by FILENAME PREFIX, not by timing', async () => {
    seedSession('cs_cap1', 'https://x.modal.run/');
    M.witness.startWorkflow({
      sessionId: 'cs_cap1',
      userId: USER,
      promptId: 'p-cap1',
      projectId: PROJECT_ID,
      workflowApiJson: graph('SaveImage', 'ScrupleRun'),
    });

    const ing = fakeIngest();
    const outcome = await M.witness.captureBytes({
      sessionId: 'cs_cap1',
      userId: USER,
      machineId: 't4-free',
      egress: '/api/view',
      surface: 'network-gate-http',
      filename: 'ScrupleRun_00001_.png',
      bytes: Buffer.from('PNGBYTES-cap1'),
      mime: null,
      ingest: ing.fn,
    });

    assert.equal(outcome.status, 'witnessed');
    assert.equal(outcome.promptId, 'p-cap1');
    assert.equal(
      outcome.correlationMethod,
      'filename-prefix',
      'the writing node declared the prefix; that is a real link, not a timing guess',
    );
    assert.equal(ing.calls.length, 1);

    // The MIME was DECLARED by the writing node class, via the component's
    // own NODE_CLASS_MIME table — never sniffed, never from the extension.
    const row = M.conn()
      .prepare(`SELECT * FROM canvas_capture_log WHERE id = ?`)
      .get(outcome.captureLogId) as { mime: string; mime_source: string; status: string };
    assert.equal(row.mime, 'image/png');
    assert.equal(row.mime_source, 'node');
    assert.equal(row.status, 'witnessed');

    // And the pending row is closed, so a second /view of the same artifact
    // cannot re-witness it.
    const pending = M.conn()
      .prepare(`SELECT status FROM canvas_pending_iterations WHERE prompt_id = 'p-cap1'`)
      .get() as { status: string };
    assert.equal(pending.status, 'done');
  });

  test('a re-fetch is a re-fetch; a NEW artifact with no workflow is a NAMED hole', async () => {
    seedSession('cs_cap2', 'https://x.modal.run/');

    // Same bytes as the witnessed artifact above → prior iteration exists.
    const refetch = await M.witness.captureBytes({
      sessionId: 'cs_cap2',
      userId: USER,
      machineId: 't4-free',
      egress: '/api/view',
      surface: 'network-gate-http',
      filename: 'ScrupleRun_00001_.png',
      bytes: Buffer.from('PNGBYTES-cap1'),
      mime: null,
    });
    assert.equal(refetch.status, 'refetch', 'a thumbnail reload is not a hole');

    // Different bytes, no pending workflow, on one of C-7's routes.
    const hole = await M.witness.captureBytes({
      sessionId: 'cs_cap2',
      userId: USER,
      machineId: 't4-free',
      egress: '/api/userdata/whatever.bin',
      surface: 'network-gate-http',
      filename: 'whatever.bin',
      bytes: Buffer.from('BYTES-THAT-LEFT-UNWITNESSED'),
      mime: null,
    });
    assert.equal(hole.status, 'unwitnessed');
    // The old code hit `return` here and logged a warning. The point of the
    // row is that the hole is countable afterwards.
    const n = M.conn()
      .prepare(`SELECT COUNT(*) c FROM canvas_capture_log WHERE status = 'unwitnessed'`)
      .get() as { c: number };
    assert.ok(n.c >= 1);
  });

  test('canvas declares what it can claim: sidecar-gate, attestation none, leaf passthrough', () => {
    const a = M.witness.canvasAssurance();
    assert.equal(a.placement, 'sidecar-gate');
    assert.equal(a.attestation, 'none');
    assert.equal(a.leaf, 'passthrough', 'no root-chained attestation on Modal — §12.4');
    assert.equal(a.canClaim, true);
    assert.equal(a.p1, 'conditional', 'P1 holds by topology and is checkable only by probe');
    assert.ok(a.conditions.length > 0);

    // The profile names ONE surface, and that is the honest difference
    // between canvas and the sidecar.
    const p = M.witness.canvasCaptureProfile();
    assert.deepEqual([...p.surfaces], ['network-gate']);
    assert.ok(!p.surfaces.includes('filesystem-watch'));
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3. The §7 silent drop
// ═══════════════════════════════════════════════════════════════════════

describe('§7 — an ingest failure is loud, durable and recoverable', () => {
  test('ingest throws: a failed row, a retained artifact, a response header, and NO silence', async () => {
    seedSession('cs_fail', 'https://x.modal.run/');
    M.witness.startWorkflow({
      sessionId: 'cs_fail',
      userId: USER,
      promptId: 'p-fail',
      projectId: PROJECT_ID,
      workflowApiJson: graph('SaveImage', 'FailRun'),
    });

    const boom = fakeIngest({ fail: new Error('storage provider said no') });
    const errors: string[] = [];
    const realError = console.error;
    console.error = (...a: unknown[]) => {
      errors.push(a.map(String).join(' '));
    };
    let outcome;
    try {
      outcome = await M.witness.captureBytes({
        sessionId: 'cs_fail',
        userId: USER,
        machineId: 't4-free',
        egress: '/api/view',
        surface: 'network-gate-http',
        filename: 'FailRun_00001_.png',
        bytes: Buffer.from('PNGBYTES-fail'),
        mime: null,
        ingest: boom.fn,
      });
    } finally {
      console.error = realError;
    }

    // 1. It did not throw — the user keeps their image. See the argument in
    //    lib/canvas/witness.ts's header for why that is the right half of
    //    the component's split to copy here.
    assert.equal(outcome!.status, 'failed');
    assert.ok(outcome!.header.startsWith('failed;'), 'the response says so at the surface');
    assert.match(outcome!.error ?? '', /storage provider said no/);

    // 2. It was LOUD. This is the assertion the old
    //    `catch (e) { console.error(...) }` would also have passed, so the
    //    three below are the ones that matter.
    assert.ok(
      errors.some((e) => e.includes('INGEST FAILED')),
      'the failure is reported at error level, naming the capture row',
    );

    // 3. It is DURABLE — a row, not a log line.
    const row = M.conn()
      .prepare(`SELECT * FROM canvas_capture_log WHERE id = ?`)
      .get(outcome!.captureLogId) as {
      status: string;
      error: string;
      attempts: number;
      content_hash: string;
      witnessed: number;
    };
    assert.equal(row.status, 'failed');
    assert.equal(row.witnessed, 0);
    assert.equal(row.attempts, 1);
    assert.match(row.error, /storage provider said no/);

    // 4. It is VISIBLE to something other than a log file.
    const open = M.witness.openCaptureFailures(USER);
    assert.ok(open.some((f) => f.id === outcome!.captureLogId));

    // 5. It is RECOVERABLE: the bytes were retained, so the queue holds a
    //    promise it can keep.
    const recovered = fakeIngest();
    const drain = await M.witness.retryFailedCaptures({ ingest: recovered.fn });
    assert.equal(drain.recovered, 1, 'the retained bytes were re-ingested');
    assert.equal(recovered.calls.length, 1);
    assert.equal(
      crypto.createHash('sha256').update(recovered.calls[0].imageBytes as Buffer).digest('hex'),
      row.content_hash,
      'the retry re-ingests the SAME bytes — a re-hash would be a different artifact',
    );

    const after = M.conn()
      .prepare(`SELECT status FROM canvas_capture_log WHERE id = ?`)
      .get(outcome!.captureLogId) as { status: string };
    assert.equal(after.status, 'witnessed');
  });

  test('fail closed on the LOCAL half: no capture row, no bytes', async () => {
    seedSession('cs_closed', 'https://x.modal.run/');
    // The one thing that must never be survivable: we cannot even record
    // that we observed these bytes.
    M.conn().exec(`ALTER TABLE canvas_capture_log RENAME TO canvas_capture_log_hidden`);
    try {
      await assert.rejects(
        () =>
          M.witness.captureBytes({
            sessionId: 'cs_closed',
            userId: USER,
            machineId: 't4-free',
            egress: '/api/view',
            surface: 'network-gate-http',
            filename: 'x.png',
            bytes: Buffer.from('BYTES'),
            mime: null,
            ingest: fakeIngest().fn,
          }),
        /canvas_capture_log/,
      );
    } finally {
      M.conn().exec(`ALTER TABLE canvas_capture_log_hidden RENAME TO canvas_capture_log`);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 4. C-7 and C-8 — canvas must not ship a narrower gate
// ═══════════════════════════════════════════════════════════════════════

describe('C-7 / C-8 — the route table', () => {
  test('all five byte-egress routes are gated, in both /api/ spellings', () => {
    const gated = [
      '/view',
      '/api/view',
      '/userdata/workflows/mine.json.bin',
      '/api/userdata/anything',
      `/api/assets/${crypto.randomUUID()}/content`,
      '/experiment/models/preview/checkpoints/0/thing.png',
      '/api/experiment/models/preview/loras/1/x.safetensors',
    ];
    for (const p of gated) {
      assert.equal(
        M.egress.classifyRoute('GET', p),
        'byte-egress',
        `${p} returns retrievable artifact bytes (H-4 §10 C-7)`,
      );
    }
    assert.equal(M.egress.classifyRoute('POST', '/prompt'), 'prompt');
    assert.equal(M.egress.classifyRoute('POST', '/api/prompt'), 'prompt');
    assert.equal(M.egress.classifyRoute('POST', '/upload/image'), 'upload');
    assert.equal(M.egress.classifyRoute('POST', '/api/upload/mask'), 'upload');
    assert.equal(M.egress.classifyRoute('GET', '/system_stats'), 'other');
    // The path param arrives without a leading slash. Both shapes classify.
    assert.equal(M.egress.classifyRoute('GET', 'api/view'), 'byte-egress');
  });

  test('the copied route table has not drifted from the component that owns it', () => {
    // BYTE_EGRESS is module-private in http-gate.ts and
    // services/scruple-capture/src/** is not this WO's to change, so
    // lib/canvas/egress.ts holds a copy. This reads the original out of its
    // own source so that the copy cannot rot in silence.
    const src = fs.readFileSync(
      path.join(REPO_ROOT, 'services/scruple-capture/src/surfaces/http-gate.ts'),
      'utf8',
    );
    const block = /const BYTE_EGRESS = \[([\s\S]*?)\];/.exec(src);
    assert.ok(block, "the component still declares a BYTE_EGRESS array; if not, this test's premise moved");
    const componentPatterns = [...block[1].matchAll(/\/(\^[^\n]*?\$)\/,/g)].map((m) => m[1]);
    assert.equal(componentPatterns.length, 4, 'the component gates four byte-egress patterns');
    assert.deepEqual(
      M.egress.BYTE_EGRESS.map((r) => r.source).sort(),
      componentPatterns.slice().sort(),
      'lib/canvas/egress.ts BYTE_EGRESS has drifted from the component. Copy the component\'s ' +
        'array across, or delete the copy and import it if the component now exports it.',
    );
  });

  test('C-8 — output/, temp/ and input/ all pass the gate, and the row says which', () => {
    // PreviewImage writes full images to temp/, not output/; LoadImage
    // inputs live in input/. A watcher on output/ alone misses every one.
    // Canvas gates the ROUTE, so all three are covered on the surface it
    // has — and the directory is recorded rather than used as a filter.
    assert.equal(M.egress.viewDirectory(new URLSearchParams('filename=a.png')), 'output');
    assert.equal(M.egress.viewDirectory(new URLSearchParams('type=temp')), 'temp');
    assert.equal(M.egress.viewDirectory(new URLSearchParams('type=input')), 'input');
    assert.equal(M.egress.viewDirectory(new URLSearchParams('type=../../etc')), null);
    assert.deepEqual([...M.egress.VIEW_DIRECTORIES], ['output', 'temp', 'input']);
  });

  test('the tripwire fires on binary bytes leaving an unenumerated route', () => {
    M.egress.resetTripwire();
    const lines: string[] = [];
    const log = (l: string) => lines.push(l);

    assert.equal(M.egress.tripwire('/api/view', 200, 'image/png', true, log), null, 'captured routes do not trip');
    assert.equal(M.egress.tripwire('/assets/index.js', 200, 'application/javascript', false, log), null);
    assert.equal(M.egress.tripwire('/object_info', 200, 'application/json', false, log), null);

    const trip = M.egress.tripwire('/some/new/comfy/route', 200, 'image/webp', false, log);
    assert.ok(trip, 'a 2xx binary response on an unenumerated route is recorded');
    assert.equal(trip!.contentType, 'image/webp');
    assert.equal(M.egress.unenumeratedEgress().length, 1);
    assert.ok(lines.some((l) => l.includes('UNENUMERATED BINARY EGRESS')));
    M.egress.resetTripwire();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 5. The WS leg is a gate
// ═══════════════════════════════════════════════════════════════════════

describe('the WebSocket surface — H-4 §2 path 2', () => {
  /** ComfyUI's PREVIEW_IMAGE_WITH_METADATA frame, built to server.py's
   *  layout: >I event_type, >I metadata_length, metadata JSON, image bytes. */
  function metadataFrame(payload: Buffer, mime = 'image/png'): Buffer {
    const meta = Buffer.from(JSON.stringify({ image_type: mime }), 'utf8');
    const head = Buffer.alloc(8);
    head.writeUInt32BE(M.wsCapture.PREVIEW_IMAGE_WITH_METADATA, 0);
    head.writeUInt32BE(meta.length, 4);
    return Buffer.concat([head, meta, payload]);
  }

  test('correlation state crosses the process boundary through the DB', () => {
    seedSession('cs_ws1', 'https://x.modal.run/');
    M.witness.startWorkflow({
      sessionId: 'cs_ws1',
      userId: USER,
      promptId: 'p-ws1',
      projectId: PROJECT_ID,
      workflowApiJson: graph('SaveImageWebsocket'),
    });

    // Before `executing`, nothing is live for a frame to belong to. This is
    // the fact the component keeps in memory and canvas cannot.
    assert.equal(M.correlate.attributeFrame('cs_ws1').prompt, null);

    assert.equal(M.wsCapture.observeUpstreamText('cs_ws1', JSON.stringify({
      type: 'executing', data: { prompt_id: 'p-ws1', node: '9' },
    })), true);

    const att = M.correlate.attributeFrame('cs_ws1');
    assert.equal(att.prompt?.prompt_id, 'p-ws1');
    assert.equal(att.method, 'ws-executing');

    // And the state only canvas can be in: a session whose WS sidecar never
    // connected has nothing marked executing, so the only ordering available
    // is insertion order — which is what the OLD code used for everything
    // and labelled 'the most recent pending row' in a comment. It has a name
    // on the row now.
    seedSession('cs_nows', 'https://x.modal.run/');
    M.witness.startWorkflow({
      sessionId: 'cs_nows', userId: USER, promptId: 'p-nows', projectId: PROJECT_ID,
      workflowApiJson: graph('SaveImage', 'NoPrefixMatch'),
    });
    const guessed = M.correlate.attribute('cs_nows', 'unrelated_name.png');
    assert.equal(guessed.prompt?.prompt_id, 'p-nows');
    assert.equal(
      guessed.method,
      'most-recent-pending',
      'no executing marker means no ws-executing claim — a weaker link gets a weaker name',
    );

    // A null prompt_id is ComfyUI's idle message and must not clear a live
    // prompt (correlation.ts noteExecuting).
    M.wsCapture.observeUpstreamText('cs_ws1', JSON.stringify({ type: 'executing', data: { prompt_id: null } }));
    assert.equal(M.correlate.attributeFrame('cs_ws1').prompt?.prompt_id, 'p-ws1');
  });

  test('a WS artifact frame is witnessed; a preview frame is counted, not witnessed', async () => {
    // Session A: the graph declares SaveImageWebsocket — the node ComfyUI's
    // own example client exists to drive, whose bytes never become a file.
    seedSession('cs_ws2', 'https://x.modal.run/');
    M.witness.startWorkflow({
      sessionId: 'cs_ws2', userId: USER, promptId: 'p-ws2', projectId: PROJECT_ID,
      workflowApiJson: graph('SaveImageWebsocket'),
    });
    M.wsCapture.observeUpstreamText('cs_ws2', JSON.stringify({
      type: 'executing', data: { prompt_id: 'p-ws2' },
    }));

    const ing = fakeIngest();
    const payload = Buffer.from('WS-IMAGE-BYTES');
    const d = await M.wsCapture.observeUpstreamBinary(
      { sessionId: 'cs_ws2', userId: USER, machineId: 't4-free', ingest: ing.fn },
      metadataFrame(payload),
    );
    assert.equal(d.kind, 'forward');
    assert.equal((d as { reason: string }).reason, 'captured');
    const outcome = (d as { outcome: { status: string; contentHash: string; captureLogId: number } }).outcome;
    assert.equal(outcome.status, 'witnessed');
    assert.equal(
      outcome.contentHash,
      crypto.createHash('sha256').update(payload).digest('hex'),
      'the hash is over the IMAGE bytes with the framing removed — what the client keeps as out[8:]',
    );
    const row = M.conn()
      .prepare(`SELECT surface, egress, mime, mime_source FROM canvas_capture_log WHERE id = ?`)
      .get(outcome.captureLogId) as { surface: string; egress: string; mime: string; mime_source: string };
    assert.equal(row.surface, 'network-gate-ws');
    assert.equal(row.egress, 'ws:binary:4');
    assert.equal(row.mime, 'image/png');
    assert.equal(row.mime_source, 'frame', 'the producer declared its own type in band');

    // Session B: the graph declares SaveImage — the artifact goes to disk
    // and is retrieved over /view. Binary frames here are progress previews.
    seedSession('cs_ws3', 'https://x.modal.run/');
    M.witness.startWorkflow({
      sessionId: 'cs_ws3', userId: USER, promptId: 'p-ws3', projectId: PROJECT_ID,
      workflowApiJson: graph('SaveImage'),
    });
    M.wsCapture.observeUpstreamText('cs_ws3', JSON.stringify({
      type: 'executing', data: { prompt_id: 'p-ws3' },
    }));
    const ing2 = fakeIngest();
    const d2 = await M.wsCapture.observeUpstreamBinary(
      { sessionId: 'cs_ws3', userId: USER, machineId: 't4-free', ingest: ing2.fn },
      metadataFrame(Buffer.from('PREVIEW-BYTES')),
    );
    assert.deepEqual(d2, { kind: 'forward', reason: 'preview' });
    assert.equal(ing2.calls.length, 0, 'a preview is not an iteration');

    // But it is COUNTED, and the count is logged on close. A hole you can
    // count is a hole you can see.
    const tally = M.wsCapture.clearWsFrameTally('cs_ws3');
    assert.equal(tally.binaryFrames, 1);
    assert.equal(tally.previews, 1);
    assert.equal(tally.artifacts, 0);
  });

  test('the frame decoder is the COMPONENT\'s, not a second implementation', () => {
    // Same function object, imported. Two decoders would be two answers to
    // "what are the artifact bytes", and only one of them could match a
    // hash the tenant can re-derive.
    const head = Buffer.alloc(8);
    head.writeUInt32BE(M.wsCapture.PREVIEW_IMAGE, 0);
    head.writeUInt32BE(2, 4); // 2 = PNG, server.py send_image
    const frame = Buffer.concat([head, Buffer.from('IMG')]);
    const dec = M.wsCapture.decodeBinaryFrame(frame);
    assert.equal(dec?.payload.toString(), 'IMG');
    assert.equal(dec?.mime?.mime, 'image/png');
    assert.equal(dec?.mime?.source, 'frame');
    // TEXT frames (event type 3) carry no artifact.
    const text = Buffer.alloc(8);
    text.writeUInt32BE(3, 0);
    assert.equal(M.wsCapture.decodeBinaryFrame(Buffer.concat([text, Buffer.from('hi')])), null);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 6. The baseline — P2, and P7 with it
// ═══════════════════════════════════════════════════════════════════════

describe('the baseline', () => {
  test('the recorded tamper-surface hash matches the working tree', () => {
    const s = M.baseline.tamperSurface(REPO_ROOT);
    assert.equal(s.complete, true, `a tracked file is missing: ${s.files.filter((f) => f.missing).map((f) => f.file).join(', ')}`);
    assert.equal(
      s.tamper_surface_hash,
      M.baseline.CANVAS_BASELINE.tamper_surface_hash,
      'A file on canvas\'s capture path changed and the baseline did not. That is the ' +
        'mechanism working, not a broken test. Re-record with:\n' +
        '  npx tsx -e "import(\'./lib/canvas/baseline\').then(m=>console.log(m.tamperSurface().tamper_surface_hash))"\n' +
        'and say in the commit WHY the capture path changed.',
    );
  });

  test('changing a covered file changes the hash — proved on a copy, not on the tree', () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-baseline-'));
    for (const rel of M.baseline.TRACKED) {
      const dst = path.join(sandbox, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(path.join(REPO_ROOT, rel), dst);
    }
    const before = M.baseline.tamperSurface(sandbox).tamper_surface_hash;
    assert.equal(before, M.baseline.CANVAS_BASELINE.tamper_surface_hash);

    // The §7 fix itself. If someone reinstates the swallowed catch, the
    // baseline says so.
    const victim = path.join(sandbox, 'lib/canvas/witness.ts');
    fs.appendFileSync(victim, '\n// silently changed\n');
    const after = M.baseline.tamperSurface(sandbox).tamper_surface_hash;
    assert.notEqual(after, before);

    // And a file DISAPPEARING is not the same as a file being unchanged.
    fs.rmSync(path.join(sandbox, 'scripts/canvas-ws-proxy.mjs'));
    const s = M.baseline.tamperSurface(sandbox);
    assert.equal(s.complete, false);
    assert.ok(s.canonical.includes('MISSING  scripts/canvas-ws-proxy.mjs'));

    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  test('P7 — attestation provider is declared `none`, which is the correct value', () => {
    assert.equal(M.baseline.CANVAS_BASELINE.attestation.provider, 'none');
    assert.equal(M.baseline.CANVAS_BASELINE.attestation.quote_ref, null);
    // P7 fails when there is no manifest to declare it in, not when the
    // value is `none`. Both halves are now present.
    assert.equal(M.baseline.CANVAS_BASELINE.integration_id, 'scruple-canvas');
    assert.equal(M.baseline.CANVAS_BASELINE.placement, 'sidecar-gate');
  });

  test('the capture path is covered: every lib/canvas module and both entry points', () => {
    const tracked = new Set(M.baseline.TRACKED);
    for (const f of fs.readdirSync(path.join(REPO_ROOT, 'lib/canvas'))) {
      if (!f.endsWith('.ts')) continue;
      const rel = `lib/canvas/${f}`;
      if (rel === 'lib/canvas/baseline.ts') {
        assert.ok(
          M.baseline.EXCLUDED.some((e) => e.path === rel),
          'the manifest excludes itself and says why — a fixpoint, not an oversight',
        );
        continue;
      }
      assert.ok(tracked.has(rel), `${rel} is on the capture path and is not baselined`);
    }
    assert.ok(tracked.has('app/canvas-proxy/[sessionId]/[[...path]]/route.ts'));
    assert.ok(tracked.has('scripts/canvas-ws-proxy.mjs'));
    assert.ok(tracked.has('lib/iterations/ingest.ts'));
    // Every exclusion carries a reason. An exclusion nobody can find is the
    // same as an oversight.
    for (const e of M.baseline.EXCLUDED) assert.ok(e.reason.length > 40, e.path);
  });
});
