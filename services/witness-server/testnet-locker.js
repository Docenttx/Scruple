/**
 * testnet-locker.js - SCRUPLE Testnet Lock Executor
 *
 * Executes RVN testnet asset issuance via raven-cli.
 * Used in Auto-RVN beta mode where Oracle master wallet handles all minting.
 *
 * SCRUPLE Witness Server V2
 * Patent Pending - All Rights Reserved
 */

const { execFile } = require('child_process');
const crypto = require('crypto');

const RAVEN_CLI = process.env.RAVEN_CLI || '/usr/local/bin/raven-cli';
const TESTNET_FLAG = '-testnet';
const ASSET_QUANTITY = 1;
const ASSET_REISSUABLE = false;

/**
 * Execute a raven-cli command on testnet.
 * @param {string[]} args - CLI arguments
 * @returns {Promise<string>} stdout
 */
function ravenCli(...args) {
  return new Promise((resolve, reject) => {
    execFile(RAVEN_CLI, [TESTNET_FLAG, ...args], { timeout: 60000 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error('[LOCKER] raven-cli error: ' + (stderr || err.message)));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

/**
 * Issue a SCRUPLE asset on RVN testnet.
 * Asset name is the SCR ID (e.g. "SCR_F10F82").
 *
 * @param {string} scrId - SCR ID to mint as asset name
 * @param {string} ipfsCid - Optional IPFS CID for asset metadata
 * @returns {object} { txid, scrId }
 */
async function issueAsset(scrId, ipfsCid) {
  console.log('[LOCKER] Issuing RVN testnet asset:', scrId);

  // Build asset metadata URL — IPFS CID if available, otherwise empty
  const assetUrl = ipfsCid ? ('ipfs://' + ipfsCid) : '';

  // issue <asset_name> <qty> [units] [reissuable] [has_ipfs] [ipfs_hash]
  const args = [
    'issue',
    scrId,
    String(ASSET_QUANTITY),
    'mhbaosfYBFkL3aNcuCgjZJ1wX8AhN8E1Jc',  // to_address
    'mhbaosfYBFkL3aNcuCgjZJ1wX8AhN8E1Jc',  // change_address
    '0',                              // units (0 = whole)
    false,                           // reissuable
    false,                           // has_ipfs
  ];

  if (ipfsCid) {
    args.push(ipfsCid);
  }

  const raw = await ravenCli(...args);
  const parsed = JSON.parse(raw);
  const txid = Array.isArray(parsed) ? parsed[0] : parsed;

  if (!txid || txid.length < 60) {
    throw new Error('[LOCKER] Unexpected txid from raven-cli: ' + raw);
  }

  console.log('[LOCKER] Asset issued. TXID:', txid);
  return { txid, scrId };
}

/**
 * Verify an asset exists on testnet.
 * @param {string} scrId - Asset name to verify
 * @returns {object} { exists, data }
 */
async function verifyAsset(scrId) {
  try {
    const result = await ravenCli('getassetdata', scrId);
    const data = JSON.parse(result);
    return { exists: true, data };
  } catch (e) {
    return { exists: false, data: null };
  }
}

module.exports = { issueAsset, verifyAsset };
