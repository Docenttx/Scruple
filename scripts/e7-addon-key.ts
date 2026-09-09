// The API key the STANDALONE ADD-ON signs in with — a second tenant, on purpose.
//
// WO-E7 puts three leaves side by side, and two of them come from two different
// PRODUCTS. `scripts/d3-sandbox.ts` provisions the desktop's capture surfaces;
// this provisions the Blender add-on, and it deliberately does NOT reuse the
// desktop's key. The add-on talking to the server is a different integration
// with a different tamper surface and a different owner, and a comparison that
// ran both halves under one tenant would be quietly comparing one product with
// itself.
//
// What it does NOT do is establish a baseline. `d3-sandbox.ts` has to, because
// the desktop's surfaces submit a `baseline_ref` the driver computed for them.
// The add-on computes its own tamper surface hash over its own files and calls
// `client.attach()` — so a baseline minted here would be a baseline over the
// wrong bytes, and the add-on would never use it. The key carries
// `baseline:write` so that attach() can establish the real one.
//
//   bash scripts/tsx.sh scripts/e7-addon-key.ts [--print-key|--json]

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { conn } from '@/lib/db/sqlite';

const REPO = path.resolve(__dirname, '..');
const APP = process.env.SCRUPLE_APP_URL ?? 'http://127.0.0.1:3902';
const STATE = path.join(REPO, '.run', 'e7', 'addon-key.json');

if (APP.includes(':5799') || APP.includes(':3001')) {
  throw new Error(`refusing to provision against ${APP} — that is production`);
}

interface AddonSandbox {
  appUrl: string;
  userId: string;
  apiKey: string;
  keyId: string;
  label: string;
}

function mint(): AddonSandbox {
  // A STABLE tenant id across runs. `baselines.baseline_hash` is globally
  // unique (d3-sandbox found that the hard way), and the add-on re-attaches
  // with the same tamper surface hash on every run — so a fresh tenant per run
  // would collide on the second one. One tenant, many keys, is fine.
  const userId = 'blender-addon-standalone';
  const apiKey = 'sk_e7_' + crypto.randomBytes(24).toString('base64url');
  const keyId = crypto.randomUUID();
  const db = conn();
  db.prepare(`INSERT OR IGNORE INTO users (id, email) VALUES (?, ?)`).run(userId, `${userId}@example.com`);
  db.prepare(
    `INSERT INTO api_keys (id, user_id, key_hash, key_prefix, scopes_json, label)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    keyId,
    userId,
    crypto.createHash('sha256').update(apiKey).digest('hex'),
    apiKey.slice(0, 12),
    JSON.stringify(['witness:write', 'baseline:write', 'read']),
    'scruple-blender standalone add-on',
  );
  return { appUrl: APP, userId, apiKey, keyId, label: 'scruple-blender standalone add-on' };
}

function main(): void {
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  let sb: AddonSandbox | null = null;
  if (fs.existsSync(STATE)) {
    const prev = JSON.parse(fs.readFileSync(STATE, 'utf8')) as AddonSandbox;
    // Reused only if the key is still LIVE in the database this app reads. The
    // scratch database is rebuilt from time to time; a cached key for a row
    // that no longer exists would fail as a 401 inside Blender, in a worker
    // thread, where it reads as "the add-on is broken".
    const row = conn()
      .prepare(`SELECT id FROM api_keys WHERE id = ?`)
      .get(prev.keyId) as { id: string } | undefined;
    if (row && prev.appUrl === APP) sb = prev;
  }
  if (!sb) {
    sb = mint();
    fs.writeFileSync(STATE, JSON.stringify(sb, null, 2), { mode: 0o600 });
  }
  if (process.argv.includes('--print-key')) { process.stdout.write(sb.apiKey + '\n'); return; }
  if (process.argv.includes('--json')) { process.stdout.write(JSON.stringify(sb) + '\n'); return; }
  console.log(`[e7-addon-key] app    ${sb.appUrl}`);
  console.log(`[e7-addon-key] tenant ${sb.userId}`);
  console.log(`[e7-addon-key] state  ${STATE}`);
}

main();
