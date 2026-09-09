// WO-E2 — `declared_uncaptured`: the absence set, and the scope it enumerated
// over.
//
// WO-C5 built the machinery and stopped here on purpose, because the scope
// rule was unsettled (`council-impl/WO-C5.md` §10). Round 5 §3 put the
// question as: "must `declared_uncaptured` carry the scope it enumerated over
// — which root types were configured, and whether any were `unspecified` — or
// does it assert a closure it does not have?" `docs/canon/DECLARED_UNCAPTURED.md`
// is the settled answer and was committed before any of this code.
//
// EVERY GATE IN THIS FILE HAS A CONTROL NAMED BESIDE IT.
//
//   THE GATE     an upstream produces an artifact the component did not
//                capture, and a leaf NAMES it with a scope that says what was
//                looked at.
//   CONTROL 1    a run with nothing uncaptured produces an EMPTY SET THAT IS
//                PRESENT — count 0, document present — never an absent field.
//                The two mean different things.
//   CONTROL 2    a run whose configured roots do not cover the output
//                directory REFUSES TO CLAIM CLOSURE, because it cannot have
//                one.
//
//   AND THE CONTROL FOR THE CONTROLS, which a first pass drops: the
//                `complete` value must be REACHABLE. A closure condition that
//                can never hold makes `partial` a constant and the whole
//                field a test that cannot fail — the exact shape WO-C5 refused
//                for `/system_stats`. §2 asserts `complete` on a real run.
//
// TEST ISOLATION follows upstream-epoch.test.ts: a private database assigned
// at module top level, everything reaching lib/db/sqlite imported dynamically
// inside before().

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
import { DEFAULT_UPSTREAM_ANCHOR_WINDOW } from '../../lib/capture/upstreamEpoch';
import type { UpstreamObservation } from '../../lib/capture/upstreamEpoch';
import {
  C8_TYPES,
  CapturedLedger,
  NOT_ENUMERATED,
  UNCAPTURED_INDEPENDENT_OBSERVER,
  UNCAPTURED_OBSERVER_BLOCKER_REASON,
  artifactKey,
  artifactsInOutputs,
  buildAbsenceSet,
  hashDeclaredUncaptured,
  type ArtifactRef,
  type ArtifactVolumeType,
  type UncapturedInput,
} from '../../lib/capture/declaredUncaptured';

if (!process.env.SCRUPLE_DB_PATH || !/tmp|test/i.test(process.env.SCRUPLE_DB_PATH)) {
  throw new Error('Refusing to run: set SCRUPLE_DB_PATH to a throwaway path. Use `npm run test:v2`.');
}
const OWN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'scruple-declared-uncaptured-'));
process.env.SCRUPLE_DB_PATH = path.join(OWN_DIR, 'declared-uncaptured.db');
process.env.SCRUPLE_BDK_HEX = 'e2'.repeat(32);
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
  validateCaptureClaims: typeof import('../../lib/leaf/captureClaims').validateCaptureClaims;
  buildMeasurement: typeof import('../../services/scruple-capture/src/build-measurement').buildMeasurement;
  Identity: typeof import('../../services/scruple-capture/src/identity').Identity;
  CaptureComponent: typeof import('../../services/scruple-capture/src/component').CaptureComponent;
  startStubComfyUI: typeof import('../../services/scruple-capture/test-support/stub-comfyui').startStubComfyUI;
  POST: (req: Request) => Promise<Response>;
};

let M: Mod;
const TENANT = 'vendor-e2';
const BUILD = 'sha256:' + 'e2'.repeat(32);
const BASELINE = 'e'.repeat(64);
let API_KEY: string;

/* ────────────────────────────────────────────────────────────────────────
 * Pure-fold fixtures. buildAbsenceSet() takes no clock, no network and no
 * storage, so the four closure conditions are driven by a table.
 * ──────────────────────────────────────────────────────────────────────── */

const UP = (over: Partial<UpstreamObservation> = {}): UpstreamObservation => ({
  upstream_identity: 'sha256:' + 'ef'.repeat(32),
  upstream_epoch: 'epoch:' + '9a'.repeat(16),
  upstream_continuity: 'continuous',
  upstream_low_watermark_open: 0,
  upstream_low_watermark_close: 0,
  upstream_uncaptured_reason: 'enumerated',
  upstream_source: 'measured',
  ...over,
});

const THREE_ROOTS: Array<{ type: ArtifactVolumeType; path: string }> = [
  { type: 'output', path: '/srv/comfy/output' },
  { type: 'temp', path: '/srv/comfy/temp' },
  { type: 'input', path: '/srv/comfy/input' },
];

const ref = (type: ArtifactVolumeType, filename: string, subfolder = ''): ArtifactRef => ({
  type,
  subfolder,
  filename,
});

function fold(over: Partial<UncapturedInput> = {}) {
  const captured = new Set<string>();
  return buildAbsenceSet({
    enumerated: [{ ...ref('output', 'a_00001_.png'), prompt_id: 'p1' }],
    anchorWindow: 64,
    entriesEnumerated: 1,
    roots: THREE_ROOTS,
    isCaptured: (r) => captured.has(artifactKey(r)),
    ledgerIntact: true,
    upstream: UP(),
    ...over,
  });
}

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
    egress: '/view',
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
    upstream_low_watermark_open: 0,
    upstream_low_watermark_close: 0,
    upstream_uncaptured_reason: 'enumerated',
    upstream_source: 'measured',
    host: null,
    host_adapter: null,
    host_evidence_type: null,
    host_semantics: 'blind',
    host_evidence_hash: null,
    // WO-E2. The `not_enumerated` shape is the base; each test overrides.
    ...NOT_ENUMERATED,
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

