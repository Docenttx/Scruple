/**
 * arweave-index-testnet.js - Arweave Testnet Wallet Manager
 *
 * Points to arlocal running on Oracle VM (129.80.23.93:1984).
 * No real AR required — fund test wallets via mint endpoint.
 *
 * SCRUPLE Studio V3 - AI Provenance Middleware
 * Patent Pending
 */

const Arweave = require('arweave');
const fs = require('fs');
const path = require('path');

// Try to get Electron app, but don't crash if not available
let electronApp = null;
try {
  electronApp = require('electron').app;
} catch (e) {
  // Not in Electron context, that's fine
}

// Initialize Arweave connection to arlocal on Oracle VM
// Use explicit api config to avoid native fetch issues in Electron main process
const arweave = Arweave.init({
  host: '129.80.23.93',
  port: 1984,
  protocol: 'http',
  timeout: 10000,
  logging: false
});

// Override fetch with Node.js http module for plain HTTP connections
// Electron v29 native fetch blocks non-HTTPS to external IPs
const http = require('http');
function arlocalFetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method: options.method || 'GET',
      headers: options.headers || {}
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          json: () => Promise.resolve(JSON.parse(data)),
          text: () => Promise.resolve(data)
        });
      });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}
// Patch the arweave instance to use our http-based fetch
if (arweave.api && arweave.api.config) {
  arweave.api.config.fetch = arlocalFetch;
}

class ArweaveManager {
  constructor(configDir = null) {
    // Determine config directory
    if (configDir) {
      this.configDir = configDir;
    } else if (electronApp) {
      this.configDir = electronApp.getPath('userData');
    } else {
      // Fallback for non-Electron: use current directory or SCRUPLE home
      this.configDir = process.env.SCRUPLE_HOME || 'C:\\Scruple';
    }
    
    this.wallet = null;      // The JWK object (in memory only when loaded)
    this.address = null;
    this.keyfilePath = null; // Path to stored encrypted keyfile
    
    // Check for existing wallet
    this._loadExistingWallet();
  }

  /**
   * Check for existing wallet on disk
   */
  _loadExistingWallet() {
    try {
      const walletFile = path.join(this.configDir, 'arweave-wallet.json');
      if (fs.existsSync(walletFile)) {
        const data = JSON.parse(fs.readFileSync(walletFile, 'utf8'));
        this.address = data.address;
        this.keyfilePath = data.keyfilePath;
        console.log('[ARWEAVE] Found existing wallet reference:', this.address);
      }
    } catch (e) {
      console.log('[ARWEAVE] No existing wallet found');
    }
  }

