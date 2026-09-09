/**
 * wallets-integration-native.js - Wallet Integration with Native Asset Issuance
 * 
 * Updated integration that uses ElectrumX + native TX building instead of RPC.
 * Implements "turnstile" fee model: service fee tx -> then asset mint tx.
 * 
 * Cost per lock:
 * - Service Fee: $15 USD (converted to RVN)
 * - Network Burn: 500 RVN
 * - Total: ~$30 USD
 * 
 * SCRUPLE Studio V3 - AI Provenance Middleware
 * Patent Pending
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { dialog } = require('electron');

// =============================================================================
// IMPORTS FROM WALLETS FOLDER STRUCTURE
// =============================================================================

// RVN wallet modules
const { WalletManager } = require('./wallet');
const { PriceManager } = require('./price');

// RVN native asset issuer
const { 
  nativeIssuer, 
  issueProofAsset,
  checkAssetExists,
  getWalletBalance,
  ASSET_CREATION_COST 
} = require('./native-issuer');

// Arweave manager
const ArweaveManager = require('../arweave/arweave-index');

// IPFS modules
const { IPFSConfigManager } = require('../ipfs/ipfs-config');
const { IPFSPinner } = require('../ipfs/ipfs-pinner');
const { IPFSUploader } = require('../ipfs/ipfs-uploader');
const PDFDocument = require('pdfkit');

// ============================================================================
// CONFIGURATION
// ============================================================================

// Treasury address for service fees
const TREASURY_ADDRESS = 'RLP4eG2PjPr8TdNTRmrEAE7sDxWQr56Ma6';

// Service fee in USD
const SERVICE_FEE_USD = 15.00;

// Singleton instances
let walletManager = null;
let ipfsConfigManager = null;
let ipfsPinner = null;
let ipfsUploader = null;
let arweaveManager = null;
let scrupleHome = null;

// ============================================================================
// INITIALIZATION
// ============================================================================

/**
 * Initialize wallet services.
 */
function initializeWalletServices(walletDir, configDir, options = {}) {
  // Save scrupleHome for later use
  scrupleHome = configDir;
  
  if (!walletManager) {
    walletManager = new WalletManager(walletDir, options);
    console.log('[WALLETS] WalletManager initialized');
  }
  
  if (!ipfsConfigManager) {
    ipfsConfigManager = new IPFSConfigManager(configDir);
    console.log('[WALLETS] IPFSConfigManager initialized');
    
    // Initialize pinner and uploader from config
    const ipfsConfig = ipfsConfigManager.get();
    if (ipfsConfig) {
      ipfsPinner = new IPFSPinner(ipfsConfig);
      ipfsUploader = new IPFSUploader(ipfsConfig);
      console.log('[WALLETS] IPFSPinner initialized with:', ipfsConfig.pinningService);
      console.log('[WALLETS] IPFSUploader initialized');
    }
  }
  
  if (!arweaveManager) {
    arweaveManager = new ArweaveManager(configDir);
    console.log('[WALLETS] ArweaveManager initialized in:', configDir);
  }
}

// ============================================================================
// IPC HANDLERS
// ============================================================================

/**
 * Setup all wallet-related IPC handlers.
 */
