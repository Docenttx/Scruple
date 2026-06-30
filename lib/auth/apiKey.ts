// API key authentication.
//
// Desktop apps (the Fusion add-in is the first; future plugins are next)
// authenticate by presenting a Bearer token in the Authorization header.
// The token is "sk_<env>_<base64url(32 bytes)>"; we store only its SHA-256.
//
// Routes call `requireUser(req)` instead of `await auth()` to get a userId
// that's resolved from either NextAuth cookie OR API key. The two paths
// converge — every downstream code path sees a normal users.id.
//
// Migration 023 is required.

import crypto from 'node:crypto';
import type { NextRequest } from 'next/server';
import { auth } from './auth';
import { conn } from '@/lib/db/sqlite';

const KEY_PREFIX = process.env.SCRUPLE_API_KEY_ENV === 'live' ? 'sk_live_' : 'sk_test_';

export interface AuthedUser {
  id: string;
  via: 'session' | 'api_key';
  keyId?: string;
}

export interface ApiKeyRow {
  id: string;
  user_id: string;
  key_hash: string;
  key_prefix: string;
  scopes_json: string | null;
  label: string | null;
  created_at: number;
  expires_at: number | null;
  last_used_at: number | null;
  revoked_at: number | null;
}

function sha256Hex(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

export function issueApiKey(
  userId: string,
  opts: { label?: string; scopes?: string[]; expiresAt?: number } = {},
): { id: string; plaintext: string; prefix: string } {
  const id = crypto.randomUUID();
  const secret = crypto.randomBytes(32).toString('base64url');
  const plaintext = `${KEY_PREFIX}${secret}`;
  const hash = sha256Hex(plaintext);
  // Store the first 12 chars of the plaintext as a UX hint so the issued
  // listing can show "sk_test_abcd…" without keeping the secret around.
  const prefix = plaintext.slice(0, 12);
  conn()
    .prepare(
      `INSERT INTO api_keys (id, user_id, key_hash, key_prefix, scopes_json, label, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      userId,
      hash,
      prefix,
      opts.scopes ? JSON.stringify(opts.scopes) : null,
      opts.label ?? null,
      opts.expiresAt ?? null,
    );
  return { id, plaintext, prefix };
}

export function revokeApiKey(userId: string, keyId: string): boolean {
  const now = Math.floor(Date.now() / 1000);
  const res = conn()
    .prepare(`UPDATE api_keys SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL`)
    .run(now, keyId, userId);
  return res.changes > 0;
}

export function listApiKeys(userId: string): Array<Omit<ApiKeyRow, 'key_hash'>> {
  const rows = conn()
    .prepare(
      `SELECT id, user_id, key_prefix, scopes_json, label, created_at, expires_at, last_used_at, revoked_at
       FROM api_keys
       WHERE user_id = ?
       ORDER BY created_at DESC`,
    )
    .all(userId) as Array<Omit<ApiKeyRow, 'key_hash'>>;
  return rows;
}

function lookupApiKey(plaintext: string): ApiKeyRow | null {
  const hash = sha256Hex(plaintext);
  const row = conn()
    .prepare(
      `SELECT id, user_id, key_hash, key_prefix, scopes_json, label,
              created_at, expires_at, last_used_at, revoked_at
       FROM api_keys
       WHERE key_hash = ? AND revoked_at IS NULL`,
    )
    .get(hash) as ApiKeyRow | undefined;
  if (!row) return null;
  if (row.expires_at !== null && row.expires_at < Math.floor(Date.now() / 1000)) return null;
  return row;
}

function touchLastUsed(keyId: string): void {
  const now = Math.floor(Date.now() / 1000);
  try {
    conn().prepare(`UPDATE api_keys SET last_used_at = ? WHERE id = ?`).run(now, keyId);
  } catch {
    // best-effort; don't block the request on this
  }
}

function bearerFromRequest(req: NextRequest | Request): string | null {
  const h = req.headers.get('authorization') || req.headers.get('Authorization');
  if (!h) return null;
  const m = /^bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : null;
}

/** Resolve the caller to a user via NextAuth cookie OR API key bearer.
 * Returns null if neither yields a user. Designed to be a drop-in for
 * `const session = await auth()` patterns:
 *
 *   const me = await requireUser(req);
 *   if (!me) return NextResponse.json({error:'Unauthorized'}, {status:401});
 *   const userId = me.id;
 */
export async function requireUser(req: NextRequest | Request): Promise<AuthedUser | null> {
  const bearer = bearerFromRequest(req);
  if (bearer) {
    const row = lookupApiKey(bearer);
    if (row) {
      touchLastUsed(row.id);
      return { id: row.user_id, via: 'api_key', keyId: row.id };
    }
    // Bearer was presented but invalid → don't fall back to cookie.
    // Surfacing a clear 401 is better than silently using a stale session.
    return null;
  }
  const session = await auth();
  const id = (session?.user as { id?: string } | undefined)?.id;
  if (!id) return null;
  return { id, via: 'session' };
}
