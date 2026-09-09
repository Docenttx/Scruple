// WO-D6 — the ComfyUI hook, host-agnostic. Two levels, and the leaf says which.
//
// The claim under test is narrow and load-bearing:
//
//   LEVEL 1  a host points its ComfyUI address at the gate. No code from us,
//            no registration, full byte coverage — and a record that is
//            honestly SEMANTICALLY BLIND, because the gate observes a wire and
//            a wire does not carry the fact that these pixels were the
//            viewport of scene X at frame Y through camera Z.
//   LEVEL 2  the host registers an adapter, which supplies exactly that and
//            nothing else.
//
// ⚑ THE CONTROL IS THE WHOLE POINT, and it is not "Level 2 is richer". It is
// that a Level-1 leaf DECLARES ITS BLINDNESS rather than being merely thinner
// than a Level-2 one. `blind` and `declined` and `supplied` are three values
// on a signed field; absent is refused; and 'declined' — an adapter that WAS
// registered and had nothing to say about this observation — must not read as
// either of the other two.
//
// Nothing here is a log line. Every assertion reads a returned object, a MAC,
// a 4xx code, or a row in a database.

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_RETENTION_POLICY,
  DEFAULT_RETENTION_POLICY_DIGEST,
} from '../../lib/leaf/retentionPolicy';
import {
  HostRegistrationError,
  _resetHostRegistryForTests,
  hashHostEvidence,
  hostAdapterSink,
  hostCaptureLevel,
  registerHost,
  registeredHosts,
  type HostAdapter,
  type HostRegistration,
} from '../../lib/capture/hostRegistry';
import type { CaptureObservation, ObservationSink } from '../../lib/capture/surface';
import { validateCaptureClaims } from '../../lib/leaf/captureClaims';
import { buildLeaf } from '../../services/scruple-capture/src/leaf';

if (!process.env.SCRUPLE_DB_PATH || !/tmp|test/i.test(process.env.SCRUPLE_DB_PATH)) {
  throw new Error('Refusing to run: set SCRUPLE_DB_PATH to a throwaway path. Use `npm run test:v2`.');
}
const OWN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'scruple-host-hook-'));
process.env.SCRUPLE_DB_PATH = path.join(OWN_DIR, 'host-hook.db');
process.env.SCRUPLE_BDK_HEX = 'd6'.repeat(32);
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
  POST: (req: Request) => Promise<Response>;
};

let M: Mod;
const TENANT = 'vendor-d6';
const BUILD = 'sha256:' + '6d'.repeat(32);
const BASELINE = '6'.repeat(64);
let API_KEY: string;

/* ────────────────────────────────────────────────────────────────────────
 * A FAKE HOST. Deliberately not Blender: docs/DESIGN.md says "Blender is the
 * first consumer of this hook, not a special case", and a test that could only
 * be satisfied by the host we happen to have would be testing the special
 * case. `phantom-cam` is a host we have not met — which is the phrase
 * lib/capture/surface.ts uses for what the ObservationSink contract is for.
 * ──────────────────────────────────────────────────────────────────────── */

const PHANTOM: HostRegistration = {
  host: 'phantom-cam',
  hostVersion: '4.2.1',
  adapter: 'viewport',
  adapterVersion: '1.0.0',
  evidenceType: 'scruple.dev/evidence/phantom-cam-viewport/v1',
  hooks: ['artifact.produced', 'graph.execute'],
  surfaces: ['host-api-callback'],
  fidelity: 'as-written',
  // DECLARED attested-client with NOTHING ENFORCING IT — the same posture
  // lib/capture/surface.ts records for `blender` and `fusion_today`. The gap
  // between the declaration and the enforcement is the finding, and
  // `assuranceForHost` is what turns it into a degraded placement rather than
  // a claim we repeat.
  declaredPlacement: 'attested-client',
  enforcement: 'none',
  schema: {
    type: 'object',
    required: ['scene', 'frame', 'camera'],
    properties: {
      scene: { type: 'string' },
      frame: { type: 'integer' },
      camera: { type: 'string' },
    },
  },
};

const OBSERVATION = (over: Partial<CaptureObservation> = {}): CaptureObservation => ({
  hook: 'artifact.produced',
  surface: 'network-gate',
  correlationId: 'prompt-1',
  bytes: { fidelity: 'as-delivered', contentHash: 'c'.repeat(64), mime: 'image/png', sizeBytes: 9 },
  evidence: { egress: '/view', kind: 'artifact' },
  observedAt: '2026-09-09T00:00:00.000Z',
  ...over,
});

