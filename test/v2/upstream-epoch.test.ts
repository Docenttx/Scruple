// WO-C5 — upstream restart detection: who ComfyUI is, and whether its history
// ring is the same ring it was.
//
// The council owned this one rather than pushing it into the schema. Hand
// round 6 §2: "nothing in the component tracks upstream identity — no call to
// /system_stats, no upstream id, no version pin ... WE NEVER ASK COMFYUI WHO
// IT IS", and so a silent restart resets an in-memory `/history` ring that
// does not survive it (execution.py:1186-1197, 1227-1228) and reads as a
// normal short history.
//
// EVERY GATE IN THIS FILE HAS A CONTROL NAMED BESIDE IT.
//
//   THE GATE     restart the upstream mid-session and the flag is raised.
//   THE CONTROL  an unrestarted session of the same length and the same work
//                does NOT raise it, and its epoch never changes.
//
//   AND THE CONTROL FOR THE CONTROL, which is the one a first pass drops:
//                `/system_stats` IS BYTE-IDENTICAL ACROSS THE RESTART. A
//                detector built on it would pass every test here and never
//                fire, so the identical digest is asserted rather than
//                assumed — if `upstreamIdentityOf()` ever started changing
//                across a restart, the epoch machinery would be redundant and
//                this file should say so out loud.
//
// The live run against the REAL component with a REAL process restart is at
// /mnt/corpus/scruple-council-impl/wo-c5/03-live-GREEN.txt, with the identical
// script against the pre-change tree in 01-controls-RED.txt.
//
// TEST ISOLATION follows test/v2/storage-confinement.test.ts: a private
// database assigned at module top level, everything reaching lib/db/sqlite
// imported dynamically inside before().

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_RETENTION_POLICY,
  DEFAULT_RETENTION_POLICY_DIGEST,
} from '../../lib/leaf/retentionPolicy';
import {
  DEFAULT_MIN_RESERVABLE_BYTES,
} from '../../lib/capture/storageConfinement';
import {
  DEFAULT_UPSTREAM_ANCHOR_WINDOW,
  DEFAULT_UPSTREAM_POLL_INTERVAL_MS,
  UNQUERIED_UPSTREAM,
  UpstreamTracker,
  compareEpoch,
  mintEpoch,
  parseHistory,
  upstreamIdentityOf,
  type BracketedRead,
  type EpochState,
  type HistoryReading,
} from '../../lib/capture/upstreamEpoch';

if (!process.env.SCRUPLE_DB_PATH || !/tmp|test/i.test(process.env.SCRUPLE_DB_PATH)) {
  throw new Error('Refusing to run: set SCRUPLE_DB_PATH to a throwaway path. Use `npm run test:v2`.');
}
const OWN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'scruple-upstream-epoch-'));
process.env.SCRUPLE_DB_PATH = path.join(OWN_DIR, 'upstream-epoch.db');
process.env.SCRUPLE_BDK_HEX = 'd5'.repeat(32);
// The standing rule: never the production witness on 127.0.0.1:5799.
process.env.WITNESS_SERVER_URL = 'http://127.0.0.1:1';

type Mod = {
  conn: typeof import('../../lib/db/sqlite').conn;
  runMigrations: typeof import('../../lib/db/migrate').runMigrations;
  issueProvisioningToken: typeof import('../../lib/ratchet/provisioning').issueProvisioningToken;
  redeemProvisioningToken: typeof import('../../lib/ratchet/provisioning').redeemProvisioningToken;
  deriveIk: typeof import('../../lib/ratchet/ratchet').deriveIk;
  Ratchet: typeof import('../../lib/ratchet/ratchet').Ratchet;
  bdk: typeof import('../../lib/ratchet/bdk').bdk;
  componentPreimage: typeof import('../../lib/leaf/componentPreimage').componentPreimage;
  buildMeasurement: typeof import('../../services/scruple-capture/src/build-measurement').buildMeasurement;
  Identity: typeof import('../../services/scruple-capture/src/identity').Identity;
  CaptureComponent: typeof import('../../services/scruple-capture/src/component').CaptureComponent;
  startStubComfyUI: typeof import('../../services/scruple-capture/test-support/stub-comfyui').startStubComfyUI;
  POST: (req: Request) => Promise<Response>;
};

let M: Mod;
const TENANT = 'vendor-c5';
const BUILD = 'sha256:' + '5d'.repeat(32);
const BASELINE = '5'.repeat(64);
let API_KEY: string;

/* ────────────────────────────────────────────────────────────────────────
 * Route-side fixtures — a capture-bearing leaf as a component sends it.
 * ──────────────────────────────────────────────────────────────────────── */

function captureBlock(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    surface: 'network-gate',
    hook: 'artifact.produced',
    fidelity: 'as-delivered',
    size_bytes: 17,
    mime_source: 'caller-declared',
    correlation_id: null,
    correlation_method: null,
    egress: 'http:/view',
    close_detection: null,
    workflow_hash: null,
    observed_at: '2026-09-09T00:00:00.000Z',
    profile: 'isolated-sidecar',
    attestation_status: 'stale',
    confinement: 'confined',
    confinement_source: 'measured',
    upstream_identity: 'sha256:' + 'ef'.repeat(32),
    upstream_epoch: 'epoch:' + '9a'.repeat(16),
    upstream_continuity: 'continuous',
    upstream_low_watermark_open: 4096,
    upstream_low_watermark_close: 4096,
    upstream_uncaptured_reason: 'enumerated',
    upstream_source: 'measured',
    // WO-D6 rule 7. A capture-bearing leaf must say which LEVEL its host
    // hook ran at, and these fixtures are Level 1: no adapter was
    // registered, so nothing named the bytes. 'blind' is the honest value
    // and it is free — which is exactly why ABSENT is refused rather than
    // read as Level 1.
    host_semantics: 'blind',
    // And the four siblings, present as nulls rather than omitted — the
    // absent-is-null discipline every capture field follows, so that a
    // Level-1 leaf and a Level-2 one produce the same preimage SHAPE and
    // the difference between them is a VALUE a MAC covers.
    host: null,
    host_adapter: null,
    host_evidence_type: null,
    host_evidence_hash: null,
    ...over,
  };
}

const RESOLUTION = () => ({
  witness_endpoint: 'https://witness.example.vendor/api',
  witness_authority: 'sha256:' + 'ef'.repeat(32),
  checkpoint_id: null,
  prev_checkpoint_id: null,
  prev_checkpoint_quote_time: null,
  settlement_deadline: new Date(
    Date.now() + DEFAULT_RETENTION_POLICY.settlement_window_s * 1000,
  ).toISOString(),
  retention_policy_digest: DEFAULT_RETENTION_POLICY_DIGEST,
});

