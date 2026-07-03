-- Migration 028: add projects.thumbnail_b64 for Fusion design previews.
-- Base64-encoded PNG data URL captured during the add-in's scan of the
-- user's Fusion account, from DataFile.thumbnail. Small enough (~5-15KB)
-- to inline in the projects row and avoid a separate blob store.

ALTER TABLE projects ADD COLUMN thumbnail_b64 TEXT;
