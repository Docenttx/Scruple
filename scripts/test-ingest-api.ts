// Integration test for WO-06 — hits the running Next.js server end-to-end.
//
// Prerequisites:
//   - Migration 030 applied.
//   - Next.js dev server running on http://localhost:3001 (or SCRUPLE_TEST_URL).
//   - A test tenant provisioned. The script provisions one automatically
//     against SCRUPLE_DB_PATH if `TEST_TENANT_API_KEY` and `TEST_TENANT_HMAC`
//     aren't set — writes directly to the tenants table via better-sqlite3.
//
// Run:
//   npx tsx scripts/test-ingest-api.ts
//
// Exits 0 on all-green, non-zero on any failure.

import Database from 'better-sqlite3';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import path from 'node:path';

const BASE = process.env.SCRUPLE_TEST_URL ?? 'http://localhost:3001';
const DB_PATH =
  process.env.SCRUPLE_DB_PATH || path.join(process.cwd(), 'data', 'scruple.db');
const TENANT_NAME = 'Test Tenant (ingest)';

function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function provisionTestTenant(): { apiKey: string; hmacSecret: string; tenantId: string } {
  const db = new Database(DB_PATH);
  db.pragma('foreign_keys = ON');
  const tenantId = 'TEN_test_ingest';
  const apiKey = `sk_test_${randomBytes(16).toString('hex')}`;
  const hmacSecret = randomBytes(32).toString('hex');
  db.prepare(
    `INSERT OR REPLACE INTO tenants
       (tenant_id, name, api_key_hash, hmac_secret_enc, is_internal, status)
     VALUES (?, ?, ?, ?, 0, 'active')`,
  ).run(tenantId, TENANT_NAME, sha256Hex(apiKey), hmacSecret);
  return { apiKey, hmacSecret, tenantId };
}

function provisionTestPrincipal(tenantId: string): string {
  const db = new Database(DB_PATH);
  const principalId = 'PRN_testingt';
  db.prepare(
    `INSERT OR REPLACE INTO principals (principal_id, name, read_key_hash)
     VALUES (?, ?, ?)`,
  ).run(principalId, 'Test Principal', sha256Hex('unused'));
  db.prepare(
    `INSERT OR REPLACE INTO delegations
       (delegation_id, principal_id, tenant_id, status)
     VALUES (?, ?, ?, 'active')`,
  ).run('DLG_testingt', principalId, tenantId);
  return principalId;
}

