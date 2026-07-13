-- Migration 036 — leaf v2.4: workflow_hash + machine_manifest_hash on log_leaves.
--
-- v2.4 promotes these two provenance-bearing hashes to first-class leaf
-- fields (see lib/witness/canonicalLeafV24.ts). Persist them on the
-- audit-side row so proof bundles can re-derive the leaf preimage
-- without inspecting client-side payload storage.
--
-- Also add leaf_scheme discriminator so downstream verifiers know which
-- canonicalization to apply. Existing rows are v2.3; new rows written
-- through the v2.4 code path stamp 'v2.4'.

ALTER TABLE log_leaves ADD COLUMN workflow_hash TEXT;
ALTER TABLE log_leaves ADD COLUMN machine_manifest_hash TEXT;
ALTER TABLE log_leaves ADD COLUMN leaf_scheme TEXT NOT NULL DEFAULT 'v2.3';

CREATE INDEX IF NOT EXISTS idx_log_leaves_workflow_hash
  ON log_leaves(workflow_hash) WHERE workflow_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_log_leaves_manifest_hash
  ON log_leaves(machine_manifest_hash) WHERE machine_manifest_hash IS NOT NULL;