function submission(
  componentId: string,
  counter: number,
  capture: Record<string, unknown> | null,
  extra: Record<string, unknown> = {},
) {
  const body: Record<string, unknown> = {
    baseline_ref: BASELINE,
    kind: 'artifact',
    content_hash: crypto.randomBytes(32).toString('hex'),
    mime: 'image/png',
    ...(capture ? { capture } : {}),
    resolution: RESOLUTION(),
    component: {
      component_id: componentId,
      build_measurement: BUILD,
      counter,
      attestation: { provider: 'none', quote_ref: null },
    },
    ...extra,
  };
  const preimage = M.componentPreimage(body as never);
  const r = new M.Ratchet(M.deriveIk(M.bdk(), componentId), 0);
  r.skip(counter);
  const { mac } = r.mac(preimage);
  r.destroy();
  body.mac = mac;
  return body;
}

const witnessReq = (body: unknown) =>
  new Request('https://scruple.ai/api/v2/witness', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify(body),
  });

let nextCounter = 0;
function provision(): string {
  const { componentId, token } = M.issueProvisioningToken({ tenantId: TENANT, label: 'sidecar' });
  assert.ok(M.redeemProvisioningToken({ token, tenantId: TENANT, buildMeasurement: BUILD }).ok);
  nextCounter = 0;
  return componentId;
}

/* ────────────────────────────────────────────────────────────────────────
 * Component-side fixtures.
 * ──────────────────────────────────────────────────────────────────────── */

interface Ingest {
  url: string;
  received: Array<Record<string, unknown>>;
  close(): Promise<void>;
}

