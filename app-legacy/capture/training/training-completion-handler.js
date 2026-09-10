/**
 * training/completion-handler.js - Training Completion & Lock
 *
 * Handles training completion events and training-specific lock flows.
 *
 * SCRUPLE Studio — Patent Pending
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ctx = require('../../context');
const { hashSafetensorsHeader } = require('./training-hasher');
const { witnessIteration } = require('../../server/witness-index');

/**
 * Handle training completion event from Kohya webview.
 * Called when training finishes (model exists).
 *
 * Note: This may also be triggered by the file watcher (handleTrainingOutputDetected).
 * This function handles the case where Kohya sends a completion event directly.
 */
async function handleTrainingComplete(data) {
  _log('=== TRAINING COMPLETE (via Kohya event) ===');

  try {
    const databaseManager = ctx.get('databaseManager');
    const pendingTrainingCaptures = ctx.get('pendingTrainingCaptures');
    const trainingOutputWatchers = ctx.get('trainingOutputWatchers');

    // Find pending training record
    let pending = null;
    let correlationKey = null;

    // Try capture ID
    if (data.id && pendingTrainingCaptures.has(data.id)) {
      correlationKey = data.id;
      pending = pendingTrainingCaptures.get(data.id);
    }

    // Try session hash
    if (!pending && data.metadata?.session_hash && pendingTrainingCaptures.has(data.metadata.session_hash)) {
      correlationKey = data.metadata.session_hash;
      pending = pendingTrainingCaptures.get(data.metadata.session_hash);
    }

    // Fallback: get first pending
    if (!pending && pendingTrainingCaptures.size > 0) {
      const firstKey = pendingTrainingCaptures.keys().next().value;
      correlationKey = firstKey;
      pending = pendingTrainingCaptures.get(firstKey);
    }

    if (!pending) {
      _log('No pending training record found for completion', 'warn');
      return;
    }

    // Check if already completed (by watcher)
    const existingRun = databaseManager.getTrainingRun(pending.trainingRunId);
    if (existingRun && existingRun.status === 'complete') {
      _log('Training run already completed (by watcher), skipping duplicate');
      pendingTrainingCaptures.delete(correlationKey);
      if (data.id && data.id !== correlationKey) {
        pendingTrainingCaptures.delete(data.id);
      }
      return;
    }

    _log('Completing training run #' + pending.trainingRunId);

    // Determine model output path
    let modelPath = data.outputData?.modelPath || null;

    if (!modelPath && pending.outputDir && pending.outputName) {
      // Construct expected path
      modelPath = path.join(pending.outputDir, pending.outputName + '.safetensors');
    }

    _log('Model path: ' + (modelPath || '(unknown)'));

    // Wait for model file to exist (training may still be writing)
    let headerHash = null;
    let headerSize = null;
    let tensorCount = null;
    let parentSeal = null;

    if (modelPath) {
      // Wait up to 30 seconds for file to appear
      const maxWait = 30000;
      const checkInterval = 1000;
      let waited = 0;

      while (!fs.existsSync(modelPath) && waited < maxWait) {
        await new Promise(resolve => setTimeout(resolve, checkInterval));
        waited += checkInterval;
      }

      if (fs.existsSync(modelPath)) {
        // Small delay to ensure file is fully written
        await new Promise(resolve => setTimeout(resolve, 500));

        try {
          // Compute Layer 1: Header Hash
          _log('Computing safetensors header hash...');
          const headerResult = hashSafetensorsHeader(modelPath);
          headerHash = headerResult.headerHash;
          headerSize = headerResult.headerSize;
          tensorCount = headerResult.tensorCount;

          _log('Header Hash: ' + headerHash.substring(0, 16) + '...');
          _log('Header Size: ' + headerSize + ' bytes, Tensors: ' + tensorCount);

          // Compute Parent Seal
          if (pending.parentId && headerHash) {
            parentSeal = crypto.createHash('sha256')
              .update(pending.parentId + headerHash)
              .digest('hex');
            _log('Parent Seal: ' + parentSeal.substring(0, 16) + '...');
          }
        } catch (e) {
          _log('Failed to hash model file: ' + e.message, 'error');
        }
      } else {
        _log('Model file not found after waiting: ' + modelPath, 'warn');
      }
    }

    // Output witness
    let outputWitnessRecord = null;
    if (headerHash) {
      try {
        outputWitnessRecord = await witnessIteration({
          projectId: pending.projectId,
          projectName: null,
          runSequence: existingRun?.run_sequence || 0,
          contentHash: headerHash,
          visualHash: parentSeal || headerHash,
          timestamp: new Date().toISOString(),
          type: 'training_complete'
        });

        if (outputWitnessRecord) {
          _log('[WITNESS] Training complete witnessed ✔');
        }
      } catch (e) {
        _log('[WITNESS] Training complete witness failed: ' + e.message, 'warn');
      }
    }

    // Update training run with completion data
    const completionData = {
      output_path: modelPath,
      output_filename: path.basename(modelPath || pending.outputName || 'unknown'),
      header_hash: headerHash,
      header_size: headerSize,
      tensor_count: tensorCount,
      parent_seal: parentSeal,
      output_witness_id: outputWitnessRecord?.witness_id || null,
      output_witness_timestamp: outputWitnessRecord?.server_timestamp || null
    };

    const updatedRun = databaseManager.completeTrainingRun(pending.trainingRunId, completionData);

    // Stop file watcher if running
    const watchKey = pending.outputDir + '/' + pending.outputName;
    if (trainingOutputWatchers.has(watchKey)) {
      trainingOutputWatchers.get(watchKey).close();
      trainingOutputWatchers.delete(watchKey);
    }

    // Cleanup pending
    pendingTrainingCaptures.delete(correlationKey);
    if (data.id && data.id !== correlationKey) {
      pendingTrainingCaptures.delete(data.id);
    }
    if (data.metadata?.session_hash && data.metadata.session_hash !== correlationKey) {
      pendingTrainingCaptures.delete(data.metadata.session_hash);
    }

    // Notify renderer
    _send('training-complete', {
      trainingRunId: pending.trainingRunId,
      projectId: pending.projectId,
      status: 'complete',
      headerHash,
      parentSeal,
      modelPath,
      witnessed: outputWitnessRecord !== null
    });

    _log('=== TRAINING COMPLETE RECORDED ===');

  } catch (error) {
    _log('Training complete error: ' + error.message, 'error');
    _send('training-error', { error: error.message });
  }
}

