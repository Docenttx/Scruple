// WO-C3 — three distinguishable states from one query path, and a deadline
// bound to a clock somebody named.
//
// Architect settled the claims-versus-evidence split on two conditions. WO-C2
// was the first. This file is the second:
//
//   "the `retention_policy_digest` must bind evidence RETENTION DURATION, not
//    just policy identity, so a resolution attempt after the evidence is
//    legitimately gone yields a named `evidence_expired` state rather than
//    being INDISTINGUISHABLE FROM A FORGED HANDLE."
//
// and, from hand round 7, the half about silence:
//
//   "an unresolved gap that never expires is indistinguishable from a policy
//    of never checking — the verifier defaults to accept by exhaustion ... at
//    deadline the gap flips to a terminal `expired` ... and `expired` must
//    itself be `source: measured` against a NAMED CLOCK, since a deadline
//    derived from a locally-set timestamp is exactly the config-inherited
//    field class we already refused."
//
// THE GATE IS "THREE STATES FROM ONE QUERY PATH" AND THE CONTROL IS "THEY MUST
// NOT COLLAPSE INTO ONE ANOTHER". Both were fired at the pre-WO code first,
// where all four shapes answered a BYTE-IDENTICAL HTTP 404 — the query path
// did not exist, and through the receipt path a reaped leaf and a leaf id
// nobody ever issued were the same bytes. That run is at
// /mnt/corpus/scruple-council-impl/wo-c3/01-controls-RED.txt and is reproduced
// in docs/canon/council-impl/WO-C3.md.
//
// TEST ISOLATION follows test/v2/resolution-handles.test.ts: `npm run test:v2`
// runs every file concurrently against one shared SCRUPLE_DB_PATH, so this
// file takes a private database assigned at module top level, and everything
// reaching lib/db/sqlite is imported DYNAMICALLY inside before().

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// STATIC, and it may be: `lib/leaf/retentionPolicy.ts` is the PURE half — a
// digest function and the default policy. The registry that touches the
// database is `retentionRegistry.ts`, imported dynamically below.
import {
  DEFAULT_RETENTION_POLICY,
  DEFAULT_RETENTION_POLICY_DIGEST,
  retentionPolicyDigest,
  validateRetentionPolicy,
  type RetentionPolicy,
} from '../../lib/leaf/retentionPolicy';
import { SCRUPLE_CLOCK, MAX_CLOCK_SKEW_S } from '../../lib/leaf/namedClock';

if (!process.env.SCRUPLE_DB_PATH || !/tmp|test/i.test(process.env.SCRUPLE_DB_PATH)) {
  throw new Error('Refusing to run: set SCRUPLE_DB_PATH to a throwaway path. Use `npm run test:v2`.');
}
const OWN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'scruple-retention-settlement-'));
process.env.SCRUPLE_DB_PATH = path.join(OWN_DIR, 'retention-settlement.db');
process.env.SCRUPLE_BDK_HEX = 'e4'.repeat(32);
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
  enrollRetentionPolicy: typeof import('../../lib/leaf/retentionRegistry').enrollRetentionPolicy;
  resolveRetentionPolicy: typeof import('../../lib/leaf/retentionRegistry').resolveRetentionPolicy;
  bindSettlement: typeof import('../../lib/leaf/settlement').bindSettlement;
  evaluateSettlement: typeof import('../../lib/leaf/settlement').evaluateSettlement;
  evaluateEvidence: typeof import('../../lib/leaf/settlement').evaluateEvidence;
  POST: (req: Request) => Promise<Response>;
  RESOLVE: (req: Request, ctx: { params: Promise<{ leaf_id: string }> }) => Promise<Response>;
  RECEIPT: (req: Request, ctx: { params: Promise<{ leaf_id: string }> }) => Promise<Response>;
};

let M: Mod;
const TENANT = 'vendor-c3a';
const BUILD = 'sha256:' + '9e'.repeat(32);
const BASELINE = '7'.repeat(64);
let API_KEY: string;

const ENDPOINT = 'https://witness.example.vendor/api';
const AUTHORITY = 'sha256:' + 'ef'.repeat(32);

/** A policy whose evidence is gone in a second, so an expiry can be OBSERVED
 *  rather than asserted about a month from now. */