function provision(): string {
  const { componentId, token } = M.issueProvisioningToken({ tenantId: TENANT, label: 'sidecar' });
  assert.ok(M.redeemProvisioningToken({ token, tenantId: TENANT, buildMeasurement: BUILD }).ok);
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
  const { componentId, token } = M.issueProvisioningToken({ tenantId: TENANT, label: 'e2' });
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

function componentConfig(o: {
  stateDir: string;
  apiBaseUrl: string;
  upstreamUrl: string;
  /** Exactly one of these, as `resolveWatchedVolumes` requires. */
  watchedVolumes?: Array<{ type: ArtifactVolumeType; path: string }>;
  outputVolume?: string;
}) {
  return {
    upstreamUrl: o.upstreamUrl,
    listenHost: '127.0.0.1',
    listenPort: 0,
    ...(o.watchedVolumes ? { watchedVolumes: o.watchedVolumes } : {}),
    ...(o.outputVolume ? { outputVolume: o.outputVolume } : {}),
    stateDir: o.stateDir,
    apiBaseUrl: o.apiBaseUrl,
    apiKey: 'sk_test_e2',
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
    settleMs: 30,
    correlationTtlMs: 60_000,
    heartbeatWindowSeconds: 900,
    // Brackets are driven by hand so nothing races an interval.
    upstreamPollIntervalMs: 3_600_000,
    upstreamMaxReadingAgeMs: 3_600_000,
    upstreamAnchorWindow: DEFAULT_UPSTREAM_ANCHOR_WINDOW,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One generation, and the client retrieves ONLY what `fetchNames` lists. An
 *  artifact ComfyUI reported and nobody fetched is the case the absence set
 *  exists for — round 5 §3's "200 files written, four `/view`s". */
async function generate(
  gateUrl: string,
  graph: Record<string, unknown>,
  fetchNames: Array<{ filename: string; type: string }>,
): Promise<void> {
  const r = await fetch(`${gateUrl}/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(graph),
  });
  await r.json();
  await sleep(120);
  for (const f of fetchNames) {
    const v = await fetch(`${gateUrl}/view?filename=${f.filename}&type=${f.type}&subfolder=`);
    await v.arrayBuffer();
  }
}

before(async () => {
  const [sqlite, migrate, prov, ratchet, bdkMod, preimage, claims, route, bm, identity, component, stub] =
    await Promise.all([
      import('../../lib/db/sqlite'),
      import('../../lib/db/migrate'),
      import('../../lib/ratchet/provisioning'),
      import('../../lib/ratchet/ratchet'),
      import('../../lib/ratchet/bdk'),
      import('../../lib/leaf/componentPreimage'),
      import('../../lib/leaf/captureClaims'),
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
    validateCaptureClaims: claims.validateCaptureClaims,
    buildMeasurement: bm.buildMeasurement,
    Identity: identity.Identity,
    CaptureComponent: component.CaptureComponent,
    startStubComfyUI: stub.startStubComfyUI,
    POST: route.POST as unknown as (req: Request) => Promise<Response>,
  };
  M.runMigrations(false);
  M.conn().prepare(`INSERT INTO users (id, email) VALUES (?, ?)`).run(TENANT, 'e2@example.com');
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
 * 1 · THE ENUMERATION — reading `/history` outputs without an allowlist
 * ════════════════════════════════════════════════════════════════════════ */

describe('WO-E2 — what `/history` says was produced', () => {
  test('a SaveImage output is found under `images`', () => {
    const out = artifactsInOutputs({
      '9': { images: [{ filename: 'A_00001_.png', subfolder: '', type: 'output' }] },
    });
    assert.deepEqual(out, [{ type: 'output', subfolder: '', filename: 'A_00001_.png' }]);
  });

  test('⚑ …and so is a PreviewImage TEMP write, which is round 5 §4(a)', () => {
    const out = artifactsInOutputs({
      '2': { images: [{ filename: 'ComfyUI_temp_x_00001_.png', subfolder: '', type: 'temp' }] },
    });
    assert.equal(out[0]!.type, 'temp');
  });

  test('ANTI-VACUITY: a key that is not `images` is found too — no allowlist', () => {
    // VideoHelperSuite's `gifs`, SaveAudio's `audio`, and a vendor node's own
    // key. WO-27 is what an enumeration used as a boundary costs: a class that
    // does not match is not "unknown", it is silently not an artifact, and the
    // absence set then omits exactly what nobody thought of.
    const out = artifactsInOutputs({
      '1': { gifs: [{ filename: 'a.webp', subfolder: '', type: 'output' }] },
      '2': { audio: [{ filename: 'b.flac', subfolder: 'sub', type: 'temp' }] },
      '3': { vendor_widgets: [{ filename: 'c.bin', subfolder: '', type: 'output' }] },
    });
    assert.deepEqual(out.map((a) => a.filename).sort(), ['a.webp', 'b.flac', 'c.bin']);
  });

  test('a reference with no recognisable `type` reads `unspecified`, never guessed', () => {
    const out = artifactsInOutputs({ '1': { images: [{ filename: 'x.png' }] } });
    assert.equal(out[0]!.type, 'unspecified');
  });

  test('a node that produced nothing contributes nothing, and does not throw', () => {
    assert.deepEqual(artifactsInOutputs({}), []);
    assert.deepEqual(artifactsInOutputs(null), []);
    assert.deepEqual(artifactsInOutputs({ '1': { images: [] } }), []);
    assert.deepEqual(artifactsInOutputs({ '1': { text: ['not a record'] } }), []);
  });

  test('the two halves that name an artifact produce the SAME key', () => {
    // `/view?filename=X&type=output&subfolder=s` and a file at
    // `<output root>/s/X`. If these disagreed the diff would be a comparison
    // of two naming schemes rather than of two sets.
    assert.equal(
      artifactKey({ type: 'output', subfolder: 's', filename: 'X.png' }),
      artifactKey({ type: 'output', subfolder: '/s/', filename: 'X.png' }),
    );
    assert.notEqual(
      artifactKey({ type: 'output', subfolder: '', filename: 'X.png' }),
      artifactKey({ type: 'temp', subfolder: '', filename: 'X.png' }),
    );
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * 2 · THE FOUR CLOSURE CONDITIONS, AS A TABLE
 * ════════════════════════════════════════════════════════════════════════ */

describe('WO-E2 — the closure rule, condition by condition', () => {
  test('⚑ `complete` IS REACHABLE — the control for every control below', () => {
    // A condition that can never hold makes `partial` a constant and this
    // whole field a test that cannot fail. WO-C5 refused exactly that shape
    // for a /system_stats-based restart detector.
    const r = fold();
    assert.equal(r.observation.uncaptured_scope, 'complete');
    assert.deepEqual(r.document!.completeness.reasons, []);
    assert.deepEqual(r.document!.completeness.conditions, {
      roots_cover_c8: true,
      history_enumerated: true,
      window_unsaturated: true,
      ledger_intact: true,
    });
  });

  test('condition 1 — a MISSING typed root refuses closure', () => {
    const r = fold({ roots: [{ type: 'output', path: '/srv/comfy/output' }] });
    assert.equal(r.observation.uncaptured_scope, 'partial');
    assert.equal(r.document!.completeness.conditions.roots_cover_c8, false);
    assert.deepEqual(r.document!.scope.missing_types, ['temp', 'input']);
    assert.match(r.document!.completeness.reasons[0]!, /missing: temp, input/);
  });

  test('condition 1 — and so does an `unspecified` root, even with all three present', () => {
    const r = fold({ roots: [...THREE_ROOTS, { type: 'unspecified', path: '/srv/other' }] });
    assert.equal(r.observation.uncaptured_scope, 'partial');
    assert.equal(r.document!.scope.unspecified_roots, 1);
    assert.match(r.document!.completeness.reasons[0]!, /unspecified/);
  });

  test("condition 2 — WO-C5's reason doing the job it was built for", () => {
    for (const reason of ['evicted_or_restarted', 'interval_not_covered'] as const) {
      const r = fold({ upstream: UP({ upstream_uncaptured_reason: reason }) });
      assert.equal(r.observation.uncaptured_scope, 'partial', reason);
      assert.equal(r.document!.completeness.conditions.history_enumerated, false);
      // ⚑ AND THE ENUMERATION IS KEPT. §5 of the design doc: the read
      // succeeded and returned artifacts that really were not captured;
      // discarding them would delete measured facts to avoid a claim nobody
      // was making.
      assert.equal(r.observation.declared_uncaptured_count, 1);
      assert.equal(r.document!.artifacts.length, 1);
    }
  });

  test('condition 3 — a SATURATED window refuses closure', () => {
    const r = fold({ anchorWindow: 4, entriesEnumerated: 4 });
    assert.equal(r.observation.uncaptured_scope, 'partial');
    assert.equal(r.document!.scope.history_window.saturated, true);
    assert.match(r.document!.completeness.reasons[0]!, /truncated the ring/);

    // …and one below the window is not saturated.
    assert.equal(fold({ anchorWindow: 4, entriesEnumerated: 3 }).observation.uncaptured_scope, 'complete');
  });

  test('condition 4 — an EVICTED ledger refuses closure rather than accusing', () => {
    const r = fold({ ledgerIntact: false });
    assert.equal(r.observation.uncaptured_scope, 'partial');
    assert.match(r.document!.completeness.reasons[0]!, /evicted/);
  });

  test('the scope carries what line 369 asked for, field by field', () => {
    const s = fold().document!.scope;
    assert.deepEqual(s.volume_types.slice().sort(), [...C8_TYPES].sort());
    assert.equal(s.roots.length, 3);
    assert.equal(s.unspecified_roots, 0);
    assert.equal(s.history_window.upstream_uncaptured_reason, 'enumerated');
    assert.equal(s.history_window.anchor_window, 64);
    assert.equal(s.history_window.low_watermark_open, 0);
    assert.equal(s.history_window.low_watermark_close, 0);
    assert.ok(s.history_window.epoch);
  });

  test('round 6 §1 — every member carries `transaction: "none"`', () => {
    // Nothing in this set spent a ratchet counter, so a verifier must not read
    // the counter's delivery-completeness interval as artifact completeness.
    assert.ok(fold().document!.artifacts.every((a) => a.transaction === 'none'));
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * 3 · EMPTY-AND-PRESENT IS NOT ABSENT
 * ════════════════════════════════════════════════════════════════════════ */

describe('WO-E2 — the two states that must never read the same', () => {
  test('nothing uncaptured → count 0, document PRESENT with an empty list', () => {
    const r = fold({ isCaptured: () => true });
    assert.equal(r.observation.declared_uncaptured_count, 0);
    assert.notEqual(r.observation.declared_uncaptured_hash, null);
    assert.deepEqual(r.document!.artifacts, []);
    assert.equal(r.observation.uncaptured_enumeration_method, 'live_history');
  });

  test('nothing enumerated → count NULL, hash NULL, document ABSENT', () => {
    for (const over of [
      { enumerated: null },
      { upstream: UP({ upstream_uncaptured_reason: 'history_unavailable', upstream_source: 'unknown' as const }) },
      { upstream: UP({ upstream_uncaptured_reason: 'not_queried', upstream_source: 'unknown' as const, upstream_epoch: null }) },
    ] as Array<Partial<UncapturedInput>>) {
      const r = fold(over);
      assert.deepEqual(r.observation, NOT_ENUMERATED);
      assert.equal(r.document, null);
      assert.equal(r.json, null);
    }
  });

  test('⚑ and the two are DIFFERENT OBSERVATIONS, not one with a different count', () => {
    const empty = fold({ isCaptured: () => true }).observation;
    const none = fold({ enumerated: null }).observation;
    assert.notDeepEqual(empty, none);
    assert.equal(empty.uncaptured_scope, 'complete');
    assert.equal(none.uncaptured_scope, 'not_enumerated');
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * 4 · THE INDEPENDENT-OBSERVER BLOCKER
 * ════════════════════════════════════════════════════════════════════════ */

describe('WO-E2 — the completeness has its own source, and today it is `unknown`', () => {
  test('the blocker stands, and it is a named constant rather than a literal', () => {
    assert.equal(UNCAPTURED_INDEPENDENT_OBSERVER, false);
    assert.match(UNCAPTURED_OBSERVER_BLOCKER_REASON, /independent observer/);
  });

  test('so every leaf reads `unknown`, even on a complete scope', () => {
    const r = fold();
    assert.equal(r.observation.uncaptured_scope, 'complete');
    assert.equal(r.observation.uncaptured_scope_source, 'unknown');
    assert.equal(r.document!.completeness.independent_observer, false);
  });

  test('ANTI-VACUITY: flip the flag and the value MOVES — both branches exist', () => {
    const r = fold({ independentObserver: true });
    assert.equal(r.observation.uncaptured_scope_source, 'measured');
    assert.equal(r.document!.completeness.independent_observer, true);
  });

  test('…but `measured` still needs a measurement to be independent OF', () => {
    const r = fold({
      independentObserver: true,
      upstream: UP({ upstream_uncaptured_reason: 'interval_not_covered', upstream_source: 'unknown' }),
    });
    assert.equal(r.observation.uncaptured_scope_source, 'unknown');
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * 5 · THE LEDGER
 * ════════════════════════════════════════════════════════════════════════ */

describe('WO-E2 — the captured-set ledger is bounded and says so', () => {
  test('a recorded artifact is captured; an unrecorded one is not', () => {
    const l = new CapturedLedger();
    l.record(ref('output', 'a.png'));
    assert.equal(l.has(ref('output', 'a.png')), true);
    assert.equal(l.has(ref('temp', 'a.png')), false);
    assert.equal(l.intact, true);
  });

  test('recording the same artifact twice is one entry, not two', () => {
    const l = new CapturedLedger();
    l.record(ref('output', 'a.png'));
    l.record(ref('output', 'a.png'));
    assert.equal(l.size, 1);
  });

  test('⚑ eviction is RECORDED, which is what costs the leaf its closure claim', () => {
    const l = new CapturedLedger(2);
    l.record(ref('output', 'a.png'));
    l.record(ref('output', 'b.png'));
    assert.equal(l.intact, true);
    l.record(ref('output', 'c.png'));
    assert.equal(l.intact, false);
    assert.equal(l.evictedCount, 1);
    // The oldest is gone, so it would now read as uncaptured — which is why
    // the ledger's own bound refuses the closure rather than the accuracy.
    assert.equal(l.has(ref('output', 'a.png')), false);
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * 6 · RULE 8 — SIX REFUSALS AND ONE ACCEPT, AT THE ROUTE
 * ════════════════════════════════════════════════════════════════════════ */

describe('WO-E2 — what a leaf is entitled to say about its absence set', () => {
  const post = async (capture: Record<string, unknown> | null, extra: Record<string, unknown> = {}) => {
    const id = provision();
    const res = await M.POST(witnessReq(submission(id, 0, capture, extra)));
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  test('THE ACCEPT — the `not_enumerated` shape is stored as itself', async () => {
    const r = await post(captureBlock());
    assert.equal(r.status, 201);
    const row = M.conn()
      .prepare(
        `SELECT uncaptured_enumeration_method, uncaptured_scope, uncaptured_scope_source,
                declared_uncaptured_count, declared_uncaptured_hash, declared_uncaptured
           FROM iterations WHERE id = ?`,
      )
      .get(Number(r.body.leaf_id)) as Record<string, unknown>;
    assert.equal(row.uncaptured_scope, 'not_enumerated');
    assert.equal(row.declared_uncaptured_count, null);
    assert.equal(row.declared_uncaptured, null);
  });

  test('(a) ABSENT on a capture-bearing leaf is refused — `not_enumerated` is free', async () => {
    const c = captureBlock();
    delete c.uncaptured_scope;
    const r = await post(c);
    assert.equal(r.status, 422);
    assert.equal((r.body.error as Record<string, unknown>).code, 'declared_uncaptured_required');
  });

  test('(a) …and so is a value outside the vocabulary', async () => {
    const r = await post(captureBlock({ uncaptured_scope: 'mostly' }));
    assert.equal(r.status, 422);
    assert.equal((r.body.error as Record<string, unknown>).code, 'declared_uncaptured_required');
  });

  test('(b) `not_enumerated` carrying a count or a hash is refused', async () => {
    for (const over of [
      { declared_uncaptured_count: 0 },
      { declared_uncaptured_hash: 'ab'.repeat(32) },
      { uncaptured_enumeration_method: 'live_history' },
    ]) {
      const r = await post(captureBlock(over));
      assert.equal(r.status, 422, JSON.stringify(over));
      assert.equal((r.body.error as Record<string, unknown>).code, 'declared_uncaptured_refused');
    }
  });

  test('⚑ (c) THE EMPTY-SET RULE — an enumerated scope with a NULL count is refused', async () => {
    const r = await post(
      captureBlock({
        uncaptured_enumeration_method: 'live_history',
        uncaptured_scope: 'partial',
        declared_uncaptured_count: null,
        declared_uncaptured_hash: 'ab'.repeat(32),
      }),
    );
    assert.equal(r.status, 422);
    assert.equal((r.body.error as Record<string, unknown>).code, 'declared_uncaptured_refused');
    assert.match(String((r.body.error as Record<string, unknown>).message), /0 IS A CARDINALITY/);
  });

  test('(d) `uncaptured_scope_source: "measured"` is refused while the blocker stands', async () => {
    const doc = hashDeclaredUncaptured(fold().document!);
    const r = await post(
      captureBlock({
        uncaptured_enumeration_method: 'live_history',
        uncaptured_scope: 'partial',
        uncaptured_scope_source: 'measured',
        declared_uncaptured_count: 1,
        declared_uncaptured_hash: doc.hash,
      }),
      { declared_uncaptured: fold().document },
    );
    assert.equal(r.status, 422);
    assert.match(String((r.body.error as Record<string, unknown>).message), /independent observer/);
  });

  test('⚑ (e) THE CROSS-RULE — `complete` beside a reason that says otherwise', async () => {
    const built = fold({ upstream: UP({ upstream_uncaptured_reason: 'evicted_or_restarted' }) });
    // Forge the scope UP to `complete` on the wire, which a conforming
    // component cannot produce — the fold refuses to.
    assert.equal(built.observation.uncaptured_scope, 'partial');
    const r = await post(
      captureBlock({
        upstream_uncaptured_reason: 'evicted_or_restarted',
        upstream_continuity: 'restarted',
        uncaptured_enumeration_method: 'live_history',
        uncaptured_scope: 'complete',
        declared_uncaptured_count: built.observation.declared_uncaptured_count,
        declared_uncaptured_hash: built.observation.declared_uncaptured_hash,
      }),
      { declared_uncaptured: built.document },
    );
    assert.equal(r.status, 422);
    assert.equal((r.body.error as Record<string, unknown>).code, 'declared_uncaptured_refused');
    assert.match(String((r.body.error as Record<string, unknown>).message), /wearing a completeness claim/);
  });

  test('(f) a non-integer count is refused — by the route AND, independently, by the ratchet', async () => {
    // ⚑ THE FLOAT GOES ON THE WIRE *AFTER* THE MAC, and that is the finding
    // rather than a test trick: a CONFORMING COMPONENT CANNOT PRODUCE THIS
    // SHAPE. `canonicalPreimage` refuses to MAC a float at all (§10 C-1: a
    // float in a preimage is a MAC that fails unreproducibly and only
    // sometimes), so the only way this reaches a server is a party in the
    // middle. Both guards are asserted, exactly as WO-C5 asserts them for a
    // watermark one field over.
    const id = provision();
    const body = submission(
      id,
      0,
      captureBlock({
        uncaptured_enumeration_method: 'live_history',
        uncaptured_scope: 'partial',
        declared_uncaptured_count: 1,
        declared_uncaptured_hash: 'ab'.repeat(32),
      }),
    );
    // Guard 1 — the ratchet, on the way out.
    assert.throws(
      () =>
        M.componentPreimage(
          submission(provision(), 0, captureBlock({
            uncaptured_enumeration_method: 'live_history',
            uncaptured_scope: 'partial',
            declared_uncaptured_count: 1,
            declared_uncaptured_hash: 'ab'.repeat(32),
          })) as never,
        ) && new M.Ratchet(M.deriveIk(M.bdk(), id), 0).mac({
          ...(M.componentPreimage(body as never) as Record<string, unknown>),
          declared_uncaptured_count: 1.5,
        } as never),
      /float value for "declared_uncaptured_count"/,
    );
    // Guard 2 — rule 8, on the way in.
    (body.capture as Record<string, unknown>).declared_uncaptured_count = 1.5;
    const res = await M.POST(witnessReq(body));
    const j = (await res.json()) as Record<string, unknown>;
    assert.equal(res.status, 422);
    assert.match(String((j.error as Record<string, unknown>).message), /non-negative safe integer/);
  });

  test('(f) a scope field sent ONE LEVEL UP is refused, not ignored', async () => {
    const r = await post(captureBlock(), { uncaptured_scope: 'complete' });
    assert.equal(r.status, 422);
    assert.match(String((r.body.error as Record<string, unknown>).message), /outside the MAC/);
  });

  test('(f) …and the DOCUMENT sent one level DOWN is refused too', async () => {
    const r = await post(captureBlock({ declared_uncaptured: { artifacts: [] } }));
    assert.equal(r.status, 422);
    assert.match(String((r.body.error as Record<string, unknown>).message), /top-level/);
  });

  test('a legacy leaf — no capture block at all — is unaffected', async () => {
    const r = await post(null);
    assert.equal(r.status, 201);
    const row = M.conn()
      .prepare(`SELECT uncaptured_scope FROM iterations WHERE id = ?`)
      .get(Number(r.body.leaf_id)) as Record<string, unknown>;
    // NULL, not 'not_enumerated'. "The question was never asked of this leaf."
    assert.equal(row.uncaptured_scope, null);
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * 7 · THE DOCUMENT AND ITS DIGEST CANNOT BE SEPARATED
 * ════════════════════════════════════════════════════════════════════════ */

describe('WO-E2 — the set and the claim about it are bound together', () => {
  const enumeratedCapture = (built: ReturnType<typeof fold>) =>
    captureBlock({
      uncaptured_enumeration_method: built.observation.uncaptured_enumeration_method,
      uncaptured_scope: built.observation.uncaptured_scope,
      uncaptured_scope_source: built.observation.uncaptured_scope_source,
      declared_uncaptured_count: built.observation.declared_uncaptured_count,
      declared_uncaptured_hash: built.observation.declared_uncaptured_hash,
    });

  test('a matching pair is accepted, and the CANONICAL BYTES are what is stored', async () => {
    const built = fold();
    const id = provision();
    const res = await M.POST(
      witnessReq(
        submission(id, 0, enumeratedCapture(built), { declared_uncaptured: built.document }),
      ),
    );
    assert.equal(res.status, 201);
    const body = (await res.json()) as Record<string, unknown>;
    const row = M.conn()
      .prepare(
        `SELECT declared_uncaptured, declared_uncaptured_hash, declared_uncaptured_count,
                uncaptured_scope FROM iterations WHERE id = ?`,
      )
      .get(Number(body.leaf_id)) as Record<string, string | number>;
    assert.equal(row.uncaptured_scope, 'complete');
    assert.equal(row.declared_uncaptured_count, 1);
    // The stored bytes reproduce the signed digest, directly, with no
    // re-serialisation in between.
    assert.equal(
      crypto.createHash('sha256').update(String(row.declared_uncaptured), 'utf8').digest('hex'),
      row.declared_uncaptured_hash,
    );
    assert.equal(row.declared_uncaptured_hash, built.observation.declared_uncaptured_hash);
  });

  test('⚑ rewriting the DOCUMENT in flight is caught by the recomputation', async () => {
    const built = fold();
    const tampered = JSON.parse(JSON.stringify(built.document)) as Record<string, unknown>;
    (tampered.artifacts as unknown[]).length = 0; // "nothing was uncaptured"
    const id = provision();
    const res = await M.POST(
      witnessReq(submission(id, 0, enumeratedCapture(built), { declared_uncaptured: tampered })),
    );
    assert.equal(res.status, 400);
    const body = (await res.json()) as Record<string, unknown>;
    assert.match(String((body.error as Record<string, unknown>).message), /disagree/);
  });

  test('a signed digest with NO document is refused', async () => {
    const built = fold();
    const id = provision();
    const res = await M.POST(witnessReq(submission(id, 0, enumeratedCapture(built))));
    assert.equal(res.status, 422);
    const body = (await res.json()) as Record<string, unknown>;
    assert.match(String((body.error as Record<string, unknown>).message), /no verifier can ever read/);
  });

  test('…and a document with NO signed digest is refused', async () => {
    const built = fold();
    const id = provision();
    const res = await M.POST(
      witnessReq(submission(id, 0, captureBlock(), { declared_uncaptured: built.document })),
    );
    assert.equal(res.status, 422);
    const body = (await res.json()) as Record<string, unknown>;
    assert.match(String((body.error as Record<string, unknown>).message), /unsigned attachment/);
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * 8 · THE FIVE SCALARS ARE INSIDE THE MAC
 * ════════════════════════════════════════════════════════════════════════ */

describe('WO-E2 — the scope is signed', () => {
  const rewriteInFlight = async (mutate: (c: Record<string, unknown>) => void) => {
    const built = fold();
    const id = provision();
    const body = submission(
      id,
      0,
      captureBlock({
        uncaptured_enumeration_method: 'live_history',
        uncaptured_scope: built.observation.uncaptured_scope,
        uncaptured_scope_source: 'unknown',
        declared_uncaptured_count: built.observation.declared_uncaptured_count,
        declared_uncaptured_hash: built.observation.declared_uncaptured_hash,
      }),
      { declared_uncaptured: built.document },
    );
    // The MAC is already computed. Now a party in the middle edits.
    mutate(body.capture as Record<string, unknown>);
    const res = await M.POST(witnessReq(body));
    return res;
  };

  test('promoting `partial` → `complete` in flight invalidates the signature', async () => {
    // The fold produced `complete` already, so go the other way and then back:
    // start from a partial scope the component really emitted.
    const built = fold({ ledgerIntact: false });
    assert.equal(built.observation.uncaptured_scope, 'partial');
    const id = provision();
    const body = submission(
      id,
      0,
      captureBlock({
        uncaptured_enumeration_method: 'live_history',
        uncaptured_scope: 'partial',
        declared_uncaptured_count: built.observation.declared_uncaptured_count,
        declared_uncaptured_hash: built.observation.declared_uncaptured_hash,
      }),
      { declared_uncaptured: built.document },
    );
    (body.capture as Record<string, unknown>).uncaptured_scope = 'complete';
    const res = await M.POST(witnessReq(body));
    const j = (await res.json()) as Record<string, unknown>;
    assert.equal(res.status, 422);
    assert.equal((j.error as Record<string, unknown>).code, 'component_unverified');
  });

  test('so does moving the COUNT by one — 0 and 1 are different signed facts', async () => {
    const res = await rewriteInFlight((c) => {
      c.declared_uncaptured_count = 0;
    });
    const j = (await res.json()) as Record<string, unknown>;
    assert.equal(res.status, 422);
    assert.equal((j.error as Record<string, unknown>).code, 'component_unverified');
  });

  test('so does swapping the enumeration method', async () => {
    const res = await rewriteInFlight((c) => {
      c.uncaptured_enumeration_method = 'none';
      c.uncaptured_scope = 'not_enumerated';
      c.declared_uncaptured_count = null;
      c.declared_uncaptured_hash = null;
    });
    const j = (await res.json()) as Record<string, unknown>;
    assert.equal(res.status, 422);
    assert.equal((j.error as Record<string, unknown>).code, 'component_unverified');
  });

  test('ANTI-VACUITY: a field deliberately NOT in the preimage still passes', async () => {
    // `fs_diagnostic` is diagnostic corroboration and is uncovered on purpose
    // (WO-C1). If this went red, the three above would be proving that any
    // edit fails rather than that these five are signed.
    const res = await rewriteInFlight((c) => {
      c.fs_diagnostic = 'fs-watch-quiescence';
    });
    assert.equal(res.status, 201);
  });

  test('and the preimage carries all five keys, always, null on a legacy leaf', () => {
    const p = M.componentPreimage({ content_hash: 'a'.repeat(64), component: { component_id: 'x', counter: 0 } } as never);
    for (const k of [
      'uncaptured_enumeration_method',
      'uncaptured_scope',
      'uncaptured_scope_source',
      'declared_uncaptured_count',
      'declared_uncaptured_hash',
    ]) {
      assert.ok(k in (p as Record<string, unknown>), k);
      assert.equal((p as Record<string, unknown>)[k], null, k);
    }
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * 9 · THE GATE, AND ITS TWO CONTROLS, AGAINST THE REAL COMPONENT
 * ════════════════════════════════════════════════════════════════════════ */

describe('WO-E2 — the gate: a real upstream, a real component, a real leaf', () => {
  /** One session. Returns the leaves the component actually submitted. */
  async function session(o: {
    name: string;
    /** Which C-8 roots to declare, or 'single' for the untyped pre-C-8 form. */
    roots: 'three' | 'output-only' | 'single';
    /** Which artifacts the client retrieves through the gate. */
    fetchNames: Array<{ filename: string; type: string }>;
  }) {
    const root = fs.mkdtempSync(path.join(OWN_DIR, `${o.name}-`));
    const comfy = await M.startStubComfyUI(root);
    const ingest = await startIngest();
    const stateDir = path.join(root, 'state');
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });

    const volumes =
      o.roots === 'three'
        ? {
            watchedVolumes: [
              { type: 'output' as const, path: comfy.dirs.output },
              { type: 'temp' as const, path: comfy.dirs.temp },
              { type: 'input' as const, path: comfy.dirs.input },
            ],
          }
        : o.roots === 'output-only'
          ? { watchedVolumes: [{ type: 'output' as const, path: comfy.dirs.output }] }
          : { outputVolume: comfy.dirs.output };

    const comp = await M.CaptureComponent.start(
      componentConfig({ stateDir, apiBaseUrl: ingest.url, upstreamUrl: comfy.url, ...volumes }),
      { identity: identityFor(stateDir), log: () => {} },
    );
    const gateUrl = `http://127.0.0.1:${comp.port}`;
    try {
      await generate(
        gateUrl,
        {
          '1': { class_type: 'SaveImage', inputs: { filename_prefix: o.name } },
          '2': { class_type: 'PreviewImage', inputs: {} },
        },
        o.fetchNames,
      );
      // The write side is settled, then ONE bracket is taken by hand so the
      // enumeration sees the prompt that just completed. Nothing races a timer.
      await comp.fsWatch.settled();
      await comp.upstream.poll();
      // …and one more artifact, so a leaf is emitted AFTER the bracket that
      // enumerated the first generation. A leaf's absence set describes the
      // newest reading available at ITS emission.
      await generate(
        gateUrl,
        { '1': { class_type: 'SaveImage', inputs: { filename_prefix: `${o.name}-b` } } },
        [{ filename: `${o.name}-b_00001_.png`, type: 'output' }],
      );
      await comp.fsWatch.settled();
      await sleep(80);
      return { leaves: ingest.received.slice(), comfy, comp };
    } finally {
      await comp.stop();
      await ingest.close();
      await comfy.close();
    }
  }

  const cap = (l: Record<string, unknown>) => l.capture as Record<string, unknown>;
  const withScope = (ls: Array<Record<string, unknown>>) =>
    ls.filter((l) => cap(l).uncaptured_enumeration_method === 'live_history');

  test('THE GATE — an artifact the upstream reported and the component did not capture is NAMED', async () => {
    // `output` is watched, `temp` is not, and the client fetches only the
    // SaveImage output. The PreviewImage write lands in `temp/`, is listed in
    // `/history` (round 5 §4(a)), and nobody captured it.
    const { leaves } = await session({
      name: 'gate',
      roots: 'output-only',
      fetchNames: [{ filename: 'gate_00001_.png', type: 'output' }],
    });
    const enumerated = withScope(leaves);
    assert.ok(enumerated.length > 0, 'no leaf carried an enumeration');
    const named = enumerated.filter((l) => Number(cap(l).declared_uncaptured_count) > 0);
    assert.ok(named.length > 0, 'no leaf named an uncaptured artifact');

    const doc = named[0]!.declared_uncaptured as Record<string, unknown>;
    const artifacts = doc.artifacts as Array<Record<string, unknown>>;
    assert.ok(
      artifacts.some((a) => a.type === 'temp' && String(a.filename).includes('temp')),
      `the temp write was not named: ${JSON.stringify(artifacts)}`,
    );
    assert.ok(artifacts.every((a) => a.transaction === 'none'));

    // …WITH A SCOPE THAT SAYS WHAT WAS LOOKED AT.
    const scope = doc.scope as Record<string, unknown>;
    assert.deepEqual(scope.volume_types, ['output']);
    assert.deepEqual(scope.missing_types, ['temp', 'input']);
    assert.equal(scope.unspecified_roots, 0);
    assert.ok((scope.history_window as Record<string, unknown>).epoch);
    assert.equal(cap(named[0]!).uncaptured_scope, 'partial');

    // And the digest on the leaf covers the document beside it.
    assert.equal(
      hashDeclaredUncaptured(doc as never).hash,
      cap(named[0]!).declared_uncaptured_hash,
    );
  });

  test('CONTROL 1 — nothing uncaptured yields an EMPTY SET THAT IS PRESENT', async () => {
    // All three C-8 roots declared, so the filesystem watcher captures the
    // temp write as well as the output one. Nothing is left over.
    const { leaves } = await session({
      name: 'control1',
      roots: 'three',
      fetchNames: [{ filename: 'control1_00001_.png', type: 'output' }],
    });
    const enumerated = withScope(leaves);
    assert.ok(enumerated.length > 0);
    const last = enumerated[enumerated.length - 1]!;
    assert.equal(cap(last).declared_uncaptured_count, 0, JSON.stringify(last.declared_uncaptured));
    // ⚑ PRESENT, NOT ABSENT. Both halves.
    assert.notEqual(cap(last).declared_uncaptured_hash, null);
    assert.ok(last.declared_uncaptured, 'the document is absent on an empty set');
    assert.deepEqual((last.declared_uncaptured as Record<string, unknown>).artifacts, []);
    assert.notEqual(cap(last).uncaptured_scope, 'not_enumerated');
    // …and with every condition met, this is the reachable `complete`.
    assert.equal(cap(last).uncaptured_scope, 'complete');
  });

  test('CONTROL 2 — roots that do not cover the output directory REFUSE closure', async () => {
    // The pre-C-8 single-root form: one root whose type is `unspecified`.
    const { leaves } = await session({
      name: 'control2',
      roots: 'single',
      fetchNames: [{ filename: 'control2_00001_.png', type: 'output' }],
    });
    const enumerated = withScope(leaves);
    assert.ok(enumerated.length > 0);
    for (const l of enumerated) {
      assert.equal(cap(l).uncaptured_scope, 'partial');
    }
    const doc = enumerated[0]!.declared_uncaptured as Record<string, unknown>;
    const completeness = doc.completeness as Record<string, unknown>;
    assert.equal((completeness.conditions as Record<string, unknown>).roots_cover_c8, false);
    assert.equal((doc.scope as Record<string, unknown>).unspecified_roots, 1);
    assert.match(String((completeness.reasons as string[])[0]), /Closure is refused/);
  });

  test('⚑ an artifact NEVER appears in the absence set of its OWN leaf', async () => {
    // THE ORDERING, ISOLATED. `Submitter.capture()` records the captured-set
    // ledger BEFORE `buildLeaf`, and this is the assertion that makes that a
    // decision rather than a comment: the sequence below puts the artifact in
    // the `/history` enumeration BEFORE the gate captures it, so the only
    // thing standing between "captured" and "named as uncaptured on its own
    // leaf" is which side of `buildLeaf` the ledger write falls on.
    //
    //   1. POST /prompt   — the upstream writes the file and lists it
    //   2. poll()         — the enumeration window now contains it, and the
    //                       ledger does NOT: nobody has retrieved it yet
    //   3. GET /view      — the gate captures it, and builds its leaf
    //
    // Only `input/` is watched, so the filesystem watcher cannot capture the
    // output file first and turn this into a test of something else.
    const root = fs.mkdtempSync(path.join(OWN_DIR, 'order-'));
    const comfy = await M.startStubComfyUI(root);
    const ingest = await startIngest();
    const stateDir = path.join(root, 'state');
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const comp = await M.CaptureComponent.start(
      componentConfig({
        stateDir,
        apiBaseUrl: ingest.url,
        upstreamUrl: comfy.url,
        watchedVolumes: [{ type: 'input', path: comfy.dirs.input }],
      }),
      { identity: identityFor(stateDir), log: () => {} },
    );
    const gateUrl = `http://127.0.0.1:${comp.port}`;
    try {
      const r = await fetch(`${gateUrl}/prompt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ '1': { class_type: 'SaveImage', inputs: { filename_prefix: 'ord' } } }),
      });
      await r.json();
      await sleep(120);
      await comp.upstream.poll();
      // The enumeration holds it and the ledger does not — the precondition
      // this test would be vacuous without.
      const win = comp.upstream.enumerationWindow();
      const enumeratedNow = (win?.outputs ?? []).flatMap((e) => artifactsInOutputs(e.outputs));
      assert.ok(
        enumeratedNow.some((a) => a.filename === 'ord_00001_.png'),
        'precondition: /history must already list the artifact before it is retrieved',
      );
      assert.equal(comp.captured.has(ref('output', 'ord_00001_.png')), false);

      const before = ingest.received.length;
      const v = await fetch(`${gateUrl}/view?filename=ord_00001_.png&type=output&subfolder=`);
      await v.arrayBuffer();
      await sleep(80);

      const leaf = ingest.received.slice(before)[0];
      assert.ok(leaf, 'the /view retrieval produced no leaf');
      assert.equal(cap(leaf).uncaptured_enumeration_method, 'live_history');
      const arts = ((leaf.declared_uncaptured as Record<string, unknown> | undefined)?.artifacts ??
        []) as Array<Record<string, unknown>>;
      assert.equal(
        arts.some((a) => a.filename === 'ord_00001_.png'),
        false,
        `the artifact named ITSELF as uncaptured: ${JSON.stringify(arts)}`,
      );
      assert.equal(cap(leaf).declared_uncaptured_count, 0);
      // …and it is in the ledger afterwards, so the write happened at all.
      assert.equal(comp.captured.has(ref('output', 'ord_00001_.png')), true);
    } finally {
      await comp.stop();
      await ingest.close();
      await comfy.close();
    }
  });

  test('a WS-only artifact is in NO absence set — it is in no `/history` output either', async () => {
    // `SaveImageWebsocket` becomes no file and records no output, so it is not
    // a member of the class the set ranges over. An absence set that named it
    // would be accusing the component of missing something the upstream never
    // said it produced.
    const root = fs.mkdtempSync(path.join(OWN_DIR, 'ws-'));
    const comfy = await M.startStubComfyUI(root);
    const ingest = await startIngest();
    const stateDir = path.join(root, 'state');
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const comp = await M.CaptureComponent.start(
      componentConfig({
        stateDir,
        apiBaseUrl: ingest.url,
        upstreamUrl: comfy.url,
        watchedVolumes: [
          { type: 'output', path: comfy.dirs.output },
          { type: 'temp', path: comfy.dirs.temp },
          { type: 'input', path: comfy.dirs.input },
        ],
      }),
      { identity: identityFor(stateDir), log: () => {} },
    );
    try {
      await generate(`http://127.0.0.1:${comp.port}`, { '1': { class_type: 'SaveImageWebsocket', inputs: {} } }, []);
      await comp.upstream.poll();
      await generate(
        `http://127.0.0.1:${comp.port}`,
        { '1': { class_type: 'SaveImage', inputs: { filename_prefix: 'ws' } } },
        [{ filename: 'ws_00001_.png', type: 'output' }],
      );
      await comp.fsWatch.settled();
      await sleep(80);
      const enumerated = withScope(ingest.received);
      assert.ok(enumerated.length > 0);
      for (const l of enumerated) {
        const doc = l.declared_uncaptured as Record<string, unknown> | undefined;
        const arts = (doc?.artifacts ?? []) as Array<Record<string, unknown>>;
        assert.equal(arts.length, 0, JSON.stringify(arts));
      }
    } finally {
      await comp.stop();
      await ingest.close();
      await comfy.close();
    }
  });
});
