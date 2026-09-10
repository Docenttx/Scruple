// WO-F3 — `imported_datablocks`: what entered the document from OUTSIDE it,
// and that nobody here watched it arrive.
//
// Closing WO-E7 finding E7-1 (`docs/STATE.md` §4.7), the finding the E series
// ends on. Two Blender scenes were built around two DIFFERENT AI images — the
// same scene, the same camera, the same frame, a different generated image
// packed inside — and the two leaves the standalone add-on produced were
// IDENTICAL in every field capable of describing how the artifact came to
// exist. Nothing on them was false. The claim was ABSENT, and absence and
// "there was nothing" read the same.
//
// EVERY GATE IN THIS FILE HAS A CONTROL NAMED BESIDE IT.
//
//   THE GATE     two leaves whose imported datablocks differ DIFFER in the new
//                field, and each names a datablock and a digest.
//   CONTROL (a)  a document with NO imported datablocks yields an EMPTY
//                DECLARATION THAT IS PRESENT — count 0, document stored —
//                never an absent field. The two mean different things, as they
//                did in WO-E2.
//   CONTROL (b)  a datablock whose bytes cannot be read is recorded as
//                UNREADABLE, not omitted and not given somebody else's digest.
//   CONTROL (c)  the field is in the MAC: a digest changed in flight breaks
//                the envelope, and a digest changed at source moves the hash
//                the witness signs — via the input manifest, which is how a
//                COMPONENTLESS plugin's declaration is bound to its leaf at
//                all.
//   CONTROL (d)  a Desktop Studio leaf and an add-on leaf for the same
//                artifact LINK by digest, and one for a different artifact
//                does not.
//
//   AND THE CONTROL FOR THE CONTROLS: `imported_origin_observed: true` must be
//                REFUSED while no door in this estate observes an import. A
//                field that could be self-asserted true is a field that says
//                nothing when it says false.
//
// TEST ISOLATION follows declared-uncaptured.test.ts: a private database
// assigned at module top level, everything reaching lib/db/sqlite imported
// dynamically inside before().

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
import {
  IMPORTED_DATABLOCKS_INPUT_KIND,
  IMPORTED_ORIGIN_OBSERVER,
  hashImportedDatablocks,
  validateImportedDatablocks,
} from '../../lib/capture/importedDatablocks';

if (!process.env.SCRUPLE_DB_PATH || !/tmp|test/i.test(process.env.SCRUPLE_DB_PATH)) {
  throw new Error('Refusing to run: set SCRUPLE_DB_PATH to a throwaway path. Use `npm run test:v2`.');
}
const OWN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'scruple-imported-datablocks-'));
process.env.SCRUPLE_DB_PATH = path.join(OWN_DIR, 'imported-datablocks.db');
process.env.SCRUPLE_BDK_HEX = 'f3'.repeat(32);
// The standing rule: never the production witness on 127.0.0.1:5799. Port 1
// refuses, `witnessed` comes back false, and every field under test here is
// written by this tier rather than by the witness.
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
  hashRunInputs: typeof import('../../lib/leaf/hashes').hashRunInputs;
  POST: (req: Request) => Promise<Response>;
};

let M: Mod;
const TENANT = 'vendor-f3';
const BUILD = 'sha256:' + 'f3'.repeat(32);
const BASELINE = 'f'.repeat(64);
let API_KEY: string;

const digestOf = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

/** One declared datablock, in the shape the SDK's `entry()` builds. */
const block = (over: Record<string, unknown> = {}) => ({
  datablock: 'imported-from-somewhere-else',
  type: 'image',
  origin: 'FILE',
  packed: true,
  filename: 'generated.png',
  bytes: 1267,
  digest: digestOf('the AI image nobody here saw being made'),
  digest_of: 'packed_bytes',
  unreadable: null,
  ...over,
});

/** The document, plus the five scalars derived from it exactly as the SDK's
 *  `wire_fields()` derives them — never declared independently, because a
 *  count that disagreed with its own list is a refusal, not a leaf. */
function declare(
  datablocks: Array<Record<string, unknown>>,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  const doc = {
    source: 'host_datablocks',
    origin_observed: false,
    datablock_types: ['image'],
    datablocks,
    ...over,
  };
  return {
    imported_datablocks: doc,
    imported_datablocks_source: doc.source,
    imported_origin_observed: doc.origin_observed,
    imported_datablocks_count: datablocks.length,
    imported_datablocks_unreadable_count: datablocks.filter((d) => d.digest === null).length,
    imported_datablocks_hash: hashImportedDatablocks(doc).hash,
  };
}

