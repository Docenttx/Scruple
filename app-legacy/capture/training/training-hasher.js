/**
 * training-hasher.js - Training Provenance Hash Utilities
 * 
 * Implements three-layer composite hashing for LoRA training provenance:
 * - Layer 1: Architecture (safetensors header hash)
 * - Layer 2: Environment (training parameters hash)
 * - Layer 3: Origin (dataset Merkle root)
 * 
 * Composite hashes:
 * - parent_id = SHA256(dataset_merkle + params_hash)
 * - parent_seal = SHA256(parent_id + header_hash)
 * 
 * SCRUPLE V3 - AI Provenance Middleware
 * Patent Pending
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ============================================================================
// LAYER 1: ARCHITECTURE (Safetensors Header Hash)
// ============================================================================

/**
 * Read and hash only the safetensors header (metadata + tensor keys).
 * Safetensors format: [8-byte header_size (LE)] [JSON header] [binary weights]
 * 
 * This captures the model's "DNA" (rank, alpha, tensor structure) without
 * reading the full 100-500MB weight data.
 * 
 * @param {string} filepath - Path to .safetensors file
 * @returns {object} - { headerHash, headerSize, metadata }
 */
function hashSafetensorsHeader(filepath) {
  if (!fs.existsSync(filepath)) {
    throw new Error(`Safetensors file not found: ${filepath}`);
  }

  const fd = fs.openSync(filepath, 'r');
  
  try {
    // Read 8-byte size prefix (little-endian uint64)
    const sizeBuffer = Buffer.alloc(8);
    fs.readSync(fd, sizeBuffer, 0, 8, 0);
    
    // Parse as little-endian 64-bit unsigned integer
    // Note: JavaScript safe integer limit is 2^53, but headers are typically <1MB
    const headerSize = Number(sizeBuffer.readBigUInt64LE());
    
    if (headerSize <= 0 || headerSize > 100 * 1024 * 1024) {
      throw new Error(`Invalid header size: ${headerSize}`);
    }
    
    // Read the JSON header
    const headerBuffer = Buffer.alloc(headerSize);
    fs.readSync(fd, headerBuffer, 0, headerSize, 8);
    
    // Hash the raw header bytes
    const headerHash = crypto.createHash('sha256').update(headerBuffer).digest('hex');
    
    // Parse header JSON for metadata extraction
    let metadata = null;
    let tensorCount = 0;
    
    try {
      const headerJson = JSON.parse(headerBuffer.toString('utf8'));
      metadata = headerJson.__metadata__ || null;
      tensorCount = Object.keys(headerJson).filter(k => k !== '__metadata__').length;
    } catch (e) {
      // Header parse failed, but hash is still valid
      console.warn('[TRAINING-HASHER] Could not parse header JSON:', e.message);
    }
    
    return {
      headerHash,
      headerSize,
      metadata,
      tensorCount
    };
    
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Attempt to extract LoRA rank/alpha from safetensors metadata.
 * 
 * @param {object} metadata - Parsed __metadata__ from header
 * @returns {object} - { rank, alpha } or nulls
 */
function extractLoraInfo(metadata) {
  if (!metadata) {
    return { rank: null, alpha: null };
  }
  
  // Common metadata keys used by different training tools
  const rankKeys = ['ss_network_dim', 'lora_rank', 'network_dim', 'dim'];
  const alphaKeys = ['ss_network_alpha', 'lora_alpha', 'network_alpha', 'alpha'];
  
  let rank = null;
  let alpha = null;
  
  for (const key of rankKeys) {
    if (metadata[key] !== undefined) {
      rank = parseInt(metadata[key], 10);
      break;
    }
  }
  
  for (const key of alphaKeys) {
    if (metadata[key] !== undefined) {
      alpha = parseFloat(metadata[key]);
      break;
    }
  }
  
  return { rank, alpha };
}

// ============================================================================
// LAYER 2: ENVIRONMENT (Training Parameters Hash)
// ============================================================================

/**
 * Canonicalize and hash training parameters.
 * Uses deterministic JSON serialization for reproducible hashing.
 * 
 * @param {object} inputData - Training parameters from capture_training.js
 * @returns {object} - { paramsHash, canonical }
 */
function hashTrainingParams(inputData) {
  // Extract reproducibility-critical params in canonical order
  // These are the params that affect the final model
  const canonical = {
    // Base model
    base_model: inputData.pretrainedModel || inputData.base_model || '',
    
    // Network architecture
    network_dim: parseInt(inputData.networkDim || inputData.network_dim || 0, 10),
    network_alpha: parseFloat(inputData.networkAlpha || inputData.network_alpha || 0),
    network_module: inputData.networkModule || inputData.network_module || 'Standard',
    
    // Training parameters
    learning_rate: parseFloat(inputData.learningRate || inputData.learning_rate || 0),
    lr_scheduler: inputData.lrScheduler || inputData.lr_scheduler || '',
    lr_warmup_steps: parseInt(inputData.lrWarmupSteps || inputData.lr_warmup_steps || 0, 10),
    
    // Optimizer
    optimizer_type: inputData.optimizerType || inputData.optimizer_type || '',
    
    // Training duration
    max_train_epochs: parseInt(inputData.maxTrainEpochs || inputData.max_train_epochs || 0, 10),
    train_batch_size: parseInt(inputData.trainBatchSize || inputData.train_batch_size || 1, 10),
    
    // Image settings
    resolution: inputData.resolution || '',
    
    // Precision
    mixed_precision: inputData.mixedPrecision || inputData.mixed_precision || '',
    save_precision: inputData.savePrecision || inputData.save_precision || ''
  };
  
  // Sort keys and stringify for deterministic hashing
  const sortedKeys = Object.keys(canonical).sort();
  const sortedCanonical = {};
  for (const key of sortedKeys) {
    sortedCanonical[key] = canonical[key];
  }
  
  const jsonString = JSON.stringify(sortedCanonical);
  const paramsHash = crypto.createHash('sha256').update(jsonString).digest('hex');
  
  return {
    paramsHash,
    canonical: sortedCanonical
  };
}

// ============================================================================
// LAYER 3: ORIGIN (Dataset Merkle Root)
// ============================================================================

/**
 * Hash a single file.
 * 
 * @param {string} filepath - Path to file
 * @returns {string} - SHA256 hex hash
 */
function hashFile(filepath) {
  const content = fs.readFileSync(filepath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Combine two hashes using Merkle tree convention (sort before concat).
 * 
 * @param {string} left - Left hash
 * @param {string} right - Right hash
 * @returns {string} - Combined hash
 */
function hashPair(left, right) {
  const combined = left < right ? left + right : right + left;
  return crypto.createHash('sha256').update(combined).digest('hex');
}

/**
 * Build Merkle root from list of hashes.
 * 
 * @param {string[]} hashes - Array of hex hashes
 * @returns {string|null} - Merkle root or null if empty
 */
function computeMerkleRoot(hashes) {
  if (!hashes || hashes.length === 0) {
    return null;
  }
  
  if (hashes.length === 1) {
    return hashes[0];
  }
  
  let currentLevel = [...hashes];
  
  while (currentLevel.length > 1) {
    // Pad odd levels by duplicating last element
    if (currentLevel.length % 2 === 1) {
      currentLevel.push(currentLevel[currentLevel.length - 1]);
    }
    
    const nextLevel = [];
    for (let i = 0; i < currentLevel.length; i += 2) {
      nextLevel.push(hashPair(currentLevel[i], currentLevel[i + 1]));
    }
    
    currentLevel = nextLevel;
  }
  
  return currentLevel[0];
}

/**
 * Compute Merkle root for all valid files in a dataset folder.
 * Includes images and caption files.
 * Recursively scans subfolders (for Kohya_ss folder structure).
 * Excludes cache files, latent caches, and hidden files.
 * 
 * @param {string} folderPath - Path to dataset folder
 * @returns {object} - { merkleRoot, imageCount, captionCount, fileHashes }
 */
function computeDatasetMerkle(folderPath) {
  if (!fs.existsSync(folderPath)) {
    console.warn(`[TRAINING-HASHER] Dataset folder not found: ${folderPath}`);
    return {
      merkleRoot: null,
      imageCount: 0,
      captionCount: 0,
      fileHashes: []
    };
  }
  
  const stats = fs.statSync(folderPath);
  if (!stats.isDirectory()) {
    console.warn(`[TRAINING-HASHER] Not a directory: ${folderPath}`);
    return {
      merkleRoot: null,
      imageCount: 0,
      captionCount: 0,
      fileHashes: []
    };
  }
  
  const imageExts = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif']);
  const captionExts = new Set(['.txt', '.caption']);
  
  // Exclusion patterns for cache files
  const excludePatterns = [
    /\.json$/i,           // Latent cache metadata
    /\.npz$/i,            // Latent cache data  
    /\.safetensors$/i,    // Models in dataset folder
    /^\..*$/,             // Hidden files (start with .)
    /meta_lat\.json$/i,   // Specific cache file
    /\.cache$/i,          // Cache files
    /\.pt$/i              // PyTorch cache files
  ];
  
  // Directories to skip
  const excludeDirs = new Set([
    '__pycache__', 
    '.cache', 
    'logs', 
    '.ipynb_checkpoints',
    'node_modules',
    '.git'
  ]);
  
  /**
   * Recursively scan directory for valid files.
   */
  function scanDirectory(dir, relativePath = '') {
    const files = [];
    
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      console.warn(`[TRAINING-HASHER] Cannot read directory: ${dir}`);
      return files;
    }
    
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath = relativePath ? path.join(relativePath, entry.name) : entry.name;
      
      if (entry.isDirectory()) {
        // Skip excluded directories and hidden folders
        if (!excludeDirs.has(entry.name) && !entry.name.startsWith('.')) {
          files.push(...scanDirectory(fullPath, relPath));
        }
      } else {
        // Check if file should be excluded
        const excluded = excludePatterns.some(p => p.test(entry.name));
        if (excluded) continue;
        
        // Check if file is a valid image or caption
        const ext = path.extname(entry.name).toLowerCase();
        const isImage = imageExts.has(ext);
        const isCaption = captionExts.has(ext);
        
        if (isImage || isCaption) {
          files.push({ 
            fullPath, 
            relPath, 
            isImage, 
            isCaption 
          });
        }
      }
    }
    
    return files;
  }
  
  // Scan recursively
  const allFiles = scanDirectory(folderPath);
  
  // Sort by relative path for deterministic order
  allFiles.sort((a, b) => a.relPath.localeCompare(b.relPath));
  
  if (allFiles.length === 0) {
    console.warn(`[TRAINING-HASHER] No valid files in dataset: ${folderPath}`);
    return {
      merkleRoot: null,
      imageCount: 0,
      captionCount: 0,
      fileHashes: []
    };
  }
  
  // Hash each file
  const fileHashes = [];
  let imageCount = 0;
  let captionCount = 0;
  
  for (const file of allFiles) {
    try {
      const hash = hashFile(file.fullPath);
      fileHashes.push({ filename: file.relPath, hash });
      
      if (file.isImage) {
        imageCount++;
      } else {
        captionCount++;
      }
    } catch (e) {
      console.warn(`[TRAINING-HASHER] Failed to hash ${file.relPath}:`, e.message);
    }
  }
  
  // Compute Merkle root
  const hashes = fileHashes.map(f => f.hash);
  const merkleRoot = computeMerkleRoot(hashes);
  
  console.log(`[TRAINING-HASHER] Dataset Merkle: ${merkleRoot?.substring(0, 16)}... (${imageCount} images, ${captionCount} captions)`);
  
  return {
    merkleRoot,
    imageCount,
    captionCount,
    fileHashes
  };
}

// ============================================================================
// COMPOSITE HASHES
// ============================================================================

/**
 * Compute Parent ID: combines Origin (Layer 3) + Environment (Layer 2).
 * This represents "what data + how trained" before the model exists.
 * 
 * @param {string} datasetMerkle - Dataset Merkle root
 * @param {string} paramsHash - Training params hash
 * @returns {string} - Parent ID hash
 */
function computeParentId(datasetMerkle, paramsHash) {
  if (!datasetMerkle || !paramsHash) {
    throw new Error('Cannot compute parent_id: missing dataset_merkle or params_hash');
  }
  
  const combined = datasetMerkle + paramsHash;
  return crypto.createHash('sha256').update(combined).digest('hex');
}

/**
 * Compute Parent Seal: combines Parent ID + Architecture (Layer 1).
 * This is the final immutable record after training completes.
 * 
 * @param {string} parentId - Parent ID hash
 * @param {string} headerHash - Safetensors header hash
 * @returns {string} - Parent Seal hash
 */
function computeParentSeal(parentId, headerHash) {
  if (!parentId || !headerHash) {
    throw new Error('Cannot compute parent_seal: missing parent_id or header_hash');
  }
  
  const combined = parentId + headerHash;
  return crypto.createHash('sha256').update(combined).digest('hex');
}

// ============================================================================
// FULL PROVENANCE COMPUTATION
// ============================================================================

/**
 * Compute complete training provenance.
 * 
 * @param {string} datasetPath - Path to dataset folder
 * @param {object} inputData - Training parameters
 * @param {string} modelPath - Path to output .safetensors file (optional for pending)
 * @returns {object} - Complete provenance data
 */
function computeTrainingProvenance(datasetPath, inputData, modelPath = null) {
  console.log('[TRAINING-HASHER] Computing training provenance...');
  
  // Layer 3: Origin
  const dataset = computeDatasetMerkle(datasetPath);
  
  // Layer 2: Environment
  const params = hashTrainingParams(inputData);
  
  // Parent ID (can compute before training completes)
  let parentId = null;
  if (dataset.merkleRoot && params.paramsHash) {
    parentId = computeParentId(dataset.merkleRoot, params.paramsHash);
    console.log(`[TRAINING-HASHER] Parent ID: ${parentId.substring(0, 16)}...`);
  }
  
  // Layer 1 + Parent Seal (only if model exists)
  let header = null;
  let parentSeal = null;
  
  if (modelPath && fs.existsSync(modelPath)) {
    header = hashSafetensorsHeader(modelPath);
    console.log(`[TRAINING-HASHER] Header Hash: ${header.headerHash.substring(0, 16)}...`);
    
    if (parentId) {
      parentSeal = computeParentSeal(parentId, header.headerHash);
      console.log(`[TRAINING-HASHER] Parent Seal: ${parentSeal.substring(0, 16)}...`);
    }
  }
  
  return {
    // Layer 3: Origin
    dataset_path: datasetPath,
    dataset_merkle: dataset.merkleRoot,
    image_count: dataset.imageCount,
    caption_count: dataset.captionCount,
    
    // Layer 2: Environment
    params_hash: params.paramsHash,
    params_canonical: params.canonical,
    
    // Layer 1: Architecture (null if model doesn't exist yet)
    header_hash: header?.headerHash || null,
    header_size: header?.headerSize || null,
    header_metadata: header?.metadata || null,
    tensor_count: header?.tensorCount || null,
    
    // Composite
    parent_id: parentId,
    parent_seal: parentSeal,
    
    // Model ID (same as header_hash, used for lineage linking)
    model_id: header?.headerHash || null
  };
}

/**
 * Complete provenance after training finishes.
 * Call this when the .safetensors file is ready.
 * 
 * @param {object} pendingProvenance - Provenance from computeTrainingProvenance (without model)
 * @param {string} modelPath - Path to completed .safetensors file
 * @returns {object} - Updated provenance with header_hash and parent_seal
 */
function completeTrainingProvenance(pendingProvenance, modelPath) {
  if (!fs.existsSync(modelPath)) {
    throw new Error(`Model file not found: ${modelPath}`);
  }
  
  console.log(`[TRAINING-HASHER] Completing provenance for: ${path.basename(modelPath)}`);
  
  // Layer 1: Architecture
  const header = hashSafetensorsHeader(modelPath);
  
  // Complete the seal
  const parentSeal = computeParentSeal(pendingProvenance.parent_id, header.headerHash);
  
  return {
    ...pendingProvenance,
    header_hash: header.headerHash,
    header_size: header.headerSize,
    header_metadata: header.metadata,
    tensor_count: header.tensorCount,
    parent_seal: parentSeal,
    model_id: header.headerHash
  };
}

// ============================================================================
// TOML HASH (Training Config)
// ============================================================================

/**
 * Hash a TOML file (Kohya training config).
 * This is the authoritative source of training parameters.
 * 
 * @param {string} filepath - Path to .toml file
 * @returns {object} - { tomlHash, contents }
 */
function hashTomlFile(filepath) {
  if (!fs.existsSync(filepath)) {
    throw new Error(`TOML file not found: ${filepath}`);
  }
  
  const contents = fs.readFileSync(filepath, 'utf-8');
  const tomlHash = crypto.createHash('sha256').update(contents).digest('hex');
  
  console.log(`[TRAINING-HASHER] TOML Hash: ${tomlHash.substring(0, 16)}...`);
  
  return {
    tomlHash,
    contents
  };
}

// ============================================================================
// FULL MODEL HASH (Streaming for large files)
// ============================================================================

/**
 * Stream-hash a large file without loading into memory.
 * Required for 5GB+ safetensors files.
 * 
 * @param {string} filepath - Path to file
 * @returns {Promise<string>} - SHA256 hex hash
 */
async function hashFullModel(filepath) {
  if (!fs.existsSync(filepath)) {
    throw new Error(`Model file not found: ${filepath}`);
  }
  
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filepath, { highWaterMark: 64 * 1024 });
    
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => {
      const modelHash = hash.digest('hex');
      console.log(`[TRAINING-HASHER] Model Hash: ${modelHash.substring(0, 16)}...`);
      resolve(modelHash);
    });
    stream.on('error', reject);
  });
}

