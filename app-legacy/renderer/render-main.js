/**
 * render-main.js - SCRUPLE Studio App Shell Rendering
 *
 * Core render functions: app shell, setup wizard, main layout,
 * sidebar, webview handlers.
 *
 * Depends on: state.js, api.js, render-workspace.js, render-wallet.js
 * (load order in index.html ensures dependencies are available)
 *
 * SCRUPLE Studio — Patent Pending
 */

// Prevent re-rendering setup wizard (preserves form data)
let setupWizardRendered = false;

function renderApp() {
  const root = document.getElementById('root');
  const isLoading = State.get('isLoading');
  const needsSetup = State.get('needsSetup');

  if (isLoading) {
    setupWizardRendered = false;
    root.innerHTML = `
      <div class="loading-screen">
        <div class="loading-spinner"></div>
        <div class="loading-text">Initializing SCRUPLE Studio...</div>
      </div>
    `;
    return;
  }

  if (needsSetup) {
    // Only render setup wizard once to preserve form data
    if (!setupWizardRendered) {
      console.log('[RENDERER] Rendering setup wizard');
      renderSetupWizard(root);
      setupWizardRendered = true;
    } else {
      console.log('[RENDERER] Skipping setup wizard re-render to preserve form data');
    }
    return;
  }

  setupWizardRendered = false;
  renderMainApp(root);
}

function renderSetupWizard(root) {
  root.innerHTML = `
    <div class="setup-wizard">
      <div class="setup-card">
        <div class="setup-header">
          <h1>SCRUPLE</h1>
          <p class="version">V3.0 - AI Provenance Middleware</p>
        </div>
        <div class="setup-content">
          <h2>Welcome!</h2>
          <p>Let's configure your AI tools. Fill in the paths you use, or skip any you don't need.</p>
          
          <form id="setup-form">
            <div class="form-group">
              <label>ComfyUI Installation Folder: <span class="optional">(optional)</span></label>
              <div class="path-input">
                <input type="text" id="comfy-path" placeholder="E:\\ComfyUI_windows_portable\\ComfyUI" />
                <button type="button" id="browse-comfy-btn" class="browse-btn">Browse...</button>
              </div>
              <p class="help-text">Root folder of your ComfyUI installation.</p>
            </div>

            <hr class="setup-divider" />

            <div class="form-group">
              <label>Kohya Training Output Folder: <span class="optional">(optional)</span></label>
              <div class="path-input">
                <input type="text" id="kohya-output-path" placeholder="C:\\Scruple\\vault\\Lora Training Output" />
                <button type="button" id="browse-kohya-output-btn" class="browse-btn">Browse...</button>
              </div>
              <p class="help-text">Where Kohya saves trained LoRA models.</p>
            </div>

            <div class="form-group">
              <label>Kohya Training Images Folder: <span class="optional">(optional)</span></label>
              <div class="path-input">
                <input type="text" id="kohya-images-path" placeholder="C:\\Scruple\\vault\\Lora Training Images" />
                <button type="button" id="browse-kohya-images-btn" class="browse-btn">Browse...</button>
              </div>
              <p class="help-text">Where your training datasets are stored.</p>
            </div>

            <div class="form-group">
              <label>Base Models Folder: <span class="optional">(optional)</span></label>
              <div class="path-input">
                <input type="text" id="kohya-model-path" placeholder="E:\\models\\checkpoints" />
                <button type="button" id="browse-kohya-model-btn" class="browse-btn">Browse...</button>
              </div>
              <p class="help-text">Folder containing your base model checkpoints.</p>
            </div>

            <div id="setup-error" class="error-message" style="display: none;"></div>

            <div class="setup-info">
              <h3>What happens next:</h3>
              <ul>
                <li>SCRUPLE monitors your configured folders for provenance capture</li>
                <li>Training configs are auto-detected when you start training in Kohya</li>
                <li>Your vault will be at <code>C:\\Scruple\\</code></li>
              </ul>
            </div>

            <button type="submit" class="submit-btn" id="submit-btn">Complete Setup</button>
          </form>
        </div>
        <div class="setup-footer">
          <p>Patent Pending - All Rights Reserved</p>
        </div>
      </div>
    </div>
  `;

  // Browse buttons
  document.getElementById('browse-comfy-btn').addEventListener('click', async () => {
    const result = await window.scruple.browseFolder();
    if (!result.canceled && result.path) {
      document.getElementById('comfy-path').value = result.path;
    }
  });

  document.getElementById('browse-kohya-output-btn').addEventListener('click', async () => {
    const result = await window.scruple.browseFolder();
    if (!result.canceled && result.path) {
      document.getElementById('kohya-output-path').value = result.path;
    }
  });

  document.getElementById('browse-kohya-images-btn').addEventListener('click', async () => {
    const result = await window.scruple.browseFolder();
    if (!result.canceled && result.path) {
      document.getElementById('kohya-images-path').value = result.path;
    }
  });

  document.getElementById('browse-kohya-model-btn').addEventListener('click', async () => {
    const result = await window.scruple.browseFolder();
    if (!result.canceled && result.path) {
      document.getElementById('kohya-model-path').value = result.path;
    }
  });

  const setupForm = document.getElementById('setup-form');
  console.log('[RENDERER] Setup form element found:', !!setupForm);
  
  setupForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    console.log('[RENDERER] Setup form submitted');
    const comfyPath = document.getElementById('comfy-path').value;
    const kohyaOutputPath = document.getElementById('kohya-output-path').value;
    const kohyaImagesPath = document.getElementById('kohya-images-path').value;
    const kohyaModelPath = document.getElementById('kohya-model-path').value;

    console.log('[RENDERER] Paths:', { comfyPath, kohyaOutputPath, kohyaImagesPath, kohyaModelPath });

    // At least one path required
    if (!comfyPath && !kohyaOutputPath) {
      document.getElementById('setup-error').textContent = 'Please configure at least ComfyUI or Kohya output folder';
      document.getElementById('setup-error').style.display = 'block';
      return;
    }

    document.getElementById('submit-btn').textContent = 'Validating...';
    document.getElementById('submit-btn').disabled = true;
    
    console.log('[RENDERER] Calling setupPaths...');
    await setupPaths({
      comfyUIPath: comfyPath || null,
      trainingOutputDir: kohyaOutputPath || null,
      trainingImagesDir: kohyaImagesPath || null,
      defaultBaseModel: kohyaModelPath || null
    });
    console.log('[RENDERER] setupPaths completed');
  });
  
  console.log('[RENDERER] renderSetupWizard complete - all listeners attached');
}

