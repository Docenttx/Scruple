/**
 * main-modular.js - SCRUPLE Studio Main Process Entry Point
 *
 * Electron main process entry point.
 * Responsibilities:
 * - Window management
 * - Session ID generation
 * - File watcher initialization
 * - Internal HTTP server
 * - IPC handling (delegated to ipc/)
 * - Wallet integration (RVN, IPFS)
 * - Witness integration (tamper-proof provenance)
 *
 * SCRUPLE V3 - AI Provenance Middleware
 * Patent Pending
 */

const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const { SessionManager } = require('./capture/comfyui/session');
const { FileWatcher } = require('./capture/comfyui/watcher');
const { InternalServer } = require('./capture/comfyui/server');
const { ConfigManager } = require('./config/config-testnet');
const { DatabaseManager } = require('./database');
const { MerkleManager } = require('./lock/merkle');

// Wallet integration
const { cleanup: walletCleanup } = require('./wallet/ravencoin/wallets-integration-native-testnet');

// Training provenance (Kohya_ss integration)
const {
  computeDatasetMerkle,
  hashTrainingParams,
  hashSafetensorsHeader,
  preflightTrainingInputs,
  preflightBaseModel,
  quickVerifyFile,
  hashLargeFileWithWorker,
  cancelHashWorker,
  checkFileRegistry,
  registerFileHash
} = require('./capture/training/training-hasher');

// Witness integration (tamper-proof provenance)
const {
  initializeWitness,
  witnessIteration,
  lockProject: witnessLockProject,
  getStatus: getWitnessStatus,
  isOnline: isWitnessOnline,
  cleanup: witnessCleanup
} = require('./server/witness-index');

// Shared context (holds initialized managers for extracted modules)
const ctx = require('./context');

// Lock operations
const {
  performLocalDiscLock,
  performSingleChainLock,
  performPersistentChainLock,
  buildScruplePackage
} = require('./lock/lock-barrel');

// Training operations
const {
  startTomlWatcher,
  stopTomlWatcher
} = require('./capture/training/training-barrel');

// IPC handler registration
const { setupAllIpcHandlers } = require('./ipc/ipc-barrel');

// Keep global references
let mainWindow = null;
let sessionManager = null;
let fileWatcher = null;
let internalServer = null;
let configManager = null;
let databaseManager = null;
let merkleManager = null;

// ============================================================================
// WINDOW CREATION
// ============================================================================

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 900,
    minWidth: 1200,
    minHeight: 700,
    title: 'SCRUPLE Studio',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true  // Enable webview for ComfyUI
    },
    show: false,  // Don't show until ready
    backgroundColor: '#0a0f1c'
  });

  // Load the renderer
  mainWindow.loadFile(path.join(__dirname, 'index-final.html'));

  // Show when ready
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Handle close
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Open DevTools in dev mode
  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }
}

// ============================================================================
// INITIALIZATION
// ============================================================================

