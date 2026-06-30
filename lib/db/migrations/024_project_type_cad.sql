-- Migration 024: extend project type to include 'cad' for Fusion add-in.
--
-- Same table-recreate dance migration 012 uses — SQLite can't ALTER a
-- CHECK constraint in place. We preserve all existing rows + indexes.

PRAGMA foreign_keys = OFF;

CREATE TABLE projects_new (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id                  TEXT NOT NULL,
  name                     TEXT NOT NULL,
  type                     TEXT NOT NULL DEFAULT 'image'
                             CHECK (type IN ('image', 'video', 'training', 'cad')),
  status                   TEXT NOT NULL DEFAULT 'unlocked'
                             CHECK (status IN ('unlocked','checkpointed','local_locked','chain_locked','persistent_locked','permanent_locked')),
  created_at               TEXT NOT NULL,
  updated_at               TEXT,
  locked_at                TEXT,
  iteration_count          INTEGER NOT NULL DEFAULT 0,
  merkle_root              TEXT,
  scr_id                   TEXT,
  pre_scr_id               TEXT,
  package_hash             TEXT,
  rvn_txid                 TEXT,
  arweave_uri              TEXT,
  ipfs_cid                 TEXT,
  final_control_index      REAL,
  is_active                INTEGER NOT NULL DEFAULT 0,
  witnessed_count          INTEGER NOT NULL DEFAULT 0,
  witness_signature        TEXT,
  is_archived              INTEGER NOT NULL DEFAULT 0,
  lock_server_signature    TEXT,
  lock_locked_at_witnessed TEXT,
  UNIQUE(user_id, name)
);

INSERT INTO projects_new
  SELECT id, user_id, name, type, status, created_at, updated_at, locked_at,
         iteration_count, merkle_root, scr_id, pre_scr_id, package_hash,
         rvn_txid, arweave_uri, ipfs_cid, final_control_index, is_active,
         witnessed_count, witness_signature, is_archived,
         lock_server_signature, lock_locked_at_witnessed
  FROM projects;

DROP TABLE projects;
ALTER TABLE projects_new RENAME TO projects;

CREATE INDEX idx_projects_user      ON projects(user_id);
CREATE INDEX idx_projects_status    ON projects(status);
CREATE INDEX idx_projects_active    ON projects(user_id, is_active);
CREATE INDEX idx_projects_type      ON projects(type);
CREATE INDEX idx_projects_archived  ON projects(user_id, is_archived);
CREATE INDEX idx_projects_scr_id    ON projects(scr_id);

PRAGMA foreign_keys = ON;
