-- Migration 050 — WHICH measurement answered, not just what it said.
--
-- WO-62/63. Three columns whose absence let a claim stand in for a measurement.
--
-- `machine_manifest_hash` is populated from a ladder of THREE structurally
-- different documents (lib/iterations/ingest.ts):
--
--   1. the container's own measurement of itself — this IS what ran;
--   2. a hash the caller supplied;
--   3. "whichever machine row this user created most recently", from the DB.
--
-- Nothing on the row said which. A leaf whose machine claim came from a
-- database default was byte-indistinguishable from one the container measured,
-- and the fallback is silent: when the container manifest is absent for any
-- reason, rung 3 answers and the leaf still looks complete.
--
-- Against the L2 floor this is H-5 — two-tier assurance, the one item marked
-- implemented: a record declares what actually backed it. `passthrough` exists
-- on attestations for exactly this reason and had no equivalent here.
--
-- THREE HONEST STATES, NOT TWO. WO-27 settled this once for input_hash — bind
-- it, or decline; never assert an empty set — and the rule was applied in one
-- place. `model_fingerprints_state` is that rule for the weights:
--
--   measured      we enumerated the models and hashed them
--   none          we enumerated and there genuinely were none
--   unavailable   we could not enumerate; the hash is NULL because we do not
--                 know, not because there was nothing
--
-- Collapsing the last two is the defect: the runner returned `{}` on a read
-- failure and the web side turned that into NULL, which is the representation
-- for "we checked and there were none".

ALTER TABLE iterations ADD COLUMN machine_manifest_source TEXT;
ALTER TABLE iterations ADD COLUMN model_fingerprints_state TEXT;
ALTER TABLE iterations ADD COLUMN model_fingerprints_error TEXT;

-- Backfill states what is KNOWABLE and refuses to guess the rest.
--
-- A row carrying a stored container manifest was measured by the container:
-- that is not an inference, the evidence is in the column beside it.
UPDATE iterations
   SET machine_manifest_source = 'container'
 WHERE container_machine_manifest IS NOT NULL;

-- Every other row keeps NULL. It could have come from rung 2 or rung 3 and the
-- record does not say — which is the finding, and writing a guess here would
-- destroy the only honest thing left about those rows. Migration 046's
-- sentence, reused because it is the same idea: "NULL — the question was never
-- asked."
