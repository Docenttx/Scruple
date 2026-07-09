-- Migration 029: generic per-user per-app session registry.
--
-- WO docs/wo/2026-07-06-kohya-runpod-app.md — Phase 2.
--
-- Parallels canvas_sessions (which stays as-is for Canvas) but is
-- app-agnostic: one row per (user, app) live session, whatever backend
-- spawned it. Kohya sessions live here first; if we later route Canvas
-- through the same table we can migrate rows over.
--
-- endpoint_id — provider-native identifier the terminate path calls
--   back with. Modal: same as endpoint_url. RunPod: the pod id.
-- backend    — session backend that owns the row (modal | runpod).
-- app_id     — 'kohya' | 'forge' | 'canvas'.
--
-- Status transitions same as canvas_sessions.
-- One active session per (user, app) enforced by the POST handler.

CREATE TABLE app_sessions (
  id                   TEXT PRIMARY KEY,
  user_id              TEXT NOT NULL,
  app_id               TEXT NOT NULL
                         CHECK (app_id IN ('canvas', 'kohya', 'forge')),
  backend              TEXT NOT NULL
                         CHECK (backend IN ('modal', 'runpod', 'local')),
  machine_id           TEXT NOT NULL,
  endpoint_id          TEXT NOT NULL,
  endpoint_url         TEXT NOT NULL,
  hourly_rate_cents    INTEGER NOT NULL DEFAULT 0,
  signed_token         TEXT NOT NULL,
  started_at           TEXT NOT NULL DEFAULT (datetime('now')),
  last_activity_at     TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at           TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'active'
                         CHECK (status IN ('active', 'expired', 'revoked'))
);
CREATE INDEX idx_app_sessions_user_app_active
  ON app_sessions(user_id, app_id, status);
CREATE INDEX idx_app_sessions_backend_endpoint
  ON app_sessions(backend, endpoint_id);

-- Kohya training progress mirror. The in-pod monkey-patched
-- safetensors.torch.save_file POSTs to /api/apps/kohya/witness with the
-- checkpoint sha256; we keep a lightweight row here so the palette can
-- show progress + link back to the training_runs row.
--
-- (Full provenance lives in training_runs — same table CAP-6 shipped.
--  This is just the app-session ↔ training_runs join table.)
CREATE TABLE app_kohya_progress (
  session_id           TEXT NOT NULL,
  training_run_id      INTEGER,               -- set once we bind
  latest_step          INTEGER,
  latest_epoch         INTEGER,
  latest_ckpt_sha256   TEXT,
  latest_ckpt_path     TEXT,
  updated_at           TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (session_id)
);
