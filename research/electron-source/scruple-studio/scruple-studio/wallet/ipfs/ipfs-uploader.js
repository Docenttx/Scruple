/**
 * ipfs-uploader.js - IPFS Package Uploader
 * 
 * Creates ZIP of provenance package and uploads to Pinata.
 * 
 * SCRUPLE Studio V3 - AI Provenance Middleware
 * Patent Pending
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const archiver = require('archiver');

class IPFSUploader {
  constructor(config = {}) {
    this.pinataApiKey = config.pinata?.apiKey || config.apiKey || null;
    this.pinataSecret = config.pinata?.apiSecret || config.apiSecret || null;
    this.pinningService = config.pinningService || 'pinata';
    this.localApiUrl = config.localApiUrl || config.localApi || 'http://129.80.132.5:5001';
    this.localGatewayUrl = 'http://129.80.132.5:8080/ipfs/';
  }

  /**
   * Create ZIP of a folder
   * @param {string} sourceDir - Folder to zip
   * @param {string} outputPath - Output ZIP path
   * @returns {Promise<string>} Path to created ZIP
   */
  async createZip(sourceDir, outputPath) {
    return new Promise((resolve, reject) => {
      const output = fs.createWriteStream(outputPath);
      const archive = archiver('zip', { zlib: { level: 9 } });

      output.on('close', () => {
        console.log('[IPFS-UPLOADER] ZIP created:', outputPath, '(' + archive.pointer() + ' bytes)');
        resolve(outputPath);
      });

      archive.on('error', reject);
      archive.pipe(output);
      archive.directory(sourceDir, false);
      archive.finalize();
    });
  }

  /**
   * Upload file to Pinata
   * @param {string} filePath - Path to file
   * @param {string} name - Name for the pin
   * @param {Object} metadata - Additional metadata
   * @returns {Promise<Object>} { success, cid, size }
   */
  async uploadFile(filePath, name, metadata = {}) {
    if (!this.pinataApiKey || !this.pinataSecret) {
      return { success: false, error: 'Pinata credentials not configured' };
    }

    if (!fs.existsSync(filePath)) {
      return { success: false, error: 'File not found: ' + filePath };
    }

    return new Promise((resolve) => {
      const fileStream = fs.createReadStream(filePath);
      const stats = fs.statSync(filePath);
      const fileName = path.basename(filePath);

      // Build multipart form data
      const boundary = '----FormBoundary' + Math.random().toString(36).substring(2);
      
      // Prepare metadata - convert all values to strings (Pinata requirement)
      const safeMetadata = {};
      for (const [key, value] of Object.entries(metadata)) {
        safeMetadata[key] = String(value);
      }
      
      const pinataMetadata = JSON.stringify({
        name: name,
        keyvalues: {
          app: 'SCRUPLE-Studio',
          version: '3.0',
          type: 'provenance-package',
          ...safeMetadata
        }
      });

      const pinataOptions = JSON.stringify({
        cidVersion: 1
      });

      // Build form parts
      const formParts = [];
      
      // File part header
      formParts.push(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
        `Content-Type: application/zip\r\n\r\n`
      );

      // Metadata part
      const metadataPart = 
        `\r\n--${boundary}\r\n` +
        `Content-Disposition: form-data; name="pinataMetadata"\r\n` +
        `Content-Type: application/json\r\n\r\n` +
        pinataMetadata;

      // Options part
      const optionsPart = 
        `\r\n--${boundary}\r\n` +
        `Content-Disposition: form-data; name="pinataOptions"\r\n` +
        `Content-Type: application/json\r\n\r\n` +
        pinataOptions;

      // Final boundary
      const closingBoundary = `\r\n--${boundary}--\r\n`;

      // Calculate content length
      const headerBuffer = Buffer.from(formParts[0]);
      const metadataBuffer = Buffer.from(metadataPart);
      const optionsBuffer = Buffer.from(optionsPart);
      const closingBuffer = Buffer.from(closingBoundary);
      
      const contentLength = headerBuffer.length + stats.size + metadataBuffer.length + 
                           optionsBuffer.length + closingBuffer.length;

      const options = {
        hostname: 'api.pinata.cloud',
        port: 443,
        path: '/pinning/pinFileToIPFS',
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': contentLength,
          'pinata_api_key': this.pinataApiKey,
          'pinata_secret_api_key': this.pinataSecret
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
                timestamp: result.Timestamp
              });
            } else {
              resolve({
                success: false,
                error: result.error?.details || result.message || `HTTP ${res.statusCode}: ${body}`
              });
            }
          } catch (e) {
            resolve({ success: false, error: 'Invalid response: ' + body.substring(0, 500) });
          }
        });
      });

      req.on('error', (e) => resolve({ success: false, error: e.message }));
      req.setTimeout(300000, () => { // 5 minute timeout for large files
        req.destroy();
        resolve({ success: false, error: 'Upload timeout' });
      });

      // Write form data in order
      req.write(headerBuffer);
      
      // Pipe file content
      fileStream.on('data', chunk => req.write(chunk));
      fileStream.on('end', () => {
        req.write(metadataBuffer);
        req.write(optionsBuffer);
        req.write(closingBuffer);
        req.end();
      });
      fileStream.on('error', (e) => {
        resolve({ success: false, error: 'File read error: ' + e.message });
      });
    });
  }

  /**
   * Upload file to local kubo IPFS node (testnet)
   * @param {string} filePath - Path to file
   * @returns {Promise<Object>} { success, cid, size, gatewayUrl }
   */
  async uploadFileToKubo(filePath) {
    const http = require('http');
    if (!fs.existsSync(filePath)) {
      return { success: false, error: 'File not found: ' + filePath };
    }

    const fileStream = fs.createReadStream(filePath);
    const stats = fs.statSync(filePath);
    const fileName = path.basename(filePath);
    const boundary = '----KuboBoundary' + Math.random().toString(36).substring(2);

    const formHeader = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
      `Content-Type: application/zip\r\n\r\n`
    );
    const formClose = Buffer.from(`\r\n--${boundary}--\r\n`);
    const contentLength = formHeader.length + stats.size + formClose.length;

    const localUrl = new URL(this.localApiUrl);

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
              gatewayUrl: `${this.localGatewayUrl}${result.Hash}`
            });
          } catch (e) {
            resolve({ success: false, error: 'Invalid kubo response: ' + body.substring(0, 200) });
          }
        });
      });

      req.on('error', (e) => resolve({ success: false, error: e.message }));
      req.setTimeout(300000, () => {
        req.destroy();
        resolve({ success: false, error: 'Kubo upload timeout' });
      });

      req.write(formHeader);
      fileStream.on('data', chunk => req.write(chunk));
      fileStream.on('end', () => {
        req.write(formClose);
        req.end();
      });
      fileStream.on('error', (e) => resolve({ success: false, error: 'File read error: ' + e.message }));
    });
  }

  /**
   * Upload provenance package (ZIP of vault folder) to Pinata
   * @param {string} vaultPath - Path to vault folder (e.g., C:\Scruple\vault\project_locked)
   * @param {string} scrId - SCR ID for naming
   * @param {Object} metadata - Additional metadata
   * @returns {Promise<Object>} { success, cid, size, zipPath }
   */
  async uploadProvenancePackage(vaultPath, scrId, metadata = {}) {
    console.log('[IPFS-UPLOADER] === UPLOAD PROVENANCE PACKAGE ===');
    console.log('[IPFS-UPLOADER] Vault path:', vaultPath);
    console.log('[IPFS-UPLOADER] SCR ID:', scrId);

    if (!fs.existsSync(vaultPath)) {
      return { success: false, error: 'Vault path not found: ' + vaultPath };
    }

    try {
      // Create ZIP in temp location
      const zipName = `${scrId}_provenance.zip`;
      const zipPath = path.join(path.dirname(vaultPath), zipName);

      console.log('[IPFS-UPLOADER] Creating ZIP:', zipPath);
    const provenanceOnlyPath = path.join(vaultPath, 'Provenance Only');
const uploadPath = fs.existsSync(provenanceOnlyPath) ? provenanceOnlyPath : vaultPath;
await this.createZip(uploadPath, zipPath);

      const stats = fs.statSync(zipPath);
      console.log('[IPFS-UPLOADER] ZIP size:', (stats.size / 1024 / 1024).toFixed(2), 'MB');

      // Upload to Pinata or local kubo based on pinning service
      console.log('[IPFS-UPLOADER] Uploading via:', this.pinningService || 'pinata');
      let result;
      if (this.pinningService === 'local') {
        result = await this.uploadFileToKubo(zipPath);
      } else {
        result = await this.uploadFile(zipPath, `SCRUPLE_${scrId}_package`, {
        scrId: scrId,
        ...metadata
      });
      }

      if (result.success) {
        console.log('[IPFS-UPLOADER] Upload successful!');
        console.log('[IPFS-UPLOADER] CID:', result.cid);
        console.log('[IPFS-UPLOADER] Size:', result.size, 'bytes');
        
        result.zipPath = zipPath;
        result.gatewayUrl = `https://gateway.pinata.cloud/ipfs/${result.cid}`;
      } else {
        console.error('[IPFS-UPLOADER] Upload failed:', result.error);
      }

      return result;

    } catch (error) {
      console.error('[IPFS-UPLOADER] Error:', error.message);
      return { success: false, error: error.message };
    }
  }
}

module.exports = { IPFSUploader };