const FAST: RetentionPolicy = {
  version: 1,
  policy_id: 'wo-c3-one-second',
  clock: SCRUPLE_CLOCK,
  retention_duration_s: 1,
  settlement_window_s: 1,
};
/** A policy counted on a clock this server is NOT an authority for. Legal as a
 *  policy — a partner timestamp authority is a real thing — and refused at
 *  ingest, because a deadline we cannot check is a deadline nobody checked. */
/** Same durations as the default, different identity — so a swap to it passes
 *  every rule except the signature. */
const ALT_30D: RetentionPolicy = {
  ...DEFAULT_RETENTION_POLICY,
  policy_id: 'wo-c3-alternate-thirty-day',
};
const FOREIGN_CLOCK: RetentionPolicy = {
  version: 1,
  policy_id: 'wo-c3-partner-tsa',
  clock: 'partner-tsa-v1',
  retention_duration_s: 3600,
  settlement_window_s: 60,
};

const deadlineIn = (s: number, fromMs = Date.now()) => new Date(fromMs + s * 1000).toISOString();

function handles(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    witness_endpoint: ENDPOINT,
    witness_authority: AUTHORITY,
    checkpoint_id: null,
    prev_checkpoint_id: null,
    prev_checkpoint_quote_time: null,
    settlement_deadline: deadlineIn(DEFAULT_RETENTION_POLICY.settlement_window_s),
    retention_policy_digest: DEFAULT_RETENTION_POLICY_DIGEST,
    ...over,
  };
}

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
    observed_at: new Date().toISOString(),
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

let nextCounter = 0;
function provision(): string {
  const { componentId, token } = M.issueProvisioningToken({ tenantId: TENANT, label: 'sidecar' });
  assert.ok(M.redeemProvisioningToken({ token, tenantId: TENANT, buildMeasurement: BUILD }).ok);
  nextCounter = 0;
  return componentId;
}

/** Build an HONEST submission and MAC it, then hand it to `tamper` — a party
 *  between the component and the route that holds no key. */
function submission(
  componentId: string,
  counter: number,
  opts: {
    capture?: Record<string, unknown> | null;
    resolution?: Record<string, unknown> | null;
    omitResolution?: boolean;
    omitComponent?: boolean;
    tamper?: (b: Record<string, unknown>) => void;
  } = {},
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    baseline_ref: BASELINE,
    kind: 'artifact',
    content_hash: crypto.randomBytes(32).toString('hex'),
    mime: 'image/png',
  };
  if (opts.capture !== null) body.capture = opts.capture ?? captureBlock();
  if (!opts.omitResolution) body.resolution = opts.resolution ?? handles();
  if (!opts.omitComponent) {
    body.component = {
      component_id: componentId,
      build_measurement: BUILD,
      counter,
      attestation: { provider: 'none', quote_ref: null },
    };
    const r = new M.Ratchet(M.deriveIk(M.bdk(), componentId), 0);
    r.skip(counter);
    const { mac } = r.mac(M.componentPreimage(body as never));
    r.destroy();
    body.mac = mac;
  }
  if (opts.tamper) opts.tamper(body);
  return body;
}

const witnessReq = (body: unknown) =>
  new Request('https://scruple.ai/api/v2/witness', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify(body),
  });

async function fire(
  opts: Parameters<typeof submission>[2],
): Promise<{ status: number; code?: string; body: Record<string, unknown> }> {
  const id = provision();
  const res = await M.POST(witnessReq(submission(id, nextCounter++, opts)));
  const json = (await res.json()) as Record<string, unknown>;
  return { status: res.status, code: (json.error as { code?: string } | undefined)?.code, body: json };
}

/** THE ONE QUERY PATH. `supplied` is what the verifier read off the leaf it is
 *  holding — following a handle means going with the values it carries. */
async function resolveLeaf(
  leafId: string | number,
  supplied: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  const qs = new URLSearchParams(supplied).toString();
  const res = await M.RESOLVE(
    new Request(`https://scruple.ai/api/v2/resolve/${leafId}${qs ? `?${qs}` : ''}`),
    { params: Promise.resolve({ leaf_id: String(leafId) }) },
  );
  return (await res.json()) as Record<string, unknown>;
}

