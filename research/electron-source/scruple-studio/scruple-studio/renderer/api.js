/**
 * api.js - SCRUPLE Studio API Layer
 *
 * Utility functions, IPC API wrappers, wallet API functions,
 * and IPC event listener setup.
 *
 * Depends on: state.js (State must be loaded first)
 *
 * SCRUPLE Studio — Patent Pending
 */

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function addLog(level, message) {
  const logs = State.get('logs') || [];
  const entry = {
    id: Date.now() + Math.random(),
    timestamp: new Date().toLocaleTimeString(),
    level,
    message
  };
  const newLogs = [...logs.slice(-99), entry];
  
  // Use silent update to avoid full re-render (preserves input focus)
  State.setSilent('logs', newLogs);
  
  // Directly update the debug console if it exists
  appendLogEntry(entry);
}

// Directly append a log entry to the debug console without re-rendering
function appendLogEntry(entry) {
  const logContainer = document.querySelector('.debug-console .log-entries');
  if (!logContainer) return;
  
  const entryHtml = `
    <div class="log-entry ${entry.level}">
      <span class="log-time">${entry.timestamp}</span>
      <span class="log-level">[${entry.level.toUpperCase()}]</span>
      <span class="log-message">${escapeHtml(entry.message)}</span>
    </div>
  `;
  logContainer.insertAdjacentHTML('beforeend', entryHtml);
  
  // Auto-scroll to bottom
  logContainer.scrollTop = logContainer.scrollHeight;
  
  // Trim old entries from DOM if too many
  while (logContainer.children.length > 100) {
    logContainer.removeChild(logContainer.firstChild);
  }
}

function truncateAddress(addr) {
  if (!addr || addr.length < 16) return addr || '';
  return addr.substring(0, 8) + '...' + addr.substring(addr.length - 6);
}

function truncateHash(hash) {
  if (!hash || hash.length < 20) return hash || '';
  return hash.substring(0, 12) + '...' + hash.substring(hash.length - 6);
}

function formatRvnBalance(balance) {
  if (balance === null || balance === undefined) return '0.00 RVN';
  // Handle new object format { confirmedRVN, ... }
  if (typeof balance === 'object' && balance.confirmedRVN !== undefined) {
    return balance.confirmedRVN.toFixed(2) + ' RVN';
  }
  // Handle old number format
  if (typeof balance === 'number') {
    return balance.toFixed(2) + ' RVN';
  }
  return '0.00 RVN';
}

function copyToClipboard(text) {
  navigator.clipboard.writeText(text);
  addLog('info', 'Copied to clipboard');
}

// ============================================================================
// API FUNCTIONS
// ============================================================================

async function initializeApp() {
  console.log('[RENDERER] initializeApp starting...');
  try {
    console.log('[RENDERER] Calling getState...');
    const state = await window.scruple.getState();
    console.log('[RENDERER] getState returned:', state);
    State.set('needsSetup', state.needsSetup);
    State.set('sessionId', state.sessionId);
    State.set('port', state.port);
    State.set('config', state.config);
    // Set tab visibility from config
    State.set('comfyUIEnabled', state.config?.comfyUIEnabled !== false);
    State.set('kohyaEnabled', state.config?.kohyaEnabled === true);
    // Legacy keys — kept for compatibility with bundle-final.js and other readers
    State.set('testnetEnabled', state.config?.testnetEnabled !== false);
    State.set('mainnetEnabled', state.config?.mainnetEnabled === true);
    // Derive fiat/blockchain mode from beta.rvnMode
    const rvnMode = state.config?.beta?.rvnMode || 'auto';
    State.set('fiatEnabled', rvnMode === 'auto');
    State.set('blockchainEnabled', rvnMode === 'user');
    State.set('walletMode', rvnMode === 'auto' ? 'fiat' : 'blockchain');
    State.set('currentView', 'workspace');
    State.set('isLoading', false);
    console.log('[RENDERER] isLoading set to false');
    addLog('info', 'App initialized');
    
    if (!state.needsSetup) {
      await fetchProjects();
      // Try to detect Kohya port
      detectKohyaPort();
    }
  } catch (error) {
    console.error('[RENDERER] initializeApp error:', error);
    addLog('error', 'Failed to initialize: ' + error.message);
    State.set('isLoading', false);
  }
}

