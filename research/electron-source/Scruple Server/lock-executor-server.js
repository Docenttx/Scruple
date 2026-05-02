/**
 * lock-executor-server.js - Server-Side Chain Lock Executor
 *
 * Beta Auto-RVN mode: POSTs to Oracle /api/testnet-lock.
 * Oracle master wallet executes RVN mint + Arweave upload.
 * No local wallet required.
 *
 * Interface: async executeLock(projectId, options) → { success, scrId, rvnTxId, ipfsCid, arweaveTxId }
 *
 * SCRUPLE Studio — Patent Pending
 */

'use strict';

const ctx = require('../../context');

const ORACLE_URL = 'http://129.80.23.93:5799';
const LOCK_TIMEOUT = 60000;

async function executeLock(projectId, options) {
  options = options || {};

  const databaseManager = ctx.get('databaseManager');
  const project = databaseManager.getProject(projectId);

  if (!project || !project.scr_id || !project.merkle_root) {
    throw new Error('Project must be local_locked before server lock');
  }

  const configManager = ctx.get('configManager');
  const installationId = configManager.getInstallationId();
  const lockTier = options.lockTier || 'basic';

  _log('[EXECUTOR-SERVER] Posting testnet-lock to Oracle: ' + project.scr_id);

  const payload = {
    project_id: String(projectId),
    scr_id: project.scr_id,
    merkle_root: project.merkle_root,
    pre_scr_id: project.pre_scr_id || null,
    installation_id: installationId,
    lock_tier: lockTier
  };

  const response = await fetch(ORACLE_URL + '/api/testnet-lock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(LOCK_TIMEOUT)
  });

  if (!response.ok) {
    const text = await response.text().catch(() => String(response.status));
    throw new Error('Oracle lock failed (' + response.status + '): ' + text);
  }

  const result = await response.json();

  if (!result.success) {
    throw new Error(result.error || 'Oracle lock returned failure');
  }

  _log('[EXECUTOR-SERVER] Lock complete. RVN: ' + (result.rvn_txid || 'none'));

  return {
    success: true,
    scrId: project.scr_id,
    rvnTxId: result.rvn_txid || null,
    arweaveTxId: result.arweave_txid || null,
    ipfsCid: result.ipfs_cid || null
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
