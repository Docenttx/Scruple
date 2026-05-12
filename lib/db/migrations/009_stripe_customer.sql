-- Migration 009 (pivot clone-4): per-user Stripe customer id.
-- Created lazily on first Stripe interaction. Owned by the witness
-- server's Stripe SDK; scruple-web only stores the foreign id.

ALTER TABLE users ADD COLUMN stripe_customer_id TEXT;
CREATE INDEX IF NOT EXISTS idx_users_stripe_customer ON users(stripe_customer_id);
