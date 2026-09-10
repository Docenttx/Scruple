/**
 * training/output-watcher.js - Training Output File Detection
 *
 * Watches training output directories for checkpoint and final model files.
 *
 * SCRUPLE Studio — Patent Pending
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const chokidar = require('chokidar');
const ctx = require('../../context');
const { hashSafetensorsHeader } = require('./training-hasher');
const { witnessIteration } = require('../../server/witness-index');

function startTrainingOutputWatcher(outputDir, outputName, trainingRunId) {
  const trainingOutputWatchers = ctx.get('trainingOutputWatchers');

  // Skip if already watching this directory
  const watchKey = outputDir + '/' + outputName;
  if (trainingOutputWatchers.has(watchKey)) {
    _log('Already watching: ' + watchKey);
    return;
  }

  // Ensure directory exists
  if (!fs.existsSync(outputDir)) {
    try {
      fs.mkdirSync(outputDir, { recursive: true });
      _log('Created output directory: ' + outputDir);
    } catch (e) {
      _log('Cannot create output directory: ' + e.message, 'warn');
      return;
    }
  }

  // Get training run start time for file creation validation
  const databaseManager = ctx.get('databaseManager');
  const trainingRun = databaseManager.getTrainingRun(trainingRunId);
  const runStartTime = trainingRun?.started_at ? new Date(trainingRun.started_at) : new Date();

  const expectedFinalFile = path.join(outputDir, outputName + '.safetensors');
  _log('Starting watcher for: ' + expectedFinalFile);
  _log('Run start time: ' + runStartTime.toISOString());

  // Checkpoint pattern: outputName-XXXXXX.safetensors (6-digit epoch number)
  const checkpointPattern = new RegExp('^' + escapeRegex(outputName) + '-(\\d{6})\\.safetensors$');

  const watcher = chokidar.watch(outputDir, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 2000,  // Wait 2 seconds after last change
      pollInterval: 500
    }
  });

  watcher.on('add', async (filePath) => {
    // Only handle .safetensors files
    if (!filePath.endsWith('.safetensors')) return;

    const basename = path.basename(filePath);
    _log('[WATCHER] Detected new safetensors: ' + basename);

    // Validate file creation time - ignore stale files from previous runs
    try {
      const stats = fs.statSync(filePath);
      const fileMtime = new Date(stats.mtime);
      if (fileMtime < runStartTime) {
        _log('[WATCHER] Ignoring stale file (created before run start): ' + basename);
        return;
      }
    } catch (e) {
      _log('[WATCHER] Could not stat file: ' + e.message, 'warn');
    }

    // Check if it's the FINAL model (exact match)
    const isFinal = basename === outputName + '.safetensors';

    // Check if it's a CHECKPOINT (pattern: outputName-XXXXXX.safetensors)
    const checkpointMatch = basename.match(checkpointPattern);
    const isCheckpoint = checkpointMatch !== null;
    const epochNumber = isCheckpoint ? parseInt(checkpointMatch[1], 10) : null;

    if (isFinal) {
      _log('[WATCHER] ✔ FINAL model detected - triggering completion');

      // Stop watching
      watcher.close();
      trainingOutputWatchers.delete(watchKey);

      // Trigger completion with detected file (creates checkpoint with is_final=1)
      await handleTrainingOutputDetected(trainingRunId, filePath, true);

    } else if (isCheckpoint) {
      _log('[WATCHER] → Checkpoint detected (epoch ' + epochNumber + ')');

      // Record checkpoint but don't trigger completion
      await handleCheckpointDetected(trainingRunId, filePath, epochNumber);

    } else {
      _log('[WATCHER] ? Unknown safetensors file (not matching expected pattern): ' + basename);
    }
  });

  watcher.on('error', (error) => {
    _log('[WATCHER] Error: ' + error.message, 'error');
  });

  trainingOutputWatchers.set(watchKey, watcher);
}

/**
 * Escape special regex characters in a string.
 */