async function fetchProjects() {
  try {
    const projects = await window.scruple.getProjects();
    State.set('projects', projects);
    
    const active = projects.find(p => p.is_active);
    if (active) {
      const details = await window.scruple.getProject(active.id);
      State.set('activeProject', details);
    }
  } catch (error) {
    addLog('error', 'Failed to fetch projects: ' + error.message);
  }
}

async function setupComfyPath(path) {
  State.set('isLoading', true);
  try {
    const result = await window.scruple.setupComfyUIPath(path);
    if (result.success) {
      State.set('needsSetup', false);
      State.set('sessionId', result.sessionId);
      State.set('port', result.port);
      State.set('config', result.config);
      addLog('info', 'Setup complete');
      await fetchProjects();
    } else {
      addLog('error', 'Setup failed: ' + result.error);
    }
  } catch (error) {
    addLog('error', 'Setup error: ' + error.message);
  }
  State.set('isLoading', false);
}

async function setupPaths(paths) {
  console.log('[RENDERER] setupPaths called with:', paths);
  // Don't use State.set('isLoading') here - it would destroy the form
  try {
    console.log('[RENDERER] Calling window.scruple.setupPaths...');
    const result = await window.scruple.setupPaths(paths);
    console.log('[RENDERER] setupPaths result:', result);
    if (result.success) {
      State.set('sessionId', result.sessionId);
      State.set('port', result.port);
      State.set('config', result.config);
      addLog('info', 'Setup complete');
      await fetchProjects();
      // Set needsSetup last to trigger re-render to main app
      State.set('needsSetup', false);
    } else {
      addLog('error', 'Setup failed: ' + result.error);
      const errorEl = document.getElementById('setup-error');
      const submitBtn = document.getElementById('submit-btn');
      if (errorEl) {
        errorEl.textContent = result.error;
        errorEl.style.display = 'block';
      }
      if (submitBtn) {
        submitBtn.textContent = 'Complete Setup';
        submitBtn.disabled = false;
      }
    }
  } catch (error) {
    console.error('[RENDERER] setupPaths error:', error);
    addLog('error', 'Setup error: ' + error.message);
    const errorEl = document.getElementById('setup-error');
    const submitBtn = document.getElementById('submit-btn');
    if (errorEl) {
      errorEl.textContent = error.message;
      errorEl.style.display = 'block';
    }
    if (submitBtn) {
      submitBtn.textContent = 'Complete Setup';
      submitBtn.disabled = false;
    }
  }
}

async function activateProjectTracking(project) {
  try {
    await window.scruple.activateProject(project.id);
    const details = await window.scruple.getProject(project.id);
    State.set('activeProject', details);
    State.set('selectedProject', details);
    await fetchIterations(project.id);
    await fetchTrainingRuns(project.id);
    addLog('info', 'Activated project: ' + project.name);
    await fetchProjects();
  } catch (error) {
    addLog('error', 'Failed to activate project: ' + error.message);
  }
}

async function viewProject(project) {
  try {
    const details = await window.scruple.getProject(project.id);
    State.set('selectedProject', details);
    await fetchIterations(project.id);
    await fetchTrainingRuns(project.id);
    State.set('currentView', 'workspace');
    addLog('info', 'Viewing project: ' + project.name);
  } catch (error) {
    addLog('error', 'Failed to view project: ' + error.message);
  }
}

async function deactivateProject() {
  try {
    await window.scruple.deactivateProject();
    State.set('activeProject', null);
    const selectedProject = State.get('selectedProject');
    const activeProject = State.get('activeProject');
    if (!selectedProject || (activeProject && selectedProject.id === activeProject.id)) {
      State.set('iterations', []);
      State.set('trainingRuns', []);
      State.set('selectedProject', null);
    }
    addLog('info', 'Stopped active project');
    await fetchProjects();
  } catch (error) {
    addLog('error', 'Failed to stop project: ' + error.message);
  }
}

