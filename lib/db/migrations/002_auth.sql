-- Migration 002: NextAuth tables (users, accounts, sessions, verification tokens)
--
-- Schema follows next-auth's expected structure (id is text uuid).

CREATE TABLE IF NOT EXISTS users (
  id                TEXT PRIMARY KEY,
  name              TEXT,
  email             TEXT NOT NULL UNIQUE,
  email_verified    TEXT,                 -- ISO timestamp
  image             TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  -- Provider keys (encrypted, JSON dict {fal, comfydeploy})
  provider_keys     TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS accounts (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL,
  type                TEXT NOT NULL,          -- 'oauth' | 'email' | 'credentials'
  provider            TEXT NOT NULL,
  provider_account_id TEXT NOT NULL,
  refresh_token       TEXT,
  access_token        TEXT,
  expires_at          INTEGER,
  token_type          TEXT,
  scope               TEXT,
  id_token            TEXT,
  session_state       TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(provider, provider_account_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL,
  session_token     TEXT NOT NULL UNIQUE,
  expires           TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS verification_tokens (
  identifier        TEXT NOT NULL,
  token             TEXT NOT NULL,
  expires           TEXT NOT NULL,
  PRIMARY KEY (identifier, token)
);

CREATE INDEX IF NOT EXISTS idx_accounts_user        ON accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user        ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_token       ON sessions(session_token);
