-- Migration 053 — the per-leaf attestation basis (WO-C1).
--
-- The Blender×ComfyUI council settled a THREE-VALUED basis that every
-- field-level `source: measured` on a leaf is conditional on:
--
--   'verified'    the quote is root-chained AND binds to this emission
--   'stale'       there is a quote and it cannot be bound; or the checkpoint
--                 the leaf would settle against cannot be claimed settled
--   'passthrough' no root-chained attestation at all
--
-- WHY A NEW COLUMN AND NOT A WIDER `platform_attestation_status`.
--
-- Migration 039 wrote that column with
-- `CHECK (platform_attestation_status IN ('verified','passthrough'))`, and
-- SQLite cannot widen a CHECK in place — the documented procedure is to
-- rebuild the table. `iterations` carries ~50 columns, several indexes and
-- inbound foreign keys from merkle_nodes, checkpoints and tamper_audit_log,
-- and it holds every leaf this estate has ever written. Rebuilding it to
-- admit one enum value is a migration that deserves its own work order and
-- the founder's eyes, not a side effect of this one.
--
-- The two columns are also not the same fact, which is what makes the split
-- honest rather than merely convenient. `platform_attestation_status` is
-- §12.4's report on the ATTESTATION ENVELOPE the caller supplied — H-5
-- dispatch said verified, or it stored the thing opaquely. `attestation_basis`
-- is the council's per-leaf basis, and it folds in a condition H-5 knows
-- nothing about: whether a checkpoint can be claimed settled at all. They will
-- often agree. They are not the same question, and a verifier that wants to
-- know what conditioned the measured fields reads THIS one.
--
-- NULL IS THE LEGACY VALUE AND IT IS NOT BACKFILLED. Every row written before
-- this migration was written without the question being asked, and
-- `basisForTrust()` reads NULL as 'unknown'. Defaulting them to 'passthrough'
-- would manufacture an answer nobody gave — the same defect migration 039
-- called out when it refused to backfill modality selection.

ALTER TABLE iterations ADD COLUMN attestation_basis TEXT
  CHECK (attestation_basis IN ('verified', 'stale', 'passthrough'));

-- The profile the basis is conditional on. `verified` is unreachable on
-- 'desktop' by construction.
--
-- ⚑ THE CROSS-COLUMN CHECK IS THE POINT, and it is a real constraint rather
-- than a partial index over rows that "must not exist" — an index does not
-- refuse an INSERT, it files it. SQLite does accept a multi-column CHECK in
-- ALTER TABLE ADD COLUMN and does enforce it (verified against sqlite3 before
-- this migration was written), and existing rows are unaffected because
-- `NOT (NULL = 'verified' AND ...)` evaluates to NULL, which a CHECK admits.
--
-- Three independent guards now say the same thing, and none of them is
-- redundant: the TYPE (`BasisOn<'desktop'>`) stops the code being written,
-- the VALIDATOR (lib/leaf/captureClaims.ts rule 3) stops the JSON arriving —
-- types do not survive a wire — and this stops any other writer, present or
-- future, that reaches the table without going through either.
ALTER TABLE iterations ADD COLUMN attestation_profile TEXT
  CHECK (
    attestation_profile IN ('server-managed', 'isolated-sidecar', 'desktop')
    AND NOT (attestation_basis = 'verified' AND attestation_profile = 'desktop')
  );

CREATE INDEX IF NOT EXISTS idx_iterations_attestation_basis
  ON iterations(attestation_basis);
