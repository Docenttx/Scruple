/**
 * config.js - IPFS Configuration Manager
 * 
 * Handles IPFS gateway and pinning service configuration.
 * Stores config in the Scruple config directory.
 * 
 * SCRUPLE Studio V3 - AI Provenance Middleware
 * Patent Pending
 */

const fs = require('fs');
const path = require('path');

class IPFSConfigManager {
  constructor(configDir) {
    this.configDir = configDir || 'C:\\Scruple';
    this.configPath = path.join(this.configDir, 'ipfs-config.json');
    this.config = null;
  }

  /**
   * Load IPFS configuration from file.
   * 
   * @returns {Object|null} Configuration or null if not exists
   */
  load() {
    try {
      if (fs.existsSync(this.configPath)) {
        const data = fs.readFileSync(this.configPath, 'utf8');
        this.config = JSON.parse(data);
        return this.config;
      }
      return null;
    } catch (error) {
      console.error('[IPFS] Error loading config:', error.message);
      return null;
    }
  }

  /**
   * Save IPFS configuration to file.
   * 
   * @param {Object} config - Configuration to save
   * @returns {boolean} Success
   */
  save(config) {
    try {
      // Ensure directory exists
      fs.mkdirSync(this.configDir, { recursive: true });
      
      // Validate config
      const sanitizedConfig = {
        gateway: config.gateway || 'https://ipfs.io/ipfs/',
        pinningService: config.pinningService || 'none',
        updatedAt: new Date().toISOString()
      };

      // Add pinning-specific config
      if (config.pinningService === 'pinata') {
        sanitizedConfig.pinata = {
          apiKey: config.pinataKey || '',
          apiSecret: config.pinataSecret || ''
        };
      } else if (config.pinningService === 'local') {
        sanitizedConfig.localApi = config.localApi || 'http://127.0.0.1:5001';
      } else if (config.pinningService === 'infura') {
        sanitizedConfig.infura = {
          projectId: config.infuraProjectId || '',
          projectSecret: config.infuraProjectSecret || ''
        };
      }

      // Write atomically
      const tempPath = this.configPath + '.tmp';
      fs.writeFileSync(tempPath, JSON.stringify(sanitizedConfig, null, 2), 'utf8');
      fs.renameSync(tempPath, this.configPath);
      
      this.config = sanitizedConfig;
      console.log('[IPFS] Config saved');
      
      return true;
    } catch (error) {
      console.error('[IPFS] Error saving config:', error.message);
      return false;
    }
  }

  /**
   * Get current configuration.
   * 
   * @returns {Object|null} Current config
   */
  get() {
    if (!this.config) {
      this.load();
    }
    return this.config;
  }

  /**
   * Delete configuration file.
   * 
   * @returns {boolean} Success
   */
  delete() {
    try {
      if (fs.existsSync(this.configPath)) {
        fs.unlinkSync(this.configPath);
        this.config = null;
        console.log('[IPFS] Config deleted');
      }
      return true;
    } catch (error) {
      console.error('[IPFS] Error deleting config:', error.message);
      return false;
    }
  }

  /**
   * Test IPFS gateway connection.
   * 
   * @returns {Promise<Object>} { success, latencyMs, error }
   */
  async testGateway() {
    const gateway = this.config?.gateway || 'https://ipfs.io/ipfs/';
    const testCid = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG'; // IPFS readme
    
    const startTime = Date.now();
    
    try {
      const https = require('https');
      const http = require('http');
      const url = new URL(`${gateway}${testCid}`);
      const protocol = url.protocol === 'https:' ? https : http;
      
      return new Promise((resolve) => {
        const req = protocol.request(url, { method: 'HEAD', timeout: 10000 }, (res) => {
          const latencyMs = Date.now() - startTime;
          
          if (res.statusCode >= 200 && res.statusCode < 400) {
            resolve({
              success: true,
              latencyMs,
              statusCode: res.statusCode
            });
          } else {
            resolve({
              success: false,
              error: `HTTP ${res.statusCode}`,
              latencyMs
            });
          }
        });
        
        req.on('error', (e) => {
          resolve({
            success: false,
            error: e.message,
            latencyMs: Date.now() - startTime
          });
        });
        
        req.on('timeout', () => {
          req.destroy();
          resolve({
            success: false,
            error: 'Timeout',
            latencyMs: Date.now() - startTime
          });
        });
        
        req.end();
      });
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }
}

module.exports = { IPFSConfigManager };