async function req(
  method: 'POST' | 'GET',
  path: string,
  headers: Record<string, string>,
  body?: string,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(BASE + path, { method, headers, body });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
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
  console.log(`[ingest-api-test] BASE=${BASE} DB=${DB_PATH}`);

  const { apiKey, hmacSecret, tenantId } = provisionTestTenant();
  const principalId = provisionTestPrincipal(tenantId);
  console.log(`  provisioned tenant=${tenantId} principal=${principalId}`);

  // ---- Streams: create ----
  console.log('\n[1] POST /v1/streams — create per_leaf stream');
  const streamBody = JSON.stringify({
    name: 'test.ingest',
    checkpoint_secs: 60,
    principal_mode: 'per_leaf',
  });
  let r = await req('POST', '/api/v1/streams', {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  }, streamBody);
  assert(r.status === 200, 'create stream returns 200', r);
  const streamId = (r.body as { stream?: { stream_id?: string } }).stream?.stream_id ?? '';
  assert(streamId.startsWith('STR_'), 'created stream_id starts with STR_', streamId);

  // ---- Streams: list ----
  console.log('\n[2] GET /v1/streams');
  r = await req('GET', '/api/v1/streams', { Authorization: `Bearer ${apiKey}` });
  assert(r.status === 200, 'list streams returns 200');
  const streams = (r.body as { streams?: unknown[] }).streams ?? [];
  assert(streams.length >= 1, 'stream count >= 1');

  // ---- Happy-path single leaf ----
  console.log('\n[3] POST /v1/log/test.ingest — happy path');
  const leafBody1 = JSON.stringify({
    tenant_seq: 1,
    idempotency_key: 'happy-1',
    principal_id: principalId,
    event_time: new Date().toISOString(),
    payload_hash: 'sha256:' + 'a'.repeat(64),
    dims: { input_hash: 'sha256:' + 'b'.repeat(64) },
    meta: { region: 'us-west' },
  });
  r = await req('POST', '/api/v1/log/test.ingest', signedHeaders(hmacSecret, apiKey, leafBody1), leafBody1);
  assert(r.status === 200, 'single leaf returns 200', r);
  const leaf1 = (r.body as { leaf?: { leaf_hash?: string; chain_hash?: string; tenant_seq?: number } }).leaf;
  assert(leaf1?.leaf_hash?.startsWith('sha256:'), 'leaf_hash has sha256: prefix');
  assert(leaf1?.tenant_seq === 1, 'tenant_seq echoed');

  // ---- Idempotency ----
  console.log('\n[4] POST /v1/log/test.ingest — replay same idempotency key');
  r = await req('POST', '/api/v1/log/test.ingest', signedHeaders(hmacSecret, apiKey, leafBody1), leafBody1);
  assert(r.status === 200, 'idempotent replay returns 200');
  assert((r.body as { duplicate?: boolean }).duplicate === true, 'response marked duplicate');

  // ---- Sequence gap acceptance ----
  console.log('\n[5] POST /v1/log/test.ingest — with a gap (seq=5, previous was 1)');
  const leafBody5 = JSON.stringify({
    tenant_seq: 5,
    idempotency_key: 'gap-5',
    principal_id: principalId,
    event_time: new Date().toISOString(),
    payload_hash: 'sha256:' + 'c'.repeat(64),
  });
  r = await req('POST', '/api/v1/log/test.ingest', signedHeaders(hmacSecret, apiKey, leafBody5), leafBody5);
  assert(r.status === 200, 'gap accepted with 200');
  assert((r.body as { gap?: boolean }).gap === true, 'gap flag set');
  assert((r.body as { gap_from?: number }).gap_from === 2, 'gap_from = 2 (first missing seq)');

  // ---- Sequence replay ----
  console.log('\n[6] POST /v1/log/test.ingest — seq_replay (seq=3 after seq=5)');
  const leafBody3 = JSON.stringify({
    tenant_seq: 3,
    idempotency_key: 'replay-3',
    principal_id: principalId,
    event_time: new Date().toISOString(),
    payload_hash: 'sha256:' + 'd'.repeat(64),
  });
  r = await req('POST', '/api/v1/log/test.ingest', signedHeaders(hmacSecret, apiKey, leafBody3), leafBody3);
  assert(r.status === 409, 'seq_replay returns 409', r);
  assert((r.body as { error?: string }).error === 'seq_replay', 'error code = seq_replay');

  // ---- payload_bytes rejection ----
  console.log('\n[7] POST /v1/log/test.ingest — payload_bytes rejected (zero-content)');
  const badBytesBody = JSON.stringify({
    tenant_seq: 100,
    idempotency_key: 'bytes-100',
    principal_id: principalId,
    event_time: new Date().toISOString(),
    payload_hash: 'sha256:' + 'e'.repeat(64),
    payload_bytes: 'AAAAAA==',
  });
  r = await req('POST', '/api/v1/log/test.ingest', signedHeaders(hmacSecret, apiKey, badBytesBody), badBytesBody);
  assert(r.status === 400, 'payload_bytes returns 400');
  assert((r.body as { error?: string }).error === 'payload_bytes_not_allowed', 'error code correct');

  // ---- PII key rejection ----
  console.log('\n[8] POST /v1/log/test.ingest — PII key in meta rejected');
  const piiBody = JSON.stringify({
    tenant_seq: 101,
    idempotency_key: 'pii-101',
    principal_id: principalId,
    event_time: new Date().toISOString(),
    payload_hash: 'sha256:' + 'f'.repeat(64),
    meta: { email: 'user@example.com' },
  });
  r = await req('POST', '/api/v1/log/test.ingest', signedHeaders(hmacSecret, apiKey, piiBody), piiBody);
  assert(r.status === 400, 'pii key returns 400');
  assert((r.body as { error?: string }).error === 'pii_key_in_meta', 'error code correct');

  // ---- Bad HMAC ----
  console.log('\n[9] POST /v1/log/test.ingest — bad HMAC');
  const someBody = JSON.stringify({
    tenant_seq: 200,
    idempotency_key: 'hmac-bad-200',
    principal_id: principalId,
    event_time: new Date().toISOString(),
    payload_hash: 'sha256:' + '1'.repeat(64),
  });
  const badHeaders = signedHeaders(hmacSecret, apiKey, someBody);
  badHeaders['X-Scruple-Signature'] = 'a'.repeat(64);
  r = await req('POST', '/api/v1/log/test.ingest', badHeaders, someBody);
  assert(r.status === 401, 'bad hmac returns 401');
  assert((r.body as { code?: string }).code === 'invalid_signature', 'code correct');

  // ---- Reserved stream ----
  console.log('\n[10] POST /v1/streams — non-internal tenant cannot create scruple.* stream');
  r = await req('POST', '/api/v1/streams', {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  }, JSON.stringify({ name: 'scruple.forbidden', principal_mode: 'none' }));
  assert(r.status === 400, 'reserved-stream create returns 400');

  // ---- Batch ingest ----
  console.log('\n[11] POST /v1/log/test.ingest/batch');
  const batchBody = JSON.stringify({
    leaves: [
      { tenant_seq: 300, idempotency_key: 'b-300', principal_id: principalId, event_time: new Date().toISOString(), payload_hash: 'sha256:' + '2'.repeat(64) },
      { tenant_seq: 301, idempotency_key: 'b-301', principal_id: principalId, event_time: new Date().toISOString(), payload_hash: 'sha256:' + '3'.repeat(64) },
      { tenant_seq: 302, idempotency_key: 'b-302', principal_id: principalId, event_time: new Date().toISOString(), payload_hash: 'sha256:' + '4'.repeat(64) },
    ],
  });
  r = await req('POST', '/api/v1/log/test.ingest/batch', signedHeaders(hmacSecret, apiKey, batchBody), batchBody);
  assert(r.status === 200, 'batch returns 200');
  const batchResults = (r.body as { results?: Array<{ leaf?: unknown }> }).results ?? [];
  assert(batchResults.length === 3, 'batch returned 3 results');
  assert(batchResults.every((x) => 'leaf' in x), 'all batch leaves succeeded');

  console.log(`\n=== ${failures === 0 ? 'PASS' : 'FAIL'} — ${failures} failure(s)`);
  return failures === 0 ? 0 : 1;
}

main().then((c) => process.exit(c));
