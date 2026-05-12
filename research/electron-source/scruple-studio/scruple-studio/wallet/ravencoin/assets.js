/**
 * assets.js - Ravencoin Asset Operations
 * 
 * Creates root assets for SCRUPLE provenance anchoring.
 * Each lock creates a new root asset (500 RVN burn).
 * 
 * Asset naming: SCR_XXXXXX (derived from merkle root)
 * Data field: Full 64-char merkle root hash
 * 
 * SCRUPLE Studio V3 - AI Provenance Middleware
 * Patent Pending
 */

// Network cost for root asset creation (burned to network)
const ROOT_ASSET_BURN = 500;

class AssetManager {
  constructor() {
    // Stateless - all operations use wallet instance passed as param
  }

  /**
   * Create a SCRUPLE proof asset.
   * This is a ROOT asset (500 RVN burn), not a sub-asset.
   * 
   * @param {WalletManager} wallet - Unlocked wallet instance
   * @param {string} scrId - SCR ID (e.g., "SCR_35C9E2") - becomes asset name
   * @param {string} merkleRoot - 64-char hex merkle root hash
   * @returns {Object} { success, txid, assetName, merkleRoot }
   */
  async createProofAsset(wallet, scrId, merkleRoot) {
    try {
      // Validate SCR ID format (this becomes the asset name)
      if (!/^SCR_[A-F0-9]{6}$/.test(scrId)) {
        throw new Error('Invalid SCR ID format. Expected: SCR_XXXXXX');
      }

      // Validate merkle root format (64 hex chars = 32 bytes = SHA-256)
      if (!/^[0-9a-fA-F]{64}$/.test(merkleRoot)) {
        throw new Error('Invalid merkle root. Expected 64-character hex string.');
      }

      // Check balance (need 500 RVN burn + tx fee buffer)
      const balance = await wallet.getBalance();
      if (balance < ROOT_ASSET_BURN + 1) {
        throw new Error(`Insufficient balance. Need ~${ROOT_ASSET_BURN + 1} RVN, have ${balance.toFixed(2)} RVN`);
      }

      // Check if asset name already exists
      const exists = await this.assetExists(wallet, scrId);
      if (exists) {
        throw new Error(`Asset ${scrId} already exists on chain. This SCR ID has been used.`);
      }

      console.log(`[ASSETS] Creating proof asset: ${scrId}`);
      console.log(`[ASSETS] Merkle root: ${merkleRoot}`);
      console.log(`[ASSETS] Network burn: ${ROOT_ASSET_BURN} RVN`);

      const rvnWallet = wallet.getWalletInstance();
      const address = await rvnWallet.getReceiveAddress();
      
      console.log(`[ASSETS] Target address: ${address}`);

      // RPC: issue "asset_name" qty "to_address" "change_address" units reissuable has_ipfs "ipfs_hash"
      // Note: has_ipfs=true enables the data field, which accepts raw hex
      console.log(`[ASSETS] Calling RPC 'issue' with params:`, JSON.stringify([
        scrId, 1, address, '', 0, false, true, merkleRoot
      ], null, 2));

      let txid;
      try {
        txid = await wallet.rpc('issue', [
          scrId,               // asset_name (SCR_XXXXXX)
          1,                   // qty (1 unit)
          address,             // to_address (self)
          '',                  // change_address (auto)
          0,                   // units (0 = indivisible integer)
          false,               // reissuable (false = permanent, immutable)
          true,                // has_ipfs (true = has data field)
          merkleRoot           // data field (64-char merkle root)
        ]);
      } catch (rpcError) {
        // Detailed RPC error logging
        console.error('[ASSETS] RPC issue call failed!');
        console.error('[ASSETS] Error type:', typeof rpcError);
        console.error('[ASSETS] Error:', rpcError);
        console.error('[ASSETS] Error message:', rpcError?.message);
        console.error('[ASSETS] Error code:', rpcError?.code);
        console.error('[ASSETS] Error stringified:', JSON.stringify(rpcError, null, 2));
        
        // Try to extract meaningful error message
        const errorMsg = rpcError?.message 
          || rpcError?.error?.message 
          || rpcError?.error 
          || (typeof rpcError === 'string' ? rpcError : 'Unknown RPC error');
        
        throw new Error(`RPC issue failed: ${errorMsg}`);
      }

      // Check if txid is valid
      if (!txid || typeof txid !== 'string') {
        console.error('[ASSETS] Invalid txid returned:', txid);
        console.error('[ASSETS] txid type:', typeof txid);
        throw new Error(`Invalid transaction ID returned: ${JSON.stringify(txid)}`);
      }

      console.log(`[ASSETS] Proof asset created: ${txid}`);

      return {
        success: true,
        txid,
        assetName: scrId,
        merkleRoot,
        networkBurn: ROOT_ASSET_BURN
      };

    } catch (error) {
      // Comprehensive error logging
      console.error('[ASSETS] createProofAsset error:', error);
      console.error('[ASSETS] Error message:', error?.message);
      console.error('[ASSETS] Error stack:', error?.stack);
      
      const errorMsg = error?.message || String(error) || 'Unknown error';
      return { success: false, error: errorMsg };
    }
  }