function escapeRegex(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Handle detected checkpoint file (intermediate epoch save).
 * Records checkpoint in database without triggering run completion.
 */
async function handleCheckpointDetected(trainingRunId, filePath, epochNumber) {
  _log('=== CHECKPOINT DETECTED ===');
  _log('Training Run ID: ' + trainingRunId);
  _log('File: ' + path.basename(filePath));
  _log('Epoch: ' + epochNumber);

  try {
    const databaseManager = ctx.get('databaseManager');
    const trainingRun = databaseManager.getTrainingRun(trainingRunId);
    if (!trainingRun) {
      _log('Training run not found: ' + trainingRunId, 'error');
      return;
    }

    // Get file stats
    const stats = fs.statSync(filePath);

    // Compute header hash (fast)
    let headerHash = null;
    try {
      const headerResult = hashSafetensorsHeader(filePath);
      headerHash = headerResult.headerHash;
      _log('Checkpoint header hash: ' + headerHash.substring(0, 16) + '...');
    } catch (e) {
      _log('Could not hash checkpoint header: ' + e.message, 'warn');
    }

    // Insert checkpoint record
    const checkpoint = databaseManager.addCheckpoint(trainingRunId, {
      epoch: epochNumber,
      step: null,
      filename: path.basename(filePath),
      filePath: filePath,
      fileSize: stats.size,
      fileMtime: stats.mtime.toISOString(),
      headerHash: headerHash,
      isFinal: false
    });

    _log('Checkpoint recorded: ID ' + checkpoint.id);

    // Notify renderer
    _send('checkpoint-added', {
      trainingRunId,
      projectId: trainingRun.project_id,
      checkpointId: checkpoint.id,
      epoch: epochNumber,
      filename: path.basename(filePath),
      headerHash
    });

  } catch (error) {
    _log('Checkpoint detection error: ' + error.message, 'error');
  }
}

/**
 * Handle detected training output file (FINAL model).
 * Called when file watcher detects the final .safetensors file.
 * Creates checkpoint record with is_final=1 and marks run complete.
 */
async function handleTrainingOutputDetected(trainingRunId, modelPath, isFinal = true) {
  _log('=== TRAINING OUTPUT DETECTED ===');
  _log('Training Run ID: ' + trainingRunId);
  _log('Model Path: ' + modelPath);
  _log('Is Final: ' + isFinal);

  try {
    const databaseManager = ctx.get('databaseManager');
    const trainingRun = databaseManager.getTrainingRun(trainingRunId);
    if (!trainingRun) {
      _log('Training run not found: ' + trainingRunId, 'error');
      return;
    }

    // Get file stats
    const stats = fs.statSync(modelPath);

    // Compute header hash (fast, header only)
    _log('Computing safetensors header hash...');
    const headerResult = hashSafetensorsHeader(modelPath);
    _log('Header Hash: ' + headerResult.headerHash.substring(0, 16) + '...');
    _log('Header Size: ' + headerResult.headerSize + ' bytes, Tensors: ' + headerResult.tensorCount);

    // =========================================================================
    // INSERT FINAL CHECKPOINT RECORD
    // =========================================================================
    const checkpoint = databaseManager.addCheckpoint(trainingRunId, {
      epoch: trainingRun.max_train_epochs || null,
      step: null,
      filename: path.basename(modelPath),
      filePath: modelPath,
      fileSize: stats.size,
      fileMtime: stats.mtime.toISOString(),
      headerHash: headerResult.headerHash,
      isFinal: true
    });
    _log('Final checkpoint recorded: ID ' + checkpoint.id);

    // Compute parent seal
    let parentSeal = null;
    if (trainingRun.parent_id && headerResult.headerHash) {
      parentSeal = crypto.createHash('sha256')
        .update(trainingRun.parent_id + headerResult.headerHash)
        .digest('hex');
      _log('Parent Seal: ' + parentSeal.substring(0, 16) + '...');
    }

    // Output witness
    let outputWitnessRecord = null;
    try {
      outputWitnessRecord = await witnessIteration({
        projectId: trainingRun.project_id,
        projectName: null, // Will be looked up
        runSequence: trainingRun.run_sequence,
        contentHash: headerResult.headerHash,
        visualHash: parentSeal || headerResult.headerHash,
        timestamp: new Date().toISOString(),
        type: 'training_complete'
      });

      if (outputWitnessRecord) {
        _log('[WITNESS] Training complete witnessed');
        // Update checkpoint with witness info
        databaseManager.updateCheckpoint(checkpoint.id, {
          witnessed: 1,
          witness_id: outputWitnessRecord.witness_id
        });
      }
    } catch (e) {
      _log('[WITNESS] Training complete witness failed: ' + e.message, 'warn');
    }

    // Update training run
    const completionData = {
      status: 'complete',
      completed_at: new Date().toISOString(),
      output_path: modelPath,
      output_filename: path.basename(modelPath),
      header_hash: headerResult.headerHash,
      header_size: headerResult.headerSize,
      tensor_count: headerResult.tensorCount,
      parent_seal: parentSeal,
      output_witness_id: outputWitnessRecord?.witness_id || null,
      output_witness_timestamp: outputWitnessRecord?.server_timestamp || null
    };

    const updatedRun = databaseManager.completeTrainingRun(trainingRunId, completionData);

    // Get checkpoint count for stats
    const checkpointCount = databaseManager.getCheckpointCount(trainingRunId);

    // Notify renderer
    _send('training-complete', {
      trainingRunId,
      projectId: trainingRun.project_id,
      status: 'complete',
      headerHash: headerResult.headerHash,
      parentSeal,
      modelPath,
      witnessed: outputWitnessRecord !== null,
      checkpointCount: checkpointCount.total,
      finalCheckpointId: checkpoint.id
    });

    _log('=== TRAINING COMPLETE RECORDED ===');
    _log('Total checkpoints: ' + checkpointCount.total + ' (intermediate: ' + checkpointCount.intermediate + ', final: ' + checkpointCount.final + ')');

  } catch (error) {
    _log('Training output detection error: ' + error.message, 'error');
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

module.exports = {
  startTrainingOutputWatcher,
  handleCheckpointDetected,
  handleTrainingOutputDetected,
  escapeRegex
};