function renderMainApp(root) {
  // Preserve focus across re-render
  const activeElement = document.activeElement;
  const activeId = activeElement?.id;
  const activeSelectionStart = activeElement?.selectionStart;
  const activeSelectionEnd = activeElement?.selectionEnd;
  const activeValue = activeElement?.value;
  
  const projects = State.get('projects') || [];
  const activeProject = State.get('activeProject');
  const selectedProject = State.get('selectedProject');
  const isInterlocked = State.get('isInterlocked');
  const sessionId = State.get('sessionId');
  const comfyConnected = State.get('comfyConnected');
  const kohyaConnected = State.get('kohyaConnected');
  const kohyaPort = State.get('kohyaPort');
  const logs = State.get('logs') || [];
  const currentView = State.get('currentView');
  const iterations = State.get('iterations') || [];
  const trainingRuns = State.get('trainingRuns') || [];
  const comfyUIEnabled = State.get('comfyUIEnabled') !== false;
  const kohyaEnabled = State.get('kohyaEnabled') === true;
  const walletMode = State.get('walletMode') || 'blockchain';
  const fiatEnabled = State.get('fiatEnabled') === true;
  const blockchainEnabled = State.get('blockchainEnabled') !== false;
  
  let appContainer = root.querySelector('.app-container');
  
  if (!appContainer) {
    root.innerHTML = `
      <div class="app-container ${isInterlocked ? 'interlocked' : ''}">
        ${renderSidebar(projects, activeProject, selectedProject, isInterlocked, sessionId, comfyConnected, iterations)}
        <div class="main-content">
          <div class="main-content-header">
            <div class="view-toggle-header">
              ${comfyUIEnabled ? `<button class="view-toggle-btn ${currentView === 'comfyui' ? 'active' : ''}" data-view="comfyui">ComfyUI</button>` : ''}
              ${kohyaEnabled ? `<button class="view-toggle-btn ${currentView === 'kohya' ? 'active' : ''}" data-view="kohya">Kohya_ss</button>` : ''}
              <button class="view-toggle-btn ${currentView === 'workspace' ? 'active' : ''}" data-view="workspace">
                Workspace
              </button>
              ${fiatEnabled ? `
              <button class="view-toggle-btn ${currentView === 'wallet' && walletMode === 'fiat' ? 'active' : ''}" data-view="wallet" data-wallet-mode="fiat" style="color: #a855f7; ${currentView === 'wallet' && walletMode === 'fiat' ? 'border-color: #a855f7; background: rgba(168,85,247,0.12);' : ''}">
                💳 Fiat
              </button>` : ''}
              ${blockchainEnabled ? `
              <button class="view-toggle-btn ${currentView === 'wallet' && walletMode === 'blockchain' ? 'active' : ''}" data-view="wallet" data-wallet-mode="blockchain">
                ⛓ Blockchain
              </button>` : ''}
            </div>
            ${selectedProject ? `<span class="viewing-label">Viewing: ${escapeHtml(selectedProject.name)}</span>` : ''}
          </div>
          <div class="main-content-body">
            ${comfyUIEnabled ? `<div class="comfy-webview-container ${currentView === 'comfyui' ? 'visible' : 'hidden'}">
              <webview 
                id="comfy-webview"
                src="http://127.0.0.1:8188"
                class="comfy-webview ${comfyConnected ? 'connected' : 'disconnected'}"
                partition="persist:comfyui"
              ></webview>
              ${!comfyConnected ? `
                <div class="webview-overlay" id="webview-overlay">
                  <div class="overlay-content">
                    ${State.get('comfyRetryPaused') ? `
                      <div class="status-icon disconnected">X</div>
                      <h2>ComfyUI Not Running</h2>
                      <p>Start ComfyUI, then click Load ComfyUI below.</p>
                      <p class="help-hint">ComfyUI must be running at http://127.0.0.1:8188</p>
                    ` : `
                      <div class="spinner large"></div>
                      <h2>Connecting to ComfyUI...</h2>
                      <p>Attempt ${(State.get('comfyRetryCount') || 0) + 1} of ${MAX_AUTO_RETRIES}</p>
                    `}
                    <div style="display:flex;gap:10px;justify-content:center;margin-top:12px;">
                      <button id="retry-comfy" class="retry-btn">Retry</button>
                      <button id="load-comfyui-btn" class="retry-btn" style="background:linear-gradient(135deg,#1d4ed8,#1e40af);border-color:#3b82f6;" onclick="window.scruple.openExternal('http://127.0.0.1:8188')">Load ComfyUI</button>
                    </div>
                  </div>
                </div>
              ` : ''}
            </div>` : ''}
            ${kohyaEnabled ? `<div class="kohya-webview-container ${currentView === 'kohya' ? 'visible' : 'hidden'}">
              ${kohyaPort ? `
                <webview 
                  id="kohya-webview"
                  src="http://127.0.0.1:${kohyaPort}?__theme=dark"
                  class="kohya-webview ${kohyaConnected ? 'connected' : 'disconnected'}"
                  partition="persist:kohya"
                  nodeintegration
                ></webview>
              ` : ''}
              ${!kohyaPort ? `
                <div class="webview-overlay" id="kohya-overlay">
                  <div class="overlay-content">
                    <div class="status-icon disconnected">X</div>
                    <h2>Kohya_ss Not Detected</h2>
                    <p>Start Kohya_ss GUI on port 7860, 7861, or 7862</p>
                    <p class="help-hint">Then click Detect to connect</p>
                    <button id="retry-kohya" class="retry-btn">Detect</button>
                  </div>
                </div>
              ` : !kohyaConnected ? `
                <div class="webview-overlay" id="kohya-overlay">
                  <div class="overlay-content">
                    ${State.get('kohyaRetryPaused') ? `
                      <div class="status-icon disconnected">X</div>
                      <h2>Kohya_ss Not Responding</h2>
                      <p>Port ${kohyaPort} detected but not responding</p>
                      <p class="help-hint">Restart Kohya_ss and click Retry</p>
                    ` : `
                      <div class="spinner large"></div>
                      <h2>Connecting to Kohya_ss...</h2>
                      <p>Port ${kohyaPort}</p>
                    `}
                    <button id="retry-kohya" class="retry-btn">Retry</button>
                  </div>
                </div>
              ` : ''}
            </div>` : ''}
            <div class="workspace-container ${currentView === 'workspace' ? 'visible' : 'hidden'}">
              ${renderWorkspace(selectedProject, activeProject, iterations, trainingRuns, isInterlocked)}
            </div>
            <div class="wallet-container ${currentView === 'wallet' ? 'visible' : 'hidden'}">
              ${walletMode === 'fiat' ? renderWallet() : renderWalletBlockchain()}
            </div>
          </div>
        </div>
        ${renderDebugConsole(logs)}
        ${isInterlocked ? `
          <div class="interlock-overlay">
            <div class="interlock-message">
              <div class="spinner"></div>
              <span>Generating...</span>
            </div>
          </div>
        ` : ''}
        ${renderGlobalModal()}
      </div>
    `;
    
    setupWebviewHandlers();
    setupKohyaWebviewHandlers();
    refreshAllWallets();
  } else {
    appContainer.className = `app-container ${isInterlocked ? 'interlocked' : ''}`;
    
    const sidebar = appContainer.querySelector('.sidebar');
    if (sidebar) {
      sidebar.outerHTML = renderSidebar(projects, activeProject, selectedProject, isInterlocked, sessionId, comfyConnected, iterations);
    }
    
    const mainContentHeader = appContainer.querySelector('.main-content-header');
    if (mainContentHeader) {
      mainContentHeader.innerHTML = `
        <div class="view-toggle-header">
          ${comfyUIEnabled ? `<button class="view-toggle-btn ${currentView === 'comfyui' ? 'active' : ''}" data-view="comfyui">ComfyUI</button>` : ''}
          ${kohyaEnabled ? `<button class="view-toggle-btn ${currentView === 'kohya' ? 'active' : ''}" data-view="kohya">Kohya_ss</button>` : ''}
          <button class="view-toggle-btn ${currentView === 'workspace' ? 'active' : ''}" data-view="workspace">
            Workspace
          </button>
          ${fiatEnabled ? `
          <button class="view-toggle-btn ${currentView === 'wallet' && walletMode === 'fiat' ? 'active' : ''}" data-view="wallet" data-wallet-mode="fiat" style="color: #a855f7; ${currentView === 'wallet' && walletMode === 'fiat' ? 'border-color: #a855f7; background: rgba(168,85,247,0.12);' : ''}">
            💳 Fiat
          </button>` : ''}
          ${blockchainEnabled ? `
          <button class="view-toggle-btn ${currentView === 'wallet' && walletMode === 'blockchain' ? 'active' : ''}" data-view="wallet" data-wallet-mode="blockchain">
            ⛓ Blockchain
          </button>` : ''}
        </div>
        ${selectedProject ? `<span class="viewing-label">Viewing: ${escapeHtml(selectedProject.name)}</span>` : ''}
      `;
    }
    
    const comfyContainer = appContainer.querySelector('.comfy-webview-container');
    const kohyaContainer = appContainer.querySelector('.kohya-webview-container');
    const workspaceContainer = appContainer.querySelector('.workspace-container');
    const walletContainer = appContainer.querySelector('.wallet-container');
    
    if (comfyContainer) {
      comfyContainer.className = `comfy-webview-container ${currentView === 'comfyui' ? 'visible' : 'hidden'}`;
    }
    if (kohyaContainer) {
      kohyaContainer.className = `kohya-webview-container ${currentView === 'kohya' ? 'visible' : 'hidden'}`;
      // Remove overlay if connected
      const kohyaOverlay = kohyaContainer.querySelector('#kohya-overlay');
      if (kohyaOverlay && State.get('kohyaConnected')) {
        kohyaOverlay.remove();
      }
    }
    if (workspaceContainer) {
      workspaceContainer.className = `workspace-container ${currentView === 'workspace' ? 'visible' : 'hidden'}`;
      workspaceContainer.innerHTML = renderWorkspace(selectedProject, activeProject, iterations, trainingRuns, isInterlocked);
    }
    if (walletContainer) {
      walletContainer.className = `wallet-container ${currentView === 'wallet' ? 'visible' : 'hidden'}`;
      const activeModal = State.get('walletModal');
      const inputModals = ['rvn-create', 'rvn-import', 'rvn-unlock', 'confirm-chain-lock', 'confirm-training-lock', 'ipfs-config'];
      const modalAlreadyShowing = !!walletContainer.querySelector('.wallet-modal-overlay');
	  if (!inputModals.includes(activeModal) || !modalAlreadyShowing) {
        try {
          walletContainer.innerHTML = walletMode === 'fiat' ? renderWallet() : renderWalletBlockchain();
        } catch (e) {
          console.error('[RENDER] Wallet render error:', e.message);
        }
      }
    }
    
    const debugConsole = appContainer.querySelector('.debug-console');
    if (debugConsole) {
      debugConsole.outerHTML = renderDebugConsole(logs);
    }
    
    const overlay = appContainer.querySelector('#webview-overlay');
    if (comfyConnected && overlay) {
      overlay.remove();
    }
    
    const interlockOverlay = appContainer.querySelector('.interlock-overlay');
    if (isInterlocked && !interlockOverlay) {
      appContainer.insertAdjacentHTML('beforeend', `
        <div class="interlock-overlay">
          <div class="interlock-message">
            <div class="spinner"></div>
            <span>Generating...</span>
          </div>
        </div>
      `);
    } else if (!isInterlocked && interlockOverlay) {
      interlockOverlay.remove();
    }
    
// Update global modal
    const existingModal = appContainer.querySelector('.wallet-modal-overlay');
    const walletModal = State.get('walletModal');
    if (walletModal === 'confirm-chain-lock' || walletModal === 'confirm-training-lock' || walletModal === 'training-folder-info' || walletModal === 'chain-lock-success' || walletModal === 'chain-lock-error' || walletModal === 'chain-lock-progress' || walletModal === 'finalize-warning' || walletModal === 'finalize-clone-warning' || walletModal === 'checkpoint-confirm' || walletModal === 'tsd-insufficient' || walletModal === 'tsd-chain-lock-confirm') {
      if (existingModal) existingModal.remove();
      appContainer.insertAdjacentHTML('beforeend', renderGlobalModal());
    } else if (!walletModal && existingModal) {
      existingModal.remove();
    }
  }
  setupMainAppHandlers();
  
  // Restore focus after re-render
  if (activeId) {
    const elementToFocus = document.getElementById(activeId);
    if (elementToFocus) {
      elementToFocus.focus();
      // Restore cursor position for text inputs
      if (activeValue !== undefined && elementToFocus.setSelectionRange) {
        elementToFocus.value = activeValue;
        try {
          elementToFocus.setSelectionRange(activeSelectionStart, activeSelectionEnd);
        } catch (e) {
          // Some input types don't support setSelectionRange
        }
      }
    }
  }
}