before(async () => {
  const [sqlite, migrate, prov, ratchet, bdkMod, preimage, registry, settlement, route, resolve, receipt] =
    await Promise.all([
      import('../../lib/db/sqlite'),
      import('../../lib/db/migrate'),
      import('../../lib/ratchet/provisioning'),
      import('../../lib/ratchet/ratchet'),
      import('../../lib/ratchet/bdk'),
      import('../../lib/leaf/componentPreimage'),
      import('../../lib/leaf/retentionRegistry'),
      import('../../lib/leaf/settlement'),
      import('../../app/api/v2/witness/route'),
      import('../../app/api/v2/resolve/[leaf_id]/route'),
      import('../../app/api/v2/receipt/[leaf_id]/route'),
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
    enrollRetentionPolicy: registry.enrollRetentionPolicy,
    resolveRetentionPolicy: registry.resolveRetentionPolicy,
    bindSettlement: settlement.bindSettlement,
    evaluateSettlement: settlement.evaluateSettlement,
    evaluateEvidence: settlement.evaluateEvidence,
    POST: route.POST as unknown as (req: Request) => Promise<Response>,
    RESOLVE: resolve.GET as unknown as Mod['RESOLVE'],
    RECEIPT: receipt.GET as unknown as Mod['RECEIPT'],
  };
  M.runMigrations(false);
  M.conn().prepare(`INSERT INTO users (id, email) VALUES (?, ?)`).run(TENANT, 'c3a@example.com');
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

  // The two extra policies this file uses. Enrolment is a DEPLOYMENT act, not
  // an ingest one — see lib/leaf/retentionRegistry.ts for why that is the
  // load-bearing half.
  M.enrollRetentionPolicy(FAST);
  M.enrollRetentionPolicy(FOREIGN_CLOCK);
  M.enrollRetentionPolicy(ALT_30D);
});

after(() => {
  try {
    fs.rmSync(OWN_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// ---------------------------------------------------------------------------
// The digest binds a DURATION. That is the whole claim of the field.
// ---------------------------------------------------------------------------

describe('WO-C3 — the digest binds duration, not identity', () => {
  test('the same policy_id with one more second of retention is a DIFFERENT digest', () => {
    const longer = { ...DEFAULT_RETENTION_POLICY, retention_duration_s: 30 * 24 * 3600 + 1 };
    // THE CONTROL, and it is what makes the line above mean anything: the
    // identity really is unchanged, so what moved the digest was the duration.
    assert.equal(longer.policy_id, DEFAULT_RETENTION_POLICY.policy_id);
    assert.notEqual(retentionPolicyDigest(longer), DEFAULT_RETENTION_POLICY_DIGEST);

    // And the shape the council refused cannot tell them apart at all.
    const identityOnly = (p: RetentionPolicy) =>
      crypto.createHash('sha256').update(p.policy_id).digest('hex');
    assert.equal(identityOnly(longer), identityOnly(DEFAULT_RETENTION_POLICY));
  });

  test('the settlement window moves it too — both durations are inside', () => {
    const shorter = { ...DEFAULT_RETENTION_POLICY, settlement_window_s: 3600 };
    assert.notEqual(retentionPolicyDigest(shorter), DEFAULT_RETENTION_POLICY_DIGEST);
  });

  test("migration 055's SQL literal is the digest this code computes", () => {
    // A seeded row whose digest came from a different version of the function
    // would resolve for nobody, and would look exactly like a policy somebody
    // forgot to enrol. Two independent expressions of one value, and this
    // between them.
    const seeded = M.resolveRetentionPolicy(DEFAULT_RETENTION_POLICY_DIGEST);
    assert.ok(seeded, 'the default policy must be seeded by the migration');
    assert.equal(seeded!.retention_duration_s, DEFAULT_RETENTION_POLICY.retention_duration_s);
    assert.equal(seeded!.settlement_window_s, DEFAULT_RETENTION_POLICY.settlement_window_s);
    assert.equal(seeded!.clock, SCRUPLE_CLOCK);
  });

  test('a digest nobody enrolled resolves to nothing — which is the forged answer', () => {
    const invented =
      'sha256:' + crypto.createHash('sha256').update('scruple-default-v1').digest('hex');
    assert.equal(M.resolveRetentionPolicy(invented), null);
  });

  test('a settlement window longer than the retention duration is refused', () => {
    const r = validateRetentionPolicy({ ...DEFAULT_RETENTION_POLICY, settlement_window_s: 60 * 24 * 3600 });
    assert.equal(r.ok, false);
  });

  test('a policy may not count its durations on the emitter\'s own clock', () => {
    for (const clock of ['local', 'system', 'component', 'host', 'none', '']) {
      assert.equal(validateRetentionPolicy({ ...DEFAULT_RETENTION_POLICY, clock }).ok, false, clock);
    }
  });

  test('a row edited after enrolment stops resolving — the digest is re-taken', () => {
    // The substitution the digest exists to prevent, performed on our own side
    // of it. Without the re-digest in resolveRetentionPolicy() a writer with
    // table access could grant every leaf naming this policy a longer window.
    const p: RetentionPolicy = { ...FAST, policy_id: 'wo-c3-edited-under-us' };
    const { digest } = M.enrollRetentionPolicy(p);
    assert.ok(M.resolveRetentionPolicy(digest));
    M.conn()
      .prepare(`UPDATE retention_policies SET retention_duration_s = ? WHERE digest = ?`)
      .run(999, digest);
    assert.equal(M.resolveRetentionPolicy(digest), null);
  });
});

// ---------------------------------------------------------------------------
// THE GATE, part one — the two new handles are inside the MAC.
// ---------------------------------------------------------------------------

describe('WO-C3 — a byte moved in either new handle invalidates the signature', () => {
  test('settlement_deadline rewritten in flight is refused', async () => {
    const r = await fire({
      tamper: (b) => {
        const h = b.resolution as Record<string, string>;
        h.settlement_deadline = deadlineIn(
          DEFAULT_RETENTION_POLICY.settlement_window_s + 60,
        );
      },
    });
    assert.equal(r.status, 422);
    assert.equal(r.code, 'component_unverified');
  });

  test('retention_policy_digest swapped for ANOTHER ENROLLED POLICY is caught by the MAC alone', async () => {
    // The swap has to be to a policy that RESOLVES, or the refusal comes from
    // `bindSettlement()` and this case would prove the digest is checked
    // rather than that it is signed. `ALT_30D` has the same two durations as
    // the default and a different `policy_id`, so every rule below the MAC
    // passes and only the signature fails.
    const r = await fire({
      tamper: (b) => {
        (b.resolution as Record<string, string>).retention_policy_digest =
          retentionPolicyDigest(ALT_30D);
      },
    });
    assert.equal(r.status, 422);
    assert.equal(r.code, 'component_unverified');
  });

  test('and a swap to a policy nobody enrolled is refused BEFORE the MAC — stated, not hidden', async () => {
    // ⚑ THE ORDER IS DELIBERATE AND IT IS REPORTED RATHER THAN PRESENTED AS A
    // SIGNATURE FAILURE. `bindSettlement()` runs before `verifySubmission()`,
    // for the reason the handle validator does: it refuses CONTENT, and
    // nothing above it has ratcheted or written a row. The consequence is that
    // an unresolvable digest answers `retention_policy_unresolvable` even
    // though the MAC also covers the field — and the case above is where the
    // MAC coverage is actually demonstrated.
    const r = await fire({
      tamper: (b) => {
        (b.resolution as Record<string, string>).retention_policy_digest =
          retentionPolicyDigest({ ...DEFAULT_RETENTION_POLICY, retention_duration_s: 365 * 24 * 3600 });
      },
    });
    assert.equal(r.status, 422);
    assert.equal(r.code, 'retention_policy_unresolvable');
  });

  test('ADDING a deadline to a leaf that carried none is refused — the absence is signed', async () => {
    const r = await fire({
      capture: null,
      omitResolution: true,
      tamper: (b) => {
        b.resolution = handles();
      },
    });
    assert.equal(r.status, 422);
    assert.equal(r.code, 'component_unverified');
  });
});

// ---------------------------------------------------------------------------
// The controls at ingest. Each one was ACCEPTED, or refused for the WRONG
// REASON, before this WO — see 01-controls-RED.txt.
// ---------------------------------------------------------------------------

describe('WO-C3 — what a leaf is entitled to say about its own expiry', () => {
  test('a capture-bearing leaf with the five WO-C2 handles and no deadline is REFUSED', async () => {
    const five = handles();
    delete five.settlement_deadline;
    delete five.retention_policy_digest;
    const r = await fire({ resolution: five });
    assert.equal(r.status, 422);
    assert.equal(r.code, 'resolution_handles_required');
  });

  test('a deadline with no retention policy is refused — a deadline against nothing', async () => {
    const r = await fire({ resolution: handles({ retention_policy_digest: null }) });
    assert.equal(r.status, 422);
    assert.equal(r.code, 'resolution_handles_refused');
  });

  test('a retention policy with no deadline is refused — a window with no moment in it', async () => {
    const r = await fire({ resolution: handles({ settlement_deadline: null }) });
    assert.equal(r.status, 422);
    assert.equal(r.code, 'resolution_handles_refused');
  });

  test('AN IDENTITY-ONLY DIGEST IS REFUSED — the shape Architect named', async () => {
    const identityOnly =
      'sha256:' + crypto.createHash('sha256').update('scruple-default-v1').digest('hex');
    const r = await fire({ resolution: handles({ retention_policy_digest: identityOnly }) });
    assert.equal(r.status, 422);
    assert.equal(r.code, 'retention_policy_unresolvable');
  });

  test('A DEADLINE FROM A CLOCK TWO HOURS FAST IS REFUSED, not believed', async () => {
    // The config-inherited field class, applied to a deadline. The component
    // is honest; its clock is wrong; the named clock says so.
    const r = await fire({
      resolution: handles({
        settlement_deadline: deadlineIn(
          DEFAULT_RETENTION_POLICY.settlement_window_s,
          Date.now() + 2 * 3600_000,
        ),
      }),
    });
    assert.equal(r.status, 422);
    assert.equal(r.code, 'settlement_deadline_unbound');
    const detail = (r.body.error as { detail: Record<string, unknown> }).detail;
    assert.equal(detail.named_clock, SCRUPLE_CLOCK);
    assert.ok(Math.abs(Number(detail.skew_s)) > MAX_CLOCK_SKEW_S);
  });

  test('a clock a few seconds out is NOT refused — the band is real, not a coincidence', async () => {
    // ANTI-VACUITY for the case above. If any deviation were refused, the
    // two-hour test would prove only that the check exists, not that it
    // measures skew.
    const r = await fire({
      resolution: handles({
        settlement_deadline: deadlineIn(
          DEFAULT_RETENTION_POLICY.settlement_window_s,
          Date.now() + 5_000,
        ),
      }),
    });
    assert.equal(r.status, 201, JSON.stringify(r.body).slice(0, 300));
  });

  test('a deadline BEYOND the evidence retention window is refused', async () => {
    // Unsettleable by construction: the gap becomes terminal at a moment when
    // the evidence needed to settle it is legitimately gone.
    const r = await fire({
      resolution: handles({
        retention_policy_digest: retentionPolicyDigest(FAST),
        settlement_deadline: deadlineIn(FAST.settlement_window_s + 3600),
      }),
    });
    assert.equal(r.status, 422);
    assert.equal(r.code, 'settlement_deadline_unbound');
  });

  test('a policy counted on a clock this server cannot read is refused', async () => {
    // A partner timestamp authority is a legitimate future entry in
    // NAMED_CLOCKS. Until it is one, a leaf counted on it is refused rather
    // than half-checked: an expiry we could not measure would have to be
    // measured against a clock we invented.
    const r = await fire({
      resolution: handles({
        retention_policy_digest: retentionPolicyDigest(FOREIGN_CLOCK),
        settlement_deadline: deadlineIn(FOREIGN_CLOCK.settlement_window_s),
      }),
    });
    assert.equal(r.status, 422);
    assert.equal(r.code, 'settlement_deadline_unbound');
  });

  test('a local-offset deadline is refused before any clock is consulted', async () => {
    const r = await fire({ resolution: handles({ settlement_deadline: '2026-09-10T00:00:00+01:00' }) });
    assert.equal(r.status, 422);
    assert.equal(r.code, 'resolution_handles_refused');
  });

  test('a policy NAME in the digest field is refused', async () => {
    const r = await fire({ resolution: handles({ retention_policy_digest: 'scruple-default-v1' }) });
    assert.equal(r.status, 422);
    assert.equal(r.code, 'resolution_handles_refused');
  });

  test('THE HONEST LEAF is accepted, and carries both classes of fact', async () => {
    const r = await fire({});
    assert.equal(r.status, 201, JSON.stringify(r.body).slice(0, 300));
    const s = r.body.settlement as Record<string, unknown>;
    assert.equal(s.retention_policy_digest, DEFAULT_RETENTION_POLICY_DIGEST);
    assert.equal(s.retention_duration_s, DEFAULT_RETENTION_POLICY.retention_duration_s);
    assert.equal(s.state, 'pending');
    assert.equal(s.source, 'measured');
    assert.equal((s.clock as Record<string, unknown>).name, SCRUPLE_CLOCK);
    assert.ok((s.clock as Record<string, unknown>).authority, 'the reading has an authority');
    assert.ok(String(s.evidence_retained_until) > String(s.deadline),
      'the evidence outlives the deadline, or the deadline could never be checked');
  });

  test('a leaf with NO capture block and no handles is still accepted — legacy is untouched', async () => {
    const r = await fire({ capture: null, omitResolution: true });
    assert.equal(r.status, 201, JSON.stringify(r.body).slice(0, 300));
    assert.equal(r.body.settlement, null);
  });
});

// ---------------------------------------------------------------------------
// THE GATE — three distinguishable states from ONE query path.
// ---------------------------------------------------------------------------

describe('WO-C3 GATE — resolvable, evidence_expired, and forged are three answers', () => {
  test('and they do not collapse into one another', async () => {
    // 1. RESOLVABLE — thirty days of retention, one second old.
    const live = await fire({});
    assert.equal(live.status, 201, JSON.stringify(live.body).slice(0, 200));

    // 2. EVIDENCE_EXPIRED — one second of retention, and we wait for it.
    const fast = await fire({
      resolution: handles({
        retention_policy_digest: retentionPolicyDigest(FAST),
        settlement_deadline: deadlineIn(FAST.settlement_window_s),
      }),
    });
    assert.equal(fast.status, 201, JSON.stringify(fast.body).slice(0, 200));

    // 3. FORGED — a leaf id nobody ever issued.
    const maxId = (M.conn().prepare(`SELECT MAX(id) m FROM iterations`).get() as { m: number }).m;
    const forgedId = String(maxId + 9999);

    await new Promise((r) => setTimeout(r, 1400));

    const a = await resolveLeaf(String(live.body.leaf_id));
    const b = await resolveLeaf(String(fast.body.leaf_id));
    const c = await resolveLeaf(forgedId);
    // 3b. A FORGED HANDLE on a real leaf: the verifier is holding a leaf this
    // server did not issue, even though the id exists.
    const d = await resolveLeaf(String(live.body.leaf_id), {
      retention_policy_digest: 'sha256:' + 'f'.repeat(64),
    });

    assert.equal(a.resolution, 'resolvable');
    assert.equal(b.resolution, 'evidence_expired');
    assert.equal(c.resolution, 'unresolvable');
    assert.equal(d.resolution, 'unresolvable');

    // THE CONTROL. Three states, and the pairs that must never be equal.
    assert.notEqual(a.resolution, b.resolution, 'live evidence must not read as expired');
    assert.notEqual(b.resolution, c.resolution, 'a legitimate expiry must not read as a forgery');
    assert.notEqual(b.resolution, d.resolution, 'a legitimate expiry must not read as a forged handle');
    assert.notEqual(a.resolution, c.resolution);

    // And the reasons under `unresolvable` are not flattened either.
    assert.equal(c.reason, 'unknown_leaf');
    assert.equal(d.reason, 'handle_mismatch');

    // `evidence_expired` IS MEASURED, against the named clock. That is
    // Architect's condition, and it is the difference between this answer and
    // a 404.
    const be = b.evidence as Record<string, unknown>;
    assert.equal(be.source, 'measured');
    assert.equal((be.clock as Record<string, unknown>).name, SCRUPLE_CLOCK);
    assert.ok(be.retained_until);

    // ⚑ THE LEAF ROW SURVIVES ITS EVIDENCE. The claim is what answers
    // `evidence_expired`; a deployment that reaped the row too would be back
    // to a 404 meaning either "gone on schedule" or "you made that up".
    assert.ok(b.leaf_hash, 'the expired leaf still has a leaf hash to show');

    // A forged query discloses NOTHING to walk the id space with.
    assert.equal(c.leaf_hash, null);
    assert.equal(d.leaf_hash, null);

    // ANTI-VACUITY: supplying the CORRECT handle still resolves. Without this,
    // "handle_mismatch" could be the answer to every query that carries one.
    const e = await resolveLeaf(String(live.body.leaf_id), {
      retention_policy_digest: DEFAULT_RETENTION_POLICY_DIGEST,
    });
    assert.equal(e.resolution, 'resolvable');
  });

  test('a legacy leaf is `unresolvable` for a NAMED reason, not as a forgery', async () => {
    const legacy = await fire({ capture: null, omitResolution: true });
    const r = await resolveLeaf(String(legacy.body.leaf_id));
    assert.equal(r.resolution, 'unresolvable');
    assert.equal(r.reason, 'no_retention_binding');
    assert.equal((r.evidence as Record<string, unknown>).source, 'unknown');
  });
});

// ---------------------------------------------------------------------------
// The gap flips to TERMINAL at the deadline, measured against a named clock.
// ---------------------------------------------------------------------------

describe('WO-C3 — the unresolved gap becomes a finding at the deadline', () => {
  test('pending before, terminal `expired` after, and the clock is named both times', async () => {
    const fast = await fire({
      resolution: handles({
        retention_policy_digest: retentionPolicyDigest(FAST),
        settlement_deadline: deadlineIn(FAST.settlement_window_s),
      }),
    });
    assert.equal(fast.status, 201, JSON.stringify(fast.body).slice(0, 200));
    const before = (await resolveLeaf(String(fast.body.leaf_id))).settlement as Record<string, unknown>;
    assert.equal(before.state, 'pending');
    assert.equal(before.terminal, false);
    assert.equal(before.source, 'measured');

    await new Promise((r) => setTimeout(r, 1400));

    const after = (await resolveLeaf(String(fast.body.leaf_id))).settlement as Record<string, unknown>;
    assert.equal(after.state, 'expired');
    assert.equal(after.terminal, true);
    // ARCHITECT'S CONDITION, in one assertion.
    assert.equal(after.source, 'measured');
    assert.equal((after.clock as Record<string, unknown>).name, SCRUPLE_CLOCK);
  });

  test('a leaf that declared no deadline reads `unknown` and can never read `expired`', async () => {
    const legacy = await fire({ capture: null, omitResolution: true });
    const s = (await resolveLeaf(String(legacy.body.leaf_id))).settlement as Record<string, unknown>;
    assert.equal(s.state, 'unknown');
    assert.equal(s.source, 'unknown');
    assert.equal(s.terminal, false);
  });

  test('`expired` is never asserted without a reading — the unit case, at a fixed instant', () => {
    const row = {
      resolution_settlement_deadline: '2026-01-01T00:00:00.000Z',
      resolution_retention_policy_digest: DEFAULT_RETENTION_POLICY_DIGEST,
      settlement_clock: SCRUPLE_CLOCK,
      settlement_clock_authority: 'scruple-web:v2-ingest',
      settlement_observed_at: '2025-12-31T00:00:00.000Z',
      evidence_retained_until: '2026-01-30T00:00:00.000Z',
      resolution_checkpoint_id: null,
    };
    const at = (iso: string) => Date.parse(iso);
    assert.equal(M.evaluateSettlement(row, at('2025-12-31T12:00:00Z')).state, 'pending');
    assert.equal(M.evaluateSettlement(row, at('2026-01-02T00:00:00Z')).state, 'expired');
    assert.equal(M.evaluateSettlement(row, at('2026-01-02T00:00:00Z')).source, 'measured');

    // A row whose clock this server is not an authority for CANNOT be expired,
    // however far past its deadline it is. `unknown` is the honest answer and
    // it is not terminal.
    const foreign = { ...row, settlement_clock: 'partner-tsa-v1' };
    const v = M.evaluateSettlement(foreign, at('2030-01-01T00:00:00Z'));
    assert.equal(v.state, 'unknown');
    assert.equal(v.source, 'unknown');
    assert.equal(v.terminal, false);

    // And the evidence half, at the same fixed instants.
    assert.equal(M.evaluateEvidence(row, {}, at('2026-01-02T00:00:00Z')).state, 'resolvable');
    assert.equal(M.evaluateEvidence(row, {}, at('2026-02-02T00:00:00Z')).state, 'evidence_expired');
    assert.equal(M.evaluateEvidence(row, {}, at('2026-02-02T00:00:00Z')).source, 'measured');
  });

  test('a leaf that named a checkpoint reads `settled` — the branch WO-C6 unlocks', () => {
    // Unreachable through the route today: no leaf may name a checkpoint while
    // the Merkle blocker stands. It is a real read of a real column rather than
    // a placeholder, and it is exercised here so it is not first exercised on
    // the day the blocker lifts.
    const v = M.evaluateSettlement({
      resolution_settlement_deadline: '2026-01-01T00:00:00.000Z',
      resolution_retention_policy_digest: DEFAULT_RETENTION_POLICY_DIGEST,
      settlement_clock: SCRUPLE_CLOCK,
      settlement_clock_authority: 'scruple-web:v2-ingest',
      settlement_observed_at: '2025-12-31T00:00:00.000Z',
      evidence_retained_until: '2026-01-30T00:00:00.000Z',
      resolution_checkpoint_id: 'ckpt-someday',
    }, Date.parse('2030-01-01T00:00:00Z'));
    assert.equal(v.state, 'settled');
    assert.equal(v.terminal, true);
  });
});

// ---------------------------------------------------------------------------
// Stored, disclosed, and guarded below the validator.
// ---------------------------------------------------------------------------

describe('WO-C3 — the row, the receipt, and the database guard', () => {
  test('the row records both classes of fact, and the receipt discloses both', async () => {
    const r = await fire({});
    assert.equal(r.status, 201, JSON.stringify(r.body).slice(0, 200));
    const row = M.conn()
      .prepare(
        `SELECT resolution_settlement_deadline, resolution_retention_policy_digest,
                settlement_clock, settlement_clock_authority, settlement_observed_at,
                evidence_retained_until
           FROM iterations WHERE id = ?`,
      )
      .get(Number(r.body.leaf_id)) as Record<string, string | null>;
    assert.equal(row.resolution_retention_policy_digest, DEFAULT_RETENTION_POLICY_DIGEST);
    assert.equal(row.settlement_clock, SCRUPLE_CLOCK);
    assert.ok(row.settlement_observed_at);
    assert.ok(row.evidence_retained_until);
    // The SIGNED value is what the component sent, not what the server would
    // have preferred: the deadline in the row is the one in the response.
    assert.equal(
      row.resolution_settlement_deadline,
      (r.body.resolution as Record<string, unknown>).settlement_deadline,
    );

    const res = await M.RECEIPT(new Request('https://scruple.ai/'), {
      params: Promise.resolve({ leaf_id: String(r.body.leaf_id) }),
    });
    const receipt = (await res.json()) as Record<string, Record<string, unknown>>;
    assert.equal(receipt.resolution.retention_policy_digest, DEFAULT_RETENTION_POLICY_DIGEST);
    assert.equal(receipt.settlement.state, 'pending');
    assert.equal(receipt.evidence.state, 'resolvable');
    // ONE PAIR OF FUNCTIONS, TWO SURFACES. The receipt and the resolve path
    // must not be able to disagree about the same leaf.
    const viaResolve = await resolveLeaf(String(r.body.leaf_id));
    assert.equal(receipt.evidence.state, viaResolve.resolution);
    assert.equal(
      receipt.settlement.state,
      (viaResolve.settlement as Record<string, unknown>).state,
    );
  });

  test('the database refuses a deadline with no named clock, even if nothing else does', () => {
    // Migration 055's cross-column CHECK. WO-C1's three-guard pattern: the
    // type stops the code, the validator stops the JSON, and this stops every
    // other writer that reaches the table. A row with a deadline and no clock
    // would read `unknown` forever — a deadline that can never become a
    // finding, which is the state the whole mechanism exists to remove.
    const id = (M.conn().prepare(`SELECT MIN(id) m FROM iterations`).get() as { m: number }).m;
    assert.throws(
      () =>
        M.conn()
          .prepare(
            `UPDATE iterations
                SET resolution_settlement_deadline = ?,
                    resolution_retention_policy_digest = ?,
                    settlement_clock = NULL
              WHERE id = ?`,
          )
          .run('2026-09-10T00:00:00.000Z', DEFAULT_RETENTION_POLICY_DIGEST, id),
      /CHECK constraint failed/,
    );
  });

  test('the database refuses a deadline with no retention policy beside it', () => {
    const id = (M.conn().prepare(`SELECT MIN(id) m FROM iterations`).get() as { m: number }).m;
    assert.throws(
      () =>
        M.conn()
          .prepare(
            `UPDATE iterations
                SET resolution_settlement_deadline = ?,
                    resolution_retention_policy_digest = NULL,
                    settlement_clock = ?
              WHERE id = ?`,
          )
          .run('2026-09-10T00:00:00.000Z', SCRUPLE_CLOCK, id),
      /CHECK constraint failed/,
    );
  });

  test('bindSettlement returns no binding for a leaf that carries neither', () => {
    const r = M.bindSettlement({ settlement_deadline: null, retention_policy_digest: null });
    assert.equal(r.ok, true);
    assert.equal((r as { binding: unknown }).binding, null);
  });
});
