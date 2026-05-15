-- Migration 013: generation_jobs table.
--
-- Async dispatch backbone. /api/generate spawns a Modal function call
-- and records a row here; /api/generate/status polls Modal via the
-- modal_call_id and ingests when complete. Each row is the full
-- lifecycle of one Queue click.
--
-- Statuses:
--   running    — Modal call in flight (or queued, or being re-spawned)
--   done       — image ingested, iteration_id is the resulting row
--   failed     — terminal failure; error_detail populated
--   preempted  — Modal preempted; we'll re-spawn on next status check.
--                (intermediate; never returned as final to clients)
--
-- The modal_call_id is the FunctionCall.object_id from Modal's
-- run_workflow.spawn(). It may change across retries when we re-spawn
-- after a preemption — retry_count tracks how many times we re-spawned.

CREATE TABLE IF NOT EXISTS generation_jobs (
  id                  TEXT PRIMARY KEY,                  -- short uuid we generate
  user_id             TEXT NOT NULL,
  project_id          INTEGER NOT NULL,
  status              TEXT NOT NULL DEFAULT 'running'
                        CHECK (status IN ('running', 'done', 'failed', 'preempted')),
  modal_call_id       TEXT,                              -- FunctionCall.object_id
  started_at          TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at        TEXT,
  iteration_id        INTEGER,                           -- set when status='done'
  leaf_hash           TEXT,                              -- denormalized for quick read
  run_sequence        INTEGER,                           -- denormalized
  error_detail        TEXT,
  dispatch_log_path   TEXT,                              -- /tmp/scruple-dispatch/N/<ts>.json
  retry_count         INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (iteration_id) REFERENCES iterations(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_gen_jobs_user_status   ON generation_jobs(user_id, status, started_at);
CREATE INDEX IF NOT EXISTS idx_gen_jobs_project       ON generation_jobs(project_id, started_at);
CREATE INDEX IF NOT EXISTS idx_gen_jobs_modal_call    ON generation_jobs(modal_call_id);
