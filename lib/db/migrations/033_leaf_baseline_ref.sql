-- Migration 033 — audit-log-side baseline reference + tenant freshness.
--
-- Adds baseline reference columns to log_leaves (the /v1/log continuous
-- audit surface) and a per-tenant freshness config on tenants.
--
-- The projects-side iterations table gets the same columns in migration
-- 034; keeping them separate lets the audit-side smoke run without the
-- iterations schema present.

ALTER TABLE log_leaves ADD COLUMN baseline_hash TEXT;
ALTER TABLE log_leaves ADD COLUMN platform_attestation_json TEXT;
ALTER TABLE log_leaves ADD COLUMN platform_attestation_verified INTEGER;
  -- 0 = not verified, 1 = server-verified, 2 = passthrough stored
ALTER TABLE log_leaves ADD COLUMN leaf_kind TEXT NOT NULL DEFAULT 'workflow';
  -- 'workflow' | 'baseline' | 'rebaseline' | 'abort'

CREATE INDEX IF NOT EXISTS idx_log_leaves_stream_baseline
  ON log_leaves(stream_id, baseline_hash);

-- Per Integration Requirements v1.2 §4.4: default 15 minutes; tenants
-- MAY configure shorter (as low as 60 seconds). Null = use default.
ALTER TABLE tenants ADD COLUMN attestation_freshness_max_seconds INTEGER;
