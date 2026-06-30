-- Migration 025: user onboarding state.
--
-- Three new columns on users to track first-run setup:
--
--   onboarded_at       NULL = needs onboarding; ISO timestamp = done
--   tos_accepted_at    ISO timestamp the user accepted ToS / privacy
--   plan               'free' | 'starter' | 'pro' | 'enterprise' | 'pilot'
--
-- The post-OAuth NextAuth signIn callback redirects to /onboarding when
-- onboarded_at IS NULL. The onboarding page collects plan + Stripe
-- payment method + ToS acceptance, then sets onboarded_at + tos_accepted_at
-- and bounces back to the original destination.
--
-- Existing users (created before this migration) get onboarded_at backfilled
-- to created_at so they're treated as already onboarded — we don't want
-- to surprise existing dev users with a forced onboarding gate.

ALTER TABLE users ADD COLUMN onboarded_at TEXT;
ALTER TABLE users ADD COLUMN tos_accepted_at TEXT;
ALTER TABLE users ADD COLUMN plan TEXT NOT NULL DEFAULT 'free'
  CHECK (plan IN ('free','starter','pro','enterprise','pilot'));

-- Backfill: existing users are treated as already onboarded so we don't
-- force test@scruple.dev etc. through onboarding mid-session.
UPDATE users SET onboarded_at = created_at WHERE onboarded_at IS NULL;
UPDATE users SET tos_accepted_at = created_at WHERE tos_accepted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_users_onboarded ON users(onboarded_at);