const RESOLUTION = () => ({
  witness_endpoint: 'https://witness.example.vendor/api',
  witness_authority: 'sha256:' + 'cd'.repeat(32),
  checkpoint_id: null,
  prev_checkpoint_id: null,
  prev_checkpoint_quote_time: null,
  // The named clock puts the end of the default policy's settlement window
  // 86400s out, and a deadline more than 300s from there is refused (WO-C3) —
  // a deadline nobody's clock agrees with was derived from a clock nobody
  // named. Not a magic number: DEFAULT_RETENTION_POLICY's window.
  settlement_deadline: new Date(
    Date.now() + DEFAULT_RETENTION_POLICY.settlement_window_s * 1000,
  ).toISOString(),
  retention_policy_digest: DEFAULT_RETENTION_POLICY_DIGEST,
});

/**
 * ⚑ A PLUGIN SUBMISSION: no component, no MAC, no capture block.
 *
 * This is the product under test. `docs/BLENDER.md` row 1 — the add-on alone,
 * with no gate anywhere in its path — and it is why the five scalars are
 * submission fields rather than capture fields: this body has nowhere else to
 * put them, and a `capture` block would oblige it to declare an attestation
 * basis, a profile, a confinement, an upstream epoch and a host level it has
 * no way to observe.
 */
function pluginBody(extra: Record<string, unknown> = {}) {
  return {
    baseline_ref: BASELINE,
    kind: 'document_save',
    content_hash: crypto.randomBytes(32).toString('hex'),
    mime: 'application/x-blender',
    machine_manifest_hash: crypto.randomBytes(32).toString('hex'),
    ...extra,
  };
}

/** A component submission, MACed over the body it actually sends. */
function componentBody(componentId: string, counter: number, extra: Record<string, unknown> = {}) {
  const body: Record<string, unknown> = {
    baseline_ref: BASELINE,
    kind: 'artifact',
    content_hash: crypto.randomBytes(32).toString('hex'),
    mime: 'image/png',
    capture: {
      surface: 'in-process-callback',
      hook: 'artifact.produced',
      fidelity: 'as-delivered',
      size_bytes: 17,
      mime_source: 'caller-declared',
      correlation_id: null,
      correlation_method: null,
      egress: null,
      close_detection: null,
      workflow_hash: null,
      observed_at: new Date().toISOString(),
      attestation_status: 'stale',
      profile: 'server-managed',
      confinement: 'unknown',
      confinement_source: 'unknown',
      upstream_identity: null,
      upstream_epoch: null,
      upstream_continuity: 'unknown',
      upstream_low_watermark_open: null,
      upstream_low_watermark_close: null,
      upstream_uncaptured_reason: 'not_queried',
      upstream_source: 'unknown',
      host: null,
      host_adapter: null,
      host_evidence_type: null,
      host_semantics: 'blind',
      host_evidence_hash: null,
      uncaptured_enumeration_method: 'none',
      uncaptured_scope: 'not_enumerated',
      uncaptured_scope_source: 'unknown',
      declared_uncaptured_count: null,
      declared_uncaptured_hash: null,
    },
    resolution: RESOLUTION(),
    component: {
      component_id: componentId,
      build_measurement: BUILD,
      counter,
      attestation: { provider: 'none', quote_ref: null },
    },
    ...extra,
  };
  const { mac } = (() => {
    const r = new M.Ratchet(M.deriveIk(M.bdk(), componentId), 0);
    r.skip(counter);
    const out = r.mac(M.componentPreimage(body as never));
    r.destroy();
    return out;
  })();
  body.mac = mac;
  return body;
}

const witnessReq = (body: unknown) =>
  new Request('https://scruple.ai/api/v2/witness', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify(body),
  });

