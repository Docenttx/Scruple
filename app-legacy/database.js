/**
 * database.js - Database Manager
 * 
 * SQLite database for projects and iterations.
 * Uses better-sqlite3 for synchronous operations.
 * 
 * SCRUPLE V3 - AI Provenance Middleware
 * Patent Pending
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Schema SQL
const SCHEMA_SQL = `
-- Projects table (with type field for txt2img vs training)
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  type TEXT DEFAULT 'txt2img',
  status TEXT DEFAULT 'unlocked',
  created_at TEXT NOT NULL,
  updated_at TEXT,
  locked_at TEXT,
  iteration_count INTEGER DEFAULT 0,
  merkle_root TEXT,
  scr_id TEXT,
  package_hash TEXT,
  rvn_txid TEXT,
  arweave_uri TEXT,
  ipfs_cid TEXT,
  final_control_index REAL,
  is_active INTEGER DEFAULT 0,
  vault_path TEXT,
  witnessed_count INTEGER DEFAULT 0,
  witness_signature TEXT,
  is_archived INTEGER DEFAULT 0,
  pre_scr_id TEXT
);

-- Iterations table (txt2img provenance)
CREATE TABLE IF NOT EXISTS iterations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  run_sequence INTEGER NOT NULL,
  timestamp TEXT NOT NULL,
  leaf_hash TEXT NOT NULL,
  input_hash TEXT,
  output_hash TEXT,
  previous_hash TEXT,
  control_index REAL,
  metadata TEXT,
  source_file TEXT,
  witnessed INTEGER DEFAULT 0,
  witness_id TEXT,
  witness_timestamp TEXT,
  witness_signature TEXT,
  FOREIGN KEY (project_id) REFERENCES projects(id),
  UNIQUE(project_id, run_sequence)
);

-- Merkle tree nodes table
CREATE TABLE IF NOT EXISTS merkle_nodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  level INTEGER NOT NULL,
  position INTEGER NOT NULL,
  hash TEXT NOT NULL,
  left_child_hash TEXT,
  right_child_hash TEXT,
  FOREIGN KEY (project_id) REFERENCES projects(id),
  UNIQUE(project_id, level, position)
);

-- Training runs table (LoRA training provenance)
CREATE TABLE IF NOT EXISTS training_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  run_sequence INTEGER NOT NULL,
  status TEXT DEFAULT 'pending',
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  
  -- Dataset provenance (Layer 3: Origin)
  dataset_path TEXT,
  dataset_merkle TEXT,
  image_count INTEGER DEFAULT 0,
  caption_count INTEGER DEFAULT 0,
  
  -- Base model tracking
  base_model_path TEXT,
  base_model_hash TEXT,
  
  -- Lineage tracking
  parent_run_id INTEGER,
  lineage_type TEXT DEFAULT 'ROOT',
  parent_checkpoint_path TEXT,
  parent_checkpoint_hash TEXT,
  
  -- Training parameters (Layer 2: Environment)
  network_dim INTEGER,
  network_alpha REAL,
  learning_rate REAL,
  lr_scheduler TEXT,
  lr_warmup_steps INTEGER,
  optimizer_type TEXT,
  max_train_epochs INTEGER,
  train_batch_size INTEGER,
  resolution TEXT,
  mixed_precision TEXT,
  save_precision TEXT,
  params_hash TEXT,
  config_json TEXT,
  
  -- TOML capture
  toml_path TEXT,
  toml_hash TEXT,
  toml_contents TEXT,
  
  -- Output provenance (Layer 1: Architecture)
  output_dir TEXT,
  output_filename TEXT,
  output_path TEXT,
  model_hash TEXT,
  header_hash TEXT,
  header_size INTEGER,
  tensor_count INTEGER,
  
  -- Composite hashes
  parent_id TEXT,
  parent_seal TEXT,
  
  -- Witness system
  input_witness_id TEXT,
  input_witness_timestamp TEXT,
  output_witness_id TEXT,
  output_witness_timestamp TEXT,
  
  -- Lock state (individual run)
  is_locked INTEGER DEFAULT 0,
  locked_at TEXT,
  lock_txid TEXT,
  ipfs_cid TEXT,
  parent_ipfs_cid TEXT,
  scr_id TEXT,
  
  -- Metadata
  source TEXT DEFAULT 'kohya_ss',
  kohya_version TEXT,
  session_hash TEXT,
  capture_id TEXT,
  
  FOREIGN KEY (project_id) REFERENCES projects(id),
  FOREIGN KEY (parent_run_id) REFERENCES training_runs(id) ON DELETE SET NULL,
  UNIQUE(project_id, run_sequence)
);

-- Checkpoints table (training epoch/step snapshots for DAG lineage)
CREATE TABLE IF NOT EXISTS checkpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  epoch INTEGER,
  step INTEGER,
  filename TEXT NOT NULL,
  file_path TEXT NOT NULL,
  file_size INTEGER,
  file_mtime TEXT,
  header_hash TEXT,
  is_final INTEGER DEFAULT 0,
  witnessed INTEGER DEFAULT 0,
  witness_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES training_runs(id) ON DELETE CASCADE
);

-- Files registry (global cache for large file hashes)
CREATE TABLE IF NOT EXISTS files_registry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_path TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  mtime TEXT NOT NULL,
  hash TEXT NOT NULL,
  hash_algorithm TEXT DEFAULT 'sha256',
  file_type TEXT,
  registered_at TEXT NOT NULL,
  UNIQUE(file_path, mtime, file_size)
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_iterations_project ON iterations(project_id);
CREATE INDEX IF NOT EXISTS idx_iterations_sequence ON iterations(run_sequence);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
CREATE INDEX IF NOT EXISTS idx_projects_active ON projects(is_active);
CREATE INDEX IF NOT EXISTS idx_projects_type ON projects(type);
CREATE INDEX IF NOT EXISTS idx_training_runs_project ON training_runs(project_id);
CREATE INDEX IF NOT EXISTS idx_training_runs_status ON training_runs(status);
CREATE INDEX IF NOT EXISTS idx_training_runs_parent ON training_runs(parent_run_id);
CREATE INDEX IF NOT EXISTS idx_training_runs_dataset ON training_runs(dataset_merkle);
CREATE INDEX IF NOT EXISTS idx_files_registry_path ON files_registry(file_path);
CREATE INDEX IF NOT EXISTS idx_files_registry_hash ON files_registry(hash);
CREATE INDEX IF NOT EXISTS idx_checkpoints_run ON checkpoints(run_id);
CREATE INDEX IF NOT EXISTS idx_checkpoints_hash ON checkpoints(header_hash);
CREATE INDEX IF NOT EXISTS idx_checkpoints_final ON checkpoints(is_final);
`;

class DatabaseManager {
  constructor(scrupleHome) {
    this.scrupleHome = scrupleHome;
    this.dbPath = path.join(scrupleHome, 'database', 'scruple.db');
    this.db = null;
  }

  /**
   * Initialize database connection and schema.
   */
  async initialize() {
    // Ensure directory exists
    const dbDir = path.dirname(this.dbPath);
    fs.mkdirSync(dbDir, { recursive: true });

    // Load better-sqlite3
    const Database = require('better-sqlite3');
    this.db = new Database(this.dbPath);
    
    // Enable foreign keys
    this.db.pragma('foreign_keys = ON');
    
    // Run migrations BEFORE schema (for existing databases)
    this.runMigrations();
    
    // Create schema (uses IF NOT EXISTS, safe for existing tables)
    this.db.exec(SCHEMA_SQL);
    
    console.log('[DATABASE] Initialized: ' + this.dbPath);
    return true;
  }

  /**
   * Run database migrations for schema updates.
   */
  runMigrations() {
    // Check if projects table exists first
    const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='projects'").all();
    if (tables.length === 0) {
      // Fresh database, no migrations needed
      return;
    }
    
    // Migration 1: Add projects.type column
    const projectColumns = this.db.prepare("PRAGMA table_info(projects)").all();
    const hasTypeColumn = projectColumns.some(col => col.name === 'type');
    
    if (!hasTypeColumn) {
      console.log('[DATABASE] Migrating: Adding type column to projects');
      this.db.exec("ALTER TABLE projects ADD COLUMN type TEXT DEFAULT 'txt2img'");
    }

    // Migration 1b: Add projects.vault_path column
    const hasVaultPathColumn = projectColumns.some(col => col.name === 'vault_path');
    if (!hasVaultPathColumn) {
      console.log('[DATABASE] Migrating: Adding vault_path column to projects');
      this.db.exec("ALTER TABLE projects ADD COLUMN vault_path TEXT");
    }

    // Migration 1c: Add projects.witnessed_count column
    const hasWitnessedCountColumn = projectColumns.some(col => col.name === 'witnessed_count');
    if (!hasWitnessedCountColumn) {
      console.log('[DATABASE] Migrating: Adding witnessed_count column to projects');
      this.db.exec("ALTER TABLE projects ADD COLUMN witnessed_count INTEGER DEFAULT 0");
    }

    // Migration 1d: Add projects.witness_signature column
    const hasWitnessSignatureColumn = projectColumns.some(col => col.name === 'witness_signature');
    if (!hasWitnessSignatureColumn) {
      console.log('[DATABASE] Migrating: Adding witness_signature column to projects');
      this.db.exec("ALTER TABLE projects ADD COLUMN witness_signature TEXT");
    }

    // Migration 1e: Add projects.is_archived column
    const hasIsArchivedColumn = projectColumns.some(col => col.name === 'is_archived');
    if (!hasIsArchivedColumn) {
      console.log('[DATABASE] Migrating: Adding is_archived column to projects');
      this.db.exec("ALTER TABLE projects ADD COLUMN is_archived INTEGER DEFAULT 0");
    }

    // Migration 1f: Add projects.pre_scr_id column
    const hasPreScrIdColumn = projectColumns.some(col => col.name === 'pre_scr_id');
    if (!hasPreScrIdColumn) {
      console.log('[DATABASE] Migrating: Adding pre_scr_id column to projects');
      this.db.exec("ALTER TABLE projects ADD COLUMN pre_scr_id TEXT");
    }
	
	// Migration 1g: Add projects.cloned_from column
    const hasClonedFromColumn = projectColumns.some(col => col.name === 'cloned_from');
    if (!hasClonedFromColumn) {
      console.log('[DATABASE] Migrating: Adding cloned_from column to projects');
      this.db.exec("ALTER TABLE projects ADD COLUMN cloned_from TEXT");
    }
    
	// Migration 2: Add training_runs JSON capture columns
    const trainingRunsExists = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='training_runs'").all();
    if (trainingRunsExists.length > 0) {
      const trColumns = this.db.prepare("PRAGMA table_info(training_runs)").all();
      const columnNames = trColumns.map(col => col.name);

      // Add json_path if missing
      if (!columnNames.includes('json_path')) {
        console.log('[DATABASE] Migrating: Adding json_path column to training_runs');
        this.db.exec("ALTER TABLE training_runs ADD COLUMN json_path TEXT");
      }

      // Add json_hash if missing
      if (!columnNames.includes('json_hash')) {
        console.log('[DATABASE] Migrating: Adding json_hash column to training_runs');
        this.db.exec("ALTER TABLE training_runs ADD COLUMN json_hash TEXT");
      }

      // Add json_contents if missing
      if (!columnNames.includes('json_contents')) {
        console.log('[DATABASE] Migrating: Adding json_contents column to training_runs');
        this.db.exec("ALTER TABLE training_runs ADD COLUMN json_contents TEXT");
      }

      // Add parent_checkpoint_id if missing
      if (!columnNames.includes('parent_checkpoint_id')) {
        console.log('[DATABASE] Migrating: Adding parent_checkpoint_id column to training_runs');
        this.db.exec("ALTER TABLE training_runs ADD COLUMN parent_checkpoint_id INTEGER REFERENCES checkpoints(id)");
      }
    }
  }

  /**
   * Close database connection.
   */
  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
      console.log('[DATABASE] Closed');
    }
  }

  // ===========================================================================
  // PROJECT OPERATIONS
  // ===========================================================================

  /**
   * Create a new project.
   */
  createProject(name, type = 'txt2img') {
    const now = new Date().toISOString();
    const preScrId = 'PRE_' + crypto.createHash('sha256').update(name + now).digest('hex').substring(0, 6).toUpperCase();
    
    const stmt = this.db.prepare(`
      INSERT INTO projects (name, type, status, created_at, updated_at, pre_scr_id)
      VALUES (?, ?, 'unlocked', ?, ?, ?)
    `);
    
    const result = stmt.run(name, type, now, now, preScrId);
    
    console.log('[DATABASE] Created project: ' + name + ' (ID: ' + result.lastInsertRowid + ', type: ' + type + ', pre_scr_id: ' + preScrId + ')');
    
    return this.getProject(result.lastInsertRowid);
  }

  /**
   * Get project by ID.
   */
  getProject(id) {
    const stmt = this.db.prepare(`
      SELECT p.*, 
        (SELECT COUNT(*) FROM training_runs WHERE project_id = p.id) as training_run_count
      FROM projects p
      WHERE p.id = ?
    `);
    return stmt.get(id);
  }

  /**
   * Get project by name.
   */
  getProjectByName(name) {
    const stmt = this.db.prepare('SELECT * FROM projects WHERE name = ?');
    return stmt.get(name);
  }

  /**
   * Get all projects.
   */
  getAllProjects() {
    const stmt = this.db.prepare(`
      SELECT p.*, 
        (SELECT COUNT(*) FROM training_runs WHERE project_id = p.id) as training_run_count
      FROM projects p
      WHERE p.is_archived = 0 OR p.is_archived IS NULL
      ORDER BY is_active DESC, updated_at DESC
    `);
    return stmt.all();
  }

  /**
   * Get project with all iterations.
   */
  getProjectWithIterations(projectId) {
    const project = this.getProject(projectId);
    if (!project) return null;

    const stmt = this.db.prepare(`
      SELECT * FROM iterations 
      WHERE project_id = ? 
      ORDER BY run_sequence ASC
    `);
    
    project.iterations = stmt.all(projectId);
    return project;
  }

  /**
   * Update project fields.
   */
  updateProject(id, updates) {
    const allowedFields = [
      'name', 'status', 'updated_at', 'locked_at', 'iteration_count',
      'merkle_root', 'scr_id', 'package_hash', 'rvn_txid', 'arweave_uri',
      'ipfs_cid', 'final_control_index', 'is_active', 'vault_path',
      'witnessed_count', 'witness_signature', 'is_archived', 'pre_scr_id', 'cloned_from'
    ];

    const setClause = [];
    const values = [];

    for (const [key, value] of Object.entries(updates)) {
      if (allowedFields.includes(key)) {
        setClause.push(key + ' = ?');
        values.push(value);
      }
    }

    // Always update updated_at
    if (!updates.updated_at) {
      setClause.push('updated_at = ?');
      values.push(new Date().toISOString());
    }

    if (setClause.length === 0) return null;

    values.push(id);

    const sql = `UPDATE projects SET ${setClause.join(', ')} WHERE id = ?`;
    const stmt = this.db.prepare(sql);
    stmt.run(...values);

    return this.getProject(id);
  }

  /**
   * Set active project (deactivates others).
   */
  setActiveProject(projectId) {
    // Deactivate all
    this.db.prepare('UPDATE projects SET is_active = 0').run();
    
    // Activate selected
    if (projectId) {
      this.db.prepare('UPDATE projects SET is_active = 1 WHERE id = ?').run(projectId);
    }
  }

  /**
   * Clear active project (deactivate all).
   */
  clearActiveProject() {
    this.db.prepare('UPDATE projects SET is_active = 0').run();
  }

  /**
   * Get active project.
   */
  getActiveProject() {
    const stmt = this.db.prepare('SELECT * FROM projects WHERE is_active = 1');
    return stmt.get();
  }

  /**
   * Archive a project (hide from workspace).
   */
  archiveProject(projectId) {
    // Clear active if this project is active
    const project = this.getProject(projectId);
    if (project && project.is_active) {
      this.clearActiveProject();
    }
    
    const stmt = this.db.prepare('UPDATE projects SET is_archived = 1, updated_at = ? WHERE id = ?');
    stmt.run(new Date().toISOString(), projectId);
    console.log('[DATABASE] Archived project: ' + projectId);
    return this.getProject(projectId);
  }

  /**
   * Unarchive a project (restore to workspace).
   */
  unarchiveProject(projectId) {
    const stmt = this.db.prepare('UPDATE projects SET is_archived = 0, updated_at = ? WHERE id = ?');
    stmt.run(new Date().toISOString(), projectId);
    console.log('[DATABASE] Unarchived project: ' + projectId);
    return this.getProject(projectId);
  }

  /**
   * Get all archived projects.
   */
  getArchivedProjects() {
    const stmt = this.db.prepare(`
      SELECT p.*, 
        (SELECT COUNT(*) FROM training_runs WHERE project_id = p.id) as training_run_count
      FROM projects p
      WHERE p.is_archived = 1
      ORDER BY updated_at DESC
    `);
    return stmt.all();
  }
  
  /**
   * Convenience: set project status directly.
   */
  updateProjectStatus(projectId, status) {
    const stmt = this.db.prepare(
      'UPDATE projects SET status = ?, updated_at = ? WHERE id = ?'
    );
    stmt.run(status, new Date().toISOString(), projectId);
    console.log(`[DATABASE] Project ${projectId} status → ${status}`);
    return this.getProject(projectId);
  }

  /**
   * Clone a project: copy record + all iterations to new identity.
   */
  cloneProject(sourceId, newName, newPreScrId) {
    const source = this.getProject(sourceId);
    if (!source) {
      console.log('[DATABASE] cloneProject: source not found: ' + sourceId);
      return null;
    }

    const now = new Date().toISOString();

    const insertProject = this.db.prepare(`
      INSERT INTO projects (
        name, type, status, created_at, updated_at,
        pre_scr_id, cloned_from
      ) VALUES (?, ?, 'unlocked', ?, ?, ?, ?)
    `);

    let newProjectId;
    try {
      const result = insertProject.run(
        newName,
        source.type || 'txt2img',
        now,
        now,
        newPreScrId,
        source.pre_scr_id || String(sourceId)
      );
      newProjectId = result.lastInsertRowid;
    } catch (err) {
      console.log('[DATABASE] cloneProject insert failed: ' + err.message);
      return null;
    }

    const sourceIterations = this.db.prepare(
      'SELECT * FROM iterations WHERE project_id = ? ORDER BY run_sequence ASC'
    ).all(sourceId);

    const insertIter = this.db.prepare(`
      INSERT INTO iterations (
        project_id, run_sequence, timestamp, leaf_hash,
        input_hash, output_hash, previous_hash, control_index,
        metadata, source_file, witnessed, witness_id,
        witness_timestamp, witness_signature
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const iter of sourceIterations) {
      try {
        insertIter.run(
          newProjectId, iter.run_sequence, iter.timestamp, iter.leaf_hash,
          iter.input_hash, iter.output_hash, iter.previous_hash, iter.control_index,
          iter.metadata, iter.source_file, iter.witnessed, iter.witness_id,
          iter.witness_timestamp, iter.witness_signature
        );
      } catch (err) {
        console.log('[DATABASE] cloneProject iter copy warning: ' + err.message);
      }
    }

    this.db.prepare(
      'UPDATE projects SET iteration_count = ? WHERE id = ?'
    ).run(sourceIterations.length, newProjectId);

    console.log(`[DATABASE] Cloned project ${sourceId} → ${newProjectId} (${newName}), ${sourceIterations.length} iterations`);
    return this.getProject(newProjectId);
  }

  // ===========================================================================
  // ITERATION OPERATIONS
  // ===========================================================================

  /**
   * Add a new iteration to a project.
   */
  addIteration(projectId, leafData) {
    // Get next sequence number
    const seqStmt = this.db.prepare(`
      SELECT COALESCE(MAX(run_sequence), 0) + 1 as next_seq 
      FROM iterations 
      WHERE project_id = ?
    `);
    const { next_seq } = seqStmt.get(projectId);

    // Get previous hash for chain linking
    const prevStmt = this.db.prepare(`
      SELECT leaf_hash FROM iterations 
      WHERE project_id = ? AND run_sequence = ?
    `);
    const prevIteration = prevStmt.get(projectId, next_seq - 1);
    const previousHash = prevIteration ? prevIteration.leaf_hash : null;

    // Insert iteration
    const insertStmt = this.db.prepare(`
      INSERT INTO iterations (
        project_id, run_sequence, timestamp, leaf_hash,
        previous_hash, metadata, source_file
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    // Use image_filename if available, fallback to source_file
    const imageFilename = leafData.image_filename || leafData.source_file || null;

    const result = insertStmt.run(
      projectId,
      next_seq,
      leafData.timestamp,
      leafData.leaf_hash,
      previousHash,
      JSON.stringify(leafData.metadata || {}),
      imageFilename
    );

    // Update project iteration count
    this.db.prepare(`
      UPDATE projects 
      SET iteration_count = iteration_count + 1, updated_at = ?
      WHERE id = ?
    `).run(new Date().toISOString(), projectId);

    console.log('[DATABASE] Added iteration #' + next_seq + ' to project ' + projectId);

    return {
      id: result.lastInsertRowid,
      run_sequence: next_seq,
      leaf_hash: leafData.leaf_hash,
      previous_hash: previousHash
    };
  }

  /**
   * Update an iteration record.
   */
  updateIteration(iterationId, updates) {
    const fields = [];
    const values = [];
    
    for (const [key, value] of Object.entries(updates)) {
      fields.push(`${key} = ?`);
      values.push(value);
    }
    
    values.push(iterationId);
    
    const stmt = this.db.prepare(`UPDATE iterations SET ${fields.join(', ')} WHERE id = ?`);
    return stmt.run(...values);
  }

  /**
   * Get iterations for a project.
   */
  getIterations(projectId) {
    const stmt = this.db.prepare(`
      SELECT 
        id, project_id, run_sequence, timestamp, leaf_hash,
        input_hash, output_hash, previous_hash, control_index,
        metadata, source_file, source_file as image_filename,
        timestamp as created_at
      FROM iterations 
      WHERE project_id = ? 
      ORDER BY run_sequence ASC
    `);
    return stmt.all(projectId);
  }

  /**
   * Get leaf hashes for Merkle tree building.
   */
  getLeafHashes(projectId) {
    const stmt = this.db.prepare(`
      SELECT leaf_hash FROM iterations 
      WHERE project_id = ? 
      ORDER BY run_sequence ASC
    `);
    return stmt.all(projectId).map(row => row.leaf_hash);
  }

  // ===========================================================================
  // MERKLE NODE OPERATIONS
  // ===========================================================================

  /**
   * Store Merkle tree node.
   */
  storeMerkleNode(projectId, level, position, hash, leftChild, rightChild) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO merkle_nodes 
      (project_id, level, position, hash, left_child_hash, right_child_hash)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(projectId, level, position, hash, leftChild, rightChild);
  }

  /**
   * Get Merkle root for project.
   */
  getMerkleRoot(projectId) {
    const stmt = this.db.prepare(`
      SELECT hash FROM merkle_nodes 
      WHERE project_id = ? 
      ORDER BY level DESC 
      LIMIT 1
    `);
    const result = stmt.get(projectId);
    return result ? result.hash : null;
  }

  /**
   * Clear Merkle tree for project (for rebuilding).
   */
  clearMerkleTree(projectId) {
    this.db.prepare('DELETE FROM merkle_nodes WHERE project_id = ?').run(projectId);
  }

  // ===========================================================================
  // UTILITY OPERATIONS
  // ===========================================================================

  /**
   * Get database statistics.
   */
  getStats() {
    const projects = this.db.prepare('SELECT COUNT(*) as count FROM projects').get();
    const iterations = this.db.prepare('SELECT COUNT(*) as count FROM iterations').get();
    const locked = this.db.prepare("SELECT COUNT(*) as count FROM projects WHERE status != 'unlocked'").get();

    return {
      totalProjects: projects.count,
      totalIterations: iterations.count,
      lockedProjects: locked.count
    };
  }

  // ===========================================================================
  // TRAINING RUN OPERATIONS
  // ===========================================================================

  /**
   * Add a new training run to a project.
   * Auto-determines lineage type based on parent_run_id and dataset comparison.
   */
  addTrainingRun(projectId, runData) {
    // Get next sequence number
    const seqStmt = this.db.prepare(`
      SELECT COALESCE(MAX(run_sequence), 0) + 1 as next_seq 
      FROM training_runs 
      WHERE project_id = ?
    `);
    const { next_seq } = seqStmt.get(projectId);

    const now = new Date().toISOString();

    // Determine lineage type
    let lineageType = 'ROOT';
    if (runData.parent_run_id) {
      const parentRun = this.getTrainingRun(runData.parent_run_id);
      if (parentRun) {
        // VERSION = same dataset merkle, BRANCH = different dataset
        if (parentRun.dataset_merkle === runData.dataset_merkle) {
          lineageType = 'VERSION';
        } else {
          lineageType = 'BRANCH';
        }
      }
    }

    const stmt = this.db.prepare(`
      INSERT INTO training_runs (
        project_id, run_sequence, status, created_at,
        dataset_path, dataset_merkle, image_count, caption_count,
        base_model_path, base_model_hash,
        parent_run_id, lineage_type, parent_checkpoint_path, parent_checkpoint_hash,
        network_dim, network_alpha, learning_rate, lr_scheduler, lr_warmup_steps,
        optimizer_type, max_train_epochs, train_batch_size, resolution,
        mixed_precision, save_precision, params_hash, config_json,
        toml_path, toml_hash, toml_contents,
        output_dir, output_filename, parent_id,
        source, kohya_version, session_hash, capture_id
      ) VALUES (
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?
      )
    `);

    const result = stmt.run(
      projectId, next_seq, runData.status || 'pending', now,
      runData.dataset_path, runData.dataset_merkle, runData.image_count || 0, runData.caption_count || 0,
      runData.base_model_path || runData.base_model, runData.base_model_hash,
      runData.parent_run_id || null, lineageType, runData.parent_checkpoint_path, runData.parent_checkpoint_hash,
      runData.network_dim, runData.network_alpha, runData.learning_rate, runData.lr_scheduler, runData.lr_warmup_steps,
      runData.optimizer_type, runData.max_train_epochs, runData.train_batch_size, runData.resolution,
      runData.mixed_precision, runData.save_precision, runData.params_hash, runData.config_json ? JSON.stringify(runData.config_json) : null,
      runData.toml_path, runData.toml_hash, runData.toml_contents,
      runData.output_dir, runData.output_filename, runData.parent_id,
      runData.source || 'kohya_ss', runData.kohya_version, runData.session_hash, runData.capture_id
    );

    console.log('[DATABASE] Added training run #' + next_seq + ' to project ' + projectId + ' (lineage: ' + lineageType + ')');

    return this.getTrainingRun(result.lastInsertRowid);
  }

  /**
   * Get a single training run by ID.
   */
  getTrainingRun(id) {
    const stmt = this.db.prepare('SELECT * FROM training_runs WHERE id = ?');
    return stmt.get(id);
  }

  /**
   * Get all training runs for a project.
   */
  getTrainingRuns(projectId) {
    const stmt = this.db.prepare(`
      SELECT * FROM training_runs 
      WHERE project_id = ? 
      ORDER BY run_sequence ASC
    `);
    return stmt.all(projectId);
  }

  /**
   * Get all training runs across all projects.
   */
  getAllTrainingRuns() {
    const stmt = this.db.prepare(`
      SELECT tr.*, p.name as project_name 
      FROM training_runs tr
      LEFT JOIN projects p ON tr.project_id = p.id
      ORDER BY tr.created_at DESC
    `);
    return stmt.all();
  }

  /**
   * Update a training run with new data.
   */
  updateTrainingRun(id, updates) {
    const allowedFields = [
      'status', 'started_at', 'completed_at',
      'dataset_path', 'dataset_merkle', 'image_count', 'caption_count',
      'base_model_path', 'base_model_hash',
      'parent_run_id', 'lineage_type', 'parent_checkpoint_path', 'parent_checkpoint_hash',
      'parent_checkpoint_id',
      'network_dim', 'network_alpha', 'learning_rate', 'lr_scheduler', 'lr_warmup_steps',
      'optimizer_type', 'max_train_epochs', 'train_batch_size', 'resolution',
      'mixed_precision', 'save_precision', 'params_hash', 'config_json',
      'toml_path', 'toml_hash', 'toml_contents',
      'json_path', 'json_hash', 'json_contents',
      'output_dir', 'output_filename', 'output_path', 'model_hash',
      'header_hash', 'header_size', 'tensor_count',
      'parent_id', 'parent_seal',
      'input_witness_id', 'input_witness_timestamp',
      'output_witness_id', 'output_witness_timestamp',
      'is_locked', 'locked_at', 'lock_txid', 'ipfs_cid', 'parent_ipfs_cid', 'scr_id',
      'source', 'kohya_version', 'session_hash'
    ];

    const setClause = [];
    const values = [];

    for (const [key, value] of Object.entries(updates)) {
      if (allowedFields.includes(key)) {
        setClause.push(key + ' = ?');
        values.push(value);
      }
    }

    if (setClause.length === 0) return null;

    values.push(id);

    const sql = `UPDATE training_runs SET ${setClause.join(', ')} WHERE id = ?`;
    const stmt = this.db.prepare(sql);
    stmt.run(...values);

    return this.getTrainingRun(id);
  }

  /**
   * Complete a training run (mark as complete with output data).
   */
  completeTrainingRun(id, completionData) {
    const updates = {
      status: 'complete',
      completed_at: new Date().toISOString(),
      ...completionData
    };
    return this.updateTrainingRun(id, updates);
  }

  /**
   * Lock a training run.
   */
  lockTrainingRun(id, lockData) {
    const updates = {
      is_locked: 1,
      locked_at: new Date().toISOString(),
      ...lockData
    };
    return this.updateTrainingRun(id, updates);
  }

  /**
   * Get ancestry chain for a training run (walk UP to root).
   * Returns array from root to the specified run.
   */
  getAncestryChain(runId) {
    const chain = [];
    let currentRun = this.getTrainingRun(runId);

    while (currentRun) {
      chain.unshift(currentRun); // Add to front (builds from root)
      
      if (!currentRun.parent_run_id) {
        break; // Reached root
      }
      
      currentRun = this.getTrainingRun(currentRun.parent_run_id);
    }

    return chain;
  }

  /**
   * Get all descendants of a training run (walk DOWN).
   * Returns flat array of all child runs.
   */
  getDescendants(runId) {
    const descendants = [];
    const queue = [runId];

    while (queue.length > 0) {
      const parentId = queue.shift();
      
      const stmt = this.db.prepare(`
        SELECT * FROM training_runs WHERE parent_run_id = ?
      `);
      const children = stmt.all(parentId);

      for (const child of children) {
        descendants.push(child);
        queue.push(child.id);
      }
    }

    return descendants;
  }

  /**
   * Check if a run has any locked descendants.
   */
  hasLockedDescendants(runId) {
    const descendants = this.getDescendants(runId);
    return descendants.some(d => d.is_locked === 1);
  }

  /**
   * Check if a training run can be unlocked.
   * Cannot unlock if any descendants are locked.
   */
  canUnlockTrainingRun(runId) {
    const run = this.getTrainingRun(runId);
    if (!run) {
      return { canUnlock: false, reason: 'Run not found' };
    }

    if (!run.is_locked) {
      return { canUnlock: false, reason: 'Run is not locked' };
    }

    const descendants = this.getDescendants(runId);
    const lockedDescendants = descendants.filter(d => d.is_locked === 1);

    if (lockedDescendants.length > 0) {
      return {
        canUnlock: false,
        reason: 'Has locked descendants',
        lockedDescendants: lockedDescendants.map(d => ({ id: d.id, scr_id: d.scr_id }))
      };
    }

    return { canUnlock: true };
  }

  /**
   * Lock a training run and all its ancestors.
   * Returns the full chain of locked runs.
   */
  lockTrainingRunWithAncestors(runId, lockData) {
    const chain = this.getAncestryChain(runId);
    const lockedRuns = [];

    for (const run of chain) {
      if (!run.is_locked) {
        const lockedRun = this.lockTrainingRun(run.id, {
          ...lockData,
          // Each run gets its own lock timestamp
          locked_at: new Date().toISOString()
        });
        lockedRuns.push(lockedRun);
      } else {
        lockedRuns.push(run);
      }
    }

    return lockedRuns;
  }

  // ===========================================================================
  // FILES REGISTRY OPERATIONS
  // ===========================================================================

  /**
   * Get a file from registry by path and stats (exact match).
   */
  getFileFromRegistry(filePath, mtime, fileSize) {
    const stmt = this.db.prepare(`
      SELECT * FROM files_registry 
      WHERE file_path = ? AND mtime = ? AND file_size = ?
    `);
    return stmt.get(filePath, mtime, fileSize);
  }

  /**
   * Get most recent registry entry for a file path.
   */
  getFileByPath(filePath) {
    const stmt = this.db.prepare(`
      SELECT * FROM files_registry 
      WHERE file_path = ? 
      ORDER BY registered_at DESC 
      LIMIT 1
    `);
    return stmt.get(filePath);
  }

  /**
   * Register a file hash in the registry.
   */
  registerFile(data) {
    const now = new Date().toISOString();

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO files_registry 
      (file_path, file_size, mtime, hash, hash_algorithm, file_type, registered_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      data.filePath,
      data.fileSize,
      data.mtime,
      data.hash,
      data.hashAlgorithm || 'sha256',
      data.fileType || null,
      now
    );

    console.log('[DATABASE] Registered file: ' + data.filePath.split('/').pop() + ' (' + data.hash.substring(0, 12) + '...)');

    return {
      id: result.lastInsertRowid,
      file_path: data.filePath,
      file_size: data.fileSize,
      mtime: data.mtime,
      hash: data.hash,
      hash_algorithm: data.hashAlgorithm || 'sha256',
      file_type: data.fileType,
      registered_at: now
    };
  }

  /**
   * Check if a file needs hashing (not in registry or modified).
   */
  checkFileNeedsHash(filePath, mtime, fileSize) {
    const existing = this.getFileFromRegistry(filePath, mtime, fileSize);
    return {
      needsHash: !existing,
      existingEntry: existing
    };
  }

  /**
   * Get registry statistics.
   */
  getRegistryStats() {
    const count = this.db.prepare('SELECT COUNT(*) as count FROM files_registry').get();
    const size = this.db.prepare('SELECT SUM(file_size) as total FROM files_registry').get();
    
    return {
      fileCount: count.count,
      totalSize: size.total || 0
    };
  }

  // ===========================================================================
  // CHECKPOINTS OPERATIONS (Training DAG Lineage)
  // ===========================================================================

  /**
   * Add a checkpoint for a training run.
   * @param {number} runId - Training run ID
   * @param {object} data - Checkpoint data
   * @returns {object} - Created checkpoint record
   */
  addCheckpoint(runId, data) {
    const now = new Date().toISOString();

    const stmt = this.db.prepare(`
      INSERT INTO checkpoints (
        run_id, epoch, step, filename, file_path, 
        file_size, file_mtime, header_hash, is_final, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      runId,
      data.epoch || null,
      data.step || null,
      data.filename,
      data.filePath,
      data.fileSize || null,
      data.fileMtime || null,
      data.headerHash || null,
      data.isFinal ? 1 : 0,
      now
    );

    console.log('[DATABASE] Added checkpoint: ' + data.filename + ' (run_id: ' + runId + ', is_final: ' + (data.isFinal ? 'yes' : 'no') + ')');

    return this.getCheckpoint(result.lastInsertRowid);
  }

  /**
   * Get a checkpoint by ID.
   */
  getCheckpoint(id) {
    const stmt = this.db.prepare('SELECT * FROM checkpoints WHERE id = ?');
    return stmt.get(id);
  }

  /**
   * Get all checkpoints for a training run.
   * @param {number} runId - Training run ID
   * @param {boolean} includeFinal - Include final checkpoint (default: true)
   * @returns {array} - Checkpoints ordered by epoch/step
   */
  getCheckpointsByRun(runId, includeFinal = true) {
    let sql = `
      SELECT * FROM checkpoints 
      WHERE run_id = ?
    `;
    
    if (!includeFinal) {
      sql += ' AND is_final = 0';
    }
    
    sql += ' ORDER BY COALESCE(epoch, 0), COALESCE(step, 0) ASC';
    
    const stmt = this.db.prepare(sql);
    return stmt.all(runId);
  }

  /**
   * Get the final checkpoint for a training run.
   * @param {number} runId - Training run ID
   * @returns {object|null} - Final checkpoint or null
   */
  getFinalCheckpoint(runId) {
    const stmt = this.db.prepare(`
      SELECT * FROM checkpoints 
      WHERE run_id = ? AND is_final = 1
      LIMIT 1
    `);
    return stmt.get(runId);
  }

  /**
   * Find a checkpoint by its header hash (for resume lineage lookup).
   * This is the "Hash-first" lookup for linking resumed training to parent checkpoint.
   * @param {string} headerHash - SHA-256 hash of safetensors header
   * @returns {object|null} - Matching checkpoint or null
   */
  getCheckpointByHash(headerHash) {
    const stmt = this.db.prepare(`
      SELECT c.*, tr.project_id, tr.output_filename as run_output_name
      FROM checkpoints c
      JOIN training_runs tr ON c.run_id = tr.id
      WHERE c.header_hash = ?
      LIMIT 1
    `);
    return stmt.get(headerHash);
  }

  /**
   * Find a checkpoint by file path (fallback lookup).
   * Used when hash lookup fails but we have a path.
   * @param {string} filePath - Full path to checkpoint file
   * @returns {object|null} - Matching checkpoint or null
   */
  getCheckpointByPath(filePath) {
    const stmt = this.db.prepare(`
      SELECT c.*, tr.project_id, tr.output_filename as run_output_name
      FROM checkpoints c
      JOIN training_runs tr ON c.run_id = tr.id
      WHERE c.file_path = ?
      ORDER BY c.created_at DESC
      LIMIT 1
    `);
    return stmt.get(filePath);
  }

  /**
   * Update a checkpoint record.
   * @param {number} id - Checkpoint ID
   * @param {object} updates - Fields to update
   * @returns {object} - Updated checkpoint
   */
  updateCheckpoint(id, updates) {
    const allowedFields = [
      'epoch', 'step', 'filename', 'file_path', 'file_size', 
      'file_mtime', 'header_hash', 'is_final', 'witnessed', 'witness_id'
    ];

    const setClause = [];
    const values = [];

    for (const [key, value] of Object.entries(updates)) {
      // Convert camelCase to snake_case for DB fields
      const dbKey = key.replace(/([A-Z])/g, '_$1').toLowerCase();
      if (allowedFields.includes(dbKey)) {
        setClause.push(dbKey + ' = ?');
        values.push(value);
      }
    }

    if (setClause.length === 0) return null;

    values.push(id);

    const sql = `UPDATE checkpoints SET ${setClause.join(', ')} WHERE id = ?`;
    const stmt = this.db.prepare(sql);
    stmt.run(...values);

    return this.getCheckpoint(id);
  }

  /**
   * Get checkpoint count for a training run.
   * @param {number} runId - Training run ID
   * @returns {object} - { total, intermediate, final }
   */
  getCheckpointCount(runId) {
    const total = this.db.prepare('SELECT COUNT(*) as count FROM checkpoints WHERE run_id = ?').get(runId);
    const intermediate = this.db.prepare('SELECT COUNT(*) as count FROM checkpoints WHERE run_id = ? AND is_final = 0').get(runId);
    const final = this.db.prepare('SELECT COUNT(*) as count FROM checkpoints WHERE run_id = ? AND is_final = 1').get(runId);

    return {
      total: total.count,
      intermediate: intermediate.count,
      final: final.count
    };
  }

  /**
   * Get all runs that branched from a specific checkpoint.
   * Useful for visualizing the DAG "children" of a checkpoint.
   * @param {number} checkpointId - Parent checkpoint ID
   * @returns {array} - Training runs that resumed from this checkpoint
   */
  getRunsFromCheckpoint(checkpointId) {
    const stmt = this.db.prepare(`
      SELECT tr.*, p.name as project_name
      FROM training_runs tr
      JOIN projects p ON tr.project_id = p.id
      WHERE tr.parent_checkpoint_id = ?
      ORDER BY tr.created_at ASC
    `);
    return stmt.all(checkpointId);
  }

  /**
   * Get the full lineage chain for a training run.
   * Walks up through parent_checkpoint_id to find all ancestors.
   * @param {number} runId - Starting training run ID
   * @returns {array} - Array of { run, checkpoint } pairs from root to current
   */
  getCheckpointLineage(runId) {
    const lineage = [];
    let currentRun = this.getTrainingRun(runId);

    while (currentRun) {
      const entry = { run: currentRun, checkpoint: null };

      // If this run has a parent checkpoint, add it
      if (currentRun.parent_checkpoint_id) {
        entry.checkpoint = this.getCheckpoint(currentRun.parent_checkpoint_id);
      }

      lineage.unshift(entry); // Add to front to build root-to-current order

      // Walk to parent run (via checkpoint's run_id)
      if (entry.checkpoint) {
        currentRun = this.getTrainingRun(entry.checkpoint.run_id);
      } else {
        break; // No parent checkpoint = root
      }
    }

    return lineage;
  }
}

module.exports = { DatabaseManager };