function setupWebviewHandlers() {
  const webview = document.getElementById('comfy-webview');
  if (!webview) return;
  
  // Ensure src is set — catches cases where the webview rendered without a src
  if (!webview.src || webview.src === 'about:blank' || webview.src === '') {
    webview.src = 'http://127.0.0.1:8188';
  }
  
  let webviewReady = false;
  
  webview.addEventListener('dom-ready', () => {
    webviewReady = true;
  });
  
  webview.addEventListener('did-finish-load', () => {
    State.set('comfyConnected', true);
    State.set('comfyRetryCount', 0);
    State.set('comfyRetryPaused', false);
    const port = State.get('port');
    if (port && webviewReady) {
      try {
        webview.executeJavaScript(`window.SCRUPLE_PORT = ${port};`);
      } catch (e) {}
    }
  });

  webview.addEventListener('did-fail-load', (e) => {
    // Error code -3 is "aborted" - ignore these
    if (e.errorCode === -3) return;
    
    State.set('comfyConnected', false);
    const retryCount = State.get('comfyRetryCount') || 0;
    
    // Only auto-retry a limited number of times
    if (retryCount < MAX_AUTO_RETRIES) {
      State.set('comfyRetryCount', retryCount + 1);
      addLog('warn', `ComfyUI connection failed (attempt ${retryCount + 1}/${MAX_AUTO_RETRIES})`);
      setTimeout(() => {
        // Check we haven't paused or connected in the meantime
        if (!State.get('comfyConnected') && !State.get('comfyRetryPaused') && webviewReady) {
          try { webview.reload(); } catch (e) {}
        }
      }, 3000);
    } else if (!State.get('comfyRetryPaused')) {
      // Max retries reached - pause and wait for manual retry
      State.set('comfyRetryPaused', true);
      addLog('info', 'ComfyUI not responding. Click "Retry" when ComfyUI is running.');
    }
  });
}

