/**
 * lock-executor-fiat.js - Fiat/TSD Chain Lock Executor
 *
 * Delegates chain lock execution to the Oracle server.
 * Oracle endpoint: POST /api/fiat-chain-lock
 *
 * SCRUPLE Studio - Patent Pending
 */

'use strict';

const ctx = require('../../context');
const { buildScruplePackage } = require('../lock-barrel');

const ORACLE_URL = process.env.SCRUPLE_WITNESS_URL || 'http://129.80.23.93:5799';
const LOCK_TIMEOUT = 120000;

async function executeLock(projectId, options) {
  const { authToken, lockTier = 'basic' } = options;
  const databaseManager = ctx.get('databaseManager');
  const configManager = ctx.get('configManager');
  if (!databaseManager) throw new Error('Database not ready');
  if (!authToken) throw new Error('Auth token required for fiat chain lock');
  const project = databaseManager.getProject(projectId);
  if (!project) throw new Error('Project not found: ' + projectId);
  console.log('[FIAT-LOCK] Starting ' + lockTier + ' chain lock for ' + project.name);
  let scruplePackage;
  try { scruplePackage = await buildScruplePackage(projectId); }
  catch (err) { throw new Error('Failed to build provenance package: ' + err.message); }
  const installationId = configManager ? configManager.getInstallationId() : null;
  const payload = { project_id: String(projectId), project_name: project.name, pre_scr_id: project.pre_scr_id || null, merkle_root: project.merkle_root || scruplePackage.merkleRoot, lock_tier: lockTier, auth_token: authToken, installation_id: installationId, package: scruplePackage };
  let response;
  try { response = await fetch(ORACLE_URL + '/api/fiat-chain-lock', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(LOCK_TIMEOUT) }); }
  catch (err) { throw new Error('Oracle unreachable: ' + err.message); }
  let body;
  try { body = await response.json(); }
  catch (err) { throw new Error('Oracle returned invalid JSON (status ' + response.status + ')'); }
  if (!response.ok || !body.success) throw new Error(body.error || 'Oracle chain lock failed (HTTP ' + response.status + ')');
  if (body.scrId) { databaseManager.updateProject(projectId, { status: 'chain_locked', scr_id: body.scrId, rvn_txid: body.proofTxId || null, ipfs_cid: body.ipfsCid || null, arweave_uri: body.arweaveTxId || null, locked_at: new Date().toISOString() }); }
  return { success: true, scrId: body.scrId, proofTxId: body.proofTxId || null, merkleRoot: body.merkleRoot || project.merkle_root, ipfsCid: body.ipfsCid || null, ipfsError: body.ipfsError || null, arweaveTxId: body.arweaveTxId || null, arweaveError: body.arweaveError || null };
}

module.exports = { executeLock };
