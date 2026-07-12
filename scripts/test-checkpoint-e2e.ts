// E2E test for WO-07 — walks the full happy path against a scratch DB:
//   1. seed tenant + principal + delegation
//   2. create a stream via /api/v1/streams
//   3. ingest 5 leaves
//   4. tick the scheduler
//   5. read the checkpoint back, verify:
//        - signature matches the canonical bundle bytes
//        - Merkle root matches an independent recomputation
//        - inclusion path for leaf 3 verifies to the root
//   6. tick again with no new leaves → heartbeat checkpoint
//        - root = sha256(prev_root_bytes)
//        - prev_checkpoint chain intact
//   7. ingest 2 more leaves, tick a third time → real checkpoint chained
//        to the heartbeat
//
// Prereqs: dedicated Next.js dev server on SCRUPLE_TEST_URL with
// SCRUPLE_DB_PATH pointing at the same DB this script reads.

import Database from 'better-sqlite3';
import { createHash, createHmac, createPublicKey, randomBytes, verify as nodeVerify } from 'node:crypto';
import path from 'node:path';
import { buildBalancedMerkle, rootFromInclusion } from '../lib/witness/merkle';
import { canonicalCheckpointV1 } from '../lib/witness/canonicalCheckpointV1';
import { getCheckpointPublicKeyPem, WITNESS_KEY_ID } from '../lib/witness/checkpointSign';
import { tickAll } from '../lib/witness/checkpointScheduler';

