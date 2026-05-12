/**
 * lock-local-lock.js - Local Disc Lock Operations
 *
 * Handles local (pre-chain) locking for both txt2img and training projects.
 *
 * SCRUPLE Studio — Patent Pending
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ctx = require('../context');
const { buildScruplePackage } = require('./lock-package-builder');
const { hashSafetensorsHeader } = require('../capture/training/training-hasher');
const { lockProject: witnessLockProject, getClient: getWitnessClient } = require('../server/witness-index');

async function performLocalDiscLock(projectId) {
  _log('Performing Local Disc Lock for project: ' + projectId);
  
  const project = ctx.get('databaseManager').getProjectWithIterations(projectId);
  if (!project) {
    throw new Error('Project not found');
  }

  if (project.status !== 'unlocked') {
    throw new Error('Project is already locked');
  }

  if (project.type === 'training') {
    return await performTrainingProjectLock(project);
  }

  let witnessLockData = null;
  let merkleRoot = null;
  let witnessedCount = 0;
  
  witnessLockData = await witnessLockProject(String(projectId));
  
  if (witnessLockData && witnessLockData.merkle_root) {
    merkleRoot = witnessLockData.merkle_root;
    witnessedCount = witnessLockData.witnessed_count || 0;
    _log(`[WITNESS] Using server's merkle root (${witnessedCount} witnessed)`);
  } else {
    merkleRoot = ctx.get('merkleManager').getRoot(projectId);
    _log('[WITNESS] Server offline - using local merkle root (unwitnessed)', 'warn');
  }

  if (!merkleRoot) {
    throw new Error('No iterations to lock');
  }

  const scrId = 'SCR_' + merkleRoot.substring(0, 6).toUpperCase();
  const preScrId = project.pre_scr_id || null;
  const installationId = ctx.get('configManager').getInstallationId();
  const packageResult = await buildScruplePackage(project, merkleRoot, scrId, preScrId, installationId);

  ctx.get('databaseManager').updateProject(projectId, {
    status: 'local_locked',
    merkle_root: merkleRoot,
    scr_id: scrId,
    package_hash: packageResult.provenanceHash,
    locked_at: new Date().toISOString(),
    witnessed_count: witnessedCount,
    witness_signature: witnessLockData?.server_signature || null
  });

  _log('Local Disc Lock complete: ' + scrId);

  // Checkpoint on Oracle — seals the current Merkle root server-side
  try {
    const witnessClient = getWitnessClient();
    if (witnessClient) {
      const checkpointResult = await witnessClient.checkpointProject(
        String(projectId),
        preScrId,
        installationId
      );
      if (checkpointResult && checkpointResult.success) {
        _log('[WITNESS] Oracle checkpoint sealed: ' + (checkpointResult.checkpoint_root || '').substring(0, 16) + '...');
      } else {
        _log('[WITNESS] Oracle checkpoint returned no result (offline?)', 'warn');
      }
    }
  } catch (e) {
    _log('[WITNESS] Checkpoint failed (non-fatal): ' + e.message, 'warn');
  }

  return {
    success: true,
    scrId,
    merkleRoot,
    packageHash: packageResult.provenanceHash,
    packagePath: packageResult.vaultPath,
    witnessed: witnessLockData !== null,
    witnessedCount
  };
}

async function performTrainingProjectLock(project) {
  _log('=== TRAINING PROJECT LOCAL LOCK ===');
  _log('Project: ' + project.name);
  
  const vaultPath = project.vault_path;
  if (!vaultPath || !fs.existsSync(vaultPath)) {
    throw new Error('Training project vault folder not found: ' + vaultPath);
  }
  
  _log('Vault path: ' + vaultPath);
  
  const files = fs.readdirSync(vaultPath);
  const fileHashes = [];
  const manifest = {
    version: '3.0',
    type: 'training',
    project_name: project.name,
    created_at: project.created_at,
    locked_at: new Date().toISOString(),
    files: []
  };
  
  for (const filename of files) {
    const filePath = path.join(vaultPath, filename);
    const stats = fs.statSync(filePath);
    
    if (stats.isDirectory() || filename === 'provenance.json') {
      continue;
    }
    
    let fileHash = null;
    let hashMethod = null;
    
    if (filename.endsWith('.toml')) {
      const contents = fs.readFileSync(filePath);
      fileHash = crypto.createHash('sha256').update(contents).digest('hex');
      hashMethod = 'sha256_full';
      _log('Hashed TOML: ' + filename + ' → ' + fileHash.substring(0, 16) + '...');
    } else if (filename.endsWith('.json')) {
      const contents = fs.readFileSync(filePath);
      fileHash = crypto.createHash('sha256').update(contents).digest('hex');
      hashMethod = 'sha256_full';
      _log('Hashed JSON: ' + filename + ' → ' + fileHash.substring(0, 16) + '...');
    } else if (filename.endsWith('.safetensors')) {
      const headerResult = hashSafetensorsHeader(filePath);
      fileHash = headerResult.headerHash;
      hashMethod = 'safetensors_header';
      _log('Hashed safetensors: ' + filename + ' → ' + fileHash.substring(0, 16) + '...');
    }
    
    if (fileHash) {
      fileHashes.push(fileHash);
      manifest.files.push({
        filename,
        size: stats.size,
        mtime: stats.mtime.toISOString(),
        hash: fileHash,
        hash_method: hashMethod
      });
    }
  }
  
  if (fileHashes.length === 0) {
    throw new Error('No hashable files found in vault folder');
  }
  
  _log('Hashed ' + fileHashes.length + ' files');
  
  const merkleRoot = buildMerkleRoot(fileHashes);
  _log('Merkle Root: ' + merkleRoot);
  
  const scrId = 'SCR_' + merkleRoot.substring(0, 6).toUpperCase();
  _log('SCR ID: ' + scrId);
  
  manifest.merkle_root = merkleRoot;
  manifest.scr_id = scrId;
  manifest.file_count = fileHashes.length;
  
  const provenancePath = path.join(vaultPath, 'provenance.json');
  fs.writeFileSync(provenancePath, JSON.stringify(manifest, null, 2));
  _log('Wrote provenance.json');
  
  const provenanceContents = fs.readFileSync(provenancePath);
  const provenanceHash = crypto.createHash('sha256').update(provenanceContents).digest('hex');
  
  ctx.get('databaseManager').updateProject(project.id, {
    status: 'local_locked',
    merkle_root: merkleRoot,
    scr_id: scrId,
    package_hash: provenanceHash,
    locked_at: new Date().toISOString()
  });
  
  const trainingRuns = ctx.get('databaseManager').getTrainingRuns(project.id);
  for (const run of trainingRuns) {
    if (!run.is_locked) {
      ctx.get('databaseManager').lockTrainingRun(run.id, { scr_id: scrId });
      _log('Locked training run #' + run.id);
    }
  }
  
  _log('=== TRAINING PROJECT LOCAL LOCK COMPLETE ===');
  
  return {
    success: true,
    scrId,
    merkleRoot,
    packageHash: provenanceHash,
    packagePath: vaultPath,
    fileCount: fileHashes.length,
    witnessed: false,
    witnessedCount: 0
  };
}

function buildMerkleRoot(hashes) {
  if (hashes.length === 0) {
    throw new Error('Cannot build merkle root from empty array');
  }
  if (hashes.length === 1) {
    return hashes[0];
  }
  const sorted = [...hashes].sort();
  let level = sorted;
  while (level.length > 1) {
    const nextLevel = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 < level.length) {
        const combined = level[i] + level[i + 1];
        const hash = crypto.createHash('sha256').update(combined, 'hex').digest('hex');
        nextLevel.push(hash);
      } else {
        nextLevel.push(level[i]);
      }
    }
    level = nextLevel;
  }
  return level[0];
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

module.exports = { performLocalDiscLock, performTrainingProjectLock, buildMerkleRoot };
