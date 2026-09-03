// WO-1 · the evidence package actually reaches the witness.
//
// The drift guard (leaf-registry.test.ts) proves the route's source
// MENTIONS input_hash, workflow_hash and model_fingerprints_hash. That
// is not the same as sending them, and the bug this replaces —
// `workflowHash: body.graph ? undefined : undefined` — mentioned the
// graph too. So this file stands a real witness server up on a loopback
// port, drives the real route handler, and reads what came off the wire.
//
// SAFETY, both rules from test/integration/harness.ts, enforced again
// here because this file is not run through that harness:
//
//  1. Its own throwaway SCRUPLE_DB_PATH. The v2 suite runs its files
//     concurrently against one shared database, so a file that writes
//     rows must not share it.
//  2. WITNESS_SERVER_URL is repointed at the local stub. 127.0.0.1:5799
//     is the PRODUCTION witness; a test that reaches it writes into a
//     real audit log, which has happened once already.
//
// tsx compiles this to CJS, so top-level await is unavailable and the
// modules under test are imported inside before() — which is also what
// makes the env assignments above take effect, since lib/db/sqlite and
// lib/scruple/witness both read their env var at module scope.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const PROD_WITNESS = /127\.0\.0\.1:5799|localhost:5799/;
if (PROD_WITNESS.test(process.env.WITNESS_SERVER_URL ?? '')) {
  throw new Error('Refusing to run against the production witness server.');
}

const TENANT = 'tenant-wo1';
const SURFACE = crypto.createHash('sha256').update('wo1 tamper surface').digest('hex');
const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

let dir: string;
let server: http.Server;
let submissions: Array<Record<string, unknown>> = [];
let POST: (req: Request) => Promise<Response>;
let db: () => import('better-sqlite3').Database;
let key: string;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scruple-wo1-'));
  process.env.SCRUPLE_DB_PATH = path.join(dir, 'wo1-test.db');

  // A witness server that records what it was told, and answers the way
  // the real one does. Port 0 so parallel test files cannot collide.
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      submissions.push(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          witness_id: `wit_${submissions.length}`,
          server_timestamp: new Date().toISOString(),
          signature: 'hmac-transport-seal',
          leaf_hash: sha256(`leaf-${submissions.length}`),
          prev_record_hash: '',
          leaf_scheme: body.machine_manifest_hash ? 'v2.2' : 'v2',
          leaf_signature: null,
          leaf_signer_key_id: null,
          leaf_signature_alg: null,
          signer_surrogate: false,
          independently_verifiable: false,
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  process.env.WITNESS_SERVER_URL = `http://127.0.0.1:${port}`;

  const { runMigrations } = await import('../../lib/db/migrate');
  const { conn } = await import('../../lib/db/sqlite');
  runMigrations(false);
  db = conn;

  conn().prepare(`INSERT INTO users (id, email) VALUES (?, ?)`).run(TENANT, 'wo1@example.com');
  key = `sk_test_${crypto.randomBytes(32).toString('base64url')}`;
  conn()
    .prepare(
      `INSERT INTO api_keys (id, user_id, key_hash, key_prefix, scopes_json, label)
       VALUES (?, ?, ?, ?, ?, 'wo1')`,
    )
    .run(
      crypto.randomUUID(),
      TENANT,
      crypto.createHash('sha256').update(key).digest('hex'),
      key.slice(0, 12),
      JSON.stringify(['witness:write']),
    );
  const now = new Date().toISOString();
  conn()
    .prepare(
      `INSERT INTO baselines
         (tenant_id, baseline_hash, manifest_json, attestation_provider,
          signer_pubkey_spki_sha256_hex, submitted_at, activated_at)
       VALUES (?, ?, '{}', 'none', ?, ?, ?)`,
    )
    .run(TENANT, SURFACE, sha256('pubkey'), now, now);

  ({ POST } = (await import('../../app/api/v2/witness/route')) as unknown as {
    POST: (req: Request) => Promise<Response>;
  });
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function witnessRequest(body: Record<string, unknown>) {
  return new Request('https://scruple.ai/api/v2/witness', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ baseline_ref: SURFACE, ...body }),
  });
}

const GRAPH = { '9': { class_type: 'SaveImage', inputs: { images: ['8', 0] } }, '3': { class_type: 'KSampler' } };
const FINGERPRINTS = {
  'checkpoints/sdxl.safetensors': { content_hash: sha256('sdxl'), bytes: 12 },
  'loras/a.safetensors': { content_hash: sha256('lora-a'), bytes: 4 },
};
const INPUTS = [
  { kind: 'init_image', hash: sha256('init') },
  { kind: 'control_image', hash: sha256('ctrl') },
];

