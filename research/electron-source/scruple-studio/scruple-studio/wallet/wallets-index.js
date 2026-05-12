/**
 * wallets-index.js - Wallets Module Aggregator
 * 
 * Aggregates all wallet/blockchain modules:
 * - RVN: Ravencoin wallet + native asset issuer
 * - IPFS: Distributed storage via Pinata/Infura/local
 * - Arweave: Permanent storage
 * 
 * SCRUPLE Studio V3 - AI Provenance Middleware
 * Patent Pending
 */

// RVN wallet modules
const { WalletManager } = require('./rvn/wallet');
const { AssetManager, ROOT_ASSET_BURN } = require('./rvn/assets');
const { PriceManager, FALLBACK_PRICE_USD } = require('./rvn/price');

// RVN native issuer (ElectrumX-based, no RPC dependency)
const { 
  nativeIssuer, 
  issueProofAsset, 
  checkAssetExists, 
  getWalletBalance,
  ASSET_CREATION_COST 
} = require('./rvn/native-issuer');

// IPFS modules
const { IPFSConfigManager } = require('./ipfs/ipfs-config');
const { IPFSPinner } = require('./ipfs/ipfs-pinner');

// Arweave module
// Note: ArweaveManager uses Electron's app.getPath() in constructor,
// so we export the class for Electron contexts, not an instance
const ArweaveManager = require('./arweave/arweave-index');

module.exports = {
  // ==========================================================================
  // RVN EXPORTS
  // ==========================================================================
  
  // Wallet management (ravenrebels-based)
  WalletManager,
  
  // Asset management (legacy RPC-based - kept for compatibility)
  AssetManager,
  ROOT_ASSET_BURN,
  
  // Price management
  PriceManager,
  FALLBACK_PRICE_USD,
  
  // Native asset issuer (ElectrumX-based - preferred)
  nativeIssuer,
  issueProofAsset,
  checkAssetExists,
  getWalletBalance,
  ASSET_CREATION_COST,
  
  // ==========================================================================
  // IPFS EXPORTS
  // ==========================================================================
  
  // Configuration manager
  IPFSConfigManager,
  
  // Pinning service
  IPFSPinner,
  
  // ==========================================================================
  // ARWEAVE EXPORTS
  // ==========================================================================
  
  // Arweave manager (singleton instance, requires Electron)
  ArweaveManager
};
