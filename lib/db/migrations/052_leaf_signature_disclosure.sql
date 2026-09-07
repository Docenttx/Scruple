-- Migration 052 — the leaf signature, on the row that has to disclose it.
--
-- WO-S1(a). The witness server has stored `leaf_signature`,
-- `leaf_signer_key_id`, `leaf_signature_alg` and `leaf_signer_surrogate`
-- since H-1 (services/witness-server/server.js:220-236, 806-829). The
-- application tier stored NONE of them. Both write doors —
-- app/api/v2/witness/route.ts and lib/iterations/ingest.ts — read
-- `res.signature` into `witness_signature` and dropped the other four on
-- the floor.
--
-- `res.signature` IS THE HMAC. leaf_signer.js's header says so in as many
-- words: the HMAC is "demoted to what it always was — a transport seal
-- between the application tier and this service (H-2)". So
-- app/api/v2/verify's `independently_verifiable: Boolean(witness_signature)`
-- was reading the transport seal and reporting it as the evidence
-- signature. Every witnessed leaf in the estate claims independent
-- verifiability; none of them can be independently verified from anything
-- the application tier holds, because the application tier never kept the
-- ECDSA signature.
--
-- Three consequences, all observed against the scratch witness on 2026-09-07:
--
--   1. No client can check a leaf. GET /api/v2/receipt returns no
--      signature, no key id, no algorithm — so `independently_verifiable`
--      is a claim the caller has no way to test.
--   2. A surrogate-signed leaf is indistinguishable from a hardware-signed
--      one. That distinction is the whole of H-5's per-leaf two-tier
--      honesty, and it was unreachable through the public surface.
--   3. A canonicalization divergence is invisible. The Blender client
--      computed `jcs-1` where the row records `jcs-2`, and no surface
--      disclosed the row's profile for the two to be compared.
--
-- FOUR COLUMNS AND A FIFTH THAT IS NOT REDUNDANT.
--
-- `leaf_signature_state` exists because NULL in the other four is
-- ambiguous and the ambiguity is exactly the kind this estate refuses
-- elsewhere (046's "NULL — the question was never asked", 050's
-- `unavailable` vs `none`). Three different facts collapse into a null
-- signature otherwise:
--
--   signed      the witness answered with an ECDSA signature; it is here.
--   unsigned    the witness answered and had none — signing was disabled,
--               or the KMS was unreachable for that leaf. leaf_signer.js
--               returns null rather than failing the event, and that is a
--               fact about the leaf, not an absence of information.
--   NULL        we never asked, or never got an answer: the witness was
--               unreachable, the row predates this migration, or the event
--               was recorded under §9.6 continuity and deliberately not
--               witnessed at all.
--
-- A receipt renders the third as `state: "unknown"` and MUST NOT render it
-- as `unsigned`. "This leaf has no signature" and "we did not record
-- whether this leaf has a signature" are different claims, and only the
-- second is true of every row written before today.
--
-- NO BACKFILL, AND THAT IS THE POINT. Every existing row keeps NULL. The
-- witness's own DB may well hold a signature for some of them, but this
-- tier did not record it and inventing a value here — even a plausible
-- one — would be the application tier asserting something it never
-- observed. Recovering them is a reconciliation against the witness DB,
-- which is a separate job with its own evidence.

ALTER TABLE iterations ADD COLUMN leaf_signature        TEXT;
ALTER TABLE iterations ADD COLUMN leaf_signer_key_id    TEXT;
ALTER TABLE iterations ADD COLUMN leaf_signature_alg    TEXT;
-- 1/0, never a string: matches witnesses.leaf_signer_surrogate's INTEGER.
-- NULL means the same thing it means in leaf_signature_state — not asked.
ALTER TABLE iterations ADD COLUMN leaf_signer_surrogate INTEGER;
ALTER TABLE iterations ADD COLUMN leaf_signature_state  TEXT
  CHECK (leaf_signature_state IN ('signed', 'unsigned'));

-- Lookup by signature is not a query anyone makes. Lookup of "which leaves
-- can actually be checked by a third party" is: it is the question an
-- auditor asks first, and before this migration it had no answer at all.
CREATE INDEX IF NOT EXISTS idx_iterations_leaf_signature_state
  ON iterations (leaf_signature_state)
  WHERE leaf_signature_state IS NOT NULL;
