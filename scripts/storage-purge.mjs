#!/usr/bin/env node
// Local artifact retention sweep (Pivot S12).
//
// Deletes local-FS artifacts whose iteration has a storage_pointer
// (i.e., they were uploaded to the user's storage) AND are older than
// LOCAL_RETAIN_MINUTES (default 15). Run from cron, or trigger ad-hoc
// after a session ends.
//
// Usage: node scripts/storage-purge.mjs [--dry-run]

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const DB_PATH = process.env.SCRUPLE_DB_PATH || path.join(process.cwd(), 'data', 'scruple.db');
const ARTIFACTS_DIR = process.env.SCRUPLE_ARTIFACTS_DIR || path.join(process.cwd(), 'artifacts');
const RETAIN_MIN = Number(process.env.LOCAL_RETAIN_MINUTES || 15);
const dryRun = process.argv.includes('--dry-run');

const db = new Database(DB_PATH);
const now = Date.now();
const cutoff = now - RETAIN_MIN * 60_000;

const rows = db
  .prepare(
    `SELECT id, leaf_hash, storage_pointer, timestamp
       FROM iterations
       WHERE storage_pointer IS NOT NULL
         AND leaf_hash IS NOT NULL`,
  )
  .all();

let candidates = 0;
let purged = 0;
let bytes = 0;
for (const r of rows) {
  // age = now - iteration.timestamp
  const ts = Date.parse(r.timestamp);
  if (Number.isNaN(ts)) continue;
  if (ts > cutoff) continue;
  candidates += 1;

  const prefix = r.leaf_hash.slice(0, 2);
  const filePath = path.join(ARTIFACTS_DIR, prefix, r.leaf_hash);
  if (!fs.existsSync(filePath)) continue;

  const stat = fs.statSync(filePath);
  bytes += stat.size;
  if (!dryRun) {
    try {
      fs.unlinkSync(filePath);
      purged += 1;
    } catch (e) {
      console.error(`[purge] failed to delete ${filePath}:`, e?.message ?? e);
    }
  } else {
    purged += 1;
  }
}

const action = dryRun ? 'would purge' : 'purged';
console.log(`[purge] ${action} ${purged} / ${candidates} stale artifacts (${(bytes / 1024).toFixed(1)} KiB)`);
console.log(`[purge] retention: ${RETAIN_MIN}m, cutoff: ${new Date(cutoff).toISOString()}`);
