// E2E test for WO-08 + WO-10 — full sign → witness → verify pipeline.
//
// Steps:
//   1. Seed a user + user's API key + a project.
//   2. Seed the reserved scruple.c2pa.sign stream (idempotent via
//      scripts/seed-c2pa-stream.mjs).
//   3. POST /api/scruple/c2pa/sign for a test image.
//   4. Assert response contains witness{leaf_hash, tenant_seq, ...}
//      AND principal was minted (users.principal_id populated).
//   5. Tick the checkpoint scheduler.
//   6. Fetch /api/v1/proof/leaf/scruple.c2pa.sign/<seq>.
//   7. Run scruple-verify CLI on the proof → VALID.
//
// Prereqs: dedicated dev server on SCRUPLE_TEST_URL pointing at
// SCRUPLE_DB_PATH; SCRUPLE_WITNESS_KEY_DIR set.

import Database from 'better-sqlite3';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { tickAll } from '../lib/witness/checkpointScheduler';

const BASE = process.env.SCRUPLE_TEST_URL ?? 'http://localhost:3005';
const DB_PATH = process.env.SCRUPLE_DB_PATH || path.join(process.cwd(), 'data', 'scruple.db');
const CLI_PATH = path.join(process.cwd(), 'packages', 'scruple-verify', 'src', 'cli.mjs');
const SOURCE_ASSET = process.env.SCRUPLE_TEST_ASSET
  || path.join(process.cwd(), 'public', 'scruple_wordmark_crimson.png');

function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

let failures = 0;
function assert(cond: unknown, name: string, detail?: unknown): void {
  if (cond) {
    console.log(`  ok — ${name}`);
  } else {
    console.error(`  FAIL — ${name}`);
    if (detail !== undefined) console.error(`         detail:`, detail);
    failures++;
  }
}

