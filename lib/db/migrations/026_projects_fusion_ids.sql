-- Migration 026: add Fusion data-id columns to projects for the
-- Fusion add-in account-scan flow. Each row can be linked to a specific
-- `.f3d` in the user's Fusion Team / Hub project tree by its stable
-- Fusion `DataFile.id`. Also captures the parent project id for future
-- sidebar grouping.

ALTER TABLE projects ADD COLUMN fusion_data_id    TEXT;
ALTER TABLE projects ADD COLUMN fusion_project_id TEXT;

-- Partial UNIQUE index — per user, one Scruple row per Fusion file. Rows
-- with NULL fusion_data_id (non-Fusion projects) don't participate.
CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_fusion_data_id
  ON projects(user_id, fusion_data_id)
  WHERE fusion_data_id IS NOT NULL;