async function initialize() {
  log('Initializing SCRUPLE Studio...');

  // Initialize config manager (must happen first, setup wizard needs it)
  if (!configManager) {
    configManager = new ConfigManager();
  }
  const config = configManager.load();

  // Check if first run
  if (!config.comfyUIPath) {
    log('First run detected - setup required');
    return { needsSetup: true };
  }

  // Validate ComfyUI path still exists
  if (!fs.existsSync(config.comfyUIPath)) {
    log('ComfyUI path no longer exists: ' + config.comfyUIPath);
    return { needsSetup: true, error: 'ComfyUI path not found' };
  }

  // Initialize database
  databaseManager = new DatabaseManager(config.scrupleHome);
  await databaseManager.initialize();

  // Initialize Merkle manager
  merkleManager = new MerkleManager(databaseManager);

  // Register DB in shared context NOW — before any async operations that
  // could delay the full ctx population. The renderer may call get-projects
  // via IPC while initializeWitness() is timing out (up to 2 seconds),
  // and the handler guards on ctx.get('databaseManager'). Setting it here
  // ensures those early IPC calls return real data instead of [].
  ctx.set('databaseManager', databaseManager);
  ctx.set('merkleManager', merkleManager);
  ctx.set('mainWindow', mainWindow);

  // Initialize witness system (tamper-proof provenance)
  const witnessInitialized = await initializeWitness();
  if (witnessInitialized) {
    log('Witness system initialized');
  } else {
    log('Witness system offline - iterations will not be witnessed', 'warn');
  }

  // Initialize session manager (writes scruple_session.txt)
  sessionManager = new SessionManager(config.comfyUIPath);
  const sessionId = sessionManager.createSession();
  log('Session created: ' + sessionId);

  // Initialize internal HTTP server (auto-find port)
  internalServer = new InternalServer();
  const port = await internalServer.start();
  log('Internal server started on port: ' + port);

  // Sync active project to server (if any)
  const activeProject = databaseManager.getActiveProject();
  if (activeProject) {
    const outputPath = path.join(config.comfyUIPath, 'output', 'terminal_provenance');
    internalServer.setActiveProject(activeProject.name, outputPath);
    log('Restored active project: ' + activeProject.name);
    // For training projects: restore TOML watcher for vault folder
    if (activeProject.type === 'training' && activeProject.vault_path) {
      if (fs.existsSync(activeProject.vault_path)) {
        startTomlWatcher(activeProject.vault_path);
        log('TOML watcher restored for training vault: ' + activeProject.vault_path);
      }
    }
  }

  // Initialize file watcher
  const watchPath = path.join(config.comfyUIPath, 'output', 'terminal_provenance');
  fileWatcher = new FileWatcher(watchPath, sessionManager.getSessionId());

  fileWatcher.on('leaf', async (leafData) => {
    await handleNewLeaf(leafData);
  });

  fileWatcher.on('error', (error) => {
    log('Watcher error: ' + error.message, 'error');
    sendToRenderer('watcher-error', { error: error.message });
  });

  await fileWatcher.start();
  log('File watcher started: ' + watchPath);

  // Initialize TOML watcher for training (if output dir configured)
  console.log('[MAIN] Checking TOML watcher - trainingOutputDir:', config.trainingOutputDir);
  console.log('[MAIN] trainingOutputDir exists:', config.trainingOutputDir ? fs.existsSync(config.trainingOutputDir) : 'N/A');
  if (config.trainingOutputDir && fs.existsSync(config.trainingOutputDir)) {
    console.log('[MAIN] Starting TOML watcher...');
    startTomlWatcher(config.trainingOutputDir);
    log('TOML watcher started: ' + config.trainingOutputDir);
  } else {
    console.log('[MAIN] TOML watcher NOT started - no valid trainingOutputDir');
  }

  // Populate shared context for extracted modules
  ctx.set('configManager', configManager);
  ctx.set('databaseManager', databaseManager);
  ctx.set('merkleManager', merkleManager);
  ctx.set('mainWindow', mainWindow);
  ctx.set('internalServer', internalServer);
  ctx.set('sessionManager', sessionManager);
  ctx.set('fileWatcher', fileWatcher);

  return {
    needsSetup: false,
    sessionId,
    port,
    config
  };
}

// ============================================================================
// LEAF HANDLING (Merkle Tree Updates)
// ============================================================================

async function handleNewLeaf(leafData) {
  log('New leaf received: ' + leafData.leaf_hash.substring(0, 16) + '...');

  try {
    // Get or create project
    const projectName = leafData.project_name || 'Default_Project';
    let project = databaseManager.getProjectByName(projectName);

    if (!project) {
      project = databaseManager.createProject(projectName);
      log('Created new project: ' + projectName);
    }

    // Check project isn't locked
    if (project.status !== 'unlocked') {
      log('Project is locked, ignoring leaf: ' + projectName, 'warn');
      return;
    }

    // Add iteration to database
    const iteration = databaseManager.addIteration(project.id, leafData);

    // Update Merkle tree
    const newRoot = merkleManager.addLeaf(project.id, leafData.leaf_hash);

    // Derive potential SCR ID
    const potentialScrId = 'SCR_' + newRoot.substring(0, 6).toUpperCase();

    // =========================================================================
    // WITNESS: Record this iteration with witness server
    // =========================================================================
    const witnessRecord = await witnessIteration({
      projectId: project.id,
      projectName: projectName,
      runSequence: iteration.run_sequence,
      contentHash: leafData.leaf_hash,
      visualHash: leafData.leaf_hash,
      timestamp: leafData.timestamp,
      preScrId: project.pre_scr_id || null,
      installationId: configManager.getInstallationId()
    });

    // Update iteration with witness status
    if (witnessRecord) {
      databaseManager.updateIteration(iteration.id, {
        witnessed: 1,
        witness_id: witnessRecord.witness_id,
        witness_timestamp: witnessRecord.server_timestamp,
        witness_signature: witnessRecord.signature
      });
    } else {
      log(`[WITNESS] Iteration ${iteration.run_sequence} NOT witnessed (offline)`, 'warn');
    }

    // Update UI
    sendToRenderer('leaf-added', {
      projectName,
      iteration: iteration.run_sequence,
      leafHash: leafData.leaf_hash,
      merkleRoot: newRoot,
      potentialScrId,
      timestamp: leafData.timestamp,
      witnessed: witnessRecord !== null
    });

    log('Leaf added to project ' + projectName + ', new root: ' + newRoot.substring(0, 16) + '...');

  } catch (error) {
    log('Error handling leaf: ' + error.message, 'error');
    sendToRenderer('leaf-error', { error: error.message });
  }
}

// ============================================================================
// IPC HANDLERS — extracted to ipc/
// See: ipc/ipc-settings-handlers.js, ipc/ipc-project-handlers.js,
//      ipc/ipc-lock-handlers.js, ipc/ipc-training-handlers.js, ipc/ipc-wallet-handlers.js
// ============================================================================

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function sendToRenderer(channel, data) {
  if (mainWindow && mainWindow.webContents) {
    mainWindow.webContents.send(channel, data);
  }
}

