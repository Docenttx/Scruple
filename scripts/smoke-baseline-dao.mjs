// scripts/smoke-baseline-dao.mjs
//
// DAO-level smoke for WO-02. Applies migration 032 to a scratch DB and
// exercises insertGenesis / insertRebaseline / getCurrent / getHistory /
// verifyMatchesCurrent across the acceptance-criteria branches.
//
// Run: SCRUPLE_DB_PATH=/tmp/wo02-dao-smoke.db node scripts/smoke-baseline-dao.mjs

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const DB_PATH = process.env.SCRUPLE_DB_PATH || '/tmp/wo02-dao-smoke.db';
if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
process.env.SCRUPLE_DB_PATH = DB_PATH;

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(fs.readFileSync(path.join(__dirname, '..', 'lib', 'db', 'migrations', '032_baselines.sql'), 'utf8'));
db.close();

// Load DAO after env var is set so it uses our scratch DB
// Use tsx (transpiling) since the DAO is TypeScript
const tsx = require.resolve('tsx/cli');
const { spawnSync } = await import('node:child_process');

const worker = `
import {
  insertGenesis,
  insertRebaseline,
  getCurrent,
  getHistory,
  verifyMatchesCurrent,
  BaselineConflictError,
} from '${pathToFileURL(path.join(__dirname, '..', 'lib', 'baseline', 'dao.ts')).href}';

let failures = 0;
function assert(cond, name, detail) {
  if (cond) console.log('  ok  —', name);
  else { console.error('  FAIL —', name); if (detail) console.error('         ', detail); failures++; }
}
function assertThrows(fn, expectedCode, name) {
  try { fn(); console.error('  FAIL —', name, '(did not throw)'); failures++; return null; }
  catch (e) {
    if (e && e.name === 'BaselineConflictError' && e.code === expectedCode) {
      console.log('  ok  —', name);
      return e;
    }
    console.error('  FAIL —', name, '(wrong error:', e?.code, e?.message, ')');
    failures++;
    return null;
  }
}

const T = 'TEN_test';
const H1 = 'a'.repeat(64);
const H2 = 'b'.repeat(64);
const H3 = 'c'.repeat(64);
const PK = 'd'.repeat(64);

console.log('[1] genesis insert');
const g1 = insertGenesis({
  tenant_id: T, baseline_hash: H1,
  manifest_json: '{"integration_id":"x"}',
  attestation_provider: 'none',
  attestation_envelope_json: null,
  signer_pubkey_spki_sha256_hex: PK,
  submitted_at: '2026-07-13T00:00:00Z',
});
assert(g1.baseline_id > 0, 'genesis inserted with id > 0');

console.log('[2] second genesis rejects with active_baseline_exists');
assertThrows(
  () => insertGenesis({
    tenant_id: T, baseline_hash: H2,
    manifest_json: '{}', attestation_provider: 'none',
    attestation_envelope_json: null, signer_pubkey_spki_sha256_hex: PK,
    submitted_at: '2026-07-13T00:01:00Z',
  }),
  'active_baseline_exists',
  'second genesis rejected',
);

console.log('[3] rebaseline with wrong prev rejects with prev_hash_mismatch');
assertThrows(
  () => insertRebaseline({
    tenant_id: T, baseline_hash: H2,
    prev_baseline_hash: H3,  // wrong
    manifest_json: '{}', attestation_provider: 'none',
    attestation_envelope_json: null, signer_pubkey_spki_sha256_hex: PK,
    reason: 'test', submitted_at: '2026-07-13T00:02:00Z',
  }),
  'prev_hash_mismatch',
  'rebaseline with wrong prev rejected',
);

console.log('[4] rebaseline with right prev succeeds; retires H1');
const r2 = insertRebaseline({
  tenant_id: T, baseline_hash: H2,
  prev_baseline_hash: H1,
  manifest_json: '{}', attestation_provider: 'none',
  attestation_envelope_json: null, signer_pubkey_spki_sha256_hex: PK,
  reason: 'code change', submitted_at: '2026-07-13T00:03:00Z',
});
assert(r2.baseline_id > g1.baseline_id, 'rebaseline id > genesis id');

console.log('[5] getCurrent returns H2');
const cur = getCurrent(T);
assert(cur !== null && cur.baseline_hash === H2, 'current is H2');
assert(cur.prev_baseline_hash === H1, 'prev of current is H1');

console.log('[6] getHistory returns [H2, H1]');
const hist = getHistory(T);
assert(hist.length === 2, 'history has 2 rows');
assert(hist[0].baseline_hash === H2 && hist[1].baseline_hash === H1, 'history ordered most-recent first');
assert(hist[1].retired_at !== null, 'H1 retired_at populated');
assert(hist[0].retired_at === null, 'H2 not retired');

console.log('[7] rebaseline with no baseline errors — new tenant');
assertThrows(
  () => insertRebaseline({
    tenant_id: 'TEN_empty', baseline_hash: H1,
    prev_baseline_hash: H1,
    manifest_json: '{}', attestation_provider: 'none',
    attestation_envelope_json: null, signer_pubkey_spki_sha256_hex: PK,
    reason: 'oops', submitted_at: '2026-07-13T00:04:00Z',
  }),
  'no_baseline',
  'rebaseline on empty tenant rejected',
);

console.log('[8] verifyMatchesCurrent');
const v1 = verifyMatchesCurrent(T, H2);
assert(v1.matches_current === true, 'H2 matches current');
const v2 = verifyMatchesCurrent(T, H1);
assert(v2.matches_current === false, 'H1 does not match current');
assert(v2.current_baseline_hash === H2, 'reports current');

console.log('[9] duplicate hash across tenants — allowed? checking behavior');
// Different tenant, same hash — should conflict due to UNIQUE on baseline_hash
assertThrows(
  () => insertGenesis({
    tenant_id: 'TEN_other', baseline_hash: H1,
    manifest_json: '{}', attestation_provider: 'none',
    attestation_envelope_json: null, signer_pubkey_spki_sha256_hex: PK,
    submitted_at: '2026-07-13T00:05:00Z',
  }),
  'duplicate_hash',
  'duplicate baseline_hash rejected across tenants',
);

console.log('');
console.log(failures === 0 ? 'PASS — 0 failures' : 'FAIL — ' + failures + ' failure(s)');
process.exit(failures === 0 ? 0 : 1);
`;

const workerPath = '/tmp/wo02-dao-worker.mjs';
fs.writeFileSync(workerPath, worker);

const res = spawnSync('node', [tsx, workerPath], {
  stdio: 'inherit',
  env: { ...process.env, SCRUPLE_DB_PATH: DB_PATH },
});

fs.unlinkSync(workerPath);
if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
if (fs.existsSync(DB_PATH + '-shm')) fs.unlinkSync(DB_PATH + '-shm');
if (fs.existsSync(DB_PATH + '-wal')) fs.unlinkSync(DB_PATH + '-wal');

process.exit(res.status ?? 1);
