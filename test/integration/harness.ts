// Integration harness — boots a real Next server against a throwaway
// database and drives the actual HTTP surface.
//
// WHY THIS EXISTS
//
// On 2026-08-29 the /v2 surface had 28 passing unit tests and a clean
// typecheck. One hour of driving it over real HTTP found two bugs that
// both suites would have kept missing indefinitely:
//
//   - /witness 500'd on NOT NULL iterations.project_id
//   - run_sequence was hardcoded to 0, so the SECOND witness for any
//     tenant collided with a UNIQUE index. The FIRST call always worked.
//
// Neither is subtle. Both were invisible because the unit tests exercised
// pure logic — scope checks, applicability — and never touched a schema.
//
// TWO SAFETY RULES, both learned the hard way in the same hour.
//
// 1. SCRUPLE_DB_PATH must point somewhere throwaway. Enforced below.
// 2. WITNESS_SERVER_URL must NOT point at the production witness. The
//    first run of these tests wrote 9 rows into
//    /opt/scruple-witness/witness.db, because pointing the app at a
//    throwaway SQLite says nothing about the second database behind it.
//    Enforced below, and belt-and-braces the production witness now
//    refuses 'tenant:' project ids outright.

import { spawn, type ChildProcess } from 'child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface Harness {
  base: string;
  dbPath: string;
  stop: () => Promise<void>;
  /** Mint a key directly in the DB. Returns the plaintext. */
  issueKey: (scopes: string[]) => string;
}

const PROD_WITNESS = /127\.0\.0\.1:5799|localhost:5799/;

export async function boot(opts: { port?: number } = {}): Promise<Harness> {
  const port = opts.port ?? 3100 + (process.pid % 400);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scruple-int-'));
  const dbPath = path.join(dir, 'test.db');

  // Rule 2. A witness URL that resolves to the production service is
  // refused outright rather than defaulted away, because the default IS
  // the production service.
  const witnessUrl = process.env.WITNESS_SERVER_URL ?? '';
  if (witnessUrl === '' || PROD_WITNESS.test(witnessUrl)) {
    // Point at a port nothing listens on. The witness call then fails,
    // the leaf lands with witnessed:false, and that is a legitimate state
    // these tests assert on. Far better than silently writing evidence
    // into a production audit log.
    process.env.WITNESS_SERVER_URL = 'http://127.0.0.1:1';
  }

  process.env.SCRUPLE_DB_PATH = dbPath;

  const { runMigrations } = await import('../../lib/db/migrate');
  runMigrations(false);

  const proc: ChildProcess = spawn(
    'npx', ['next', 'dev', '-p', String(port)],
    {
      cwd: path.resolve(__dirname, '..', '..'),
      env: { ...process.env, SCRUPLE_DB_PATH: dbPath },
      stdio: 'ignore',
    },
  );

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 90_000;
  for (;;) {
    if (Date.now() > deadline) {
      proc.kill();
      throw new Error('Next did not become ready within 90s');
    }
    try {
      const r = await fetch(`${base}/api/v2/capabilities?host=blender&mime=image/png`);
      if (r.ok) break;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }

  const { conn } = await import('../../lib/db/sqlite');

  return {
    base,
    dbPath,
    issueKey(scopes: string[]) {
      const plaintext = `sk_test_${crypto.randomBytes(32).toString('base64url')}`;
      conn()
        .prepare(
          `INSERT INTO api_keys (id, user_id, key_hash, key_prefix, scopes_json, label, created_at)
           VALUES (?, 'tenant-int', ?, ?, ?, 'integration', ?)`,
        )
        .run(
          crypto.randomUUID(),
          crypto.createHash('sha256').update(plaintext).digest('hex'),
          plaintext.slice(0, 12),
          JSON.stringify(scopes),
          Math.floor(Date.now() / 1000),
        );
      return plaintext;
    },
    async stop() {
      proc.kill();
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

export async function ensureUser(): Promise<void> {
  const { conn } = await import('../../lib/db/sqlite');
  conn()
    .prepare(`INSERT OR IGNORE INTO users (id, email) VALUES ('tenant-int','int@example.com')`)
    .run();
}

export interface ApiResult<T = any> { status: number; body: T }

export function api(base: string, token?: string) {
  return async function call<T = any>(
    method: string, pathname: string, body?: unknown,
  ): Promise<ApiResult<T>> {
    const res = await fetch(`${base}/api/v2${pathname}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let parsed: any = null;
    try { parsed = await res.json(); } catch { parsed = null; }
    return { status: res.status, body: parsed };
  };
}

export const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
