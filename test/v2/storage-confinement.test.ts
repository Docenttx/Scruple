// WO-C4 — storage confinement: startup refusal, and a per-leaf raw stat()
// st_dev re-read at emission.
//
// IT Expert's finding, confirmed by the council in the code (round 8 §3):
// `stateDir` holds the sealed IK, the ratchet counter and the durable queue;
// the watched volumes are where an uncaptured tenant write lands; and nothing
// requires them to be on different filesystems.
//
//   an uncaptured runaway write exhausts blocks on a shared filesystem
//     → the ratchet's local append cannot fsync()
//     → and the MAC is the BLOCKING half of emit()
//     → fail-closed becomes FAIL-STOPPED, triggered by the very artifact
//       class the gate cannot see.
//
// TWO HALVES, AND EACH HAS A CONTROL HERE.
//
//   STARTUP  refuse to bind the proxy socket when the devices are shared or
//            the state device has no reservable capacity. Control: the same
//            configuration with degraded operation DECLARED starts, and its
//            leaves carry the measured degraded value — the waiver does not
//            make the finding disappear, it makes it travel.
//
//   PER LEAF re-read the device identity at emission. Architect: "a
//            startup-only check is a config-inherited fact by the time the
//            leaf is emitted — volumes can be remounted or bind-mounted after
//            boot." CONTROL: the startup reading is kept on the component and
//            is asserted to be STILL SAYING `confined` after the device
//            behind the volume changed. If it fired, this test would prove
//            nothing about the re-read.
//
// ⚑ WHY THE IN-SUITE DEVICE CHANGE IS A SYMLINK SWAP AND NOT `mount --bind`.
// A bind mount needs a private mount namespace, which a test process cannot
// enter for itself. The property under test is the one IT Expert named — raw
// `stat()` st_dev on the CONFIGURED PATH at the moment of emission, rather
// than a value cached at boot — and repointing the configured path at a
// directory on another device exercises exactly that code with no privilege.
// The real `mount --bind`, performed after startup under `unshare -rm`
// against the real component, is recorded at
// /mnt/corpus/scruple-council-impl/wo-c4/03-live-GREEN.txt, with the same run
// against the pre-change tree in 01-controls-RED.txt.
//
// TEST ISOLATION follows test/v2/attestation-basis.test.ts: a private
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
  measureStorageConfinement,
  readDevice,
  startupDecision,
} from '../../lib/capture/storageConfinement';
import {
  DEFAULT_UPSTREAM_ANCHOR_WINDOW,
  DEFAULT_UPSTREAM_POLL_INTERVAL_MS,
} from '../../lib/capture/upstreamEpoch';

if (!process.env.SCRUPLE_DB_PATH || !/tmp|test/i.test(process.env.SCRUPLE_DB_PATH)) {
  throw new Error('Refusing to run: set SCRUPLE_DB_PATH to a throwaway path. Use `npm run test:v2`.');
}
const OWN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'scruple-storage-confinement-'));
process.env.SCRUPLE_DB_PATH = path.join(OWN_DIR, 'storage-confinement.db');
process.env.SCRUPLE_BDK_HEX = 'd4'.repeat(32);
// The standing rule: never the production witness on 127.0.0.1:5799.
process.env.WITNESS_SERVER_URL = 'http://127.0.0.1:1';

/**
 * A second device, and the whole file depends on there being one. /dev/shm is
 * a tmpfs on every Linux this ships to and is a different st_dev from the
 * tmpdir. If it is ever absent, these tests must FAIL rather than skip: a gate
 * that quietly stops running is the failure mode this series exists to close.
 */
const SHM = '/dev/shm';

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
  StorageConfinementError: typeof import('../../services/scruple-capture/src/component').StorageConfinementError;
  POST: (req: Request) => Promise<Response>;
};

