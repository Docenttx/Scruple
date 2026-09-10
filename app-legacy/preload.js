/**
 * preload.js - Preload Script
 * * Exposes safe IPC bridge to renderer process.
 * Context isolation enabled - uses contextBridge.
 * * SCRUPLE V3 - AI Provenance Middleware
 * Patent Pending
 */

const { contextBridge, ipcRenderer, shell } = require('electron');

// Expose protected methods to renderer
contextBridge.exposeInMainWorld('scruple', {

  // ===========================================================================
  // HOST SEAM (WO-D1 onward) — ping, profile, capture, vault, ComfyUI,
  // Blender, receipts, credentials. These came from app/preload.js.
  //
  // ⚑ They are INLINE, and that is not a style choice. A preload script runs
  // sandboxed (contextIsolation: true, sandbox left at its default), and a
  // sandboxed preload's `require` reaches `electron` and a short allowlist of
  // built-ins — NOT a relative file beside it. Splitting these into
  // preload-host.js loaded silently as nothing: no throw, no warning, just a
  // `window.scruple` with no `ping` on it. The alternative was sandbox: false,
  // which trades a real boundary for a tidier file.
  //
  // Every entry is a channel into a main-process handler. Nothing is answered
  // here — a bridge that could answer in the renderer would make the D-series
  // gates a test of this file rather than of the app.
  // ===========================================================================

  host: 'electron',
  ping: (nonce) => ipcRenderer.invoke('scruple:ping', nonce),
  profile: () => ipcRenderer.invoke('scruple:profile'),
  blender: () => ipcRenderer.invoke('scruple:blender'),
  captureFile: (req) => ipcRenderer.invoke('scruple:capture-file', req),
  vaultCapture: (req) => ipcRenderer.invoke('scruple:vault-capture', req),
  blenderGenerate: (req) => ipcRenderer.invoke('scruple:blender-generate', req),
  comfyLaunch: () => ipcRenderer.invoke('scruple:comfy-launch'),
  comfyGenerate: (req) => ipcRenderer.invoke('scruple:comfy-generate', req),
  comfyStop: () => ipcRenderer.invoke('scruple:comfy-stop'),
  receipts: (req) => ipcRenderer.invoke('scruple:receipts', req),
  credential: (req) => ipcRenderer.invoke('scruple:credential', req),
  // WO-G2. §9.1 C2PA and §9.2 watermarking, put on one artifact at a lock.
  // ⚑ Watermarking is EU AI Act Art.50 Code of Practice — the PEER of C2PA,
  // not a part of it, and it must never borrow C2PA's conformance language.
  modalities: (req) => ipcRenderer.invoke('scruple:modalities', req),
  // WO-G6. The Blender Asset Tracer. `probe` asks whether it can run here,
  // `list` traces what a .blend depends on, `pack` relocates it AND records what
  // moved, `compare` asks whether anything has changed since it was witnessed.
  bat: (req) => ipcRenderer.invoke('scruple:bat', req),

  
  // ===========================================================================
  // STATE & SETUP
  // ===========================================================================
  
  getState: () => ipcRenderer.invoke('get-state'),
  setupComfyUIPath: (path) => ipcRenderer.invoke('setup-comfyui-path', path),
  setupPaths: (paths) => ipcRenderer.invoke('setup-paths', paths),
  browseFolder: () => ipcRenderer.invoke('browse-folder'),
  browseFile: (fileType) => ipcRenderer.invoke('browse-file', fileType),
  
  // ===========================================================================
  // PROJECT OPERATIONS
  // ===========================================================================
  
  getProjects: () => ipcRenderer.invoke('get-projects'),
  getProject: (id) => ipcRenderer.invoke('get-project', id),
  getIterations: (projectId) => ipcRenderer.invoke('get-iterations', projectId),
  readImage: (projectName, imageFilename) => ipcRenderer.invoke('read-image', projectName, imageFilename),
  createProject: (name, type) => ipcRenderer.invoke('create-project', name, type),
  archiveProject: (id) => ipcRenderer.invoke('archive-project', id),
  activateProject: (id) => ipcRenderer.invoke('activate-project', id),
  deactivateProject: () => ipcRenderer.invoke('deactivate-project'),
  
  // ===========================================================================
  // LOCK OPERATIONS
  // ===========================================================================
  
  localDiscLock: (projectId, authToken) => ipcRenderer.invoke('local-disc-lock', projectId, authToken),
  singleChainLock: (projectId, password) => ipcRenderer.invoke('single-chain-lock', projectId, password),
  persistentChainLock: (projectId) => ipcRenderer.invoke('persistent-chain-lock', projectId),
  checkpointProject: (projectId, authToken) => ipcRenderer.invoke('checkpoint-project', projectId, authToken),
  
  // ===========================================================================
  // STRIPE PAYMENT
  // ===========================================================================

  stripeGetConfig: () => ipcRenderer.invoke('stripe-get-config'),
  stripeCreatePaymentIntent: (action, projectId) => ipcRenderer.invoke('stripe-create-payment-intent', action, projectId),
  stripeConfirmAndExecute: (paymentIntentId, action, projectId, options) => ipcRenderer.invoke('stripe-confirm-and-execute', paymentIntentId, action, projectId, options),
  
  // ===========================================================================
  // TRAINING RUNS (Kohya_ss Integration)
  // ===========================================================================
  
  getTrainingRuns: (projectId) => ipcRenderer.invoke('get-training-runs', projectId),
  getAllTrainingRuns: () => ipcRenderer.invoke('get-all-training-runs'),
  getTrainingRun: (trainingId) => ipcRenderer.invoke('get-training-run', trainingId),
  lockTrainingRun: (trainingId, lockType, password) => ipcRenderer.invoke('lock-training-run', trainingId, lockType, password),
  detectKohyaPort: () => ipcRenderer.invoke('detect-kohya-port'),
  getCaptureStatus: () => ipcRenderer.invoke('get-capture-status'),
  
  // ===========================================================================
  // WITNESS SYSTEM
  // ===========================================================================
  
  getWitnessStatus: () => ipcRenderer.invoke('get-witness-status'),
  
  // ===========================================================================
  // INTERLOCK
  // ===========================================================================
  
  setInterlock: (busy) => ipcRenderer.invoke('set-interlock', busy),
  
  // ===========================================================================
  // RVN WALLET
  // ===========================================================================
  
  rvnWalletStatus: () => ipcRenderer.invoke('rvn-wallet-status'),
  rvnWalletCreate: (password) => ipcRenderer.invoke('rvn-wallet-create', password),
  rvnWalletImport: (mnemonic, password) => ipcRenderer.invoke('rvn-wallet-import', mnemonic, password),
  rvnWalletUnlock: (password) => ipcRenderer.invoke('rvn-wallet-unlock', password),
  rvnWalletLock: () => ipcRenderer.invoke('rvn-wallet-lock'),
  rvnWalletDelete: (confirmation) => ipcRenderer.invoke('rvn-wallet-delete', confirmation),
  rvnWalletVerifyPassword: (password) => ipcRenderer.invoke('rvn-wallet-verify-password', password),
  rvnGetBalance: () => ipcRenderer.invoke('rvn-get-balance'),
  rvnGetAddress: () => ipcRenderer.invoke('rvn-get-address'),
  rvnGetFeeQuote: () => ipcRenderer.invoke('rvn-get-fee-quote'),
  rvnGetCosts: () => ipcRenderer.invoke('rvn-get-costs'),
  rvnGetPrice: () => ipcRenderer.invoke('rvn-get-rvn-price'),
  rvnCheckAssetExists: (assetName) => ipcRenderer.invoke('rvn-check-asset-exists', assetName),
  rvnGetAssetData: (assetName) => ipcRenderer.invoke('rvn-get-asset-data', assetName),
  rvnVerifyProof: (scrId, merkleRoot) => ipcRenderer.invoke('rvn-verify-proof', scrId, merkleRoot),
  
  // ===========================================================================
  // IPFS CONFIG (Fixed!)
  // ===========================================================================
  
  ipfsGetConfig: () => ipcRenderer.invoke('ipfs-get-config'),
  ipfsSaveConfig: (config) => ipcRenderer.invoke('ipfs-save-config', config),
  ipfsTestConnection: () => ipcRenderer.invoke('ipfs-test-connection'),
  
  // ===========================================================================
  // ARWEAVE WALLET (Fixed!)
  // ===========================================================================
  
  arweaveImportKey: () => ipcRenderer.invoke('arweave-import-key'),
  arweaveGetStatus: () => ipcRenderer.invoke('arweave-get-status'),
  arweaveDisconnect: () => ipcRenderer.invoke('arweave-disconnect'),
  arweaveGetBalance: () => ipcRenderer.invoke('arweave-get-balance'),
  arweaveMintTestAr: () => ipcRenderer.invoke('arweave-mint-test-ar'),
  preflightTraining: (projectId) => ipcRenderer.invoke('preflight-training', projectId),
  
  // ===========================================================================
  // UTILITY
  // ===========================================================================
  
  // CHANGED: Use shell directly so links work without main process handlers
  openExternal: (url) => shell.openExternal(url),
  openFolder: (folderPath) => ipcRenderer.invoke('open-folder', folderPath),
  
  // ===========================================================================
  // EVENT LISTENERS
  // ===========================================================================
  
  on: (channel, callback) => {
    const validChannels = [
      'initialized',
      'needs-setup',
      'leaf-added',
      'leaf-error',
      'watcher-error',
      'interlock-changed',
      'project-changed',
      'tab-settings-changed',
      'log',
      // Training events
      'training-added',
      'training-complete',
      'training-error',
      'checkpoint-added',
      // Witness events
      'witness-status',
      // Preflight events
      'preflight-progress',
      'preflight-complete',
      // Kohya events
      'kohya-connected',
      'kohya-disconnected',
      // TOML watcher events
      'toml-detected',
      'training-run-created'
    ];
    
    if (validChannels.includes(channel)) {
      ipcRenderer.on(channel, (event, ...args) => callback(...args));
    }
  },
  
  off: (channel, callback) => {
    ipcRenderer.removeListener(channel, callback);
  },
  
  removeAllListeners: (channel) => {
    ipcRenderer.removeAllListeners(channel);
  }
});

console.log('[PRELOAD] Scruple API exposed to renderer');
