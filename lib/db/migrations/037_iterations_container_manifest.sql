-- Migration 037 — persist the container-side machine manifest on iterations.
--
-- WO-B1 introduced runner-side enumeration of custom_nodes/ with real
-- commit_shas + content hashes. WO-B2 uses this data (per-pack) to
-- render trust-set labels on receipts. Storing the manifest JSON on the
-- iteration row lets the receipt page label without a round-trip to
-- the runner (which by then may be a different container anyway).
--
-- machine_manifest_hash (columns already exist via v2/v2.2 leaf work) is
-- the SIGNED value — this column stores the corresponding raw structure
-- for pretty rendering and per-pack trust labeling only. Editing the
-- stored JSON does NOT invalidate the leaf; verifiers re-derive the
-- hash from the canonical form and reject any mismatch.

ALTER TABLE iterations ADD COLUMN container_machine_manifest TEXT;