describe('the three dropped hashes reach the witness', () => {
  let submitted: Record<string, unknown>;
  let responded: Record<string, unknown>;

  before(async () => {
    const res = await POST(
      witnessRequest({
        kind: 'graph_execute',
        content_hash: sha256('output bytes'),
        mime: 'image/png',
        graph: GRAPH,
        inputs: INPUTS,
        model_fingerprints: FINGERPRINTS,
        machine_manifest_hash: sha256('machine manifest'),
      }),
    );
    assert.equal(res.status, 201, await res.clone().text());
    responded = await res.json();
    submitted = submissions[submissions.length - 1];
  });

  test('workflow_hash — the graph is folded in, not discarded', async () => {
    const { hashWorkflow } = await import('../../lib/leaf/hashes');
    assert.equal(submitted.workflow_hash, hashWorkflow(GRAPH));
    assert.equal(responded.workflow_hash, hashWorkflow(GRAPH));
  });

  test('input_hash — the declared input manifest is bound', async () => {
    const { hashRunInputs } = await import('../../lib/leaf/hashes');
    const expected = hashRunInputs({ provider: null, prompt: null, spec: null, inputs: INPUTS });
    assert.equal(submitted.input_hash, expected);
  });

  test('model_fingerprints_hash — the weights are bound', async () => {
    const { hashModelFingerprints } = await import('../../lib/leaf/hashes');
    assert.equal(submitted.model_fingerprints_hash, hashModelFingerprints(FINGERPRINTS)?.hash);
  });

  test('machine_manifest_hash still rides along, and selects the v2.2 scheme', () => {
    assert.equal(submitted.machine_manifest_hash, sha256('machine manifest'));
    assert.equal(responded.leaf_scheme, 'v2.2');
  });

  test('all five hashes are present in one submission — the package is whole', () => {
    for (const f of [
      'content_hash',
      'input_hash',
      'workflow_hash',
      'model_fingerprints_hash',
      'machine_manifest_hash',
    ]) {
      assert.match(String(submitted[f]), /^[0-9a-f]{64}$/, `${f} missing from the leaf`);
    }
  });

  test('and they are stored, not only transmitted', () => {
    const row = db()
      .prepare(`SELECT * FROM iterations WHERE output_hash = ?`)
      .get(sha256('output bytes')) as Record<string, unknown>;
    assert.ok(row, 'no iteration row');
    assert.equal(row.workflow_hash, submitted.workflow_hash);
    assert.equal(row.input_hash, submitted.input_hash);
    assert.equal(row.model_fingerprints_hash, submitted.model_fingerprints_hash);
    assert.equal(row.machine_manifest_hash, submitted.machine_manifest_hash);
    assert.ok(row.model_fingerprints, 'the manifest itself must survive for the receipt');
  });
});

