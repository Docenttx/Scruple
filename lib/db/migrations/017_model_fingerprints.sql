-- Migration 017: model fingerprinting (in-container, on load).
--
-- The v2 leaf currently commits run_sequence + output_hash + input_hash +
-- workflow_hash + server_timestamp + prev_record_hash. workflow_hash binds
-- the workflow GRAPH (which references model files by filename string),
-- but the actual weight bytes loaded for those filenames are not under the
-- anchor. A user could swap a file at the same path between runs and
-- nothing in the provenance would notice.
--
-- This migration adds the storage for the in-container fingerprint that
-- closes that gap. Modal's run_workflow now walks the workflow for model
-- references, hashes each file on the volume, and returns a manifest:
--
--   model_fingerprints  TEXT JSON — {volume_relpath: {content_hash, header_hash, header_size, bytes, mtime}}
--   model_fingerprints_hash TEXT — sha256(canonical(model_fingerprints)) — folded into the v2 record so the on-chain Merkle root commits the exact weights that produced the run.
--
-- v2 record (post-migration):
--   { run_sequence, output_hash, input_hash, workflow_hash,
--     model_fingerprints_hash,
--     server_timestamp, prev_record_hash }
--   leaf = sha256(canonical(record))
--
-- Existing rows: both columns default NULL; their leaf preimage didn't
-- include model_fingerprints_hash, so their original Merkle still
-- verifies. New rows always carry the field (empty manifest → empty
-- string for the hash, identical to the v2-without-models case).

ALTER TABLE iterations ADD COLUMN model_fingerprints      TEXT;
ALTER TABLE iterations ADD COLUMN model_fingerprints_hash TEXT;
