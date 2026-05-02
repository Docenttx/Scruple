-- Migration 001: core schema (ported from desktop SCRUPLE Studio v3 database.js)
--
-- Source: research/electron-source/scruple-studio/database.js
-- Web-specific change: every project belongs to a user_id (multi-tenant from day one).
-- Removed `vault_path` (Electron-only filesystem concept).
-- `name` is no longer globally UNIQUE — only unique per (user_id, name).

CREATE TABLE IF NOT EXISTS projects (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id               TEXT NOT NULL,
  name                  TEXT NOT NULL,
  type                  TEXT NOT NULL DEFAULT 'txt2img' CHECK (type IN ('txt2img', 'training')),
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

CREATE INDEX IF NOT EXISTS idx_projects_user        ON projects(user_id);
CREATE INDEX IF NOT EXISTS idx_projects_status      ON projects(status);
CREATE INDEX IF NOT EXISTS idx_projects_active      ON projects(user_id, is_active);
CREATE INDEX IF NOT EXISTS idx_projects_type        ON projects(type);
CREATE INDEX IF NOT EXISTS idx_projects_archived    ON projects(user_id, is_archived);
CREATE INDEX IF NOT EXISTS idx_projects_scr_id      ON projects(scr_id);

-- ── Iterations (txt2img provenance) ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS iterations (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id            INTEGER NOT NULL,
  run_sequence          INTEGER NOT NULL,
  timestamp             TEXT NOT NULL,
  leaf_hash             TEXT NOT NULL,
  input_hash            TEXT,
  output_hash           TEXT,
  previous_hash         TEXT,
  control_index         REAL,
  metadata              TEXT,                 -- JSON
  source_file           TEXT,                 -- artifact path: artifacts/<prefix>/<hash>
  image_filename        TEXT,                 -- display name preserved for receipt
  prompt                TEXT,                 -- denormalized for fast list rendering
  provider              TEXT,                 -- 'fal' | 'comfydeploy' | 'manual'
  provider_job_id       TEXT,
  witnessed             INTEGER NOT NULL DEFAULT 0,
  witness_id            TEXT,
  witness_timestamp     TEXT,
  witness_signature     TEXT,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  UNIQUE(project_id, run_sequence)
);

CREATE INDEX IF NOT EXISTS idx_iterations_project   ON iterations(project_id);
CREATE INDEX IF NOT EXISTS idx_iterations_seq       ON iterations(project_id, run_sequence);
CREATE INDEX IF NOT EXISTS idx_iterations_leaf      ON iterations(leaf_hash);

-- ── Merkle nodes ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS merkle_nodes (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id            INTEGER NOT NULL,
  level                 INTEGER NOT NULL,
  position              INTEGER NOT NULL,
  hash                  TEXT NOT NULL,
  left_child_hash       TEXT,
  right_child_hash      TEXT,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  UNIQUE(project_id, level, position)
);

CREATE INDEX IF NOT EXISTS idx_merkle_project       ON merkle_nodes(project_id);
CREATE INDEX IF NOT EXISTS idx_merkle_hash          ON merkle_nodes(hash);

-- ── Training runs (DEFERRED in v1 — schema ported for forward compat) ───────
CREATE TABLE IF NOT EXISTS training_runs (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id            INTEGER NOT NULL,
  run_sequence          INTEGER NOT NULL,
  status                TEXT DEFAULT 'pending',
  created_at            TEXT NOT NULL,
  started_at            TEXT,
  completed_at          TEXT,
  dataset_path          TEXT,
  dataset_merkle        TEXT,
  image_count           INTEGER DEFAULT 0,
  caption_count         INTEGER DEFAULT 0,
  base_model_path       TEXT,
  base_model_hash       TEXT,
  parent_run_id         INTEGER,
  lineage_type          TEXT DEFAULT 'ROOT',
  parent_checkpoint_path TEXT,
  parent_checkpoint_hash TEXT,
  network_dim           INTEGER,
  network_alpha         REAL,
  learning_rate         REAL,
  lr_scheduler          TEXT,
  lr_warmup_steps       INTEGER,
  optimizer_type        TEXT,
  max_train_epochs      INTEGER,
  train_batch_size      INTEGER,
  resolution            TEXT,
  mixed_precision       TEXT,
  save_precision        TEXT,
  params_hash           TEXT,
  config_json           TEXT,
  toml_path             TEXT,
  toml_hash             TEXT,
  toml_contents         TEXT,
  output_dir            TEXT,
  output_filename       TEXT,
  output_path           TEXT,
  model_hash            TEXT,
  header_hash           TEXT,
  header_size           INTEGER,
  tensor_count          INTEGER,
  parent_id             TEXT,
  parent_seal           TEXT,
  input_witness_id      TEXT,
  input_witness_timestamp TEXT,
  output_witness_id     TEXT,
  output_witness_timestamp TEXT,
  is_locked             INTEGER DEFAULT 0,
  locked_at             TEXT,
  lock_txid             TEXT,
  ipfs_cid              TEXT,
  parent_ipfs_cid       TEXT,
  scr_id                TEXT,
  source                TEXT DEFAULT 'kohya_ss',
  kohya_version         TEXT,
  session_hash          TEXT,
  capture_id            TEXT,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (parent_run_id) REFERENCES training_runs(id) ON DELETE SET NULL,
  UNIQUE(project_id, run_sequence)
);

CREATE INDEX IF NOT EXISTS idx_training_project     ON training_runs(project_id);
CREATE INDEX IF NOT EXISTS idx_training_status      ON training_runs(status);

-- ── Checkpoints (DEFERRED — training v2) ───────────────────────────────────
CREATE TABLE IF NOT EXISTS checkpoints (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id                INTEGER NOT NULL,
  epoch                 INTEGER,
  step                  INTEGER,
  filename              TEXT NOT NULL,
  file_path             TEXT NOT NULL,
  file_size             INTEGER,
  file_mtime            TEXT,
  header_hash           TEXT,
  is_final              INTEGER DEFAULT 0,
  witnessed             INTEGER DEFAULT 0,
  witness_id            TEXT,
  created_at            TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES training_runs(id) ON DELETE CASCADE
);

-- ── Files registry (global hash cache) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS files_registry (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  file_path             TEXT NOT NULL,
  file_size             INTEGER NOT NULL,
  mtime                 TEXT NOT NULL,
  hash                  TEXT NOT NULL,
  hash_algorithm        TEXT NOT NULL DEFAULT 'sha256',
  file_type             TEXT,
  registered_at         TEXT NOT NULL,
  UNIQUE(file_path, mtime, file_size)
);
