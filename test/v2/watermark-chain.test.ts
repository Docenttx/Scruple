// WO-28 — the watermarked derivative, in the chain.
//
// WHAT THIS FILE EXISTS TO PROVE
//
//   1. A WATERMARKED DERIVATIVE GETS ITS OWN WITNESSED LEAF. Migration
//      038 opened `iterations.watermark_derivative_leaf_hash` in July and
//      nothing had ever written it, for a structural reason: the lock
//      finalized (which inserts `locked_projects`) BEFORE it watermarked,
//      and the witness server 403s any witness request for a project
//      holding that row. The derivative was not merely unwitnessed — it
//      could not be witnessed.
//
//   2. THE LEAF IS INDEPENDENTLY RECOMPUTABLE. The test rebuilds the
//      v2.5 canonical record from the iterations row alone and gets
//      the same hash the server returned. A leaf hash nobody outside the
//      server can reproduce is a claim, not evidence.
//
//   3. THE MERKLE ROOT COMMITS TO BOTH ARTIFACTS, and a project with no
//      derivative still produces the byte-identical root it produced
//      before WO-28.
//
//   4. THE 403 IS INTACT AND STILL REFUSES A POST-LOCK LEAF — which is
//      the same assertion as "the reorder is load-bearing": run the
//      watermarker after the seal and it wins no leaf at all.
//
//   5. THE VOCABULARY VALIDATES. All-three-or-none, 64-hex, 32-hex,
//      magic 0x5c, version nibble 1 — the rules lib/witness/ingest.ts
//      has enforced on /v1/log since July, now enforced on the surface
//      the lock actually uses.
//
// THE STUB WITNESS IS THE REAL SERVER. `services/witness-server/server.js`
// is spawned as a child process on an ephemeral port against a throwaway
// SQLite file. That is deliberate: a hand-written stub would have proved
// that the TEST understands the protocol, not that the SERVER implements
// it, and the whole defect being closed here is two witness surfaces
// disagreeing about a vocabulary.
//
// SAFETY. 127.0.0.1:5799 is the PRODUCTION witness and a test that
// reaches it writes into a real audit log, which has happened once
// already. This file asserts its own port is not 5799 before it sends a
// single byte, and never calls the stub's /api/lock (which would mint on
// RVN testnet); it writes `locked_projects` directly, which is exactly
// what `finalize` does at server.js's confirm-and-execute.
//
// TEST ISOLATION, as the other v2 files explain it: `npm run test:v2`
// runs every file CONCURRENTLY against one shared SCRUPLE_DB_PATH, so
// this file takes its own private database, assigned at module top level,
// with every module that reaches lib/db/sqlite imported DYNAMICALLY
// inside before().

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';

if (!process.env.SCRUPLE_DB_PATH || !/tmp|test/i.test(process.env.SCRUPLE_DB_PATH)) {
  throw new Error('Refusing to run: set SCRUPLE_DB_PATH to a throwaway path. Use `npm run test:v2`.');
}
const OWN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-chain-'));
process.env.SCRUPLE_DB_PATH = path.join(OWN_DIR, 'watermark-chain.db');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SERVER_JS = path.join(REPO_ROOT, 'services', 'witness-server', 'server.js');

const USER = 'u_wm_chain';
const WITNESS_PROJECT = `wmchain-${crypto.randomBytes(4).toString('hex')}`;

type Mod = {
  runMigrations: typeof import('../../lib/db/migrate').runMigrations;
  conn: typeof import('../../lib/db/sqlite').conn;
  apply: typeof import('../../lib/watermark/apply');
  witness: typeof import('../../lib/scruple/witness');
  merkle: typeof import('../../lib/scruple/merkle');
  artifacts: typeof import('../../lib/scruple/artifacts');
  embed: typeof import('../../lib/watermark/embed');
};

let M: Mod;
let child: ChildProcess | null = null;
let PORT = 0;
let BASE = '';
let stubDbPath = '';
/** Artifact hashes this file wrote into the repo's content store. */
const WROTE: string[] = [];
let PROJECT_ID = 0;
/** run_sequence → master leaf hash, in run_sequence order. */
const MASTER_LEAVES: string[] = [];

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