async function fetchIterations(projectId) {
  try {
    const iterations = await window.scruple.getIterations(projectId);
    State.set('iterations', iterations || []);
  } catch (error) {
    addLog('error', 'Failed to fetch iterations: ' + error.message);
    State.set('iterations', []);
  }
}

async function fetchTrainingRuns(projectId) {
  try {
    console.log('[RENDERER] Fetching training runs for project:', projectId);
    const trainingRuns = await window.scruple.getTrainingRuns(projectId);
    console.log('[RENDERER] Training runs fetched:', trainingRuns);
    State.set('trainingRuns', trainingRuns || []);
  } catch (error) {
    console.error('[RENDERER] Failed to fetch training runs:', error);
    addLog('error', 'Failed to fetch training runs: ' + error.message);
    State.set('trainingRuns', []);
  }
}

let detectingKohya = false;

async function detectKohyaPort() {
  if (detectingKohya) return;
  detectingKohya = true;
  
  try {
    const result = await window.scruple.detectKohyaPort();
    if (result.detected) {
      State.set('kohyaPort', result.port);
      addLog('info', 'Kohya_ss detected on port ' + result.port);
      // Force full re-render to show webview
      document.querySelector('.app-container')?.remove();
      renderApp();
    }
  } catch (error) {
    // Kohya not running, that's OK
  } finally {
    detectingKohya = false;
  }
}

async function createProject(name, type = 'txt2img') {
  try {
    const result = await window.scruple.createProject(name, type);
    if (result.success) {
      addLog('info', 'Created project: ' + name + ' (' + type + ')');
      
      // For training projects, show vault path popup
      if (result.isTraining && result.vaultPath) {
        addLog('info', 'Training output folder: ' + result.vaultPath);
        State.set('trainingVaultPath', result.vaultPath);
        State.set('walletModal', 'training-folder-info');
      }
      
      await fetchProjects();
      await viewProject(result.project);
      return result.project;
    } else {
      addLog('error', 'Failed to create project: ' + result.error);
    }
  } catch (error) {
    addLog('error', 'Create project error: ' + error.message);
  }
  return null;
}

async function performLock(lockType) {
  const selectedProject = State.get('selectedProject');
  if (!selectedProject) {
    addLog('error', 'No project selected to lock');
    return;
  }

  addLog('info', `Starting ${lockType} lock for ${selectedProject.name}...`);

  try {
    let result;
    switch (lockType) {
      case 'local':
        result = await window.scruple.localDiscLock(selectedProject.id);
        break;
      case 'chain':
        // Show confirmation modal - actual lock happens in form handler
        State.set('pendingLockProject', selectedProject);
        State.set('walletModal', 'confirm-chain-lock');
        return; // Exit early, form handler will complete the lock
          }

    if (result.success) {
      addLog('info', `${lockType} lock complete: ${result.scrId}`);
      if (result.mock) {
        addLog('warn', '(Mock transaction - real minting not implemented yet)');
      }
      await fetchProjects();
      const details = await window.scruple.getProject(selectedProject.id);
      State.set('selectedProject', details);
      const activeProject = State.get('activeProject');
      if (activeProject && activeProject.id === selectedProject.id) {
        State.set('activeProject', details);
      }
    } else {
      addLog('error', `${lockType} lock failed: ${result.error}`);
    }
  } catch (error) {
    addLog('error', `${lockType} lock error: ${error.message}`);
  }
}

/**
 * Start pre-flight verification for training inputs (Phase 7)
 */