function setupKohyaWebviewHandlers() {
  const webview = document.getElementById('kohya-webview');
  addLog('info', 'setupKohyaWebviewHandlers called, webview: ' + (webview ? 'found' : 'NOT FOUND'));
  if (!webview) return;
  
  let webviewReady = false;
  
  webview.addEventListener('dom-ready', () => {
    addLog('info', 'Kohya webview dom-ready');
    webviewReady = true;
    
    // Inject capture script directly
    fetch('./capture_training.js')
      .then(r => r.text())
      .then(script => {
        webview.executeJavaScript(script);
        addLog('info', 'Kohya capture script injected');
      })
      .catch(e => {
        addLog('warn', 'Could not inject capture script: ' + e.message);
      });
  });
  
  webview.addEventListener('did-finish-load', () => {
    addLog('info', 'Kohya webview did-finish-load');
    State.set('kohyaConnected', true);
    State.set('kohyaRetryCount', 0);
    State.set('kohyaRetryPaused', false);
  });

  webview.addEventListener('did-fail-load', (e) => {
    // Error code -3 is "aborted" - ignore these
    if (e.errorCode === -3) return;
    
    State.set('kohyaConnected', false);
    const retryCount = State.get('kohyaRetryCount') || 0;
    
    // Only log once per retry cycle to avoid spam
    if (retryCount < MAX_AUTO_RETRIES) {
      State.set('kohyaRetryCount', retryCount + 1);
      addLog('warn', `Kohya connection failed (attempt ${retryCount + 1}/${MAX_AUTO_RETRIES}), error: ${e.errorCode}`);
    } else if (!State.get('kohyaRetryPaused')) {
      State.set('kohyaRetryPaused', true);
      addLog('info', 'Kohya_ss not responding. Click "Retry" when Kohya_ss is running.');
    }
  });
  
  // Forward console messages for debugging
  webview.addEventListener('console-message', (e) => {
    if (e.message.includes('[SCRUPLE]')) {
      addLog('info', '[KOHYA] ' + e.message);
    }
  });
}