/** A real 256×256 PNG. 1024 8×8 blocks — the DCT encoder needs ≥720. */
function makePng(seed: number): Buffer {
  const out = path.join(OWN_DIR, `master-${seed}.png`);
  const r = spawnSync('python3', ['-c', `
import numpy as np
from PIL import Image
rng = np.random.default_rng(${seed})
a = rng.integers(0, 256, size=(256, 256, 3), dtype=np.uint8)
Image.fromarray(a).save(${JSON.stringify(out)})
`], { encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`fixture PNG failed: ${r.stderr}`);
  return fs.readFileSync(out);
}

/**
 * The v2.5 canonical record, reimplemented here from the migration's
 * documentation rather than imported from the server. That is the point:
 * if the server's field order or slot set drifts, this recomputation
 * stops matching and the test fails — which is exactly what a third-party
 * verifier would experience.
 */
function recomputeDerivativeLeaf(row: {
  watermark_derivative_run_sequence: number;
  watermark_derivative_hash: string;
  output_hash: string;
  watermark_payload_hex: string;
  leaf_hash: string;
  watermark_derivative_witness_timestamp: string;
  watermark_derivative_prev_record_hash: string | null;
}): string {
  const ordered = {
    run_sequence: row.watermark_derivative_run_sequence,
    output_hash: row.watermark_derivative_hash,
    input_hash: '',
    workflow_hash: '',
    model_fingerprints_hash: '',
    machine_manifest_hash: '',
    master_hash: row.output_hash,
    watermark_payload_hex: row.watermark_payload_hex,
    ingredient_master_leaf_hash: row.leaf_hash,
    server_timestamp: row.watermark_derivative_witness_timestamp,
    prev_record_hash: row.watermark_derivative_prev_record_hash || '',
  };
  return crypto.createHash('sha256').update(JSON.stringify(ordered)).digest('hex');
}

before(async () => {
  PORT = await freePort();
  assert.notEqual(PORT, 5799, 'REFUSING TO RUN: 5799 is the production witness.');
  BASE = `http://127.0.0.1:${PORT}`;
  stubDbPath = path.join(OWN_DIR, 'stub-witness.db');

  // The witness server's own dependency tree is NOT installed in-tree:
  // services/witness-server/package.json lists `arweave`, and neither the
  // repo root's node_modules nor that directory has it, so `node
  // server.js` from a checkout dies at require time. Rather than npm
  // install a chain-anchoring dependency to run a provenance test, this
  // preload stubs the one missing module. Nothing in this file reaches
  // it: `anchorPermanence` runs only from /api/lock and
  // confirm-and-execute's chain actions, and this file calls neither.
  const shim = path.join(OWN_DIR, 'arweave-shim.cjs');
  fs.writeFileSync(shim, `
const Module = require('module');
const orig = Module._load;
Module._load = function (request) {
  if (request === 'arweave') {
    const stub = { init: () => { throw new Error('arweave is stubbed in test/v2/watermark-chain.test.ts'); } };
    return stub;
  }
  return orig.apply(this, arguments);
};
`);

  child = spawn(process.execPath, ['--require', shim, SERVER_JS], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_PATH: stubDbPath,
      // A real 32+ char secret, so the fail-closed branch is exercised
      // the way production exercises it rather than via the dev opt-in.
      SCRUPLE_WITNESS_SECRET: 'wm-chain-test-secret-'.padEnd(48, 'x'),
      // Leaf signing stays 'disabled' (the module default) — no subprocess
      // per leaf, no KMS, no network.
      SCRUPLE_WITNESS_SIGNER: '',
      STRIPE_SECRET_KEY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.resume();
  child.stderr?.resume();

  // Wait for /health.
  const deadline = Date.now() + 15000;
  for (;;) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) break;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error('stub witness did not start');
    await new Promise((r) => setTimeout(r, 100));
  }

  // MUST be set before lib/scruple/witness.ts is first imported — it
  // reads WITNESS_SERVER_URL at module scope.
  process.env.WITNESS_SERVER_URL = BASE;

  M = {
    runMigrations: (await import('../../lib/db/migrate')).runMigrations,
    conn: (await import('../../lib/db/sqlite')).conn,
    apply: await import('../../lib/watermark/apply'),
    witness: await import('../../lib/scruple/witness'),
    merkle: await import('../../lib/scruple/merkle'),
    artifacts: await import('../../lib/scruple/artifacts'),
    embed: await import('../../lib/watermark/embed'),
  };
  M.runMigrations();

  const now = new Date().toISOString();
  M.conn()
    .prepare(`INSERT INTO projects (user_id, name, type, status, created_at, is_active)
              VALUES (?, ?, 'image', 'unlocked', ?, 1)`)
    .run(USER, `wm-chain-${WITNESS_PROJECT}`, now);
  PROJECT_ID = (M.conn()
    .prepare(`SELECT id FROM projects WHERE user_id = ? AND name = ?`)
    .get(USER, `wm-chain-${WITNESS_PROJECT}`) as { id: number }).id;

  // Two image masters + one video master (the video proves the Phase-2
  // skip still skips and contributes no leaf).
  for (const seq of [1, 2]) {
    const bytes = makePng(seq);
    const hash = crypto.createHash('sha256').update(bytes).digest('hex');
    M.artifacts.storeArtifact(hash, bytes);
    WROTE.push(hash);

    // Witness the MASTER first, exactly as capture does, so the master
    // leaf is a real leaf and the derivative's prev_record_hash chains
    // off something real.
    const w = await M.witness.witness.witnessIteration({
      projectId: WITNESS_PROJECT,
      runSequence: seq,
      contentHash: hash,
    });
    assert.ok(w.leaf_hash, 'master must be witnessed');
    MASTER_LEAVES.push(w.leaf_hash!);

    M.conn()
      .prepare(`INSERT INTO iterations
                 (project_id, run_sequence, timestamp, leaf_hash, output_hash,
                  output_kind, output_content_type, witnessed, witness_id, leaf_scheme)
                VALUES (?, ?, ?, ?, ?, 'image', 'image/png', 1, ?, 'v2')`)
      .run(PROJECT_ID, seq, now, w.leaf_hash, hash, w.witness_id);
  }
  M.conn()
    .prepare(`INSERT INTO iterations
               (project_id, run_sequence, timestamp, leaf_hash, output_hash,
                output_kind, output_content_type, witnessed, leaf_scheme)
              VALUES (?, 3, ?, ?, ?, 'video', 'video/mp4', 0, 'v2')`)
    .run(PROJECT_ID, now, 'ff'.repeat(32), 'ee'.repeat(32));
  MASTER_LEAVES.push('ff'.repeat(32));
});