async function startPreflight() {
  addLog('info', 'Starting pre-flight verification...');
  State.set('preflightRunning', true);
  State.set('preflightStatus', { started: new Date().toISOString() });
  
  try {
    // Get current training configuration from Kohya webview
    // For now, just trigger with empty inputs to test the flow
    const result = await window.scruple.preflightTraining({
      // These would come from the Kohya form
      // baseModelPath: null,
      // datasetPath: null,
      // checkpointPath: null
    });
    
    if (result.success) {
      addLog('info', 'Pre-flight verification complete');
    } else {
      addLog('warn', 'Pre-flight failed: ' + result.error);
    }
  } catch (error) {
    addLog('error', 'Pre-flight error: ' + error.message);
    State.set('preflightRunning', false);
  }
}

// Make startPreflight available globally
window.startPreflight = startPreflight;

async function performTrainingLock(trainingId, lockType) {
  addLog('info', `Starting ${lockType} lock for training run #${trainingId}...`);

  try {
    let password = null;
    if (lockType === 'chain') {
      // Show password modal
      State.set('pendingTrainingLock', { trainingId, lockType });
      State.set('walletModal', 'confirm-training-lock');
      return;
    }

    const result = await window.scruple.lockTrainingRun(trainingId, lockType, password);

    if (result.success) {
      addLog('info', `Training ${lockType} lock complete: ${result.scrId}`);
      if (result.mock) {
        addLog('warn', '(Mock transaction)');
      }
      const selectedProject = State.get('selectedProject');
      if (selectedProject) {
        await fetchTrainingRuns(selectedProject.id);
      }
    } else {
      addLog('error', `Training lock failed: ${result.error}`);
    }
  } catch (error) {
    addLog('error', `Training lock error: ${error.message}`);
  }
}

async function executeChainLock(projectId, password, authToken, lockTier) {
  const selectedProject = State.get('selectedProject');
  addLog('info', `Executing chain lock for project ${projectId}...`);
  
  // Show progress modal
  State.set('walletModal', 'chain-lock-progress');
  
  try {
    // fiat mode: authToken present, Oracle executes the chain lock
    // blockchain mode: password present, local RVN wallet signs
    const result = authToken
      ? await window.scruple.singleChainLock(projectId, authToken, lockTier)
      : await window.scruple.singleChainLock(projectId, password);
    
    if (result.success) {
      addLog('info', `Chain lock complete: ${result.scrId}`);
      // Store result and show success modal - don't update state until user acknowledges
      State.set('chainLockResult', {
        projectId,
        scrId: result.scrId,
        txId: result.proofTxId,
        merkleRoot: result.merkleRoot,
        ipfsCid: result.ipfsCid,
        ipfsError: result.ipfsError,
        arweaveTxId: result.arweaveTxId,
        arweaveError: result.arweaveError,
        costs: result.costs
      });
      State.set('walletModal', 'chain-lock-success');
    } else {
      addLog('error', `Chain lock failed: ${result.error}`);
      // Show error modal
      State.set('chainLockError', result);
      State.set('walletModal', 'chain-lock-error');
    }
  } catch (error) {
    addLog('error', `Chain lock error: ${error.message}`);
    State.set('chainLockError', error.message);
    State.set('walletModal', 'chain-lock-error');
  }
}

async function acknowledgeChainLockSuccess() {
  const result = State.get('chainLockResult');
  if (result) {
    await fetchProjects();
    const details = await window.scruple.getProject(result.projectId);
    State.set('selectedProject', details);
    const activeProject = State.get('activeProject');
    if (activeProject && activeProject.id === result.projectId) {
      State.set('activeProject', details);
    }
  }
  State.set('chainLockResult', null);
  State.set('walletModal', null);
}


async function executeTrainingChainLock(trainingId, password) {
  addLog('info', `Executing chain lock for training #${trainingId}...`);
  
  try {
    const result = await window.scruple.lockTrainingRun(trainingId, 'chain', password);
    
    if (result.success) {
      addLog('info', `Training chain lock complete: ${result.scrId}`);
      const selectedProject = State.get('selectedProject');
      if (selectedProject) {
        await fetchTrainingRuns(selectedProject.id);
      }
    } else {
      addLog('error', `Training chain lock failed: ${result.error}`);
    }
  } catch (error) {
    addLog('error', `Training chain lock error: ${error.message}`);
  }
}

