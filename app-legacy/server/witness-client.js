/**
 * witness-client.js - SCRUPLE Witness Client
 * 
 * Communicates with SCRUPLE Witness Server to record
 * realtime provenance hashes that user cannot forge.
 * 
 * SCRUPLE Studio V3
 * Patent Pending - All Rights Reserved
 */

const crypto = require('crypto');
const tsdClient = require('./tsd-client');

// Server configuration
const WITNESS_SERVER_URL = process.env.SCRUPLE_WITNESS_URL || 'http://129.80.23.93:5799';
const WITNESS_TIMEOUT = 5000; // 5 seconds

class WitnessClient {
  constructor() {
    this.serverUrl = WITNESS_SERVER_URL;
    this.online = false;
    this.lastCheck = null;
  }

  /**
   * Check if witness server is reachable
   */
  async checkConnection() {
    try {
      const response = await fetch(`${this.serverUrl}/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(2000)
      });
      this.online = response.ok;
      this.lastCheck = Date.now();
      return this.online;
    } catch (error) {
      this.online = false;
      this.lastCheck = Date.now();
      return false;
    }
  }

  /**
   * Witness a single iteration
   * Called immediately after each generation
   * 
   * @param {string} projectId - Project UUID
   * @param {string} projectName - Human-readable project name
   * @param {number} runSequence - Iteration number
   * @param {string} contentHash - The chained content hash
   * @param {string} visualHash - Raw image hash (for reference)
   * @param {string} timestamp - ISO timestamp from Studio
   * @returns {object|null} Witness record or null if offline
   */
  async witnessIteration(projectId, projectName, runSequence, contentHash, visualHash, timestamp) {
    try {
      const payload = {
        project_id: projectId,
        project_name: projectName,
        run_sequence: runSequence,
        content_hash: contentHash,
        visual_hash: visualHash,
        client_timestamp: timestamp
      };

      const response = await fetch(`${this.serverUrl}/api/witness`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(WITNESS_TIMEOUT)
      });

      if (!response.ok) {
        console.log(`[WITNESS] Server error: ${response.status}`);
        return null;
      }

      const result = await response.json();
      this.online = true;
      
      console.log(`[WITNESS] Iteration ${runSequence} witnessed: ${result.witness_id}`);
      
      return {
        witnessed: true,
        witness_id: result.witness_id,
        server_timestamp: result.server_timestamp,
        signature: result.signature
      };

    } catch (error) {
      console.log(`[WITNESS] Offline or error: ${error.message}`);
      this.online = false;
      return null;
    }
  }

  /**
   * Lock a project - get server's authoritative chain
   * 
   * @param {string} projectId - Project UUID
   * @returns {object|null} Lock record with all witnessed iterations
   */
  async lockProject(projectId) {
    try {
      const response = await fetch(`${this.serverUrl}/api/lock/${projectId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(WITNESS_TIMEOUT * 2)
      });

      if (!response.ok) {
        console.log(`[WITNESS] Lock failed: ${response.status}`);
        return null;
      }

      const result = await response.json();
      
      console.log(`[WITNESS] Project locked. Root: ${result.merkle_root?.substring(0, 16)}...`);
      
      return {
        project_id: result.project_id,
        iterations: result.iterations,
        witnessed_count: result.witnessed_count,
        merkle_root: result.merkle_root,
        server_signature: result.server_signature,
        locked_at: result.locked_at
      };

    } catch (error) {
      console.log(`[WITNESS] Lock error: ${error.message}`);
      return null;
    }
  }

  /**
   * Get all witnessed iterations for a project
   * 
   * @param {string} projectId - Project UUID
   * @returns {array} List of witnessed iterations
   */
  async getWitnessedIterations(projectId) {
    try {
      const response = await fetch(`${this.serverUrl}/api/witness/${projectId}`, {
        method: 'GET',
        signal: AbortSignal.timeout(WITNESS_TIMEOUT)
      });

      if (!response.ok) {
        return [];
      }

      const result = await response.json();
      return result.iterations || [];

    } catch (error) {
      console.log(`[WITNESS] Fetch error: ${error.message}`);
      return [];
    }
  }

  /**
   * Verify local chain against server records
   * 
   * @param {string} projectId - Project UUID
   * @param {array} localChain - Array of { run_sequence, content_hash }
   * @returns {object} Verification result
   */
  async verifyChain(projectId, localChain) {
    try {
      const response = await fetch(`${this.serverUrl}/api/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: projectId,
          local_chain: localChain
        }),
        signal: AbortSignal.timeout(WITNESS_TIMEOUT)
      });

      if (!response.ok) {
        return { valid: false, error: 'Server error' };
      }

      return await response.json();

    } catch (error) {
      return { valid: false, error: error.message };
    }
  }

  // ===========================================================================
  // TSD Methods (proxy to tsd-client.js)
  // ===========================================================================

  async getTsdBalance(installationId) {
    return await tsdClient.getBalance(installationId);
  }

  async fundTsd(installationId, amount) {
    return await tsdClient.fundAccount(installationId, amount);
  }

  async payTsd(installationId, action, amount) {
    return await tsdClient.pay(installationId, action, amount);
  }

  async verifyTsdToken(authToken, action) {
    return await tsdClient.verifyToken(authToken, action);
  }

  /**
   * Get connection status
   */
  getStatus() {
    return {
      online: this.online,
      serverUrl: this.serverUrl,
      lastCheck: this.lastCheck
    };
  }
}

module.exports = WitnessClient;
