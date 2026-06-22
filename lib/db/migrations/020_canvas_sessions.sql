-- Migration 020: per-user canvas session registry.
--
-- WO docs/wo/2026-06-22-canvas-on-modal.md.
--
-- Each Pro/Enterprise user launching the Modal-hosted ComfyUI canvas
-- gets a row here. The session_token (HMAC of {id, user_id, expires_at}
-- signed with AUTH_SECRET) gates incoming witness POSTs from the
-- canvas page's intercept JS — without it, anyone could submit
-- iterations attributed to this user.
--
-- modal_url is what the canvas page iframes. It's the URL Modal returned
-- after deploy for the user's chosen GPU class's @web_server (e.g.
-- https://<workspace>--scruple-canvas-comfyuia100-serve.modal.run/?token=<sig>).
--
-- Status transitions:
--   active   — session is live; canvas page can iframe modal_url
--   expired  — past expires_at, never extended; reaper sets this
--   revoked  — user clicked End Session, or POSTed a fresh /api/canvas/session
--
-- One active session per user (UI rule, enforced by the POST handler).

CREATE TABLE canvas_sessions (
  id                   TEXT PRIMARY KEY,
  user_id              TEXT NOT NULL,
  machine_id           TEXT NOT NULL,
  modal_url            TEXT NOT NULL,
  signed_token         TEXT NOT NULL,
  started_at           TEXT NOT NULL DEFAULT (datetime('now')),
  last_activity_at     TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at           TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'active'
                         CHECK (status IN ('active', 'expired', 'revoked'))
);
CREATE INDEX idx_canvas_sessions_user_active
  ON canvas_sessions(user_id, status);

-- Pending iterations: the intercept JS POSTs /api/canvas/witness/start
-- BEFORE the workflow executes (capturing the workflow JSON for
-- provenance), then /api/canvas/witness/complete with the output bytes
-- after. If `complete` never fires (ComfyUI crash, browser close, etc.)
-- the row stays pending; a sweep can flag those for audit.
CREATE TABLE canvas_pending_iterations (
  prompt_id            TEXT NOT NULL,          -- ComfyUI's prompt_id
  session_id           TEXT NOT NULL,
  user_id              TEXT NOT NULL,
  project_id           INTEGER NOT NULL,
  workflow_api_json    TEXT NOT NULL,
  started_at           TEXT NOT NULL DEFAULT (datetime('now')),
  status               TEXT NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending', 'done', 'lost')),
  PRIMARY KEY (session_id, prompt_id)
);
CREATE INDEX idx_canvas_pending_status
  ON canvas_pending_iterations(status, started_at);
