-- Migration 031 — user ↔ audit-principal linkage.
--
-- Every Scruple end-user is a Principal in the audit-API sense (see
-- CANONICAL_SCRUPLE_WITNESSING_L2.md §3). When they sign a C2PA asset,
-- the sign event lands as a leaf on `scruple.c2pa.sign` under a
-- delegation from that Principal to tenant TEN_scruple.
--
-- Principals are minted lazily on first sign (see lib/witness/
-- principalForUser.ts). This migration only adds the column + index.

ALTER TABLE users ADD COLUMN principal_id TEXT REFERENCES principals(principal_id);

CREATE INDEX idx_users_principal_id ON users(principal_id);
