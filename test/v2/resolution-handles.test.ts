// WO-C2 — the resolution handles are inside the signed preimage, and a handle
// outside it is refused.
//
// The council split what a leaf CLAIMS from what it CARRIES AS EVIDENCE: the
// Merkle inclusion path and the raw TPM quote stay in the checkpoint store,
// and the leaf carries compact handles saying where to fetch them. Architect
// settled that split on one condition, and this file is that condition:
//
//   "the handles (`witness endpoint`, authority identity, `checkpoint_id`,
//    preceding checkpoint id and quote time) must sit inside the signed
//    preimage, or an attacker who can rewrite an unsigned endpoint redirects
//    resolution to a service that will happily confirm anything — the handle
//    becomes the attack surface the proof used to close."
//
// THE GATE IS "ONE BYTE INVALIDATES THE SIGNATURE" AND THE CONTROL IS "A
// HANDLE OUTSIDE THE PREIMAGE MUST FAIL". Both were fired at the pre-WO code
// first, and the route answered 201 to every one of the fourteen shapes below;
// the run is recorded at /mnt/corpus/scruple-council-impl/wo-c2/01-controls-RED.txt
// and reproduced in docs/canon/council-impl/WO-C2.md. A green test with no
// control proves only that it cannot fail.
//
// AND THERE IS AN ANTI-VACUITY CASE, because "the MAC rejects everything"
// would satisfy every gate here: `capture.header_hash` is deliberately NOT in
// the preimage (leaf.ts says so and explains why), so rewriting it in flight
// must still be ACCEPTED. If that test ever fails, the gate tests below have
// stopped measuring the preimage and started measuring an unrelated refusal.
//
// TEST ISOLATION follows test/v2/attestation-basis.test.ts: `npm run test:v2`
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
const OWN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'scruple-resolution-handles-'));
process.env.SCRUPLE_DB_PATH = path.join(OWN_DIR, 'resolution-handles.db');
process.env.SCRUPLE_BDK_HEX = 'd9'.repeat(32);
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
  preimageOf: typeof import('../../services/scruple-capture/src/leaf').preimageOf;
  resolutionPreimageFields: typeof import('../../lib/leaf/resolutionHandles').resolutionPreimageFields;
  validateResolutionHandles: typeof import('../../lib/leaf/resolutionHandles').validateResolutionHandles;
  RESOLUTION_HANDLE_KEYS: typeof import('../../lib/leaf/resolutionHandles').RESOLUTION_HANDLE_KEYS;
  POST: (req: Request) => Promise<Response>;
  RECEIPT: (req: Request, ctx: { params: Promise<{ leaf_id: string }> }) => Promise<Response>;
};

let M: Mod;
const TENANT = 'vendor-c2a';
const BUILD = 'sha256:' + '4d'.repeat(32);
const BASELINE = '3'.repeat(64);
let API_KEY: string;

const ENDPOINT = 'https://witness.example.vendor/api';
/** WO-C3. Where the named clock puts the end of the default policy's window. */
const DEADLINE = () =>
  new Date(Date.now() + DEFAULT_RETENTION_POLICY.settlement_window_s * 1000).toISOString();
const AUTHORITY = 'sha256:' + 'cd'.repeat(32);
const QUOTE_TIME = '2026-09-08T23:00:00.000Z';

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
    ...over,
  };
}

function handles(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    witness_endpoint: ENDPOINT,
    witness_authority: AUTHORITY,
    // null on every leaf while the Merkle blocker stands. Rule 7 of
    // lib/leaf/resolutionHandles.ts refuses a leaf that names one.
    checkpoint_id: null,
    prev_checkpoint_id: 'ckpt-2026-09-08-0417',
    prev_checkpoint_quote_time: QUOTE_TIME,
    // WO-C3 landed handles six and seven, and a capture-bearing leaf must
    // carry both. Computed per call rather than fixed, because the route
    // checks the deadline against a NAMED CLOCK — a literal here would drift
    // out of the band and fail these WO-C2 cases with a message about clock
    // skew, which is precisely the "green for the wrong reason" this file
    // exists to prevent, inverted.
    settlement_deadline: DEADLINE(),
    retention_policy_digest: DEFAULT_RETENTION_POLICY_DIGEST,
    ...over,
  };
}