function notifyWebviewProjectChange(projectName) {
  // Send to renderer, which will inject into webview
  sendToRenderer('project-changed', { projectName });
}

function log(message, level) {
  level = level || 'info';
  const timestamp = new Date().toISOString();
  const logMessage = '[' + timestamp + '] [' + level.toUpperCase() + '] ' + message;
  console.log(logMessage);

  // Send to renderer debug console
  sendToRenderer('log', { timestamp: timestamp, level: level, message: message });
}

// ============================================================================
// APPLICATION MENU
// ============================================================================

function setupMenu() {
  const config = configManager.load();
  const comfyEnabled = config.comfyUIEnabled !== false;   // default true
  const kohyaEnabled = config.kohyaEnabled === true;      // default false
  const rvnMode = config.beta?.rvnMode || 'auto';         // 'auto'=fiat, 'user'=blockchain
  const fiatEnabled = rvnMode === 'auto';
  const blockchainEnabled = rvnMode === 'user';

  function emitTabSettings() {
    const currentMode = configManager.get('beta')?.rvnMode || 'auto';
    sendToRenderer('tab-settings-changed', {
      comfyUIEnabled: configManager.get('comfyUIEnabled') !== false,
      kohyaEnabled: configManager.get('kohyaEnabled') === true,
      fiatEnabled: currentMode === 'auto',
      blockchainEnabled: currentMode === 'user',
      walletMode: currentMode === 'auto' ? 'fiat' : 'blockchain'
    });
  }

  const template = [
    {
      label: 'File',
      submenu: [
        { role: 'quit' }
      ]
    },
    {
      label: 'Window',
      submenu: [
        {
          label: 'Show ComfyUI Tab',
          type: 'checkbox',
          checked: comfyEnabled,
          click(menuItem) {
            configManager.set('comfyUIEnabled', menuItem.checked);
            configManager.save();
            emitTabSettings();
          }
        },
        {
          label: 'Show Kohya Tab',
          type: 'checkbox',
          checked: kohyaEnabled,
          click(menuItem) {
            configManager.set('kohyaEnabled', menuItem.checked);
            configManager.save();
            emitTabSettings();
          }
        },
        { type: 'separator' },
        {
          label: 'Payment Mode: Fiat / TSD',
          type: 'radio',
          checked: fiatEnabled,
          click() {
            const beta = configManager.get('beta') || {};
            beta.rvnMode = 'auto';
            configManager.set('beta', beta);
            configManager.save();
            setupMenu(); // rebuild menu to update radio state
            sendToRenderer('tab-settings-changed', {
              comfyUIEnabled: configManager.get('comfyUIEnabled') !== false,
              kohyaEnabled: configManager.get('kohyaEnabled') === true,
              fiatEnabled: true,
              blockchainEnabled: false,
              walletMode: 'fiat'
            });
          }
        },
        {
          label: 'Payment Mode: Blockchain / RVN',
          type: 'radio',
          checked: blockchainEnabled,
          click() {
            const beta = configManager.get('beta') || {};
            beta.rvnMode = 'user';
            configManager.set('beta', beta);
            configManager.save();
            setupMenu(); // rebuild menu to update radio state
            sendToRenderer('tab-settings-changed', {
              comfyUIEnabled: configManager.get('comfyUIEnabled') !== false,
              kohyaEnabled: configManager.get('kohyaEnabled') === true,
              fiatEnabled: false,
              blockchainEnabled: true,
              walletMode: 'blockchain'
            });
          }
        }
      ]
    },
    {
      label: 'Dev',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' }
      ]
    }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ============================================================================
// APP LIFECYCLE
// ============================================================================

app.whenReady().then(async () => {
  // Initialize config manager FIRST (needed by wallet handlers)
  configManager = new ConfigManager();
  ctx.set('configManager', configManager);

  setupAllIpcHandlers({ initialize, sendToRenderer, notifyWebviewProjectChange });
  await createWindow();
  setupMenu();

  const config = configManager.load();

  // Check if any path is configured (comfyUI or Kohya)
  const hasAnyPath = config.comfyUIPath || config.trainingOutputDir;

  if (hasAnyPath) {
    const result = await initialize();
    sendToRenderer('initialized', result);
  } else {
    sendToRenderer('needs-setup', {});
  }
});

app.on('window-all-closed', async () => {
  // Cleanup
  if (fileWatcher) fileWatcher.stop();
  if (internalServer) internalServer.stop();
  if (databaseManager) databaseManager.close();

  // Cleanup training file watchers
  const watchers = ctx.get('trainingOutputWatchers');
  for (const [key, watcher] of watchers) {
    try {
      watcher.close();
    } catch (e) {}
  }
  watchers.clear();

  // Cleanup TOML watcher
  stopTomlWatcher();

  // Wallet cleanup
  try {
    await walletCleanup();
  } catch (e) {}

  // Witness cleanup
  try {
    await witnessCleanup();
  } catch (e) {}

  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
