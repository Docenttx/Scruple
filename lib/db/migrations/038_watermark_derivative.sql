-- Migration 038 — watermark derivative tracking on iterations.
--
-- Per WATERMARK_DESIGN_v1.md v1.2: watermarking happens at
-- publication/lock time as a signed derivative of the clean master. The
-- master hash column already exists (iterations.output_hash — that's
-- the clean master). Derivative bytes get their own hash, own signed
-- C2PA manifest, own witness leaf, and reference the master via a
-- c2pa.actions.v2 c2pa.edited action + ingredient.
--
-- This migration adds columns to track the derivative alongside the
-- master. Master preservation is unconditional; derivative is optional
-- per lock tier + user preference.

ALTER TABLE iterations ADD COLUMN watermark_derivative_hash TEXT;
  -- sha256 of the watermarked bytes; NULL when no watermark applied
ALTER TABLE iterations ADD COLUMN watermark_payload_hex TEXT;
  -- 32-hex (128 bits) — the packed payload per WATERMARK_DESIGN §3
ALTER TABLE iterations ADD COLUMN watermark_scheme_version INTEGER;
  -- payload version (currently 1); NULL when no watermark applied
ALTER TABLE iterations ADD COLUMN watermark_tier INTEGER;
  -- 1..5 per WATERMARK_DESIGN §3.1; NULL when no watermark applied
ALTER TABLE iterations ADD COLUMN watermark_signed_at TEXT;
  -- ISO 8601 timestamp of the derivative sign event; NULL when no
  -- watermark applied
ALTER TABLE iterations ADD COLUMN watermark_derivative_leaf_hash TEXT;
  -- the witness leaf hash for the derivative (parent leaf is on the
  -- master row via leaf_hash); NULL when no watermark applied

CREATE INDEX IF NOT EXISTS idx_iterations_wm_derivative
  ON iterations(watermark_derivative_hash)
  WHERE watermark_derivative_hash IS NOT NULL;
