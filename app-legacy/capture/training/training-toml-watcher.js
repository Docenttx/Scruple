/**
 * training/toml-watcher.js - Kohya TOML Config Detection
 *
 * Watches output directories for Kohya config_lora-*.toml files.
 * Captures training configuration at execution time.
 *
 * SCRUPLE Studio — Patent Pending
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const chokidar = require('chokidar');
const TOML = require('@iarna/toml');
const ctx = require('../../context');
const { hashSafetensorsHeader } = require('./training-hasher');
const {
  computeDatasetMerkle,
  hashTrainingParams,
  preflightBaseModel,
  quickVerifyFile
} = require('./training-hasher');
const { witnessIteration } = require('../../server/witness-index');

// Module-level state (was globals in main.js)
let tomlWatcher = null;
const watchedOutputDirs = new Set();
let lastDetectedToml = null;

function startTomlWatcher(outputDir) {
  if (!outputDir || !fs.existsSync(outputDir)) {
    _log('Cannot watch TOML - invalid output dir: ' + outputDir, 'warn');
    return false;
  }

  // Already watching?
  if (watchedOutputDirs.has(outputDir)) {
    _log('Already watching for TOML: ' + outputDir);
    return true;
  }

  _log('Starting TOML watcher for: ' + outputDir);
  watchedOutputDirs.add(outputDir);

  // Create or update watcher
  const watchPaths = Array.from(watchedOutputDirs);

  if (tomlWatcher) {
    // Add new path to existing watcher
    tomlWatcher.add(outputDir);
  } else {
    // Create new watcher
    console.log('[TOML WATCHER] Creating watcher for paths:', watchPaths);
    tomlWatcher = chokidar.watch(watchPaths, {
      persistent: true,
      ignoreInitial: true,
      usePolling: true,  // More reliable on Windows
      interval: 500,
      awaitWriteFinish: {
        stabilityThreshold: 500,  // Wait 500ms after last change
        pollInterval: 100
      }
    });

    tomlWatcher.on('add', (filePath) => {
      console.log('[TOML WATCHER] File added:', filePath);
      if (filePath.endsWith('.toml')) {
        handleTomlDetected(filePath);
      }
    });

    tomlWatcher.on('change', (filePath) => {
      console.log('[TOML WATCHER] File changed:', filePath);
      if (filePath.endsWith('.toml')) {
        handleTomlDetected(filePath);
      }
    });

    tomlWatcher.on('ready', () => {
      console.log('[TOML WATCHER] Ready - watching:', tomlWatcher.getWatched());
    });

    tomlWatcher.on('error', (error) => {
      console.log('[TOML WATCHER] Error:', error.message);
      _log('[TOML WATCHER] Error: ' + error.message, 'error');
    });

    _log('TOML watcher initialized');
  }

  return true;
}

/**
 * Stop the TOML watcher.
 */
function stopTomlWatcher() {
  if (tomlWatcher) {
    tomlWatcher.close();
    tomlWatcher = null;
    watchedOutputDirs.clear();
    _log('TOML watcher stopped');
  }
}

/**
 * Unwatch a specific directory from the TOML watcher.
 * Used when deactivating/switching training projects.
 */
function unwatchDir(dir) {
  if (tomlWatcher && watchedOutputDirs.has(dir)) {
    tomlWatcher.unwatch(dir);
    watchedOutputDirs.delete(dir);
    _log('TOML watcher removed for: ' + dir);
  }
}

/**
 * Handle detected TOML config file.
 * Called when Kohya writes config_lora-*.toml at training start.
 */
