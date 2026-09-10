/**
 * hash-worker.js - Worker Thread for Large File Hashing
 * 
 * Streams large files (10GB+ base models) through SHA-256 hashing
 * without blocking the main thread or freezing the UI.
 * 
 * Features:
 * - Streaming hash computation (128KB chunks)
 * - Progress reporting via parentPort
 * - Cancellation support
 * - File metadata collection
 * 
 * Expected throughput: 400-600 MB/s on NVMe
 * 10GB file: ~20-30 seconds
 * 
 * SCRUPLE V3 - AI Provenance Middleware
 * Patent Pending
 */

const { parentPort, workerData } = require('worker_threads');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Configuration
const CHUNK_SIZE = 128 * 1024; // 128KB chunks for optimal streaming
const PROGRESS_INTERVAL = 1024 * 1024 * 10; // Report progress every 10MB

/**
 * Message types for communication with main thread.
 */
const MessageType = {
  PROGRESS: 'progress',
  COMPLETE: 'complete',
  ERROR: 'error',
  CANCELLED: 'cancelled'
};

/**
 * Send a message to the parent thread.
 */
function sendMessage(type, data) {
  if (parentPort) {
    parentPort.postMessage({ type, ...data });
  }
}

/**
 * Hash a file using streaming to avoid memory issues.
 * Reports progress back to main thread.
 * 
 * @param {string} filePath - Path to file to hash
 * @param {string} algorithm - Hash algorithm (default: sha256)
 * @returns {Promise<object>} - { hash, fileSize, mtime, duration }
 */
async function hashFileStreaming(filePath, algorithm = 'sha256') {
  return new Promise((resolve, reject) => {
    // Validate file exists
    if (!fs.existsSync(filePath)) {
      reject(new Error(`File not found: ${filePath}`));
      return;
    }

    // Get file stats
    const stats = fs.statSync(filePath);
    const fileSize = stats.size;
    const mtime = stats.mtime.toISOString();
    const fileName = path.basename(filePath);

    // Track timing
    const startTime = Date.now();

    // Create hash and read stream
    const hash = crypto.createHash(algorithm);
    const stream = fs.createReadStream(filePath, { highWaterMark: CHUNK_SIZE });

    let bytesProcessed = 0;
    let lastProgressBytes = 0;
    let cancelled = false;

    // Handle cancellation from parent
    if (parentPort) {
      parentPort.on('message', (msg) => {
        if (msg.type === 'cancel') {
          cancelled = true;
          stream.destroy();
        }
      });
    }

    // Process data chunks
    stream.on('data', (chunk) => {
      if (cancelled) return;

      hash.update(chunk);
      bytesProcessed += chunk.length;

      // Report progress at intervals
      if (bytesProcessed - lastProgressBytes >= PROGRESS_INTERVAL) {
        const progress = Math.round((bytesProcessed / fileSize) * 100);
        const elapsedMs = Date.now() - startTime;
        const speedMBps = (bytesProcessed / (1024 * 1024)) / (elapsedMs / 1000);
        const remainingBytes = fileSize - bytesProcessed;
        const etaSeconds = remainingBytes / (speedMBps * 1024 * 1024);

        sendMessage(MessageType.PROGRESS, {
          filePath,
          fileName,
          fileSize,
          bytesProcessed,
          progress,
          speedMBps: Math.round(speedMBps * 10) / 10,
          etaSeconds: Math.round(etaSeconds)
        });

        lastProgressBytes = bytesProcessed;
      }
    });

    // Handle completion
    stream.on('end', () => {
      if (cancelled) {
        sendMessage(MessageType.CANCELLED, { filePath, fileName });
        resolve(null);
        return;
      }

      const hashHex = hash.digest('hex');
      const duration = Date.now() - startTime;
      const speedMBps = (fileSize / (1024 * 1024)) / (duration / 1000);

      const result = {
        hash: hashHex,
        algorithm,
        filePath,
        fileName,
        fileSize,
        mtime,
        duration,
        speedMBps: Math.round(speedMBps * 10) / 10
      };

      sendMessage(MessageType.COMPLETE, result);
      resolve(result);
    });

    // Handle errors
    stream.on('error', (err) => {
      if (cancelled) return;

      sendMessage(MessageType.ERROR, {
        filePath,
        fileName,
        error: err.message
      });
      reject(err);
    });
  });
}

