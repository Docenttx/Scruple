-- Migration 022: Canvas / Scruple provenance tables
-- sessions     — token-based auth for canvas.scruple.ai (nginx auth_request)
-- scruple_artifacts — controlled copy of every witnessed output image

CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  created_at  TEXT DEFAULT (datetime('now')),
  expires_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user    ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- Controlled artifact store: one row per witnessed output image
-- storage_path is relative to the project root artifacts/ directory
CREATE TABLE IF NOT EXISTS scruple_artifacts (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL,
  prompt_id    TEXT,
  run_sequence INTEGER,
  filename     TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'image/png',
  size_bytes   INTEGER NOT NULL,
  storage_path TEXT NOT NULL,   -- relative path under artifacts/canvas/
  witnessed_at TEXT NOT NULL,
  created_at   TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_artifacts_project  ON scruple_artifacts(project_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_prompt   ON scruple_artifacts(prompt_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_hash     ON scruple_artifacts(content_hash);
