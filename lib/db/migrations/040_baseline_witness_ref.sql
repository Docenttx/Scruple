-- Migration 040 — a baseline's witness leaf reference, typed correctly.
--
-- Standard §4 requires a baseline transition to be a witnessed leaf.
-- Migration 032 provided `baselines.witness_leaf_id INTEGER` for that,
-- and in practice it has always been NULL — which removes the one
-- property that makes §4 mean anything: that the change is ON the record
-- rather than merely recorded.
--
-- The likely reason it was never populated is a type mismatch rather than
-- an oversight. The witness server returns `witness_id` as a STRING
-- (lib/scruple/witness.ts, WitnessIterationResult). There is no integer
-- to put in an INTEGER column, so the code that would have filled it had
-- nothing to write.
--
-- witness_leaf_ref is the correctly-typed field. witness_leaf_id stays
-- for compatibility with anything already reading it, and for the day a
-- numeric log-leaf id exists.

ALTER TABLE baselines ADD COLUMN witness_leaf_ref TEXT;

CREATE INDEX IF NOT EXISTS idx_baselines_witness_ref
  ON baselines(witness_leaf_ref);
