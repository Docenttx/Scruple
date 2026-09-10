/**
 * training/capture-handler.js - Training Capture Handler
 *
 * Handles the training start event from Kohya webview.
 * Phase 2 of the three-phase training provenance handshake.
 *
 * SCRUPLE Studio — Patent Pending
 */

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const ctx = require('../../context');
const { startTrainingOutputWatcher } = require('./training-output-watcher');
const {
  computeDatasetMerkle,
  hashTrainingParams,
  preflightBaseModel,
  quickVerifyFile
} = require('./training-hasher');
const { witnessIteration } = require('../../server/witness-index');

/**
 * Auto-detect Kohya_ss port (7860, 7861, 7862)
 */
async function detectKohyaPort() {
  const ports = [7860, 7861, 7862];

  for (const port of ports) {
    _log(`Checking port ${port}...`);

    try {
      const result = await new Promise((resolve) => {
        const req = http.get(`http://127.0.0.1:${port}/`, (res) => {
          res.destroy();
          resolve(true);
        });

        req.setTimeout(500, () => {
          req.destroy();
          resolve(false);
        });

        req.on('error', () => {
          resolve(false);
        });
      });

      if (result) {
        _log(`Kohya_ss detected on port ${port}`);
        return port;
      }
    } catch (e) {
      // continue
    }
  }

  _log('Kohya_ss not detected on ports 7860-7862', 'warn');
  return null;
}

/**
 * Handle training capture event from Kohya webview.
 * Called when training starts (before model exists).
 *
 * Three-phase handshake:
 * 1. [Activate Project] → Background hash of base model (via preflight)
 * 2. [Start Training]   → Quick verify → Single witness call (inputs)
 * 3. [Training Complete] → Hash output → Complete witness (output)
 */
