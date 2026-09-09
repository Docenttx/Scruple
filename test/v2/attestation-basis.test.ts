// WO-C1 — the three-valued attestation basis, `stale` until the roots agree,
// and the `close_detection` validator rejection.
//
// The council settled a PER-LEAF attestation basis that every field-level
// `source: measured` is conditional on. One basis per leaf, no per-field
// `basis_ref` pointer — "twelve fields pointing at one basis still read as
// twelve measurements to anyone not following the pointer."
//
// THIS FILE IS THE CONTROL. Every rule below was demonstrated failing against
// the pre-WO code before the fix went in; the runs are recorded at
// /mnt/corpus/scruple-council-impl/wo-c1/. A green test with no control proves
// only that it cannot fail, and this whole series exists because a prose rule
// failed exactly that way inside the council itself.
//
// TEST ISOLATION follows test/v2/component-auth.test.ts: `npm run test:v2`
// runs every file concurrently against one shared SCRUPLE_DB_PATH, so this
// file takes a private database assigned at module top level, and everything
// reaching lib/db/sqlite is imported DYNAMICALLY inside before().

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_RETENTION_POLICY,
  DEFAULT_RETENTION_POLICY_DIGEST,
} from '../../lib/leaf/retentionPolicy';

if (!process.env.SCRUPLE_DB_PATH || !/tmp|test/i.test(process.env.SCRUPLE_DB_PATH)) {
  throw new Error('Refusing to run: set SCRUPLE_DB_PATH to a throwaway path. Use `npm run test:v2`.');
}
const OWN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'scruple-attestation-basis-'));
process.env.SCRUPLE_DB_PATH = path.join(OWN_DIR, 'attestation-basis.db');
process.env.SCRUPLE_BDK_HEX = 'a7'.repeat(32);
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
  POST: (req: Request) => Promise<Response>;
};

let M: Mod;
const TENANT = 'vendor-ab1';
const BUILD = 'sha256:' + '3c'.repeat(32);
const BASELINE = '7'.repeat(64);
let API_KEY: string;

/** The capture block a sidecar component sends TODAY, under the blocker. */
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
    // WO-C4. The storage confinement measured at emission, and its source.
    // Both are in the MAC preimage: the value says what was seen and the
    // source says whether anything was, and an attacker who could promote
    // `unknown` to `measured` would turn "nobody looked" into "somebody
    // checked". A capture-bearing leaf without them is refused by rule 5.
    confinement: 'confined',
    confinement_source: 'measured',
    // WO-C5. Which upstream run this leaf came from, and whether its
    // in-memory history ring survived. `upstream_identity` is the
    // /system_stats digest and is NOT a restart signal — it is
    // byte-identical across one — while `upstream_epoch` is derived from
    // the volatile /history ring and is. Both low watermarks, because
    // /history is paged and non-atomic. A capture-bearing leaf without
    // them is refused by rule 6.
    upstream_identity: 'sha256:' + 'ef'.repeat(32),
    upstream_epoch: 'epoch:' + '9a'.repeat(16),
    upstream_continuity: 'continuous',
    upstream_low_watermark_open: 0,
    upstream_low_watermark_close: 0,
    upstream_uncaptured_reason: 'enumerated',
    upstream_source: 'measured',
    // WO-E2 rule 8. A capture-bearing leaf must say what its absence set
    // enumerated over. These fixtures enumerate nothing — there is no
    // upstream ring behind them — so they carry the `not_enumerated` shape,
    // whose count and hash are NULL. An enumerated set carries a count even
    // when it is 0, and that is the distinction rule 8 refuses to collapse.
    uncaptured_enumeration_method: 'none',
    uncaptured_scope: 'not_enumerated',
    uncaptured_scope_source: 'unknown',
    declared_uncaptured_count: null,
    declared_uncaptured_hash: null,
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

/**
 * WO-C2. Every capture-bearing leaf now carries its resolution handles, and
 * they are in the MAC. Present here so that WO-C1's controls keep testing what
 * they were written to test: without them the route refuses on
 * `resolution_handles_required` and the basis rules are never reached, which
 * would turn six controls into six passes for the wrong reason.
 */
