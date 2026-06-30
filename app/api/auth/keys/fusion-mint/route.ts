// GET /api/auth/keys/fusion-mint?next=/embed/fusion
//   → mints a 'fusion-addin' labeled API key for the cookie-authed user
//     and 302s to <next> with `?token=<key>` appended.
//
// Used by the Fusion add-in signin flow: palette opens scruple-web's login
// page when no token is present; after Google/Autodesk auth lands a cookie
// session, the login page redirects through here to get an API key minted
// and bounce back into the palette with the token in the URL.
//
// Auth: NextAuth session cookie ONLY. Bearer-authed callers get 401 — we
// don't want an existing API key to mint another one (privilege escalation
// path if a key leaks).
//
// `next` is constrained to relative paths beginning with `/` to prevent
// open-redirect — the caller cannot redirect us to an arbitrary origin
// with a freshly minted key in the URL.

import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth/auth';
import { issueApiKey } from '@/lib/auth/apiKey';
import { conn } from '@/lib/db/sqlite';

export const dynamic = 'force-dynamic';

const DEFAULT_NEXT = '/embed/fusion';

function safeNext(raw: string | null): string {
  if (!raw) return DEFAULT_NEXT;
  // Must be a relative URL starting with a single '/'. Reject '//' or
  // anything that could be interpreted as a scheme-relative URL.
  if (!raw.startsWith('/') || raw.startsWith('//')) return DEFAULT_NEXT;
  // Optional path-traversal guard
  if (raw.includes('..')) return DEFAULT_NEXT;
  return raw;
}

// Resolve the canonical public origin for redirects. Behind Cloudflare,
// req.url reflects the upstream host (localhost:3001) which won't work
// for clients (Fusion's Chromium, browsers) on the public side. Prefer
// NEXTAUTH_URL when set; fall back to x-forwarded-host header; lastly
// fall back to req.url's origin (dev/local only).
function publicOrigin(req: NextRequest): string {
  const fromEnv = process.env.NEXTAUTH_URL;
  if (fromEnv) {
    try {
      return new URL(fromEnv).origin;
    } catch {
      // fall through
    }
  }
  const fwdHost = req.headers.get('x-forwarded-host');
  const fwdProto = req.headers.get('x-forwarded-proto') || 'https';
  if (fwdHost) return `${fwdProto}://${fwdHost}`;
  return new URL(req.url).origin;
}

export async function GET(req: NextRequest) {
  const origin = publicOrigin(req);
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) {
    const next = safeNext(new URL(req.url).searchParams.get('next'));
    const loginUrl = new URL('/login', origin);
    loginUrl.searchParams.set(
      'callbackUrl',
      `/api/auth/keys/fusion-mint?next=${encodeURIComponent(next)}`,
    );
    return NextResponse.redirect(loginUrl);
  }

  const url = new URL(req.url);
  const next = safeNext(url.searchParams.get('next'));

  // First-run check: if the user hasn't completed onboarding, route them
  // through /onboarding first.
  const row = conn()
    .prepare('SELECT onboarded_at FROM users WHERE id = ?')
    .get(userId) as { onboarded_at: string | null } | undefined;
  if (!row?.onboarded_at) {
    const onboardingUrl = new URL('/onboarding', origin);
    onboardingUrl.searchParams.set(
      'next',
      `/api/auth/keys/fusion-mint?next=${encodeURIComponent(next)}`,
    );
    return NextResponse.redirect(onboardingUrl);
  }

  const issued = issueApiKey(userId, {
    label: `fusion-addin (${new Date().toISOString().slice(0, 10)})`,
    scopes: ['fusion'],
  });

  const target = new URL(next, origin);
  target.searchParams.set('token', issued.plaintext);
  return NextResponse.redirect(target);
}
