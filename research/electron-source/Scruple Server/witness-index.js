/**
 * witness-index.js - SCRUPLE Witness Module
 * 
 * Provides realtime hash witnessing for tamper-proof provenance.
 * Server records each iteration's hash immediately after generation.
 * At lock time, server provides authoritative chain.
 * 
 * SCRUPLE Studio V3
 * Patent Pending - All Rights Reserved
 */

const WitnessClient = require('./witness-client');

// Singleton instances
let client = null;
let initialized = false;

/**
 * Initialize the witness system.
 * Starts mock server locally (swap URL for production later).
 * 
 * @returns {Promise<boolean>} true if initialized successfully
 */
async function initializeWitness() {
  if (initialized) {
    console.log('[WITNESS] Already initialized');
    return true;
  }

  try {
    // Create client pointing to Oracle VM witness server
    client = new WitnessClient();
    
    // Verify connection
    const online = await client.checkConnection();
    console.log('[WITNESS] Client connected to Oracle VM:', online);

    initialized = true;
    return true;

  } catch (error) {
    console.error('[WITNESS] Initialization failed:', error.message);
    return false;
  }
}

/**
 * Witness a single iteration.
 * Call this immediately after each generation.
 * 
 * @param {Object} params - Witness parameters
 * @param {string} params.projectId - Project UUID/ID
 * @param {string} params.projectName - Human-readable project name
 * @param {number} params.runSequence - Iteration number
 * @param {string} params.contentHash - The chained content hash (leaf_hash)
 * @param {string} params.visualHash - Raw image hash (optional, for reference)
 * @param {string} params.timestamp - ISO timestamp
 * @returns {Promise<Object|null>} Witness record or null if offline
 */
async function witnessIteration(params) {
  if (!client) {
    console.log('[WITNESS] Client not initialized');
    return null;
  }

  const { projectId, projectName, runSequence, contentHash, visualHash, timestamp, preScrId, installationId } = params;

  const result = await client.witnessIteration(
    String(projectId),
    projectName,
    runSequence,
    contentHash,
    visualHash || contentHash,
    timestamp,
    preScrId || null,
    installationId || null
  );

  if (result) {
    console.log(`[WITNESS] Iteration ${runSequence} witnessed: ${result.witness_id}`);
  } else {
    console.log(`[WITNESS] Iteration ${runSequence} NOT witnessed (offline)`);
  }

  return result;
}

/**
 * Lock a project and get authoritative chain from server.
 * Server returns the merkle root calculated from witnessed hashes.
 * 
 * @param {string} projectId - Project UUID/ID
 * @returns {Promise<Object|null>} Lock data with server's merkle root, or null if offline
 */
async function lockProject(projectId) {
  if (!client) {
    console.log('[WITNESS] Client not initialized');
    return null;
  }

  const result = await client.lockProject(String(projectId));

  if (result) {
    console.log(`[WITNESS] Project locked. Witnessed: ${result.witnessed_count}, Root: ${result.merkle_root?.substring(0, 16)}...`);
  } else {
    console.log('[WITNESS] Lock failed - server offline');
  }

  return result;
}

/**
 * Get all witnessed iterations for a project.
 * 
 * @param {string} projectId - Project UUID/ID
 * @returns {Promise<Array>} Array of witnessed iterations
 */
async function getWitnessedIterations(projectId) {
  if (!client) return [];
  return await client.getWitnessedIterations(String(projectId));
}

/**
 * Verify local chain against server records.
 * 
 * @param {string} projectId - Project UUID/ID
 * @param {Array} localChain - Array of { run_sequence, content_hash }
 * @returns {Promise<Object>} Verification result
 */
async function verifyChain(projectId, localChain) {
  if (!client) {
    return { valid: false, error: 'Client not initialized' };
  }
  return await client.verifyChain(String(projectId), localChain);
}

/**
 * Get witness system status.
 * 
 * @returns {Object} Status info
 */
function getStatus() {
  return {
    initialized,
    online: client?.online || false,
    serverUrl: client?.serverUrl || null
  };
}

/**
 * Check if witness server is online.
 * 
 * @returns {Promise<boolean>}
 */
async function isOnline() {
  if (!client) return false;
  return await client.checkConnection();
}

/**
 * Cleanup - stop mock server.
 * Call on app quit.
 */
async function cleanup() {
  client = null;
  initialized = false;
  console.log('[WITNESS] Cleanup complete');
}

module.exports = {
  initializeWitness,
  witnessIteration,
  lockProject,
  getWitnessedIterations,
  verifyChain,
  getStatus,
  isOnline,
  cleanup,
  
  // Export for direct access if needed
  getClient: () => client
};
