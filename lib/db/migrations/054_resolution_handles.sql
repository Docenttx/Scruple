-- Migration 054 — the resolution handles, stored so the leaf can be resolved
-- (WO-C2).
--
-- The Blender×ComfyUI council split what a leaf CLAIMS from what it CARRIES AS
-- EVIDENCE: the Merkle path and the raw TPM quote stay in the checkpoint
-- store, and the leaf carries compact handles that say where to fetch them.
-- Architect settled on that split with one condition — the handles must sit
-- INSIDE the signed preimage, because "an attacker who can rewrite an unsigned
-- endpoint redirects resolution to a service that will happily confirm
-- anything."
--
-- The preimage half is `lib/leaf/resolutionHandles.ts` and the three MAC
-- implementations. These columns are the other half: a handle that is signed
-- on the wire and then not written down is a handle nobody can follow, and the
-- leaf goes back to being unresolvable for the same reason it would have been
-- had it never carried one.
--
-- ⚑ WHAT IS STORED IS WHAT THE COMPONENT SIGNED, NOT WHAT THE SERVER KNOWS.
-- `resolution_witness_endpoint` is self-asserted by the emitter, and the route
-- deliberately does NOT overwrite it with its own address. A compromised
-- component naming somewhere else is a fact, and rewriting the column would
-- destroy the only record of it. The receipt discloses the value as signed and
-- a reader compares.
--
-- NULL IS THE LEGACY VALUE AND IT IS NOT BACKFILLED, for migration 053's
-- reason one column over: every leaf written before this was written without
-- the question being asked, and filling in this server's own endpoint would
-- manufacture an answer nobody signed.

ALTER TABLE iterations ADD COLUMN resolution_witness_endpoint TEXT;

-- Whose signature counts at that address. The endpoint says WHERE; without
-- this, a verifier who follows the URL gets whoever answers it.
ALTER TABLE iterations ADD COLUMN resolution_witness_authority TEXT;

-- The checkpoint this leaf settles into. NULL on every row today: no
-- checkpoint can be claimed settled while the three live Merkle constructions
-- disagree (WO-C6, Appendix C item 0), and the validator refuses a leaf that
-- names one.
--
-- ⚑ THE CROSS-COLUMN CHECK IS THE POINT, and it is the same guard the
-- validator applies, placed where any other writer reaching this table has to
-- pass it too — WO-C1's three-guard pattern: the type stops the code being
-- written, the validator stops the JSON arriving, and this stops everything
-- else. Existing rows are unaffected: `NOT (NULL IS NOT NULL AND ...)`
-- evaluates true for them.
ALTER TABLE iterations ADD COLUMN resolution_checkpoint_id TEXT
  CHECK (NOT (resolution_checkpoint_id IS NOT NULL
              AND resolution_witness_authority IS NULL));

-- The preceding checkpoint and when it was quoted — Architect's interval
-- bound, carried on the leaf rather than left to policy. Present together or
-- not at all; half an interval bounds nothing.
ALTER TABLE iterations ADD COLUMN resolution_prev_checkpoint_id TEXT;
ALTER TABLE iterations ADD COLUMN resolution_prev_checkpoint_quote_time TEXT
  CHECK ((resolution_prev_checkpoint_id IS NULL)
         = (resolution_prev_checkpoint_quote_time IS NULL));

CREATE INDEX IF NOT EXISTS idx_iterations_resolution_checkpoint
  ON iterations(resolution_checkpoint_id);