function setupWalletHandlers(ipcMain, configManager) {
  const config = configManager.load();
  const walletDir = path.join(config.scrupleHome, 'wallet');
  const configDir = config.scrupleHome;
  
  initializeWalletServices(walletDir, configDir, {
    network: config.rvn?.network || 'rvn',
    rpcUrl: config.rvn?.rpcUrl || undefined
  });

  // ===========================================================================
  // RVN WALLET MANAGEMENT
  // ===========================================================================

  ipcMain.handle('rvn-wallet-status', async () => {
    try {
      const status = walletManager.getStatus();
      
      if (status.isUnlocked) {
        try {
          status.balance = await walletManager.getBalance();
        } catch (e) {
          status.balanceError = e.message;
        }
      }
      
      return status;
    } catch (error) {
      return { error: error.message };
    }
  });

  ipcMain.handle('rvn-wallet-create', async (event, password) => {
    try {
      return await walletManager.createWallet(password);
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('rvn-wallet-import', async (event, mnemonic, password) => {
    try {
      return await walletManager.importWallet(mnemonic, password);
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('rvn-wallet-unlock', async (event, password) => {
    try {
      return await walletManager.unlockWallet(password);
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('rvn-wallet-lock', async () => {
    try {
      return walletManager.lockWallet();
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('rvn-wallet-verify-password', async (event, password) => {
    try {
      const valid = await walletManager.verifyPassword(password);
      return { valid };
    } catch (error) {
      return { valid: false, error: error.message };
    }
  });

  ipcMain.handle('rvn-wallet-delete', async (event, confirmation) => {
    try {
      return walletManager.deleteWallet(confirmation);
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // ===========================================================================
  // RVN BALANCE & INFO
  // ===========================================================================

  ipcMain.handle('rvn-get-balance', async () => {
    try {
      const balance = await walletManager.getBalance();
      const address = walletManager.getAddress();
      return { balance, address };
    } catch (error) {
      return { error: error.message };
    }
  });

  ipcMain.handle('rvn-get-address', async () => {
    try {
      const address = walletManager.getAddress();
      return { address };
    } catch (error) {
      return { error: error.message };
    }
  });

  // ===========================================================================
  // RVN PRICE & FEE QUOTES
  // ===========================================================================

  ipcMain.handle('rvn-get-fee-quote', async () => {
    try {
      const quote = await PriceManager.getFeeQuote(SERVICE_FEE_USD);
      return quote;
    } catch (error) {
      return { error: error.message };
    }
  });

  ipcMain.handle('rvn-get-rvn-price', async () => {
    try {
      const price = await PriceManager.getRvnPrice();
      return { price, currency: 'USD' };
    } catch (error) {
      return { error: error.message };
    }
  });

  // ===========================================================================
  // RVN ASSET OPERATIONS (using native issuer)
  // ===========================================================================

  ipcMain.handle('rvn-check-asset-exists', async (event, assetName) => {
    try {
      const exists = await checkAssetExists(assetName);
      return { exists, assetName };
    } catch (error) {
      return { error: error.message };
    }
  });

  ipcMain.handle('rvn-get-asset-data', async (event, assetName) => {
    try {
      await nativeIssuer.connect();
      const meta = await nativeIssuer.electrumx.getAssetMeta(assetName);
      return { data: meta, assetName };
    } catch (error) {
      return { error: error.message };
    }
  });

  ipcMain.handle('rvn-verify-proof', async (event, scrId, expectedMerkleRoot) => {
    try {
      return await nativeIssuer.verifyProof(scrId, expectedMerkleRoot);
    } catch (error) {
      return { valid: false, error: error.message };
    }
  });

  ipcMain.handle('rvn-get-costs', async () => {
    try {
      const quote = await PriceManager.getFeeQuote(SERVICE_FEE_USD);
      const nativeQuote = await nativeIssuer.getFeeQuote();
      
      return {
        networkBurn: {
          rvn: ASSET_CREATION_COST / 1e8,
          description: 'Burned to Ravencoin network for root asset creation'
        },
        serviceFee: {
          usd: SERVICE_FEE_USD,
          rvn: quote.serviceFeeRvn,
          exchangeRate: quote.exchangeRate
        },
        networkFee: {
          rvn: nativeQuote.networkFeeRVN,
          description: 'Transaction fee'
        },
        total: {
          rvn: quote.totalRvn + nativeQuote.networkFeeRVN,
          description: 'Service fee + network burn + tx fee'
        }
      };
    } catch (error) {
      return { error: error.message };
    }
  });

  // ===========================================================================
  // IPFS CONFIGURATION & PINNING
  // ===========================================================================

  ipcMain.handle('ipfs-get-config', async () => {
    try {
      return ipfsConfigManager.get();
    } catch (error) {
      return { error: error.message };
    }
  });

  ipcMain.handle('ipfs-save-config', async (event, config) => {
    try {
      const success = ipfsConfigManager.save(config);
      
      // Reinitialize pinner with new config
      if (success) {
        const newConfig = ipfsConfigManager.get();
        ipfsPinner = new IPFSPinner(newConfig);
      }
      
      return { success };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('ipfs-test-connection', async () => {
    try {
      if (!ipfsPinner) {
        return { success: false, error: 'IPFS not configured' };
      }
      return await ipfsPinner.testAuth();
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('ipfs-pin-proof', async (event, scrId, merkleRoot, proofData) => {
    try {
      if (!ipfsPinner) {
        return { success: false, error: 'IPFS not configured' };
      }
      return await ipfsPinner.pinProofRecord(scrId, merkleRoot, proofData);
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // ===========================================================================
  // ARWEAVE WALLET
  // ===========================================================================

ipcMain.handle('arweave-import-key', async () => {
    try {
      const { canceled, filePaths } = await dialog.showOpenDialog({
        title: 'Import Arweave Keyfile',
        properties: ['openFile'],
        filters: [{ name: 'Arweave Keyfile', extensions: ['json'] }]
      });

      if (canceled || filePaths.length === 0) {
        return { success: false, error: 'Cancelled' };
      }

      const result = await arweaveManager.loadWallet(filePaths[0]);
      
      if (result.success) {
        // Check actual network connectivity
        const balanceResult = await arweaveManager.getBalanceWithStatus();
        return { 
          success: true, 
          connected: balanceResult.success,
          address: result.address, 
          balance: balanceResult.balance,
          error: balanceResult.success ? null : 'Network error'
        };
      }
      return result;
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

ipcMain.handle('arweave-get-status', async () => {
    const address = arweaveManager.getAddress();
    if (!address) return { connected: false, error: 'No wallet' };
    
    // Wallet exists = connected. Balance is 0 if network fails.
    const balance = await arweaveManager.getBalance();
    return { connected: true, address, balance };
  });
  ipcMain.handle('arweave-disconnect', async () => {
    try {
      arweaveManager.disconnect();
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('arweave-upload-proof', async (event, scrId, merkleRoot, proofData) => {
    try {
      return await arweaveManager.uploadProofRecord(scrId, merkleRoot, proofData);
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  console.log('[WALLETS] IPC handlers registered (native issuer mode)');
}

// ============================================================================
// MNEMONIC ACCESS (for native issuer)
// ============================================================================

/**
 * Decrypt mnemonic from wallet file.
 * 
 * @param {string} password - Wallet password
 * @returns {Promise<string>} Decrypted mnemonic
 */
async function decryptMnemonic(password) {
  if (!walletManager || !walletManager.walletExists()) {
    throw new Error('No wallet found');
  }
  
  const walletPath = walletManager.walletPath;
  const walletData = JSON.parse(fs.readFileSync(walletPath, 'utf8'));
  
  const { salt, iv, authTag, ciphertext } = walletData.encrypted;
  
  // Derive key from password
  const key = crypto.pbkdf2Sync(
    password,
    Buffer.from(salt, 'hex'),
    100000, // KEY_DERIVATION_ITERATIONS
    32,
    'sha512'
  );
  
  // Decrypt
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(iv, 'hex')
  );
  decipher.setAuthTag(Buffer.from(authTag, 'hex'));
  
  let mnemonic = decipher.update(ciphertext, 'hex', 'utf8');
  mnemonic += decipher.final('utf8');
  
  return mnemonic;
}

// ============================================================================
// TURNSTILE LOCK IMPLEMENTATION (Native Version)
// ============================================================================

/**
 * Perform Single Chain Lock using native asset issuance.
 * 
 * Flow:
 * 1. Decrypt mnemonic with password
 * 2. Calculate service fee in RVN
 * 3. Transaction A: Send fee to treasury (using ravenrebels)
 * 4. Transaction B: Mint proof asset (using native issuer!)
 * 
 * @param {number} projectId - Project ID to lock
 * @param {string} password - Wallet password
 * @param {Object} databaseManager - DatabaseManager instance
 * @returns {Object} { success, scrId, proofTxId, feeTxId, costs }
 */
async function performSingleChainLock(projectId, password, databaseManager) {
  console.log('[WALLETS-NATIVE] === SINGLE CHAIN LOCK START ===');
  console.log('[WALLETS-NATIVE] Project ID:', projectId);
  
  let feeTxId = null;
  let mnemonic = null;
  
  try {
    // -------------------------------------------------------------------------
    // STEP 1: Validate project state
    // -------------------------------------------------------------------------
    const project = databaseManager.getProject(projectId);
    if (!project) {
      throw new Error('Project not found');
    }
    
    if (project.status !== 'local_locked') {
      throw new Error('Project must be local locked first');
    }
    
    const scrId = project.scr_id;
    const merkleRoot = project.merkle_root;
    
    if (!scrId || !merkleRoot) {
      throw new Error('Project missing SCR ID or merkle root');
    }
    
    console.log('[WALLETS-NATIVE] SCR ID:', scrId);
    console.log('[WALLETS-NATIVE] Merkle Root:', merkleRoot);

    // -------------------------------------------------------------------------
    // STEP 2: Decrypt mnemonic
    // -------------------------------------------------------------------------
    mnemonic = await decryptMnemonic(password);
    console.log('[WALLETS-NATIVE] Mnemonic decrypted');
    
    // -------------------------------------------------------------------------
    // STEP 3: Check if asset already exists
    // -------------------------------------------------------------------------
    const exists = await checkAssetExists(scrId);
    if (exists) {
      throw new Error(`Asset ${scrId} already exists on chain`);
    }
    console.log('[WALLETS-NATIVE] Asset name available');

    // -------------------------------------------------------------------------
    // STEP 4: Get fee quote and check balance
    // -------------------------------------------------------------------------
    // BETA: Only check for network burn (500 RVN), skip service fee check
    const balanceInfo = await getWalletBalance(mnemonic);
    const networkBurnRvn = ASSET_CREATION_COST / 1e8; // 500 RVN
    const totalNeeded = networkBurnRvn + 1; // +1 for tx fee buffer
    
    if (balanceInfo.totalRVN < totalNeeded) {
      throw new Error(
        `Insufficient balance. Need ~${totalNeeded.toFixed(2)} RVN, ` +
        `have ${balanceInfo.totalRVN.toFixed(2)} RVN`
      );
    }
    
    console.log('[WALLETS-NATIVE] Balance Check (BETA):', {
      networkBurnRvn: networkBurnRvn,
      totalNeeded: totalNeeded,
      balance: balanceInfo.totalRVN
    });

    // -------------------------------------------------------------------------
    // STEP 5: TURNSTILE - Transaction A: Pay service fee
    // -------------------------------------------------------------------------
    // BETA: Service fee disabled for testing
    // console.log('[WALLETS-NATIVE] TURNSTILE: Sending service fee to treasury...');
    // 
    // // Unlock wallet for ravenrebels send
    // await walletManager.unlockWallet(password);
    // 
    // const feeResult = await walletManager.send({
    //   toAddress: TREASURY_ADDRESS,
    //   amount: quote.serviceFeeRvn,
    //   assetName: 'RVN'
    // });
    // 
    // feeTxId = feeResult.transactionId || feeResult.txid;
    // console.log('[WALLETS-NATIVE] TURNSTILE: Fee paid. TxID:', feeTxId);
    // 
    // // Wait for UTXO propagation
    // console.log('[WALLETS-NATIVE] Waiting for UTXO propagation (5 seconds)...');
    // await new Promise(resolve => setTimeout(resolve, 5000));
    
    feeTxId = 'SKIPPED_FOR_BETA';
    console.log('[WALLETS-NATIVE] TURNSTILE: Service fee SKIPPED (beta mode)');

    // -------------------------------------------------------------------------
    // STEP 6: Transaction B: Mint proof asset (NATIVE!)
    // -------------------------------------------------------------------------
    console.log('[WALLETS-NATIVE] Creating proof asset via native issuer...');
    
    const mintResult = await issueProofAsset(scrId, merkleRoot, mnemonic);
    
    if (!mintResult.success) {
      throw new Error(mintResult.error || 'Asset creation failed');
    }
    
    console.log('[WALLETS-NATIVE] Proof asset created. TxID:', mintResult.txid);

    // -------------------------------------------------------------------------
    // STEP 7: Upload to IPFS
    // -------------------------------------------------------------------------
    let ipfsCid = null;
    let ipfsError = null;
    
    if (ipfsUploader) {
      console.log('[WALLETS-NATIVE] Uploading provenance package to IPFS...');
      const vaultPath = project.vault_path || path.join(scrupleHome, 'vault', project.name + '_locked');
      
      if (fs.existsSync(vaultPath)) {
        const ipfsResult = await ipfsUploader.uploadProvenancePackage(vaultPath, scrId, {
          merkleRoot: merkleRoot,
          rvnTxId: mintResult.txid
        });
        
        if (ipfsResult.success) {
          ipfsCid = ipfsResult.cid;
          console.log('[WALLETS-NATIVE] IPFS CID:', ipfsCid);
        } else {
          ipfsError = ipfsResult.error;
          console.error('[WALLETS-NATIVE] IPFS upload failed:', ipfsError);
        }
      } else {
        ipfsError = 'Vault folder not found';
        console.error('[WALLETS-NATIVE] Vault not found:', vaultPath);
      }
    } else {
      ipfsError = 'IPFS not configured';
      console.log('[WALLETS-NATIVE] IPFS not configured, skipping');
    }

    // Fail if IPFS failed
    if (ipfsError) {
      return {
        success: false,
        error: 'IPFS upload failed: ' + ipfsError,
        failedStep: 'ipfs',
        scrId,
        proofTxId: mintResult.txid,
        merkleRoot,
        ipfsCid: null,
        ipfsError,
        arweaveTxId: null,
        arweaveError: null,
        canRetry: { ipfs: true, arweave: true }
      };
    }

    // -------------------------------------------------------------------------
    // STEP 8: Upload to Arweave
    // -------------------------------------------------------------------------
    let arweaveTxId = null;
    let arweaveError = null;
    
    if (arweaveManager && arweaveManager.exists()) {
      console.log('[WALLETS-NATIVE] Uploading proof record to Arweave...');
      const proofData = {
        rvnTxId: mintResult.txid,
        ipfsCid: ipfsCid,
        controlIndex: project.control_index,
        createdAt: project.created_at
      };
      
      const arResult = await arweaveManager.uploadProofRecord(scrId, merkleRoot, proofData);
      
      if (arResult.success) {
        arweaveTxId = arResult.txId;
        console.log('[WALLETS-NATIVE] Arweave TxID:', arweaveTxId);
      } else {
        arweaveError = arResult.error;
        console.error('[WALLETS-NATIVE] Arweave upload failed:', arweaveError);
      }
    } else {
      arweaveError = 'Arweave not configured';
      console.log('[WALLETS-NATIVE] Arweave not configured, skipping');
    }

    // Fail if Arweave failed
    if (arweaveError) {
      return {
        success: false,
        error: 'Arweave upload failed: ' + arweaveError,
        failedStep: 'arweave',
        scrId,
        proofTxId: mintResult.txid,
        merkleRoot,
        ipfsCid,
        ipfsError: null,
        arweaveTxId: null,
        arweaveError,
        canRetry: { ipfs: false, arweave: true }
      };
    }

    // -------------------------------------------------------------------------
    // STEP 9: Update database
    // -------------------------------------------------------------------------
    const dbUpdates = {
      status: 'chain_locked',
      rvn_txid: mintResult.txid,
      rvn_fee_txid: feeTxId
    };
    if (ipfsCid) dbUpdates.ipfs_cid = ipfsCid;
    if (arweaveTxId) dbUpdates.arweave_txid = arweaveTxId;
    
    databaseManager.updateProject(projectId, dbUpdates);

    // -------------------------------------------------------------------------
    // STEP 9b: Generate PDF receipt
    // -------------------------------------------------------------------------
    try {
      const vaultPath = project.vault_path || path.join(scrupleHome, 'vault', project.name + '_locked');
      const pdfPath = path.join(vaultPath, `${scrId}_receipt.pdf`);
      
      const doc = new PDFDocument({ margin: 50 });
      const writeStream = fs.createWriteStream(pdfPath);
      doc.pipe(writeStream);
      
      // Header
      doc.fontSize(24).text('SCRUPLE Provenance Receipt', { align: 'center' });
      doc.moveDown();
      doc.fontSize(12).fillColor('#666').text(new Date().toISOString(), { align: 'center' });
      doc.moveDown(2);
      
      // Project Info
      doc.fillColor('#000').fontSize(14).text('Project Details', { underline: true });
      doc.moveDown(0.5);
      doc.fontSize(11);
      doc.text(`Project Name: ${project.name}`);
      doc.text(`Project Type: ${project.type}`);
      doc.text(`SCR ID: ${scrId}`);
      doc.moveDown();
      
      // Merkle Root
      doc.fontSize(14).text('Cryptographic Proof', { underline: true });
      doc.moveDown(0.5);
      doc.fontSize(9).font('Courier').text(`Merkle Root: ${merkleRoot}`);
      doc.moveDown();
      
      // Blockchain Records
      doc.font('Helvetica').fontSize(14).text('Blockchain Records', { underline: true });
      doc.moveDown(0.5);
      doc.fontSize(10);
      doc.text('Ravencoin:', { continued: true }).font('Courier').fontSize(8).text(` ${mintResult.txid}`);
      doc.font('Helvetica').fontSize(10).text('IPFS CID:', { continued: true }).font('Courier').fontSize(8).text(` ${ipfsCid || 'N/A'}`);
      doc.font('Helvetica').fontSize(10).text('Arweave TX:', { continued: true }).font('Courier').fontSize(8).text(` ${arweaveTxId || 'N/A'}`);
      doc.moveDown();
      
      // Verification Links
      doc.font('Helvetica').fontSize(14).text('Verification Links', { underline: true });
      doc.moveDown(0.5);
      doc.fontSize(9).fillColor('#0066cc');
      doc.text(`RVN: https://rvn.cryptoscope.io/tx/?txid=${mintResult.txid}`);
      if (ipfsCid) doc.text(`IPFS: https://gateway.pinata.cloud/ipfs/${ipfsCid}`);
      if (arweaveTxId) doc.text(`Arweave: https://arweave.net/${arweaveTxId}`);
      
      doc.end();
      console.log('[WALLETS-NATIVE] PDF receipt saved:', pdfPath);
    } catch (pdfError) {
      console.error('[WALLETS-NATIVE] PDF generation failed:', pdfError.message);
    }

    // -------------------------------------------------------------------------
    // STEP 10: Lock wallet and cleanup
    // -------------------------------------------------------------------------
    walletManager.lockWallet();
    mnemonic = null;
    
    console.log('[WALLETS-NATIVE] === CHAIN LOCK COMPLETE ===');
    
    return {
      success: true,
      scrId,
      assetName: scrId,
      proofTxId: mintResult.txid,
      feeTxId,
      merkleRoot,
      ipfsCid,
      ipfsError,
      arweaveTxId,
      arweaveError,
      costs: {
        serviceFeeUsd: 0,
        serviceFeeRvn: 0,
        networkBurnRvn: ASSET_CREATION_COST / 1e8,
        totalRvn: ASSET_CREATION_COST / 1e8,
        exchangeRate: null
      },
      mock: false,
      native: true
    };
    
  } catch (error) {
    // Cleanup
    mnemonic = null;
    if (walletManager && walletManager.isUnlocked) {
      walletManager.lockWallet();
    }
    
    console.error('[WALLETS-NATIVE] Single Chain Lock FAILED:', error.message);
    
    // Handle partial failure
    if (feeTxId) {
      console.error('[WALLETS-NATIVE] WARNING: Fee transaction succeeded but mint failed!');
      console.error('[WALLETS-NATIVE] Fee TxID:', feeTxId);
      return {
        success: false,
        error: error.message,
        feeTxId,
        partialFailure: true,
        message: 'Service fee was paid but asset minting failed. Contact support.'
      };
    }
    
    return { success: false, error: error.message };
  }
}

/**
 * Perform Permanent Lock (Arweave + IPFS)
 * 
 * @param {number} projectId - Project ID to lock
 * @param {Object} databaseManager - DatabaseManager instance
 * @param {Object} options - { arweave: boolean, ipfs: boolean }
 * @returns {Object} { success, arweaveTxId, ipfsCid }
 */
async function performPermanentLock(projectId, databaseManager, options = {}) {
  console.log('[WALLETS-NATIVE] === PERMANENT LOCK START ===');
  console.log('[WALLETS-NATIVE] Project ID:', projectId);
  console.log('[WALLETS-NATIVE] Options:', options);
  
  try {
    // Get project
    const project = databaseManager.getProject(projectId);
    if (!project) {
      throw new Error('Project not found');
    }
    
    if (project.status !== 'chain_locked') {
      throw new Error('Project must be chain locked first');
    }
    
    const scrId = project.scr_id;
    const merkleRoot = project.merkle_root;
    
    const proofData = {
      rvnTxId: project.rvn_txid,
      controlIndex: project.control_index,
      createdAt: project.created_at
    };
    
    const results = {
      success: true,
      arweaveTxId: null,
      ipfsCid: null
    };
    
    // Upload to Arweave if requested
    if (options.arweave) {
      console.log('[WALLETS-NATIVE] Uploading to Arweave...');
      const arResult = await arweaveManager.uploadProofRecord(scrId, merkleRoot, proofData);
      
      if (arResult.success) {
        results.arweaveTxId = arResult.txId;
        console.log('[WALLETS-NATIVE] Arweave TxID:', arResult.txId);
      } else {
        console.error('[WALLETS-NATIVE] Arweave upload failed:', arResult.error);
        results.arweaveError = arResult.error;
      }
    }
    
    // Upload provenance package to IPFS if requested
    if (options.ipfs && ipfsUploader) {
      console.log('[WALLETS-NATIVE] Uploading provenance package to IPFS...');
      
      // Get vault path - training projects use vault_path, image projects use _locked convention
      const vaultPath = project.vault_path || path.join(scrupleHome, 'vault', project.name + '_locked');
      console.log('[WALLETS-NATIVE] Vault path:', vaultPath);
      
      if (!fs.existsSync(vaultPath)) {
        console.error('[WALLETS-NATIVE] Vault not found:', vaultPath);
        results.ipfsError = 'Vault folder not found. Run local lock first.';
      } else {
        const ipfsResult = await ipfsUploader.uploadProvenancePackage(vaultPath, scrId, {
          merkleRoot: merkleRoot,
          rvnTxId: project.rvn_txid
        });
        
        if (ipfsResult.success) {
          results.ipfsCid = ipfsResult.cid;
          results.ipfsSize = ipfsResult.size;
          results.ipfsGatewayUrl = ipfsResult.gatewayUrl;
          console.log('[WALLETS-NATIVE] IPFS CID:', ipfsResult.cid);
          console.log('[WALLETS-NATIVE] Package size:', ipfsResult.size, 'bytes');
        } else {
          console.error('[WALLETS-NATIVE] IPFS upload failed:', ipfsResult.error);
          results.ipfsError = ipfsResult.error;
        }
      }
    }
    
    // Update database with results
    const updates = { status: 'persistent_locked' };
    if (results.arweaveTxId) updates.arweave_txid = results.arweaveTxId;
    if (results.ipfsCid) updates.ipfs_cid = results.ipfsCid;
    
    databaseManager.updateProject(projectId, updates);
    
    console.log('[WALLETS-NATIVE] === PERMANENT LOCK COMPLETE ===');
    
    return results;
    
  } catch (error) {
    console.error('[WALLETS-NATIVE] Permanent Lock FAILED:', error.message);
    return { success: false, error: error.message };
  }
}

// ============================================================================
// CLEANUP
// ============================================================================

async function cleanup() {
  if (walletManager && walletManager.isUnlocked) {
    walletManager.lockWallet();
  }
  
  // Disconnect native issuer
  try {
    await nativeIssuer.disconnect();
  } catch (e) {}
  
  console.log('[WALLETS-NATIVE] Cleanup complete');
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  initializeWalletServices,
  setupWalletHandlers,
  performSingleChainLock,
  performPermanentLock,
  cleanup,
  
  // Export for direct access
  getWalletManager: () => walletManager,
  getIPFSConfigManager: () => ipfsConfigManager,
  getIPFSPinner: () => ipfsPinner,
  getIPFSUploader: () => ipfsUploader,
  getArweaveManager: () => arweaveManager,
  getNativeIssuer: () => nativeIssuer,
  
  // Export config
  SERVICE_FEE_USD,
  TREASURY_ADDRESS
};