async function handleTrainingCapture(record) {
  _log('=== TRAINING CAPTURE START (Phase 2: Start Training) ===');
  _log('Capture ID: ' + record.id);

  try {
    const databaseManager = ctx.get('databaseManager');
    const pendingTrainingCaptures = ctx.get('pendingTrainingCaptures');

    // Get active project
    const project = databaseManager.getActiveProject();
    if (!project) {
      _log('No active project for training capture', 'warn');
      _send('training-error', { error: 'No active project' });
      return;
    }

    _log('Project: ' + project.name);

    const inputData = record.inputData || {};

    // Extract paths
    const datasetPath = inputData.trainDataDir || null;
    const outputDir = inputData.outputDir || null;
    const outputName = inputData.outputName || null;
    const baseModelPath = inputData.pretrainedModel || null;

    _log('Dataset Path: ' + (datasetPath || '(none)'));
    _log('Base Model: ' + (baseModelPath || '(none)'));
    _log('Output: ' + (outputDir || '') + '/' + (outputName || '') + '.safetensors');

    // =========================================================================
    // QUICK VERIFY: Check if base model hash is already in registry
    // =========================================================================
    let baseModelHash = null;
    let baseModelVerified = false;

    if (baseModelPath) {
      const verifyResult = quickVerifyFile(baseModelPath, databaseManager);
      if (verifyResult.verified && verifyResult.hash) {
        baseModelHash = verifyResult.hash;
        baseModelVerified = true;
        _log('Base Model verified from registry: ' + baseModelHash.substring(0, 16) + '...');
      } else {
        _log('Base Model not in registry or modified - will hash on completion', 'warn');
        // Start background hashing if file exists
        if (fs.existsSync(baseModelPath)) {
          preflightBaseModel(baseModelPath, databaseManager, (progress) => {
            _send('preflight-progress', { baseModel: progress });
          }).then(result => {
            _log('Background base model hash complete: ' + result.hash.substring(0, 16) + '...');
          }).catch(err => {
            _log('Background base model hash failed: ' + err.message, 'warn');
          });
        }
      }
    }

    // =========================================================================
    // COMPUTE DATASET MERKLE (Layer 3: Origin)
    // =========================================================================
    let datasetMerkle = null;
    let imageCount = 0;
    let captionCount = 0;

    if (datasetPath && fs.existsSync(datasetPath)) {
      _log('Computing dataset Merkle root...');
      const datasetResult = computeDatasetMerkle(datasetPath);
      datasetMerkle = datasetResult.merkleRoot;
      imageCount = datasetResult.imageCount;
      captionCount = datasetResult.captionCount;
      _log('Dataset Merkle: ' + (datasetMerkle?.substring(0, 16) || 'null') + '... (' + imageCount + ' images)');
    } else {
      _log('Dataset path not found, skipping Merkle computation', 'warn');
    }

    // =========================================================================
    // COMPUTE PARAMS HASH (Layer 2: Environment)
    // =========================================================================
    const paramsResult = hashTrainingParams(inputData);
    _log('Params Hash: ' + paramsResult.paramsHash.substring(0, 16) + '...');

    // Compute Parent ID (before model exists)
    let parentId = null;
    if (datasetMerkle && paramsResult.paramsHash) {
      parentId = crypto.createHash('sha256')
        .update(datasetMerkle + paramsResult.paramsHash)
        .digest('hex');
      _log('Parent ID: ' + parentId.substring(0, 16) + '...');
    }

    // =========================================================================
    // INPUT WITNESS: Record training start with witness server
    // =========================================================================
    let inputWitnessRecord = null;
    try {
      inputWitnessRecord = await witnessIteration({
        projectId: project.id,
        projectName: project.name,
        runSequence: 0, // Training run (not iteration)
        contentHash: datasetMerkle || paramsResult.paramsHash,
        visualHash: parentId || paramsResult.paramsHash,
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
    // CREATE TRAINING RUN RECORD
    // =========================================================================
    const trainingData = {
      status: 'running',
      started_at: new Date().toISOString(),
      dataset_path: datasetPath,
      dataset_merkle: datasetMerkle,
      image_count: imageCount,
      caption_count: captionCount,
      base_model_path: baseModelPath,
      base_model_hash: baseModelHash,
      network_dim: parseInt(inputData.networkDim) || null,
      network_alpha: parseFloat(inputData.networkAlpha) || null,
      learning_rate: parseFloat(inputData.learningRate) || null,
      lr_scheduler: inputData.lrScheduler || null,
      lr_warmup_steps: parseInt(inputData.lrWarmupSteps) || null,
      optimizer_type: inputData.optimizerType || null,
      max_train_epochs: parseInt(inputData.maxTrainEpochs) || null,
      train_batch_size: parseInt(inputData.trainBatchSize) || null,
      resolution: inputData.resolution || null,
      mixed_precision: inputData.mixedPrecision || null,
      save_precision: inputData.savePrecision || null,
      params_hash: paramsResult.paramsHash,
      config_json: paramsResult.canonical,
      output_dir: outputDir,
      output_filename: outputName,
      parent_id: parentId,
      source: 'kohya_ss',
      kohya_version: record.metadata?.kohya_version || null,
      session_hash: record.metadata?.session_hash || null,
      capture_id: record.id,
      input_witness_id: inputWitnessRecord?.witness_id || null,
      input_witness_timestamp: inputWitnessRecord?.server_timestamp || null
    };

    const trainingRun = databaseManager.addTrainingRun(project.id, trainingData);
    _log('Created training run #' + trainingRun.id + ' (run_sequence: ' + trainingRun.run_sequence + ')');

    // =========================================================================
    // START FILE WATCHER for output directory
    // =========================================================================
    if (outputDir && outputName) {
      startTrainingOutputWatcher(outputDir, outputName, trainingRun.id);
    }

    // Store in pending map for completion correlation
    pendingTrainingCaptures.set(record.id, {
      trainingRunId: trainingRun.id,
      projectId: project.id,
      outputDir,
      outputName,
      parentId,
      baseModelPath,
      baseModelVerified
    });

    // Also store by session hash if available
    if (record.metadata?.session_hash) {
      pendingTrainingCaptures.set(record.metadata.session_hash, {
        trainingRunId: trainingRun.id,
        projectId: project.id,
        outputDir,
        outputName,
        parentId,
        baseModelPath,
        baseModelVerified
      });
    }

    // Notify renderer
    _send('training-added', {
      trainingRunId: trainingRun.id,
      projectId: project.id,
      projectName: project.name,
      status: 'running',
      datasetMerkle,
      parentId,
      outputName,
      witnessed: inputWitnessRecord !== null
    });

    _log('=== TRAINING CAPTURE RECORDED ===');

  } catch (error) {
    _log('Training capture error: ' + error.message, 'error');
    _send('training-error', { error: error.message });
  }
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

module.exports = { detectKohyaPort, handleTrainingCapture };
