// NextAuth adapter backed by our better-sqlite3 connection.
// Matches the @auth/core adapter contract (snake_case → camelCase mapping).

import type { Adapter, AdapterUser, AdapterAccount, AdapterSession, VerificationToken } from '@auth/core/adapters';
import { nanoid } from 'nanoid';
import { conn } from '@/lib/db/sqlite';

function mapUser(row: any): AdapterUser | null {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    emailVerified: row.email_verified ? new Date(row.email_verified) : null,
    name: row.name,
    image: row.image,
  };
}

export function SqliteAdapter(): Adapter {
  const db = conn();

  return {
    async createUser(user) {
      const id = nanoid();
      db.prepare(
        `INSERT INTO users (id, name, email, email_verified, image) VALUES (?, ?, ?, ?, ?)`,
      ).run(id, user.name ?? null, user.email, user.emailVerified?.toISOString() ?? null, user.image ?? null);
      const row = db.prepare(`SELECT * FROM users WHERE id = ?`).get(id);
      return mapUser(row)!;
    },

    async getUser(id) {
      return mapUser(db.prepare(`SELECT * FROM users WHERE id = ?`).get(id));
    },

    async getUserByEmail(email) {
      return mapUser(db.prepare(`SELECT * FROM users WHERE email = ?`).get(email));
    },

    async getUserByAccount({ provider, providerAccountId }) {
      const row = db
        .prepare(
          `SELECT u.* FROM users u
           JOIN accounts a ON a.user_id = u.id
           WHERE a.provider = ? AND a.provider_account_id = ?`,
        )
        .get(provider, providerAccountId);
      return mapUser(row);
    },

    async updateUser(user) {
      db.prepare(
        `UPDATE users SET name = COALESCE(?, name), email = COALESCE(?, email),
         email_verified = COALESCE(?, email_verified), image = COALESCE(?, image)
         WHERE id = ?`,
      ).run(
        user.name ?? null,
        user.email ?? null,
        user.emailVerified?.toISOString() ?? null,
        user.image ?? null,
        user.id,
      );
      const row = db.prepare(`SELECT * FROM users WHERE id = ?`).get(user.id);
      return mapUser(row)!;
    },

    async deleteUser(userId) {
      db.prepare(`DELETE FROM users WHERE id = ?`).run(userId);
    },

    async linkAccount(account: AdapterAccount) {
      db.prepare(
        `INSERT INTO accounts (id, user_id, type, provider, provider_account_id,
          refresh_token, access_token, expires_at, token_type, scope, id_token, session_state)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        nanoid(),
        account.userId,
        account.type,
        account.provider,
        account.providerAccountId,
        account.refresh_token ?? null,
        account.access_token ?? null,
        account.expires_at ?? null,
        account.token_type ?? null,
        account.scope ?? null,
        account.id_token ?? null,
        account.session_state as string ?? null,
      );
      return account;
    },

    async unlinkAccount({ provider, providerAccountId }) {
      db.prepare(
        `DELETE FROM accounts WHERE provider = ? AND provider_account_id = ?`,
      ).run(provider, providerAccountId);
    },

    async createSession(session) {
      db.prepare(
        `INSERT INTO sessions (id, user_id, session_token, expires) VALUES (?, ?, ?, ?)`,
      ).run(nanoid(), session.userId, session.sessionToken, session.expires.toISOString());
      return session;
    },

    async getSessionAndUser(sessionToken) {
      const row: any = db
        .prepare(
          `SELECT s.id as s_id, s.user_id, s.session_token, s.expires,
                  u.id as u_id, u.name, u.email, u.email_verified, u.image
           FROM sessions s JOIN users u ON u.id = s.user_id
           WHERE s.session_token = ?`,
        )
        .get(sessionToken);
      if (!row) return null;
      return {
        session: {
          sessionToken: row.session_token,
          userId: row.user_id,
          expires: new Date(row.expires),
        } as AdapterSession,
        user: mapUser({
          id: row.u_id,
          email: row.email,
          email_verified: row.email_verified,
          name: row.name,
          image: row.image,
        })!,
      };
    },

    async updateSession(session) {
      // @auth/core passes a Partial — typically only { sessionToken, expires }
      // for rolling-expiry updates. Only UPDATE the columns that were actually
      // provided so we never null out user_id (NOT NULL in schema).
      const sets: string[] = [];
      const args: unknown[] = [];
      if (session.expires !== undefined) {
        sets.push('expires = ?');
        args.push(session.expires.toISOString());
      }
      if (session.userId !== undefined) {
        sets.push('user_id = ?');
        args.push(session.userId);
      }
      if (sets.length > 0) {
        args.push(session.sessionToken);
        db.prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE session_token = ?`).run(...args);
      }
      const row: any = db
        .prepare(`SELECT user_id, session_token, expires FROM sessions WHERE session_token = ?`)
        .get(session.sessionToken);
      if (!row) return null;
      return {
        sessionToken: row.session_token,
        userId: row.user_id,
        expires: new Date(row.expires),
      };
    },

    async deleteSession(sessionToken) {
      db.prepare(`DELETE FROM sessions WHERE session_token = ?`).run(sessionToken);
    },

    async createVerificationToken(token) {
      db.prepare(`INSERT INTO verification_tokens (identifier, token, expires) VALUES (?, ?, ?)`).run(
        token.identifier,
        token.token,
        token.expires.toISOString(),
      );
      return token;
    },

    async useVerificationToken({ identifier, token }) {
      const row: any = db
        .prepare(`SELECT identifier, token, expires FROM verification_tokens
                  WHERE identifier = ? AND token = ?`)
        .get(identifier, token);
      if (!row) return null;
      db.prepare(`DELETE FROM verification_tokens WHERE identifier = ? AND token = ?`).run(
        identifier,
        token,
      );
      return {
        identifier: row.identifier,
        token: row.token,
        expires: new Date(row.expires),
      } as VerificationToken;
    },
  };
}
