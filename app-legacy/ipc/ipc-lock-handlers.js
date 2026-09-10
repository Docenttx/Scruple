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
// stripe-client loaded on demand in handlers to avoid circular deps

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

/**
 * WO-G2. Put the Standard's output modalities on a project that has just been
 * locked, and NEVER let doing so change whether the lock happened.
 *
 * §9.1 (C2PA) and §9.2 (EU-compliant watermarking) are peers under EU AI Act
 * Article 50 Code of Practice Section 1. Both are applied here; the tier follows
 * the button (checkpoint → 2, local → 3, chain → 4/5).
 *
 * ⚑ `digitalSourceType` is NOT defaulted. Standard §9.1 puts it in the manifest
 * and it is the field that asserts whether generative AI made the bytes. A lock
 * action cannot know that, so the renderer must say — and when it has not, this
 * returns `declined` rather than picking one. An unsigned artifact is a gap; a
 * wrongly-typed one is a false statement, and the second is worse.
 */
async function applyLockModalities(projectId, lock, options) {
  const dst = options && options.digitalSourceType;
  if (!dst) {
    return {
      applied: false,
      reason: 'declined',
      detail: 'no digitalSourceType was declared; §9.1 will not guess it and neither will this',
    };
  }
  try {
    const { applyToProject } = require('../lock/modalities');
    const r = await applyToProject({
      projectId,
      lock,
      digitalSourceType: dst,
      scrId: options.scrId,
      pinnedHint: options.pinnedHint,
    });
    console.log(`[LOCK] modalities ${lock}: ${r.marked}/${r.attempted} watermarked, ${r.signed} signed`);
    return { applied: true, ...r };
  } catch (e) {
    // A failure here is reported, never thrown: the lock has already happened.
    console.error('[LOCK] modalities failed: ' + e.message);
    return { applied: false, reason: 'error', detail: e.message };
  }
}

function registerLockHandlers(sendToRenderer) {
  // 'sendToRenderer' passed in for set-interlock

  // Local Disc Lock — TSD-gated, clone-aware
  ipcMain.handle('local-disc-lock', async (event, projectId, authToken, options) => {
    const databaseManager = ctx.get('databaseManager');
    const merkleManager = ctx.get('merkleManager');
    if (!databaseManager || !merkleManager) {
      return { success: false, error: 'System not ready' };
    }

    // Stripe payment verification — paymentIntentId passed instead of authToken
    if (authToken) {
      try {
        const stripeClient = require('../server/stripe-client');
        const verifyResult = await stripeClient.verifyPayment(authToken, 'finalize');
        if (!verifyResult.valid) {
          return { success: false, error: verifyResult.error || 'Payment not verified' };
        }
      } catch (err) {
        console.log('[LOCK] Stripe verify error: ' + err.message);
        return { success: false, error: 'Payment verification failed: ' + err.message };
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
      // WO-G2. §9.2 tier 3 + §9.1. Only on a lock that actually succeeded —
      // marking the artifacts of a failed lock would put a signing timestamp on
      // an event that did not happen.
      if (result && result.success !== false) {
        result.modalities = await applyLockModalities(projectId, 'local', options);
      }
      return result;
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Checkpoint Project — TSD-gated
  ipcMain.handle('checkpoint-project', async (event, projectId, authToken, options) => {
    const databaseManager = ctx.get('databaseManager');
    if (!databaseManager) {
      return { success: false, error: 'System not ready' };
    }

    // Stripe payment verification
    if (authToken) {
      try {
        const stripeClient = require('../server/stripe-client');
        const verifyResult = await stripeClient.verifyPayment(authToken, 'checkpoint');
        if (!verifyResult.valid) {
          return { success: false, error: verifyResult.error || 'Payment not verified' };
        }
      } catch (err) {
        return { success: false, error: 'Payment verification failed: ' + err.message };
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

      // WO-G2. §9.2 tier 2 + §9.1, on every image iteration. The button did not
      // change; what happens underneath it did.
      //
      // ⚑ THE MODALITIES DO NOT DECIDE WHETHER THE CHECKPOINT HAPPENED. The
      // status is already written above. If the signer is unreachable the
      // project is still checkpointed and the caller is told which iterations
      // are unmarked — the alternative is a lock that fails because a network
      // was down, which loses the user's work to protect a credential.
      const modalities = await applyLockModalities(projectId, 'checkpoint', options);

      return { success: true, projectId, status: 'checkpointed', modalities };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Single Chain Lock
  ipcMain.handle('single-chain-lock', async (event, projectId, password, options) => {
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
      // WO-G2. §9.3 tier 4 — the CHAIN-LOCK watermark, whose body is the SCR_ID
      // rather than a timestamp, so someone finding the file in the wild can
      // recover the ID from the pixels and reach the ledger inscription.
      //
      // ⚑ WITHOUT AN SCR_ID THERE IS NO TIER-4 PAYLOAD, and the server refuses
      // to mint one — a lookup path that leads nowhere is worse than none,
      // because it looks like one. The SCR_ID comes off the lock result; if the
      // lock did not produce one, the modalities decline and say so.
      if (result && result.success !== false) {
        result.modalities = await applyLockModalities(projectId, 'chain', {
          ...(options || {}),
          scrId: (options && options.scrId) || result.scrId || result.scr_id,
        });
      }
      return result;
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Persistent Chain Lock
  ipcMain.handle('persistent-chain-lock', async (event, projectId, options) => {
    const databaseManager = ctx.get('databaseManager');
    const merkleManager = ctx.get('merkleManager');
    if (!databaseManager || !merkleManager) {
      return { success: false, error: 'System not ready' };
    }

    try {
      const result = await performPersistentChainLock(projectId);
      // WO-G2. §9.3 tier 5 when the artifact is pinned — SCR_ID plus a
      // pinned-content hint — and tier 4 when it is not. The distinction is the
      // Standard's, not a preference: tier 5's body carries the hint that lets a
      // finder reach the pinned copy directly.
      if (result && result.success !== false) {
        const scrId = (options && options.scrId) || result.scrId || result.scr_id;
        const hint = (options && options.pinnedHint) !== undefined
          ? options.pinnedHint
          : (result.pinnedHint !== undefined ? result.pinnedHint : undefined);
        result.modalities = await applyLockModalities(
          projectId,
          hint === undefined ? 'chain' : 'chain-pinned',
          { ...(options || {}), scrId, pinnedHint: hint }
        );
      }
      return result;
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // ===========================================================================
  // Stripe IPC Handlers
  // ===========================================================================

  ipcMain.handle('stripe-get-config', async () => {
    try {
      const stripeClient = require('../server/stripe-client');
      return await stripeClient.getConfig();
    } catch (err) {
      return { error: err.message };
    }
  });

  ipcMain.handle('stripe-create-payment-intent', async (event, action, projectId) => {
    try {
      const stripeClient = require('../server/stripe-client');
      const configManager = ctx.get('configManager');
      const installationId = configManager ? configManager.getInstallationId() : 'unknown';
      return await stripeClient.createPaymentIntent(action, projectId, installationId);
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('stripe-confirm-and-execute', async (event, paymentIntentId, action, projectId, options) => {
    try {
      const stripeClient = require('../server/stripe-client');
      const configManager = ctx.get('configManager');
      const installationId = configManager ? configManager.getInstallationId() : 'unknown';
      return await stripeClient.confirmAndExecute(paymentIntentId, action, projectId, installationId, options || {});
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