let M: Mod;
const TENANT = 'vendor-c4';
const BUILD = 'sha256:' + '4d'.repeat(32);
const BASELINE = '4'.repeat(64);
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
    // WO-C5. Which upstream run this leaf came from. Rule 6 refuses a
    // capture-bearing leaf without them, so they are here for the same
    // reason the confinement pair is here in WO-C4's own fixtures.
    upstream_identity: 'sha256:' + 'ef'.repeat(32),
    upstream_epoch: 'epoch:' + '9a'.repeat(16),
    upstream_continuity: 'continuous',
    upstream_low_watermark_open: 0,
    upstream_low_watermark_close: 0,
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
  const { componentId, token } = M.issueProvisioningToken({ tenantId: TENANT, label: 'c4' });
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
  outputVolume: string;
  apiBaseUrl: string;
  listenPort?: number;
  allowDegradedStorage?: boolean;
  stateMinReservableBytes?: number;
}) {
  return {
    // Never contacted by these tests — nothing is driven through the gate,
    // the observations go into the sink directly. Port 1 so it can never be
    // mistaken for a live upstream.
    upstreamUrl: 'http://127.0.0.1:1',
    listenHost: '127.0.0.1',
    listenPort: o.listenPort ?? 0,
    outputVolume: o.outputVolume,
    stateDir: o.stateDir,
    apiBaseUrl: o.apiBaseUrl,
    apiKey: 'sk_test_c4',
    provisioningToken: null,
    baselineRef: BASELINE,
    outputVolumeDeclaredMime: 'image/png',
    witnessAuthority: null,
    retentionPolicyDigest: DEFAULT_RETENTION_POLICY_DIGEST,
    settlementWindowSeconds: DEFAULT_RETENTION_POLICY.settlement_window_s,
    allowDegradedStorage: o.allowDegradedStorage ?? false,
    stateMinReservableBytes: o.stateMinReservableBytes ?? DEFAULT_MIN_RESERVABLE_BYTES,
    settleMs: 40,
    correlationTtlMs: 60_000,
    heartbeatWindowSeconds: 900,
    // WO-C5. The upstream bracket cadence. Explicit here rather than
    // defaulted in the type, because `CaptureConfig` has no defaults by
    // design (config.ts header: "no defaults for anything load-bearing").
    upstreamPollIntervalMs: DEFAULT_UPSTREAM_POLL_INTERVAL_MS,
    upstreamMaxReadingAgeMs: DEFAULT_UPSTREAM_POLL_INTERVAL_MS * 2,
    upstreamAnchorWindow: DEFAULT_UPSTREAM_ANCHOR_WINDOW,
  };
}

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** One observation, straight into the sink — the emission path `emit()` uses. */
function observation(name: string) {
  return {
    surface: 'network-gate' as const,
    hook: 'artifact.produced' as const,
    observedAt: new Date().toISOString(),
    correlationId: null,
    bytes: {
      contentHash: crypto.createHash('sha256').update(`${name}${Math.random()}`).digest('hex'),
      sizeBytes: PNG.length,
      mime: 'image/png',
      fidelity: 'as-delivered' as const,
    },
    evidence: { egress: `http:/view?filename=${name}` },
  };
}