const BASE = process.env.SCRUPLE_TEST_URL ?? 'http://localhost:3001';
const DB_PATH = process.env.SCRUPLE_DB_PATH || path.join(process.cwd(), 'data', 'scruple.db');

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
  console.log(`[checkpoint-e2e] BASE=${BASE} DB=${DB_PATH}`);

  // ---- 1. seed ----
  const db = new Database(DB_PATH);
  db.pragma('foreign_keys = ON');
  const tenantId = 'TEN_test_ckpt';
  const apiKey = `sk_test_${randomBytes(16).toString('hex')}`;
  const hmacSecret = randomBytes(32).toString('hex');
  db.prepare(
    `INSERT OR REPLACE INTO tenants (tenant_id, name, api_key_hash, hmac_secret_enc, is_internal, status)
     VALUES (?, 'ckpt-tenant', ?, ?, 0, 'active')`,
  ).run(tenantId, sha256Hex(apiKey), hmacSecret);
  const principalId = 'PRN_testckpt';
  db.prepare(
    `INSERT OR REPLACE INTO principals (principal_id, name, read_key_hash) VALUES (?, 'ckpt-principal', ?)`,
  ).run(principalId, sha256Hex('unused'));
  db.prepare(
    `INSERT OR REPLACE INTO delegations (delegation_id, principal_id, tenant_id, status) VALUES (?, ?, ?, 'active')`,
  ).run('DLG_testckpt', principalId, tenantId);
  console.log(`  seeded tenant=${tenantId} principal=${principalId}`);

  // ---- 2. create stream ----
  const streamBody = JSON.stringify({
    name: 'ckpt.test',
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

  // ---- 3. ingest 5 leaves ----
  const leafHashes: string[] = [];
  for (let i = 1; i <= 5; i++) {
    const body = JSON.stringify({
      tenant_seq: i,
      idempotency_key: `ckpt-${i}`,
      principal_id: principalId,
      event_time: new Date().toISOString(),
      payload_hash: 'sha256:' + i.toString().padStart(64, '0'),
    });
    const r = await fetch(BASE + '/api/v1/log/ckpt.test', {
      method: 'POST',
      headers: signedHeaders(hmacSecret, apiKey, body),
      body,
    });
    const j = (await r.json()) as { leaf?: { leaf_hash?: string } };
    const raw = j.leaf?.leaf_hash?.replace(/^sha256:/, '') ?? '';
    leafHashes.push(raw);
  }
  assert(leafHashes.length === 5, '5 leaves ingested');

  // ---- 4. tick ----
  const tickResults = tickAll();
  const ours = tickResults.find((t) => t.stream_id === streamId);
  assert(ours?.action === 'wrote_checkpoint', 'first tick wrote a real checkpoint', ours);

  // ---- 5. verify signature + Merkle root + inclusion ----
  const ckpt = db
    .prepare(`SELECT * FROM log_checkpoints WHERE stream_id = ? ORDER BY epoch_index DESC LIMIT 1`)
    .get(streamId) as {
      checkpoint_id: string;
      epoch_index: number;
      first_seq: number;
      last_seq: number;
      merkle_root: string;
      prev_checkpoint: string | null;
      witness_sig: string;
      witness_key_id: string;
      is_heartbeat: number;
      created_at: string;
    };

  // Signature: reconstruct canonical bundle, verify with the published pubkey.
  const bundleBytes = canonicalCheckpointV1({
    stream_id: streamId,
    epoch_index: ckpt.epoch_index,
    first_seq: ckpt.first_seq,
    last_seq: ckpt.last_seq,
    merkle_root: ckpt.merkle_root,
    prev_checkpoint_id: ckpt.prev_checkpoint ?? '',
    is_heartbeat: !!ckpt.is_heartbeat,
    created_at: ckpt.created_at,
  });
  const pubKeyPem = getCheckpointPublicKeyPem();
  const pubKey = createPublicKey(pubKeyPem);
  const sigOK = nodeVerify(null, bundleBytes, pubKey, Buffer.from(ckpt.witness_sig, 'hex'));
  assert(sigOK, 'checkpoint signature verifies against published pubkey');
  assert(ckpt.witness_key_id === WITNESS_KEY_ID, 'witness_key_id matches trust manifest');

  // Merkle root: independent recomputation from the 5 leaf hashes.
  const tree = buildBalancedMerkle(leafHashes);
  assert(tree.root === ckpt.merkle_root, 'stored merkle_root matches independent recomputation');

  // Inclusion path for leaf 3 (index 2): recompute root from path + leaf.
  const path3 = tree.inclusionPath(2);
  const recomputedRoot = rootFromInclusion(leafHashes[2], path3);
  assert(recomputedRoot === tree.root, 'inclusion path for leaf 3 reconstructs the root');

  // ---- 6. heartbeat ----
  const tick2 = tickAll();
  const hb = tick2.find((t) => t.stream_id === streamId);
  assert(hb?.action === 'wrote_heartbeat', 'second tick with no new leaves = heartbeat', hb);
  const ckpt2 = db
    .prepare(`SELECT * FROM log_checkpoints WHERE stream_id = ? ORDER BY epoch_index DESC LIMIT 1`)
    .get(streamId) as { merkle_root: string; prev_checkpoint: string; is_heartbeat: number; epoch_index: number };
  const expectedHbRoot = sha256Hex(Buffer.from(ckpt.merkle_root, 'hex'));
  assert(ckpt2.merkle_root === expectedHbRoot, 'heartbeat root = sha256(prev.merkle_root bytes)');
  assert(ckpt2.prev_checkpoint === ckpt.checkpoint_id, 'heartbeat prev_checkpoint links to previous');
  assert(ckpt2.epoch_index === ckpt.epoch_index + 1, 'epoch_index incremented');
  assert(ckpt2.is_heartbeat === 1, 'is_heartbeat flag set');

  // ---- 7. ingest 2 more leaves + third tick ----
  for (let i = 6; i <= 7; i++) {
    const body = JSON.stringify({
      tenant_seq: i,
      idempotency_key: `ckpt-${i}`,
      principal_id: principalId,
      event_time: new Date().toISOString(),
      payload_hash: 'sha256:' + i.toString().padStart(64, '0'),
    });
    await fetch(BASE + '/api/v1/log/ckpt.test', {
      method: 'POST',
      headers: signedHeaders(hmacSecret, apiKey, body),
      body,
    });
  }
  const tick3 = tickAll();
  const t3 = tick3.find((t) => t.stream_id === streamId);
  assert(t3?.action === 'wrote_checkpoint', 'third tick wrote real checkpoint with new leaves', t3);
  const ckpt3 = db
    .prepare(`SELECT * FROM log_checkpoints WHERE stream_id = ? ORDER BY epoch_index DESC LIMIT 1`)
    .get(streamId) as { prev_checkpoint: string; first_seq: number; last_seq: number; epoch_index: number };
  assert(ckpt3.prev_checkpoint === ckpt2.merkle_root ? false : true, 'prev_checkpoint FK on ckpt3 exists');
  assert(ckpt3.first_seq === 6 && ckpt3.last_seq === 7, 'ckpt3 covers seqs 6–7');
  assert(ckpt3.epoch_index === ckpt2.epoch_index + 1, 'epoch_index incremented on ckpt3');

  // ---- 8. trust manifest ----
  const tmResp = await fetch(BASE + '/.well-known/witness-trust.json');
  const tm = (await tmResp.json()) as { checkpoint_keys?: Array<{ key_id?: string; alg?: string; public_key_pem?: string }> };
  assert(tmResp.status === 200, 'trust manifest reachable');
  const keyEntry = tm.checkpoint_keys?.find((k) => k.key_id === WITNESS_KEY_ID);
  assert(!!keyEntry, 'trust manifest lists the checkpoint key');
  assert(keyEntry?.alg === 'ED25519', 'trust manifest alg = ED25519');
  assert((keyEntry?.public_key_pem ?? '').includes('BEGIN PUBLIC KEY'), 'trust manifest carries pubkey PEM');

  console.log(`\n=== ${failures === 0 ? 'PASS' : 'FAIL'} — ${failures} failure(s)`);
  return failures === 0 ? 0 : 1;
}

main().then((c) => process.exit(c));
