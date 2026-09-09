/**
 * native-issuer.js - Native RVN Asset Issuer
 * 
 * High-level interface for issuing SCRUPLE proof assets.
 * Replaces RPC-based asset creation with pure JavaScript implementation.
 * 
 * Uses:
 * - ElectrumX for UTXO queries and broadcast
 * - Custom transaction builder for asset issuance
 * - Independent key derivation from mnemonic
 * 
 * SCRUPLE Studio V3 - AI Provenance Middleware
 * Patent Pending
 */

const { ElectrumXClient } = require('./electrumx-client');
const { 
  deriveMultipleKeys, 
  buildAndSignAssetTx,
  ASSET_CREATION_COST,
  DEFAULT_FEE_RATE 
} = require('./asset-encoder');

// ============================================================================
// NATIVE ASSET ISSUER CLASS
// ============================================================================

class NativeAssetIssuer {
  constructor() {
    this.electrumx = new ElectrumXClient();
    this.connected = false;
  }

  /**
   * Initialize connection to ElectrumX.
   * 
   * @returns {Promise<boolean>} True if connected
   */
  async connect() {
    if (this.connected) return true;
    
    try {
      await this.electrumx.connect();
      this.connected = true;
      return true;
    } catch (error) {
      console.error('[NATIVE-ISSUER] Connection failed:', error.message);
      return false;
    }
  }

  /**
   * Disconnect from ElectrumX.
   */
  async disconnect() {
    await this.electrumx.close();
    this.connected = false;
  }

  /**
   * Check if an asset name already exists.
   * 
   * @param {string} assetName - Asset name to check (e.g., "SCR_XXXXXX")
   * @returns {Promise<boolean>} True if asset exists
   */
  async assetExists(assetName) {
    await this.connect();
    return await this.electrumx.assetExists(assetName);
  }

  /**
   * Get balance for wallet addresses derived from mnemonic.
   * Scans multiple derivation paths to find all UTXOs.
   * 
   * @param {string} mnemonic - BIP39 mnemonic
   * @returns {Promise<Object>} { total, utxos, addresses }
   */
  async getBalance(mnemonic) {
    await this.connect();
    
    // Derive multiple addresses
    const keys = deriveMultipleKeys(mnemonic, 20);
    const addresses = keys.map(k => k.address);
    
    // Get UTXOs for all addresses
    const allUtxos = [];
    let total = 0;
    
    for (const key of keys) {
      try {
        const utxos = await this.electrumx.getUTXOs(key.address);
        for (const utxo of utxos) {
          allUtxos.push({
            ...utxo,
            address: key.address
          });
          total += utxo.value;
        }
      } catch (e) {
        // Skip addresses with errors
      }
    }
    
    console.log(`[NATIVE-ISSUER] Found ${allUtxos.length} UTXOs totaling ${total / 1e8} RVN`);
    
    return {
      total,
      totalRVN: total / 1e8,
      utxos: allUtxos,
      addresses: addresses.slice(0, 5) // Return first 5 for display
    };
  }

  /**
   * Get fee quote for asset issuance.
   * 
   * @returns {Promise<Object>} Fee breakdown
   */
  async getFeeQuote() {
    await this.connect();
    
    const feeRate = await this.electrumx.estimateFee(6);
    
    // Estimate transaction size (~400 bytes for typical asset TX)
    const estimatedSize = 400;
    const networkFee = estimatedSize * feeRate;
    
    return {
      burnAmount: ASSET_CREATION_COST,
      burnAmountRVN: ASSET_CREATION_COST / 1e8,
      networkFee,
      networkFeeRVN: networkFee / 1e8,
      feeRate,
      estimatedTotal: ASSET_CREATION_COST + networkFee,
      estimatedTotalRVN: (ASSET_CREATION_COST + networkFee) / 1e8
    };
  }