const RESOLUTION = () => ({
  witness_endpoint: 'https://witness.example.vendor/api',
  witness_authority: 'sha256:' + 'cd'.repeat(32),
  checkpoint_id: null,
  prev_checkpoint_id: null,
  prev_checkpoint_quote_time: null,
  // WO-C3. And the two that bind the DURATION. A FUNCTION rather than a
  // constant, because the deadline is checked against a named clock at ingest
  // — a module-level literal would drift out of the band the first time this
  // file was left running, and would fail with a message about clock skew in a
  // test about something else.
  settlement_deadline: new Date(
    Date.now() + DEFAULT_RETENTION_POLICY.settlement_window_s * 1000,
  ).toISOString(),
  retention_policy_digest: DEFAULT_RETENTION_POLICY_DIGEST,
});

function submission(componentId: string, counter: number, capture: Record<string, unknown>) {
  const body: Record<string, unknown> = {
    baseline_ref: BASELINE,
    kind: 'artifact',
    content_hash: crypto.randomBytes(32).toString('hex'),
    mime: 'image/png',
    capture,
    resolution: RESOLUTION(),
    component: {
      component_id: componentId,
      build_measurement: BUILD,
      counter,
      attestation: { provider: 'none', quote_ref: null },
    },
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
let nextSeq = 1;
let projectIdForConstraintTest = 0;
function provision(): string {
  const { componentId, token } = M.issueProvisioningToken({ tenantId: TENANT, label: 'sidecar' });
  assert.ok(M.redeemProvisioningToken({ token, tenantId: TENANT, buildMeasurement: BUILD }).ok);
  nextCounter = 0;
  return componentId;
}

before(async () => {
  const [sqlite, migrate, prov, ratchet, bdkMod, preimage, route] = await Promise.all([
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
    issueProvisioningToken: prov.issueProvisioningToken,
    redeemProvisioningToken: prov.redeemProvisioningToken,
    deriveIk: ratchet.deriveIk,
    Ratchet: ratchet.Ratchet,
    bdk: bdkMod.bdk,
    componentPreimage: preimage.componentPreimage,
    POST: route.POST as unknown as (req: Request) => Promise<Response>,
  };
  M.runMigrations(false);
  M.conn().prepare(`INSERT INTO users (id, email) VALUES (?, ?)`).run(TENANT, 'ab1@example.com');
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

  const created = M.conn()
    .prepare(
      `INSERT INTO projects
         (user_id, name, type, status, created_at,
          iteration_count, is_active, witnessed_count, is_archived)
       VALUES (?, 'constraint-probe', 'image', 'unlocked', ?, 0, 0, 0, 0)`,
    )
    .run(TENANT, now);
  projectIdForConstraintTest = Number(created.lastInsertRowid);
});

after(() => {
  try {
    fs.rmSync(OWN_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// ---------------------------------------------------------------------------
// THE THREE CONTROLS. Each was RED before the fix — the route accepted the
// shape with a 201 — and each is named in the WO as a thing that must NOT fire.
// ---------------------------------------------------------------------------

describe('WO-C1 controls — the validator, not the prose', () => {
  test('CONTROL 1: a leaf claiming `verified` on the desktop profile is REJECTED', async () => {
    const id = provision();
    const res = await M.POST(
      witnessReq(
        submission(id, nextCounter++, captureBlock({ profile: 'desktop', attestation_status: 'verified' })),
      ),
    );
    assert.notEqual(res.status, 201);
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    assert.equal(body.error?.code, 'attestation_basis_refused');
    assert.match(String(body.error?.message), /desktop/i);
  });

  test('CONTROL 2: a leaf with `attestation_status: null` is REJECTED', async () => {
    const id = provision();
    const res = await M.POST(
      witnessReq(submission(id, nextCounter++, captureBlock({ attestation_status: null }))),
    );
    assert.notEqual(res.status, 201);
    const body = (await res.json()) as { error?: { code?: string } };
    assert.equal(body.error?.code, 'attestation_basis_required');
  });

  test('CONTROL 3: a `close_detection` value used as a provenance field is REJECTED', async () => {
    const id = provision();
    const res = await M.POST(
      witnessReq(
        submission(id, nextCounter++, captureBlock({ close_detection: 'fs-watch-quiescence' })),
      ),
    );
    assert.notEqual(res.status, 201);
    const body = (await res.json()) as { error?: { code?: string } };
    assert.equal(body.error?.code, 'close_detection_rejected');
  });

  test('THE GATE: a leaf emitted today is accepted and reads `stale`', async () => {
    const id = provision();
    const res = await M.POST(witnessReq(submission(id, nextCounter++, captureBlock())));
    assert.equal(res.status, 201);
    const body = (await res.json()) as {
      leaf_id: string;
      attestation_basis: { basis: string; profile: string | null };
    };
    assert.deepEqual(body.attestation_basis, { basis: 'stale', profile: 'isolated-sidecar' });
    const row = M.conn()
      .prepare(`SELECT attestation_basis, attestation_profile FROM iterations WHERE id = ?`)
      .get(Number(body.leaf_id)) as {
      attestation_basis: string | null;
      attestation_profile: string | null;
    };
    assert.equal(row.attestation_basis, 'stale');
    assert.equal(row.attestation_profile, 'isolated-sidecar');
  });
});

// ---------------------------------------------------------------------------
// THE RESOLVER. Pure logic, no database — the same rule the emitters run.
//
// THE ANTI-VACUITY CONTROL IS THE LAST TEST IN THIS BLOCK and it is the one
// that matters. Every test above it asserts `stale`, and a resolver hardcoded
// to return `stale` would satisfy all of them. So one test drives the settled
// path with a bound quote and asserts `verified` comes back: `stale` is what
// the BLOCKER produces, not what the function is capable of.
// ---------------------------------------------------------------------------

describe('the three-valued basis', () => {
  test('every leaf emitted today is `stale`, at every profile', async () => {
    const { resolveAttestationBasis, CAPTURE_PROFILES, CHECKPOINT_VECTORS_SETTLED } = await import(
      '../../lib/leaf/attestationBasis'
    );
    // The blocker is real, not a test fixture.
    assert.equal(CHECKPOINT_VECTORS_SETTLED, false);

    for (const profile of CAPTURE_PROFILES) {
      const enforcement =
        profile === 'server-managed'
          ? 'no-tenant-code'
          : profile === 'isolated-sidecar'
            ? 'isolated-namespace'
            : 'none';
      const r = resolveAttestationBasis({ profile, enforcement });
      assert.equal(r.basis, 'stale', `${profile} must emit stale while the vectors disagree`);
      assert.match(r.reason, /shared Merkle vectors/);
    }
  });

  test('`verified` is unreachable on the desktop profile even with a perfect quote', async () => {
    const { resolveAttestationBasis } = await import('../../lib/leaf/attestationBasis');
    // Root-chained, nonce from outside the box, covering this emission — the
    // strongest quote the model can express — and every enforcement, INCLUDING
    // `host-enforced-signature`, which §1 names as a requirement for verified.
    const perfect = {
      rootChained: true,
      nonceOrigin: 'external-authority' as const,
      coversEmission: true,
    };
    for (const enforcement of [
      'host-enforced-signature',
      'isolated-namespace',
      'no-tenant-code',
      'none',
    ] as const) {
      const r = resolveAttestationBasis({
        profile: 'desktop',
        enforcement,
        quote: perfect,
        // Settled, so nothing but the profile is holding `verified` back.
        vectorsSettled: true,
      });
      assert.notEqual(r.basis, 'verified', `desktop + ${enforcement} must never be verified`);
    }
  });

  test('an unbindable quote is `stale`, NOT folded into `passthrough`', async () => {
    const { resolveAttestationBasis } = await import('../../lib/leaf/attestationBasis');
    const cases = [
      { rootChained: false, nonceOrigin: 'external-authority' as const, coversEmission: true },
      { rootChained: true, nonceOrigin: 'in-box' as const, coversEmission: true },
      { rootChained: true, nonceOrigin: 'none' as const, coversEmission: true },
      { rootChained: true, nonceOrigin: 'external-authority' as const, coversEmission: false },
    ];
    for (const quote of cases) {
      const r = resolveAttestationBasis({
        profile: 'isolated-sidecar',
        enforcement: 'isolated-namespace',
        quote,
        vectorsSettled: true,
      });
      assert.equal(r.basis, 'stale', JSON.stringify(quote));
      // The CONTROL on this rule: `passthrough` is the wrong answer and the
      // reason says why. They are different operational conditions with
      // different fixes, and collapsing them sends the operator to buy
      // hardware they already own.
      assert.notEqual(r.basis, 'passthrough');
      assert.match(r.reason, /NOT as `passthrough`/);
    }
  });

  test('no quote at all IS `passthrough` — which is what makes the line above meaningful', async () => {
    const { resolveAttestationBasis } = await import('../../lib/leaf/attestationBasis');
    const r = resolveAttestationBasis({
      profile: 'server-managed',
      enforcement: 'no-tenant-code',
      quote: null,
      vectorsSettled: true,
    });
    assert.equal(r.basis, 'passthrough');
  });

  test('ANTI-VACUITY: with the vectors settled and a bound quote, the answer IS `verified`', async () => {
    const { resolveAttestationBasis } = await import('../../lib/leaf/attestationBasis');
    for (const [profile, enforcement] of [
      ['server-managed', 'no-tenant-code'],
      ['isolated-sidecar', 'isolated-namespace'],
    ] as const) {
      const r = resolveAttestationBasis({
        profile,
        enforcement,
        quote: { rootChained: true, nonceOrigin: 'external-authority', coversEmission: true },
        vectorsSettled: true,
      });
      assert.equal(r.basis, 'verified', `${profile} must be able to reach verified`);
    }
  });

  test('absent, null and malformed all read as `unknown`, and never as verified', async () => {
    const { basisForTrust } = await import('../../lib/leaf/attestationBasis');
    for (const v of [
      undefined,
      null,
      '',
      'VERIFIED',
      ' verified',
      'verified ',
      'trusted',
      0,
      1,
      true,
      {},
      [],
      { toString: () => 'verified' },
    ]) {
      assert.equal(basisForTrust(v), 'unknown', JSON.stringify(v) ?? String(v));
    }
    // And the three real ones pass through unchanged, so the mapping is not
    // simply "everything is unknown".
    for (const v of ['verified', 'stale', 'passthrough']) {
      assert.equal(basisForTrust(v), v);
    }
  });

  test('the TYPE refuses `verified` on the desktop — checked by tsc, not by this runtime', async () => {
    const { type: _t } = await import('node:os');
    // THE ASSERTION IS THE @ts-expect-error DIRECTIVE, AND `npm run typecheck`
    // IS WHAT RUNS IT. If `BasisOn<'desktop'>` ever admits 'verified', the
    // directive becomes unused and TypeScript fails the build with
    // "Unused '@ts-expect-error' directive" — the guard breaks loudly rather
    // than quietly widening.
    type Desktop = import('../../lib/leaf/attestationBasis').BasisOn<'desktop'>;
    // @ts-expect-error — `verified` is not assignable on the desktop profile.
    const impossible: Desktop = 'verified';
    // The CONTROL, on the same type: the two values that ARE representable
    // compile without a directive. A type that admitted nothing would satisfy
    // the line above for the wrong reason.
    const stale: Desktop = 'stale';
    const passthrough: Desktop = 'passthrough';
    assert.equal(String(impossible), 'verified');
    assert.deepEqual([stale, passthrough], ['stale', 'passthrough']);
  });

  test('the profile comes from the EFFECTIVE placement, never a declared one', async () => {
    const { profileFor } = await import('../../lib/leaf/attestationBasis');
    const { resolvePlacement } = await import('../../lib/capture/surface');
    // A host DECLARING sidecar-gate with nothing enforcing it resolves to
    // unattested-client, and therefore to the desktop profile — where
    // `verified` is unreachable. Declaring your way up is the defect this
    // closes.
    const degraded = resolvePlacement('sidecar-gate', 'none');
    assert.equal(degraded.effective, 'unattested-client');
    assert.equal(profileFor(degraded.effective), 'desktop');

    const honoured = resolvePlacement('sidecar-gate', 'isolated-namespace');
    assert.equal(profileFor(honoured.effective), 'isolated-sidecar');
  });
});

// ---------------------------------------------------------------------------
// The guards that are NOT the validator. Three independent mechanisms say the
// same thing, and each is tested where it lives — a test that only exercised
// the route would pass while the other two rotted.
// ---------------------------------------------------------------------------

describe('the other two guards', () => {
  test('the DATABASE refuses a verified/desktop row — it constrains, it does not merely index', () => {
    const insert = (basis: string, profile: string) =>
      M.conn()
        .prepare(
          `INSERT INTO iterations
             (project_id, run_sequence, timestamp, leaf_hash, output_hash, output_kind,
              witnessed, attestation_basis, attestation_profile)
           VALUES (?, ?, ?, ?, ?, 'image', 0, ?, ?)`,
        )
        .run(
          projectIdForConstraintTest,
          nextSeq++,
          new Date().toISOString(),
          crypto.randomBytes(32).toString('hex'),
          crypto.randomBytes(32).toString('hex'),
          basis,
          profile,
        );

    assert.throws(
      () => insert('verified', 'desktop'),
      /CHECK constraint failed/,
      'migration 053 must REFUSE the combination, not file it',
    );
    // THE CONTROL. If the CHECK were malformed it could refuse everything,
    // and the assertion above would pass for the wrong reason.
    assert.doesNotThrow(() => insert('verified', 'server-managed'));
    assert.doesNotThrow(() => insert('stale', 'desktop'));
    // And a value outside the enum is refused too.
    assert.throws(() => insert('trusted', 'desktop'), /CHECK constraint failed/);
  });

  test('the PROFILE is inside the MAC — rewriting it in flight invalidates the signature', async () => {
    const id = provision();
    const good = submission(id, nextCounter++, captureBlock({ profile: 'isolated-sidecar' }));

    // A proxy between the component and this route flips one field. The MAC
    // is untouched. This is the shape WO-C2 is about, and it is why the
    // profile could not be left out of the preimage: `verified` is refused on
    // `desktop`, and an unsigned profile puts that refusal one byte away from
    // being bypassed.
    const tampered = JSON.parse(JSON.stringify(good)) as typeof good;
    (tampered.capture as Record<string, unknown>).profile = 'server-managed';

    const res = await M.POST(witnessReq(tampered));
    const body = (await res.json()) as { error?: { code?: string } };
    assert.equal(res.status, 422);
    assert.equal(body.error?.code, 'component_unverified');

    // THE CONTROL: the untampered submission verifies. Without this, a route
    // that rejected everything would pass the assertion above.
    const ok = await M.POST(witnessReq(good));
    assert.equal(ok.status, 201);
  });
});

// ---------------------------------------------------------------------------
// The legacy path, which must NOT have been broken by any of the above.
// ---------------------------------------------------------------------------

describe('legacy leaves still witness, and read as `unknown`', () => {
  test('a submission with no capture block is accepted and records no basis', async () => {
    const res = await M.POST(
      witnessReq({
        baseline_ref: BASELINE,
        kind: 'artifact',
        content_hash: crypto.randomBytes(32).toString('hex'),
        mime: 'image/png',
      }),
    );
    assert.equal(res.status, 201);
    const body = (await res.json()) as {
      leaf_id: string;
      attestation_basis: { basis: string; profile: string | null };
    };
    // 'unknown', not null and not absent: the question was never asked of
    // canvas or the plugins, and that is a fact a consumer can act on.
    assert.deepEqual(body.attestation_basis, { basis: 'unknown', profile: null });
    const row = M.conn()
      .prepare(`SELECT attestation_basis FROM iterations WHERE id = ?`)
      .get(Number(body.leaf_id)) as { attestation_basis: string | null };
    assert.equal(row.attestation_basis, null);
  });

  test('`close_detection` smuggled up one level, outside the capture block, is still rejected', async () => {
    const res = await M.POST(
      witnessReq({
        baseline_ref: BASELINE,
        kind: 'artifact',
        content_hash: crypto.randomBytes(32).toString('hex'),
        mime: 'image/png',
        close_detection: 'IN_CLOSE_WRITE',
      }),
    );
    const body = (await res.json()) as { error?: { code?: string } };
    assert.equal(res.status, 422);
    assert.equal(body.error?.code, 'close_detection_rejected');
  });
});
