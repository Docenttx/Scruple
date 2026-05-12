/**
 * ipfs-pinner.js - IPFS Pinning Service
 * 
 * Handles pinning data to IPFS via Pinata (or other services).
 * Standalone module - no Electron dependency.
 * 
 * SCRUPLE Studio V3 - AI Provenance Middleware
 * Patent Pending
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

class IPFSPinner {
  constructor(config = {}) {
    this.gateway = config.gateway || 'https://ipfs.io/ipfs/';
    this.pinningService = config.pinningService || 'none';
    this.pinata = config.pinata || null;
    this.infura = config.infura || null;
    this.localApi = config.localApi || 'http://127.0.0.1:5001';
  }

  /**
   * Load configuration from file
   * @param {string} configPath - Path to ipfs-config.json
   * @returns {IPFSPinner} Configured instance
   */
  static fromConfigFile(configPath) {
    if (!fs.existsSync(configPath)) {
      console.log('[IPFS] No config file found, using defaults');
      return new IPFSPinner();
    }
    
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    console.log('[IPFS] Loaded config, service:', config.pinningService);
    return new IPFSPinner(config);
  }

  /**
   * Test authentication with pinning service
   * @returns {Promise<Object>} { success, message }
   */
  async testAuth() {
    if (this.pinningService === 'pinata') {
      return this._testPinataAuth();
    } else if (this.pinningService === 'infura') {
      return this._testInfuraAuth();
    } else {
      return { success: false, error: 'No pinning service configured' };
    }
  }

  /**
   * Pin JSON data to IPFS
   * @param {Object} data - JSON data to pin
   * @param {string} name - Name/label for the pin
   * @param {Object} metadata - Additional metadata
   * @returns {Promise<Object>} { success, cid, size }
   */
  async pinJSON(data, name, metadata = {}) {
    if (this.pinningService === 'pinata') {
      return this._pinToPinata(data, name, metadata);
    } else if (this.pinningService === 'infura') {
      return this._pinToInfura(data, name);
    } else if (this.pinningService === 'local') {
      return this._pinToLocal(data);
    } else {
      return { success: false, error: 'No pinning service configured' };
    }
  }

  /**
   * Pin a SCRUPLE proof record
   * @param {string} scrId - SCR ID
   * @param {string} merkleRoot - Merkle root hash
   * @param {Object} proofData - Additional proof data
   * @returns {Promise<Object>} { success, cid, size }
   */
  async pinProofRecord(scrId, merkleRoot, proofData = {}) {
    const record = {
      scrId,
      merkleRoot,
      timestamp: new Date().toISOString(),
      source: 'SCRUPLE Studio V3',
      version: '3.0',
      type: 'proof-record',
      ...proofData
    };

    const metadata = {
      app: 'SCRUPLE-Studio',
      version: '3.0',
      type: 'proof-record',
      scrId
    };

    return this.pinJSON(record, `SCRUPLE_${scrId}`, metadata);
  }

  /**
   * Get gateway URL for a CID
   * @param {string} cid - IPFS CID
   * @returns {string} Gateway URL
   */
  getGatewayUrl(cid) {
    return `${this.gateway}${cid}`;
  }

  // ===========================================================================
  // PINATA IMPLEMENTATION
  // ===========================================================================

  async _testPinataAuth() {
    if (!this.pinata?.apiKey || !this.pinata?.apiSecret) {
      return { success: false, error: 'Pinata credentials not configured' };
    }

    return new Promise((resolve) => {
      const options = {
        hostname: 'api.pinata.cloud',
        port: 443,
        path: '/data/testAuthentication',
        method: 'GET',
        headers: {
          'pinata_api_key': this.pinata.apiKey,
          'pinata_secret_api_key': this.pinata.apiSecret
        }
      };

      const req = https.request(options, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try {
            const result = JSON.parse(body);
            if (res.statusCode === 200) {
              resolve({ success: true, message: result.message || 'Authenticated' });
            } else {
              resolve({ success: false, error: `Auth failed: HTTP ${res.statusCode}` });
            }
          } catch (e) {
            resolve({ success: false, error: 'Invalid response' });
          }
        });
      });

      req.on('error', (e) => resolve({ success: false, error: e.message }));
      req.setTimeout(10000, () => {
        req.destroy();
        resolve({ success: false, error: 'Timeout' });
      });
      req.end();
    });
  }

  async _pinToPinata(data, name, metadata = {}) {
    if (!this.pinata?.apiKey || !this.pinata?.apiSecret) {
      return { success: false, error: 'Pinata credentials not configured' };
    }

    return new Promise((resolve) => {
      const payload = JSON.stringify({
        pinataContent: data,
        pinataMetadata: {
          name: name,
          keyvalues: metadata
        },
        pinataOptions: {
          cidVersion: 1
        }
      });

      const options = {
        hostname: 'api.pinata.cloud',
        port: 443,
        path: '/pinning/pinJSONToIPFS',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'pinata_api_key': this.pinata.apiKey,
          'pinata_secret_api_key': this.pinata.apiSecret
        }
      };

      const req = https.request(options, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try {
            const result = JSON.parse(body);
            if (res.statusCode === 200) {
              resolve({
                success: true,
                cid: result.IpfsHash,
                size: result.PinSize,
                timestamp: result.Timestamp,
                gatewayUrl: this.getGatewayUrl(result.IpfsHash)
              });
            } else {
              resolve({
                success: false,
                error: result.error?.details || result.message || `HTTP ${res.statusCode}`
              });
            }
          } catch (e) {
            resolve({ success: false, error: 'Invalid response: ' + body.substring(0, 200) });
          }
        });
      });

      req.on('error', (e) => resolve({ success: false, error: e.message }));
      req.setTimeout(30000, () => {
        req.destroy();
        resolve({ success: false, error: 'Timeout' });
      });
      req.write(payload);
      req.end();
    });
  }

  // ===========================================================================
  // INFURA IMPLEMENTATION (placeholder)
  // ===========================================================================

  async _testInfuraAuth() {
    // TODO: Implement Infura auth test
    return { success: false, error: 'Infura not yet implemented' };
  }

  async _pinToInfura(data, name) {
    // TODO: Implement Infura pinning
    return { success: false, error: 'Infura not yet implemented' };
  }

  // ===========================================================================
  // LOCAL NODE IMPLEMENTATION (placeholder)
  // ===========================================================================

  async _pinToLocal(data) {
    // POST JSON data to kubo /api/v0/add on Oracle VM
    const http = require('http');
    const payload = Buffer.from(JSON.stringify(data, null, 2));
    const boundary = '----KuboBoundary' + Math.random().toString(36).substring(2);

    const formHeader = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="data.json"\r\n` +
      `Content-Type: application/json\r\n\r\n`
    );
    const formClose = Buffer.from(`\r\n--${boundary}--\r\n`);
    const contentLength = formHeader.length + payload.length + formClose.length;

    const localUrl = new URL(this.localApi || 'http://129.80.132.5:5001');

    return new Promise((resolve) => {
      const req = http.request({
        hostname: localUrl.hostname,
        port: localUrl.port || 5001,
        path: '/api/v0/add',
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': contentLength
        }
      }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try {
            const result = JSON.parse(body);
            resolve({
              success: true,
              cid: result.Hash,
              size: parseInt(result.Size || 0),
              gatewayUrl: `http://129.80.132.5:8080/ipfs/${result.Hash}`
            });
          } catch (e) {
            resolve({ success: false, error: 'Invalid kubo response: ' + body.substring(0, 200) });
          }
        });
      });

      req.on('error', (e) => resolve({ success: false, error: e.message }));
      req.setTimeout(30000, () => {
        req.destroy();
        resolve({ success: false, error: 'Kubo upload timeout' });
      });

      req.write(formHeader);
      req.write(payload);
      req.write(formClose);
      req.end();
    });
  }
}

module.exports = { IPFSPinner };