/**
 * Lock a training run with recursive ancestry locking.
 * Phase 6: When locking a run, all ancestors must also be locked.
 * Only the tip gets the RVN anchor.
 */
async function performTrainingLock(trainingId, lockType, password) {
  _log('Performing ' + lockType + ' lock for training run: ' + trainingId);

  const databaseManager = ctx.get('databaseManager');
  const trainingRun = databaseManager.getTrainingRun(trainingId);
  if (!trainingRun) {
    throw new Error('Training run not found');
  }

  if (trainingRun.status !== 'complete') {
    throw new Error('Training must be complete before locking');
  }

  if (trainingRun.is_locked) {
    throw new Error('Training run is already locked');
  }

  if (!trainingRun.parent_seal) {
    throw new Error('Training run has no parent seal');
  }

  // Derive SCR ID from parent_seal
  const scrId = 'SCR_' + trainingRun.parent_seal.substring(0, 6).toUpperCase();

  // Get full ancestry chain (bottom-up locking)
  const ancestryChain = databaseManager.getAncestryChain(trainingId);
  _log('Ancestry chain: ' + ancestryChain.length + ' runs');

  if (lockType === 'local') {
    // Local lock only - lock all ancestors too
    for (const run of ancestryChain) {
      if (!run.is_locked) {
        const runScrId = 'SCR_' + (run.parent_seal || run.header_hash || 'NONE').substring(0, 6).toUpperCase();
        databaseManager.lockTrainingRun(run.id, {
          scr_id: runScrId
        });
        _log('Locked ancestor run #' + run.id + ': ' + runScrId);
      }
    }

    _log('Training local lock complete: ' + scrId);
    return {
      success: true,
      scrId,
      lockedRuns: ancestryChain.length,
      mock: false
    };
  }

  if (lockType === 'chain') {
    // Chain lock - requires wallet password
    if (!password) {
      throw new Error('Password required for chain lock');
    }

    // Build recursive IPFS manifest with linked CIDs
    const lockedCids = [];
    let previousCid = null;

    for (const run of ancestryChain) {
      if (!run.is_locked) {
        const runScrId = 'SCR_' + (run.parent_seal || run.header_hash || 'NONE').substring(0, 6).toUpperCase();

        // Build provenance package for this run
        const provenancePackage = buildTrainingProvenancePackage(run, runScrId);
        provenancePackage.parent_ipfs_cid = previousCid;

        // TODO: Upload to IPFS and get CID
        // const cid = await uploadToIPFS(provenancePackage);
        const mockCid = 'Qm' + crypto.randomBytes(22).toString('hex');

        // Lock this run with CID
        databaseManager.lockTrainingRun(run.id, {
          scr_id: runScrId,
          ipfs_cid: mockCid,
          parent_ipfs_cid: previousCid
        });

        lockedCids.push({ runId: run.id, scrId: runScrId, cid: mockCid });
        previousCid = mockCid;

        _log('Locked and uploaded run #' + run.id + ': ' + mockCid.substring(0, 20) + '...');
      } else {
        previousCid = run.ipfs_cid;
      }
    }

    // Only tip gets RVN anchor (last in chain = the requested run)
    const tipCid = lockedCids.length > 0 ? lockedCids[lockedCids.length - 1].cid : null;

    // TODO: Mint RVN asset with tip CID
    // const txid = await mintRvnAsset(scrId, tipCid, password);
    const mockTxid = crypto.randomBytes(32).toString('hex');

    // Update tip run with txid
    databaseManager.updateTrainingRun(trainingId, {
      lock_txid: mockTxid
    });

    _log('Training chain lock complete: ' + scrId + ' (tip txid: ' + mockTxid.substring(0, 16) + '...)');
    return {
      success: true,
      scrId,
      tipCid,
      txid: mockTxid,
      lockedRuns: lockedCids.length,
      chain: lockedCids,
      mock: true
    };
  }

  throw new Error('Invalid lock type: ' + lockType);
}

