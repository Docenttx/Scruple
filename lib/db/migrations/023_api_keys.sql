-- Migration 023: API keys for desktop / non-browser clients.
--
-- Desktop add-ins (Fusion 360, future plugins) can't reliably maintain
-- NextAuth session cookies. They authenticate with Bearer tokens issued
-- here. Keys are tied to a user_id and carry an optional scope set.
--
-- key_hash: sha256(plaintext_key). The plaintext is shown to the user
-- exactly once at issue time, then the server keeps only the hash.
-- Format of the plaintext is "sk_<env>_<base64url(32 bytes)>" so the env
-- prefix is visible in logs without leaking the secret.
--
-- scopes_json: JSON array of strings. Empty/NULL = all-API scope (current
-- default). Reserved for future per-route scoping (e.g., 'witness',
-- 'lock', 'project:read').

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL,
  scopes_json TEXT,
  label TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at INTEGER,
  last_used_at INTEGER,
  revoked_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash) WHERE revoked_at IS NULL;
