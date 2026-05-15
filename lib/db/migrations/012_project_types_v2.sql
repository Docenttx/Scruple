-- Migration 012: project types v2 — image | video | training.
--
-- "image" consolidates txt2img/img2img/upscale/etc into one type. Workflow
-- specifics live in the canvas nodes, not on the project row. "video" is
-- registered now as a valid type slot (UI placeholder only — content
-- pipeline lands later). "training" unchanged.
--
-- Also drops comfy_workflow_id (workspace is read-only, no dispatch from
-- the project page → workflow binding is dead weight).
--
-- Existing rows are wiped per user direction ("start fresh"). FK cascades
-- handle iterations, merkle_nodes, training_runs, checkpoints, and
-- tamper_audit_log.
--
-- SQLite can't modify a CHECK constraint in place, so we do the
-- table-recreate dance with FKs temporarily disabled to allow the swap.

PRAGMA foreign_keys = OFF;

-- Wipe existing content (cascades would handle this with FK ON; explicit
-- DELETEs make the intent unmistakable in the migration log).
DELETE FROM tamper_audit_log;
DELETE FROM checkpoints;
DELETE FROM training_runs;
DELETE FROM merkle_nodes;
DELETE FROM iterations;
DELETE FROM storage_sync_log;
DELETE FROM projects;

-- Recreate projects with the new CHECK constraint + drop comfy_workflow_id
CREATE TABLE projects_new (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id               TEXT NOT NULL,
  name                  TEXT NOT NULL,
  type                  TEXT NOT NULL DEFAULT 'image'
                          CHECK (type IN ('image', 'video', 'training')),
  status                TEXT NOT NULL DEFAULT 'unlocked'
                          CHECK (status IN ('unlocked','checkpointed','local_locked','chain_locked','persistent_locked','permanent_locked')),
  created_at            TEXT NOT NULL,
  updated_at            TEXT,
  locked_at             TEXT,
  iteration_count       INTEGER NOT NULL DEFAULT 0,
  merkle_root           TEXT,
  scr_id                TEXT,
  pre_scr_id            TEXT,
  package_hash          TEXT,
  rvn_txid              TEXT,
  arweave_uri           TEXT,
  ipfs_cid              TEXT,
  final_control_index   REAL,
  is_active             INTEGER NOT NULL DEFAULT 0,
  witnessed_count       INTEGER NOT NULL DEFAULT 0,
  witness_signature     TEXT,
  is_archived           INTEGER NOT NULL DEFAULT 0,
  UNIQUE(user_id, name)
);

DROP TABLE projects;
ALTER TABLE projects_new RENAME TO projects;

-- Recreate indexes
CREATE INDEX idx_projects_user      ON projects(user_id);
CREATE INDEX idx_projects_status    ON projects(status);
CREATE INDEX idx_projects_active    ON projects(user_id, is_active);
CREATE INDEX idx_projects_type      ON projects(type);
CREATE INDEX idx_projects_archived  ON projects(user_id, is_archived);
CREATE INDEX idx_projects_scr_id    ON projects(scr_id);

PRAGMA foreign_keys = ON;
