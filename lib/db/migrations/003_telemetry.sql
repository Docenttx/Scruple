-- Migration 003: telemetry — one row per generation call (cost + duration).

CREATE TABLE IF NOT EXISTS telemetry (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         TEXT NOT NULL,
  project_id      INTEGER,
  iteration_id    INTEGER,
  ts              TEXT NOT NULL DEFAULT (datetime('now')),
  provider        TEXT NOT NULL,         -- 'fal' | 'comfydeploy' | 'manual'
  provider_job_id TEXT,
  prompt          TEXT,
  spec            TEXT NOT NULL,         -- JSON of GenerationSpec
  cost_cents      INTEGER NOT NULL DEFAULT 0,
  duration_ms     INTEGER NOT NULL DEFAULT 0,
  success         INTEGER NOT NULL DEFAULT 1,
  error           TEXT,
  FOREIGN KEY (project_id)   REFERENCES projects(id)   ON DELETE SET NULL,
  FOREIGN KEY (iteration_id) REFERENCES iterations(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_telemetry_user      ON telemetry(user_id);
CREATE INDEX IF NOT EXISTS idx_telemetry_user_ts   ON telemetry(user_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_telemetry_project   ON telemetry(project_id);