async function main(): Promise<number> {
  console.log(`[c2pa-sign-witness-e2e] BASE=${BASE} DB=${DB_PATH}`);
  console.log(`  source asset: ${SOURCE_ASSET}`);

  const db = new Database(DB_PATH);
  db.pragma('foreign_keys = ON');

  // ---- seed user + api key + project ----
  const userId = 'usr_c2pa_test';
  db.prepare(
    `INSERT OR REPLACE INTO users (id, name, email, email_verified, provider_keys, plan)
     VALUES (?, 'C2PA Test User', 'c2pa+test@example.com', datetime('now'), '{}', 'free')`,
  ).run(userId);

  const apiKey = `sk_test_${randomBytes(16).toString('hex')}`;
  const apiKeyId = 'ak_c2pa_test';
  db.prepare(
    `INSERT OR REPLACE INTO api_keys (id, user_id, key_hash, key_prefix, label)
     VALUES (?, ?, ?, ?, 'c2pa-e2e-test')`,
  ).run(apiKeyId, userId, sha256Hex(apiKey), apiKey.slice(0, 12));

  // Ensure a clean project row — the (user_id, name) unique constraint
  // trips on rerun otherwise. Delete any pre-existing test project first,
  // along with dependent rows (iterations / etc — none in this test).
  db.prepare(`DELETE FROM projects WHERE user_id = ? AND name = ?`).run(
    userId, 'c2pa-witness-test',
  );
  const projectRow = db
    .prepare(
      `INSERT INTO projects (user_id, name, type, created_at)
       VALUES (?, 'c2pa-witness-test', 'image', datetime('now'))
       RETURNING id`,
    )
    .get(userId) as { id: number };
  const projectId = projectRow.id;
  console.log(`  user=${userId} apiKey=${apiKey.slice(0, 20)}... project=${projectId}`);

  // ---- ensure the reserved scruple.c2pa.sign stream is seeded ----
  const seedResult = spawnSync('node', [
    path.join(process.cwd(), 'scripts', 'seed-c2pa-stream.mjs'),
  ], { encoding: 'utf-8', env: { ...process.env, SCRUPLE_DB_PATH: DB_PATH } });
  assert(seedResult.status === 0, 'seed-c2pa-stream.mjs succeeds', seedResult.stderr);
  console.log(`  ${seedResult.stdout.trim()}`);

  // ---- POST /api/scruple/c2pa/sign ----
  console.log('\n[1] POST /api/scruple/c2pa/sign — bare tier');
  const signResp = await fetch(BASE + '/api/scruple/c2pa/sign', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      project_id: projectId,
      asset_path: SOURCE_ASSET,
      product: 'studio',
      tier: 'bare',
    }),
  });
  const signJson = (await signResp.json()) as {
    ok?: boolean; signed_path?: string; witness?: {
      stream_id: string; tenant_seq: number; leaf_hash: string;
      chain_hash: string; principal_id: string;
    };
    witness_error?: string;
    signing_mode?: string; signer_identity?: string;
  };
  assert(signResp.status === 200, 'sign returns 200', signJson);
  assert(signJson.ok === true, 'sign result ok=true', signJson);
  assert(!!signJson.signed_path, 'signed_path present');
  assert(signJson.signing_mode === 'local', 'signing_mode = local (default)');
  assert(!!signJson.signer_identity?.startsWith('local:'), 'signer_identity local:*');
  assert(!signJson.witness_error, 'no witness_error', signJson.witness_error);
  assert(!!signJson.witness, 'witness block present');
  const w = signJson.witness!;
  assert(w.tenant_seq > 0, 'witness.tenant_seq > 0');
  assert(w.leaf_hash?.startsWith('sha256:'), 'witness.leaf_hash sha256: prefix');
  assert(w.principal_id?.startsWith('PRN_'), 'witness.principal_id PRN_ prefix');

  // ---- principal was minted for the user ----
  const userRow = db
    .prepare(`SELECT principal_id FROM users WHERE id = ?`)
    .get(userId) as { principal_id: string | null };
  assert(userRow.principal_id === w.principal_id, 'users.principal_id populated + matches witness');
  const delRow = db
    .prepare(
      `SELECT status FROM delegations WHERE principal_id = ? AND tenant_id = 'TEN_scruple'`,
    )
    .get(w.principal_id) as { status: string } | undefined;
  assert(delRow?.status === 'active', 'active delegation created');

  // ---- leaf lands in log_leaves ----
  const leafRow = db
    .prepare(
      `SELECT tenant_seq, leaf_hash, principal_id, meta_json
         FROM log_leaves WHERE stream_id = ? AND tenant_seq = ?`,
    )
    .get(w.stream_id, w.tenant_seq) as {
    tenant_seq: number; leaf_hash: string; principal_id: string; meta_json: string;
  } | undefined;
  assert(!!leafRow, 'leaf row exists in log_leaves');
  assert(leafRow?.leaf_hash === w.leaf_hash.replace(/^sha256:/, ''), 'leaf_hash bytes match');
  assert(leafRow?.principal_id === w.principal_id, 'principal_id on leaf matches');
  const meta = leafRow?.meta_json ? JSON.parse(leafRow.meta_json) : {};
  assert(meta.status === 'signed', 'meta.status = signed');
  assert(meta.product === 'studio', 'meta.product = studio');

  // ---- second sign is idempotent-safe (different asset → different tenant_seq) ----
  console.log('\n[2] second sign to check the chain advances');
  const secondSign = await fetch(BASE + '/api/scruple/c2pa/sign', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      project_id: projectId,
      asset_path: SOURCE_ASSET,   // same asset, but different sign event
      product: 'studio',
      tier: 'bare',
    }),
  });
  const secondJson = (await secondSign.json()) as {
    witness?: { tenant_seq: number }; witness_error?: string; signed_path?: string;
  };
  console.log('  second sign:', JSON.stringify({
    signed_path: secondJson.signed_path,
    witness: secondJson.witness,
    witness_error: secondJson.witness_error,
  }));
  assert(secondJson.witness?.tenant_seq === w.tenant_seq + 1, 'second sign chain advances by 1');

  // ---- tick checkpoint ----
  console.log('\n[3] tick checkpoint scheduler');
  const tickResults = tickAll();
  const ours = tickResults.find((t) => t.stream_id === w.stream_id);
  assert(ours?.action === 'wrote_checkpoint', 'checkpoint written for scruple.c2pa.sign', ours);
  assert((ours?.first_seq ?? 0) === w.tenant_seq, 'checkpoint covers our leaves');

  // ---- fetch proof ----
  console.log('\n[4] fetch proof + verify with scruple-verify CLI');
  const proofResp = await fetch(
    BASE + `/api/v1/proof/leaf/scruple.c2pa.sign/${w.tenant_seq}`,
  );
  assert(proofResp.status === 200, 'proof endpoint returns 200');
  const proof = await proofResp.json();
  const proofPath = '/tmp/scruple-c2pa-witness-proof.json';
  writeFileSync(proofPath, JSON.stringify(proof));

  const verifyRun = spawnSync('node', [
    CLI_PATH, 'leaf',
    '--proof', proofPath,
    '--trust-manifest', `${BASE}/.well-known/witness-trust.json`,
    '--quiet',
  ], { encoding: 'utf-8' });
  console.log(`  CLI: ${verifyRun.stdout.trim()}`);
  if (verifyRun.stderr.trim()) console.log(`  CLI stderr: ${verifyRun.stderr.trim()}`);
  assert(verifyRun.status === 0, 'scruple-verify exits 0 on C2PA sign leaf');
  assert(verifyRun.stdout.trim() === 'PASS', 'CLI prints PASS');

  console.log(`\n=== ${failures === 0 ? 'PASS' : 'FAIL'} — ${failures} failure(s)`);
  return failures === 0 ? 0 : 1;
}

main().then((c) => process.exit(c));
