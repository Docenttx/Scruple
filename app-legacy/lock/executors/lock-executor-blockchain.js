/**
 * lock-executor-blockchain.js - Client-Side Chain Lock Executor
 *
 * Beta User-RVN mode: executes RVN asset mint via local ElectrumX,
 * then calls Oracle /api/upload-proof for Arweave token record upload.
 *
 * Interface: async executeLock(projectId, options) → { success, scrId, rvnTxId, ipfsCid, arweaveTxId }
 *
 * SCRUPLE Studio — Patent Pending
 */

'use strict';

const ctx = require('../../context');
const { getClient: getWitnessClient } = require('../../server/witness-index');

function getWalletsIntegration() {
  const network = ctx.get('configManager')?.getNetwork() || 'rvn';
  if (network === 'rvn-test') {
    return require('../../wallet/ravencoin/wallets-integration-native-testnet');
  }
  return require('../../wallet/ravencoin/wallets-integration-native');
}

async function executeLock(projectId, options) {
  options = options || {};

  const databaseManager = ctx.get('databaseManager');
  const project = databaseManager.getProject(projectId);

  if (!project || !project.scr_id || !project.merkle_root) {
    throw new Error('Project must be local_locked before blockchain lock');
  }

  const password = options.password || '';

  _log('[EXECUTOR-BLOCKCHAIN] Starting client-side ElectrumX mint: ' + project.scr_id);

  const { performSingleChainLock: walletsSingleChainLock } = getWalletsIntegration();
  const mintResult = await walletsSingleChainLock(projectId, password, databaseManager);

  if (!mintResult.success) {
    throw new Error(mintResult.error || 'Blockchain mint failed');
  }

  _log('[EXECUTOR-BLOCKCHAIN] RVN mint complete: ' + mintResult.txId);

  // Post Arweave token record via Oracle treasury wallet
  let arweaveTxId = null;
  try {
    const witnessClient = getWitnessClient();
    if (witnessClient) {
      const configManager = ctx.get('configManager');
      const installationId = configManager.getInstallationId();
      const proofResult = await witnessClient.uploadProof(
        project.scr_id,
        mintResult.txId || null,
        project.merkle_root,
        project.pre_scr_id || null,
        installationId,
        mintResult.ipfsCid || null
      );
      if (proofResult && proofResult.arweave_txid) {
        arweaveTxId = proofResult.arweave_txid;
        _log('[EXECUTOR-BLOCKCHAIN] Arweave record posted: ' + arweaveTxId);
      }
    }
  } catch (e) {
    _log('[EXECUTOR-BLOCKCHAIN] Arweave upload failed (non-fatal): ' + e.message, 'warn');
  }

  return {
    success: true,
    scrId: mintResult.scrId || project.scr_id,
    rvnTxId: mintResult.txId || null,
    arweaveTxId: arweaveTxId,
    ipfsCid: mintResult.ipfsCid || null
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

module.exports = { executeLock };