async function handleTomlDetected(tomlPath) {
  // Only handle config_lora-*.toml files
  const filename = path.basename(tomlPath);
  if (!filename.startsWith('config_lora-') && !filename.startsWith('config_')) {
    return;
  }

  _log('=== TOML CONFIG DETECTED ===');
  _log('Path: ' + tomlPath);

  try {
    // Read and parse TOML
    const contents = fs.readFileSync(tomlPath, 'utf-8');
    const config = TOML.parse(contents);

    // Hash the raw contents for provenance
    const tomlHash = crypto.createHash('sha256').update(contents).digest('hex');
    _log('TOML Hash: ' + tomlHash.substring(0, 16) + '...');

    // Extract key parameters from Kohya TOML structure
    const extractedConfig = extractKohyaConfig(config);
    _log('Base Model: ' + (extractedConfig.baseModelPath || '(none)'));
    _log('Dataset: ' + (extractedConfig.datasetPath || '(none)'));
    _log('Output: ' + extractedConfig.outputDir + '/' + extractedConfig.outputName);

    // =========================================================================
    // FIND AND CAPTURE COMPANION JSON FILE
    // JSON filename pattern: {output_name}_{timestamp}.json
    // TOML filename pattern: config_lora-{timestamp}.toml
    // =========================================================================
    let jsonPath = null;
    let jsonHash = null;
    let jsonContents = null;
    let jsonConfig = null;
    let resumePath = null;

    // Extract timestamp from TOML filename (e.g., "20260119-212504" from "config_lora-20260119-212504.toml")
    const tomlFilename = path.basename(tomlPath);
    const timestampMatch = tomlFilename.match(/config_lora-(\d{8}-\d{6})\.toml/);

    if (timestampMatch && extractedConfig.outputName) {
      const timestamp = timestampMatch[1];
      const expectedJsonFilename = extractedConfig.outputName + '_' + timestamp + '.json';
      const expectedJsonPath = path.join(extractedConfig.outputDir, expectedJsonFilename);

      _log('Looking for companion JSON: ' + expectedJsonFilename);

      if (fs.existsSync(expectedJsonPath)) {
        try {
          jsonContents = fs.readFileSync(expectedJsonPath, 'utf-8');
          jsonConfig = JSON.parse(jsonContents);
          jsonHash = crypto.createHash('sha256').update(jsonContents).digest('hex');
          jsonPath = expectedJsonPath;

          // Extract resume path from JSON (this is where lineage is captured)
          resumePath = jsonConfig.resume || null;

          _log('JSON captured: ' + expectedJsonFilename);
          _log('JSON Hash: ' + jsonHash.substring(0, 16) + '...');
          if (resumePath) {
            _log('Resume from: ' + resumePath);
          }
        } catch (jsonErr) {
          _log('Could not parse companion JSON: ' + jsonErr.message, 'warn');
        }
      } else {
        _log('Companion JSON not found (may not exist yet): ' + expectedJsonFilename);
      }
    }

    // =========================================================================
    // RESUME LINEAGE LOOKUP (Hash-first)
    // =========================================================================
    let parentCheckpointId = null;
    let lineageType = 'ROOT';

    const databaseManager = ctx.get('databaseManager');

    if (resumePath && fs.existsSync(resumePath)) {
      _log('=== RESUME LINEAGE LOOKUP ===');

      // Hash the resume file header
      try {
        const resumeHeaderResult = hashSafetensorsHeader(resumePath);
        const resumeHash = resumeHeaderResult.headerHash;
        _log('Resume file header hash: ' + resumeHash.substring(0, 16) + '...');

        // Hash-first lookup in checkpoints table
        const parentCheckpoint = databaseManager.getCheckpointByHash(resumeHash);

        if (parentCheckpoint) {
          parentCheckpointId = parentCheckpoint.id;
          lineageType = 'BRANCH';
          _log('Found parent checkpoint: ID ' + parentCheckpoint.id + ' (Run #' + parentCheckpoint.run_id + ', epoch ' + parentCheckpoint.epoch + ')');
        } else {
          // Fallback: try path lookup
          const pathCheckpoint = databaseManager.getCheckpointByPath(resumePath);
          if (pathCheckpoint) {
            parentCheckpointId = pathCheckpoint.id;
            lineageType = 'BRANCH';
            _log('Found parent checkpoint by path: ID ' + pathCheckpoint.id);
          } else {
            _log('Resume checkpoint not found in database - orphan lineage', 'warn');
          }
        }
      } catch (resumeErr) {
        _log('Could not hash resume file: ' + resumeErr.message, 'warn');
      }
    }

    // Store for reference
    lastDetectedToml = {
      path: tomlPath,
      hash: tomlHash,
      contents: contents,
      config: extractedConfig,
      detectedAt: new Date().toISOString()
    };

    // Get active project
    const project = databaseManager.getActiveProject();
    if (!project) {
      _log('No active project - TOML captured but not processed', 'warn');
      _send('toml-detected', {
        path: tomlPath,
        hash: tomlHash,
        config: extractedConfig,
        noProject: true
      });
      return;
    }

    _log('Project: ' + project.name);

    // =========================================================================
    // QUICK PREFLIGHT: Check if base model is in registry
    // =========================================================================
    let baseModelHash = null;
    if (extractedConfig.baseModelPath && fs.existsSync(extractedConfig.baseModelPath)) {
      const verifyResult = quickVerifyFile(extractedConfig.baseModelPath, databaseManager);
      if (verifyResult.verified && verifyResult.hash) {
        baseModelHash = verifyResult.hash;
        _log('Base Model verified from registry: ' + baseModelHash.substring(0, 16) + '...');
      } else {
        _log('Base Model not in registry - starting background hash');
        // Start background hashing
        preflightBaseModel(extractedConfig.baseModelPath, databaseManager, (progress) => {
          _send('preflight-progress', { baseModel: progress });
        }).then(result => {
          _log('Background base model hash complete: ' + result.hash.substring(0, 16) + '...');
          // Update the pending training run if it exists
          if (lastDetectedToml?.trainingRunId) {
            databaseManager.updateTrainingRun(lastDetectedToml.trainingRunId, {
              base_model_hash: result.hash
            });
          }
        }).catch(err => {
          _log('Background base model hash failed: ' + err.message, 'warn');
        });
      }
    }

    // =========================================================================
    // COMPUTE DATASET MERKLE
    // =========================================================================
    let datasetMerkle = null;
    let imageCount = 0;
    let captionCount = 0;

    if (extractedConfig.datasetPath && fs.existsSync(extractedConfig.datasetPath)) {
      _log('Computing dataset Merkle root...');
      const datasetResult = computeDatasetMerkle(extractedConfig.datasetPath);
      datasetMerkle = datasetResult.merkleRoot;
      imageCount = datasetResult.imageCount;
      captionCount = datasetResult.captionCount;
      _log('Dataset Merkle: ' + (datasetMerkle?.substring(0, 16) || 'null') + '... (' + imageCount + ' images)');
    }

    // =========================================================================
    // COMPUTE PARAMS HASH from TOML config
    // =========================================================================
    const paramsResult = hashTrainingParams(extractedConfig);
    _log('Params Hash: ' + paramsResult.paramsHash.substring(0, 16) + '...');

    // Compute Parent ID
    let parentId = null;
    if (datasetMerkle && paramsResult.paramsHash) {
      parentId = crypto.createHash('sha256')
        .update(datasetMerkle + paramsResult.paramsHash)
        .digest('hex');
      _log('Parent ID: ' + parentId.substring(0, 16) + '...');
    }

    // =========================================================================
    // INPUT WITNESS
    // =========================================================================
    let inputWitnessRecord = null;
    try {
      inputWitnessRecord = await witnessIteration({
        projectId: project.id,
        projectName: project.name,
        runSequence: 0,
        contentHash: tomlHash,
        visualHash: parentId || tomlHash,
        timestamp: new Date().toISOString(),
        type: 'training_start'
      });
      if (inputWitnessRecord) {
        _log('[WITNESS] Training start witnessed');
      }
    } catch (e) {
      _log('[WITNESS] Training start witness failed: ' + e.message, 'warn');
    }

    // =========================================================================
    // CREATE TRAINING RUN
    // =========================================================================
    const trainingData = {
      status: 'running',
      started_at: new Date().toISOString(),

      // Dataset provenance
      dataset_path: extractedConfig.datasetPath,
      dataset_merkle: datasetMerkle,
      image_count: imageCount,
      caption_count: captionCount,

      // Base model
      base_model_path: extractedConfig.baseModelPath,
      base_model_hash: baseModelHash,

      // Lineage tracking (from resume detection)
      parent_checkpoint_id: parentCheckpointId,
      lineage_type: lineageType,
      parent_checkpoint_path: resumePath,

      // Training params (from TOML)
      network_dim: extractedConfig.networkDim,
      network_alpha: extractedConfig.networkAlpha,
      learning_rate: extractedConfig.learningRate,
      lr_scheduler: extractedConfig.lrScheduler,
      lr_warmup_steps: extractedConfig.lrWarmupSteps,
      optimizer_type: extractedConfig.optimizerType,
      max_train_epochs: extractedConfig.maxTrainEpochs,
      train_batch_size: extractedConfig.trainBatchSize,
      resolution: extractedConfig.resolution,
      mixed_precision: extractedConfig.mixedPrecision,
      save_precision: extractedConfig.savePrecision,

      // Hashes
      params_hash: paramsResult.paramsHash,
      config_json: JSON.stringify(paramsResult.canonical),
      parent_id: parentId,

      // TOML capture
      toml_path: tomlPath,
      toml_hash: tomlHash,
      toml_contents: contents,

      // JSON capture (companion file)
      json_path: jsonPath,
      json_hash: jsonHash,
      json_contents: jsonContents,

      // Output
      output_dir: extractedConfig.outputDir,
      output_filename: extractedConfig.outputName,

      // Metadata
      source: 'kohya_toml',

      // Witness
      input_witness_id: inputWitnessRecord?.witness_id || null,
      input_witness_timestamp: inputWitnessRecord?.server_timestamp || null
    };

    const trainingRun = databaseManager.addTrainingRun(project.id, trainingData);
    _log('Created training run #' + trainingRun.id + ' (run_sequence: ' + trainingRun.run_sequence + ', lineage: ' + lineageType + ')');

    // Store reference
    lastDetectedToml.trainingRunId = trainingRun.id;

    // Start watching for .safetensors output
    if (extractedConfig.outputDir && extractedConfig.outputName) {
      // Lazy require to avoid circular dependency
      const { startTrainingOutputWatcher } = require('./training-output-watcher');
      startTrainingOutputWatcher(extractedConfig.outputDir, extractedConfig.outputName, trainingRun.id);
    }

    // Notify renderer
    _send('training-added', {
      trainingRunId: trainingRun.id,
      projectId: project.id,
      projectName: project.name,
      tomlPath,
      tomlHash,
      datasetMerkle,
      parentId,
      outputName: extractedConfig.outputName,
      witnessed: inputWitnessRecord !== null,
      lineageType: lineageType,
      parentCheckpointId: parentCheckpointId,
      hasJsonCapture: jsonPath !== null
    });

    _log('=== TRAINING RUN CREATED FROM TOML ===');

  } catch (error) {
    _log('TOML processing error: ' + error.message, 'error');
    _send('training-error', { error: 'TOML processing failed: ' + error.message });
  }
}