/**
 * Build provenance package JSON for training run.
 */
function buildTrainingProvenancePackage(trainingRun, scrId) {
  const databaseManager = ctx.get('databaseManager');
  const project = databaseManager.getProject(trainingRun.project_id);

  return {
    version: '3.0',
    type: 'training_provenance',
    scr_id: scrId,

    seals: {
      parent_seal: trainingRun.parent_seal,
      parent_id: trainingRun.parent_id,
      dataset_merkle: trainingRun.dataset_merkle,
      params_hash: trainingRun.params_hash,
      header_hash: trainingRun.header_hash
    },

    origin: {
      dataset_path: trainingRun.dataset_path,
      image_count: trainingRun.image_count,
      caption_count: trainingRun.caption_count
    },

    environment: {
      base_model: trainingRun.base_model,
      network_dim: trainingRun.network_dim,
      network_alpha: trainingRun.network_alpha,
      learning_rate: trainingRun.learning_rate,
      lr_scheduler: trainingRun.lr_scheduler,
      optimizer: trainingRun.optimizer_type,
      max_epochs: trainingRun.max_train_epochs,
      batch_size: trainingRun.train_batch_size,
      resolution: trainingRun.resolution,
      mixed_precision: trainingRun.mixed_precision,
      source: trainingRun.source,
      kohya_version: trainingRun.kohya_version
    },

    output: {
      filename: trainingRun.output_filename,
      header_hash: trainingRun.header_hash,
      header_size: trainingRun.header_size,
      tensor_count: trainingRun.tensor_count,
      trained_at: trainingRun.completed_at
    },

    creator: {
      project_name: project?.name || null,
      locked_at: new Date().toISOString(),
      capture_id: trainingRun.capture_id
    }
  };
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
  handleTrainingComplete,
  performTrainingLock,
  buildTrainingProvenancePackage
};