/** Collects what the SDK would have submitted. Nothing here reaches a wire. */
function collector(): ObservationSink & { seen: CaptureObservation[] } {
  const seen: CaptureObservation[] = [];
  return {
    seen,
    async emit(o: CaptureObservation) {
      seen.push(o);
    },
  };
}

function adapterFor(
  answer: (o: CaptureObservation) => Record<string, unknown> | null,
  registration: HostRegistration = PHANTOM,
): HostAdapter {
  return { registration, semanticsFor: async (o) => answer(o) };
}

/* ────────────────────────────────────────────────────────────────────────
 * Route-side fixtures.
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
    upstream_low_watermark_open: 0,
    upstream_low_watermark_close: 0,
    upstream_uncaptured_reason: 'enumerated',
    upstream_source: 'measured',
    host: null,
    host_adapter: null,
    host_evidence_type: null,
    host_semantics: 'blind',
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
  const { componentId, token } = M.issueProvisioningToken({ tenantId: TENANT, label: 'd6' });
  assert.ok(M.redeemProvisioningToken({ token, tenantId: TENANT, buildMeasurement: BUILD }).ok);
  nextCounter = 0;
  return componentId;
}

before(async () => {
  const [sqlite, migrate, provisioning, ratchet, bdkMod, preimage, route] = await Promise.all([
    import('../../lib/db/sqlite'),
    import('../../lib/db/migrate'),
    import('../../lib/ratchet/provisioning'),
    import('../../lib/ratchet/ratchet'),
    import('../../lib/ratchet/bdk'),
    import('../../lib/leaf/componentPreimage'),
    import('../../app/api/v2/witness/route'),
  ]);
  M = {
    conn: sqlite.conn,
    runMigrations: migrate.runMigrations,
    issueProvisioningToken: provisioning.issueProvisioningToken,
    redeemProvisioningToken: provisioning.redeemProvisioningToken,
    deriveIk: ratchet.deriveIk,
    Ratchet: ratchet.Ratchet,
    bdk: bdkMod.bdk,
    componentPreimage: preimage.componentPreimage,
    POST: route.POST as unknown as Mod['POST'],
  };
  M.runMigrations(false);
  M.conn().prepare(`INSERT INTO users (id, email) VALUES (?, ?)`).run(TENANT, 'd6@example.com');
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

/* ══════════════════════════════════════════════════════════════════════
 * 1. Registration — how a host declares itself, and what it may not say.
 * ════════════════════════════════════════════════════════════════════ */