function renderSidebar(projects, activeProject, selectedProject, isInterlocked, sessionId, comfyConnected, iterations = []) {
  const statusClass = !comfyConnected ? 'disconnected' : isInterlocked ? 'busy' : 'connected';
  const statusText = !comfyConnected ? 'Waiting...' : isInterlocked ? 'Busy' : 'Ready';

  return `
    <div class="sidebar">
      <div class="sidebar-header">
        <div class="logo">
          <span class="logo-text">SCRUPLE</span>
          <span class="logo-version">Studio V3</span>
        </div>
        <div class="connection-status">
          <span class="status-dot ${statusClass}"></span>
          <span class="status-text">${statusText}</span>
        </div>
      </div>

      <div class="sidebar-section active-project-section">
        ${renderActiveProjectSidebar(activeProject, iterations)}
      </div>

      <div class="sidebar-section flex-grow">
        <div class="section-header">
          <h3>Projects</h3>
          <div class="header-buttons">
            <button class="btn-icon" id="load-archive-btn" disabled title="Load from Archive (Coming Soon)"></button>
            <button class="btn-icon" id="new-project-btn" ${isInterlocked ? 'disabled' : ''} title="New Project">+</button>
          </div>
        </div>
        <div id="new-project-form" style="display: none;">
          <form class="new-project-form">
            <input type="text" id="new-project-name" placeholder="Project name..." ${isInterlocked ? 'disabled' : ''} />
            <select id="new-project-type" ${isInterlocked ? 'disabled' : ''}>
              <option value="txt2img"> Image Generation</option>
              <option value="training">Model Training</option>
            </select>
            <div class="form-buttons">
              <button type="submit" ${isInterlocked ? 'disabled' : ''}>Create</button>
              <button type="button" id="cancel-new-project">Cancel</button>
            </div>
          </form>
        </div>
        ${renderProjectList(projects, activeProject, selectedProject, isInterlocked)}
      </div>

      <div class="sidebar-footer">
        <div class="status-line">Ready</div>
        <div class="footer-row">
          <div class="session-info">
            <span class="label">Session:</span>
            <span class="value">${sessionId ? sessionId.substring(0, 8) : '...'}</span>
          </div>
          <button class="debug-btn" id="toggle-debug">Debug</button>
        </div>
      </div>
    </div>
  `;
}