async function startIngest(): Promise<Ingest> {
  const received: Array<Record<string, unknown>> = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      try {
        received.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        /* the assertion will notice */
      }
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const a = server.address();
  return {
    url: `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`,
    received,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

function identityFor(stateDir: string) {
  const { componentId, token } = M.issueProvisioningToken({ tenantId: TENANT, label: 'c5' });
  const measurement = M.buildMeasurement();
  const r = M.redeemProvisioningToken({ token, tenantId: TENANT, buildMeasurement: measurement });
  assert.ok(r.ok);
  return M.Identity.fromSealed(stateDir, {
    component_id: componentId,
    chain_key_hex: r.ikHex,
    counter: 0,
    build_measurement: measurement,
    attestation_status: null,
    provisioned_at: r.provisionedAt,
  });
}

function componentConfig(o: { stateDir: string; outputVolume: string; apiBaseUrl: string; upstreamUrl: string }) {
  return {
    upstreamUrl: o.upstreamUrl,
    listenHost: '127.0.0.1',
    listenPort: 0,
    outputVolume: o.outputVolume,
    stateDir: o.stateDir,
    apiBaseUrl: o.apiBaseUrl,
    apiKey: 'sk_test_c5',
    provisioningToken: null,
    baselineRef: BASELINE,
    outputVolumeDeclaredMime: 'image/png',
    witnessAuthority: null,
    retentionPolicyDigest: DEFAULT_RETENTION_POLICY_DIGEST,
    settlementWindowSeconds: DEFAULT_RETENTION_POLICY.settlement_window_s,
    // One mkdtemp root, so this is one device and the session declares it —
    // WO-C4's waiver, used here exactly as the other harnesses use it.
    allowDegradedStorage: true,
    stateMinReservableBytes: 1,
    settleMs: 40,
    correlationTtlMs: 60_000,
    heartbeatWindowSeconds: 900,
    // Fast enough that a test drives brackets by hand without racing them.
    upstreamPollIntervalMs: 3_600_000,
    upstreamMaxReadingAgeMs: 3_600_000,
    upstreamAnchorWindow: DEFAULT_UPSTREAM_ANCHOR_WINDOW,
  };
}

/* ────────────────────────────────────────────────────────────────────────
 * Pure-fold fixtures. compareEpoch() takes no clock and no network, so the
 * rules are driven by a table rather than by a live upstream.
 * ──────────────────────────────────────────────────────────────────────── */

const reading = (
  pairs: Array<[number | null, string]>,
): HistoryReading => ({
  ok: true,
  low: pairs.reduce<number | null>((a, [n]) => (n === null ? a : a === null || n < a ? n : a), null),
  high: pairs.reduce<number | null>((a, [n]) => (n === null ? a : a === null || n > a ? n : a), null),
  anchors: pairs.map(([number, prompt_id]) => ({ number, prompt_id })),
  error: null,
});

const oneLow = (n: number | null, id = 'oldest'): HistoryReading =>
  n === null ? reading([]) : reading([[n, id]]);

function bracket(o: {
  identity?: string | null;
  open?: HistoryReading;
  window: HistoryReading;
  close?: HistoryReading;
  identityOk?: boolean;
}): BracketedRead {
  const w = o.window;
  return {
    identity: o.identity === undefined ? 'sha256:install-A' : o.identity,
    identityOk: o.identityOk ?? true,
    open: o.open ?? oneLow(w.low),
    window: w,
    close: o.close ?? oneLow(w.low),
  };
}

const stateOf = (read: BracketedRead): EpochState =>
  compareEpoch(null, read).next;

/* ──────────────────────────────────────────────────────────────────────── */

before(async () => {
  const [sqlite, migrate, prov, ratchet, bdkMod, preimage, route, bm, identity, component, stub] =
    await Promise.all([
      import('../../lib/db/sqlite'),
      import('../../lib/db/migrate'),
      import('../../lib/ratchet/provisioning'),
      import('../../lib/ratchet/ratchet'),
      import('../../lib/ratchet/bdk'),
      import('../../lib/leaf/componentPreimage'),
      import('../../app/api/v2/witness/route'),
      import('../../services/scruple-capture/src/build-measurement'),
      import('../../services/scruple-capture/src/identity'),
      import('../../services/scruple-capture/src/component'),
      import('../../services/scruple-capture/test-support/stub-comfyui'),
    ]);
  M = {
    conn: sqlite.conn,
    runMigrations: migrate.runMigrations,
    issueProvisioningToken: prov.issueProvisioningToken,
    redeemProvisioningToken: prov.redeemProvisioningToken,
    deriveIk: ratchet.deriveIk,
    Ratchet: ratchet.Ratchet,
    bdk: bdkMod.bdk,
    componentPreimage: preimage.componentPreimage,
    buildMeasurement: bm.buildMeasurement,
    Identity: identity.Identity,
    CaptureComponent: component.CaptureComponent,
    startStubComfyUI: stub.startStubComfyUI,
    POST: route.POST as unknown as (req: Request) => Promise<Response>,
  };
  M.runMigrations(false);
  M.conn().prepare(`INSERT INTO users (id, email) VALUES (?, ?)`).run(TENANT, 'c5@example.com');
  const now = new Date().toISOString();
  M.conn()
    .prepare(
      `INSERT INTO baselines
         (tenant_id, baseline_hash, manifest_json, attestation_provider,
          signer_pubkey_spki_sha256_hex, submitted_at, activated_at)
       VALUES (?, ?, '{}', 'none', ?, ?, ?)`,
    )
    .run(TENANT, BASELINE, crypto.createHash('sha256').update('pk').digest('hex'), now, now);
  const plaintext = `sk_test_${crypto.randomBytes(32).toString('base64url')}`;
  M.conn()
    .prepare(
      `INSERT INTO api_keys (id, user_id, key_hash, key_prefix, scopes_json, label)
       VALUES (?, ?, ?, ?, ?, 'test')`,
    )
    .run(
      crypto.randomUUID(),
      TENANT,
      crypto.createHash('sha256').update(plaintext).digest('hex'),
      plaintext.slice(0, 12),
      JSON.stringify(['witness:write']),
    );
  API_KEY = plaintext;
});

after(() => {
  fs.rmSync(OWN_DIR, { recursive: true, force: true });
});

/* ════════════════════════════════════════════════════════════════════════
 * 1 · THE CONTROL FOR EVERY OTHER CONTROL
 * ════════════════════════════════════════════════════════════════════════ */

describe('WO-C5 — /system_stats cannot detect a restart, and that is the finding', () => {
  test('the identity digest is IDENTICAL across a restart of the same install', async () => {
    const root = fs.mkdtempSync(path.join(OWN_DIR, 'stats-'));
    const comfy = await M.startStubComfyUI(root);
    try {
      const before = upstreamIdentityOf(await (await fetch(`${comfy.url}/system_stats`)).json());
      await comfy.restart();
      const after = upstreamIdentityOf(await (await fetch(`${comfy.url}/system_stats`)).json());
      // server.py:646-685 returns os, ram, comfyui_version, the frontend and
      // template versions, python/pytorch version, embedded_python, argv and
      // devices. NO boot id, NO pid, NO start time. A restart detector built
      // on this digest would pass every other test in this file and never
      // fire once.
      assert.equal(before, after);
      assert.ok(before?.startsWith('sha256:'));
    } finally {
      await comfy.close();
    }
  });

  test('...and it is not vacuous: it DOES change when the install changes', () => {
    const base = {
      system: { os: 'linux', comfyui_version: '0.3.44', argv: ['main.py'] },
      devices: [{ name: 'cuda:0', type: 'cuda', index: 0, vram_total: 1 }],
    };
    const upgraded = { ...base, system: { ...base.system, comfyui_version: '0.3.45' } };
    const repointed = { ...base, system: { ...base.system, argv: ['main.py', '--output-directory', '/b'] }};
    assert.notEqual(upstreamIdentityOf(base), upstreamIdentityOf(upgraded));
    assert.notEqual(upstreamIdentityOf(base), upstreamIdentityOf(repointed));
  });

  test('the volatile fields are excluded, or every poll would be a new install', () => {
    const a = {
      system: { os: 'linux', comfyui_version: '0.3.44', argv: [], ram_free: 1_000 },
      devices: [{ name: 'cuda:0', type: 'cuda', index: 0, vram_total: 23, vram_free: 21 }],
    };
    const b = {
      system: { os: 'linux', comfyui_version: '0.3.44', argv: [], ram_free: 2_000 },
      devices: [{ name: 'cuda:0', type: 'cuda', index: 0, vram_total: 23, vram_free: 3 }],
    };
    assert.equal(upstreamIdentityOf(a), upstreamIdentityOf(b));
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * 2 · THE THREE CONTRADICTIONS, AND WHAT EACH IS SUFFICIENT FOR
 * ════════════════════════════════════════════════════════════════════════ */

describe('WO-C5 — the epoch fold, driven by a table', () => {
  test('a first reading is a baseline, not a continuity', () => {
    const r = compareEpoch(null, bracket({ window: reading([[0, 'p0']]) }));
    assert.equal(r.observation.upstream_continuity, 'unknown');
    assert.equal(r.observation.upstream_source, 'measured');
    assert.ok(r.observation.upstream_epoch?.startsWith('epoch:'));
  });

  test('RULE 1 — the high watermark going backwards is a restart', () => {
    const prev = stateOf(bracket({ window: reading([[8, 'p8'], [9, 'p9']]) }));
    const r = compareEpoch(prev, bracket({ window: reading([[0, 'q0']]) }));
    assert.equal(r.observation.upstream_continuity, 'restarted');
    assert.equal(r.observation.upstream_uncaptured_reason, 'evicted_or_restarted');
    assert.match(r.reason, /high watermark went backwards/);
  });

  test('RULE 2 — the low watermark going backwards is a restart', () => {
    // Eviction pops the FRONT (execution.py:1227-1228), so the oldest
    // retained number cannot decrease inside one process.
    const prev = stateOf(bracket({ window: reading([[100, 'p100'], [101, 'p101']]) }));
    const r = compareEpoch(
      prev,
      bracket({ window: reading([[3, 'q3'], [400, 'q400']]) }),
    );
    assert.equal(r.observation.upstream_continuity, 'restarted');
    assert.match(r.reason, /low watermark went backwards/);
  });

  test('RULE 3 — THE ONE THE WATERMARKS MISS: both agree, and the ids do not', () => {
    // The upstream never held 10,001 prompts, so the low watermark is 0 in
    // BOTH epochs; and it processed more work after the restart than before,
    // so the high watermark rose. Every watermark reads continuous. The
    // prompt ids are the only thing that contradicts it.
    const prev = stateOf(bracket({ window: reading([[0, 'p0'], [1, 'p1'], [2, 'p2']]) }));
    const next = bracket({
      window: reading([[0, 'q0'], [1, 'q1'], [2, 'q2'], [3, 'q3'], [4, 'q4']]),
    });
    assert.ok(next.window.low !== null && prev.low !== null && next.window.low >= prev.low);
    assert.ok(next.window.high !== null && prev.high !== null && next.window.high > prev.high);
    const r = compareEpoch(prev, next);
    assert.equal(r.observation.upstream_continuity, 'restarted');
    assert.match(r.reason, /witnessed prompt id\(s\) are gone/);
  });

  test('RULE 0 — a different install answering the address breaks continuity', () => {
    const prev = stateOf(bracket({ identity: 'sha256:install-A', window: reading([[0, 'p0']]) }));
    const r = compareEpoch(
      prev,
      bracket({ identity: 'sha256:install-B', window: reading([[0, 'p0']]) }),
    );
    assert.equal(r.observation.upstream_continuity, 'restarted');
    assert.match(r.reason, /upstream identity changed/);
  });

  test('CONTROL — none of the four fires on an upstream that just kept working', () => {
    const prev = stateOf(bracket({ window: reading([[0, 'p0'], [1, 'p1']]) }));
    const r = compareEpoch(
      prev,
      bracket({ window: reading([[0, 'p0'], [1, 'p1'], [2, 'p2']]) }),
    );
    assert.equal(r.observation.upstream_continuity, 'continuous');
    assert.equal(r.observation.upstream_uncaptured_reason, 'enumerated');
    assert.equal(r.observation.upstream_epoch, prev.epoch);
  });

  test('a turnover big enough to explain the loss is `unknown`, NOT `restarted`', () => {
    // 2 witnessed ids, and the high watermark advanced by 40. Legitimate
    // turnover explains their absence as well as a reset does, so nobody
    // established which — and `unknown` is the honest answer with the
    // operator signal attached.
    const prev = stateOf(bracket({ window: reading([[0, 'p0'], [1, 'p1']]) }));
    const r = compareEpoch(prev, bracket({ window: reading([[40, 'q40'], [41, 'q41']]) }));
    assert.equal(r.observation.upstream_continuity, 'unknown');
    assert.equal(r.observation.upstream_uncaptured_reason, 'evicted_or_restarted');
    assert.match(r.reason, /shorten the poll interval/);
  });

  test('AND THE UNDECIDABLE CASE IS `unknown`, never `continuous`', () => {
    // An idle upstream and a restarted idle upstream are the SAME READING.
    // Saying `continuous` here is exactly "letting a restart look like a
    // quiet afternoon", which is the sentence this work order is written
    // against.
    const prev = stateOf(bracket({ window: reading([]) }));
    const r = compareEpoch(prev, bracket({ window: reading([]) }));
    assert.equal(r.observation.upstream_continuity, 'unknown');
    assert.match(r.reason, /a restarted idle upstream are the same reading/);
  });

  test('a failed read is `unknown` / `history_unavailable`, and does NOT clear the anchors', () => {
    const prev = stateOf(bracket({ window: reading([[7, 'p7']]) }));
    const failed: BracketedRead = {
      identity: null,
      identityOk: false,
      open: { ok: false, low: null, high: null, anchors: [], error: 'ECONNREFUSED' },
      window: { ok: false, low: null, high: null, anchors: [], error: 'ECONNREFUSED' },
      close: { ok: false, low: null, high: null, anchors: [], error: 'ECONNREFUSED' },
    };
    const r = compareEpoch(prev, failed);
    assert.equal(r.observation.upstream_continuity, 'unknown');
    assert.equal(r.observation.upstream_uncaptured_reason, 'history_unavailable');
    assert.equal(r.observation.upstream_source, 'unknown');
    // A failed poll is not evidence of a restart. Dropping the anchors would
    // manufacture a discontinuity at the next successful poll.
    assert.deepEqual(r.next.anchors, prev.anchors);
    assert.equal(r.next.epoch, prev.epoch);
    // ...and the very next successful poll must therefore read `continuous`.
    const back = compareEpoch(r.next, bracket({ window: reading([[7, 'p7'], [8, 'p8']]) }));
    assert.equal(back.observation.upstream_continuity, 'continuous');
  });

  test('an epoch that could not be pinned is RE-PINNED, not re-baselined', () => {
    // The bracket right after a restart finds an EMPTY ring, so mintEpoch has
    // nothing to pin and the state carries `epoch: null`. Treating that as a
    // first poll would throw the prior anchors away and the restart would
    // vanish one bracket after it was found.
    const prev = stateOf(bracket({ window: reading([[0, 'p0'], [1, 'p1']]) }));
    const emptied = compareEpoch(prev, bracket({ window: reading([]) }));
    assert.equal(emptied.observation.upstream_continuity, 'restarted');
    assert.equal(emptied.next.epoch, null);
    assert.deepEqual(emptied.next.anchors, []);
    const refilled = compareEpoch(emptied.next, bracket({ window: reading([[0, 'q0']]) }));
    assert.ok(refilled.next.epoch?.startsWith('epoch:'));
    assert.notEqual(refilled.next.epoch, prev.epoch);
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * 3 · BOTH ENDS OF THE QUERY
 * ════════════════════════════════════════════════════════════════════════ */

describe('WO-C5 — the low watermark is recorded at BOTH ends of the bracket', () => {
  test('eviction DURING the enumeration makes the absence set not a closure', () => {
    // `/history` is paged and non-atomic (server.py:888-900 →
    // execution.py:1282) and `task_done` evicts between pages. One reading
    // cannot tell "these were never there" from "these left while I read".
    const prev = stateOf(
      bracket({ window: reading([[10, 'p10'], [11, 'p11']]) }),
    );
    const r = compareEpoch(
      prev,
      {
        identity: 'sha256:install-A',
        identityOk: true,
        open: oneLow(10, 'p10'),
        window: reading([[11, 'p11'], [12, 'p12']]),
        close: oneLow(11, 'p11'),
      },
    );
    assert.equal(r.observation.upstream_continuity, 'continuous');
    assert.equal(r.observation.upstream_low_watermark_open, 10);
    assert.equal(r.observation.upstream_low_watermark_close, 11);
    assert.equal(r.observation.upstream_uncaptured_reason, 'evicted_or_restarted');
    assert.match(r.reason, /DURING the bracket/);
  });

  test('CONTROL — a bracket whose ends agree reports `enumerated`', () => {
    const prev = stateOf(bracket({ window: reading([[10, 'p10'], [11, 'p11']]) }));
    const r = compareEpoch(prev, {
      identity: 'sha256:install-A',
      identityOk: true,
      open: oneLow(10, 'p10'),
      window: reading([[10, 'p10'], [11, 'p11'], [12, 'p12']]),
      close: oneLow(10, 'p10'),
    });
    assert.equal(r.observation.upstream_uncaptured_reason, 'enumerated');
    assert.equal(r.observation.upstream_low_watermark_open, 10);
    assert.equal(r.observation.upstream_low_watermark_close, 10);
  });

  test('eviction BETWEEN polls is also reported, and it is the same signal', () => {
    const prev = stateOf(bracket({ window: reading([[10, 'p10'], [11, 'p11']]) }));
    const r = compareEpoch(prev, bracket({ window: reading([[11, 'p11'], [12, 'p12']]) }));
    assert.equal(r.observation.upstream_continuity, 'continuous');
    assert.equal(r.observation.upstream_uncaptured_reason, 'evicted_or_restarted');
    assert.match(r.reason, /between polls/);
  });

  test('the tracker really issues four requests, with the oldest read at both ends', async () => {
    const seen: string[] = [];
    const t = new UpstreamTracker({
      upstreamUrl: 'http://upstream.invalid',
      pollIntervalMs: 3_600_000,
      maxReadingAgeMs: 3_600_000,
      anchorWindow: 8,
      fetchImpl: (async (u: string) => {
        seen.push(new URL(String(u)).pathname + new URL(String(u)).search);
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      }) as unknown as typeof fetch,
    });
    await t.poll();
    assert.deepEqual(seen, [
      '/system_stats',
      // offset=0 walks the dict from the FRONT: this IS the low watermark.
      '/history?max_items=1&offset=0',
      // `max_items` alone returns the NEWEST, because offset defaults to -1
      // and becomes `len - max_items` (execution.py:1285-1286).
      '/history?max_items=8',
      '/history?max_items=1&offset=0',
    ]);
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * 4 · THE HISTORY PARSER, AND WHAT A TENANT CAN DO TO IT
 * ════════════════════════════════════════════════════════════════════════ */

describe('WO-C5 — parsing /history, and the tenant-controlled `number`', () => {
  test('the queue tuple is read the way task_done wrote it', () => {
    // execution.py:1237-1242 — history[prompt[1]]["prompt"] is the queue
    // tuple, so prompt[0] is the number and prompt[1] is the id.
    const r = parseHistory({
      'uuid-a': { prompt: [4, 'uuid-a', {}, {}, []], outputs: {}, status: {} },
      'uuid-b': { prompt: [9, 'uuid-b', {}, {}, []], outputs: {}, status: {} },
    });
    assert.equal(r.low, 4);
    assert.equal(r.high, 9);
    assert.deepEqual(r.anchors.map((a) => a.prompt_id).sort(), ['uuid-a', 'uuid-b']);
  });

  test('a non-integer `number` is dropped from the watermark, not carried and not fatal', () => {
    // 🔴 server.py:920 takes the number FROM THE CLIENT:
    // `number = float(json_data['number'])`. A float in the MAC preimage is a
    // MAC that fails unreproducibly (§10 C-1), and aborting the reading would
    // hand a tenant an off switch for the whole signal.
    const r = parseHistory({
      'uuid-a': { prompt: [1.5, 'uuid-a'], outputs: {} },
      'uuid-b': { prompt: [7, 'uuid-b'], outputs: {} },
    });
    assert.equal(r.ok, true);
    assert.equal(r.low, 7);
    assert.equal(r.high, 7);
    // ...and the id is STILL an anchor, because the overlap rule is the part
    // a tenant cannot forge: it cannot make ids it never sent reappear after
    // a reset.
    assert.equal(r.anchors.length, 2);
    assert.ok(r.anchors.some((a) => a.prompt_id === 'uuid-a' && a.number === null));
  });

  test('the overlap rule still works when every number is unusable', () => {
    const prev = stateOf(bracket({ window: reading([[null, 'p0'], [null, 'p1']]) }));
    const same = compareEpoch(prev, bracket({ window: reading([[null, 'p0'], [null, 'p1']]) }));
    assert.equal(same.observation.upstream_continuity, 'continuous');
    const reset = compareEpoch(prev, bracket({ window: reading([[null, 'q0'], [null, 'q1']]) }));
    assert.equal(reset.observation.upstream_continuity, 'restarted');
  });

  test('an id that reappears at a different number is a contradiction of its own', () => {
    const prev = stateOf(bracket({ window: reading([[5, 'p5']]) }));
    const r = compareEpoch(prev, bracket({ window: reading([[5, 'other'], [6, 'p5']]) }));
    assert.equal(r.observation.upstream_continuity, 'restarted');
    assert.match(r.reason, /reappeared at a different number/);
  });

  test('mintEpoch is null for an empty ring, and stable for a given anchor', () => {
    assert.equal(mintEpoch('sha256:x', [], null, null), null);
    const a = mintEpoch('sha256:x', [{ number: 0, prompt_id: 'p' }], 0, 0);
    const b = mintEpoch('sha256:x', [{ number: 0, prompt_id: 'p' }], 0, 0);
    assert.equal(a, b);
    assert.notEqual(a, mintEpoch('sha256:x', [{ number: 0, prompt_id: 'q' }], 0, 0));
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * 5 · STALENESS IS DISCLOSED, NOT ASSUMED
 * ════════════════════════════════════════════════════════════════════════ */

describe('WO-C5 — a reading that no longer covers the interval says so', () => {
  /**
   * One history body PER POLL — not per request. A bracket issues three
   * `/history` calls and an index that advanced per request would silently
   * make the open, the window and the close disagree, which is a different
   * scenario from the one each test below is naming.
   */
  function trackerOver(perPoll: Array<Record<string, unknown>>, now: () => number) {
    let poll = -1;
    let seenInPoll = 0;
    return new UpstreamTracker({
      upstreamUrl: 'http://upstream.invalid',
      pollIntervalMs: 1000,
      maxReadingAgeMs: 2000,
      anchorWindow: 8,
      now,
      fetchImpl: (async (u: string) => {
        const p = new URL(String(u)).pathname;
        if (p === '/system_stats') {
          poll += 1;
          seenInPoll = 0;
          return new Response(JSON.stringify({ system: { os: 'linux' }, devices: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        seenInPoll += 1;
        const body = perPoll[Math.min(poll, perPoll.length - 1)] ?? {};
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as unknown as typeof fetch,
    });
  }

  const hist = (...pairs: Array<[number, string]>) =>
    Object.fromEntries(pairs.map(([n, id]) => [id, { prompt: [n, id], outputs: {} }]));

  test('a fresh bracket describes the leaf; a stale one does not', async () => {
    const clock = 1_000_000;
    const t = trackerOver([hist([0, 'p0']), hist([0, 'p0'])], () => clock);
    await t.poll();
    await t.poll();
    const fresh = t.observationFor(clock + 500);
    assert.equal(fresh.observation.upstream_continuity, 'continuous');
    assert.equal(fresh.observation.upstream_uncaptured_reason, 'enumerated');

    // The same reading, five seconds later. It is REAL — the identity and the
    // epoch are facts about a past bracket and stay true of it — but it does
    // not cover this leaf's interval, and a restart inside the gap would be
    // invisible to it.
    const stale = t.observationFor(clock + 5_000);
    assert.equal(stale.observation.upstream_continuity, 'unknown');
    assert.equal(stale.observation.upstream_uncaptured_reason, 'interval_not_covered');
    assert.equal(stale.observation.upstream_epoch, fresh.observation.upstream_epoch);
    assert.match(stale.reason, /beyond the 2000ms bound/);
  });

  test('a tracker that has not completed a bracket says `not_queried`, not `enumerated`', () => {
    const t = trackerOver([], () => 1);
    assert.deepEqual(t.observationFor(1).observation, UNQUERIED_UPSTREAM);
  });

  test('CONTROL — a HELD discontinuity outranks staleness', async () => {
    // A measured restart is a measured restart whatever the age of the newest
    // bracket. Reporting `interval_not_covered` over the top of it would
    // suppress the one fact the leaf exists to carry.
    const clock = 1_000_000;
    const t = trackerOver([hist([0, 'p0']), hist([0, 'p0']), {}], () => clock);
    await t.poll();
    await t.poll();
    await t.poll();
    const held = t.observationFor(clock + 60_000);
    assert.equal(held.observation.upstream_continuity, 'restarted');
    assert.equal(held.observation.upstream_uncaptured_reason, 'evicted_or_restarted');
  });

  test('THE REASON THE HOLD EXISTS: it survives the clean polls that follow', async () => {
    // Without the hold, a restart detected at 12:00:03 would be reported for
    // one poll window and then go quiet — in the log and on no leaf at all,
    // which is this work order's own defect one level up. A leaf's interval
    // runs from the previous emission to this one, and the poll cadence has
    // nothing to do with it.
    const clock = 1_000_000;
    const t = trackerOver(
      [
        hist([0, 'p0']), //  poll 0 — baseline
        hist([0, 'p0']), //  poll 1 — continuous
        {}, //               poll 2 — THE RESTART: an empty ring
        hist([0, 'q0']), //  poll 3 — the new run's first prompt
        hist([0, 'q0'], [1, 'q1']), // poll 4 — clean, and CONTINUOUS
      ],
      () => clock,
    );
    for (let i = 0; i < 5; i++) await t.poll();
    // The NEWEST reading says `continuous`. The leaf still says `restarted`,
    // because the discontinuity is inside the interval this leaf closes.
    assert.equal(t.readings[4]!.observation.upstream_continuity, 'continuous');
    const taken = t.observationFor(clock);
    assert.equal(taken.observation.upstream_continuity, 'restarted');
    assert.match(taken.reason, /a leaf's interval runs from the previous emission/);

    // ...and once an emission has taken it, the next leaf reports what the
    // newest bracket actually found. Otherwise every subsequent leaf would
    // read as a further restart.
    assert.equal(t.observationFor(clock).observation.upstream_continuity, 'continuous');
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * 6 · THE GATE — a real component, a real restart, and its control
 * ════════════════════════════════════════════════════════════════════════ */

describe('WO-C5 GATE — restart the upstream mid-session and the flag is raised', () => {
  async function session(restart: boolean) {
    const root = fs.mkdtempSync(path.join(OWN_DIR, restart ? 'gate-' : 'control-'));
    const stateDir = path.join(root, 'state');
    const outputVolume = path.join(root, 'output');
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(outputVolume, { recursive: true });
    const comfy = await M.startStubComfyUI(path.join(root, 'comfy'));
    const ingest = await startIngest();
    const comp = await M.CaptureComponent.start(
      componentConfig({ stateDir, outputVolume, apiBaseUrl: ingest.url, upstreamUrl: comfy.url }),
      { identity: identityFor(stateDir), log: () => {} },
    );

    const prompt = async (i: number) => {
      await fetch(`http://127.0.0.1:${comp.port}/prompt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ 1: { class_type: 'SaveImage', inputs: { filename_prefix: `g${i}` } } }),
      });
    };

    const leaves: Array<Record<string, unknown>> = [];
    const emit = async (name: string) => {
      // Straight into the sink, so the leaf's fields are the subject and no
      // proxy timing is. Both halves of the run use the identical call.
      await comp.submitter.emit({
        surface: 'network-gate',
        hook: 'artifact.produced',
        observedAt: new Date().toISOString(),
        correlationId: null,
        bytes: {
          contentHash: crypto.createHash('sha256').update(name).digest('hex'),
          sizeBytes: 1,
          mime: 'image/png',
          fidelity: 'as-delivered',
        },
        evidence: {},
      } as never);
      leaves.push(
        (ingest.received[ingest.received.length - 1] ?? {}) as Record<string, unknown>,
      );
    };

    // Three prompts, a bracket, three leaves.
    for (let i = 0; i < 3; i++) await prompt(i);
    await comp.upstream.poll();
    await emit('a');
    await comp.upstream.poll();
    await emit('b');

    if (restart) await comfy.restart();

    // The same amount of work on the other side of the (non-)restart.
    for (let i = 3; i < 6; i++) await prompt(i);
    await comp.upstream.poll();
    await emit('c');
    await comp.upstream.poll();
    await emit('d');

    await comp.stop();
    await ingest.close();
    await comfy.close();
    return leaves.map((l) => (l.capture ?? {}) as Record<string, unknown>);
  }

  test('THE GATE: a restarted session raises `restarted`; THE CONTROL does not', async () => {
    const restarted = await session(true);
    const control = await session(false);

    const flagged = (ls: Array<Record<string, unknown>>) =>
      ls.filter((c) => c.upstream_continuity === 'restarted');
    const epochs = (ls: Array<Record<string, unknown>>) =>
      new Set(ls.map((c) => String(c.upstream_epoch)));

    // THE GATE.
    assert.ok(
      flagged(restarted).length >= 1,
      `no leaf carried \`restarted\`: ${JSON.stringify(restarted.map((c) => c.upstream_continuity))}`,
    );
    // ...and the flag comes with the reason that makes an absence set
    // untrustworthy, not just a status.
    assert.equal(flagged(restarted)[0]!.upstream_uncaptured_reason, 'evicted_or_restarted');
    assert.equal(flagged(restarted)[0]!.upstream_source, 'measured');
    // The DURABLE half: the epoch changes permanently, so two leaves from
    // either side of the restart disagree about which run produced them long
    // after the transient flag has cleared.
    assert.ok(epochs(restarted).size > 1);

    // THE CONTROL — same length, same work, no restart.
    assert.equal(
      flagged(control).length,
      0,
      `the control fired: ${JSON.stringify(control.map((c) => c.upstream_continuity))}`,
    );
    assert.equal(epochs(control).size, 1);
    // ANTI-VACUITY: the control must not be silently emitting nothing at all.
    assert.equal(control.length, 4);
    assert.ok(control.every((c) => c.upstream_source === 'measured'));
    assert.ok(control.some((c) => c.upstream_continuity === 'continuous'));
  });

  test('CONTROL FOR THE CONTROL: /system_stats did not change across that restart', async () => {
    // Asserted against the same stub the gate drives. If a future ComfyUI
    // added a boot id, this test fails and the epoch machinery becomes
    // belt-and-braces rather than the only signal — which is a fact worth
    // finding out from a red test rather than from a code review.
    const comfy = await M.startStubComfyUI(fs.mkdtempSync(path.join(OWN_DIR, 'ctl-')));
    try {
      const a = upstreamIdentityOf(await (await fetch(`${comfy.url}/system_stats`)).json());
      await comfy.restart();
      const b = upstreamIdentityOf(await (await fetch(`${comfy.url}/system_stats`)).json());
      assert.equal(a, b);
    } finally {
      await comfy.close();
    }
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * 7 · THE LOOP IS CLOSED — what the component emits, the route accepts
 * ════════════════════════════════════════════════════════════════════════ */

describe('WO-C5 — the component and the validator agree', () => {
  test('every shape a real restarted session produces is ACCEPTED by the route', async () => {
    // The gate above posts to a dumb ingest. This test takes the SAME shapes
    // and puts them through `validateCaptureClaims` via the real route, so a
    // rule that refuses what the component actually emits shows up here
    // rather than in production. It caught one: a first draft refused
    // `enumerated` with both watermarks null, which is what an EMPTY history
    // ring legitimately reads as — and an empty ring is exactly what the
    // bracket after a restart finds.
    const shapes: Array<Record<string, unknown>> = [
      // pre-restart, steady
      { upstream_continuity: 'continuous', upstream_uncaptured_reason: 'enumerated', upstream_source: 'measured', upstream_low_watermark_open: 0, upstream_low_watermark_close: 0 },
      // the restart itself, on an empty ring — no epoch, no watermarks
      { upstream_continuity: 'restarted', upstream_uncaptured_reason: 'evicted_or_restarted', upstream_source: 'measured', upstream_epoch: null, upstream_low_watermark_open: null, upstream_low_watermark_close: null },
      // the window after it, before prompts resume
      { upstream_continuity: 'unknown', upstream_uncaptured_reason: 'enumerated', upstream_source: 'measured', upstream_epoch: null, upstream_low_watermark_open: null, upstream_low_watermark_close: null },
      // a stale bracket
      { upstream_continuity: 'unknown', upstream_uncaptured_reason: 'interval_not_covered', upstream_source: 'measured' },
      // the upstream is down
      { upstream_continuity: 'unknown', upstream_uncaptured_reason: 'history_unavailable', upstream_source: 'unknown', upstream_identity: null, upstream_epoch: null, upstream_low_watermark_open: null, upstream_low_watermark_close: null },
      // a placement with no upstream to ask
      { ...UNQUERIED_UPSTREAM },
    ];
    const id = provision();
    for (const [i, over] of shapes.entries()) {
      const res = await M.POST(witnessReq(submission(id, nextCounter++, captureBlock(over))));
      assert.equal(res.status, 201, `shape ${i}: ${await res.text()}`);
    }
  });

  test('and the row records what the component said', async () => {
    const id = provision();
    const body = submission(
      id,
      nextCounter++,
      captureBlock({
        upstream_continuity: 'restarted',
        upstream_uncaptured_reason: 'evicted_or_restarted',
        upstream_low_watermark_open: 4096,
        upstream_low_watermark_close: 4103,
      }),
    );
    assert.equal((await M.POST(witnessReq(body))).status, 201);
    const row = M.conn()
      .prepare(
        `SELECT upstream_identity, upstream_epoch, upstream_continuity,
                upstream_low_watermark_open, upstream_low_watermark_close,
                upstream_uncaptured_reason, upstream_source
           FROM iterations WHERE component_id = ? ORDER BY id DESC LIMIT 1`,
      )
      .get(id) as Record<string, unknown>;
    assert.equal(row.upstream_continuity, 'restarted');
    assert.equal(row.upstream_uncaptured_reason, 'evicted_or_restarted');
    assert.equal(row.upstream_low_watermark_open, 4096);
    assert.equal(row.upstream_low_watermark_close, 4103);
    assert.equal(row.upstream_source, 'measured');
    assert.equal(row.upstream_epoch, 'epoch:' + '9a'.repeat(16));
  });

  test('a legacy leaf with no capture block leaves the columns NULL, not `not_queried`', async () => {
    const id = provision();
    assert.equal((await M.POST(witnessReq(submission(id, nextCounter++, null)))).status, 201);
    const row = M.conn()
      .prepare(
        `SELECT upstream_continuity, upstream_uncaptured_reason, upstream_source
           FROM iterations WHERE component_id = ? ORDER BY id DESC LIMIT 1`,
      )
      .get(id) as Record<string, unknown>;
    // NULL is "the question was never asked of this leaf"; 'not_queried' is
    // "asked, and there was nothing to ask". Defaulting the first into the
    // second would manufacture an answer nobody gave.
    assert.equal(row.upstream_continuity, null);
    assert.equal(row.upstream_uncaptured_reason, null);
    assert.equal(row.upstream_source, null);
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * 8 · RULE 6 — the validator, not the prose
 * ════════════════════════════════════════════════════════════════════════ */

describe('WO-C5 — what a leaf is entitled to say about its upstream', () => {
  const refusal = async (over: Record<string, unknown> | null, code: string, extra = {}) => {
    const id = provision();
    const cap = over === null ? captureBlock() : captureBlock(over);
    if (over === null) {
      for (const k of Object.keys(cap)) if (k.startsWith('upstream_')) delete cap[k];
    }
    const res = await M.POST(witnessReq(submission(id, nextCounter++, cap, extra)));
    const body = (await res.json()) as { error: { code: string; message: string } };
    assert.equal(res.status, 422, JSON.stringify(body));
    assert.equal(body.error.code, code, body.error.message);
    return body.error.message;
  };

  test('(a) a capture-bearing leaf with NO upstream fields is refused', async () => {
    const m = await refusal(null, 'upstream_epoch_required');
    assert.match(m, /masquerades as a normal short history/);
  });

  test('(a) a malformed continuity is refused', async () => {
    await refusal({ upstream_continuity: 'probably-fine' }, 'upstream_epoch_required');
  });

  test('(b) `continuous` on an unmeasured source is refused', async () => {
    await refusal(
      { upstream_continuity: 'continuous', upstream_source: 'unknown', upstream_uncaptured_reason: 'not_queried', upstream_epoch: null, upstream_low_watermark_open: null, upstream_low_watermark_close: null },
      'upstream_epoch_refused',
    );
  });

  test('(b) and so is `restarted` on one — an alarm nobody rang', async () => {
    const m = await refusal(
      { upstream_continuity: 'restarted', upstream_source: 'unknown', upstream_uncaptured_reason: 'history_unavailable' },
      'upstream_epoch_refused',
    );
    assert.match(m, /an alarm nobody rang/);
  });

  test('(d) THE COUNCIL\'S CONDITION: `evicted_or_restarted` on an unmeasured source is refused', async () => {
    // "otherwise the volatile source degrades to unknown for both the
    // recoverable and unrecoverable cases and you lose the only signal that
    // would tell an operator to shorten their query interval."
    const m = await refusal(
      { upstream_continuity: 'unknown', upstream_source: 'unknown', upstream_uncaptured_reason: 'evicted_or_restarted' },
      'upstream_epoch_refused',
    );
    assert.match(m, /shorten their query interval/);
  });

  test('(d) `enumerated` on an unmeasured source is an enumeration nobody performed', async () => {
    await refusal(
      { upstream_continuity: 'unknown', upstream_source: 'unknown', upstream_uncaptured_reason: 'enumerated' },
      'upstream_epoch_refused',
    );
  });

  test('(e) `not_queried` with an epoch is refused', async () => {
    await refusal(
      { upstream_continuity: 'unknown', upstream_source: 'unknown', upstream_uncaptured_reason: 'not_queried', upstream_epoch: 'epoch:' + '11'.repeat(16), upstream_low_watermark_open: null, upstream_low_watermark_close: null },
      'upstream_epoch_refused',
    );
  });

  test('(e) `not_queried` with a watermark is refused too', async () => {
    await refusal(
      { upstream_continuity: 'unknown', upstream_source: 'unknown', upstream_uncaptured_reason: 'not_queried', upstream_epoch: null, upstream_low_watermark_open: 3, upstream_low_watermark_close: 3 },
      'upstream_epoch_refused',
    );
  });

  test('a float watermark is refused — a float in the preimage is an unreproducible MAC', async () => {
    // ⚑ THE FLOAT IS PUT ON THE WIRE AFTER THE MAC, and it has to be: the
    // ratchet itself refuses to MAC one (`canonicalPreimage: float value for
    // "upstream_low_watermark_open"`, lib/ratchet/ratchet.ts:226), so a
    // component CANNOT send this shape. What can send it is anything between
    // the component and the route, and rule 6 is what refuses it there —
    // before `componentPreimage()` is asked to canonicalise a value that
    // would throw. Two guards, and this test exercises the second.
    const id = provision();
    const body = submission(
      id,
      nextCounter++,
      captureBlock({ upstream_low_watermark_open: 1 }),
    ) as { capture: Record<string, unknown> };
    body.capture.upstream_low_watermark_open = 1.5;
    const res = await M.POST(witnessReq(body));
    const err = (await res.json()) as { error: { code: string; message: string } };
    assert.equal(res.status, 422);
    assert.equal(err.error.code, 'upstream_epoch_refused');
    assert.match(err.error.message, /safe integer/);
  });

  test('...and the ratchet refuses to MAC one in the first place', () => {
    assert.throws(
      () => submission(provision(), 0, captureBlock({ upstream_low_watermark_close: 2.5 })),
      /float value for "upstream_low_watermark_close"/,
    );
  });

  test('(f) an upstream field sent ONE LEVEL UP is refused, not ignored', async () => {
    // `componentPreimage()` reads them out of `capture`, so a copy at the top
    // level is outside the MAC while looking exactly like a signed
    // measurement.
    await refusal({}, 'upstream_epoch_refused', { upstream_continuity: 'continuous' });
  });

  test('ANTI-VACUITY: `unknown` WITH `measured` is ACCEPTED, unlike the storage pair', async () => {
    // Migration 056 refuses the analogous storage pair and this rule
    // deliberately does not, because the facts differ. A storage `unknown`
    // means the stat failed. An upstream `unknown` is frequently the
    // CONCLUSION of a measurement: an idle history at both ends genuinely
    // cannot distinguish a restart from a quiet afternoon. Refusing it would
    // force a component that looked and found that out to lie.
    const id = provision();
    const res = await M.POST(
      witnessReq(
        submission(
          id,
          nextCounter++,
          captureBlock({
            upstream_continuity: 'unknown',
            upstream_source: 'measured',
            upstream_uncaptured_reason: 'enumerated',
          }),
        ),
      ),
    );
    assert.equal(res.status, 201, await res.text());
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * 9 · THE FIELDS ARE INSIDE THE MAC
 * ════════════════════════════════════════════════════════════════════════ */

describe('WO-C5 — the epoch is INSIDE the MAC', () => {
  test('rewriting `upstream_continuity` in flight invalidates the signature', async () => {
    const id = provision();
    const body = submission(
      id,
      nextCounter++,
      captureBlock({ upstream_continuity: 'restarted', upstream_uncaptured_reason: 'evicted_or_restarted' }),
    ) as { capture: Record<string, unknown> };
    // A proxy between the component and the route, quietly turning a restart
    // back into a quiet afternoon. It cannot: the value is in the preimage.
    body.capture.upstream_continuity = 'continuous';
    const res = await M.POST(witnessReq(body));
    assert.equal(res.status, 422);
    assert.equal((await res.json()).error.code, 'component_unverified');
  });

  test('so does rewriting the epoch', async () => {
    const id = provision();
    const body = submission(id, nextCounter++, captureBlock()) as {
      capture: Record<string, unknown>;
    };
    body.capture.upstream_epoch = 'epoch:' + '00'.repeat(16);
    const res = await M.POST(witnessReq(body));
    assert.equal(res.status, 422);
    assert.equal((await res.json()).error.code, 'component_unverified');
  });

  test('so does moving a low watermark by one', async () => {
    const id = provision();
    const body = submission(id, nextCounter++, captureBlock()) as {
      capture: Record<string, unknown>;
    };
    body.capture.upstream_low_watermark_close = 4097;
    const res = await M.POST(witnessReq(body));
    assert.equal(res.status, 422);
    assert.equal((await res.json()).error.code, 'component_unverified');
  });

  test('ANTI-VACUITY: rewriting a field deliberately NOT in the preimage still passes', async () => {
    const id = provision();
    const body = submission(id, nextCounter++, captureBlock()) as {
      capture: Record<string, unknown>;
    };
    // If this one were refused too, the three above would be measuring the
    // MAC's sensitivity to any edit rather than to these fields.
    body.capture.fs_diagnostic = 'fs-watch-quiescence';
    const res = await M.POST(witnessReq(body));
    assert.equal(res.status, 201, await res.text());
  });
});
