// E2E test for WO-09 — full pipeline:
//   1. Ingest 5 leaves via /api/v1/log
//   2. Tick the checkpoint scheduler (writes signed checkpoint)
//   3. Fetch proof bundle via /api/v1/proof/leaf/<stream>/<seq>
//   4. Run scruple-verify CLI on it → must exit 0 with VALID
//   5. Corrupt the proof (tamper the payload_hash), re-run → must exit 1
//
// Requires: dev server running with SCRUPLE_DB_PATH + SCRUPLE_WITNESS_KEY_DIR
// pointed at the same locations this script uses.

import Database from 'better-sqlite3';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { tickAll } from '../lib/witness/checkpointScheduler';

const BASE = process.env.SCRUPLE_TEST_URL ?? 'http://localhost:3001';
const DB_PATH = process.env.SCRUPLE_DB_PATH || path.join(process.cwd(), 'data', 'scruple.db');
const CLI_PATH = path.join(process.cwd(), 'packages', 'scruple-verify', 'src', 'cli.mjs');

function sha256Hex(s: string | Buffer): string {
  return createHash('sha256').update(s).digest('hex');
}

function signedHeaders(hmacSecret: string, apiKey: string, body: string): Record<string, string> {
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = createHmac('sha256', hmacSecret)
    .update(Buffer.concat([Buffer.from(`${ts}\n`), Buffer.from(body)]))
    .digest('hex');
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'X-Scruple-Timestamp': ts,
    'X-Scruple-Signature': sig,
  };
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
  console.log(`[verify-cli-e2e] BASE=${BASE} DB=${DB_PATH} CLI=${CLI_PATH}`);

  // ---- seed ----
  const db = new Database(DB_PATH);
  db.pragma('foreign_keys = ON');
  const tenantId = 'TEN_test_verify';
  const apiKey = `sk_test_${randomBytes(16).toString('hex')}`;
  const hmacSecret = randomBytes(32).toString('hex');
  db.prepare(
    `INSERT OR REPLACE INTO tenants (tenant_id, name, api_key_hash, hmac_secret_enc, is_internal, status)
     VALUES (?, 'verify-tenant', ?, ?, 0, 'active')`,
  ).run(tenantId, sha256Hex(apiKey), hmacSecret);
  const principalId = 'PRN_testvrfy';
  db.prepare(
    `INSERT OR REPLACE INTO principals (principal_id, name, read_key_hash) VALUES (?, 'verify-principal', ?)`,
  ).run(principalId, sha256Hex('unused'));
  db.prepare(
    `INSERT OR REPLACE INTO delegations (delegation_id, principal_id, tenant_id, status)
     VALUES (?, ?, ?, 'active')`,
  ).run('DLG_testvrfy', principalId, tenantId);

  // ---- stream ----
  const streamBody = JSON.stringify({
    name: 'verify.test',
    checkpoint_secs: 60,
    principal_mode: 'per_leaf',
  });
  const streamResp = await fetch(BASE + '/api/v1/streams', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: streamBody,
  });
  const streamJson = (await streamResp.json()) as { stream?: { stream_id?: string } };
  const streamId = streamJson.stream?.stream_id ?? '';
  assert(streamId.startsWith('STR_'), 'stream created', streamJson);

  // ---- ingest 5 leaves ----
  for (let i = 1; i <= 5; i++) {
    const body = JSON.stringify({
      tenant_seq: i,
      idempotency_key: `verify-${i}`,
      principal_id: principalId,
      event_time: new Date().toISOString(),
      payload_hash: 'sha256:' + i.toString().padStart(64, '0'),
    });
    await fetch(BASE + '/api/v1/log/verify.test', {
      method: 'POST',
      headers: signedHeaders(hmacSecret, apiKey, body),
      body,
    });
  }

  // ---- tick ----
  tickAll();

  // ---- fetch proof for leaf 3 ----
  const proofResp = await fetch(BASE + '/api/v1/proof/leaf/verify.test/3');
  assert(proofResp.status === 200, 'proof endpoint returns 200');
  const proof = await proofResp.json();
  assert(!!proof.inclusion && !!proof.checkpoint, 'proof has inclusion + checkpoint sections');

  // ---- run CLI in VALID mode ----
  const proofPath = '/tmp/scruple-verify-test-proof.json';
  writeFileSync(proofPath, JSON.stringify(proof));

  const validRun = spawnSync('node', [
    CLI_PATH, 'leaf',
    '--proof', proofPath,
    '--trust-manifest', `${BASE}/.well-known/witness-trust.json`,
    '--quiet',
  ], { encoding: 'utf-8' });
  console.log(`  CLI stdout: ${validRun.stdout.trim()}`);
  if (validRun.stderr.trim()) console.log(`  CLI stderr: ${validRun.stderr.trim()}`);
  assert(validRun.status === 0, 'scruple-verify exits 0 on valid proof');
  assert(validRun.stdout.trim() === 'PASS', 'CLI prints PASS');

  // ---- tamper the proof ----
  const tampered = JSON.parse(JSON.stringify(proof));
  tampered.leaf.payload_hash = 'sha256:' + 'f'.repeat(64);
  const tamperedPath = '/tmp/scruple-verify-test-proof-tampered.json';
  writeFileSync(tamperedPath, JSON.stringify(tampered));

  const badRun = spawnSync('node', [
    CLI_PATH, 'leaf',
    '--proof', tamperedPath,
    '--trust-manifest', `${BASE}/.well-known/witness-trust.json`,
    '--quiet',
  ], { encoding: 'utf-8' });
  console.log(`  CLI stdout (tampered): ${badRun.stdout.trim()}`);
  assert(badRun.status !== 0, 'scruple-verify exits non-zero on tampered proof');
  assert(badRun.stdout.trim() === 'FAIL', 'CLI prints FAIL');

  // ---- fetch via URL flag (end-to-end without file) ----
  const urlRun = spawnSync('node', [
    CLI_PATH, 'leaf',
    '--witness', BASE,
    '--stream', 'verify.test',
    '--seq', '3',
    '--quiet',
  ], { encoding: 'utf-8' });
  console.log(`  CLI stdout (URL mode): ${urlRun.stdout.trim()}`);
  if (urlRun.stderr.trim()) console.log(`  CLI stderr: ${urlRun.stderr.trim()}`);
  assert(urlRun.status === 0, 'CLI exits 0 with --witness/--stream/--seq mode');

  // ---- JSON output ----
  const jsonRun = spawnSync('node', [
    CLI_PATH, 'leaf',
    '--proof', proofPath,
    '--trust-manifest', `${BASE}/.well-known/witness-trust.json`,
    '--json',
  ], { encoding: 'utf-8' });
  assert(jsonRun.status === 0, 'CLI --json exits 0 on valid');
  const jsonOut = JSON.parse(jsonRun.stdout);
  assert(jsonOut.verdict === 'VALID', 'JSON verdict = VALID');
  assert(Array.isArray(jsonOut.steps) && jsonOut.steps.every((s: { ok: boolean }) => s.ok), 'all JSON steps ok');

  console.log(`\n=== ${failures === 0 ? 'PASS' : 'FAIL'} — ${failures} failure(s)`);
  return failures === 0 ? 0 : 1;
}

main().then((c) => process.exit(c));
