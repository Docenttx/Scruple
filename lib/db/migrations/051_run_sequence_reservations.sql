-- Migration 051 — WO-74. Make a run_sequence takeable, not merely readable.
--
-- `ingestIteration` allocated with `MAX(run_sequence) + 1` and then made a
-- REMOTE witness call before inserting the row. The comment said the risk was
-- covered — "a uniqueness violation would surface as an INSERT failure below"
-- — and it does, but it fires AFTER THE LEAF IS SIGNED AND ON THE WITNESS.
--
-- Two concurrent ingests in one project both read N, both obtain a signed leaf
-- for N, and the loser's INSERT aborts. What is left is an ORPHAN LEAF ON AN
-- APPEND-ONLY LOG: a signed record whose run_sequence no row holds,
-- duplicating a sequence number, and unretractable by construction.
--
-- A LOCK ALONE DOES NOT FIX IT. Any lock is released when the allocating
-- statement returns, and `MAX(run_sequence)+1` reads COMMITTED ROWS — so a
-- second caller arriving during the witness call still computes the same N.
-- The number has to be TAKEN, and only a row can take it.
--
-- Studio has no concurrency today. This is fixed anyway because the shape —
-- allocate unlocked, witness, then insert — is what a vendor copies out of the
-- reference implementation, and it is wrong in any estate with two writers.

CREATE TABLE IF NOT EXISTS run_sequence_reservations (
  project_id   INTEGER NOT NULL,
  run_sequence INTEGER NOT NULL,
  reserved_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (project_id, run_sequence)
);

-- A reservation left behind by a crashed ingest burns one number and blocks
-- nothing. That is the correct trade for an append-only sequence: reusing a
-- number that a witness may already have signed is the failure this exists to
-- prevent, so a stale row is never reclaimed automatically.
CREATE INDEX IF NOT EXISTS idx_run_seq_reservations_project
  ON run_sequence_reservations(project_id);
