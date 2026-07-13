-- Migration 035 — public-baseline transparency toggle per tenant.
--
-- Per Standard v1.2 §4: "Public ledger anchoring of the baseline is a
-- core transparency option." When publish_baseline_publicly = 1, the
-- tenant's baseline history is served through the /api/v1/registry/*
-- endpoints without authentication.
--
-- Actual chain-lock inscription of baseline events onto RVN/IPFS/
-- Arweave is a follow-up (WO-15 v2) — requires wiring baselines into
-- the audit-log-leaf stream so the existing checkpoint scheduler +
-- super-root anchor path pick them up.

ALTER TABLE tenants ADD COLUMN publish_baseline_publicly INTEGER NOT NULL DEFAULT 0;