describe('the /v2 path produces the same hash as the canvas path', () => {
  // The failure this rules out is silent: two implementations of one
  // preimage disagree, and a mismatch is indistinguishable from a
  // tampered file. Both call sites import lib/leaf/hashes.ts, and this
  // asserts the numbers, not the import.
  test('workflow_hash is byte-identical to canonicalWorkflow.hashWorkflow', async () => {
    const { hashWorkflow: leaf } = await import('../../lib/leaf/hashes');
    const { hashWorkflow: canvas } = await import('../../lib/scruple/canonicalWorkflow');
    assert.equal(leaf(GRAPH), canvas(GRAPH));
  });

  test('key order in the submitted graph does not change the hash', async () => {
    const { hashWorkflow } = await import('../../lib/leaf/hashes');
    const reordered = { '3': GRAPH['3'], '9': GRAPH['9'] };
    assert.equal(hashWorkflow(reordered), hashWorkflow(GRAPH));
  });

  test('model_fingerprints_hash is canonical, excludes mtime, and stores what it hashed', async () => {
    const { hashModelFingerprints, hashModelFingerprintsLegacy } = await import(
      '../../lib/leaf/hashes'
    );
    const { canonicalize } = await import('../../lib/leaf/canonicalJson');

    // jcs-2. This test previously pinned "sorts only the top level, as ingest
    // always did", which was an accurate description of a defect: nesting
    // stayed in insertion order and was therefore engine-dependent, and the
    // preimage carried each file's `mtime` — filesystem metadata, not a
    // property of the bytes, so nobody holding the model could recompute it.
    const stripped: Record<string, unknown> = {};
    for (const k of Object.keys(FINGERPRINTS)) {
      const { mtime: _m, ...rest } = FINGERPRINTS[k as keyof typeof FINGERPRINTS] as Record<
        string,
        unknown
      >;
      void _m;
      stripped[k] = rest;
    }
    const expected = canonicalize(stripped);
    const got = hashModelFingerprints(FINGERPRINTS);
    assert.equal(got?.hash, crypto.createHash('sha256').update(expected).digest('hex'));

    // STORED IS HASHED. A caller that persists `json` gives a verifier bytes
    // that reproduce the digest; it used to persist one serialization and
    // hash another.
    assert.equal(got?.json, expected);
    assert.equal(crypto.createHash('sha256').update(got!.json).digest('hex'), got!.hash);

    // MUST NOT FIRE — mtime is genuinely gone from the preimage rather than
    // merely reordered. Changing only the timestamp must not move the hash.
    const touched = JSON.parse(JSON.stringify(FINGERPRINTS)) as Record<
      string,
      Record<string, unknown>
    >;
    for (const k of Object.keys(touched)) touched[k].mtime = 1;
    assert.equal(hashModelFingerprints(touched)?.hash, got?.hash);

    // And the jcs-1 rows stay replayable: the old formula still reproduces
    // what it always did, and differs from the new one.
    const legacy = hashModelFingerprintsLegacy(FINGERPRINTS);
    const sorted = Object.keys(FINGERPRINTS).sort();
    const oldCanonical: Record<string, unknown> = {};
    for (const k of sorted) oldCanonical[k] = FINGERPRINTS[k as keyof typeof FINGERPRINTS];
    assert.equal(
      legacy?.hash,
      crypto.createHash('sha256').update(JSON.stringify(oldCanonical)).digest('hex'),
    );
    assert.notEqual(legacy?.hash, got?.hash);
  });

  test('an empty manifest hashes to nothing, not to the hash of {}', async () => {
    const { hashModelFingerprints } = await import('../../lib/leaf/hashes');
    assert.equal(hashModelFingerprints({}), null);
    assert.equal(hashModelFingerprints(undefined), null);
  });
});

describe('kind=model_write · the training recipe is not discarded either', () => {
  test('training hashes into workflow_hash when there is no graph', async () => {
    const { hashWorkflow } = await import('../../lib/leaf/hashes');
    const training = { base_model: 'sdxl', dataset_root_hash: sha256('ds'), lr: 1e-4 };
    const res = await POST(
      witnessRequest({
        kind: 'model_write',
        content_hash: sha256('checkpoint bytes'),
        mime: 'application/octet-stream',
        training,
      }),
    );
    assert.equal(res.status, 201);
    assert.equal(submissions[submissions.length - 1].workflow_hash, hashWorkflow(training));
  });
});

describe('the witness call no longer disagrees with the row it produces', () => {
  test('project_id is the real project, never a synthetic tenant: id', () => {
    // The production witness REFUSES ids prefixed `tenant:`. This route
    // sent one on every call that omitted project_id, the 400 was
    // swallowed, and `witnessed` was false with nothing saying why.
    for (const s of submissions) {
      assert.doesNotMatch(String(s.project_id), /^tenant:|^baseline:/);
      assert.match(String(s.project_id), /^\d+$/);
    }
  });

  test('run_sequence increments per project instead of always being 0', () => {
    const byProject = new Map<string, number[]>();
    for (const s of submissions) {
      const p = String(s.project_id);
      byProject.set(p, [...(byProject.get(p) ?? []), Number(s.run_sequence)]);
    }
    for (const [p, seqs] of byProject) {
      assert.ok(!seqs.includes(0), `project ${p} witnessed run_sequence 0`);
      assert.deepEqual(seqs, [...new Set(seqs)], `project ${p} repeated a run_sequence`);
    }
  });

  test('the sequence the witness was told matches the sequence stored', () => {
    for (const s of submissions) {
      const row = db()
        .prepare(`SELECT run_sequence FROM iterations WHERE project_id = ? AND output_hash = ?`)
        .get(Number(s.project_id), s.content_hash) as { run_sequence: number } | undefined;
      assert.ok(row, `no row for ${s.content_hash}`);
      assert.equal(row.run_sequence, Number(s.run_sequence));
    }
  });
});

describe('a caller that contradicts itself is refused, not guessed at', () => {
  test('a mismatched model_fingerprints_hash is a 400 naming both values', async () => {
    const res = await POST(
      witnessRequest({
        kind: 'artifact',
        content_hash: sha256('contradiction'),
        mime: 'image/png',
        model_fingerprints: FINGERPRINTS,
        model_fingerprints_hash: sha256('something else entirely'),
      }),
    );
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, 'invalid_body');
    assert.ok(body.error.detail.computed);
    assert.ok(body.error.detail.supplied);
  });
});
