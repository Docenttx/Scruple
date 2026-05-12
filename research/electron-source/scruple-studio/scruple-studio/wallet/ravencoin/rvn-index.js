/**
 * rvn-index.js - RVN Module Exports
 * 
 * Aggregates Ravencoin wallet functionality:
 * - WalletManager: Key generation, encryption, signing
 * - AssetManager: Proof asset creation and verification
 * - PriceManager: USD/RVN conversion via CoinGecko
 * 
 * SCRUPLE Studio V3 - AI Provenance Middleware
 * Patent Pending
 */

const { WalletManager } = require('./wallet');
const { AssetManager, ROOT_ASSET_BURN } = require('./assets');
const { PriceManager, FALLBACK_PRICE_USD } = require('./price');

module.exports = {
  WalletManager,
  AssetManager,
  PriceManager,
  ROOT_ASSET_BURN,
  FALLBACK_PRICE_USD
};