  /**
   * Load wallet from a JWK JSON keyfile
   * 
   * @param {string} filePath - Path to the JWK keyfile
   * @returns {Object} { success, address, balance }
   */
  async loadWallet(filePath) {
    try {
      // If no file path is provided, try loading the saved one
      if (!filePath) {
        return this.loadSavedWallet();
      }

      // Read and parse keyfile
      const raw = fs.readFileSync(filePath, 'utf8');
      const jwk = JSON.parse(raw);
      
      // Validate it's a proper JWK
      if (!jwk.n || !jwk.e || !jwk.d) {
        throw new Error('Invalid Arweave keyfile format');
      }
      
      // Get address from key
      const address = await arweave.wallets.jwkToAddress(jwk);
      
      // Store reference (NOT the actual key for security)
      this.wallet = jwk;
      this.address = address;
      this.keyfilePath = filePath;
      
      // Save wallet info (address + path, not the key itself)
      const walletFile = path.join(this.configDir, 'arweave-wallet.json');
      fs.mkdirSync(this.configDir, { recursive: true });
      fs.writeFileSync(walletFile, JSON.stringify({
        address,
        keyfilePath: filePath,
        importedAt: new Date().toISOString()
      }, null, 2));
      
      // Get balance
      const balance = await this.getBalance();
      
      console.log('[ARWEAVE] Wallet loaded:', address);
      
      return { success: true, address, balance };
    } catch (error) {
      console.error('[ARWEAVE] Load failed:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Load wallet from previously imported keyfile (Internal use)
   * 
   * @returns {Object} { success, address }
   */
  async loadSavedWallet() {
    try {
      if (!this.keyfilePath) {
        return { success: false, error: 'No wallet imported' };
      }
      
      if (!fs.existsSync(this.keyfilePath)) {
        return { success: false, error: 'Keyfile not found at: ' + this.keyfilePath };
      }
      
      const raw = fs.readFileSync(this.keyfilePath, 'utf8');
      const jwk = JSON.parse(raw);
      
      this.wallet = jwk;
      this.address = await arweave.wallets.jwkToAddress(jwk);
      
      return { success: true, address: this.address };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Get balance for current wallet
   * 
   * @returns {number} Balance in AR
   */
  async getBalance() {
    if (!this.address) return 0;
    try {
      const winston = await arweave.wallets.getBalance(this.address);
      const ar = arweave.ar.winstonToAr(winston);
      return parseFloat(ar);
    } catch (e) {
      console.warn('[ARWEAVE-TESTNET] Balance fetch failed (arlocal may have reset):', e.message);
      return 0;
    }
  }

/**
   * Get balance with network status — testnet version.
   * Returns success:true as long as address exists, even if arlocal balance fetch fails.
   * arlocal resets on restart so balance fetch failure is expected and normal.
   */
  async getBalanceWithStatus() {
    if (!this.address) return { success: false, balance: 0 };
    try {
      const winston = await arweave.wallets.getBalance(this.address);
      const ar = arweave.ar.winstonToAr(winston);
      return { success: true, balance: parseFloat(ar) };
    } catch (e) {
      console.warn('[ARWEAVE-TESTNET] Balance fetch failed (arlocal may have reset):', e.message);
      // Wallet still exists — arlocal just needs minting. Don't mark as disconnected.
      return { success: true, balance: 0 };
    }
  }
  
  /**
   * Get current wallet address
   * 
   * @returns {string|null}
   */
  getAddress() {
    return this.address;
  }

  /**
   * Check if wallet exists
   * 
   * @returns {boolean}
   */
  exists() {
    return !!this.address;
  }

  /**
   * Check if wallet is loaded (key in memory)
   * 
   * @returns {boolean}
   */
  isLoaded() {
    return !!this.wallet;
  }

  /**
   * Mint fake AR to a testnet wallet via arlocal endpoint.
   * Only available on arlocal — not on mainnet.
   *
   * @param {string} address - Wallet address to fund
   * @param {number} winstonAmount - Amount in winston (1 AR = 1e12 winston)
   * @returns {Promise<Object>} { success }
   */
  async mintTestAr(address, winstonAmount = 1e12) {
    try {
      const http = require('http');
      return new Promise((resolve) => {
        const req = http.get(
          `http://129.80.23.93:1984/mint/${address}/${winstonAmount}`,
          (res) => {
            resolve({ success: res.statusCode === 200 });
          }
        );
        req.on('error', (e) => resolve({ success: false, error: e.message }));
      });
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Get wallet status (testnet version — always marks as testnet)
   */
  async getStatus() {
    if (!this.address) {
      return { exists: false, connected: false, testnet: true };
    }
    const balance = await this.getBalance();
    return {
      exists: true,
      connected: true,
      address: this.address,
      balance,
      keyfilePath: this.keyfilePath,
      testnet: true,
      gateway: 'http://129.80.23.93:1984'
    };
  }

  /**
   * Disconnect/remove wallet
   * 
   * @returns {Object} { success }
   */
  disconnect() {
    try {
      // Clear in-memory data
      this.wallet = null;
      this.address = null;
      this.keyfilePath = null;
      
      // Remove stored wallet info
      const walletFile = path.join(this.configDir, 'arweave-wallet.json');
      if (fs.existsSync(walletFile)) {
        fs.unlinkSync(walletFile);
      }
      
      console.log('[ARWEAVE] Wallet disconnected');
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Sign and submit a data transaction
   * 
   * @param {Buffer|string} data - Data to upload
   * @param {Object} tags - Key-value tags
   * @returns {Object} { success, txId }
   */
  async uploadData(data, tags = {}) {
    try {
      if (!this.wallet) {
        // Try to load wallet
        const loaded = await this.loadSavedWallet();
        if (!loaded.success) {
          throw new Error('Wallet not loaded');
        }
      }
      
      // Create transaction
      const tx = await arweave.createTransaction({ data }, this.wallet);
      
      // Add tags
      for (const [key, value] of Object.entries(tags)) {
        tx.addTag(key, String(value));
      }
      
      // Sign
      await arweave.transactions.sign(tx, this.wallet);
      
      // Submit
      const response = await arweave.transactions.post(tx);
      
      if (response.status === 200 || response.status === 202) {
        console.log('[ARWEAVE] Transaction submitted:', tx.id);
        return { 
          success: true, 
          txId: tx.id,
          reward: arweave.ar.winstonToAr(tx.reward)
        };
      } else {
        throw new Error('Transaction failed: ' + response.status);
      }
    } catch (error) {
      console.error('[ARWEAVE] Upload failed:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Upload a SCRUPLE proof record
   * 
   * @param {string} scrId - SCR ID
   * @param {string} merkleRoot - Merkle root hash
   * @param {Object} proofData - Additional proof data
   * @returns {Object} { success, txId }
   */
  async uploadProofRecord(scrId, merkleRoot, proofData = {}) {
    const record = JSON.stringify({
      scrId,
      merkleRoot,
      timestamp: new Date().toISOString(),
      source: 'SCRUPLE Studio V3',
      version: '3.0',
      type: 'proof-record',
      ...proofData
    }, null, 2);

    const tags = {
      'Content-Type': 'application/json',
      'App-Name': 'SCRUPLE-Studio',
      'App-Version': '3.0',
      'SCR-ID': scrId,
      'Type': 'proof-record'
    };

    return this.uploadData(record, tags);
  }

  /**
   * Get transaction status
   * 
   * @param {string} txId
   * @returns {Object}
   */
  async getTransactionStatus(txId) {
    try {
      const status = await arweave.transactions.getStatus(txId);
      return status;
    } catch (error) {
      return { error: error.message };
    }
  }

  /**
   * Get data URL for a transaction
   * 
   * @param {string} txId
   * @returns {string}
   */
  getDataUrl(txId) {
    return `http://129.80.23.93:1984/${txId}`;
  }
}

// Export class for flexibility (caller can instantiate with custom configDir)
// Also export a default instance for Electron contexts
module.exports = ArweaveManager;
module.exports.ArweaveManager = ArweaveManager;

// Create singleton instance only in Electron context
if (electronApp) {
  module.exports.arweaveManager = new ArweaveManager();
}