function renderActiveProjectSidebar(project, iterations = []) {
  if (!project) {
    return `
      <div class="active-project empty">
        <div class="placeholder">
          <span class="icon">Connected</span>
          <span class="text">No Active Tracking</span>
          <span class="hint">Activate a project to track provenance</span>
        </div>
      </div>
    `;
  }

  const statusColors = {
    'unlocked': '#4caf50',
    'local_locked': '#ff9800',
    'chain_locked': '#2196f3',
    'persistent_locked': '#9c27b0',
    'permanent_locked': '#9c27b0'
  };

  return `
    <div class="active-project">
      <div class="active-tracking-header">
        <span class="tracking-icon">Tracking</span>
        <span class="tracking-label">TRACKING</span>
      </div>
      <div class="project-header">
        <h2>${escapeHtml(project.name)}</h2>
        <div class="status-indicator" style="background-color: ${statusColors[project.status] || '#4caf50'}">
          ${project.iteration_count || 0} iter
        </div>
      </div>
      <div class="project-stats">
        <div class="stat">
          <span class="label">Status:</span>
          <span class="value">${project.status}</span>
        </div>
        ${project.pre_scr_id ? `
          <div class="stat">
            <span class="label">Pre-SCR:</span>
            <span class="value scr-id" style="color:#94a3b8;font-size:11px;">${project.pre_scr_id}</span>
          </div>
        ` : ''}
        ${project.scr_id ? `
          <div class="stat">
            <span class="label">SCR ID:</span>
            <span class="value scr-id">${project.scr_id}</span>
          </div>
        ` : ''}
      </div>
      <div class="recent-iterations">
        <span class="label">Recent:</span>
        <div class="iteration-thumbnails">
          ${iterations.slice(-4).reverse().map(iter => `
            <div class="iteration-thumb" data-project="${project.name}" data-image="${iter.image_filename || ''}">
              <span class="thumb-placeholder">#${iter.run_sequence}</span>
            </div>
          `).join('')}
        </div>
      </div>
      <button class="stop-btn" id="stop-tracking-btn">Stop Tracking</button>
    </div>
  `;
}

