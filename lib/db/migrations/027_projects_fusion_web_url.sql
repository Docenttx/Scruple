-- Migration 027: add projects.fusion_web_url — the Fusion cloud viewer URL
-- for a DataFile. Populated by the Fusion add-in sync so the palette
-- workspace can iframe / link to the live 3D viewer.

ALTER TABLE projects ADD COLUMN fusion_web_url TEXT;