  /**
   * Issue a SCRUPLE proof asset.
   * 
   * This is the main entry point for asset creation.
   * 
   * @param {Object} params
   * @param {string} params.scrId - SCR ID (e.g., "SCR_XXXXXX")
   * @param {string} params.merkleRoot - 64-char hex merkle root
   * @param {string} params.mnemonic - BIP39 mnemonic for signing
   * @returns {Promise<Object>} { success, txid, assetName, details }
   */
  async issueAsset(params) {
    const { scrId, merkleRoot, mnemonic } = params;
    
    console.log('[NATIVE-ISSUER] ========================================');
    console.log('[NATIVE-ISSUER] ASSET ISSUANCE START');
    console.log('[NATIVE-ISSUER] ========================================');
    console.log(`[NATIVE-ISSUER] Asset: ${scrId}`);
    console.log(`[NATIVE-ISSUER] Merkle Root: ${merkleRoot}`);
    
    try {
      // =====================================================================
      // STEP 1: Connect to ElectrumX
      // =====================================================================
      await this.connect();
      console.log('[NATIVE-ISSUER] Step 1: Connected to ElectrumX');
      
      // =====================================================================
      // STEP 2: Check asset doesn't already exist
      // =====================================================================
      const exists = await this.electrumx.assetExists(scrId);
      if (exists) {
        throw new Error(`Asset ${scrId} already exists on chain`);
      }
      console.log('[NATIVE-ISSUER] Step 2: Asset name available');
      
      // =====================================================================
      // STEP 3: Get UTXOs
      // =====================================================================
      const balanceInfo = await this.getBalance(mnemonic);
      
      if (balanceInfo.utxos.length === 0) {
        throw new Error('No UTXOs found. Wallet may be empty or using different derivation path.');
      }
      
      // Check minimum balance
      const quote = await this.getFeeQuote();
      if (balanceInfo.total < quote.estimatedTotal) {
        throw new Error(
          `Insufficient balance. Need ~${quote.estimatedTotalRVN.toFixed(2)} RVN, ` +
          `have ${balanceInfo.totalRVN.toFixed(2)} RVN`
        );
      }
      console.log(`[NATIVE-ISSUER] Step 3: Found ${balanceInfo.utxos.length} UTXOs (${balanceInfo.totalRVN} RVN)`);
      
      // =====================================================================
      // STEP 4: Build and sign transaction
      // =====================================================================
      console.log('[NATIVE-ISSUER] Step 4: Building transaction...');
      
      const txResult = await buildAndSignAssetTx({
        assetName: scrId,
        merkleRoot: merkleRoot.toLowerCase(),
        mnemonic,
        utxos: balanceInfo.utxos,
        feeRate: quote.feeRate
      });
      
      console.log(`[NATIVE-ISSUER] Transaction built: ${txResult.txHex.length / 2} bytes`);
      console.log(`[NATIVE-ISSUER] Calculated TXID: ${txResult.txid}`);
      
      // =====================================================================
      // STEP 5: Broadcast transaction
      // =====================================================================
      console.log('[NATIVE-ISSUER] Step 5: Broadcasting...');
      
      const broadcastTxid = await this.electrumx.broadcastTransaction(txResult.txHex);
      
      console.log('[NATIVE-ISSUER] ========================================');
      console.log('[NATIVE-ISSUER] ASSET ISSUANCE COMPLETE');
      console.log('[NATIVE-ISSUER] ========================================');
      console.log(`[NATIVE-ISSUER] TXID: ${broadcastTxid}`);
      console.log(`[NATIVE-ISSUER] Asset: ${scrId}`);
      
      return {
        success: true,
        txid: broadcastTxid,
        assetName: scrId,
        merkleRoot,
        details: {
          ...txResult.details,
          broadcastTxid
        }
      };
      
    } catch (error) {
      console.error('[NATIVE-ISSUER] ========================================');
      console.error('[NATIVE-ISSUER] ASSET ISSUANCE FAILED');
      console.error('[NATIVE-ISSUER] ========================================');
      console.error(`[NATIVE-ISSUER] Error: ${error.message}`);
      
      return {
        success: false,
        error: error.message,
        assetName: scrId
      };
    }
  }

  /**
   * Verify a proof asset exists on chain with correct merkle root.
   * 
   * @param {string} scrId - Asset name to verify
   * @param {string} expectedMerkleRoot - Expected merkle root
   * @returns {Promise<Object>} Verification result
   */
  async verifyProof(scrId, expectedMerkleRoot) {
    await this.connect();
    
    try {
      const meta = await this.electrumx.getAssetMeta(scrId);
      
      if (!meta) {
        return {
          valid: false,
          exists: false,
          message: `Asset ${scrId} not found on chain`
        };
      }
      
      // The merkle root is stored in the ipfs_hash field
      const onChainData = meta.ipfs_hash || meta.data || null;
      
      if (!onChainData) {
        return {
          valid: false,
          exists: true,
          message: 'Asset exists but has no data field',
          meta
        };
      }
      
      const matches = onChainData.toLowerCase() === expectedMerkleRoot.toLowerCase();
      
      return {
        valid: matches,
        exists: true,
        onChainData,
        expectedMerkleRoot,
        message: matches ? 'Proof verified' : 'Merkle root mismatch',
        meta
      };
      
    } catch (error) {
      return {
        valid: false,
        error: error.message
      };
    }
  }

  /**
   * Get server connection info.
   * 
   * @returns {Promise<Object>} Server info
   */
  async getServerInfo() {
    await this.connect();
    return await this.electrumx.getServerInfo();
  }
}

// ============================================================================
// SINGLETON INSTANCE
// ============================================================================

// Export singleton for use across the application
const nativeIssuer = new NativeAssetIssuer();

// ============================================================================
// CONVENIENCE FUNCTIONS
// ============================================================================

/**
 * Issue a SCRUPLE proof asset (convenience function).
 * 
 * @param {string} scrId - Asset name
 * @param {string} merkleRoot - Merkle root hash
 * @param {string} mnemonic - Wallet mnemonic
 * @returns {Promise<Object>} Result
 */
async function issueProofAsset(scrId, merkleRoot, mnemonic) {
  return await nativeIssuer.issueAsset({ scrId, merkleRoot, mnemonic });
}

/**
 * Check if asset exists (convenience function).
 * 
 * @param {string} assetName - Asset name to check
 * @returns {Promise<boolean>}
 */
async function checkAssetExists(assetName) {
  return await nativeIssuer.assetExists(assetName);
}

/**
 * Get wallet balance (convenience function).
 * 
 * @param {string} mnemonic - Wallet mnemonic
 * @returns {Promise<Object>}
 */
async function getWalletBalance(mnemonic) {
  return await nativeIssuer.getBalance(mnemonic);
}

/**
 * Cleanup - disconnect from ElectrumX.
 */
async function cleanup() {
  await nativeIssuer.disconnect();
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  NativeAssetIssuer,
  nativeIssuer,
  
  // Convenience functions
  issueProofAsset,
  checkAssetExists,
  getWalletBalance,
  cleanup,
  
  // Re-export constants
  ASSET_CREATION_COST,
  DEFAULT_FEE_RATE
};
