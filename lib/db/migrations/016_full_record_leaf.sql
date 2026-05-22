-- Migration 016: full-record leaf scheme (v2).
--
-- Today the witnessed/Merkled leaf is just `content_hash` (= output_hash),
-- so the RVN-anchored root commits to outputs only — inputs, workflow,
-- timestamps, and order live in operator SQLite and aren't under the
-- anchor. That makes "anyone with the asset ID can prove an untampered
-- provenance package" hold for outputs but not for the recipe or order.
--
-- v2 makes the leaf a hash of the full record:
--   record = { run_sequence, output_hash, input_hash, workflow_hash,
--              server_timestamp, prev_record_hash }
--   leaf   = sha256(canonical(record))
-- The Merkle root then commits inputs + workflow + order + time too.
--
-- Cols added here:
--   workflow_hash  sha256 of canonical(workflowApiJson) at ingest;
--                  NULL when the run had no workflow (legacy paths).
--   leaf_scheme    'v1' (legacy: leaf_hash == output_hash) or
--                  'v2' (this migration onward: leaf_hash == record_hash).
--                  Defaults to 'v1' for existing rows so the old Merkle
--                  recomputation still verifies old locked projects.

ALTER TABLE iterations ADD COLUMN workflow_hash TEXT;
ALTER TABLE iterations ADD COLUMN leaf_scheme   TEXT NOT NULL DEFAULT 'v1';