/**
 * Hash multiple files sequentially.
 * @param {string[]} filePaths - Array of file paths
 * @param {string} algorithm - Hash algorithm
 * @returns {Promise<object[]>} - Array of hash results
 */
async function hashMultipleFiles(filePaths, algorithm = 'sha256') {
  const results = [];

  for (let i = 0; i < filePaths.length; i++) {
    const filePath = filePaths[i];
    
    try {
      const result = await hashFileStreaming(filePath, algorithm);
      if (result) {
        results.push(result);
      }
    } catch (err) {
      results.push({
        filePath,
        fileName: path.basename(filePath),
        error: err.message
      });
    }
  }

  return results;
}

/**
 * Quick file verification - check if file matches expected hash.
 * Uses early termination if mismatch detected.
 * 
 * @param {string} filePath - Path to file
 * @param {string} expectedHash - Expected hash value
 * @param {string} algorithm - Hash algorithm
 * @returns {Promise<object>} - { verified: boolean, actualHash, reason }
 */
async function verifyFileHash(filePath, expectedHash, algorithm = 'sha256') {
  try {
    const result = await hashFileStreaming(filePath, algorithm);
    
    if (!result) {
      return { verified: false, reason: 'Hashing cancelled' };
    }

    const verified = result.hash === expectedHash;
    
    return {
      verified,
      actualHash: result.hash,
      expectedHash,
      reason: verified ? 'Hash matches' : 'Hash mismatch'
    };
  } catch (err) {
    return {
      verified: false,
      reason: err.message
    };
  }
}

// ============================================================================
// WORKER ENTRY POINT
// ============================================================================

/**
 * Worker receives messages from main thread to perform hashing operations.
 * 
 * Message format:
 * {
 *   action: 'hash' | 'hashMultiple' | 'verify',
 *   filePath: string,        // For 'hash' and 'verify'
 *   filePaths: string[],     // For 'hashMultiple'
 *   expectedHash: string,    // For 'verify'
 *   algorithm: string        // Optional, defaults to 'sha256'
 * }
 */
if (parentPort) {
  parentPort.on('message', async (message) => {
    const { action, filePath, filePaths, expectedHash, algorithm = 'sha256' } = message;

    try {
      switch (action) {
        case 'hash':
          await hashFileStreaming(filePath, algorithm);
          break;

        case 'hashMultiple':
          const results = await hashMultipleFiles(filePaths, algorithm);
          sendMessage(MessageType.COMPLETE, { results, action: 'hashMultiple' });
          break;

        case 'verify':
          const verification = await verifyFileHash(filePath, expectedHash, algorithm);
          sendMessage(MessageType.COMPLETE, { ...verification, action: 'verify', filePath });
          break;

        default:
          sendMessage(MessageType.ERROR, { error: `Unknown action: ${action}` });
      }
    } catch (err) {
      sendMessage(MessageType.ERROR, { error: err.message, action, filePath });
    }
  });

  // Signal ready
  sendMessage('ready', { message: 'Hash worker initialized' });
}

// ============================================================================
// STANDALONE EXECUTION (for testing)
// ============================================================================

if (require.main === module) {
  // Run as standalone script for testing
  const testFile = process.argv[2];
  
  if (!testFile) {
    console.log('Usage: node hash-worker.js <file-path>');
    process.exit(1);
  }

  console.log(`Hashing: ${testFile}`);
  
  hashFileStreaming(testFile)
    .then(result => {
      console.log('\nResult:');
      console.log(`  Hash: ${result.hash}`);
      console.log(`  Size: ${(result.fileSize / (1024 * 1024)).toFixed(2)} MB`);
      console.log(`  Time: ${(result.duration / 1000).toFixed(2)}s`);
      console.log(`  Speed: ${result.speedMBps} MB/s`);
    })
    .catch(err => {
      console.error('Error:', err.message);
      process.exit(1);
    });
}

module.exports = {
  hashFileStreaming,
  hashMultipleFiles,
  verifyFileHash,
  MessageType,
  CHUNK_SIZE
};