/**
 * Find config files in output directory matching timestamp pattern.
 * Kohya generates: config_lora-YYYYMMDD-HHMMSS.toml
 *                  {output_name}_YYYYMMDD-HHMMSS.json
 * 
 * @param {string} outputDir - Output directory path
 * @param {string} outputName - Model output name
 * @returns {object} - { tomlPath, jsonPath } or nulls
 */
function findConfigFiles(outputDir, outputName) {
  if (!fs.existsSync(outputDir)) {
    return { tomlPath: null, jsonPath: null };
  }
  
  const files = fs.readdirSync(outputDir);
  
  // Find most recent TOML (config_lora-*.toml)
  const tomlFiles = files
    .filter(f => f.startsWith('config_lora-') && f.endsWith('.toml'))
    .sort()
    .reverse();
  
  // Find most recent JSON ({outputName}_*.json)
  const jsonFiles = files
    .filter(f => f.startsWith(outputName + '_') && f.endsWith('.json'))
    .sort()
    .reverse();
  
  const tomlPath = tomlFiles.length > 0 
    ? path.join(outputDir, tomlFiles[0]) 
    : null;
    
  const jsonPath = jsonFiles.length > 0 
    ? path.join(outputDir, jsonFiles[0]) 
    : null;
  
  if (tomlPath) {
    console.log(`[TRAINING-HASHER] Found TOML: ${tomlFiles[0]}`);
  }
  if (jsonPath) {
    console.log(`[TRAINING-HASHER] Found JSON: ${jsonFiles[0]}`);
  }
  
  return { tomlPath, jsonPath };
}