// ============================================================================
// WALLET API FUNCTIONS
// ============================================================================

async function refreshRvnWallet() {
  State.set('rvnLoading', true);
  try {
    const status = await window.scruple.rvnWalletStatus();
    State.set('rvnStatus', status);
    if (status.isUnlocked) {
      try {
        const costs = await window.scruple.rvnGetCosts();
        const current = State.get('rvnStatus');
        State.set('rvnStatus', { ...current, costs });
      } catch (e) {}
    }
  } catch (error) {
    addLog('error', 'Failed to get RVN status: ' + error.message);
  }
  State.set('rvnLoading', false);
}

async function createRvnWallet(password) {
  try {
    const result = await window.scruple.rvnWalletCreate(password);
    if (result.success) {
      State.set('walletModalData', { mnemonic: result.mnemonic, address: result.address });
      State.set('walletModal', 'rvn-mnemonic');
      addLog('info', 'RVN wallet created: ' + result.address);
    } else {
      alert('Failed to create wallet: ' + result.error);
    }
  } catch (error) {
    alert('Error: ' + error.message);
  }
}

async function importRvnWallet(mnemonic, password) {
  try {
    const result = await window.scruple.rvnWalletImport(mnemonic, password);
    if (result.success) {
      State.set('walletModal', null);
      await refreshRvnWallet();
      addLog('info', 'RVN wallet imported: ' + result.address);
    } else {
      alert('Import failed: ' + result.error);
    }
  } catch (error) {
    alert('Error: ' + error.message);
  }
}

async function unlockRvnWallet(password) {
  try {
    const result = await window.scruple.rvnWalletUnlock(password);
    if (result.success) {
      State.set('walletModal', null);
      await refreshRvnWallet();
      addLog('info', 'RVN wallet unlocked');
    } else {
      alert('Incorrect password');
    }
  } catch (error) {
    alert('Error: ' + error.message);
  }
}

async function lockRvnWallet() {
  await window.scruple.rvnWalletLock();
  await refreshRvnWallet();
  addLog('info', 'RVN wallet locked');
}

async function deleteRvnWallet() {
  if (!confirm('Are you sure? This cannot be undone. Make sure you have your recovery phrase!')) {
    return;
  }
  const result = await window.scruple.rvnWalletDelete('DELETE MY WALLET');
  if (result.success) {
    State.set('walletModal', null);
    await refreshRvnWallet();
    addLog('info', 'RVN wallet deleted');
  } else {
    alert('Failed to delete: ' + result.error);
  }
}

async function refreshArweave() {
  try {
    const status = await window.scruple.arweaveGetStatus();
    if (status.connected && status.address) {
      State.set('arweaveConnected', true);
      State.set('arweaveAddress', status.address);
      State.set('arweaveBalance', status.balance || 0);
    } else {
      State.set('arweaveConnected', false);
      State.set('arweaveAddress', null);
      State.set('arweaveBalance', 0);
    }
  } catch (error) {
    State.set('arweaveConnected', false);
  }
}

async function connectArweave() {
  try {
    addLog('info', 'Importing Arweave keyfile...');
    const result = await window.scruple.arweaveImportKey();
    
    if (result.success) {
      State.set('arweaveConnected', true);
      State.set('arweaveAddress', result.address);
      State.set('arweaveBalance', result.balance || 0);
      addLog('info', 'Arweave wallet imported: ' + result.address);
      renderApp();
    } else if (result.error !== 'Cancelled') {
      alert('Failed to import keyfile: ' + result.error);
    }
  } catch (error) {
    alert('Error importing wallet: ' + error.message);
  }
}

