// User-plan resolver.
//
// scruple-web doesn't have a subscriptions table yet — Stripe is wired
// for one-time payments on chain locks but not for recurring tier
// gating. This module provides the interface every plan-gated feature
// expects (`'free' | 'pro' | 'enterprise'`), with an env-var driven
// implementation today and a clean swap-out for the real subscriptions
// table when it lands.
//
// To grant a user a tier without a paying mechanism (testing,
// founder-grants, comp accounts):
//
//   SCRUPLE_PRO_EMAILS=alice@example.com,bob@example.com
//   SCRUPLE_ENTERPRISE_EMAILS=carol@example.com
//
// Emails are lowercased, comma-separated, trimmed.

import { conn } from '@/lib/db/sqlite';
import type { UserPlan } from './machines';

interface UserRow {
  email: string;
}

function readListFromEnv(envVar: string): Set<string> {
  return new Set(
    (process.env[envVar] ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * Resolve a user's plan. Defaults to 'free'. Reads from env-grants
 * by email; falls back to free.
 *
 * TODO: when the subscriptions table lands, replace the env lookup
 * with a SELECT on subscriptions.tier WHERE user_id = ? AND active.
 */
export function getUserPlan(userId: string): UserPlan {
  const row = conn()
    .prepare(`SELECT email FROM users WHERE id = ?`)
    .get(userId) as UserRow | undefined;
  if (!row) return 'free';
  const email = row.email.toLowerCase();
  // Enterprise wins over pro if a user is listed in both.
  if (readListFromEnv('SCRUPLE_ENTERPRISE_EMAILS').has(email)) return 'enterprise';
  if (readListFromEnv('SCRUPLE_PRO_EMAILS').has(email)) return 'pro';
  return 'free';
}
