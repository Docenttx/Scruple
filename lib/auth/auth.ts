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

export const { handlers, signIn, signOut, auth } = NextAuth({
  adapter: SqliteAdapter(),
  session: { strategy: 'database' },
  providers: [
    ...(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
      ? [Google({ clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET })]
      : []),
  ],
  callbacks: {
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