async function mintTestAr() {
  try {
    const address = State.get('arweaveAddress');
    if (!address) {
      alert('No Arweave address connected');
      return;
    }
    addLog('info', 'Minting 10 test AR to ' + address + '...');
    const result = await window.scruple.arweaveMintTestAr(address, 10000000000000);
    if (result.success) {
      addLog('info', 'Minted 10 test AR successfully');
      await refreshArweave();
    } else {
      addLog('error', 'Mint failed: ' + (result.error || 'Unknown error'));
    }
  } catch (error) {
    addLog('error', 'Mint error: ' + error.message);
  }
}

async function disconnectArweave() {
  try {
    await window.scruple.arweaveDisconnect();
    State.set('arweaveConnected', false);
    State.set('arweaveAddress', null);
    State.set('arweaveBalance', 0);
    addLog('info', 'Arweave wallet disconnected');
    renderApp();
  } catch (error) {
    console.error('Disconnect error:', error);
  }
}

async function refreshIpfs() {
  try {
    const config = await window.scruple.ipfsGetConfig();
    State.set('ipfsConfig', config);
  } catch (error) {
    addLog('error', 'Failed to get IPFS config');
  }
}

async function saveIpfsConfig(config) {
  try {
    const result = await window.scruple.ipfsSaveConfig(config);
    if (result.success) {
      State.set('walletModal', null);
      await refreshIpfs();
      addLog('info', 'IPFS configuration saved');
    }
  } catch (error) {
    alert('Failed to save: ' + error.message);
  }
}

async function testIpfsConnection() {
  try {
    addLog('info', 'Testing IPFS connection...');
    const result = await window.scruple.ipfsTestConnection();
    if (result.success) {
      addLog('info', 'IPFS connection successful');
      alert('IPFS connection successful!');
    } else {
      addLog('error', 'IPFS test failed: ' + result.error);
      alert('IPFS test failed: ' + result.error);
    }
  } catch (error) {
    alert('Error: ' + error.message);
  }
}

async function refreshAllWallets() {
  await Promise.all([
    refreshRvnWallet(),
    refreshArweave(),
    refreshIpfs()
  ]);
}

// ============================================================================
// EVENT LISTENERS
// ============================================================================

