/**
 * watcher.js - File Watcher V3
 * 
 * Watches for .provenance.json files (the atomic trigger).
 * Independently verifies image hash for security.
 * 
 * Contract:
 * - Python writes PNG â†’ computes hash â†’ atomic JSON rename
 * - Electron sees .provenance.json â†’ reads image â†’ verifies hash
 * - Only valid hashes are added to Merkle tree
 * 
 * SCRUPLE V3 - AI Provenance Middleware
 * Patent Pending
 */

const chokidar = require('chokidar');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const EventEmitter = require('events');

class FileWatcher extends EventEmitter {
  constructor(watchPath, sessionId) {
    super();
    this.watchPath = watchPath;
    this.sessionId = sessionId;
    this.watcher = null;
    this.debounceTimers = new Map();
    this.processedFiles = new Set();  // Prevent double-processing
    this.DEBOUNCE_MS = 100;
  }

  /**
   * Start watching for provenance files.
   */
  async start() {
    // Ensure directory exists
    fs.mkdirSync(this.watchPath, { recursive: true });

    console.log('[WATCHER] Starting watch on: ' + this.watchPath);

    this.watcher = chokidar.watch(this.watchPath, {
      persistent: true,
      ignoreInitial: true,  // Don't process existing files
      depth: 2,             // Watch project subfolders
      awaitWriteFinish: {
        stabilityThreshold: 100,
        pollInterval: 50
      }
    });

    // Watch for .provenance.json files (THE TRIGGER)
    this.watcher.on('add', (filePath) => {
      if (filePath.endsWith('.provenance.json')) {
        this.handleNewFile(filePath);
      }
    });

    // Also watch for renames (atomic write pattern)
    this.watcher.on('change', (filePath) => {
      if (filePath.endsWith('.provenance.json')) {
        this.handleNewFile(filePath);
      }
    });

    this.watcher.on('error', (error) => {
      console.error('[WATCHER] Error:', error);
      this.emit('error', error);
    });

    this.watcher.on('ready', () => {
      console.log('[WATCHER] Ready and watching for .provenance.json');
    });
  }

  /**
   * Handle new provenance file detection.
   */
  handleNewFile(filePath) {
    // Prevent double-processing
    if (this.processedFiles.has(filePath)) {
      return;
    }

    // Debounce rapid file events
    if (this.debounceTimers.has(filePath)) {
      clearTimeout(this.debounceTimers.get(filePath));
    }

    const timer = setTimeout(() => {
      this.debounceTimers.delete(filePath);
      this.processFile(filePath);
    }, this.DEBOUNCE_MS);

    this.debounceTimers.set(filePath, timer);
  }

  /**
   * Process a provenance file with independent verification.
   */
  async processFile(filePath) {
    console.log('[WATCHER] Processing: ' + path.basename(filePath));

    try {
      // Mark as processed (before any async operations)
      this.processedFiles.add(filePath);

      // =====================================================================
      // 1. READ AND PARSE PROVENANCE JSON
      // =====================================================================
      const content = fs.readFileSync(filePath, 'utf8');
      const provenance = JSON.parse(content);

      // =====================================================================
      // 2. VALIDATE SESSION ID (Ghost Ingest Prevention)
      // =====================================================================
      if (provenance.session_id !== this.sessionId) {
        console.warn('[WATCHER] Session mismatch, ignoring stale file');
        console.warn('[WATCHER]   File session: ' + provenance.session_id);
        console.warn('[WATCHER]   Current session: ' + this.sessionId);
        return;
      }

      // =====================================================================
      // 3. GET IMAGE PATH AND LEAF HASH
      // =====================================================================
      const imagePath = provenance.image_path;
      const pythonHash = provenance.leaf_hash;  // Python's computed hash

      if (!imagePath || !pythonHash) {
        console.warn('[WATCHER] Missing image_path or leaf_hash');
        return;
      }

      // Check image file exists (handle both absolute and relative paths)
      let resolvedImagePath = imagePath;
      if (!fs.existsSync(imagePath)) {
        // Try relative to JSON file
        const jsonDir = path.dirname(filePath);
        const imageFilename = provenance.image_filename || path.basename(imagePath);
        resolvedImagePath = path.join(jsonDir, imageFilename);
        
        if (!fs.existsSync(resolvedImagePath)) {
          console.error('[WATCHER] Image file not found: ' + imagePath);
          return;
        }
      }

      // =====================================================================
      // 4. INDEPENDENT VERIFICATION - Compute our own hash
      // =====================================================================
      const electronHash = this.hashFile(resolvedImagePath);

      if (electronHash !== pythonHash) {
        console.error('[WATCHER] âŒ HASH MISMATCH - Possible tampering!');
        console.error('[WATCHER]   Python hash:   ' + pythonHash);
        console.error('[WATCHER]   Electron hash: ' + electronHash);
        this.emit('verification-failed', {
          filePath,
          pythonHash,
          electronHash,
          projectName: provenance.project_name
        });
        return;
      }

      console.log('[WATCHER] âœ“ Hash verified: ' + pythonHash.substring(0, 16) + '...');

      // =====================================================================
      // 5. EMIT VALID LEAF FOR MERKLE TREE
      // =====================================================================
      const leafData = {
        project_name: provenance.project_name,
        run_sequence: provenance.run_sequence,
        timestamp: provenance.timestamp,
        leaf_hash: electronHash,  // Use OUR verified hash (same value, but independently computed)
        image_path: resolvedImagePath,
        image_filename: provenance.image_filename,
        provenance_path: filePath,
        metadata: provenance.metadata || {},
        image_shape: provenance.image_shape
      };

      console.log('[WATCHER] Emitting verified leaf for project: ' + leafData.project_name);
      this.emit('leaf', leafData);

    } catch (error) {
      console.error('[WATCHER] Failed to process file:', error);
      this.emit('error', error);
    }
  }

  /**
   * Compute SHA-256 hash of file.
   * This is the independent verification - we don't trust Python's hash.
   */
  hashFile(filePath) {
    const fileBuffer = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(fileBuffer).digest('hex');
  }

  /**
   * Update session ID (if session changes).
   */
  setSessionId(sessionId) {
    this.sessionId = sessionId;
    console.log('[WATCHER] Session ID updated: ' + sessionId);
  }

  /**
   * Stop watching.
   */
  async stop() {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
      console.log('[WATCHER] Stopped');
    }

    // Clear debounce timers
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    this.processedFiles.clear();
  }
}

module.exports = { FileWatcher };
