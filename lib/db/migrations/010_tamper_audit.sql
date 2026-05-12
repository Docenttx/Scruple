-- Migration 010 (pivot polish): tamper-audit log.
-- Each row records one re-hash check of an iteration's bytes against
-- their recorded leaf_hash. Status 'ok' = bytes match; 'mismatch' =
-- file modified externally; 'missing' = file no longer findable;
-- 'unreachable' = storage provider error.

CREATE TABLE IF NOT EXISTS tamper_audit_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  iteration_id    INTEGER NOT NULL,
  user_id         TEXT NOT NULL,
  audited_at      TEXT NOT NULL DEFAULT (datetime('now')),
  expected_hash   TEXT NOT NULL,
  observed_hash   TEXT,                          -- null when status != 'ok'/'mismatch'
  storage_pointer TEXT NOT NULL,                 -- JSON snapshot at audit time
  status          TEXT NOT NULL CHECK (status IN ('ok', 'mismatch', 'missing', 'unreachable')),
  detail          TEXT,
  size_bytes      INTEGER,
  duration_ms     INTEGER,
  FOREIGN KEY (iteration_id) REFERENCES iterations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tamper_audit_status ON tamper_audit_log(status, audited_at);
CREATE INDEX IF NOT EXISTS idx_tamper_audit_iter   ON tamper_audit_log(iteration_id, audited_at);
CREATE INDEX IF NOT EXISTS idx_tamper_audit_user   ON tamper_audit_log(user_id, audited_at);