  /**
   * Check if an asset name already exists on chain.
   * 
   * @param {WalletManager} wallet - Unlocked wallet instance
   * @param {string} assetName - Asset name to check
   * @returns {boolean} True if asset exists
   */
  async assetExists(wallet, assetName) {
    try {
      const data = await wallet.rpc('getassetdata', [assetName]);
      return data !== null && data !== undefined;
    } catch (e) {
      // RPC throws if asset doesn't exist
      return false;
    }
  }

  /**
   * Get asset data from chain.
   * 
   * @param {WalletManager} wallet - Unlocked wallet instance
   * @param {string} assetName - Asset name to look up
   * @returns {Object|null} Asset data or null
   */
  async getAssetData(wallet, assetName) {
    try {
      return await wallet.rpc('getassetdata', [assetName]);
    } catch (e) {
      return null;
    }
  }

  /**
   * Verify a proof by checking on-chain data matches expected merkle root.
   * 
   * @param {WalletManager} wallet - Unlocked wallet instance
   * @param {string} scrId - SCR ID (asset name)
   * @param {string} expectedMerkleRoot - Expected merkle root
   * @returns {Object} { valid, onChainData, message }
   */
  async verifyProof(wallet, scrId, expectedMerkleRoot) {
    try {
      const assetData = await this.getAssetData(wallet, scrId);
      
      if (!assetData) {
        return {
          valid: false,
          message: `Asset ${scrId} not found on chain`
        };
      }

      // The merkle root is stored in the ipfs_hash field
      const onChainHash = assetData.ipfs_hash || assetData.ipfsHash || null;
      
      if (!onChainHash) {
        return {
          valid: false,
          message: 'Asset exists but has no data field',
          onChainData: assetData
        };
      }

      const matches = onChainHash.toLowerCase() === expectedMerkleRoot.toLowerCase();
      
      return {
        valid: matches,
        onChainHash,
        expectedHash: expectedMerkleRoot,
        message: matches ? 'Proof verified' : 'Hash mismatch',
        onChainData: assetData
      };

    } catch (error) {
      return {
        valid: false,
        message: error.message
      };
    }
  }

  /**
   * Get cost breakdown for a lock operation.
   * 
   * @returns {Object} Cost info
   */
  getCosts() {
    return {
      networkBurn: {
        rvn: ROOT_ASSET_BURN,
        description: 'Burned to Ravencoin network for root asset creation'
      },
      note: 'Service fee is additional (calculated at lock time based on USD/RVN rate)'
    };
  }

  /**
   * Derive SCR ID from merkle root.
   * Format: SCR_ + first 6 chars of merkle root (uppercase)
   * 
   * @param {string} merkleRoot - 64-char hex merkle root
   * @returns {string} SCR ID (e.g., "SCR_35C9E2")
   */
  deriveScrId(merkleRoot) {
    if (!merkleRoot || merkleRoot.length < 6) {
      throw new Error('Invalid merkle root for SCR ID derivation');
    }
    return 'SCR_' + merkleRoot.substring(0, 6).toUpperCase();
  }

  /**
   * Validate a potential SCR ID format.
   * 
   * @param {string} scrId - SCR ID to validate
   * @returns {boolean} True if valid format
   */
  isValidScrId(scrId) {
    return /^SCR_[A-F0-9]{6}$/.test(scrId);
  }
}

module.exports = { 
  AssetManager, 
  ROOT_ASSET_BURN 
};
