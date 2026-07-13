-- Migration 034 — projects-side baseline reference on iterations.
--
-- Extends the per-app witness ingest surface (Fusion/Adobe/Kohya) with
-- the same baseline_hash + platform_attestation columns landed on
-- log_leaves in migration 033. Split for cleaner audit-side vs
-- projects-side dependency separation.

ALTER TABLE iterations ADD COLUMN baseline_hash TEXT;
ALTER TABLE iterations ADD COLUMN platform_attestation_json TEXT;
ALTER TABLE iterations ADD COLUMN platform_attestation_verified INTEGER;
ALTER TABLE iterations ADD COLUMN leaf_kind TEXT NOT NULL DEFAULT 'workflow';

CREATE INDEX IF NOT EXISTS idx_iterations_baseline
  ON iterations(baseline_hash);
