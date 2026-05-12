-- Migration 011 (pivot polish): model fingerprint columns.
--
-- Adds the structural-summary JSON column to training_runs + checkpoints.
-- The other fingerprint fields (model_hash, header_hash, header_size,
-- tensor_count) already exist on these tables from migration 001 — they
-- were schema-reserved for v2 training. This migration only adds the
-- JSON blob carrying the shapes_sketch + dtypes + model-type guess that
-- lib/scruple/model-fingerprint.ts produces.
--
-- Naming note: model_hash here is the canonical content_hash (full
-- SHA-256 of the file bytes). header_hash is the structural_hash
-- (SHA-256 of the safetensors JSON header region only).

ALTER TABLE training_runs ADD COLUMN structural_summary TEXT;  -- JSON
ALTER TABLE checkpoints   ADD COLUMN structural_summary TEXT;  -- JSON

-- Existing model_hash column is now also the lookup key for "is this
-- exact same model already on chain anywhere?" queries. Index it.
CREATE INDEX IF NOT EXISTS idx_training_model_hash  ON training_runs(model_hash);
CREATE INDEX IF NOT EXISTS idx_training_header_hash ON training_runs(header_hash);
CREATE INDEX IF NOT EXISTS idx_ckpt_header_hash     ON checkpoints(header_hash);
