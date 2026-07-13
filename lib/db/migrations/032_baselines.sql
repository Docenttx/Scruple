-- Migration 032 — baseline attestation schema.
--
-- Implements Standard v1.2 §3-4 and Integration Requirements v1.2 §2 P7/P8.
-- Adds the two tables that back the baseline API endpoints (WO-02) and the
-- ingest-side baseline reference enforcement (WO-03).
--
-- One baseline per tenant is active at a time; the chain of prior baselines
-- is walkable via `prev_baseline_hash` back to the tenant's genesis.
--
-- Related:
--   - docs/architecture/SCRUPLE_STANDARD_v1.md §3 (baseline attestation)
--   - docs/architecture/SCRUPLE_INTEGRATION_REQUIREMENTS_v1.md §2 (P7, P8)
--   - docs/wo/2026-07-13-baseline-attestation/WO-01-foundation.md

CREATE TABLE IF NOT EXISTS baselines (
  id                              INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id                       TEXT NOT NULL,
  baseline_hash                   TEXT NOT NULL UNIQUE,
  prev_baseline_hash              TEXT,
  manifest_json                   TEXT NOT NULL,
  attestation_provider            TEXT NOT NULL,
  attestation_envelope_json       TEXT,
  signer_pubkey_spki_sha256_hex   TEXT NOT NULL,
  reason                          TEXT,
  submitted_at                    TEXT NOT NULL,
  activated_at                    TEXT NOT NULL,
  retired_at                      TEXT,
  witness_leaf_id                 INTEGER
);

CREATE INDEX IF NOT EXISTS idx_baselines_tenant_activated
  ON baselines(tenant_id, activated_at DESC);

CREATE INDEX IF NOT EXISTS idx_baselines_prev
  ON baselines(prev_baseline_hash);

CREATE TABLE IF NOT EXISTS tenant_current_baseline (
  tenant_id     TEXT PRIMARY KEY,
  baseline_id   INTEGER NOT NULL REFERENCES baselines(id),
  updated_at    TEXT NOT NULL
);
