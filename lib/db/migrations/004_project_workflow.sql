-- Migration 004: per-project ComfyDeploy workflow id.
--
-- Each project can target one ComfyDeploy deployment. Stored as TEXT
-- because deployment ids are opaque strings from ComfyDeploy's side.
-- NULL = no workflow configured yet; generate UI will block.

ALTER TABLE projects ADD COLUMN comfy_workflow_id TEXT;
