/**
 * wallet.js - Ravencoin Wallet Manager
 * 
 * Handles key generation, encrypted storage, and wallet operations.
 * Uses @ravenrebels/ravencoin-jswallet for blockchain operations.
 * Wallet file encrypted with AES-256-GCM at rest.
 * 
 * SCRUPLE Studio V3 - AI Provenance Middleware
 * Patent Pending
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Will be loaded dynamically
let RavencoinWallet = null;
let bip39 = null;
let deriveKeyFromMnemonic = null;
let nativeIssuerGetBalance = null;

// Encryption parameters
const ENCRYPTION_ALGORITHM = 'aes-256-gcm';
const KEY_DERIVATION_ITERATIONS = 100000;
const SALT_LENGTH = 32;
const IV_LENGTH = 16;

// Default RPC endpoints
const DEFAULT_RPC_URL = 'https://rpc.ting.finance/rpc';
const TESTNET_RPC_URL = 'https://testnet-rpc.ting.finance/rpc';

class WalletManager {
  constructor(walletDir, options = {}) {
    this.walletDir = walletDir || 'C:\\Scruple\\wallet';
    this.walletPath = path.join(this.walletDir, 'wallet.json');
    this.network = options.network || 'rvn';  // 'rvn' or 'rvn-test'
    this.rpcUrl = options.rpcUrl || (this.network === 'rvn-test' ? TESTNET_RPC_URL : DEFAULT_RPC_URL);
    
    // In-memory state (cleared on lock)
    this.isUnlocked = false;
    this.rvnWallet = null;  // Legacy ravenrebels instance
    this.decryptedMnemonic = null;  // For ElectrumX operations
    
    // Cached address (safe to keep, it's public)
    this.cachedAddress = null;
    
    // Load dependencies
    this._loadDependencies();
  }

  /**
   * Load npm dependencies with graceful error handling.
   */
  _loadDependencies() {
    // Load asset-encoder for local address derivation
    try {
      const assetEncoder = require('./asset-encoder');
      deriveKeyFromMnemonic = assetEncoder.deriveKeyFromMnemonic;
      console.log('[WALLET] asset-encoder loaded');
    } catch (e) {
      try {
        const assetEncoder = require('../../asset-encoder');
        deriveKeyFromMnemonic = assetEncoder.deriveKeyFromMnemonic;
        console.log('[WALLET] asset-encoder loaded (relative)');
      } catch (e2) {
        console.error('[WALLET] asset-encoder not available');
      }
    }
    
    // Load native-issuer for ElectrumX balance
    try {
      const nativeIssuer = require('./native-issuer');
      nativeIssuerGetBalance = nativeIssuer.getWalletBalance;
      console.log('[WALLET] native-issuer loaded');
    } catch (e) {
      try {
        const nativeIssuer = require('../../native-issuer');
        nativeIssuerGetBalance = nativeIssuer.getWalletBalance;
        console.log('[WALLET] native-issuer loaded (relative)');
      } catch (e2) {
        console.error('[WALLET] native-issuer not available');
      }
    }
    
    // Load ravenrebels (optional legacy)
    try {
      RavencoinWallet = require('@ravenrebels/ravencoin-jswallet');
      console.log('[WALLET] ravenrebels loaded (optional)');
    } catch (e) {
      console.warn('[WALLET] ravenrebels not available');
    }

    try {
      bip39 = require('bip39');
      console.log('[WALLET] bip39 loaded');
    } catch (e) {
      console.error('[WALLET] bip39 not installed');
    }
  }

  /**
   * Check if dependencies are available.
   */
  _checkDependencies() {
    if (!deriveKeyFromMnemonic) {
      throw new Error('asset-encoder not available for address derivation');
    }
    if (!bip39) {
      throw new Error('bip39 not available');
    }
  }

  /**
   * Check if a wallet file exists.
   */
  walletExists() {
    return fs.existsSync(this.walletPath);
  }

  /**
   * Create a new wallet with a fresh mnemonic.
   * Returns the mnemonic for user backup (SHOW ONCE, NEVER STORE PLAINTEXT).
   * 
   * @param {string} password - Password to encrypt the wallet
   * @returns {Object} { success, address, mnemonic }
   */
  async createWallet(password) {
    this._checkDependencies();

    if (this.walletExists()) {
      throw new Error('Wallet already exists. Delete existing wallet first or import.');
    }

    if (!password || password.length < 8) {
      throw new Error('Password must be at least 8 characters');
    }

    // Generate 24-word mnemonic (256 bits of entropy)
    const mnemonic = bip39.generateMnemonic(256);
    
    // Derive address locally (no network needed)
    const keyInfo = deriveKeyFromMnemonic(mnemonic, 0);
    const address = keyInfo.address;

    // Encrypt and save wallet
    await this._saveEncryptedWallet(mnemonic, password, address);

    // Cache the address (public info, safe to keep)
    this.cachedAddress = address;

    console.log('[WALLET] Created new wallet: ' + address);

    return {
      success: true,
      address,
      mnemonic  // User must write this down! Never shown again.
    };
  }

  /**
   * Import an existing wallet from mnemonic.
   * 
   * @param {string} mnemonic - BIP39 mnemonic phrase (12 or 24 words)
   * @param {string} password - Password to encrypt the wallet
   * @returns {Object} { success, address }
   */
  async importWallet(mnemonic, password) {
    this._checkDependencies();

    if (this.walletExists()) {
      throw new Error('Wallet already exists. Delete existing wallet first.');
    }

    if (!password || password.length < 8) {
      throw new Error('Password must be at least 8 characters');
    }

    // Validate mnemonic
    if (!bip39.validateMnemonic(mnemonic)) {
      throw new Error('Invalid mnemonic phrase');
    }

    // Derive address locally (no network needed)
    const keyInfo = deriveKeyFromMnemonic(mnemonic, 0);
    const address = keyInfo.address;

    // Encrypt and save wallet
    await this._saveEncryptedWallet(mnemonic, password, address);

    // Cache the address
    this.cachedAddress = address;

    console.log('[WALLET] Imported wallet: ' + address);

    return {
      success: true,
      address
    };
  }

  /**
   * Encrypt and save wallet to file.
   * 
   * Wallet file format:
   * {
   *   version: "2.0",
   *   address: "R...",           // Public, for display
   *   network: "rvn",            // Network type
   *   encrypted: {
   *     salt: "hex...",
   *     iv: "hex...",
   *     authTag: "hex...",
   *     ciphertext: "hex..."     // Encrypted mnemonic
   *   },
   *   created: "ISO date"
   * }
   */
  async _saveEncryptedWallet(mnemonic, password, address) {
    // Ensure directory exists
    fs.mkdirSync(this.walletDir, { recursive: true });

    // Generate random salt and IV
    const salt = crypto.randomBytes(SALT_LENGTH);
    const iv = crypto.randomBytes(IV_LENGTH);

    // Derive encryption key from password using PBKDF2
    const key = crypto.pbkdf2Sync(
      password,
      salt,
      KEY_DERIVATION_ITERATIONS,
      32,  // 256 bits for AES-256
      'sha512'
    );

    // Encrypt the mnemonic
    const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
    let ciphertext = cipher.update(mnemonic, 'utf8', 'hex');
    ciphertext += cipher.final('hex');
    const authTag = cipher.getAuthTag();

    // Build wallet file
    const walletData = {
      version: '2.0',
      address,
      network: this.network,
      encrypted: {
        salt: salt.toString('hex'),
        iv: iv.toString('hex'),
        authTag: authTag.toString('hex'),
        ciphertext
      },
      created: new Date().toISOString()
    };

    // Write atomically (write to temp, then rename)
    const tempPath = this.walletPath + '.tmp';
    fs.writeFileSync(tempPath, JSON.stringify(walletData, null, 2), 'utf8');
    fs.renameSync(tempPath, this.walletPath);

    console.log('[WALLET] Saved encrypted wallet to: ' + this.walletPath);
  }

  /**
   * Unlock wallet with password.
   * Decrypts mnemonic, creates wallet instance, holds in memory.
   * 
   * @param {string} password - Wallet password
   * @returns {Object} { success, address }
   */
  async unlockWallet(password) {
    this._checkDependencies();

    if (!this.walletExists()) {
      throw new Error('No wallet found. Create or import a wallet first.');
    }

    if (this.isUnlocked && this.rvnWallet) {
      const address = await this.rvnWallet.getReceiveAddress();
      return { success: true, address, alreadyUnlocked: true };
    }

    // Read wallet file
    const walletData = JSON.parse(fs.readFileSync(this.walletPath, 'utf8'));

    // Decrypt mnemonic
    const { salt, iv, authTag, ciphertext } = walletData.encrypted;

    // Derive key from password
    const key = crypto.pbkdf2Sync(
      password,
      Buffer.from(salt, 'hex'),
      KEY_DERIVATION_ITERATIONS,
      32,
      'sha512'
    );

    // Decrypt
    try {
      console.log('[WALLET] Step 1: Creating decipher...');
      const decipher = crypto.createDecipheriv(
        ENCRYPTION_ALGORITHM,
        key,
        Buffer.from(iv, 'hex')
      );
      decipher.setAuthTag(Buffer.from(authTag, 'hex'));
      
      console.log('[WALLET] Step 2: Decrypting mnemonic...');
      let mnemonic = decipher.update(ciphertext, 'hex', 'utf8');
      mnemonic += decipher.final('utf8');
      console.log('[WALLET] Step 2 complete: Mnemonic decrypted (length: ' + mnemonic.split(' ').length + ' words)');

      // Derive address locally (no network needed)
      console.log('[WALLET] Step 3: Deriving address locally...');
      const keyInfo = deriveKeyFromMnemonic(mnemonic, 0);
      const address = keyInfo.address;
      console.log('[WALLET] Step 3 complete: Address derived');

      // Store state
      this.decryptedMnemonic = mnemonic;
      this.cachedAddress = address;
      this.isUnlocked = true;

      console.log('[WALLET] Unlocked: ' + address);

      return { success: true, address };

    } catch (error) {
      console.error('[WALLET] Unlock error:', error);
      console.error('[WALLET] Error type:', typeof error);
      console.error('[WALLET] Error name:', error?.name);
      console.error('[WALLET] Error message:', error?.message);
      console.error('[WALLET] Error stack:', error?.stack);
      
      // Check if it's an RPC/network error (object with status/statusText)
      if (error?.status || error?.statusText) {
        throw new Error('RPC connection failed: ' + (error.statusText || 'Network error') + ' (Status: ' + error.status + ')');
      }
      
      const errMsg = error?.message || String(error) || 'Unknown error';
      if (errMsg.includes('Unsupported state') || 
          errMsg.includes('authentication')) {
        throw new Error('Incorrect password');
      }
      throw new Error(errMsg);
    }
  }

  /**
   * Lock wallet - clear sensitive data from memory.
   */
  lockWallet() {
    this.rvnWallet = null;
    this.decryptedMnemonic = null;
    this.isUnlocked = false;
    
    // Keep cached address (it's public)
    console.log('[WALLET] Locked');
    
    return { success: true };
  }

  /**
   * Get the wallet's receive address.
   * Can be called without unlocking (reads from file or cache).
   * 
   * @returns {string|null} Ravencoin address starting with 'R'
   */
  getAddress() {
    // Return cached if available
    if (this.cachedAddress) {
      return this.cachedAddress;
    }

    // Try to read from wallet file
    if (this.walletExists()) {
      try {
        const walletData = JSON.parse(fs.readFileSync(this.walletPath, 'utf8'));
        this.cachedAddress = walletData.address;
        return this.cachedAddress;
      } catch (e) {
        console.error('[WALLET] Failed to read address from wallet file');
      }
    }

    return null;
  }

  /**
   * Get the underlying ravenrebels wallet instance.
   * Wallet must be unlocked.
   * 
   * @returns {Object} RavencoinWallet instance
   */
  getWalletInstance() {
    if (!this.isUnlocked || !this.rvnWallet) {
      throw new Error('Wallet is locked. Unlock first.');
    }
    return this.rvnWallet;
  }

  /**
   * Get RVN balance.
   * Wallet must be unlocked.
   * 
   * @returns {number} Balance in RVN
   */
  async getBalance() {
    if (!this.isUnlocked || !this.decryptedMnemonic) {
      throw new Error('Wallet is locked. Unlock first.');
    }
    
    // Use ElectrumX via native-issuer
    if (nativeIssuerGetBalance) {
      const balanceInfo = await nativeIssuerGetBalance(this.decryptedMnemonic);
      return {
        confirmed: balanceInfo.total,
        confirmedRVN: balanceInfo.totalRVN,
        unconfirmed: 0,
        utxoCount: balanceInfo.utxos.length
      };
    }
    
    throw new Error('Balance query not available (native-issuer not loaded)');
  }

  /**
   * Get the decrypted mnemonic for ElectrumX operations.
   * Wallet must be unlocked.
   * WARNING: Handle with care - this is sensitive data.
   * 
   * @returns {string} BIP39 mnemonic
   */
  getMnemonic() {
    if (!this.isUnlocked || !this.decryptedMnemonic) {
      throw new Error('Wallet is locked. Unlock first.');
    }
    return this.decryptedMnemonic;
  }

  /**
   * Get assets held by wallet.
   * Wallet must be unlocked.
   * 
   * @returns {Array} List of assets
   */
  async getAssets() {
    // TODO: Implement via ElectrumX
    if (!this.isUnlocked || !this.rvnWallet) {
      throw new Error('Wallet is locked. Unlock first.');
    }
    return await this.rvnWallet.getAssets();
  }

  /**
   * Send RVN or assets.
   * Wallet must be unlocked.
   * TODO: Implement via ElectrumX
   * 
   * @param {Object} params - { toAddress, amount, assetName? }
   * @returns {Object} { transactionId }
   */
  async send(params) {
    // TODO: Implement via ElectrumX
    if (!this.isUnlocked || !this.rvnWallet) {
      throw new Error('Wallet is locked. Unlock first.');
    }
    return await this.rvnWallet.send(params);
  }

  /**
   * Execute raw RPC call.
   * Wallet must be unlocked.
   * 
   * @param {string} method - RPC method name
   * @param {Array} params - RPC parameters
   * @returns {*} RPC result
   */
  async rpc(method, params = []) {
    if (!this.isUnlocked || !this.rvnWallet) {
      throw new Error('Wallet is locked. Unlock first.');
    }
    return await this.rvnWallet.rpc(method, params);
  }

  /**
   * Delete wallet file.
   * DANGEROUS - requires confirmation.
   * 
   * @param {string} confirmation - Must be "DELETE MY WALLET"
   */
  deleteWallet(confirmation) {
    if (confirmation !== 'DELETE MY WALLET') {
      throw new Error('Confirmation string incorrect. Wallet not deleted.');
    }

    if (this.walletExists()) {
      // Lock first
      this.lockWallet();
      
      // Delete file
      fs.unlinkSync(this.walletPath);
      
      // Clear cache
      this.cachedAddress = null;
      
      console.log('[WALLET] Deleted wallet file');
      
      return { success: true };
    }

    return { success: false, error: 'No wallet file found' };
  }

  /**
   * Get wallet status for UI display.
   * 
   * @returns {Object} Wallet status info
   */
  getStatus() {
    const exists = this.walletExists();
    
    return {
      exists,
      isUnlocked: this.isUnlocked,
      address: this.getAddress(),
      walletPath: this.walletPath,
      network: this.network,
      rpcUrl: this.rpcUrl
    };
  }

  /**
   * Verify a password without fully unlocking.
   * Useful for confirming user identity before sensitive ops.
   * 
   * @param {string} password - Password to verify
   * @returns {boolean} True if password is correct
   */
  async verifyPassword(password) {
    if (!this.walletExists()) {
      return false;
    }

    try {
      const walletData = JSON.parse(fs.readFileSync(this.walletPath, 'utf8'));
      const { salt, iv, authTag, ciphertext } = walletData.encrypted;

      const key = crypto.pbkdf2Sync(
        password,
        Buffer.from(salt, 'hex'),
        KEY_DERIVATION_ITERATIONS,
        32,
        'sha512'
      );

      const decipher = crypto.createDecipheriv(
        ENCRYPTION_ALGORITHM,
        key,
        Buffer.from(iv, 'hex')
      );
      decipher.setAuthTag(Buffer.from(authTag, 'hex'));
      
      decipher.update(ciphertext, 'hex', 'utf8');
      decipher.final('utf8');
      
      return true;
    } catch (e) {
      return false;
    }
  }
}

module.exports = { WalletManager };