before(async () => {
  const [sqlite, migrate, prov, ratchet, bdkMod, preimage, route, bm, identity, component] =
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
    StorageConfinementError: component.StorageConfinementError,
    POST: route.POST as unknown as (req: Request) => Promise<Response>,
  };
  M.runMigrations(false);
  M.conn().prepare(`INSERT INTO users (id, email) VALUES (?, ?)`).run(TENANT, 'c4@example.com');
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
  try {
    fs.rmSync(OWN_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// ---------------------------------------------------------------------------
describe('the measurement itself — raw stat(2), no cache', () => {
  test('two directories on two devices read as two st_dev values', () => {
    const a = fs.mkdtempSync(path.join(OWN_DIR, 'dev-a-'));
    const b = fs.mkdtempSync(path.join(SHM, 'scruple-c4-dev-b-'));
    try {
      const da = readDevice(a);
      const db = readDevice(b);
      assert.equal(da.error, null);
      assert.equal(db.error, null);
      assert.notEqual(
        da.dev,
        db.dev,
        `${a} and ${b} must be on different devices for this file to test anything. ` +
          'If /dev/shm is not a separate mount here, the gate below is unfalsifiable.',
      );
      assert.equal(measureStorageConfinement({ stateDir: a, volumes: [b] }).confinement, 'confined');
      assert.equal(
        measureStorageConfinement({ stateDir: a, volumes: [a] }).confinement,
        'degraded_shared_storage',
      );
    } finally {
      fs.rmSync(b, { recursive: true, force: true });
    }
  });

  test('an unreadable path is `unknown`/`unknown` — never a degraded state', () => {
    const a = fs.mkdtempSync(path.join(OWN_DIR, 'dev-c-'));
    const m = measureStorageConfinement({ stateDir: a, volumes: [path.join(a, 'nope')] });
    assert.equal(m.confinement, 'unknown');
    assert.equal(m.source, 'unknown');
  });

  test('a floor above the device`s free space is `degraded_no_reservation`, not `confined`', () => {
    const a = fs.mkdtempSync(path.join(OWN_DIR, 'dev-d-'));
    const b = fs.mkdtempSync(path.join(SHM, 'scruple-c4-dev-e-'));
    try {
      const m = measureStorageConfinement({
        stateDir: a,
        volumes: [b],
        // Larger than any filesystem this will ever run on.
        minReservableBytes: Number.MAX_SAFE_INTEGER,
      });
      assert.equal(m.confinement, 'degraded_no_reservation');
      assert.equal(m.source, 'measured');
    } finally {
      fs.rmSync(b, { recursive: true, force: true });
    }
  });

  test('`unknown` is refused at startup EVEN with degraded operation declared', () => {
    const a = fs.mkdtempSync(path.join(OWN_DIR, 'dev-f-'));
    const m = measureStorageConfinement({ stateDir: a, volumes: [path.join(a, 'gone')] });
    // The waiver's whole basis is that the leaves carry the measured value.
    // There is no measured value here, so there is nothing to carry.
    assert.equal(startupDecision(m, { allowDegraded: true }).ok, false);
    assert.equal(startupDecision(m, { allowDegraded: false }).ok, false);
  });
});

// ---------------------------------------------------------------------------
describe('THE GATE: a device change performed AFTER startup is caught at the next emission', () => {
  test('leaf 1 says confined, the volume moves onto the state device, leaf 2 says degraded', async () => {
    const root = fs.mkdtempSync(path.join(OWN_DIR, 'gate-'));
    const stateDir = path.join(root, 'state');
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    // The output volume starts on ANOTHER device — a correctly provisioned
    // deployment. /dev/shm is that device.
    const volume = fs.mkdtempSync(path.join(SHM, 'scruple-c4-vol-'));
    // Where it will point after the change: back on the state device.
    const onStateDevice = path.join(root, 'moved-volume');
    fs.mkdirSync(onStateDevice, { recursive: true });

    const ingest = await startIngest();
    const component = await M.CaptureComponent.start(
      componentConfig({ stateDir, outputVolume: volume, apiBaseUrl: ingest.url }),
      { identity: identityFor(stateDir), log: () => undefined },
    );

    try {
      assert.equal(component.storageAtStartup.confinement, 'confined');

      await component.submitter.emit(observation('before') as never);
      const leaf1 = ingest.received.at(-1) as { capture: Record<string, unknown> };
      assert.equal(leaf1.capture.confinement, 'confined');
      assert.equal(leaf1.capture.confinement_source, 'measured');

      // ── THE DEVICE BEHIND THE CONFIGURED PATH CHANGES. Nothing in the
      //    configuration moves; the component is not restarted.
      fs.rmSync(volume, { recursive: true, force: true });
      fs.symlinkSync(onStateDevice, volume, 'dir');
      assert.equal(
        readDevice(volume).dev,
        readDevice(stateDir).dev,
        'the swap must actually have moved the volume onto the state device',
      );

      await component.submitter.emit(observation('after') as never);
      const leaf2 = ingest.received.at(-1) as { capture: Record<string, unknown> };
      assert.equal(
        leaf2.capture.confinement,
        'degraded_shared_storage',
        'the emission-time re-read did not see the change',
      );
      assert.equal(leaf2.capture.confinement_source, 'measured');

      // ── THE CONTROL. The startup reading is still on the component and
      //    still says `confined`. A startup-only check — which is what the
      //    council explicitly refused as sufficient — would have reported a
      //    confined session for every leaf after this point.
      assert.equal(
        component.storageAtStartup.confinement,
        'confined',
        'CONTROL FAILED: the startup reading changed, so this test would not ' +
          'distinguish a per-leaf re-read from a startup-only check',
      );
    } finally {
      await component.stop();
      await ingest.close();
      fs.rmSync(volume, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
describe('THE OTHER HALF: the proxy socket is not bound on shared storage', () => {
  test('a component whose state shares a device with its volume REFUSES to start', async () => {
    const root = fs.mkdtempSync(path.join(OWN_DIR, 'refuse-'));
    const stateDir = path.join(root, 'state');
    const volume = path.join(root, 'volume');
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(volume, { recursive: true });
    const ingest = await startIngest();
    // A fixed port, so "was anything bound" can be asked of the kernel
    // rather than of the code path that was supposed to bind it.
    const PORT = 18021;

    // Held so that a component which starts when it should NOT can still be
    // shut down. Without this, the mutant run that removes the refusal leaves
    // a listening socket behind and the test RUNNER hangs instead of
    // reporting a failure — a control that cannot report is not a control.
    let leaked: Awaited<ReturnType<typeof M.CaptureComponent.start>> | null = null;

    try {
      await assert.rejects(
        async () => {
          leaked = await M.CaptureComponent.start(
            componentConfig({ stateDir, outputVolume: volume, apiBaseUrl: ingest.url, listenPort: PORT }),
            { identity: identityFor(stateDir), log: () => undefined },
          );
        },
        (e: unknown) => e instanceof M.StorageConfinementError,
      );

      const answered = await new Promise<boolean>((resolve) => {
        const probe = http.get({ host: '127.0.0.1', port: PORT, path: '/', timeout: 400 }, (r) => {
          r.resume();
          resolve(true);
        });
        probe.on('error', () => resolve(false));
        probe.on('timeout', () => {
          probe.destroy();
          resolve(false);
        });
      });
      assert.equal(answered, false, 'the proxy socket was bound despite the refusal');
    } finally {
      if (leaked) await (leaked as { stop(): Promise<void> }).stop();
      await ingest.close();
    }
  });

  test('CONTROL: the same configuration with degraded operation DECLARED starts — and every leaf says so', async () => {
    const root = fs.mkdtempSync(path.join(OWN_DIR, 'declared-'));
    const stateDir = path.join(root, 'state');
    const volume = path.join(root, 'volume');
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(volume, { recursive: true });
    const ingest = await startIngest();

    const component = await M.CaptureComponent.start(
      componentConfig({
        stateDir,
        outputVolume: volume,
        apiBaseUrl: ingest.url,
        allowDegradedStorage: true,
      }),
      { identity: identityFor(stateDir), log: () => undefined },
    );
    try {
      assert.ok(component.port > 0, 'the declared-degraded component must actually bind');
      await component.submitter.emit(observation('degraded') as never);
      const leaf = ingest.received.at(-1) as { capture: Record<string, unknown> };
      // The waiver does not make the finding go away — it makes it travel
      // with every artifact the session produced.
      assert.equal(leaf.capture.confinement, 'degraded_shared_storage');
      assert.equal(leaf.capture.confinement_source, 'measured');
    } finally {
      await component.stop();
      await ingest.close();
    }
  });
});

// ---------------------------------------------------------------------------
describe('the route refuses a confinement claim with nothing behind it', () => {
  test('a capture-bearing leaf with NO confinement field is refused', async () => {
    const id = provision();
    const cap = captureBlock();
    delete cap.confinement;
    delete cap.confinement_source;
    const res = await M.POST(witnessReq(submission(id, nextCounter++, cap)));
    assert.equal(res.status, 422);
    assert.equal((await res.json()).error.code, 'storage_confinement_required');
  });

  test('`confined` with an unmeasured source is refused — a boundary nobody observed', async () => {
    const id = provision();
    const res = await M.POST(
      witnessReq(
        submission(id, nextCounter++, captureBlock({ confinement_source: 'unknown' })),
      ),
    );
    assert.equal(res.status, 422);
    assert.equal((await res.json()).error.code, 'storage_confinement_refused');
  });

  test('a DEGRADED value with an unmeasured source is refused too', async () => {
    const id = provision();
    const res = await M.POST(
      witnessReq(
        submission(
          id,
          nextCounter++,
          captureBlock({ confinement: 'degraded_shared_storage', confinement_source: 'unknown' }),
        ),
      ),
    );
    assert.equal(res.status, 422);
    assert.equal((await res.json()).error.code, 'storage_confinement_refused');
  });

  test('`unknown` with `measured` is refused — no measurement concludes that nothing was measured', async () => {
    const id = provision();
    const res = await M.POST(
      witnessReq(
        submission(id, nextCounter++, captureBlock({ confinement: 'unknown', confinement_source: 'measured' })),
      ),
    );
    assert.equal(res.status, 422);
    assert.equal((await res.json()).error.code, 'storage_confinement_refused');
  });

  test('a confinement field sent ONE LEVEL UP is refused, not ignored', async () => {
    const id = provision();
    // The preimage reads `capture.confinement` by key, so a top-level copy is
    // outside the MAC while looking exactly like a signed measurement.
    const res = await M.POST(
      witnessReq(
        submission(id, nextCounter++, captureBlock(), { confinement: 'confined' }),
      ),
    );
    assert.equal(res.status, 422);
    assert.equal((await res.json()).error.code, 'storage_confinement_refused');
  });

  test('ANTI-VACUITY: the same leaf, properly declared, is ACCEPTED and the row records it', async () => {
    const id = provision();
    const body = submission(id, nextCounter++, captureBlock());
    const res = await M.POST(witnessReq(body));
    assert.equal(res.status, 201, await res.text());
    const row = M.conn()
      .prepare(
        `SELECT storage_confinement AS c, storage_confinement_source AS s
           FROM iterations WHERE leaf_hash IS NOT NULL AND component_id = ?
          ORDER BY id DESC LIMIT 1`,
      )
      .get(id) as { c: string; s: string };
    assert.equal(row.c, 'confined');
    assert.equal(row.s, 'measured');
  });

  test('a legacy leaf with NO capture block is still accepted, and the columns stay NULL', async () => {
    const id = provision();
    const body = submission(id, nextCounter++, null);
    const res = await M.POST(witnessReq(body));
    assert.equal(res.status, 201, await res.text());
    const row = M.conn()
      .prepare(
        `SELECT storage_confinement AS c, storage_confinement_source AS s
           FROM iterations WHERE component_id = ? ORDER BY id DESC LIMIT 1`,
      )
      .get(id) as { c: string | null; s: string | null };
    // NULL is "the question was never asked of this leaf", which is a
    // different fact from 'unknown' — "asked, and unanswerable".
    assert.equal(row.c, null);
    assert.equal(row.s, null);
  });
});

// ---------------------------------------------------------------------------
describe('the third guard — migration 056 refuses the pairs the validator refuses', () => {
  // The type stops the code being written, the validator stops the JSON
  // arriving (types do not survive a wire), and this stops any other writer,
  // present or future, that reaches the table through neither.
  const insert = (c: string | null, src: string | null) => {
    const now = new Date().toISOString();
    const p = M.conn()
      .prepare(
        `INSERT INTO projects (user_id, name, type, status, created_at,
            iteration_count, is_active, witnessed_count, is_archived)
         VALUES (?, ?, 'image', 'unlocked', ?, 0, 0, 0, 0)`,
      )
      .run(TENANT, `c4-constraint-${crypto.randomUUID()}`, now);
    M.conn()
      .prepare(
        `INSERT INTO iterations
           (project_id, run_sequence, timestamp, leaf_hash, output_hash, output_kind,
            storage_confinement, storage_confinement_source)
         VALUES (?, 1, ?, ?, ?, 'image', ?, ?)`,
      )
      .run(Number(p.lastInsertRowid), now, crypto.randomBytes(32).toString('hex'), '0'.repeat(64), c, src);
  };

  test('a substantive value with an unmeasured source is refused by the CHECK', () => {
    assert.throws(() => insert('confined', 'unknown'), /CHECK constraint failed/);
    assert.throws(() => insert('degraded_shared_storage', 'unknown'), /CHECK constraint failed/);
  });

  test('`unknown` with `measured` is refused by the CHECK', () => {
    assert.throws(() => insert('unknown', 'measured'), /CHECK constraint failed/);
  });

  test('an unrecognised value is refused by the CHECK', () => {
    assert.throws(() => insert('confined_ish', 'measured'), /CHECK constraint failed/);
  });

  test('ANTI-VACUITY: the legal pairs, and the legacy NULLs, are accepted', () => {
    insert('confined', 'measured');
    insert('degraded_shared_storage', 'measured');
    insert('degraded_no_reservation', 'measured');
    insert('unknown', 'unknown');
    // NULL/NULL is every row written before this migration: the question was
    // never asked, and it is not backfilled into an answer nobody gave.
    insert(null, null);
  });
});

// ---------------------------------------------------------------------------
describe('the confinement is INSIDE the MAC', () => {
  test('rewriting `confinement` in flight invalidates the signature', async () => {
    const id = provision();
    const body = submission(id, nextCounter++, captureBlock()) as {
      capture: Record<string, unknown>;
    };
    // A proxy between the component and the route, promoting a degraded
    // session to a clean one. It cannot: the value is in the preimage.
    (body.capture as Record<string, unknown>).confinement = 'degraded_shared_storage';
    const res = await M.POST(witnessReq(body));
    assert.equal(res.status, 422);
    assert.equal((await res.json()).error.code, 'component_unverified');
  });

  test('rewriting `confinement_source` in flight invalidates it too', async () => {
    const id = provision();
    const body = submission(
      id,
      nextCounter++,
      captureBlock({ confinement: 'unknown', confinement_source: 'unknown' }),
    ) as { capture: Record<string, unknown> };
    // Promoting "nobody looked" to "somebody checked" is the attack the
    // separate source field exists to stop, and it is signed separately for
    // exactly that reason.
    (body.capture as Record<string, unknown>).confinement_source = 'measured';
    const res = await M.POST(witnessReq(body));
    assert.equal(res.status, 422);
    // Rule 5 and the MAC both refuse this shape; the MAC is checked after the
    // validator, so the validator's code is the one that surfaces. Either
    // refusal is a refusal — what must never happen is a 201.
    assert.equal((await res.json()).error.code, 'storage_confinement_refused');
  });

  test('ANTI-VACUITY: rewriting a field deliberately NOT in the preimage still passes', async () => {
    const id = provision();
    const body = submission(id, nextCounter++, captureBlock()) as {
      capture: Record<string, unknown>;
    };
    // `fs_diagnostic` is carried and not MACed on purpose (WO-C1). If this
    // one were refused too, the two tests above would be measuring the MAC's
    // sensitivity to any edit rather than to these fields.
    body.capture.fs_diagnostic = 'fs-watch-quiescence';
    const res = await M.POST(witnessReq(body));
    assert.equal(res.status, 201, await res.text());
  });
});
