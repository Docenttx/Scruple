-- Migration 048 — the witnessed watermark derivative (WO-28).
--
-- Migration 038 opened `iterations.watermark_derivative_leaf_hash` in
-- July and nothing has ever written it. The reason was structural, not
-- an omission: `app/api/lock/local` finalised with the witness (which
-- inserts `locked_projects`) BEFORE it watermarked, and
-- `services/witness-server/server.js` 403s any witness request for a
-- project holding a `locked_projects` row. The derivative was not merely
-- unwitnessed — it could not be witnessed.
--
-- WO-28 reorders the lock (watermark → witness the derivative → build
-- the Merkle → finalise) so the derivative leaf is minted while the
-- project is still open. The 403 is untouched.
--
-- These columns are the rest of the derivative leaf's preimage. Without
-- them `watermark_derivative_leaf_hash` is an assertion a verifier has
-- to take on faith; with them the leaf hash is RECOMPUTABLE from this
-- row alone:
--
--   sha256(JSON.stringify({
--     run_sequence:                <watermark_derivative_run_sequence>,
--     output_hash:                 <watermark_derivative_hash>,
--     input_hash:                  "",
--     workflow_hash:               "",
--     model_fingerprints_hash:     "",
--     machine_manifest_hash:       "",
--     master_hash:                 <output_hash>,
--     watermark_payload_hex:       <watermark_payload_hex>,
--     ingredient_master_leaf_hash: <leaf_hash>,
--     server_timestamp:            <watermark_derivative_witness_timestamp>,
--     prev_record_hash:            <watermark_derivative_prev_record_hash>,
--   }))
--
-- == leaf scheme 'v2.5' on the witness server. Field order is part of
-- the protocol; see canonicalRecordV25 in services/witness-server/server.js.
--
-- SIBLING, NOT INGREDIENT-OF-THE-MASTER. The master's leaf is NOT
-- rewritten. It was sealed at generation time, and folding a derivative
-- that did not yet exist into that preimage would mean re-signing a
-- record whose `server_timestamp` claims a moment the derivative had not
-- happened. The lineage pointer therefore lives inside the DERIVATIVE's
-- preimage (`ingredient_master_leaf_hash`) and points backwards — the
-- same direction a C2PA ingredient points.

ALTER TABLE iterations ADD COLUMN watermark_derivative_witness_id TEXT;
  -- witness_id of the derivative's own leaf; NULL when the derivative was
  -- produced but the witness was unreachable (bytes exist, chain does not)
ALTER TABLE iterations ADD COLUMN watermark_derivative_run_sequence INTEGER;
  -- synthetic run_sequence the derivative leaf was witnessed under.
  -- Rule: max(project run_sequence) + this row's run_sequence. Strictly
  -- greater than every master, distinct per master, monotone in the
  -- master's order — so the witness server's own prev_record_hash chain
  -- puts every derivative after every master.
ALTER TABLE iterations ADD COLUMN watermark_derivative_witness_timestamp TEXT;
  -- the witness server's server_timestamp for the derivative leaf. Part
  -- of the preimage: without it the leaf cannot be recomputed.
ALTER TABLE iterations ADD COLUMN watermark_derivative_prev_record_hash TEXT;
  -- prev_record_hash the witness chained the derivative leaf from. Also
  -- part of the preimage. Empty string is a legitimate value (first leaf).
ALTER TABLE iterations ADD COLUMN watermark_derivative_leaf_scheme TEXT;
  -- 'v2.5' for every leaf this path writes. Recorded per row because
  -- an audit replay must pick the canonical form by scheme, never by
  -- "the newest one".
ALTER TABLE iterations ADD COLUMN watermark_derivative_witness_signature TEXT;
  -- the witness server's HMAC over the derivative leaf hash. A TRANSPORT
  -- seal (H-2), not evidence; the evidence is the ECDSA leaf signature,
  -- which lives on the witness server's own row.

CREATE INDEX IF NOT EXISTS idx_iterations_wm_derivative_leaf
  ON iterations(watermark_derivative_leaf_hash)
  WHERE watermark_derivative_leaf_hash IS NOT NULL;
