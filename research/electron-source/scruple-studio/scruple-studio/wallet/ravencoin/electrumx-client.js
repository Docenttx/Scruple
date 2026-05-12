/**
 * electrumx-client.js - ElectrumX Client for Ravencoin
 * 
 * Provides connection to ElectrumX servers for UTXO queries,
 * asset existence checks, and transaction broadcasting.
 * Implements server failover for reliability.
 * 
 * SCRUPLE Studio V3 - AI Provenance Middleware
 * Patent Pending
 */

const ElectrumClient = require('electrum-client');
const crypto = require('crypto');

// ============================================================================
// CONFIGURATION
// ============================================================================

// ElectrumX servers with failover (SSL on port 50002)
const ELECTRUMX_SERVERS = [
  { host: 'rvn4lyfe.com', port: 50002, protocol: 'ssl' },
  { host: 'electrum1.rvn.rocks', port: 50002, protocol: 'ssl' },
  { host: 'electrum2.rvn.rocks', port: 50002, protocol: 'ssl' }
];

// Protocol version
const PROTOCOL_VERSION = '1.4.2';
const CLIENT_NAME = 'scruple-studio';

// Connection settings
const CONNECTION_TIMEOUT = 10000; // 10 seconds
const REQUEST_TIMEOUT = 30000;    // 30 seconds for broadcasts

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Convert Ravencoin address to ElectrumX scripthash format.
 * 
 * ElectrumX uses reversed SHA256 of the scriptPubKey.
 * 
 * @param {string} address - Ravencoin address (starts with 'R')
 * @returns {string} Scripthash in hex
 */
function addressToScripthash(address) {
  // Dynamically require bs58 to handle both ESM and CJS
  let bs58;
  try {
    bs58 = require('bs58');
    if (bs58.default) bs58 = bs58.default;
  } catch (e) {
    throw new Error('bs58 not installed. Run: npm install bs58');
  }

  // Decode base58check address
  const decoded = bs58.decode(address);
  
  // Remove version byte (first) and checksum (last 4)
  // Ravencoin mainnet P2PKH version byte is 0x3c (60)
  const pubkeyHash = decoded.slice(1, 21);
  
  // Build P2PKH scriptPubKey:
  // OP_DUP OP_HASH160 <20-byte-hash> OP_EQUALVERIFY OP_CHECKSIG
  const script = Buffer.concat([
    Buffer.from([0x76]),       // OP_DUP
    Buffer.from([0xa9]),       // OP_HASH160
    Buffer.from([0x14]),       // Push 20 bytes
    pubkeyHash,
    Buffer.from([0x88]),       // OP_EQUALVERIFY
    Buffer.from([0xac])        // OP_CHECKSIG
  ]);
  
  // SHA256 hash, then reverse for ElectrumX format
  const hash = crypto.createHash('sha256').update(script).digest();
  return hash.reverse().toString('hex');
}

/**
 * Create P2PKH scriptPubKey from address.
 * 
 * @param {string} address - Ravencoin address
 * @returns {Buffer} scriptPubKey
 */
function addressToScriptPubKey(address) {
  let bs58;
  try {
    bs58 = require('bs58');
    if (bs58.default) bs58 = bs58.default;
  } catch (e) {
    throw new Error('bs58 not installed');
  }

  const decoded = bs58.decode(address);
  const pubkeyHash = decoded.slice(1, 21);
  
  return Buffer.concat([
    Buffer.from([0x76, 0xa9, 0x14]),
    pubkeyHash,
    Buffer.from([0x88, 0xac])
  ]);
}

// ============================================================================
// ELECTRUMX CLIENT CLASS
// ============================================================================

class ElectrumXClient {
  constructor() {
    this.client = null;
    this.connected = false;
    this.currentServer = null;
    this.serverIndex = 0;
  }

  /**
   * Connect to an ElectrumX server with failover.
   * 
   * @returns {Promise<boolean>} True if connected
   */
  async connect() {
    // Try each server in order
    for (let i = 0; i < ELECTRUMX_SERVERS.length; i++) {
      const serverIndex = (this.serverIndex + i) % ELECTRUMX_SERVERS.length;
      const server = ELECTRUMX_SERVERS[serverIndex];
      
      try {
        console.log(`[ELECTRUMX] Trying ${server.host}:${server.port}...`);
        
        this.client = new ElectrumClient(server.port, server.host, server.protocol);
        
        // Connect with timeout
        await Promise.race([
          this.client.connect(CLIENT_NAME, PROTOCOL_VERSION),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Connection timeout')), CONNECTION_TIMEOUT)
          )
        ]);
        
        // Verify connection with version handshake
        await this.client.server_version(CLIENT_NAME, PROTOCOL_VERSION);
        
        this.connected = true;
        this.currentServer = server;
        this.serverIndex = serverIndex;
        
        console.log(`[ELECTRUMX] Connected to ${server.host}`);
        return true;
        
      } catch (error) {
        console.log(`[ELECTRUMX] Failed to connect to ${server.host}: ${error.message}`);
        if (this.client) {
          try { await this.client.close(); } catch (e) {}
        }
        this.client = null;
      }
    }
    
