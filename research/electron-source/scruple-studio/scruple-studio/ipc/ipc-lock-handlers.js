/**
 * ipc/lock-handlers.js - Lock Flow and Witness IPC Handlers
 *
 * Registers: local-disc-lock, single-chain-lock, persistent-chain-lock,
 *            checkpoint-project, tsd-balance, tsd-fund, tsd-pay,
 *            set-interlock, open-external, open-folder, get-witness-status
 *
 * SCRUPLE Studio — Patent Pending
 */

'use strict';

const { ipcMain, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ctx = require('../context');
const { performLocalDiscLock, performSingleChainLock, performPersistentChainLock } = require('../lock/lock-barrel');
const { isOnline: isWitnessOnline, getStatus: getWitnessStatus } = require('../server/witness-index');
const tsdClient = require('../server/tsd-client');

/**
 * Derive a Pre-SCR ID from project name + timestamp.
 */
function derivePreScrId(name, createdAt) {
  const input = name + createdAt;
  return 'PRE_' + crypto.createHash('sha256').update(input).digest('hex').substring(0, 6).toUpperCase();
}

/**
 * Clone a checkpointed project into a new finalized copy.
 * Called from the local-disc-lock handler when project.status === 'checkpointed'.
 *
 * @param {number} sourceProjectId - source project DB id
 * @param {string} installationId - installation/session id
 * @returns {object} result with success and clonedName
 */
async function performFinalizeClone(sourceProjectId, installationId) {
  const databaseManager = ctx.get('databaseManager');
  const configManager = ctx.get('configManager');

  const source = databaseManager.getProject(sourceProjectId);
  if (!source) {
    return { success: false, error: 'Source project not found' };
  }

  const newName = source.name + '_final';
  const newCreatedAt = new Date().toISOString();
  const newPreScrId = derivePreScrId(newName, newCreatedAt);

  // 1. Clone project in local DB
  const cloned = await databaseManager.cloneProject(sourceProjectId, newName, newPreScrId);
  if (!cloned) {
    return { success: false, error: 'DB clone failed' };
  }

  // 2. Clone witness records on Oracle
  try {
    await tsdClient.cloneProject(sourceProjectId, newPreScrId, newName, installationId);
  } catch (err) {
    console.log('[LOCK] Oracle clone-project warning: ' + err.message);
    // Non-fatal — continue with local lock even if Oracle clone fails
  }

  // 3. Copy vault folder
  const config = configManager.load();
  const vaultRoot = path.join(config.scrupleHome, 'vault');
  const sourceFolderName = source.name + '_locked';
  const destFolderName = newName + '_locked';
  const sourceVaultPath = path.join(vaultRoot, sourceFolderName);
  const destVaultPath = path.join(vaultRoot, destFolderName);

  if (fs.existsSync(sourceVaultPath)) {
    try {
      fs.cpSync(sourceVaultPath, destVaultPath, { recursive: true });

      // 4. Update cloned provenance.json
      const provenancePath = path.join(destVaultPath, 'provenance.json');
      if (fs.existsSync(provenancePath)) {
        const provenance = JSON.parse(fs.readFileSync(provenancePath, 'utf8'));
        provenance.pre_scr_id = newPreScrId;
        provenance.project.name = newName;
        provenance.cloned_from = source.pre_scr_id || String(sourceProjectId);
        provenance.clone_note = 'Finalized copy created from checkpointed project';
        fs.writeFileSync(provenancePath, JSON.stringify(provenance, null, 2));
      }
    } catch (err) {
      console.log('[LOCK] Vault copy warning: ' + err.message);
    }
  }

  // 5. Local lock the cloned project
  try {
    const lockResult = await performLocalDiscLock(cloned.id);
    return {
      success: lockResult.success,
      error: lockResult.error,
      clonedName: newName,
      clonedId: cloned.id,
      newPreScrId
    };
  } catch (err) {
    return { success: false, error: 'Clone lock failed: ' + err.message };
  }
}

function registerLockHandlers(sendToRenderer) {
  // 'sendToRenderer' passed in for set-interlock

  // Local Disc Lock — TSD-gated, clone-aware
  ipcMain.handle('local-disc-lock', async (event, projectId, authToken) => {
    const databaseManager = ctx.get('databaseManager');
    const merkleManager = ctx.get('merkleManager');
    if (!databaseManager || !merkleManager) {
      return { success: false, error: 'System not ready' };
    }

    // Verify TSD auth token
    if (authToken) {
      try {
        const tsdResult = await tsdClient.verifyToken(authToken, 'finalize');
        if (!tsdResult.valid) {
          return { success: false, error: tsdResult.error || 'TSD token invalid or expired' };
        }
      } catch (err) {
        console.log('[LOCK] TSD verify error: ' + err.message);
        return { success: false, error: 'TSD verification failed: ' + err.message };
      }
    }

    try {
      // Check if project is checkpointed — trigger clone flow
      const project = databaseManager.getProject(projectId);
      if (project && project.status === 'checkpointed') {
        const installationId = ctx.get('installationId') || String(projectId);
        return await performFinalizeClone(projectId, installationId);
      }

      const result = await performLocalDiscLock(projectId);
      return result;
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Checkpoint Project — TSD-gated
  ipcMain.handle('checkpoint-project', async (event, projectId, authToken) => {
    const databaseManager = ctx.get('databaseManager');
    if (!databaseManager) {
      return { success: false, error: 'System not ready' };
    }

    // Verify TSD auth token
    if (authToken) {
      try {
        const tsdResult = await tsdClient.verifyToken(authToken, 'checkpoint');
        if (!tsdResult.valid) {
          return { success: false, error: tsdResult.error || 'TSD token invalid or expired' };
        }
      } catch (err) {
        return { success: false, error: 'TSD verification failed: ' + err.message };
      }
    }

    try {
      const project = databaseManager.getProject(projectId);
      if (!project) {
        return { success: false, error: 'Project not found' };
      }
      if (project.status !== 'unlocked') {
        return { success: false, error: 'Only unlocked projects can be checkpointed' };
      }

      // Mark project as checkpointed
      databaseManager.updateProjectStatus(projectId, 'checkpointed');
      console.log('[LOCK] Project checkpointed: ' + projectId);

      return { success: true, projectId, status: 'checkpointed' };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Single Chain Lock
  ipcMain.handle('single-chain-lock', async (event, projectId, password) => {
    const databaseManager = ctx.get('databaseManager');
    const merkleManager = ctx.get('merkleManager');
    if (!databaseManager || !merkleManager) {
      return { success: false, error: 'System not ready' };
    }

    if (!password) {
      return { success: false, error: 'Password required' };
    }

    try {
      const result = await performSingleChainLock(projectId, password);
      return result;
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Persistent Chain Lock
  ipcMain.handle('persistent-chain-lock', async (event, projectId) => {
    const databaseManager = ctx.get('databaseManager');
    const merkleManager = ctx.get('merkleManager');
    if (!databaseManager || !merkleManager) {
      return { success: false, error: 'System not ready' };
    }

    try {
      const result = await performPersistentChainLock(projectId);
      return result;
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // ===========================================================================
  // TSD IPC Handlers
  // ===========================================================================

  ipcMain.handle('tsd-balance', async (event, installationId) => {
    try {
      return await tsdClient.getBalance(installationId);
    } catch (err) {
      return { error: err.message };
    }
  });

  ipcMain.handle('tsd-fund', async (event, installationId, amount) => {
    try {
      return await tsdClient.fundAccount(installationId, amount);
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('tsd-pay', async (event, installationId, action, amount) => {
    try {
      return await tsdClient.pay(installationId, action, amount);
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // ===========================================================================
  // Utility Handlers
  // ===========================================================================

  // Interlock (freeze/unfreeze UI during generation)
  ipcMain.handle('set-interlock', async (event, busy) => {
    sendToRenderer('interlock-changed', { busy });
    return { success: true };
  });

  // Open external URL
  ipcMain.handle('open-external', async (event, url) => {
    await shell.openExternal(url);
    return { success: true };
  });

  ipcMain.handle('open-folder', async (event, folderPath) => {
    await shell.openPath(folderPath);
    return { success: true };
  });

  // Witness status
  ipcMain.handle('get-witness-status', async () => {
    const online = await isWitnessOnline();
    const status = getWitnessStatus();
    return { ...status, online };
  });
}

module.exports = { registerLockHandlers };
