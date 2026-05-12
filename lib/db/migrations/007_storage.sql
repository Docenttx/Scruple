-- Migration 007 (pivot): per-user storage provider config + sync log.
-- BYOS per D-017 — Scruple stores hash + pointer only.

CREATE TABLE IF NOT EXISTS storage_providers (
  user_id          TEXT PRIMARY KEY,
  provider         TEXT NOT NULL,                  -- 'gdrive' | 'onedrive' | 'github'
  encrypted_creds  TEXT NOT NULL,                  -- JSON, AES-GCM encrypted access/refresh tokens
  root_folder      TEXT,                           -- provider-native id ('appDataFolder' for Drive, etc.)
  metadata         TEXT NOT NULL DEFAULT '{}',     -- arbitrary provider-specific extras (account email, etc.)
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS storage_sync_log (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id          TEXT NOT NULL,
  iteration_id     INTEGER,
  operation        TEXT NOT NULL,                  -- 'upload' | 'read' | 'delete'
  provider         TEXT NOT NULL,
  status           TEXT NOT NULL,                  -- 'ok' | 'err'
  detail           TEXT,                           -- error message or url
  size_bytes       INTEGER,
  ts               TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_storage_sync_user ON storage_sync_log(user_id, ts);
CREATE INDEX IF NOT EXISTS idx_storage_sync_iter ON storage_sync_log(iteration_id);
