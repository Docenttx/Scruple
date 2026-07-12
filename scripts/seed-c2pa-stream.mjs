// Idempotent seed for the reserved `scruple.c2pa.sign` stream on tenant
// TEN_scruple. Safe to re-run — INSERT OR IGNORE keys off the unique
// (tenant_id, name) constraint.
//
// Runs after migration 030 lands. Exists so the C2PA signer (WO-08) has
// a stream to emit into without a manual DB tweak in every environment.
//
// Usage:
//   node scripts/seed-c2pa-stream.mjs
//   SCRUPLE_DB_PATH=/tmp/x.db node scripts/seed-c2pa-stream.mjs

import Database from 'better-sqlite3';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';

const DB_PATH =
  process.env.SCRUPLE_DB_PATH ||
  path.join(process.cwd(), 'data', 'scruple.db');

const RESERVED_STREAM_NAME = 'scruple.c2pa.sign';
const RESERVED_TENANT_ID = 'TEN_scruple';

function shortHex(namespace) {
  return createHash('sha256')
    .update(namespace + randomBytes(16).toString('hex') + Date.now())
    .digest('hex')
    .slice(0, 8);
}

const db = new Database(DB_PATH);
db.pragma('foreign_keys = ON');

const tenantRow = db
  .prepare('SELECT tenant_id FROM tenants WHERE tenant_id = ?')
  .get(RESERVED_TENANT_ID);
if (!tenantRow) {
  console.error(
    `FATAL: tenant ${RESERVED_TENANT_ID} not found. Run migrations first ` +
      '(npm run db:migrate).',
  );
  process.exit(1);
}

const existing = db
  .prepare('SELECT stream_id, checkpoint_secs, tsa_mode FROM streams WHERE tenant_id = ? AND name = ?')
  .get(RESERVED_TENANT_ID, RESERVED_STREAM_NAME);

if (existing) {
  console.log(
    `OK — ${RESERVED_STREAM_NAME} already exists: ${existing.stream_id} ` +
      `(checkpoint_secs=${existing.checkpoint_secs}, tsa_mode=${existing.tsa_mode})`,
  );
  process.exit(0);
}

// Enhanced tier defaults per canonical design §8. C2PA signs get 5-minute
// checkpoints + hourly anchoring; tsa_mode starts at 'none' and upgrades
// under WO-11 (Sprint 2) when the qualified TSA vendor is procured.
const streamId = `STR_${shortHex('stream')}`;
db.prepare(
  `INSERT INTO streams
     (stream_id, tenant_id, name, checkpoint_secs, tsa_mode,
      anchor_epoch_secs, retention_days, principal_mode)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
).run(
  streamId,
  RESERVED_TENANT_ID,
  RESERVED_STREAM_NAME,
  300, // 5 min — enhanced default
  'none',
  3600, // 1h
  2555, // 7 years
  'per_leaf',
);

console.log(
  `SEEDED — ${RESERVED_STREAM_NAME} stream_id=${streamId} tier=enhanced-baseline`,
);
