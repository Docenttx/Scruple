// /v2 authentication — bearer API key, scopes ENFORCED.
//
// Canon decision D-2. The estate had five mechanisms across four API
// generations:
//
//   tenant Bearer + HMAC          /api/v1/log*      (the official SDK
//                                                    never sent the HMAC,
//                                                    so it always 401'd)
//   session-or-bearer             c2pa/sign, witness/cad, lock/chain
//   session cookie ONLY           lock/local, workflow/validate, ...
//                                 — a silent 401 for every plugin, whose
//                                 clients all assume bearer works
//   bespoke bearer + lookup       scruple/witness/{adobe,photoshop}
//   one global shared secret      apps/kohya/witness
//
// Here there is one. Session cookies authenticate the browser UI and are
// never accepted on a /v2 route: a cookie proves a human is at a
// keyboard, which is not what a plugin is, and accepting both means
// neither is really required.
//
// Scopes were already stored in api_keys.scopes_json and returned by
// /api/auth/keys — and never checked anywhere. That made them
// documentation. requireScope() is the difference.

import crypto from 'node:crypto';
import type { NextRequest } from 'next/server';
import { conn } from '@/lib/db/sqlite';
import { v2Error } from './http';

export const V2_SCOPES = ['baseline:write', 'witness:write', 'mark:write', 'read'] as const;
export type V2Scope = (typeof V2_SCOPES)[number];

export interface V2Principal {
  userId: string;
  keyId: string;
  scopes: V2Scope[];
}

interface KeyRow {
  id: string;
  user_id: string;
  scopes_json: string | null;
  expires_at: number | null;
  revoked_at: number | null;
}

function sha256Hex(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function bearer(req: NextRequest | Request): string | null {
  const h = req.headers.get('authorization');
  if (!h) return null;
  const m = /^bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : null;
}

/**
 * Resolve the caller. Returns null for any failure — the route turns
 * that into a 401. Deliberately does NOT distinguish "no key" from "bad
 * key" from "expired key" in the response: that difference is useful to
 * an attacker enumerating keys and useless to a legitimate client, which
 * cannot act differently on any of them.
 */
export function principalFrom(req: NextRequest | Request): V2Principal | null {
  const token = bearer(req);
  if (!token) return null;

  const row = conn()
    .prepare(
      `SELECT id, user_id, scopes_json, expires_at, revoked_at
         FROM api_keys
        WHERE key_hash = ? AND revoked_at IS NULL`,
    )
    .get(sha256Hex(token)) as KeyRow | undefined;
  if (!row) return null;
  if (row.expires_at !== null && row.expires_at < Math.floor(Date.now() / 1000)) return null;

  let scopes: V2Scope[];
  if (row.scopes_json === null) {
    // A key issued before scopes were enforced. Granting it everything
    // would silently defeat the point of enforcing them; granting it
    // nothing would break every existing dev key at once. Read-only is
    // the honest middle: the key still works for anything that cannot
    // change state, and the failure on a write names the missing scope,
    // so the fix is obvious rather than mysterious.
    scopes = ['read'];
  } else {
    try {
      const parsed = JSON.parse(row.scopes_json) as unknown;
      scopes = Array.isArray(parsed)
        ? (parsed.filter((s): s is V2Scope =>
            (V2_SCOPES as readonly string[]).includes(s as string),
          ))
        : ['read'];
    } catch {
      scopes = ['read'];
    }
  }

  try {
    conn()
      .prepare(`UPDATE api_keys SET last_used_at = ? WHERE id = ?`)
      .run(Math.floor(Date.now() / 1000), row.id);
  } catch {
    // best-effort; never block a request on telemetry
  }

  return { userId: row.user_id, keyId: row.id, scopes };
}

export function hasScope(p: V2Principal, scope: V2Scope): boolean {
  return p.scopes.includes(scope);
}

/**
 * The guard every /v2 route starts with.
 *
 *   const gate = requireScope(req, 'witness:write');
 *   if ('response' in gate) return gate.response;
 *   const { principal } = gate;
 */
export function requireScope(
  req: NextRequest | Request,
  scope: V2Scope,
): { principal: V2Principal } | { response: ReturnType<typeof v2Error> } {
  const principal = principalFrom(req);
  if (!principal) {
    return {
      response: v2Error(
        'unauthorized',
        'Present a Scruple API key as `Authorization: Bearer sk_...`. Session cookies are not accepted on /v2 routes.',
      ),
    };
  }
  if (!hasScope(principal, scope)) {
    return {
      response: v2Error(
        'forbidden_scope',
        `This API key does not carry the "${scope}" scope. Issue a new key with it, or add it to this one.`,
        { required: scope, held: principal.scopes },
      ),
    };
  }
  return { principal };
}
