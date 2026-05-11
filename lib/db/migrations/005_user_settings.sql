-- Migration 005: per-user app settings (IPFS gateway, pinning service,
-- ipfs/pinata credentials, future preferences).
--
-- JSON blob keyed by user_id. Encrypted fields (pinata keys, etc.) use
-- the AES-256-GCM helper in lib/auth/encryption.ts and are stored
-- pre-encrypted in the JSON value before write.

CREATE TABLE IF NOT EXISTS user_settings (
  user_id     TEXT PRIMARY KEY,
  settings    TEXT NOT NULL DEFAULT '{}',  -- JSON
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