function setupEventListeners() {
  window.scruple.on('initialized', async (data) => {
    State.set('needsSetup', data.needsSetup);
    State.set('sessionId', data.sessionId);
    State.set('port', data.port);
    State.set('config', data.config);
    // Derive tab/wallet mode from config (mirrors initializeApp logic)
    if (data.config) {
      State.set('comfyUIEnabled', data.config.comfyUIEnabled !== false);
      State.set('kohyaEnabled', data.config.kohyaEnabled === true);
      const rvnMode = data.config.beta?.rvnMode || 'auto';
      State.set('fiatEnabled', rvnMode === 'auto');
      State.set('blockchainEnabled', rvnMode === 'user');
      State.set('walletMode', rvnMode === 'auto' ? 'fiat' : 'blockchain');
    }
    addLog('info', 'System initialized');
    // 'initialized' fires only after main process completes initialize(),
    // guaranteeing databaseManager is in ctx. Fetch projects here to fix
    // the race condition where initializeApp()'s fetchProjects() fires
    // before the DB is ready and gets an empty list.
    if (!data.needsSetup) {
      await fetchProjects();
      detectKohyaPort();
    }
  });

  window.scruple.on('needs-setup', () => {
    State.set('needsSetup', true);
  });

  window.scruple.on('leaf-added', async (data) => {
    addLog('info', `Leaf added to ${data.projectName} (Run #${data.iteration})`);
    addLog('info', `New root: ${data.merkleRoot.substring(0, 16)}... -> ${data.potentialScrId}`);
    await fetchProjects();
    
    const activeProject = State.get('activeProject');
    const selectedProject = State.get('selectedProject');
    
    if (activeProject && activeProject.name === data.projectName) {
      const details = await window.scruple.getProject(activeProject.id);
      State.set('activeProject', details);
      
      if (selectedProject && selectedProject.id === activeProject.id) {
        State.set('selectedProject', details);
      }
      
      await fetchIterations(activeProject.id);
    }
  });

  window.scruple.on('interlock-changed', (data) => {
    State.set('isInterlocked', data.busy);
    addLog('info', data.busy ? 'UI frozen - generating...' : 'UI released');
  });

  window.scruple.on('tab-settings-changed', (data) => {
    State.set('comfyUIEnabled', data.comfyUIEnabled);
    State.set('kohyaEnabled', data.kohyaEnabled);
    if (data.fiatEnabled !== undefined) State.set('fiatEnabled', data.fiatEnabled);
    if (data.blockchainEnabled !== undefined) State.set('blockchainEnabled', data.blockchainEnabled);
    if (data.walletMode !== undefined) State.set('walletMode', data.walletMode);
    // If current view is wallet and now hidden, switch to workspace
    const currentView = State.get('currentView');
    if (currentView === 'comfyui' && !data.comfyUIEnabled) {
      State.set('currentView', 'workspace');
    } else if (currentView === 'kohya' && !data.kohyaEnabled) {
      State.set('currentView', 'workspace');
    } else if (currentView === 'wallet' && !data.fiatEnabled && !data.blockchainEnabled) {
      State.set('currentView', 'workspace');
    }
    // Force full re-render by destroying the app container
    const appContainer = document.querySelector('.app-container');
    if (appContainer) appContainer.remove();
  });

  window.scruple.on('log', (data) => {
    addLog(data.level, data.message);
  });

  window.scruple.on('project-changed', (data) => {
    const projectName = data.projectName || '';
    addLog('info', projectName ? `Project activated: ${projectName}` : 'Project deactivated');
    
    // Notify ComfyUI webview
    const webview = document.getElementById('comfy-webview');
    if (webview) {
      try {
        webview.executeJavaScript(`
          if (typeof window.scrupleProjectName !== 'undefined') {
            window.scrupleProjectName = "${projectName}";
            window.scrupleStudioConnected = true;
          } else {
            window.scrupleProjectName = "${projectName}";
            window.scrupleStudioConnected = true;
          }
          if (typeof app !== 'undefined' && app.graph) {
            app.graph.setDirtyCanvas(true, true);
          }
        `);
      } catch (e) {
        console.log('Webview not ready for project inject');
      }
    }
  });

  // Training capture events
  window.scruple.on('training-added', async (data) => {
    console.log('[RENDERER] training-added event received:', data);
    addLog('info', `Training capture started: ${data.outputName || 'unknown'}`);
    State.set('pendingTraining', data);
    
    const selectedProject = State.get('selectedProject');
    if (selectedProject && selectedProject.id === data.projectId) {
      await fetchTrainingRuns(selectedProject.id);
    }
  });

  window.scruple.on('training-complete', async (data) => {
    addLog('info', `Training complete: ${data.headerHash ? truncateHash(data.headerHash) : 'unknown'}`);
    State.set('pendingTraining', null);
    
    const selectedProject = State.get('selectedProject');
    if (selectedProject && selectedProject.id === data.projectId) {
      await fetchTrainingRuns(selectedProject.id);
    }
  });

  window.scruple.on('training-error', (data) => {
    addLog('error', `Training error: ${data.error}`);
    State.set('pendingTraining', null);
  });

  // Pre-flight progress events (Phase 7)
  window.scruple.on('preflight-progress', (status) => {
    State.set('preflightStatus', status);
    State.set('preflightRunning', true);
  });

  window.scruple.on('preflight-complete', (status) => {
    State.set('preflightStatus', status);
    State.set('preflightRunning', false);
    addLog('info', 'Pre-flight complete: ' + (status.verified ? 'Verified' : 'Issues found'));
  });

  window.scruple.on('kohya-connected', () => {
    State.set('kohyaConnected', true);
    addLog('info', 'Kohya_ss connected');
  });

  window.scruple.on('kohya-disconnected', () => {
    State.set('kohyaConnected', false);
    addLog('info', 'Kohya_ss disconnected');
  });
}