after(async () => {
  if (child) {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 200));
    if (!child.killed) child.kill('SIGKILL');
  }
  // Remove what this file put into the repo's content store.
  for (const h of WROTE) {
    try { fs.rmSync(M.artifacts.artifactPath(h), { force: true }); } catch { /* ignore */ }
  }
  try { fs.rmSync(OWN_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('WO-28 — the derivative enters the chain', () => {
  let result: Awaited<ReturnType<typeof import('../../lib/watermark/apply').watermarkProjectIterations>>;

  test('the watermarker runs BEFORE the seal and wins a leaf per image derivative', async () => {
    result = await M.apply.watermarkProjectIterations({
      projectId: PROJECT_ID,
      tier: 'local-lock',
      witnessProjectId: WITNESS_PROJECT,
    });

    assert.equal(result.errors.length, 0, `no embed errors: ${JSON.stringify(result.errors)}`);
    assert.equal(result.applied, 2, 'both image masters watermarked');
    assert.equal(
      result.unwitnessed.length, 0,
      `every derivative must be witnessed: ${JSON.stringify(result.unwitnessed)}`,
    );
    assert.equal(result.witnessed.length, 2, 'two derivative leaves');

    // The video master is skipped, and skipping it costs it no leaf.
    assert.ok(
      result.skipped.some((s) => s.runSequence === 3 && /Phase 2/.test(s.reason)),
      'video iteration is skipped as Phase 2',
    );

    for (const d of result.witnessed) {
      assert.equal(d.leafScheme, 'v2.5', 'derivative leaf must use the derivative scheme');
      assert.match(d.leafHash, /^[0-9a-f]{64}$/);
      assert.notEqual(d.leafHash, d.masterLeafHash, 'a derivative leaf is not its master leaf');
      assert.notEqual(d.derivativeHash, d.masterHash, 'derivative bytes are not master bytes');
    }
  });

  test('the master bytes are untouched — WATERMARK_DESIGN §4.3', () => {
    for (const d of result.witnessed) {
      const master = M.artifacts.readArtifact(d.masterHash);
      assert.ok(master, 'master still readable');
      assert.equal(
        crypto.createHash('sha256').update(master!).digest('hex'),
        d.masterHash,
        'master bytes still hash to the master hash',
      );
    }
  });

  test('migration 038’s column is finally written, with the rest of the preimage', () => {
    const rows = M.conn()
      .prepare(`SELECT run_sequence, leaf_hash, output_hash,
                       watermark_derivative_hash, watermark_payload_hex,
                       watermark_derivative_leaf_hash, watermark_derivative_witness_id,
                       watermark_derivative_run_sequence,
                       watermark_derivative_witness_timestamp,
                       watermark_derivative_prev_record_hash,
                       watermark_derivative_leaf_scheme
                  FROM iterations
                 WHERE project_id = ? AND output_kind = 'image'
                 ORDER BY run_sequence ASC`)
      .all(PROJECT_ID) as Array<Record<string, never>>;

    assert.equal(rows.length, 2);
    for (const row of rows) {
      const r = row as unknown as Parameters<typeof recomputeDerivativeLeaf>[0] & {
        run_sequence: number;
        watermark_derivative_leaf_hash: string;
        watermark_derivative_witness_id: string;
        watermark_derivative_leaf_scheme: string;
      };
      assert.ok(r.watermark_derivative_leaf_hash, 'the July column is no longer NULL');
      assert.ok(r.watermark_derivative_witness_id?.startsWith('wit_'));
      assert.equal(r.watermark_derivative_leaf_scheme, 'v2.5');

      // The synthetic sequence rule: max(run_sequence) + this run_sequence.
      assert.equal(
        r.watermark_derivative_run_sequence,
        3 + r.run_sequence,
        'derivative run_sequence is maxMasterSeq + masterSeq',
      );

      // (2) THE LEAF IS RECOMPUTABLE FROM THE ROW ALONE.
      assert.equal(
        recomputeDerivativeLeaf(r),
        r.watermark_derivative_leaf_hash,
        'a third party must be able to rebuild the derivative leaf from stored fields',
      );
    }
  });

  test('the payload the leaf commits to is the payload actually in the pixels', () => {
    // Not "we told the witness a payload" — the bytes carry it.
    for (const d of result.witnessed) {
      const bytes = M.artifacts.readArtifact(d.derivativeHash);
      assert.ok(bytes, 'derivative bytes stored');
      WROTE.push(d.derivativeHash);
      const decoded = M.embed.decodeImageWatermark(bytes!);
      assert.ok(decoded, 'the watermark is recoverable from the derivative');
      assert.equal(decoded!.tier, 3, 'tier 3 = local-lock');
      assert.equal(decoded!.version, 1);
      assert.equal(d.payloadHex.slice(0, 2), '5c', 'magic byte');
    }
  });

  test('the registry and the server agree on the v2.5 field order', async () => {
    // test/v2/leaf-registry.test.ts pins canonicalRecord and
    // canonicalRecordV22 against leaf schemes v2 and v2.2. It knows
    // nothing about v2.5, so the pin for the new scheme lives here.
    // Field ORDER is the protocol; a silent reorder would invalidate
    // every derivative leaf ever issued while every test still passed.
    const { LEAF_SCHEMES } = await import('../../lib/leaf/registry.generated');
    const declared = [...(LEAF_SCHEMES as Record<string, readonly string[]>)['v2.5']];
    const src = fs.readFileSync(SERVER_JS, 'utf8');
    const fn = src.slice(src.indexOf('function canonicalRecordV25(rec) {'));
    const body = fn.slice(fn.indexOf('{'), fn.indexOf('};'));
    const actual = [...body.matchAll(/^\s{4}([a-z_]+):/gm)].map((m) => m[1]);
    assert.deepEqual(actual, declared,
      'canonicalRecordV25 must emit exactly the registry’s v2.5 record_order');
  });

  test('the Merkle root commits to BOTH artifacts', () => {
    const masters = MASTER_LEAVES;
    const leaves = M.apply.lockLeafOrder(masters, result.witnessed);

    assert.equal(leaves.length, masters.length + 2);
    assert.deepEqual(leaves.slice(0, masters.length), masters,
      'masters keep their positions — leaf index still equals run_sequence − 1');

    const withBoth = M.merkle.buildMerkle(leaves).root;
    const mastersOnly = M.merkle.buildMerkle(masters).root;
    assert.ok(withBoth && mastersOnly);
    assert.notEqual(withBoth, mastersOnly, 'the derivative changes the root — it is committed');

    // Move one derivative bit and the root moves: the commitment is real,
    // not decorative.
    const tampered = [...leaves];
    tampered[tampered.length - 1] = 'ab'.repeat(32);
    assert.notEqual(M.merkle.buildMerkle(tampered).root, withBoth,
      'altering a derivative leaf must change the root');

    // REGRESSION GUARD: a project with no derivative gets the same root
    // it would have got before WO-28. This is why derivatives are
    // APPENDED rather than interleaved.
    assert.equal(
      M.merkle.buildMerkle(M.apply.lockLeafOrder(masters, [])).root,
      mastersOnly,
      'no derivative ⇒ byte-identical root to the pre-WO-28 behaviour',
    );
  });
});

describe('WO-28 — the vocabulary, ported from lib/witness/ingest.ts', () => {
  async function post(body: Record<string, unknown>) {
    const res = await fetch(`${BASE}/api/witness`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as { error?: string; detail?: string; leaf_scheme?: string } };
  }

  const base = () => ({
    project_id: `${WITNESS_PROJECT}-vocab`,
    run_sequence: Math.floor(Math.random() * 1e6) + 1000,
    content_hash: 'a'.repeat(64),
  });

  test('all-three-or-none: a master_hash without the rest is refused', async () => {
    const r = await post({ ...base(), master_hash: 'b'.repeat(64) });
    assert.equal(r.status, 400);
    assert.equal(r.json.error, 'invalid_watermark_payload');
  });

  test('all-three-or-none: a payload without the ingredient leaf is refused', async () => {
    const r = await post({ ...base(), master_hash: 'b'.repeat(64), watermark_payload_hex: '5c1' + '0'.repeat(29) });
    assert.equal(r.status, 400);
    assert.equal(r.json.error, 'invalid_ingredient_leaf_hash');
  });

  test('the magic byte is enforced', async () => {
    const r = await post({
      ...base(),
      master_hash: 'b'.repeat(64),
      watermark_payload_hex: '001' + '0'.repeat(29),
      ingredient_master_leaf_hash: 'c'.repeat(64),
    });
    assert.equal(r.status, 400);
    assert.match(String(r.json.error), /watermark_payload/);
  });

  test('an unsupported version nibble is refused', async () => {
    const r = await post({
      ...base(),
      master_hash: 'b'.repeat(64),
      watermark_payload_hex: '5c2' + '0'.repeat(29),
      ingredient_master_leaf_hash: 'c'.repeat(64),
    });
    assert.equal(r.status, 400);
    assert.equal(r.json.error, 'invalid_watermark_payload');
    assert.match(String(r.json.detail), /unsupported watermark version/);
  });

  test('a non-hex master_hash is refused', async () => {
    const r = await post({
      ...base(),
      master_hash: 'ZZ'.repeat(32),
      watermark_payload_hex: '5c1' + '0'.repeat(29),
      ingredient_master_leaf_hash: 'c'.repeat(64),
    });
    assert.equal(r.status, 400);
    assert.equal(r.json.error, 'invalid_master_hash');
  });

  test('a leaf with no watermark fields is still a plain v2 leaf', async () => {
    const r = await post(base());
    assert.equal(r.status, 200);
    assert.equal(r.json.leaf_scheme, 'v2', 'the new scheme must not leak onto ordinary leaves');
  });
});

describe('WO-28 — the 403 is intact, and that is why the order matters', () => {
  const LOCKED = `${WITNESS_PROJECT}-locked`;

  before(async () => {
    // Exactly what `finalize` does (server.js confirm-and-execute). We do
    // NOT call the stub's /api/lock, which would mint on RVN testnet.
    const Database = (await import('better-sqlite3')).default;
    const sdb = new Database(stubDbPath);
    sdb.prepare(
      `INSERT OR REPLACE INTO locked_projects
         (project_id, merkle_root, witnessed_count, server_signature, locked_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(LOCKED, 'de'.repeat(32), 1, 'sig', new Date().toISOString());
    sdb.close();
  });

  test('a locked project refuses an ordinary post-lock leaf', async () => {
    const res = await fetch(`${BASE}/api/witness`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: LOCKED, run_sequence: 99, content_hash: 'a'.repeat(64) }),
    });
    assert.equal(res.status, 403);
  });

  test('a locked project ALSO refuses a watermarked derivative — the guard was not widened', async () => {
    const res = await fetch(`${BASE}/api/witness`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project_id: LOCKED,
        run_sequence: 100,
        content_hash: 'a'.repeat(64),
        master_hash: 'b'.repeat(64),
        // WELL-FORMED on purpose: magic 0x5c, version 1, 32 hex. The
        // refusal must be the seal, not a validation accident.
        watermark_payload_hex: '5c1' + '0'.repeat(29),
        ingredient_master_leaf_hash: 'c'.repeat(64),
      }),
    });
    assert.equal(res.status, 403, 'a derivative is not an exception to the seal');
    const body = (await res.json()) as { error?: string };
    assert.match(String(body.error), /locked/i);
  });

  test('run the watermarker AFTER the seal and it wins no leaf — the July NULL, reproduced', async () => {
    // A second project whose witness id is already locked. This is the
    // pre-WO-28 order, executed deliberately.
    const now = new Date().toISOString();
    M.conn()
      .prepare(`INSERT INTO projects (user_id, name, type, status, created_at, is_active)
                VALUES (?, ?, 'image', 'unlocked', ?, 1)`)
      .run(USER, `wm-chain-late-${WITNESS_PROJECT}`, now);
    const pid = (M.conn()
      .prepare(`SELECT id FROM projects WHERE user_id = ? AND name = ?`)
      .get(USER, `wm-chain-late-${WITNESS_PROJECT}`) as { id: number }).id;

    const bytes = makePng(7);
    const hash = crypto.createHash('sha256').update(bytes).digest('hex');
    M.artifacts.storeArtifact(hash, bytes);
    WROTE.push(hash);
    M.conn()
      .prepare(`INSERT INTO iterations
                 (project_id, run_sequence, timestamp, leaf_hash, output_hash,
                  output_kind, output_content_type, witnessed, leaf_scheme)
                VALUES (?, 1, ?, ?, ?, 'image', 'image/png', 1, 'v2')`)
      .run(pid, now, 'dd'.repeat(32), hash);

    const late = await M.apply.watermarkProjectIterations({
      projectId: pid,
      tier: 'local-lock',
      witnessProjectId: LOCKED,
    });

    assert.equal(late.applied, 1, 'the derivative bytes are still produced');
    assert.equal(late.witnessed.length, 0, 'but it wins no leaf');
    assert.equal(late.unwitnessed.length, 1);
    assert.match(late.unwitnessed[0].reason, /403/, 'and the reason is recorded, not swallowed');

    const row = M.conn()
      .prepare(`SELECT watermark_derivative_hash, watermark_derivative_leaf_hash
                  FROM iterations WHERE project_id = ?`)
      .get(pid) as { watermark_derivative_hash: string | null; watermark_derivative_leaf_hash: string | null };
    assert.ok(row.watermark_derivative_hash, 'bytes recorded');
    if (row.watermark_derivative_hash) WROTE.push(row.watermark_derivative_hash);
    assert.equal(
      row.watermark_derivative_leaf_hash, null,
      'NULL is what "produced but not in the chain" looks like — this is the July state, on purpose',
    );
  });
});
