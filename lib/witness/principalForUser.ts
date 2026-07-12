// Get-or-create the audit-API Principal for a Scruple end-user.
//
// Every Scruple user is a Principal (see canonical design §3.3 —
// three-party geometry). When they sign C2PA content, the sign event
// is emitted under a delegation from their Principal to TEN_scruple.
//
// Principals are minted lazily on first sign (this file). The read key
// is generated + hashed here; the plaintext isn't returned to the user
// until the principal-onboarding UX lands under WO-14 (Sprint 2). For
// Sprint 1 the user simply doesn't have direct access yet — the
// witness chain still works for the sign event, which is what matters
// for the C2PA-signer L2 evidence.

import { createHash, randomBytes } from 'node:crypto';
import { conn } from '@/lib/db/sqlite';

const TENANT_ID = 'TEN_scruple';

function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function shortHex(): string {
  return createHash('sha256')
    .update(randomBytes(16))
    .digest('hex')
    .slice(0, 8);
}

interface UserRow {
  id: string;
  principal_id: string | null;
  name: string | null;
  email: string | null;
}

/**
 * Return the principal_id for a user, minting one if needed.
 * Also ensures a delegation to TEN_scruple exists (active).
 *
 * Runs inside the request lifecycle — the sign route calls this before
 * dispatching to signAsset(). Idempotent.
 */
export function ensurePrincipalForUser(userId: string): { principalId: string; created: boolean } {
  const db = conn();
  const user = db
    .prepare(`SELECT id, principal_id, name, email FROM users WHERE id = ?`)
    .get(userId) as UserRow | undefined;
  if (!user) {
    throw new Error(`user ${userId} not found`);
  }
  if (user.principal_id) {
    // Ensure delegation still exists + is active. If not, restore it.
    const del = db
      .prepare(
        `SELECT status FROM delegations WHERE principal_id = ? AND tenant_id = ?`,
      )
      .get(user.principal_id, TENANT_ID) as { status: string } | undefined;
    if (!del) {
      // Never delegated — mint one now.
      db.prepare(
        `INSERT INTO delegations (delegation_id, principal_id, tenant_id, status)
         VALUES (?, ?, ?, 'active')`,
      ).run(`DLG_${shortHex()}`, user.principal_id, TENANT_ID);
    } else if (del.status !== 'active') {
      // Delegation exists but revoked — do NOT auto-reactivate. The
      // principal explicitly revoked; sign will fail delegation_inactive
      // at ingest, which is correct.
    }
    return { principalId: user.principal_id, created: false };
  }
  // Mint a new principal.
  const principalId = `PRN_${shortHex()}`;
  const readKey = `pk_${randomBytes(24).toString('base64url')}`;
  const readKeyHash = sha256Hex(readKey);
  const displayName = user.name || user.email || 'Scruple user';
  db.prepare(
    `INSERT INTO principals (principal_id, name, read_key_hash, user_id, contact_email)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(principalId, displayName, readKeyHash, userId, user.email);
  db.prepare(
    `INSERT INTO delegations (delegation_id, principal_id, tenant_id, status)
     VALUES (?, ?, ?, 'active')`,
  ).run(`DLG_${shortHex()}`, principalId, TENANT_ID);
  db.prepare(`UPDATE users SET principal_id = ? WHERE id = ?`).run(principalId, userId);
  // NOTE: the readKey plaintext is discarded here — Sprint 1 doesn't
  // expose the principal read API yet. WO-14 wires the onboarding email
  // that delivers the plaintext to the user's contact address.
  return { principalId, created: true };
}