/**
 * Watch output directory for new config files.
 * Returns a promise that resolves when files appear.
 * 
 * @param {string} outputDir - Output directory path
 * @param {string} outputName - Model output name
 * @param {number} timeout - Timeout in ms (default 30s)
 * @returns {Promise<object>} - { tomlPath, jsonPath }
 */
async function watchForConfigFiles(outputDir, outputName, timeout = 30000) {
  const startTime = Date.now();
  const checkInterval = 500;
  
  while (Date.now() - startTime < timeout) {
    const { tomlPath, jsonPath } = findConfigFiles(outputDir, outputName);
    
    if (tomlPath) {
      // TOML exists, that's the critical one
      return { tomlPath, jsonPath };
    }
    
    await new Promise(resolve => setTimeout(resolve, checkInterval));
  }
  
  // Timeout - return whatever we found
  return findConfigFiles(outputDir, outputName);
}

// ============================================================================
// FILES REGISTRY INTEGRATION
// ============================================================================

/**
 * Check if a file needs hashing by looking up in the registry.
 * Uses path + mtime + size as the cache key.
 * 
 * @param {string} filePath - Path to file
 * @param {object} databaseManager - Database manager instance
 * @returns {object} - { needsHash, existingEntry, fileStats }
 */
function checkFileRegistry(filePath, databaseManager) {
  if (!fs.existsSync(filePath)) {
    return { 
      needsHash: false, 
      reason: 'File does not exist',
      existingEntry: null,
      fileStats: null
    };
  }

  const stats = fs.statSync(filePath);
  const mtime = stats.mtime.toISOString();
  const fileSize = stats.size;

  // Use database method if available
  if (databaseManager && typeof databaseManager.getFileFromRegistry === 'function') {
    const existing = databaseManager.getFileFromRegistry(filePath, mtime, fileSize);
    
    if (existing) {
      console.log(`[TRAINING-HASHER] Registry HIT: ${path.basename(filePath)} (cached hash: ${existing.hash.substring(0, 16)}...)`);
      return {
        needsHash: false,
        reason: 'File found in registry with matching mtime and size',
        existingEntry: existing,
        fileStats: { mtime, fileSize }
      };
    }
  }

  console.log(`[TRAINING-HASHER] Registry MISS: ${path.basename(filePath)} (needs hashing)`);
  return {
    needsHash: true,
    reason: 'File not in registry or has been modified',
    existingEntry: null,
    fileStats: { mtime, fileSize }
  };
}

