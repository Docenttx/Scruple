/**
 * lock-chain-lock.js - Chain Lock Operations
 *
 * Handles RVN asset issuance (Single Chain Lock) and
 * permanent storage (Persistent Chain Lock via IPFS + Arweave).
 *
 * SCRUPLE Studio — Patent Pending
 */

'use strict';

const ctx = require('../context');
const { performLocalDiscLock } = require('./lock-local-lock');

/**
 * Dynamically select wallet integration based on active network config.
 * Returns mainnet or testnet module at call time, not at require time.
 */
function getWalletsIntegration() {
  const network = ctx.get('configManager')?.getNetwork() || 'rvn';
  if (network === 'rvn-test') {
    return require('../wallet/ravencoin/wallets-integration-native-testnet');
  }
  return require('../wallet/ravencoin/wallets-integration-native');
}

/**
 * Select chain lock executor based on beta.rvnMode config.
 * 'auto' → lock-executor-server.js (Oracle master wallet)
 * 'user' → lock-executor-blockchain.js (local ElectrumX)
 * 'fiat' → lock-executor-fiat.js (stub — not yet implemented)
 */
function getLockExecutor() {
  const mode = ctx.get('configManager').get('beta')?.rvnMode || 'auto';
  const executorMap = { 'auto': 'server', 'user': 'blockchain', 'fiat': 'fiat' };
  const executorName = executorMap[mode] || 'server';
  return require('./executors/lock-executor-' + executorName);
}

async function performSingleChainLock(projectId, password, options) {
  options = options || {};
  _log('Performing Single Chain Lock for project: ' + projectId);
  
  const project = ctx.get('databaseManager').getProject(projectId);
  if (!project) {
    throw new Error('Project not found');
  }

  if (project.status !== 'local_locked') {
    if (project.status === 'unlocked') {
      await performLocalDiscLock(projectId);
    } else {
      throw new Error('Invalid project state for Single Chain Lock');
    }
  }

  const executor = getLockExecutor();
  const result = await executor.executeLock(projectId, {
    password: password || '',
    lockTier: options.lockTier || 'basic'
  });

  if (!result.success) {
    throw new Error(result.error || 'Single Chain Lock failed');
  }

  // Update project status — executors may do this internally too, idempotent
  ctx.get('databaseManager').updateProject(projectId, { status: 'chain_locked' });

  _log('Single Chain Lock complete: ' + result.scrId);
  return result;
}

async function performPersistentChainLock(projectId, password) {
  _log('Performing Persistent Chain Lock for project: ' + projectId);
  
  const project = ctx.get('databaseManager').getProject(projectId);
  if (!project) {
    throw new Error('Project not found');
  }

  if (project.status !== 'chain_locked') {
    if (project.status === 'unlocked' || project.status === 'local_locked') {
      await performSingleChainLock(projectId, password);
    } else {
      throw new Error('Invalid project state for Persistent Chain Lock');
    }
  }

  const { performPermanentLock: walletsPermanentLock } = getWalletsIntegration();
  const result = await walletsPermanentLock(projectId, ctx.get('databaseManager'), {
    arweave: true,
    ipfs: true
  });

  if (!result.success) {
    throw new Error(result.error || 'Permanent lock failed');
  }

  const lockedProject = ctx.get('databaseManager').getProject(projectId);

  _log('Persistent Chain Lock complete: ' + lockedProject.scr_id);

  return {
    success: true,
    scrId: lockedProject.scr_id,
    ipfsCid: result.ipfsCid,
    arweaveTxId: result.arweaveTxId,
    mock: false
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

module.exports = { performSingleChainLock, performPersistentChainLock };