async function post(body: unknown) {
  const res = await M.POST(witnessReq(body));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function provision(): string {
  const { componentId, token } = M.issueProvisioningToken({ tenantId: TENANT, label: 'sidecar' });
  assert.ok(M.redeemProvisioningToken({ token, tenantId: TENANT, buildMeasurement: BUILD }).ok);
  return componentId;
}

const rowOf = (leafId: unknown) =>
  M.conn()
    .prepare(
      `SELECT output_hash, input_hash,
              imported_datablocks_source, imported_origin_observed,
              imported_datablocks_count, imported_datablocks_unreadable_count,
              imported_datablocks_hash, imported_datablocks
         FROM iterations WHERE id = ?`,
    )
    .get(Number(leafId)) as Record<string, unknown>;

before(async () => {
  const [sqlite, migrate, prov, ratchet, bdkMod, preimage, hashes, route] = await Promise.all([
    import('../../lib/db/sqlite'),
    import('../../lib/db/migrate'),
    import('../../lib/ratchet/provisioning'),
    import('../../lib/ratchet/ratchet'),
    import('../../lib/ratchet/bdk'),
    import('../../lib/leaf/componentPreimage'),
    import('../../lib/leaf/hashes'),
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
    hashRunInputs: hashes.hashRunInputs,
    POST: route.POST as unknown as (req: Request) => Promise<Response>,
  };
  M.runMigrations(false);
  M.conn().prepare(`INSERT INTO users (id, email) VALUES (?, ?)`).run(TENANT, 'f3@example.com');
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
 * 1 · THE GATE — two documents around two different imports DIFFER
 * ════════════════════════════════════════════════════════════════════════ */

describe('WO-F3 — the leaf declares what entered the document from outside it', () => {
  test('⚑ THE GATE: two imports, two different declarations on two leaves', async () => {
    const one = digestOf('AI image A');
    const two = digestOf('AI image B');
    const a = await post(pluginBody(declare([block({ digest: one })])));
    const b = await post(pluginBody(declare([block({ digest: two })])));
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    const ra = rowOf(a.body.leaf_id);
    const rb = rowOf(b.body.leaf_id);

    // The declaration MOVED. E7-1's measurement was that nothing did.
    assert.notEqual(ra.imported_datablocks_hash, rb.imported_datablocks_hash);
    // …and each names the datablock and the digest, rather than a cardinality.
    const doca = JSON.parse(String(ra.imported_datablocks));
    assert.equal(doca.datablocks[0].datablock, 'imported-from-somewhere-else');
    assert.equal(doca.datablocks[0].digest, one);
    assert.equal(JSON.parse(String(rb.imported_datablocks)).datablocks[0].digest, two);
    // …and says nobody here watched it arrive, as a VALUE.
    assert.equal(ra.imported_origin_observed, 0);
    assert.equal(ra.imported_datablocks_count, 1);
    assert.equal(ra.imported_datablocks_unreadable_count, 0);
  });

  test('the stored document is the CANONICAL BYTES, so the digest re-computes from the column', async () => {
    const r = await post(pluginBody(declare([block()])));
    const row = rowOf(r.body.leaf_id);
    const rehashed = crypto
      .createHash('sha256')
      .update(String(row.imported_datablocks), 'utf8')
      .digest('hex');
    assert.equal(rehashed, row.imported_datablocks_hash);
  });

  test('⚑ CONTROL (c): the digest is folded into input_hash, so it moves the LEAF', async () => {
    // The witness hashes `input_hash` into its canonical record under both v2
    // and v2.2, and signs the result. This is the whole binding for a
    // componentless plugin — there is no MAC on its submissions at all.
    const one = digestOf('AI image A');
    const two = digestOf('AI image B');
    const da = declare([block({ digest: one })]);
    const db = declare([block({ digest: two })]);
    const a = await post(pluginBody(da));
    const b = await post(pluginBody(db));
    const ra = rowOf(a.body.leaf_id);
    const rb = rowOf(b.body.leaf_id);
    assert.notEqual(ra.input_hash, rb.input_hash);
    // And it is REPRODUCIBLE outside this server: the manifest is one ref
    // under a reserved kind, hashed with the formula in lib/leaf/hashes.ts.
    assert.equal(
      ra.input_hash,
      M.hashRunInputs({
        provider: null,
        prompt: null,
        spec: null,
        inputs: [
          {
            kind: IMPORTED_DATABLOCKS_INPUT_KIND,
            hash: String(da.imported_datablocks_hash),
          },
        ],
      }),
    );
    // A one-digit change in ONE datablock's digest is enough. The document's
    // digest covers the list, and the list's digest is in the leaf.
    assert.notEqual(da.imported_datablocks_hash, db.imported_datablocks_hash);
  });

  test('the response echoes the declaration, including that it is bound to the leaf', async () => {
    const r = await post(pluginBody(declare([block()])));
    const d = r.body.imported_datablocks as Record<string, unknown>;
    assert.equal(d.source, 'host_datablocks');
    assert.equal(d.origin_observed, false);
    assert.equal(d.count, 1);
    assert.equal(d.input_hash_folds_declaration, true);
    // `signed` is the RATCHET's answer, and it is false here because a plugin
    // has no component. Stated rather than omitted: "nothing MACed this" is a
    // fact a consumer needs.
    assert.equal(d.signed, false);
  });

  test('a leaf that declared NOTHING is null across all six columns, and echoes null', async () => {
    const r = await post(pluginBody());
    assert.equal(r.status, 201);
    const row = rowOf(r.body.leaf_id);
    assert.equal(row.imported_datablocks_source, null);
    assert.equal(row.imported_origin_observed, null);
    assert.equal(row.imported_datablocks_count, null);
    assert.equal(row.imported_datablocks_unreadable_count, null);
    assert.equal(row.imported_datablocks_hash, null);
    assert.equal(row.imported_datablocks, null);
    assert.equal(row.input_hash, null);
    assert.equal(r.body.imported_datablocks, null);
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * 2 · CONTROL (a) — THE EMPTY DECLARATION IS PRESENT
 * ════════════════════════════════════════════════════════════════════════ */

describe('WO-F3 control (a) — an empty declaration is PRESENT, not absent', () => {
  test('⚑ a document with no imports declares count 0 and stores the document', async () => {
    const r = await post(pluginBody(declare([])));
    assert.equal(r.status, 201);
    const row = rowOf(r.body.leaf_id);
    assert.equal(row.imported_datablocks_source, 'host_datablocks');
    assert.equal(row.imported_datablocks_count, 0);
    assert.equal(row.imported_datablocks_unreadable_count, 0);
    assert.equal(row.imported_origin_observed, 0);
    assert.ok(row.imported_datablocks_hash);
    assert.deepEqual(JSON.parse(String(row.imported_datablocks)).datablocks, []);
  });

  test('⚑ …and it is DISTINGUISHABLE from a leaf that declared nothing, on the leaf', async () => {
    const empty = await post(pluginBody(declare([])));
    const silent = await post(pluginBody());
    const re = rowOf(empty.body.leaf_id);
    const rs = rowOf(silent.body.leaf_id);
    assert.equal(rs.imported_datablocks_count, null);
    assert.equal(re.imported_datablocks_count, 0);
    // Not merely a different column value: a different input_hash, therefore a
    // different leaf. "Looked and nothing came from outside" and "nobody
    // looked" are not the same leaf even when the bytes are the same bytes.
    assert.ok(re.input_hash);
    assert.equal(rs.input_hash, null);
  });

  test('`source: "none"` is the third state — enumerated by nobody, and carries no set', async () => {
    const r = await post(pluginBody({ imported_datablocks_source: 'none' }));
    assert.equal(r.status, 201);
    const row = rowOf(r.body.leaf_id);
    assert.equal(row.imported_datablocks_source, 'none');
    assert.equal(row.imported_datablocks_count, null);
    assert.equal(row.imported_origin_observed, null);
    assert.equal(row.imported_datablocks, null);
    // ⚑ Still not NULL: the column says somebody was asked and had nothing to
    // enumerate, which is not the same as never being asked.
    assert.notEqual(row.imported_datablocks_source, null);
  });

  test('`source: "none"` carrying a set is refused in every direction', async () => {
    for (const over of [
      { imported_datablocks_count: 0 },
      { imported_datablocks_hash: 'ab'.repeat(32) },
      { imported_origin_observed: false },
      { imported_datablocks: { source: 'none', origin_observed: false, datablock_types: ['image'], datablocks: [] } },
    ]) {
      const r = await post(pluginBody({ imported_datablocks_source: 'none', ...over }));
      assert.equal(r.status, 422);
      assert.equal(
        (r.body.error as Record<string, unknown>).code,
        'imported_datablocks_refused',
        JSON.stringify(over),
      );
    }
  });

  test('an enumerated source with no count, no digest or no origin answer is refused', async () => {
    const full = declare([block()]);
    for (const drop of [
      'imported_datablocks_count',
      'imported_datablocks_hash',
      'imported_origin_observed',
      'imported_datablocks_unreadable_count',
    ]) {
      const partial: Record<string, unknown> = { ...full };
      delete partial[drop];
      const r = await post(pluginBody(partial));
      assert.equal(r.status, 422, drop);
      assert.equal(
        (r.body.error as Record<string, unknown>).code,
        'imported_datablocks_required',
        drop,
      );
    }
  });

  test('a digest with no document is refused — a set no verifier can read', async () => {
    const full = declare([block()]);
    delete full.imported_datablocks;
    const r = await post(pluginBody(full));
    assert.equal(r.status, 422);
    assert.equal((r.body.error as Record<string, unknown>).code, 'imported_datablocks_refused');
  });

  test('a document with no scope — no `datablock_types` — is refused', async () => {
    const d = declare([block()]);
    const doc = { ...(d.imported_datablocks as Record<string, unknown>) };
    delete doc.datablock_types;
    const r = await post(
      pluginBody({ ...d, imported_datablocks: doc, imported_datablocks_hash: hashImportedDatablocks(doc).hash }),
    );
    assert.equal(r.status, 422);
    assert.equal((r.body.error as Record<string, unknown>).code, 'imported_datablocks_refused');
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * 3 · CONTROL (b) — UNREADABLE IS RECORDED, NOT OMITTED
 * ════════════════════════════════════════════════════════════════════════ */

describe('WO-F3 control (b) — a datablock whose bytes cannot be read', () => {
  test('⚑ it is a MEMBER with a reason, and the unreadable count says so', async () => {
    const gone = block({
      datablock: 'vanished-import',
      digest: null,
      digest_of: null,
      unreadable: 'source_file_missing',
      bytes: null,
      packed: false,
    });
    const r = await post(pluginBody(declare([block(), gone])));
    assert.equal(r.status, 201);
    const row = rowOf(r.body.leaf_id);
    assert.equal(row.imported_datablocks_count, 2);
    assert.equal(row.imported_datablocks_unreadable_count, 1);
    const doc = JSON.parse(String(row.imported_datablocks));
    const m = doc.datablocks.find((d: Record<string, unknown>) => d.datablock === 'vanished-import');
    assert.equal(m.digest, null);
    assert.equal(m.unreadable, 'source_file_missing');
  });

  test('a member with BOTH a digest and a reason it has none is refused', async () => {
    const both = block({ unreadable: 'source_file_missing' });
    const r = await post(pluginBody(declare([both])));
    assert.equal(r.status, 422);
    assert.equal((r.body.error as Record<string, unknown>).code, 'imported_datablocks_refused');
  });

  test('a member with NEITHER is refused — it declares nothing at all', async () => {
    const neither = block({ digest: null, digest_of: null });
    const r = await post(pluginBody(declare([neither])));
    assert.equal(r.status, 422);
  });

  test('a digest with no `digest_of` is refused — a verifier would not know what to re-hash', async () => {
    const r = await post(pluginBody(declare([block({ digest_of: null })])));
    assert.equal(r.status, 422);
  });

  test('an unreadable count above the count is refused — the unreadable are a SUBSET', async () => {
    const d = declare([block()]);
    d.imported_datablocks_unreadable_count = 2;
    const r = await post(pluginBody(d));
    assert.equal(r.status, 422);
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * 4 · CONTROL (c) — IN THE MAC, AND THE DOCUMENT CANNOT BE SEPARATED FROM IT
 * ════════════════════════════════════════════════════════════════════════ */

describe('WO-F3 control (c) — the declaration is inside the MAC', () => {
  test('⚑ the five scalars are preimage fields, and the digest moves the preimage', () => {
    const one = { ...pluginBody(declare([block({ digest: digestOf('A') })])), component: { component_id: 'c', counter: 0 } };
    const two = { ...pluginBody(declare([block({ digest: digestOf('B') })])), component: { component_id: 'c', counter: 0 } };
    const pa = M.componentPreimage(one as never);
    const pb = M.componentPreimage(two as never);
    assert.equal(Object.hasOwn(pa, 'imported_datablocks_hash'), true);
    assert.equal(Object.hasOwn(pa, 'imported_origin_observed'), true);
    assert.notEqual(pa.imported_datablocks_hash, pb.imported_datablocks_hash);
    // ⚑ AND THE DOCUMENT IS NOT IN THE PREIMAGE. A member list cannot ride in
    // a MAC — the same split `graph`/`workflow_hash` uses. What binds it is
    // the digest beside it.
    assert.equal(Object.hasOwn(pa, 'imported_datablocks'), false);
  });

  test('⚑ a declaration rewritten in flight lands as component_unverified', async () => {
    const id = provision();
    const body = componentBody(id, 0, declare([block({ digest: digestOf('what the component declared') })]));
    // A party in the middle swaps the document AND its digest, consistently —
    // the pair agrees, so the route's arithmetic check passes and only the MAC
    // notices. That is the whole reason the scalars are signed.
    const swapped = declare([block({ digest: digestOf('what somebody else put there') })]);
    const tampered = { ...body, ...swapped };
    const r = await post(tampered);
    assert.equal(r.status, 422);
    assert.equal((r.body.error as Record<string, unknown>).code, 'component_unverified');
  });

  test('…and the same submission, unmodified, verifies', async () => {
    const id = provision();
    const r = await post(componentBody(id, 0, declare([block()])));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.component_verified, true);
    assert.equal((r.body.imported_datablocks as Record<string, unknown>).signed, true);
  });

  test('a document whose digest does not match it is refused, both halves stated', async () => {
    const d = declare([block()]);
    d.imported_datablocks_hash = 'ab'.repeat(32);
    const r = await post(pluginBody(d));
    assert.equal(r.status, 422);
    assert.equal((r.body.error as Record<string, unknown>).code, 'imported_datablocks_refused');
  });

  test('a document whose LIST disagrees with the signed count is refused', async () => {
    const d = declare([block(), block({ datablock: 'second' })]);
    // The counts are signed and the list is not: a member removed in flight
    // must not pass, even with the digest recomputed over the shortened list.
    const doc = d.imported_datablocks as Record<string, unknown>;
    const shortened = { ...doc, datablocks: [(doc.datablocks as unknown[])[0]] };
    const r = await post(
      pluginBody({
        ...d,
        imported_datablocks: shortened,
        imported_datablocks_hash: hashImportedDatablocks(shortened).hash,
      }),
    );
    assert.equal(r.status, 422);
    assert.equal((r.body.error as Record<string, unknown>).code, 'imported_datablocks_refused');
  });

  test('a scalar sent DOWN into `capture` is refused — the preimage does not read it there', async () => {
    const id = provision();
    const body = componentBody(id, 0);
    (body.capture as Record<string, unknown>).imported_datablocks_count = 1;
    const r = await post(body);
    assert.equal(r.status, 422);
    assert.equal((r.body.error as Record<string, unknown>).code, 'imported_datablocks_refused');
  });

  test('the DOCUMENT sent down into `capture` is refused — nothing would hash it', async () => {
    const id = provision();
    const body = componentBody(id, 0);
    (body.capture as Record<string, unknown>).imported_datablocks = { datablocks: [] };
    const r = await post(body);
    assert.equal(r.status, 422);
    assert.equal((r.body.error as Record<string, unknown>).code, 'imported_datablocks_refused');
  });

  test('a precomputed `input_hash` beside a declaration is refused, not silently unbound', async () => {
    const r = await post(
      pluginBody({ ...declare([block()]), input_hash: crypto.randomBytes(32).toString('hex') }),
    );
    assert.equal(r.status, 422);
    assert.equal((r.body.error as Record<string, unknown>).code, 'imported_datablocks_refused');
  });

  test('an input ref under the reserved kind is refused — it would forge the fold', async () => {
    const r = await post(
      pluginBody({ inputs: [{ kind: IMPORTED_DATABLOCKS_INPUT_KIND, hash: 'cd'.repeat(32) }] }),
    );
    assert.equal(r.status, 422);
    assert.equal((r.body.error as Record<string, unknown>).code, 'imported_datablocks_refused');
  });

  test('a caller that declares its own inputs keeps them, with the declaration APPENDED', async () => {
    const d = declare([block()]);
    const mine = { kind: 'reference_image', hash: 'ef'.repeat(32) };
    const r = await post(pluginBody({ ...d, inputs: [mine] }));
    assert.equal(r.status, 201);
    const row = rowOf(r.body.leaf_id);
    assert.equal(
      row.input_hash,
      M.hashRunInputs({
        provider: null,
        prompt: null,
        spec: null,
        inputs: [mine, { kind: IMPORTED_DATABLOCKS_INPUT_KIND, hash: String(d.imported_datablocks_hash) }],
      }),
    );
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * 5 · THE CONTROL FOR THE CONTROLS — `origin_observed: true` is REFUSED
 * ════════════════════════════════════════════════════════════════════════ */

describe('WO-F3 — nobody may claim they watched the import', () => {
  test('the blocker is off, and that is a named fact rather than an accident', () => {
    assert.equal(IMPORTED_ORIGIN_OBSERVER, false);
  });

  test('⚑ `imported_origin_observed: true` is refused while no door observes an import', async () => {
    const d = declare([block()], { origin_observed: true });
    const r = await post(pluginBody(d));
    assert.equal(r.status, 422);
    assert.equal((r.body.error as Record<string, unknown>).code, 'imported_datablocks_refused');
    assert.match(String((r.body.error as Record<string, unknown>).message), /refusal rather than a downgrade/);
  });

  test('…and the refusal is POLICY: with an observer it validates', () => {
    const d = declare([block()], { origin_observed: true });
    const body = { ...pluginBody(d) } as Record<string, unknown>;
    assert.equal(validateImportedDatablocks(body, { originObserver: false }).ok, false);
    assert.equal(validateImportedDatablocks(body, { originObserver: true }).ok, true);
  });

  test('a non-boolean origin answer is refused', async () => {
    const d = declare([block()]);
    d.imported_origin_observed = 'no' as unknown as boolean;
    const r = await post(pluginBody(d));
    assert.equal(r.status, 400);
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * 6 · CONTROL (d) — THE TWO PRODUCTS LINK BY DIGEST
 * ════════════════════════════════════════════════════════════════════════ */

describe('WO-F3 control (d) — a Desktop Studio leaf and a plugin leaf join up', () => {
  test('⚑ the join finds the witnessed artifact the document imported', async () => {
    // 1. Desktop Studio witnesses the AI image: its `content_hash` IS the
    //    sha256 of the file ComfyUI wrote.
    const id = provision();
    const studio = componentBody(id, 0);
    const artifact = String(studio.content_hash);
    const s = await post(studio);
    assert.equal(s.status, 201);

    // 2. The add-on, later, on a different machine for all this proves, saves
    //    a .blend with those same bytes packed inside it.
    const p = await post(
      pluginBody(declare([block({ digest: artifact, filename: 'from-comfy.png' })])),
    );
    assert.equal(p.status, 201);

    // 3. THE JOIN. Given a witnessed artifact, which documents imported it —
    //    over the stored document, with no shared identifier of any kind
    //    between the two leaves except the digest of the bytes.
    const joined = M.conn()
      .prepare(
        `SELECT plugin.id AS plugin_leaf, studio.id AS studio_leaf
           FROM iterations plugin
           JOIN iterations studio ON studio.output_hash = ?
          WHERE plugin.imported_datablocks LIKE '%' || ? || '%'
            AND plugin.id = ?`,
      )
      .all(artifact, artifact, Number(p.body.leaf_id)) as Array<Record<string, unknown>>;
    assert.equal(joined.length, 1);
    assert.equal(String(joined[0]!.studio_leaf), String(s.body.leaf_id));

    // ⚑ AND NEITHER LEAF OVERCLAIMS. The plugin leaf still says nobody there
    // watched the import; the link is something a THIRD party computes from
    // two records, not something either record asserts.
    const row = rowOf(p.body.leaf_id);
    assert.equal(row.imported_origin_observed, 0);
  });

  test('CONTROL: a document that imported something else does NOT join', async () => {
    const id = provision();
    const studio = componentBody(id, 0);
    const artifact = String(studio.content_hash);
    await post(studio);
    const p = await post(pluginBody(declare([block({ digest: digestOf('some other bytes') })])));
    const joined = M.conn()
      .prepare(
        `SELECT id FROM iterations
          WHERE imported_datablocks LIKE '%' || ? || '%' AND id = ?`,
      )
      .all(artifact, Number(p.body.leaf_id)) as unknown[];
    assert.equal(joined.length, 0);
  });
});
