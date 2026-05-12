-- Migration 008 (pivot): per-user Google Drive OAuth tokens.
-- One row per user. Tokens stored encrypted via AES-GCM (encryptSecret).
-- Access tokens refresh on demand via lib/storage/gdrive client.

CREATE TABLE IF NOT EXISTS gdrive_tokens (
  user_id            TEXT PRIMARY KEY,
  access_token_enc   TEXT NOT NULL,                    -- AES-GCM ciphertext
  refresh_token_enc  TEXT NOT NULL,                    -- AES-GCM ciphertext
  expires_at         INTEGER NOT NULL,                 -- unix seconds
  user_email         TEXT,
  user_name          TEXT,
  scope              TEXT,
  connected_at       TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_gdrive_tokens_user ON gdrive_tokens(user_id);
