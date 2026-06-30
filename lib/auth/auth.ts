import NextAuth from 'next-auth';
import Google from 'next-auth/providers/google';
import { SqliteAdapter } from './db-adapter';
import { runMigrations } from '@/lib/db/migrate';

// Autodesk (APS) OAuth provider — manual NextAuth config since there's no
// first-party preset. The endpoints are Autodesk Platform Services'
// 3-legged OAuth: https://aps.autodesk.com/en/docs/oauth/v2/
//
// To enable, register a Web App at https://aps.autodesk.com/myapps:
//   - Callback URL: https://scruple.stooges.ai/api/auth/callback/autodesk
//   - Scopes: user-profile:read
// Then set AUTODESK_CLIENT_ID + AUTODESK_CLIENT_SECRET in .env.local.
//
// The strategic story for Fusion 360 users: signing in with Autodesk
// SSO lets the add-in inherit the user's already-authenticated Fusion
// identity. Zero-friction, brand-native, ID-tied-to-Fusion-Team.
const Autodesk = {
  id: 'autodesk' as const,
  name: 'Autodesk',
  type: 'oauth' as const,
  clientId: process.env.AUTODESK_CLIENT_ID,
  clientSecret: process.env.AUTODESK_CLIENT_SECRET,
  authorization: {
    url: 'https://developer.api.autodesk.com/authentication/v2/authorize',
    params: { scope: 'user-profile:read openid', response_type: 'code' },
  },
  token: 'https://developer.api.autodesk.com/authentication/v2/token',
  userinfo: 'https://api.userprofile.autodesk.com/userinfo',
  profile(profile: Record<string, unknown>) {
    return {
      id: String(profile.sub),
      name: String(profile.name ?? profile.preferred_username ?? ''),
      email: String(profile.email ?? ''),
      image: typeof profile.picture === 'string' ? profile.picture : null,
    };
  },
};

// Apply migrations on first import (idempotent). Server-only path.
if (typeof window === 'undefined') {
  try {
    runMigrations(false);
  } catch (e) {
    console.error('[auth] migrations failed at import:', e);
  }
}

// Identity gate. A Scruple deployment is dev or prod depending on which
// endpoints (RVN testnet vs mainnet, sk_test vs sk_live, arlocal vs
// arweave, etc.) it's pointed at — the code is identical. What separates
// dev from prod at runtime is WHO can sign in: the dev deployment
// whitelists known dev Google accounts; prod is open or has its own
// policy. SSH-originated callers use /api/dev/session (shared-secret
// gated) and never traverse this callback.
//
//   SCRUPLE_ALLOWED_EMAILS   comma-separated list of allowed addresses.
//                            If set, signin is gated to this list.
//                            If unset, all signins accepted (back-compat
//                            with un-gated deployments; logged as a
//                            warning so it shows up in any audit).
const ALLOWED_EMAILS = (process.env.SCRUPLE_ALLOWED_EMAILS ?? '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

export const { handlers, signIn, signOut, auth } = NextAuth({
  adapter: SqliteAdapter(),
  session: { strategy: 'database' },
  providers: [
    ...(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
      ? [Google({ clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET })]
      : []),
    ...(process.env.AUTODESK_CLIENT_ID && process.env.AUTODESK_CLIENT_SECRET
      ? [Autodesk]
      : []),
  ],
  callbacks: {
    async signIn({ user }) {
      if (ALLOWED_EMAILS.length === 0) {
        if (typeof window === 'undefined') {
          console.warn('[auth] SCRUPLE_ALLOWED_EMAILS not set — accepting any signin');
        }
        return true;
      }
      const email = (user?.email ?? '').toLowerCase();
      if (!email || !ALLOWED_EMAILS.includes(email)) {
        console.warn(`[auth] rejected signin for "${email || '(no email)'}" — not on allowed list`);
        return false;
      }
      return true;
    },
    session({ session, user }) {
      if (session.user && user) {
        (session.user as { id?: string }).id = user.id;
        // Surface onboarding state to client so the UI can route new users
        // through /onboarding before they can use anything else.
        const u = user as unknown as { onboarded_at?: string | null; plan?: string | null };
        (session.user as { onboarded?: boolean }).onboarded = !!u.onboarded_at;
        (session.user as { plan?: string }).plan = u.plan ?? 'free';
      }
      return session;
    },
  },
  pages: {
    signIn: '/login',
  },
  trustHost: true,
});
