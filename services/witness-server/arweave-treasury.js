/**
 * arweave-treasury.js - SCRUPLE Arweave Treasury
 *
 * Posts token records to arlocal using the Oracle treasury wallet.
 * Called after every successful chain lock.
 *
 * SCRUPLE Witness Server V2
 * Patent Pending - All Rights Reserved
 */

const Arweave = require('arweave');
const fs = require('fs');
const path = require('path');

const KEY_PATH = process.env.AR_KEY_PATH || path.join(__dirname, 'arweave-key.json');
const ARLOCAL_HOST = process.env.ARLOCAL_HOST || '127.0.0.1';
const ARLOCAL_PORT = parseInt(process.env.ARLOCAL_PORT || '1984');

let ar = null;
let walletKey = null;
let walletAddress = null;

/**
 * Initialize Arweave client and load treasury wallet.
 */
async function initialize() {
  ar = Arweave.init({
    host: ARLOCAL_HOST,
    port: ARLOCAL_PORT,
    protocol: 'http',
    timeout: 20000
  });

  if (!fs.existsSync(KEY_PATH)) {
    throw new Error('[TREASURY] Arweave key file not found: ' + KEY_PATH);
  }

  walletKey = JSON.parse(fs.readFileSync(KEY_PATH, 'utf8'));
  walletAddress = await ar.wallets.jwkToAddress(walletKey);
  console.log('[TREASURY] Initialized. Address:', walletAddress);
  return walletAddress;
}

/**
 * Get treasury AR balance.
 * @returns {string} Balance in AR
 */
async function getBalance() {
  if (!ar || !walletAddress) await initialize();
  const winston = await ar.wallets.getBalance(walletAddress);
  return ar.ar.winstonToAr(winston);
}

/**
 * Post a token record to arlocal.
 * The token record is a small JSON (~300 bytes) anchoring the lock.
 *
 * @param {object} record - Token record fields
 * @param {string} record.scr_id
 * @param {string} record.pre_scr_id
 * @param {string} record.installation_id
 * @param {string} record.project_name
 * @param {string} record.merkle_root
 * @param {string} record.rvn_txid
 * @param {string} record.witness_signature
 * @param {number} record.witnessed_count
 * @param {string} record.locked_at
 * @param {string|null} record.ipfs_cid
 * @returns {string} Arweave transaction ID
 */
async function postTokenRecord(record) {
  if (!ar || !walletKey) await initialize();

  const tokenRecord = {
    version: '2.0',
    scr_id: record.scr_id,
    pre_scr_id: record.pre_scr_id || null,
    installation_id: record.installation_id || null,
    project_name: record.project_name || null,
    merkle_root: record.merkle_root,
    rvn_txid: record.rvn_txid || null,
    witness_signature: record.witness_signature || null,
    witnessed_count: record.witnessed_count || 0,
    locked_at: record.locked_at || new Date().toISOString(),
    ipfs_cid: record.ipfs_cid || null
  };

  const data = JSON.stringify(tokenRecord);

  const tx = await ar.createTransaction({ data }, walletKey);

  tx.addTag('Content-Type', 'application/json');
  tx.addTag('App-Name', 'SCRUPLE-Studio');
  tx.addTag('SCR-ID', record.scr_id);
  if (record.pre_scr_id) tx.addTag('Pre-SCR-ID', record.pre_scr_id);
  if (record.installation_id) tx.addTag('Installation-ID', record.installation_id);

  await ar.transactions.sign(tx, walletKey);
  const response = await ar.transactions.post(tx);

  if (response.status !== 200 && response.status !== 202) {
    throw new Error('[TREASURY] Arweave post failed: status ' + response.status);
  }

  // Mine the block so the transaction confirms immediately (arlocal only)
  try {
    await fetch('http://' + ARLOCAL_HOST + ':' + ARLOCAL_PORT + '/mine');
  } catch (e) {
    console.warn('[TREASURY] Mine call failed (non-fatal):', e.message);
  }

  console.log('[TREASURY] Token record posted. TX:', tx.id, '| SCR:', record.scr_id);
  return tx.id;
}

module.exports = { initialize, getBalance, postTokenRecord };