describe('WO-D6 — registration is explicit, static, and validated', () => {
  test('a well-formed host registers, and its assurance is DERIVED not declared', () => {
    _resetHostRegistryForTests();
    const entry = registerHost(PHANTOM);
    assert.deepEqual(registeredHosts(), ['phantom-cam']);

    // It DECLARED attested-client. Nothing enforces that, so the resolved
    // placement degrades — and the grade follows the resolution, never the
    // declaration. This is why a host may not hand in its own attestation.
    assert.equal(entry.assurance.resolution.declared, 'attested-client');
    assert.equal(entry.assurance.resolution.effective, 'unattested-client');
    assert.equal(entry.profile.attestation, 'none');
  });

  test('a host may NOT grade itself', () => {
    _resetHostRegistryForTests();
    const cheating = { ...PHANTOM, attestation: 'verified' } as unknown as HostRegistration;
    assert.throws(
      () => registerHost(cheating),
      (e: unknown) =>
        e instanceof HostRegistrationError && e.code === 'host_may_not_grade_itself',
    );
    assert.deepEqual(registeredHosts(), [], 'a refused registration leaves nothing behind');
  });

  test('an unversioned evidence type is refused — a shape that changes silently is unreadable in hindsight', () => {
    _resetHostRegistryForTests();
    for (const bad of ['phantom-cam-viewport', 'scruple.dev/evidence/viewport', 'HTTP://x/evidence/y/v1']) {
      assert.throws(
        () => registerHost({ ...PHANTOM, evidenceType: bad }),
        (e: unknown) =>
          e instanceof HostRegistrationError && e.code === 'evidence_type_unversioned',
        bad,
      );
    }
  });

  test('a schema that requires nothing is refused — an adapter that can never decline says nothing when it supplies', () => {
    _resetHostRegistryForTests();
    assert.throws(
      () => registerHost({ ...PHANTOM, schema: { type: 'object', required: [] } }),
      (e: unknown) => e instanceof HostRegistrationError && e.code === 'schema_requires_nothing',
    );
  });

  test('no hooks, no surfaces, and a duplicate are each refused', () => {
    _resetHostRegistryForTests();
    assert.throws(
      () => registerHost({ ...PHANTOM, hooks: [] }),
      (e: unknown) => e instanceof HostRegistrationError && e.code === 'hooks_empty',
    );
    assert.throws(
      () => registerHost({ ...PHANTOM, surfaces: [] }),
      (e: unknown) => e instanceof HostRegistrationError && e.code === 'surfaces_empty',
    );
    registerHost(PHANTOM);
    assert.throws(
      () => registerHost(PHANTOM),
      (e: unknown) => e instanceof HostRegistrationError && e.code === 'host_already_registered',
    );
  });

  test('the level is DERIVED from the semantics, never asserted', () => {
    assert.equal(hostCaptureLevel('blind'), 1);
    assert.equal(hostCaptureLevel('declined'), 2);
    assert.equal(hostCaptureLevel('supplied'), 2);
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * 2. The adapter sink — the composition, and what it refuses to let a host do.
 * ════════════════════════════════════════════════════════════════════ */

describe('WO-D6 — a registered adapter supplies the meaning, and only the meaning', () => {
  test('THE GATE: the fake host\'s semantics reach the observation the SDK would submit', async () => {
    const inner = collector();
    const sink = hostAdapterSink({
      adapter: adapterFor(() => ({ scene: 'atrium', frame: 240, camera: 'CAM_hero' })),
      inner,
      log: () => {},
    });
    await sink.emit(OBSERVATION());

    assert.equal(inner.seen.length, 1, 'a sink may never swallow an observation');
    const ev = inner.seen[0].evidence as Record<string, unknown>;
    assert.equal(ev.host_semantics, 'supplied');
    assert.equal(ev.host, 'phantom-cam');
    assert.equal(ev.host_adapter, 'viewport@1.0.0');
    assert.equal(ev.host_evidence_type, 'scruple.dev/evidence/phantom-cam-viewport/v1');
    assert.deepEqual(ev.host_evidence, { scene: 'atrium', frame: 240, camera: 'CAM_hero' });
    // The digest binds the document, and it is the SDK's canonicalization —
    // not a second implementation of a preimage.
    assert.equal(
      ev.host_evidence_hash,
      hashHostEvidence({ scene: 'atrium', frame: 240, camera: 'CAM_hero' })!.hash,
    );
    // What the gate already knew is untouched. An adapter adds meaning; it
    // does not get to restate an observation.
    assert.equal(ev.egress, '/view');
    assert.equal(inner.seen[0].bytes!.contentHash, 'c'.repeat(64));
  });

  test('THE CONTROL: no adapter at all produces a leaf that DECLARES it is blind', () => {
    const built = buildLeaf(
      OBSERVATION(),
      {
        baselineRef: BASELINE,
        componentId: 'comp-1',
        buildMeasurement: BUILD,
        profile: 'desktop',
        enforcement: 'none',
        witnessEndpoint: 'https://witness.example.vendor/api',
        witnessAuthority: null,
        settlementWindowSeconds: DEFAULT_RETENTION_POLICY.settlement_window_s,
        retentionPolicyDigest: DEFAULT_RETENTION_POLICY_DIGEST,
      },
      0,
    );
    // Not absent. Not undefined. A VALUE, and it is in the preimage.
    assert.equal(built.submission.capture.host_semantics, 'blind');
    assert.equal(built.submission.capture.host, null);
    assert.equal(built.submission.capture.host_adapter, null);
    assert.equal(built.preimage.host_semantics, 'blind');
    assert.equal(built.submission.host_evidence, undefined);
  });

  test('an adapter with nothing to say DECLINES — which is neither blind nor supplied', async () => {
    const inner = collector();
    const sink = hostAdapterSink({ adapter: adapterFor(() => null), inner, log: () => {} });
    await sink.emit(OBSERVATION());
    const ev = inner.seen[0].evidence as Record<string, unknown>;
    assert.equal(ev.host_semantics, 'declined');
    // It still NAMES the integration: those are facts about the deployment,
    // true whether or not this observation was announced.
    assert.equal(ev.host, 'phantom-cam');
    assert.equal(ev.host_adapter, 'viewport@1.0.0');
    // And it carries no document and no digest, which is what declined means.
    assert.equal(ev.host_evidence, undefined);
    assert.equal(ev.host_evidence_hash, undefined);
    assert.equal(sink.enrichments[0].reason, 'no-announcement');
  });

  test('a PARTIAL announcement is declined, not supplied-with-holes', async () => {
    const inner = collector();
    const sink = hostAdapterSink({
      adapter: adapterFor(() => ({ scene: 'atrium', frame: 240 })), // no camera
      inner,
      log: () => {},
    });
    await sink.emit(OBSERVATION());
    const ev = inner.seen[0].evidence as Record<string, unknown>;
    assert.equal(ev.host_semantics, 'declined');
    assert.equal(sink.enrichments[0].reason, 'schema:missing camera');
  });

  test('an adapter that THROWS costs the leaf its semantics and never the artifact its leaf', async () => {
    const inner = collector();
    const sink = hostAdapterSink({
      adapter: {
        registration: PHANTOM,
        semanticsFor: async () => {
          throw new Error('the add-on crashed mid-render');
        },
      },
      inner,
      log: () => {},
    });
    await sink.emit(OBSERVATION());
    assert.equal(inner.seen.length, 1, 'the observation still reached the Submitter');
    assert.equal((inner.seen[0].evidence as Record<string, unknown>).host_semantics, 'declined');
    assert.match(sink.enrichments[0].reason, /^threw: /);
  });

  test('an adapter answering for a hook it never declared is declined', async () => {
    const inner = collector();
    const sink = hostAdapterSink({
      adapter: adapterFor(() => ({ scene: 'x', frame: 1, camera: 'c' })),
      inner,
      log: () => {},
    });
    await sink.emit(OBSERVATION({ hook: 'model.write' }));
    const ev = inner.seen[0].evidence as Record<string, unknown>;
    assert.equal(ev.host_semantics, 'declined');
    assert.equal(sink.enrichments[0].reason, 'hook-not-declared: model.write');
  });

  test('a second adapter may not overwrite the first — a disagreement is a finding, not a merge', async () => {
    const inner = collector();
    const second = hostAdapterSink({
      adapter: adapterFor(() => ({ scene: 'OTHER', frame: 9, camera: 'CAM_b' })),
      inner,
      log: () => {},
    });
    await second.emit(
      OBSERVATION({
        evidence: {
          host: 'other-host',
          host_adapter: 'first@1',
          host_evidence_type: 'scruple.dev/evidence/other/v1',
          host_semantics: 'supplied',
          host_evidence: { scene: 'FIRST' },
          host_evidence_hash: 'a'.repeat(64),
        },
      }),
    );
    const ev = inner.seen[0].evidence as Record<string, unknown>;
    assert.equal(ev.host, 'other-host');
    assert.deepEqual(ev.host_evidence, { scene: 'FIRST' });
    assert.equal(second.enrichments[0].reason, 'already-present');
  });

  test('hashHostEvidence returns null for an empty manifest — NOT the digest of {}', () => {
    assert.equal(hashHostEvidence({}), null);
    assert.equal(hashHostEvidence(null), null);
    // ...because the digest of {} would assert we asked the host and it
    // genuinely had nothing, which is what `declined` says and this must not.
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * 3. Rule 7 — what a leaf is entitled to say about its own level.
 * ════════════════════════════════════════════════════════════════════ */

describe('WO-D6 — the level is declared, and Level 2 needs somebody behind it', () => {
  const claim = (over: Record<string, unknown>, body: Record<string, unknown> = {}) =>
    validateCaptureClaims({ ...body, capture: captureBlock(over) });

  test('a capture-bearing leaf with NO host_semantics is REQUIRED to declare one', () => {
    const r = validateCaptureClaims({
      capture: (() => {
        const c = captureBlock();
        delete c.host_semantics;
        return c;
      })(),
    });
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.code, 'host_semantics_required');
  });

  test('"supplied" or "declined" with no adapter is refused', () => {
    for (const s of ['supplied', 'declined']) {
      const r = claim({ host_semantics: s, host_evidence_hash: s === 'supplied' ? 'a'.repeat(64) : null });
      assert.equal(r.ok, false, s);
      assert.equal(r.ok === false && r.code, 'host_semantics_refused', s);
    }
  });

  test('"blind" that names anybody is refused — two statements that cannot both be true', () => {
    for (const over of [
      { host: 'phantom-cam' },
      { host_adapter: 'viewport@1.0.0' },
      { host_evidence_type: 'scruple.dev/evidence/x/v1' },
      { host_evidence_hash: 'a'.repeat(64) },
    ]) {
      const r = claim(over);
      assert.equal(r.ok, false, JSON.stringify(over));
      assert.equal(r.ok === false && r.code, 'host_semantics_refused');
    }
    const withDoc = claim({}, { host_evidence: { scene: 'x' } });
    assert.equal(withDoc.ok, false, 'a blind leaf carrying a document is refused too');
  });

  test('"supplied" that supplied nothing, and "declined" that shipped a document, are both refused', () => {
    const suppliedNothing = claim({
      host: 'phantom-cam',
      host_adapter: 'viewport@1.0.0',
      host_evidence_type: 'scruple.dev/evidence/phantom-cam-viewport/v1',
      host_semantics: 'supplied',
      host_evidence_hash: null,
    });
    assert.equal(suppliedNothing.ok, false);

    const declinedAnyway = claim(
      {
        host: 'phantom-cam',
        host_adapter: 'viewport@1.0.0',
        host_evidence_type: 'scruple.dev/evidence/phantom-cam-viewport/v1',
        host_semantics: 'declined',
      },
      { host_evidence: { scene: 'x', frame: 1, camera: 'c' } },
    );
    assert.equal(declinedAnyway.ok, false);
  });

  test('a host field sent ONE LEVEL UP is refused — the preimage reads that block by key', () => {
    const r = validateCaptureClaims({ capture: captureBlock(), host_semantics: 'supplied' });
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.code, 'host_semantics_refused');
  });

  test('ANTI-VACUITY: all three legal shapes are ACCEPTED', () => {
    const blind = claim({});
    assert.equal(blind.ok, true);
    assert.equal(blind.ok === true && blind.host!.level, 1);

    const declined = claim({
      host: 'phantom-cam',
      host_adapter: 'viewport@1.0.0',
      host_evidence_type: 'scruple.dev/evidence/phantom-cam-viewport/v1',
      host_semantics: 'declined',
    });
    assert.equal(declined.ok, true);
    assert.equal(declined.ok === true && declined.host!.level, 2);

    const supplied = claim(
      {
        host: 'phantom-cam',
        host_adapter: 'viewport@1.0.0',
        host_evidence_type: 'scruple.dev/evidence/phantom-cam-viewport/v1',
        host_semantics: 'supplied',
        host_evidence_hash: hashHostEvidence({ scene: 'a', frame: 1, camera: 'c' })!.hash,
      },
      { host_evidence: { scene: 'a', frame: 1, camera: 'c' } },
    );
    assert.equal(supplied.ok, true);
    assert.equal(supplied.ok === true && supplied.host!.level, 2);
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * 4. The route — the semantics reach the leaf, and the level is in the MAC.
 * ════════════════════════════════════════════════════════════════════ */

describe('WO-D6 — POST /api/v2/witness stores the level and the document', () => {
  test('THE GATE: a Level-2 leaf is stored with the host\'s semantics on it', async () => {
    const id = provision();
    const evidence = { scene: 'atrium', frame: 240, camera: 'CAM_hero' };
    const hashed = hashHostEvidence(evidence)!;
    const body = submission(
      id,
      nextCounter++,
      captureBlock({
        host: 'phantom-cam',
        host_adapter: 'viewport@1.0.0',
        host_evidence_type: 'scruple.dev/evidence/phantom-cam-viewport/v1',
        host_semantics: 'supplied',
        host_evidence_hash: hashed.hash,
      }),
      { host_evidence: evidence },
    );
    const res = await M.POST(witnessReq(body));
    assert.equal(res.status, 201, await res.text());

    const row = M.conn()
      .prepare(
        `SELECT host, host_adapter, host_evidence_type, host_semantics,
                host_evidence, host_evidence_hash
           FROM iterations WHERE output_hash = ?`,
      )
      .get(body.content_hash) as Record<string, string | null>;
    assert.equal(row.host, 'phantom-cam');
    assert.equal(row.host_adapter, 'viewport@1.0.0');
    assert.equal(row.host_semantics, 'supplied');
    assert.equal(row.host_evidence_hash, hashed.hash);
    assert.deepEqual(JSON.parse(row.host_evidence!), evidence);
    // The stored manifest is the BYTES THAT WERE HASHED, so a verifier
    // holding this column reproduces the digest without our help.
    assert.equal(
      crypto.createHash('sha256').update(row.host_evidence!, 'utf8').digest('hex'),
      row.host_evidence_hash,
    );
  });

  test('THE CONTROL: the same submission with no adapter stores `blind`, and says so', async () => {
    const id = provision();
    const body = submission(id, nextCounter++, captureBlock());
    const res = await M.POST(witnessReq(body));
    assert.equal(res.status, 201, await res.text());
    const row = M.conn()
      .prepare(`SELECT host, host_semantics, host_evidence FROM iterations WHERE output_hash = ?`)
      .get(body.content_hash) as Record<string, string | null>;
    // NOT NULL. Null is "the question was never asked of this leaf" — canvas,
    // the plugins — and this leaf was asked and answered.
    assert.equal(row.host_semantics, 'blind');
    assert.equal(row.host, null);
    assert.equal(row.host_evidence, null);
  });

  test('a document and a digest that DISAGREE are refused rather than reconciled', async () => {
    const id = provision();
    const body = submission(
      id,
      nextCounter++,
      captureBlock({
        host: 'phantom-cam',
        host_adapter: 'viewport@1.0.0',
        host_evidence_type: 'scruple.dev/evidence/phantom-cam-viewport/v1',
        host_semantics: 'supplied',
        host_evidence_hash: 'b'.repeat(64),
      }),
      { host_evidence: { scene: 'atrium', frame: 240, camera: 'CAM_hero' } },
    );
    const res = await M.POST(witnessReq(body));
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'invalid_body');
  });

  test('⚑ THE LEVEL IS IN THE MAC: promoting a blind leaf to Level 2 in flight is refused', async () => {
    const id = provision();
    // MACed as blind — an honest Level-1 leaf from a deployment that
    // registered nobody.
    const body = submission(id, nextCounter++, captureBlock()) as Record<string, unknown>;
    // ...and rewritten in flight by something between the component and here,
    // claiming a registered host named these bytes.
    const evidence = { scene: 'somewhere-else', frame: 1, camera: 'CAM_forged' };
    const capture = body.capture as Record<string, unknown>;
    capture.host = 'phantom-cam';
    capture.host_adapter = 'viewport@1.0.0';
    capture.host_evidence_type = 'scruple.dev/evidence/phantom-cam-viewport/v1';
    capture.host_semantics = 'supplied';
    capture.host_evidence_hash = hashHostEvidence(evidence)!.hash;
    body.host_evidence = evidence;

    const res = await M.POST(witnessReq(body));
    const seen = await res.json();
    assert.equal(res.status, 422, JSON.stringify(seen));
    assert.equal(seen.error.code, 'component_unverified');
  });

  test('ANTI-VACUITY: rewriting the top-level host_evidence ALONE also fails, because the hash is signed', async () => {
    const id = provision();
    const evidence = { scene: 'atrium', frame: 240, camera: 'CAM_hero' };
    const body = submission(
      id,
      nextCounter++,
      captureBlock({
        host: 'phantom-cam',
        host_adapter: 'viewport@1.0.0',
        host_evidence_type: 'scruple.dev/evidence/phantom-cam-viewport/v1',
        host_semantics: 'supplied',
        host_evidence_hash: hashHostEvidence(evidence)!.hash,
      }),
      { host_evidence: evidence },
    ) as Record<string, unknown>;
    // The document is NOT in the preimage — only its digest is — so this
    // passes the MAC and is caught by the recomputation instead. Two guards,
    // and this test is what proves the second one is doing work.
    body.host_evidence = { scene: 'elsewhere', frame: 999, camera: 'CAM_forged' };
    const res = await M.POST(witnessReq(body));
    const seen = await res.json();
    assert.equal(res.status, 400, JSON.stringify(seen));
    assert.equal(seen.error.code, 'invalid_body');
  });
});