/**
 * Register a file hash in the database registry.
 * 
 * @param {string} filePath - Path to file
 * @param {string} hash - Computed hash
 * @param {object} databaseManager - Database manager instance
 * @param {string} fileType - Optional file type identifier
 * @returns {object} - Registry entry
 */
function registerFileHash(filePath, hash, databaseManager, fileType = null) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Cannot register: file does not exist: ${filePath}`);
  }

  const stats = fs.statSync(filePath);
  
  if (databaseManager && typeof databaseManager.registerFile === 'function') {
    return databaseManager.registerFile({
      filePath,
      fileSize: stats.size,
      mtime: stats.mtime.toISOString(),
      hash,
      hashAlgorithm: 'sha256',
      fileType
    });
  }

  // Return a mock entry if no database
  return {
    file_path: filePath,
    file_size: stats.size,
    mtime: stats.mtime.toISOString(),
    hash,
    hash_algorithm: 'sha256',
    file_type: fileType
  };
}

// ============================================================================
// WORKER THREAD INTEGRATION
// ============================================================================

const { Worker } = require('worker_threads');

/**
 * Hash a large file using a worker thread.
 * Reports progress via callback.
 * 
 * @param {string} filePath - Path to file
 * @param {function} onProgress - Progress callback: ({ progress, speedMBps, etaSeconds })
 * @returns {Promise<object>} - { hash, fileSize, mtime, duration, speedMBps }
 */
function hashLargeFileWithWorker(filePath, onProgress = null) {
  return new Promise((resolve, reject) => {
    // Determine worker path - try multiple locations
    const possibleWorkerPaths = [
      path.join(__dirname, 'hash-worker.js'),
      path.join(__dirname, '..', 'main', 'hash-worker.js'),
      path.join(__dirname, 'workers', 'hash-worker.js')
    ];

    let workerPath = null;
    for (const p of possibleWorkerPaths) {
      if (fs.existsSync(p)) {
        workerPath = p;
        break;
      }
    }

    // Fallback to inline streaming if worker not found
    if (!workerPath) {
      console.warn('[TRAINING-HASHER] Worker not found, using inline streaming');
      return hashFullModel(filePath).then(hash => {
        const stats = fs.statSync(filePath);
        resolve({
          hash,
          fileSize: stats.size,
          mtime: stats.mtime.toISOString(),
          duration: 0,
          speedMBps: 0
        });
      }).catch(reject);
    }

    const worker = new Worker(workerPath);
    let result = null;

    worker.on('message', (msg) => {
      switch (msg.type) {
        case 'progress':
          if (onProgress) {
            onProgress({
              progress: msg.progress,
              bytesProcessed: msg.bytesProcessed,
              fileSize: msg.fileSize,
              speedMBps: msg.speedMBps,
              etaSeconds: msg.etaSeconds,
              fileName: msg.fileName
            });
          }
          break;

        case 'complete':
          result = msg;
          worker.terminate();
          break;

        case 'error':
          worker.terminate();
          reject(new Error(msg.error));
          break;

        case 'ready':
          // Worker initialized, send hash request
          worker.postMessage({ action: 'hash', filePath });
          break;
      }
    });

    worker.on('error', (err) => {
      reject(err);
    });

    worker.on('exit', (code) => {
      if (result) {
        resolve(result);
      } else if (code !== 0) {
        reject(new Error(`Worker exited with code ${code}`));
      }
    });
  });
}

/**
 * Cancel an ongoing hash operation.
 * @param {Worker} worker - Worker thread instance
 */
function cancelHashWorker(worker) {
  if (worker) {
    worker.postMessage({ type: 'cancel' });
  }
}

// ============================================================================
// PRE-FLIGHT VERIFICATION
// ============================================================================

/**
 * Perform pre-flight check on base model.
 * Checks registry first, hashes if needed.
 * 
 * @param {string} modelPath - Path to base model
 * @param {object} databaseManager - Database manager instance
 * @param {function} onProgress - Progress callback for hashing
 * @returns {Promise<object>} - { hash, cached, duration, fileSize }
 */
async function preflightBaseModel(modelPath, databaseManager = null, onProgress = null) {
  console.log(`[TRAINING-HASHER] Pre-flight check: ${path.basename(modelPath)}`);
  
  // Check registry first
  const registryCheck = checkFileRegistry(modelPath, databaseManager);
  
  if (!registryCheck.needsHash && registryCheck.existingEntry) {
    return {
      hash: registryCheck.existingEntry.hash,
      cached: true,
      duration: 0,
      fileSize: registryCheck.fileStats.fileSize,
      mtime: registryCheck.fileStats.mtime
    };
  }

  if (!registryCheck.fileStats) {
    throw new Error(`Base model not found: ${modelPath}`);
  }

  // Need to hash - use worker for large files (>100MB)
  const fileSizeMB = registryCheck.fileStats.fileSize / (1024 * 1024);
  console.log(`[TRAINING-HASHER] Hashing base model (${fileSizeMB.toFixed(1)} MB)...`);

  let result;
  if (fileSizeMB > 100) {
    // Use worker thread for large files
    result = await hashLargeFileWithWorker(modelPath, onProgress);
  } else {
    // Use inline streaming for smaller files
    const startTime = Date.now();
    const hash = await hashFullModel(modelPath);
    result = {
      hash,
      fileSize: registryCheck.fileStats.fileSize,
      mtime: registryCheck.fileStats.mtime,
      duration: Date.now() - startTime
    };
  }

  // Register in database
  if (databaseManager) {
    registerFileHash(modelPath, result.hash, databaseManager, 'base_model');
  }

  return {
    hash: result.hash,
    cached: false,
    duration: result.duration,
    fileSize: result.fileSize,
    mtime: result.mtime,
    speedMBps: result.speedMBps
  };
}

/**
 * Quick verification that a file hasn't changed since last hash.
 * Compares mtime and size without re-hashing.
 * 
 * @param {string} filePath - Path to file
 * @param {object} databaseManager - Database manager instance
 * @returns {object} - { verified, reason, currentStats, registeredStats }
 */
function quickVerifyFile(filePath, databaseManager) {
  if (!fs.existsSync(filePath)) {
    return { 
      verified: false, 
      reason: 'File does not exist',
      currentStats: null,
      registeredStats: null
    };
  }

  const stats = fs.statSync(filePath);
  const currentMtime = stats.mtime.toISOString();
  const currentSize = stats.size;

  // Look up in registry by path
  if (databaseManager && typeof databaseManager.getFileByPath === 'function') {
    const registered = databaseManager.getFileByPath(filePath);
    
    if (!registered) {
      return {
        verified: false,
        reason: 'File not in registry',
        currentStats: { mtime: currentMtime, size: currentSize },
        registeredStats: null
      };
    }

    const mtimeMatch = registered.mtime === currentMtime;
    const sizeMatch = registered.file_size === currentSize;

    if (mtimeMatch && sizeMatch) {
      return {
        verified: true,
        reason: 'File unchanged (mtime and size match)',
        currentStats: { mtime: currentMtime, size: currentSize },
        registeredStats: { mtime: registered.mtime, size: registered.file_size },
        hash: registered.hash
      };
    }

    return {
      verified: false,
      reason: mtimeMatch ? 'File size changed' : 'File modified since registration',
      currentStats: { mtime: currentMtime, size: currentSize },
      registeredStats: { mtime: registered.mtime, size: registered.file_size }
    };
  }

  return {
    verified: false,
    reason: 'No database manager available',
    currentStats: { mtime: currentMtime, size: currentSize },
    registeredStats: null
  };
}

/**
 * Perform complete pre-flight check for training.
 * Verifies and/or hashes all input files.
 * 
 * @param {object} inputs - { baseModelPath, datasetPath, checkpointPath }
 * @param {object} databaseManager - Database manager instance
 * @param {function} onProgress - Progress callback
 * @returns {Promise<object>} - Pre-flight results
 */
async function preflightTrainingInputs(inputs, databaseManager = null, onProgress = null) {
  const results = {
    verified: true,
    baseModel: null,
    dataset: null,
    checkpoint: null,
    errors: []
  };

  // 1. Base Model
  if (inputs.baseModelPath) {
    try {
      results.baseModel = await preflightBaseModel(
        inputs.baseModelPath, 
        databaseManager,
        (progress) => onProgress && onProgress({ type: 'baseModel', ...progress })
      );
    } catch (err) {
      results.verified = false;
      results.errors.push({ type: 'baseModel', error: err.message });
    }
  }

  // 2. Dataset
  if (inputs.datasetPath) {
    try {
      const datasetResult = computeDatasetMerkle(inputs.datasetPath);
      results.dataset = {
        merkleRoot: datasetResult.merkleRoot,
        imageCount: datasetResult.imageCount,
        captionCount: datasetResult.captionCount
      };
      if (onProgress) {
        onProgress({ type: 'dataset', complete: true, ...results.dataset });
      }
    } catch (err) {
      results.verified = false;
      results.errors.push({ type: 'dataset', error: err.message });
    }
  }

  // 3. Checkpoint (if continuing from previous training)
  if (inputs.checkpointPath) {
    try {
      results.checkpoint = await preflightBaseModel(
        inputs.checkpointPath,
        databaseManager,
        (progress) => onProgress && onProgress({ type: 'checkpoint', ...progress })
      );
    } catch (err) {
      results.verified = false;
      results.errors.push({ type: 'checkpoint', error: err.message });
    }
  }

  return results;
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Layer 1: Architecture
  hashSafetensorsHeader,
  extractLoraInfo,
  
  // Layer 2: Environment
  hashTrainingParams,
  
  // Layer 3: Origin
  hashFile,
  hashPair,
  computeMerkleRoot,
  computeDatasetMerkle,
  
  // TOML Hash
  hashTomlFile,
  
  // Full Model Hash (streaming)
  hashFullModel,
  
  // Config file discovery
  findConfigFiles,
  watchForConfigFiles,
  
  // Composite
  computeParentId,
  computeParentSeal,
  
  // Full computation
  computeTrainingProvenance,
  completeTrainingProvenance,
  
  // Files Registry Integration (NEW)
  checkFileRegistry,
  registerFileHash,
  
  // Worker Thread Hashing (NEW)
  hashLargeFileWithWorker,
  cancelHashWorker,
  
  // Pre-flight Verification (NEW)
  preflightBaseModel,
  quickVerifyFile,
  preflightTrainingInputs
};
