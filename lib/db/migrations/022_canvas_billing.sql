-- Migration 022: Canvas session billing — Stripe pre-auth + capture-actual.
--
-- WO docs/wo/2026-06-22-v2-06-stripe-lifecycle.md.
-- Spec docs/architecture/canvas-v2.md decision 7.
--
-- Lifecycle:
--   mint    → paymentIntents.create(manual_capture, 1h*rate)
--           → payment_intent_id stored on canvas_sessions row
--   tick    → client heartbeat updates last_heartbeat + accumulated_seconds
--   end     → paymentIntents.capture(amount_to_capture=accumulated)
--           → finalized_at set + canvas_session_charges audit row written
--           OR paymentIntents.cancel() if accumulated_cents == 0

ALTER TABLE canvas_sessions ADD COLUMN payment_intent_id TEXT;
ALTER TABLE canvas_sessions ADD COLUMN payment_status TEXT NOT NULL DEFAULT 'none';
  -- 'none' (legacy/missing), 'held' (PI created+confirmed),
  -- 'captured', 'cancelled', 'capture_failed'
ALTER TABLE canvas_sessions ADD COLUMN last_heartbeat INTEGER;
ALTER TABLE canvas_sessions ADD COLUMN accumulated_seconds INTEGER NOT NULL DEFAULT 0;
ALTER TABLE canvas_sessions ADD COLUMN finalized_at INTEGER;
ALTER TABLE canvas_sessions ADD COLUMN captured_cents INTEGER;
ALTER TABLE canvas_sessions ADD COLUMN hold_cents INTEGER;

CREATE TABLE canvas_session_charges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  payment_intent_id TEXT NOT NULL,
  hold_cents INTEGER NOT NULL,
  captured_cents INTEGER NOT NULL,
  accumulated_seconds INTEGER NOT NULL,
  outcome TEXT NOT NULL,  -- 'captured', 'cancelled', 'capture_failed'
  outcome_detail TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_csc_user ON canvas_session_charges(user_id);
CREATE INDEX idx_csc_session ON canvas_session_charges(session_id);
