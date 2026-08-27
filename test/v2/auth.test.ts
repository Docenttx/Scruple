// Scope enforcement (canon D-2).
//
// api_keys.scopes_json has existed since migration 023 and has never been
// checked anywhere. These tests exist so that stays fixed.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// SCRUPLE_DB_PATH must be set BEFORE lib/db/sqlite is loaded — it reads
// the path at module scope. Static imports hoist above any assignment
// here, so the test runner sets it (see the `test:v2` npm script). If it
// is unset we refuse to run rather than quietly migrating the real
// database.
if (!process.env.SCRUPLE_DB_PATH || !/tmp|test/i.test(process.env.SCRUPLE_DB_PATH)) {
  throw new Error(
    'Refusing to run: set SCRUPLE_DB_PATH to a throwaway path first. ' +
      'Use `npm run test:v2`.',
  );
}
const TMP = path.dirname(process.env.SCRUPLE_DB_PATH);

import { runMigrations } from '../../lib/db/migrate';
import { conn } from '../../lib/db/sqlite';
import { requireScope, principalFrom } from '../../lib/v2/auth';

function makeKey(scopes: string[] | null, opts: { expired?: boolean; revoked?: boolean } = {}) {
  const plaintext = `sk_test_${crypto.randomBytes(32).toString('base64url')}`;
  const hash = crypto.createHash('sha256').update(plaintext).digest('hex');
  const id = crypto.randomUUID();
  conn()
    .prepare(
      `INSERT INTO api_keys (id, user_id, key_hash, key_prefix, scopes_json, label, expires_at, revoked_at)
       VALUES (?, 'tenant-1', ?, ?, ?, 'test', ?, ?)`,
    )
    .run(
      id, hash, plaintext.slice(0, 12),
      scopes ? JSON.stringify(scopes) : null,
      opts.expired ? Math.floor(Date.now() / 1000) - 60 : null,
      opts.revoked ? Math.floor(Date.now() / 1000) - 60 : null,
    );
  return plaintext;
}

const reqWith = (token?: string) =>
  new Request('https://scruple.ai/api/v2/witness', {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });

before(() => {
  runMigrations(false);
  conn().prepare(`INSERT INTO users (id, email) VALUES ('tenant-1','t@example.com')`).run();
});

after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('bearer only', () => {
  test('no credential is rejected', () => {
    const r = requireScope(reqWith(), 'witness:write');
    assert.ok('response' in r);
  });

  test('a session cookie is not an alternative on /v2', () => {
    const req = new Request('https://scruple.ai/api/v2/witness', {
      headers: { cookie: 'next-auth.session-token=whatever' },
    });
    const r = requireScope(req, 'read');
    assert.ok('response' in r, 'cookies must not authenticate a plugin route');
  });
});

describe('scopes are enforced, not decorative', () => {
  test('a key with the scope passes', () => {
    const k = makeKey(['witness:write']);
    const r = requireScope(reqWith(k), 'witness:write');
    assert.ok('principal' in r);
    assert.equal(r.principal.userId, 'tenant-1');
  });

  test('a key without the scope is refused', () => {
    const k = makeKey(['read']);
    const r = requireScope(reqWith(k), 'mark:write');
    assert.ok('response' in r);
    assert.equal(r.response.status, 403);
  });

  test('the refusal names the missing scope, so the fix is obvious', async () => {
    const k = makeKey(['read']);
    const r = requireScope(reqWith(k), 'baseline:write');
    assert.ok('response' in r);
    const body = await r.response.json();
    assert.match(body.error.message, /baseline:write/);
    assert.deepEqual(body.error.detail.held, ['read']);
  });
});

describe('legacy keys issued before scopes were enforced', () => {
  test('are read-only rather than all-powerful', () => {
    const k = makeKey(null);
    assert.ok('principal' in requireScope(reqWith(k), 'read'));
    assert.ok('response' in requireScope(reqWith(k), 'witness:write'));
  });

  test('malformed scopes_json degrades to read, never to full access', () => {
    const plaintext = `sk_test_${crypto.randomBytes(32).toString('base64url')}`;
    const hash = crypto.createHash('sha256').update(plaintext).digest('hex');
    conn()
      .prepare(
        `INSERT INTO api_keys (id, user_id, key_hash, key_prefix, scopes_json, label)
         VALUES (?, 'tenant-1', ?, ?, '{not json', 'bad')`,
      )
      .run(crypto.randomUUID(), hash, plaintext.slice(0, 12));
    const p = principalFrom(reqWith(plaintext));
    assert.deepEqual(p?.scopes, ['read']);
  });

  test('an unrecognised scope string is dropped, not honoured', () => {
    const k = makeKey(['witness:write', 'admin:everything']);
    const p = principalFrom(reqWith(k));
    assert.deepEqual(p?.scopes, ['witness:write']);
  });
});

describe('key lifecycle', () => {
  test('expired keys do not authenticate', () => {
    const k = makeKey(['read'], { expired: true });
    assert.equal(principalFrom(reqWith(k)), null);
  });

  test('revoked keys do not authenticate', () => {
    const k = makeKey(['read'], { revoked: true });
    assert.equal(principalFrom(reqWith(k)), null);
  });

  test('an unknown token does not authenticate', () => {
    assert.equal(principalFrom(reqWith('sk_test_nope')), null);
  });
});
