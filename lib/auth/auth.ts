import NextAuth from 'next-auth';
import Google from 'next-auth/providers/google';
import { SqliteAdapter } from './db-adapter';
import { runMigrations } from '@/lib/db/migrate';

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
      }
      return session;
    },
  },
  pages: {
    signIn: '/login',
  },
  trustHost: true,
});
