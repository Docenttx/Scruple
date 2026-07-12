// Emit a leaf to the reserved `scruple.c2pa.sign` stream on tenant
// TEN_scruple. This is the internal-tenant emit path used by the C2PA
// signer (WO-08) to record every sign event as a witnessed leaf.
//
// Auth mode: the internal tenant's api_key + hmac_secret are provisioned
// once at deploy time and injected via env:
//   SCRUPLE_INTERNAL_API_KEY=sk_int_...
//   SCRUPLE_INTERNAL_HMAC_SECRET=<hex-random-32-bytes>
//
// The provisioning script (scripts/provision-scruple-internal-tenant.mjs)
// generates these, hashes the API key, and writes it into the tenants
// row. Same secrets live in .env.local for the running server. In dev,
// if the env vars are absent, this module auto-provisions on first use
// (development ergonomics — prod deploy MUST provide them explicitly).

import { createHash, createHmac, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { conn } from '@/lib/db/sqlite';

const INGEST_BASE = process.env.SCRUPLE_INTERNAL_INGEST_BASE ?? 'http://localhost:3005';
const STREAM_NAME = 'scruple.c2pa.sign';
const TENANT_ID = 'TEN_scruple';
const DEV_CREDS_DIR = process.env.SCRUPLE_INTERNAL_CREDS_DIR
  ?? path.join(process.cwd(), 'data', 'witness');
const DEV_CREDS_FILE = path.join(DEV_CREDS_DIR, 'scruple-internal.dev.json');

interface CredCache {
  apiKey: string;
  hmacSecret: string;
}
let _creds: CredCache | null = null;

function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function readDevCredsFile(): CredCache | null {
  try {
    const raw = fs.readFileSync(DEV_CREDS_FILE, 'utf-8');
    const j = JSON.parse(raw) as { apiKey?: string; hmacSecret?: string };
    if (j.apiKey && j.hmacSecret) return { apiKey: j.apiKey, hmacSecret: j.hmacSecret };
  } catch {
    /* not present is normal */
  }
  return null;
}

function writeDevCredsFile(creds: CredCache): void {
  fs.mkdirSync(DEV_CREDS_DIR, { recursive: true });
  fs.writeFileSync(DEV_CREDS_FILE, JSON.stringify(creds, null, 2), { mode: 0o600 });
}

/** Return the internal-tenant credentials.
 *  Priority: env vars → dev creds file → auto-provision + persist to file.
 *  In prod, only env vars should be set (dev file path won't exist).
 */
function getInternalCreds(): CredCache {
  if (_creds) return _creds;

  // Highest priority: explicit env vars (prod / CI).
  const envKey = process.env.SCRUPLE_INTERNAL_API_KEY;
  const envSecret = process.env.SCRUPLE_INTERNAL_HMAC_SECRET;
  if (envKey && envSecret) {
    _creds = { apiKey: envKey, hmacSecret: envSecret };
    return _creds;
  }

  // Second: dev creds file (persists across Next.js hot-reloads).
  const file = readDevCredsFile();
  if (file) {
    // Sanity-check that the file's apiKey matches the tenants.api_key_hash
    // row — if the DB was wiped since the file was written, we need to
    // re-provision and re-write.
    const row = conn()
      .prepare(`SELECT api_key_hash FROM tenants WHERE tenant_id = ?`)
      .get(TENANT_ID) as { api_key_hash: string } | undefined;
    if (row && row.api_key_hash === sha256Hex(file.apiKey)) {
      _creds = file;
      return _creds;
    }
    // File is stale — fall through to auto-provision.
  }

  // Third: auto-provision (dev only). Writes file for reuse.
  const row = conn()
    .prepare(`SELECT api_key_hash, hmac_secret_enc FROM tenants WHERE tenant_id = ?`)
    .get(TENANT_ID) as { api_key_hash: string; hmac_secret_enc: string } | undefined;
  if (!row) {
    throw new Error(`TEN_scruple row missing. Run migrations first.`);
  }
  const apiKey = `sk_int_${randomBytes(16).toString('hex')}`;
  const hmacSecret = randomBytes(32).toString('hex');
  conn()
    .prepare(
      `UPDATE tenants SET api_key_hash = ?, hmac_secret_enc = ? WHERE tenant_id = ?`,
    )
    .run(sha256Hex(apiKey), hmacSecret, TENANT_ID);
  writeDevCredsFile({ apiKey, hmacSecret });
  _creds = { apiKey, hmacSecret };
  return _creds;
}

interface EmitInput {
  principalId: string;
  assetSha256Hex: string;
  outputManifestSha256Hex: string;
  certSubjectKeyId: string;
  signingIdentity: string;  // 'vault:...xxxxxxxx' | 'local:<path>'
  signingMode: 'vault' | 'local';
  product: string;
  tier: string;
  status: 'signed' | string;
  scrupleTenantSeq?: number;   // caller supplies monotonic; if absent we mint
}

export interface EmitResult {
  ok: true;
  leaf: {
    stream_id: string;
    tenant_seq: number;
    leaf_hash: string;
    chain_hash: string;
    pending_checkpoint_epoch: number;
  };
  idempotency_key: string;
}

export interface EmitError {
  ok: false;
  error: string;
  http_status?: number;
}

/** Compute the monotonic tenant_seq for the C2PA sign stream. We derive
 *  from MAX(tenant_seq) + 1 directly at the DB layer for simplicity —
 *  the ingest layer will detect gaps if concurrent writes race, but at
 *  Scruple's C2PA sign volume that's a non-issue. */
function nextTenantSeq(): number {
  // Look up the stream row for scruple.c2pa.sign, then MAX(tenant_seq)
  // from log_leaves for that stream_id.
  const stream = conn()
    .prepare(`SELECT stream_id FROM streams WHERE tenant_id = ? AND name = ?`)
    .get(TENANT_ID, STREAM_NAME) as { stream_id: string } | undefined;
  if (!stream) {
    throw new Error(
      `stream ${STREAM_NAME} not found — run scripts/seed-c2pa-stream.mjs`,
    );
  }
  const row = conn()
    .prepare(
      `SELECT COALESCE(MAX(tenant_seq), 0) AS n FROM log_leaves WHERE stream_id = ?`,
    )
    .get(stream.stream_id) as { n: number };
  return row.n + 1;
}

/**
 * Emit a leaf for a C2PA sign event. Fail-open: on any error, returns
 * an EmitError but does NOT throw — the caller is expected to still
 * return the sign result to the user with a `witness_error` field.
 *
 * Zero-content posture (§9): no bytes ever leave via payload_bytes.
 * payload_hash is sha256 of a canonicalized JSON of the sign event
 * metadata (hashes + identifiers only).
 */
export async function emitC2paSignLeaf(input: EmitInput): Promise<EmitResult | EmitError> {
  let creds: CredCache;
  try {
    creds = getInternalCreds();
  } catch (e) {
    return { ok: false, error: `internal creds unavailable: ${(e as Error).message}` };
  }

  const eventTime = new Date().toISOString();
  const canonicalPayload = JSON.stringify({
    asset_sha256: input.assetSha256Hex,
    cert_subject_key_id: input.certSubjectKeyId,
    output_manifest_sha256: input.outputManifestSha256Hex,
    product: input.product,
    signing_identity: input.signingIdentity,
    signing_mode: input.signingMode,
    status: input.status,
    tier: input.tier,
  });
  const payloadHash = 'sha256:' + sha256Hex(canonicalPayload);

  const tenantSeq = input.scrupleTenantSeq ?? nextTenantSeq();
  const idempotencyKey = `c2pa-sign-${input.assetSha256Hex.slice(0, 12)}-${tenantSeq}`;

  const body = JSON.stringify({
    tenant_seq: tenantSeq,
    idempotency_key: idempotencyKey,
    principal_id: input.principalId,
    event_time: eventTime,
    payload_hash: payloadHash,
    dims: {},
    meta: {
      product: input.product,
      tier: input.tier,
      status: input.status,
    },
  });

  const ts = String(Math.floor(Date.now() / 1000));
  const sig = createHmac('sha256', creds.hmacSecret)
    .update(Buffer.concat([Buffer.from(`${ts}\n`), Buffer.from(body)]))
    .digest('hex');

  const url = `${INGEST_BASE.replace(/\/+$/, '')}/api/v1/log/${STREAM_NAME}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${creds.apiKey}`,
        'Content-Type': 'application/json',
        'X-Scruple-Timestamp': ts,
        'X-Scruple-Signature': sig,
      },
      body,
    });
    if (!res.ok) {
      const text = await res.text();
      return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}`, http_status: res.status };
    }
    const j = (await res.json()) as {
      leaf?: {
        stream_id: string; tenant_seq: number;
        leaf_hash: string; chain_hash: string;
        pending_checkpoint_epoch: number;
      };
    };
    if (!j.leaf) return { ok: false, error: 'no leaf in response' };
    return { ok: true, leaf: j.leaf, idempotency_key: idempotencyKey };
  } catch (e) {
    return { ok: false, error: `fetch failed: ${(e as Error).message}` };
  }
}

/** For tests / config commands: reset the cached creds so a re-read
 *  from env picks up new values. */
export function _resetInternalCredsCache(): void {
  _creds = null;
}
