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

export async function GET(req: NextRequest) {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) {
    // Bounce to login, preserving the original next-after-mint so the
    // login page can come back here once the cookie session is set.
    const next = safeNext(new URL(req.url).searchParams.get('next'));
    const loginUrl = new URL('/login', req.url);
    loginUrl.searchParams.set(
      'callbackUrl',
      `/api/auth/keys/fusion-mint?next=${encodeURIComponent(next)}`,
    );
    return NextResponse.redirect(loginUrl);
  }

  const url = new URL(req.url);
  const next = safeNext(url.searchParams.get('next'));

  // Issue the key. We label it so the user can identify + revoke it in
  // the Settings → API Keys page later.
  const issued = issueApiKey(userId, {
    label: `fusion-addin (${new Date().toISOString().slice(0, 10)})`,
    scopes: ['fusion'],
  });

  const target = new URL(next, req.url);
  target.searchParams.set('token', issued.plaintext);
  return NextResponse.redirect(target);
}
