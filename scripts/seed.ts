// Seed script — creates one demo user + one project with a few
// captured iterations so the UI has something to render before any
// provider key is configured. Idempotent: re-running re-uses the user.
//
//   npm run db:seed

import crypto from 'node:crypto';
import { runMigrations } from '../lib/db/migrate';
import { conn } from '../lib/db/sqlite';
import { sha256Hex } from '../lib/scruple/hash';
import { storeArtifact } from '../lib/scruple/artifacts';

runMigrations(false);

const db = conn();
const SEED_EMAIL = 'demo@scruple.local';

let userId: string;
const existing = db.prepare(`SELECT id FROM users WHERE email = ?`).get(SEED_EMAIL) as
  { id: string } | undefined;
if (existing) {
  userId = existing.id;
} else {
  userId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO users (id, email, name) VALUES (?, ?, ?)`,
  ).run(userId, SEED_EMAIL, 'Demo User');
}

// Create a demo project (idempotent on name uniqueness)
const projectName = 'Demo — Hero image batch';
let projectId: number;
const exProj = db
  .prepare(`SELECT id FROM projects WHERE user_id = ? AND name = ?`)
  .get(userId, projectName) as { id: number } | undefined;
if (exProj) {
  projectId = exProj.id;
} else {
  const res = db
    .prepare(
      `INSERT INTO projects (user_id, name, type, created_at, updated_at)
       VALUES (?, ?, 'txt2img', datetime('now'), datetime('now'))`,
    )
    .run(userId, projectName);
  projectId = res.lastInsertRowid as number;
}

// Insert 5 iterations with synthetic images (1x1 PNG of varying colors)
const PNG_PREFIX = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
function tinyPng(seed: number): Buffer {
  // Build a 1x1 PNG with seed-derived color in IDAT — not strictly valid
  // PNG (we don't compute CRC), but our pipeline only hashes bytes.
  const idat = Buffer.from([0x00, seed & 0xff, (seed >> 8) & 0xff, 0xff]);
  return Buffer.concat([PNG_PREFIX, idat]);
}

const insertIter = db.prepare(
  `INSERT OR IGNORE INTO iterations
     (project_id, run_sequence, timestamp, leaf_hash, input_hash, output_hash,
      previous_hash, metadata, source_file, image_filename, prompt, provider, provider_job_id)
   VALUES (?, ?, datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?)`,
);

let prev: string | null = null;
for (let i = 1; i <= 5; i++) {
  const bytes = tinyPng(i);
  const outputHash = sha256Hex(bytes);
  const inputHash = sha256Hex(`seed-input-${i}`);
  const meta = JSON.stringify({ generationSpec: { prompt: `seed iter ${i}` }, contentType: 'image/png' });
  storeArtifact(outputHash, bytes);
  insertIter.run(
    projectId,
    i,
    outputHash,
    inputHash,
    outputHash,
    prev,
    meta,
    outputHash,
    `seed-${i}.png`,
    `Synthetic seed iteration ${i}`,
    `seed-job-${projectId}-${i}`,
  );
  prev = outputHash;
}

// Refresh iteration_count
db.prepare(
  `UPDATE projects SET iteration_count = (SELECT COUNT(*) FROM iterations WHERE project_id = ?) WHERE id = ?`,
).run(projectId, projectId);

console.log('Seeded:');
console.log(`  user:    ${SEED_EMAIL} (id ${userId})`);
console.log(`  project: ${projectName} (id ${projectId})`);
const n = (db.prepare(`SELECT COUNT(*) AS n FROM iterations WHERE project_id = ?`).get(projectId) as { n: number }).n;
console.log(`  iterations: ${n}`);
process.exit(0);
