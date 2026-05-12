// GET /api/dev/session?email=<addr>&secret=<shared>
//
// Development-only session minting endpoint for the scrupel test CLI.
// Inserts a row directly into the sessions table (NextAuth uses
// database strategy here, not JWT) and returns the raw session_token
// as the auth cookie.
//
// Hard-gated by:
//   - NODE_ENV must be 'development'
//   - process.env.SCRUPLE_DEV_AUTH must equal '1'
//   - ?secret= must match process.env.SCRUPLE_DEV_AUTH_SECRET
//
// If any gate fails → 404 (don't acknowledge the route in production).

import { NextRequest, NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { conn } from '@/lib/db/sqlite';

export const dynamic = 'force-dynamic';

const DEV_ENABLED =
  process.env.NODE_ENV === 'development' && process.env.SCRUPLE_DEV_AUTH === '1';

interface UserRow {
  id: string;
  email: string;
  name: string | null;
}

export async function GET(req: NextRequest) {
  if (!DEV_ENABLED) {
    return new NextResponse('Not found', { status: 404 });
  }
  const url = new URL(req.url);
  const email = url.searchParams.get('email') ?? 'test@scruple.dev';
  const secret = url.searchParams.get('secret') ?? '';
  const expected = process.env.SCRUPLE_DEV_AUTH_SECRET ?? '';
  if (!expected || secret !== expected) {
    return new NextResponse('Not found', { status: 404 });
  }

  const db = conn();
  let user = db.prepare(`SELECT id, email, name FROM users WHERE email = ?`).get(email) as
    | UserRow
    | undefined;
  if (!user) {
    const id = crypto.randomUUID();
    db.prepare(
      `INSERT INTO users (id, email, name, email_verified) VALUES (?, ?, ?, datetime('now'))`,
    ).run(id, email, email.split('@')[0]);
    user = { id, email, name: email.split('@')[0] };
  }

  // Insert a sessions row directly. NextAuth's database strategy looks
  // up the cookie value in the sessions table on every request.
  const sessionToken = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const sessionId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO sessions (id, user_id, session_token, expires) VALUES (?, ?, ?, ?)`,
  ).run(sessionId, user.id, sessionToken, expires);

  // NextAuth v5 selects the cookie name from NEXTAUTH_URL's scheme: an
  // https value → `__Secure-authjs.session-token`. The Secure flag on
  // the cookie itself only matters in browsers; CLIs (scrupel) speak
  // server-to-server so they can hold a __Secure-named cookie over HTTP
  // without issue.
  const useSecurePrefix = (process.env.NEXTAUTH_URL ?? '').startsWith('https://');
  const cookieName = useSecurePrefix
    ? '__Secure-authjs.session-token'
    : 'authjs.session-token';
  const cookie = `${cookieName}=${sessionToken}; Path=/; HttpOnly; SameSite=Lax`;

  return new NextResponse(
    JSON.stringify({ ok: true, userId: user.id, email: user.email, cookieName, sessionToken }),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': cookie,
      },
    },
  );
}