function renderProjectList(projects, activeProject, selectedProject, isInterlocked) {
  if (!projects || projects.length === 0) {
    return `<div class="project-list empty"><p>No projects yet</p></div>`;
  }

  return `
    <div class="project-list">
      ${projects.map(project => {
        const isActive = activeProject && activeProject.id === project.id;
        const isSelected = selectedProject && selectedProject.id === project.id;
        const statusColors = {
          'unlocked': '#4caf50',
          'local_locked': '#ff9800',
          'chain_locked': '#2196f3',
          'persistent_locked': '#9c27b0',
          'permanent_locked': '#9c27b0'
        };
        const typeIcon = project.type === 'training' ? '[T]' : '[I]';
        const countLabel = project.type === 'training' ? 'runs' : 'iterations';
        const count = project.type === 'training' ? (project.training_run_count || 0) : (project.iteration_count || 0);
        
        return `
          <div class="project-item ${isSelected ? 'selected' : ''} ${isActive ? 'active' : ''}">
            <div class="project-main clickable" data-view-project="${project.id}">
              <div class="project-info">
                <span class="project-name">${typeIcon} ${escapeHtml(project.name)}</span>
                <span class="project-meta">${count} ${countLabel}</span>
                ${project.pre_scr_id && !project.scr_id ? `<span class="project-meta" style="color:#94a3b8;font-size:10px;">${project.pre_scr_id}</span>` : ''}
                ${project.scr_id ? `<span class="project-meta" style="color:#58a6ff;font-size:10px;">${project.scr_id}</span>` : ''}
              </div>
              <div class="project-status" style="background-color: ${statusColors[project.status] || '#4caf50'}"></div>
            </div>
            <div class="project-footer">
              <button class="archive-btn" data-project-id="${project.id}" title="Archive Project">Archive</button>
              <div class="project-actions">
                ${!isActive ? `
                  <button class="activate-btn" data-project-id="${project.id}" ${isInterlocked ? 'disabled' : ''} title="Start Tracking">Start</button>
                ` : `
                  <button class="stop-btn small" data-project-id="${project.id}" title="Stop Tracking">Stop Tracking</button>
                `}
              </div>
            </div>
          </div>
        `;
      }).join('')}
    </div>
  `;
}
