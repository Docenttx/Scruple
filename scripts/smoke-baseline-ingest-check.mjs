// scripts/smoke-baseline-ingest-check.mjs
//
// Smoke for WO-03 lib/baseline/ingest_check.ts. Exercises:
//  1. Tenant with no baseline → passes both checks (skip)
//  2. Tenant with baseline (provider=none) → passes header check, skips attestation
//  3. Tenant with baseline (provider=none), wrong header → 409 baseline_mismatch
//  4. Tenant with baseline (provider=amd-sev-snp), missing envelope → 400
//  5. Same, wrong nonce → 400 attestation_nonce_mismatch
//  6. Same, stale attestation_time → 400 attestation_stale
//  7. Same, valid envelope → passes

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const tsx = require.resolve('tsx/cli');

const DB_PATH = '/tmp/wo03-ingest-smoke.db';
for (const p of [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm']) if (fs.existsSync(p)) fs.unlinkSync(p);
process.env.SCRUPLE_DB_PATH = DB_PATH;

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Apply relevant migrations: 030 (tenants + log_leaves), 032 (baselines), 033 (extensions)
const migrationsDir = path.join(__dirname, '..', 'lib', 'db', 'migrations');
db.exec(fs.readFileSync(path.join(migrationsDir, '030_scruple_log.sql'), 'utf8'));
db.exec(fs.readFileSync(path.join(migrationsDir, '032_baselines.sql'), 'utf8'));
db.exec(fs.readFileSync(path.join(migrationsDir, '033_leaf_baseline_ref.sql'), 'utf8'));

// Seed two tenants
db.prepare(
  `INSERT INTO tenants (tenant_id, name, api_key_hash, hmac_secret_enc, status, is_internal)
   VALUES (?, ?, ?, ?, 'active', 0)`,
).run('TEN_a', 'A', 'hash_a', 'sec_a');
db.prepare(
  `INSERT INTO tenants (tenant_id, name, api_key_hash, hmac_secret_enc, status, is_internal)
   VALUES (?, ?, ?, ?, 'active', 0)`,
).run('TEN_b', 'B', 'hash_b', 'sec_b');
// TEN_a has NO baseline (empty)
// TEN_b will get a baseline with provider=amd-sev-snp
const H_NONE = 'a'.repeat(64);
const H_SEV = 'b'.repeat(64);
const nowIso = new Date().toISOString();
db.prepare(
  `INSERT INTO baselines (tenant_id, baseline_hash, prev_baseline_hash, manifest_json,
     attestation_provider, attestation_envelope_json, signer_pubkey_spki_sha256_hex,
     submitted_at, activated_at)
   VALUES (?, ?, NULL, '{}', ?, NULL, ?, ?, ?)`,
).run('TEN_b', H_SEV, 'amd-sev-snp', 'c'.repeat(64), nowIso, nowIso);
const baselineId = db.prepare(`SELECT last_insert_rowid() AS id`).get().id;
db.prepare(
  `INSERT INTO tenant_current_baseline (tenant_id, baseline_id, updated_at) VALUES (?, ?, ?)`,
).run('TEN_b', baselineId, nowIso);
// Add a "TEN_c" with provider=none
db.prepare(
  `INSERT INTO tenants (tenant_id, name, api_key_hash, hmac_secret_enc, status, is_internal)
   VALUES (?, ?, ?, ?, 'active', 0)`,
).run('TEN_c', 'C', 'hash_c', 'sec_c');
const H_C = 'e'.repeat(64);
db.prepare(
  `INSERT INTO baselines (tenant_id, baseline_hash, prev_baseline_hash, manifest_json,
     attestation_provider, attestation_envelope_json, signer_pubkey_spki_sha256_hex,
     submitted_at, activated_at)
   VALUES (?, ?, NULL, '{}', 'none', NULL, ?, ?, ?)`,
).run('TEN_c', H_C, 'f'.repeat(64), nowIso, nowIso);
const bIdC = db.prepare(`SELECT last_insert_rowid() AS id`).get().id;
db.prepare(
  `INSERT INTO tenant_current_baseline (tenant_id, baseline_id, updated_at) VALUES (?, ?, ?)`,
).run('TEN_c', bIdC, nowIso);

db.close();

// Compute expected nonce for a sample preimage
function canon(o) {
  if (o === null || o === undefined) return 'null';
  if (Array.isArray(o)) return '[' + o.map(canon).join(',') + ']';
  if (typeof o === 'object') {
    const keys = Object.keys(o).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canon(o[k])).join(',') + '}';
  }
  return JSON.stringify(o);
}
const preimage = { field_a: 1, field_b: 'x' };
const expectedNonce = createHash('sha256').update(canon(preimage)).digest('hex');
const bogusNonce = 'a'.repeat(64);

const worker = `
import { enforceBaselineRef, enforceAttestation } from '${pathToFileURL(path.join(__dirname, '..', 'lib', 'baseline', 'ingest_check.ts')).href}';

let failures = 0;
function assert(cond, name, detail) {
  if (cond) console.log('  ok  —', name);
  else { console.error('  FAIL —', name); if (detail) console.error('         ', JSON.stringify(detail)); failures++; }
}

const H_NONE  = '${'a'.repeat(64)}';
const H_SEV   = '${H_SEV}';
const H_C     = '${H_C}';
const expected = '${expectedNonce}';
const bogus    = '${bogusNonce}';
const validEnv = {
  attestation_type: 'amd-sev-snp',
  attestation_report: 'aGVsbG8=',
  certificate_chain: ['-----BEGIN CERTIFICATE-----\\nfake\\n-----END CERTIFICATE-----\\n'],
  nonce: expected,
  attestation_time: new Date().toISOString(),
};
const staleEnv = { ...validEnv, attestation_time: new Date(Date.now() - 24*60*60*1000).toISOString() };
const wrongNonceEnv = { ...validEnv, nonce: bogus };

console.log('[1] tenant with no baseline — skips both checks');
const r1 = enforceBaselineRef('TEN_a', null);
assert(r1.ok && r1.baseline === null, 'baseline check pass, no baseline row', r1);
const r1a = enforceAttestation('TEN_a', null, null, expected);
assert(r1a.ok, 'attestation check skipped when no baseline', r1a);

console.log('[2] provider=none tenant — passes with matching baseline');
const r2 = enforceBaselineRef('TEN_c', H_C);
assert(r2.ok && r2.baseline && r2.baseline.attestation_provider === 'none', 'baseline matched', r2);
const r2a = enforceAttestation('TEN_c', r2.baseline ?? null, null, expected);
assert(r2a.ok, 'attestation skipped for provider=none', r2a);

console.log('[3] provider=none tenant — wrong baseline_hash → 409');
const r3 = enforceBaselineRef('TEN_c', bogus);
assert(!r3.ok && r3.status === 409 && r3.body.code === 'baseline_mismatch', 'wrong header → 409', r3);

console.log('[4] provider=amd-sev-snp — missing envelope → 400');
const r4b = enforceBaselineRef('TEN_b', H_SEV);
assert(r4b.ok, 'baseline OK', r4b);
const r4 = enforceAttestation('TEN_b', r4b.baseline ?? null, null, expected);
assert(!r4.ok && r4.status === 400 && r4.body.code === 'attestation_required', 'missing envelope → 400', r4);

console.log('[5] wrong nonce → 400 attestation_nonce_mismatch');
const r5 = enforceAttestation('TEN_b', r4b.baseline ?? null, wrongNonceEnv, expected);
assert(!r5.ok && r5.status === 400 && r5.body.code === 'attestation_nonce_mismatch', 'wrong nonce → 400', r5);

console.log('[6] stale attestation_time → 400 attestation_stale');
const r6 = enforceAttestation('TEN_b', r4b.baseline ?? null, staleEnv, expected);
assert(!r6.ok && r6.status === 400 && r6.body.code === 'attestation_stale', 'stale → 400', r6);

console.log('[7] valid envelope → passes');
const r7 = enforceAttestation('TEN_b', r4b.baseline ?? null, validEnv, expected);
assert(r7.ok, 'valid → ok', r7);

console.log('[8] missing baseline header on non-empty tenant → 409');
const r8 = enforceBaselineRef('TEN_b', null);
assert(!r8.ok && r8.status === 409 && r8.body.code === 'baseline_required', 'missing header → 409', r8);

console.log('[9] type mismatch — declared amd-sev-snp, submitted nvidia-h100-cc');
const r9 = enforceAttestation('TEN_b', r4b.baseline ?? null,
  { ...validEnv, attestation_type: 'nvidia-h100-cc' }, expected);
assert(!r9.ok && r9.body.code === 'attestation_type_mismatch', 'type mismatch caught', r9);

console.log('');
console.log(failures === 0 ? 'PASS — 0 failures' : 'FAIL — ' + failures + ' failure(s)');
process.exit(failures === 0 ? 0 : 1);
`;

const workerPath = '/tmp/wo03-ingest-worker.mjs';
fs.writeFileSync(workerPath, worker);
const res = spawnSync('node', [tsx, workerPath], {
  stdio: 'inherit',
  env: { ...process.env, SCRUPLE_DB_PATH: DB_PATH },
});
fs.unlinkSync(workerPath);
for (const p of [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm']) if (fs.existsSync(p)) fs.unlinkSync(p);
process.exit(res.status ?? 1);