    this.connected = false;
    throw new Error('Failed to connect to any ElectrumX server');
  }

  /**
   * Ensure connection is active, reconnect if needed.
   */
  async ensureConnected() {
    if (!this.connected || !this.client) {
      await this.connect();
    }
  }

  /**
   * Close the connection.
   */
  async close() {
    if (this.client) {
      try {
        await this.client.close();
      } catch (e) {
        // Ignore close errors
      }
      this.client = null;
      this.connected = false;
      console.log('[ELECTRUMX] Connection closed');
    }
  }

  /**
   * Get current block height.
   * 
   * @returns {Promise<number>} Block height
   */
  async getBlockHeight() {
    await this.ensureConnected();
    const header = await this.client.blockchainHeaders_subscribe();
    return header.height;
  }

  /**
   * Get UTXOs for an address.
   * 
   * @param {string} address - Ravencoin address
   * @returns {Promise<Array>} Array of UTXOs
   */
  async getUTXOs(address) {
    await this.ensureConnected();
    
    const scripthash = addressToScripthash(address);
    const utxos = await this.client.blockchainScripthash_listunspent(scripthash);
    
    console.log(`[ELECTRUMX] Found ${utxos.length} UTXOs for ${address}`);
    
    // Return with address info added
    return utxos.map(utxo => ({
      txid: utxo.tx_hash,
      vout: utxo.tx_pos,
      value: utxo.value, // in satoshis
      height: utxo.height,
      address: address,
      scripthash: scripthash
    }));
  }

  /**
   * Get UTXOs for multiple addresses.
   * Useful when wallet has funds scattered across derivation paths.
   * 
   * @param {string[]} addresses - Array of Ravencoin addresses
   * @returns {Promise<Array>} Combined array of UTXOs
   */
  async getUTXOsMultiple(addresses) {
    const allUtxos = [];
    
    for (const address of addresses) {
      const utxos = await this.getUTXOs(address);
      allUtxos.push(...utxos);
    }
    
    // Sort by value descending (prefer larger UTXOs first)
    allUtxos.sort((a, b) => b.value - a.value);
    
    return allUtxos;
  }

  /**
   * Get balance for an address (in satoshis).
   * 
   * @param {string} address - Ravencoin address
   * @returns {Promise<number>} Balance in satoshis
   */
  async getBalance(address) {
    const utxos = await this.getUTXOs(address);
    return utxos.reduce((sum, utxo) => sum + utxo.value, 0);
  }

  /**
   * Get raw transaction hex.
   * 
   * @param {string} txid - Transaction ID
   * @returns {Promise<string>} Raw transaction hex
   */
  async getRawTransaction(txid) {
    await this.ensureConnected();
    return await this.client.blockchainTransaction_get(txid);
  }

  /**
   * Check if an asset name exists on chain.
   * 
   * @param {string} assetName - Asset name to check (e.g., "SCR_XXXXXX")
   * @returns {Promise<boolean>} True if asset exists
   */
  async assetExists(assetName) {
    await this.ensureConnected();
    
    try {
      const result = await this.client.request('blockchain.asset.get_meta', [assetName]);
      if (result && Object.keys(result).length > 0) {
        console.log(`[ELECTRUMX] Asset ${assetName} EXISTS`);
        return true;
      }
      return false;
    } catch (error) {
      // "unknown" or "not found" means asset doesn't exist
      if (error.message.includes('not found') || 
          error.message.includes('unknown') ||
          error.message.includes('null')) {
        console.log(`[ELECTRUMX] Asset ${assetName} does NOT exist (available)`);
        return false;
      }
      // Re-throw unexpected errors
      throw error;
    }
  }

  /**
   * Get asset metadata.
   * 
   * @param {string} assetName - Asset name
   * @returns {Promise<Object|null>} Asset metadata or null
   */
  async getAssetMeta(assetName) {
    await this.ensureConnected();
    
    try {
      const result = await this.client.request('blockchain.asset.get_meta', [assetName]);
      return result;
    } catch (error) {
      return null;
    }
  }

  /**
   * Broadcast a signed transaction.
   * 
   * @param {string} txHex - Signed transaction in hex
   * @returns {Promise<string>} Transaction ID if successful
   */
  async broadcastTransaction(txHex) {
    await this.ensureConnected();
    
    console.log(`[ELECTRUMX] Broadcasting transaction (${txHex.length / 2} bytes)...`);
    
    try {
      const txid = await Promise.race([
        this.client.blockchainTransaction_broadcast(txHex),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Broadcast timeout')), REQUEST_TIMEOUT)
        )
      ]);
      
      console.log(`[ELECTRUMX] Broadcast successful: ${txid}`);
      return txid;
      
    } catch (error) {
      console.error(`[ELECTRUMX] Broadcast failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get estimated fee rate (satoshis per byte).
   * Ravencoin typically uses 1000 sat/byte minimum.
   * 
   * @param {number} blocks - Target confirmation blocks
   * @returns {Promise<number>} Fee rate in satoshis per byte
   */
  async estimateFee(blocks = 6) {
    await this.ensureConnected();
    
    try {
      // ElectrumX returns fee in RVN per KB
      const feePerKb = await this.client.blockchainEstimatefee(blocks);
      
      if (feePerKb <= 0) {
        // Use default minimum
        return 1000; // sat/byte (standard RVN minimum)
      }
      
      // Convert RVN/KB to sat/byte
      const satPerByte = Math.ceil((feePerKb * 1e8) / 1000);
      return Math.max(satPerByte, 1000); // Minimum 1000 sat/byte
      
    } catch (error) {
      console.log('[ELECTRUMX] Fee estimation failed, using default');
      return 1000; // Default minimum
    }
  }

  /**
   * Get server info.
   * 
   * @returns {Promise<Object>} Server information
   */
  async getServerInfo() {
    await this.ensureConnected();
    
    const height = await this.getBlockHeight();
    
    return {
      server: this.currentServer,
      blockHeight: height
    };
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  ElectrumXClient,
  addressToScripthash,
  addressToScriptPubKey,
  ELECTRUMX_SERVERS
};