/**
 * Build an HONEST submission and MAC it, then hand it to `tamper` — which
 * stands for a party sitting between the component and the route that holds
 * no key. Everything it does happens AFTER the MAC, which is the only way a
 * test of this gate means anything.
 */
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

let nextCounter = 0;
function provision(): string {
  const { componentId, token } = M.issueProvisioningToken({ tenantId: TENANT, label: 'sidecar' });
  assert.ok(M.redeemProvisioningToken({ token, tenantId: TENANT, buildMeasurement: BUILD }).ok);
  nextCounter = 0;
  return componentId;
}

/** Fire one shape and report (status, code). */
async function fire(opts: Parameters<typeof submission>[2]): Promise<{ status: number; code?: string; body: Record<string, unknown> }> {
  const id = provision();
  const res = await M.POST(witnessReq(submission(id, nextCounter++, opts)));
  const json = (await res.json()) as Record<string, unknown>;
  const err = json.error as { code?: string } | undefined;
  return { status: res.status, code: err?.code, body: json };
}

before(async () => {
  const [sqlite, migrate, prov, ratchet, bdkMod, preimage, leaf, rh, route, receipt] =
    await Promise.all([
      import('../../lib/db/sqlite'),
      import('../../lib/db/migrate'),
      import('../../lib/ratchet/provisioning'),
      import('../../lib/ratchet/ratchet'),
      import('../../lib/ratchet/bdk'),
      import('../../lib/leaf/componentPreimage'),
      import('../../services/scruple-capture/src/leaf'),
      import('../../lib/leaf/resolutionHandles'),
      import('../../app/api/v2/witness/route'),
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
    preimageOf: leaf.preimageOf,
    resolutionPreimageFields: rh.resolutionPreimageFields,
    validateResolutionHandles: rh.validateResolutionHandles,
    RESOLUTION_HANDLE_KEYS: rh.RESOLUTION_HANDLE_KEYS,
    POST: route.POST as unknown as (req: Request) => Promise<Response>,
    RECEIPT: receipt.GET as unknown as Mod['RECEIPT'],
  };
  M.runMigrations(false);
  M.conn().prepare(`INSERT INTO users (id, email) VALUES (?, ?)`).run(TENANT, 'c2a@example.com');
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
// THE GATE — one byte, and the signature is gone.
// ---------------------------------------------------------------------------

describe('WO-C2 gate — altering any handle by one byte invalidates the signature', () => {
  const oneByte: Array<[string, (b: Record<string, unknown>) => void]> = [
    [
      'witness_endpoint (…vendor/api → …vendor/apj)',
      (b) => {
        (b.resolution as Record<string, unknown>).witness_endpoint = ENDPOINT.slice(0, -1) + 'j';
      },
    ],
    [
      'witness_authority (…cdcd → …cdce)',
      (b) => {
        (b.resolution as Record<string, unknown>).witness_authority = AUTHORITY.slice(0, -1) + 'e';
      },
    ],
    [
      'prev_checkpoint_id (…0417 → …0418)',
      (b) => {
        (b.resolution as Record<string, unknown>).prev_checkpoint_id = 'ckpt-2026-09-08-0418';
      },
    ],
    [
      'prev_checkpoint_quote_time (23:00 → 22:00)',
      (b) => {
        (b.resolution as Record<string, unknown>).prev_checkpoint_quote_time =
          '2026-09-08T22:00:00.000Z';
      },
    ],
  ];

  for (const [what, tamper] of oneByte) {
    test(`rewriting ${what} in flight is refused`, async () => {
      const r = await fire({ tamper });
      assert.equal(r.status, 422);
      assert.equal(r.code, 'component_unverified');
    });
  }

  test('ADDING a handle block a component never sent is refused too — the ABSENCE is signed', async () => {
    // Not a variation on the above. The seven keys are always in the preimage,
    // so a leaf whose component named no witness MACs seven nulls; a party in
    // the middle that supplies them changes the canonical JSON exactly as much
    // as one that rewrites them. Stripping and adding are the same failure.
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

  test('STRIPPING the handle block in flight is refused BY THE MAC', async () => {
    // Deliberately on a leaf with NO capture block, so that
    // `resolution_handles_required` cannot answer first. What is being
    // measured here is the preimage, not the requirement: seven keys became
    // seven nulls, the canonical JSON changed, and the signature is gone.
    const r = await fire({
      capture: null,
      tamper: (b) => {
        delete b.resolution;
      },
    });
    assert.equal(r.status, 422);
    assert.equal(r.code, 'component_unverified');
  });

  test('the same leaf, untampered, is ACCEPTED — so the four above are not vacuous', async () => {
    const r = await fire({});
    assert.equal(r.status, 201, JSON.stringify(r.body).slice(0, 300));
    assert.deepEqual(r.body.resolution, {
      witness_endpoint: ENDPOINT,
      witness_authority: AUTHORITY,
      checkpoint_id: null,
      prev_checkpoint_id: 'ckpt-2026-09-08-0417',
      prev_checkpoint_quote_time: QUOTE_TIME,
      // The deadline is generated per call, so it is read back off the
      // response rather than pinned: what this case measures is that the
      // SEVEN keys survived the round trip, not what o'clock it is.
      settlement_deadline: (r.body.resolution as Record<string, unknown>).settlement_deadline,
      retention_policy_digest: DEFAULT_RETENTION_POLICY_DIGEST,
      signed: true,
    });
  });

  test('ANTI-VACUITY: rewriting a field that is deliberately NOT in the preimage still passes', async () => {
    // `capture.header_hash` is uncovered by the MAC on purpose — leaf.ts says
    // so and gives the reason. If this ever starts failing, the four gate
    // tests above have stopped measuring the preimage and started measuring
    // some blanket refusal.
    const r = await fire({
      capture: captureBlock({ header_hash: 'a'.repeat(64) }),
      tamper: (b) => {
        (b.capture as Record<string, unknown>).header_hash = 'b'.repeat(64);
      },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body).slice(0, 300));
  });
});

// ---------------------------------------------------------------------------
// THE CONTROL — handles present, but outside the preimage.
// ---------------------------------------------------------------------------

describe('WO-C2 control — a handle outside the signed preimage must FAIL', () => {
  test('bare handle keys at the top level are refused', async () => {
    const r = await fire({
      capture: null,
      omitResolution: true,
      tamper: (b) => {
        b.witness_endpoint = ENDPOINT;
        b.witness_authority = AUTHORITY;
        b.checkpoint_id = 'ckpt-unsigned-0001';
      },
    });
    assert.equal(r.status, 422);
    assert.equal(r.code, 'resolution_handles_unsigned');
  });

  test('handles inside `capture` are refused — the preimage reads that block BY KEY', async () => {
    // The sharp one. `componentPreimage()` pulls named fields out of
    // `capture`, so an unrecognised key there is silently skipped: it looks
    // signed, sits beside fields that are, and is not.
    const r = await fire({
      omitResolution: true,
      capture: captureBlock({ witness_endpoint: ENDPOINT, checkpoint_id: 'ckpt-unsigned-0002' }),
    });
    assert.equal(r.status, 422);
    assert.equal(r.code, 'resolution_handles_unsigned');
  });

  test('a whole `resolution` block nested inside `capture` is refused', async () => {
    const r = await fire({
      omitResolution: true,
      capture: captureBlock({ resolution: handles() }),
    });
    assert.equal(r.status, 422);
    assert.equal(r.code, 'resolution_handles_unsigned');
  });

  test('handles parked inside the component envelope are refused', async () => {
    const r = await fire({
      omitResolution: true,
      tamper: (b) => {
        (b.component as Record<string, unknown>).witness_endpoint = ENDPOINT;
      },
    });
    assert.equal(r.status, 422);
    assert.equal(r.code, 'resolution_handles_unsigned');
  });

  test('an unknown key INSIDE the resolution block is refused', async () => {
    // A sixth handle introduced on the wire ahead of being introduced into the
    // preimage: inside the block a reader trusts, covered by nothing.
    const r = await fire({ resolution: handles({ witness_endpoint_v2: ENDPOINT }) });
    assert.equal(r.status, 422);
    assert.equal(r.code, 'resolution_handles_unsigned');
  });

  test('a resolution block on a submission with no component and no MAC is refused', async () => {
    const r = await fire({ capture: null, omitComponent: true });
    assert.equal(r.status, 422);
    assert.equal(r.code, 'resolution_handles_unsigned');
  });

  test('and a component-less submission with NO handles is still accepted — legacy is untouched', async () => {
    // The boundary. Canvas and the desktop plugins predate this design, send
    // no capture block and no component, and must keep working. Without this
    // the six refusals above would also be satisfied by a route that had
    // simply stopped accepting anything.
    const r = await fire({ capture: null, omitComponent: true, omitResolution: true });
    assert.equal(r.status, 201, JSON.stringify(r.body).slice(0, 300));
    assert.equal(r.body.resolution, null);
  });
});

// ---------------------------------------------------------------------------
// The rules the handles have to satisfy to be worth following.
// ---------------------------------------------------------------------------

describe('WO-C2 — what a handle is entitled to say', () => {
  test('a capture-bearing leaf that names no witness is refused', async () => {
    const r = await fire({ omitResolution: true });
    assert.equal(r.status, 422);
    assert.equal(r.code, 'resolution_handles_required');
  });

  test('a null endpoint is refused', async () => {
    const r = await fire({ resolution: handles({ witness_endpoint: null }) });
    assert.equal(r.status, 422);
    assert.equal(r.code, 'resolution_handles_required');
  });

  for (const [what, url] of [
    ['embedded credentials', 'https://attacker:pw@witness.example.vendor/api'],
    ['a query string on a base URL', 'https://witness.example.vendor/api?to=elsewhere'],
    ['a fragment', 'https://witness.example.vendor/api#x'],
    ['a non-http scheme', 'file:///etc/passwd'],
    ['a relative path', '/api/v2'],
  ] as const) {
    test(`an endpoint with ${what} is refused`, async () => {
      const r = await fire({ resolution: handles({ witness_endpoint: url }) });
      assert.equal(r.status, 422, `${url} was accepted`);
      assert.equal(r.code, 'resolution_handles_refused');
    });
  }

  test('half an interval — a prev id with no quote time — is refused', async () => {
    const r = await fire({ resolution: handles({ prev_checkpoint_quote_time: null }) });
    assert.equal(r.status, 422);
    assert.equal(r.code, 'resolution_handles_refused');
  });

  test('a quote time that is not a UTC instant is refused', async () => {
    const r = await fire({ resolution: handles({ prev_checkpoint_quote_time: '2026-09-08 23:00:00 +02:00' }) });
    assert.equal(r.status, 422);
    assert.equal(r.code, 'resolution_handles_refused');
  });

  test('a checkpoint_id with no authority is refused — an address with no whose-signature', async () => {
    const r = M.validateResolutionHandles(
      {
        component: { component_id: 'x', counter: 0 },
        mac: 'f'.repeat(64),
        resolution: handles({ checkpoint_id: 'ckpt-1', witness_authority: null }),
      },
      // Driven with the blocker LIFTED, or rule 7 would answer first and this
      // rule would never be reached. That is the whole reason the override
      // exists, and it changes nothing about what the estate emits.
      { vectorsSettled: true },
    );
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.code, 'resolution_handles_refused');
    assert.match(r.ok === false ? r.message : '', /cooperating liar/);
  });

  test('and a checkpoint_id may not be named at all while the Merkle blocker stands', async () => {
    const r = await fire({ resolution: handles({ checkpoint_id: 'ckpt-claimed-now' }) });
    assert.equal(r.status, 422);
    assert.equal(r.code, 'resolution_handles_refused');
    assert.match(String((r.body.error as { message: string }).message), /shared Merkle vectors/);
  });

  test('the same leaf IS accepted once the vectors settle — so rule 7 is a blocker, not a ban', async () => {
    // Anti-vacuity for the rule above: `checkpoint_id` is refused today
    // because of Appendix C item 0, not because the design has no place for
    // it. WO-C6 flips the constant; nothing else may.
    const r = M.validateResolutionHandles(
      {
        component: { component_id: 'x', counter: 0 },
        mac: 'f'.repeat(64),
        resolution: handles({ checkpoint_id: 'ckpt-1' }),
      },
      { vectorsSettled: true },
    );
    assert.equal(r.ok, true);
    assert.equal(r.ok === true && r.handles?.checkpoint_id, 'ckpt-1');
  });
});

// ---------------------------------------------------------------------------
// The preimage itself — three implementations, one field set.
// ---------------------------------------------------------------------------

describe('WO-C2 — the handles are in the preimage, in all of it', () => {
  test('the seven handles appear in the preimage under `resolution_` keys', () => {
    const fields = M.componentPreimage({
      content_hash: 'a'.repeat(64),
      component: { component_id: 'x', counter: 0 },
      resolution: {
        witness_endpoint: ENDPOINT,
        witness_authority: AUTHORITY,
        checkpoint_id: null,
        prev_checkpoint_id: 'ckpt-1',
        prev_checkpoint_quote_time: QUOTE_TIME,
        settlement_deadline: QUOTE_TIME,
        retention_policy_digest: DEFAULT_RETENTION_POLICY_DIGEST,
      },
    } as never);
    assert.equal(fields.resolution_witness_endpoint, ENDPOINT);
    assert.equal(fields.resolution_witness_authority, AUTHORITY);
    assert.equal(fields.resolution_checkpoint_id, null);
    assert.equal(fields.resolution_prev_checkpoint_id, 'ckpt-1');
    assert.equal(fields.resolution_prev_checkpoint_quote_time, QUOTE_TIME);
    assert.equal(fields.resolution_settlement_deadline, QUOTE_TIME);
    assert.equal(fields.resolution_retention_policy_digest, DEFAULT_RETENTION_POLICY_DIGEST);
  });

  test('a submission with NO resolution block produces the SAME key set, seven nulls', () => {
    const withBlock = M.componentPreimage({
      content_hash: 'a'.repeat(64),
      component: { component_id: 'x', counter: 0 },
      resolution: handles() as never,
    } as never);
    const without = M.componentPreimage({
      content_hash: 'a'.repeat(64),
      component: { component_id: 'x', counter: 0 },
    } as never);
    assert.deepEqual(Object.keys(withBlock).sort(), Object.keys(without).sort());
    for (const k of M.RESOLUTION_HANDLE_KEYS) {
      assert.equal(without[`resolution_${k}`], null);
    }
  });

  test('the server and the sidecar produce the identical preimage for the identical submission', () => {
    // The same assertion test/v2/component-auth.test.ts makes for the whole
    // field set, repeated here with the handles populated: the two are copies
    // of one field list and a copy is what drifts.
    const sample = {
      baseline_ref: 'b'.repeat(64),
      kind: 'artifact',
      content_hash: 'c'.repeat(64),
      mime: 'image/png',
      capture: captureBlock(),
      resolution: handles(),
      component: {
        component_id: 'x',
        build_measurement: BUILD,
        counter: 3,
        attestation: { provider: 'none', quote_ref: null },
      },
    };
    assert.deepEqual(M.componentPreimage(sample as never), M.preimageOf(sample as never));
  });

  test('checkpoint_id is COVERED BY THE MAC, even though no leaf may name one today', () => {
    // The one gate case the live run could not show as a MAC failure: rule 7
    // refuses a `checkpoint_id` outright while the Merkle blocker stands, so
    // the validator answers before the ratchet does. The coverage is real
    // regardless, and this is where it is demonstrated — two preimages
    // differing in nothing but the checkpoint id, and two different MACs.
    const base = {
      content_hash: 'a'.repeat(64),
      component: { component_id: 'x', counter: 0 },
      resolution: handles(),
    };
    const named = { ...base, resolution: handles({ checkpoint_id: 'ckpt-1' }) };
    const key = M.deriveIk(M.bdk(), 'x');
    const macOf = (b: unknown) => {
      const r = new M.Ratchet(key, 0);
      const { mac } = r.mac(M.componentPreimage(b as never));
      r.destroy();
      return mac;
    };
    assert.notEqual(macOf(base), macOf(named));
  });

  test('`resolutionPreimageFields` emits exactly seven keys whatever it is given', () => {
    for (const input of [null, undefined, {}, handles(), { witness_endpoint: ENDPOINT }]) {
      const f = M.resolutionPreimageFields(input as never);
      assert.deepEqual(
        Object.keys(f).sort(),
        M.RESOLUTION_HANDLE_KEYS.map((k) => `resolution_${k}`).sort(),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Stored, and disclosed — a handle nobody wrote down is a handle nobody can
// follow.
// ---------------------------------------------------------------------------

describe('WO-C2 — the handles reach the row and the receipt', () => {
  test('the row records what the component signed, and the receipt discloses it', async () => {
    const r = await fire({});
    assert.equal(r.status, 201, JSON.stringify(r.body).slice(0, 300));
    const row = M.conn()
      .prepare(
        `SELECT resolution_witness_endpoint AS ep, resolution_witness_authority AS auth,
                resolution_checkpoint_id AS cp, resolution_prev_checkpoint_id AS prev,
                resolution_prev_checkpoint_quote_time AS at
           FROM iterations WHERE id = ?`,
      )
      .get(Number(r.body.leaf_id)) as Record<string, unknown>;
    assert.deepEqual(row, {
      ep: ENDPOINT,
      auth: AUTHORITY,
      cp: null,
      prev: 'ckpt-2026-09-08-0417',
      at: QUOTE_TIME,
    });

    const res = await M.RECEIPT(new Request('https://scruple.ai/x'), {
      params: Promise.resolve({ leaf_id: String(r.body.leaf_id) }),
    });
    const receipt = (await res.json()) as { resolution: Record<string, unknown> | null };
    assert.deepEqual(receipt.resolution, {
      witness_endpoint: ENDPOINT,
      witness_authority: AUTHORITY,
      checkpoint_id: null,
      prev_checkpoint_id: 'ckpt-2026-09-08-0417',
      prev_checkpoint_quote_time: QUOTE_TIME,
      // WO-C3. Handles six and seven, disclosed by the same receipt and
      // covered by the same MAC.
      settlement_deadline: (receipt.resolution as Record<string, unknown>).settlement_deadline,
      retention_policy_digest: DEFAULT_RETENTION_POLICY_DIGEST,
      // The claim of the whole block, and it is computed from whether the
      // component envelope verified — not asserted because the fields exist.
      signed: true,
    });
  });

  test('the database refuses a checkpoint with no authority even if nothing else does', () => {
    // Migration 054's cross-column CHECK, and WO-C1's three-guard pattern one
    // WO on: the validator stops the JSON arriving, this stops every other
    // writer that reaches the table. A CHECK and not a partial index — an
    // index does not refuse an INSERT, it files it.
    const created = M.conn()
      .prepare(
        `INSERT INTO projects
           (user_id, name, type, status, created_at,
            iteration_count, is_active, witnessed_count, is_archived)
         VALUES (?, 'handle-constraint-probe', 'image', 'unlocked', ?, 0, 0, 0, 0)`,
      )
      .run(TENANT, new Date().toISOString());
    const projectId = Number(created.lastInsertRowid);
    let seq = 1;
    const insert = (cp: string | null, auth: string | null) =>
      M.conn()
        .prepare(
          `INSERT INTO iterations
             (project_id, run_sequence, timestamp, leaf_hash, output_hash, output_kind,
              output_bytes, witnessed,
              resolution_checkpoint_id, resolution_witness_authority)
           VALUES (?, ?, ?, ?, ?, 'image', 0, 0, ?, ?)`,
        )
        .run(projectId, seq++, new Date().toISOString(), 'h'.repeat(64), 'o'.repeat(64), cp, auth);

    assert.throws(() => insert('ckpt-1', null), /CHECK constraint failed/);
    // And the control: the constraint is not merely refusing everything.
    assert.doesNotThrow(() => insert('ckpt-1', AUTHORITY));
    assert.doesNotThrow(() => insert(null, null));
  });
});
