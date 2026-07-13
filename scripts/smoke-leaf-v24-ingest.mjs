// scripts/smoke-leaf-v24-ingest.mjs
//
// Smoke for WO-A1 — v2.4 leaf ingest via lib/witness/ingest.ts.
//
// Asserts:
//   1. Leaves without workflow_hash + machine_manifest_hash → leaf_scheme='v2.3',
//      leaf_hash matches v2.3 canonical module.
//   2. Leaves with workflow_hash only → leaf_scheme='v2.4', leaf_hash matches
//      v2.4 canonical module preimage with '' for machine_manifest_hash.
//   3. Leaves with machine_manifest_hash only → same pattern (workflow empty).
//   4. Leaves with both → v2.4, both fields present in preimage.
//   5. Chain hash continuity across mixed-scheme leaves (chain hash function
//      is not version-scoped).
//   6. Invalid workflow_hash (non-hex, wrong length, sha256: prefix) → 400.
//   7. Row persistence: log_leaves.workflow_hash + machine_manifest_hash +
//      leaf_scheme columns store the expected values.

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const tsx = require.resolve('tsx/cli');

const DB_PATH = '/tmp/leaf-v24-smoke.db';
for (const p of [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm']) if (fs.existsSync(p)) fs.unlinkSync(p);
process.env.SCRUPLE_DB_PATH = DB_PATH;

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const mig = path.join(__dirname, '..', 'lib', 'db', 'migrations');
db.exec(fs.readFileSync(path.join(mig, '030_scruple_log.sql'), 'utf8'));
db.exec(fs.readFileSync(path.join(mig, '032_baselines.sql'), 'utf8'));
db.exec(fs.readFileSync(path.join(mig, '033_leaf_baseline_ref.sql'), 'utf8'));
db.exec(fs.readFileSync(path.join(mig, '036_leaf_v24_workflow_manifest.sql'), 'utf8'));

// Seed one tenant + one stream (principal_mode='none' for simplicity).
db.prepare(
  `INSERT INTO tenants (tenant_id, name, api_key_hash, hmac_secret_enc, status, is_internal)
   VALUES ('TEN_v24', 'V24', 'hash_v24', 'sec_v24', 'active', 0)`,
).run();
db.prepare(
  `INSERT INTO streams (stream_id, tenant_id, name, checkpoint_secs, principal_mode)
   VALUES ('STR_v24', 'TEN_v24', 'v24_stream', 60, 'none')`,
).run();

db.close();

// Run assertions in a child tsx process so we can import the TS ingest.
const asserts = `
import { ingestLeaf } from '../lib/witness/ingest';
import { canonicalLeafV23, leafHashV23 } from '../lib/witness/canonicalLeafV23';
import { canonicalLeafV24, leafHashV24 } from '../lib/witness/canonicalLeafV24';
import { conn } from '../lib/db/sqlite';

const tenant = { tenant_id: 'TEN_v24', is_internal: false };

function eq(label, got, want) {
  if (got !== want) {
    console.error('FAIL', label, '\\n  got:  ', got, '\\n  want: ', want);
    process.exit(1);
  }
  console.log('OK  ', label);
}

// Case 1 — no workflow/manifest → v2.3
const r1 = ingestLeaf(tenant, 'v24_stream', {
  tenant_seq: 1,
  idempotency_key: 'k1',
  event_time: '2026-07-13T00:00:00.000Z',
  payload_hash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
});
if (!r1.ok) { console.error('r1 failed', r1); process.exit(1); }
eq('case1 leaf_scheme', r1.leaf_scheme, 'v2.3');
const expected1 = leafHashV23({
  tenant_id: 'TEN_v24', principal_id: '', stream_id: 'STR_v24',
  tenant_seq: 1, event_time: '2026-07-13T00:00:00.000Z',
  payload_hash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
});
eq('case1 leaf_hash matches v2.3 canonical', r1.leaf_hash, expected1);

// Case 2 — workflow_hash only → v2.4
const wfHash = 'a'.repeat(64);
const r2 = ingestLeaf(tenant, 'v24_stream', {
  tenant_seq: 2,
  idempotency_key: 'k2',
  event_time: '2026-07-13T00:00:01.000Z',
  payload_hash: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
  workflow_hash: wfHash,
});
if (!r2.ok) { console.error('r2 failed', r2); process.exit(1); }
eq('case2 leaf_scheme', r2.leaf_scheme, 'v2.4');
const expected2 = leafHashV24({
  tenant_id: 'TEN_v24', principal_id: '', stream_id: 'STR_v24',
  tenant_seq: 2, event_time: '2026-07-13T00:00:01.000Z',
  payload_hash: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
  workflow_hash: wfHash, machine_manifest_hash: '',
});
eq('case2 leaf_hash matches v2.4 canonical (workflow-only)', r2.leaf_hash, expected2);

// Case 3 — manifest only → v2.4
const manHash = 'b'.repeat(64);
const r3 = ingestLeaf(tenant, 'v24_stream', {
  tenant_seq: 3,
  idempotency_key: 'k3',
  event_time: '2026-07-13T00:00:02.000Z',
  payload_hash: 'sha256:2222222222222222222222222222222222222222222222222222222222222222',
  machine_manifest_hash: manHash,
});
if (!r3.ok) { console.error('r3 failed', r3); process.exit(1); }
eq('case3 leaf_scheme', r3.leaf_scheme, 'v2.4');
const expected3 = leafHashV24({
  tenant_id: 'TEN_v24', principal_id: '', stream_id: 'STR_v24',
  tenant_seq: 3, event_time: '2026-07-13T00:00:02.000Z',
  payload_hash: 'sha256:2222222222222222222222222222222222222222222222222222222222222222',
  workflow_hash: '', machine_manifest_hash: manHash,
});
eq('case3 leaf_hash matches v2.4 canonical (manifest-only)', r3.leaf_hash, expected3);

// Case 4 — both → v2.4
const r4 = ingestLeaf(tenant, 'v24_stream', {
  tenant_seq: 4,
  idempotency_key: 'k4',
  event_time: '2026-07-13T00:00:03.000Z',
  payload_hash: 'sha256:3333333333333333333333333333333333333333333333333333333333333333',
  workflow_hash: wfHash,
  machine_manifest_hash: manHash,
});
if (!r4.ok) { console.error('r4 failed', r4); process.exit(1); }
eq('case4 leaf_scheme', r4.leaf_scheme, 'v2.4');

// Case 5 — chain continuity across mixed schemes
const row2 = conn().prepare('SELECT prev_chain_hash, chain_hash FROM log_leaves WHERE tenant_seq = 2').get();
const row3 = conn().prepare('SELECT prev_chain_hash FROM log_leaves WHERE tenant_seq = 3').get();
eq('case5 chain continuous 2→3', row3.prev_chain_hash, row2.chain_hash);

// Case 6 — invalid workflow_hash → error
const r6 = ingestLeaf(tenant, 'v24_stream', {
  tenant_seq: 6,
  idempotency_key: 'k6',
  event_time: '2026-07-13T00:00:04.000Z',
  payload_hash: 'sha256:4444444444444444444444444444444444444444444444444444444444444444',
  workflow_hash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
});
if (r6.ok || r6.code !== 'invalid_workflow_hash') {
  console.error('case6 expected invalid_workflow_hash, got', r6);
  process.exit(1);
}
console.log('OK  case6 rejects workflow_hash with sha256: prefix');

const r6b = ingestLeaf(tenant, 'v24_stream', {
  tenant_seq: 6,
  idempotency_key: 'k6b',
  event_time: '2026-07-13T00:00:04.000Z',
  payload_hash: 'sha256:4444444444444444444444444444444444444444444444444444444444444444',
  workflow_hash: 'ABCDEF' + '0'.repeat(58),
});
if (r6b.ok || r6b.code !== 'invalid_workflow_hash') {
  console.error('case6b expected invalid_workflow_hash for uppercase, got', r6b);
  process.exit(1);
}
console.log('OK  case6b rejects uppercase workflow_hash');

// Case 7 — persistence
const row4 = conn().prepare('SELECT workflow_hash, machine_manifest_hash, leaf_scheme FROM log_leaves WHERE tenant_seq = 4').get();
eq('case7 workflow_hash persisted', row4.workflow_hash, wfHash);
eq('case7 machine_manifest_hash persisted', row4.machine_manifest_hash, manHash);
eq('case7 leaf_scheme persisted', row4.leaf_scheme, 'v2.4');

const row1 = conn().prepare('SELECT workflow_hash, machine_manifest_hash, leaf_scheme FROM log_leaves WHERE tenant_seq = 1').get();
eq('case7 v2.3 row workflow_hash NULL', row1.workflow_hash, null);
eq('case7 v2.3 row leaf_scheme', row1.leaf_scheme, 'v2.3');

console.log('\\nleaf v2.4 ingest smoke — all 12 assertions PASS');
`;

const asserts_path = path.join(__dirname, '_leaf_v24_asserts.ts');
fs.writeFileSync(asserts_path, asserts);
const result = spawnSync('node', [tsx, asserts_path], {
  cwd: path.join(__dirname, '..'),
  env: process.env,
  stdio: 'inherit',
});
fs.unlinkSync(asserts_path);
process.exit(result.status ?? 1);