/**
 * Extract training parameters from Kohya TOML config structure.
 * Kohya uses nested objects like { pretrained_model_name_or_path: "path" }
 */
function extractKohyaConfig(config) {
  // Helper to get value (handles both direct values and nested objects)
  const getValue = (key, defaultVal = null) => {
    const val = config[key];
    if (val === undefined || val === null) return defaultVal;
    if (typeof val === 'object' && 'value' in val) return val.value;
    return val;
  };

  // Helper for numeric values
  const getNumber = (key, defaultVal = null) => {
    const val = getValue(key);
    if (val === null || val === undefined) return defaultVal;
    const num = parseFloat(val);
    return isNaN(num) ? defaultVal : num;
  };

  const getInt = (key, defaultVal = null) => {
    const val = getValue(key);
    if (val === null || val === undefined) return defaultVal;
    const num = parseInt(val, 10);
    return isNaN(num) ? defaultVal : num;
  };

  return {
    // Paths
    baseModelPath: getValue('pretrained_model_name_or_path'),
    datasetPath: getValue('train_data_dir'),
    outputDir: getValue('output_dir'),
    outputName: getValue('output_name'),

    // Network architecture
    networkDim: getInt('network_dim'),
    networkAlpha: getNumber('network_alpha'),
    networkModule: getValue('network_module', 'networks.lora'),

    // Training params
    learningRate: getNumber('learning_rate') || getNumber('unet_lr'),
    lrScheduler: getValue('lr_scheduler'),
    lrWarmupSteps: getInt('lr_warmup_steps') || getInt('lr_warmup'),
    optimizerType: getValue('optimizer_type'),
    maxTrainEpochs: getInt('max_train_epochs'),
    maxTrainSteps: getInt('max_train_steps'),
    trainBatchSize: getInt('train_batch_size', 1),

    // Resolution
    resolution: getValue('resolution') ||
      (getInt('max_resolution') ? `${getInt('max_resolution')}` : null),

    // Precision
    mixedPrecision: getValue('mixed_precision'),
    savePrecision: getValue('save_precision'),

    // Additional useful params
    seed: getInt('seed'),
    clipSkip: getInt('clip_skip'),
    noiseOffset: getNumber('noise_offset'),
    gradientAccumulationSteps: getInt('gradient_accumulation_steps', 1),

    // Resume/checkpoint
    resumePath: getValue('resume'),

    // Text encoder
    trainTextEncoder: getValue('train_text_encoder'),
    textEncoderLr: getNumber('text_encoder_lr'),

    // LoRA specific
    loraType: getValue('LoRA_type') || getValue('lora_type'),

    // Raw config for reference
    _raw: config
  };
}

/**
 * Get the last detected TOML config (for UI/debugging).
 */
function getLastDetectedToml() {
  return lastDetectedToml;
}

function _log(message, level) {
  level = level || 'info';
  const timestamp = new Date().toISOString();
  console.log('[' + timestamp + '] [' + level.toUpperCase() + '] ' + message);
  const mw = ctx.get('mainWindow');
  if (mw && mw.webContents) {
    mw.webContents.send('log', { timestamp, level, message });
  }
}

function _send(channel, data) {
  const mw = ctx.get('mainWindow');
  if (mw && mw.webContents) {
    mw.webContents.send(channel, data);
  }
}

module.exports = {
  startTomlWatcher,
  stopTomlWatcher,
  unwatchDir,
  handleTomlDetected,
  extractKohyaConfig,
  getLastDetectedToml,
  // Expose state accessors for IPC handlers
  getWatchedDirs: () => Array.from(watchedOutputDirs)
};
