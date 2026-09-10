/**
 * render-wallet.js - SCRUPLE Studio Wallet Rendering
 *
 * Renders the wallet tab, wallet modals (create/import/unlock/chain-lock),
 * global modal overlay, and debug console.
 *
 * Depends on: state.js, api.js
 *
 * SCRUPLE Studio — Patent Pending
 */

function renderWalletMainnet() {
  const rvnStatus = State.get('rvnStatus');
  const rvnLoading = State.get('rvnLoading');
  const ipfsConfig = State.get('ipfsConfig');
  const walletModal = State.get('walletModal');
  const walletModalData = State.get('walletModalData') || {};

  return `
    <div class="wallet-tab">
      <div class="wallet-container">
        
        <!-- RVN Panel -->
        <div class="network-panel">
          <div class="panel-header">
            <div class="network-title">
              <span class="network-icon">R</span>
              <h3>Ravencoin</h3>
            </div>
            <span class="status-indicator ${rvnStatus?.isUnlocked ? 'online' : rvnStatus?.exists ? 'warning' : 'offline'}">
              -- ${rvnStatus?.isUnlocked ? 'Online' : rvnStatus?.exists ? 'Locked' : 'No Wallet'}
            </span>
          </div>
          <div class="panel-body">
            ${rvnLoading ? `<div class="loading">Loading...</div>` : !rvnStatus?.exists ? `
              <div class="state-section">
                <p class="info-text">RVN wallet required for Single Chain Lock</p>
                <p class="cost-info">Lock cost: ~500 RVN asset creation fee</p>
                <div class="button-group">
                  <button class="btn btn-primary" data-wallet-action="create-rvn">Create New Wallet</button>
                  <button class="btn btn-secondary" data-wallet-action="import-rvn">Import from Phrase</button>
                </div>
              </div>
            ` : `
              <div class="state-section">
                <div class="info-row">
                  <span class="label">Address:</span>
                  <code class="address">${truncateAddress(rvnStatus.address)}</code>
                  <button class="btn-icon-small" data-copy="${rvnStatus.address || ''}" title="Copy address">Copy</button>
                </div>
                <div class="info-row">
                  <span class="label">Balance:</span>
                  <span class="value highlight">${rvnStatus.isUnlocked ? formatRvnBalance(rvnStatus.balance) : '-- RVN'}</span>
                  ${rvnStatus.isUnlocked ? `<button class="btn-icon-small" data-wallet-action="refresh-rvn" title="Refresh balance">Refresh</button>` : ''}
                </div>
                <div class="info-row">
                  <span class="label">Status:</span>
                  <span class="badge ${rvnStatus.isUnlocked ? 'badge-success' : 'badge-warning'}">${rvnStatus.isUnlocked ? 'Unlocked' : 'Locked'}</span>
                </div>
                <div class="button-group">
                  ${rvnStatus.isUnlocked ? `
                    <button class="btn btn-secondary" data-wallet-action="lock-rvn">Lock Wallet</button>
                  ` : `
                    <button class="btn btn-primary" data-wallet-action="unlock-rvn">Unlock Wallet</button>
                  `}
                  <button class="btn btn-ghost" data-wallet-action="settings-rvn">Settings</button>
                </div>
              </div>
            `}
          </div>
          <div class="panel-footer">
            <span class="network-label">Single Chain Lock</span>
            <a href="#" data-external-link="https://ravencoin.network">Explorer </a>
          </div>
        </div>


        <!-- IPFS Panel -->
        <div class="network-panel">
          <div class="panel-header">
            <div class="network-title">
              <span class="network-icon">I</span>
              <h3>IPFS</h3>
            </div>
            <span class="status-indicator ${ipfsConfig?.gateway ? 'online' : 'offline'}">
              -- ${ipfsConfig?.gateway ? 'Configured' : 'Not Configured'}
            </span>
          </div>
          <div class="panel-body">
            ${!ipfsConfig?.gateway ? `
              <div class="state-section">
                <p class="info-text">Configure IPFS pinning for Pinned Chain Locks</p>
                <div class="button-group">
                  <button class="btn btn-primary" data-wallet-action="config-ipfs">Configure IPFS</button>
                </div>
              </div>
            ` : `
              <div class="state-section">
                <div class="info-row">
                  <span class="label">Gateway:</span>
                  <code class="address">${ipfsConfig.gateway}</code>
                </div>
                <div class="info-row">
                  <span class="label">Pinning:</span>
                  <span class="value">${ipfsConfig.pinningService || 'None'}</span>
                </div>
                <div class="button-group">
                  <button class="btn btn-secondary" data-wallet-action="config-ipfs">Edit Config</button>
                  <button class="btn btn-ghost" data-wallet-action="test-ipfs">Test Connection</button>
                </div>
              </div>
            `}
          </div>
          <div class="panel-footer">
            <span class="network-label">Distributed Storage</span>
            <a href="#" data-external-link="https://ipfs.io">Learn More </a>
          </div>
        </div>

      </div>
      ${renderWalletModal()}
    </div>
  `;
}

/**
 * Blockchain wallet view — network-aware (testnet or mainnet).
 * Shown when walletMode === 'blockchain'.
 */
function renderWalletBlockchain() {
  const rvnStatus = State.get('rvnStatus');
  const rvnLoading = State.get('rvnLoading');
  const rvnNetwork = State.get('rvnNetwork') || rvnStatus?.network || 'rvn';
  const isTestnet = (rvnNetwork === 'rvn-test');
  const ipfsConfig = State.get('ipfsConfig');

  return `
    <div class="wallet-tab">
      <div class="wallet-container">

        <!-- RVN Panel -->
        <div class="network-panel" style="${isTestnet ? 'border: 2px solid #f97316; box-shadow: 0 0 16px rgba(249,115,22,0.25);' : ''}">
          <div class="panel-header">
            <div class="network-title">
              <span class="network-icon" style="${isTestnet ? 'background: #f97316;' : ''}">R</span>
              <h3>Ravencoin${isTestnet ? ' <span style="color:#f97316;font-size:11px;font-weight:700;">TESTNET</span>' : ''}</h3>
            </div>
            <span class="status-indicator ${rvnStatus?.isUnlocked ? 'online' : rvnStatus?.exists ? 'warning' : 'offline'}">
              -- ${rvnStatus?.isUnlocked ? 'Online' : rvnStatus?.exists ? 'Locked' : 'No Wallet'}
            </span>
          </div>
          ${isTestnet ? `
          <div style="background: linear-gradient(135deg, #431407, #7c2d12); border-bottom: 1px solid #f97316; padding: 8px 14px; display: flex; align-items: center; gap: 8px;">
            <span style="font-size: 16px;">🧪</span>
            <div>
              <div style="color: #f97316; font-weight: 700; font-size: 12px; letter-spacing: 0.08em;">TESTNET MODE ACTIVE</div>
              <div style="color: #fed7aa; font-size: 10px;">Connected to 129.80.23.93:443 — testnet RVN only, no real value</div>
            </div>
          </div>` : ''}
          <div class="panel-body">
            ${rvnLoading ? `<div class="loading">Loading...</div>` : !rvnStatus?.exists ? `
              <div class="state-section">
                <p class="info-text">RVN wallet required for Chain Lock</p>
                <p class="cost-info">Lock cost: ~500 RVN asset creation fee</p>
                ${isTestnet ? `<p style="color:#f97316;font-size:11px;margin:4px 0 8px;">Testnet wallet — address starts with <strong>m</strong> or <strong>n</strong></p>` : ''}
                <div class="button-group">
                  <button class="btn btn-primary" data-wallet-action="create-rvn">Create New Wallet</button>
                  <button class="btn btn-secondary" data-wallet-action="import-rvn">Import from Phrase</button>
                </div>
              </div>
            ` : `
              <div class="state-section">
                <div class="info-row">
                  <span class="label">Address:</span>
                  <code class="address" style="${isTestnet ? 'color:#fb923c;' : ''}">${truncateAddress(rvnStatus.address)}</code>
                  <button class="btn-icon-small" data-copy="${rvnStatus.address || ''}" title="Copy address">Copy</button>
                </div>
                <div class="info-row">
                  <span class="label">Balance:</span>
                  <span class="value highlight">${rvnStatus.isUnlocked ? formatRvnBalance(rvnStatus.balance) : '-- RVN'}</span>
                  ${rvnStatus.isUnlocked ? `<button class="btn-icon-small" data-wallet-action="refresh-rvn" title="Refresh balance">Refresh</button>` : ''}
                </div>
                <div class="info-row">
                  <span class="label">Status:</span>
                  <span class="badge ${rvnStatus.isUnlocked ? 'badge-success' : 'badge-warning'}">${rvnStatus.isUnlocked ? 'Unlocked' : 'Locked'}</span>
                </div>
                <div class="button-group">
                  ${rvnStatus.isUnlocked ? `
                    <button class="btn btn-secondary" data-wallet-action="lock-rvn">Lock Wallet</button>
                  ` : `
                    <button class="btn btn-primary" data-wallet-action="unlock-rvn">Unlock Wallet</button>
                  `}
                  <button class="btn btn-ghost" data-wallet-action="settings-rvn">Settings</button>
                </div>
              </div>
            `}
          </div>
          <div class="panel-footer" style="${isTestnet ? 'border-top: 1px solid #f97316;' : ''}">
            <span class="network-label">Chain Lock</span>
            <div style="display:flex;align-items:center;gap:8px;">
              <span style="color:#8b949e;font-size:10px;">Network:</span>
              <select data-wallet-action="set-network"
                style="background:#161b22;color:${isTestnet ? '#f97316' : '#e6edf3'};border:1px solid ${isTestnet ? '#f97316' : '#30363d'};border-radius:4px;padding:2px 6px;font-size:10px;cursor:pointer;"
                title="Requires restart to apply">
                <option value="rvn" ${!isTestnet ? 'selected' : ''}>Mainnet</option>
                <option value="rvn-test" ${isTestnet ? 'selected' : ''}>Testnet</option>
              </select>
              ${!isTestnet ? `<a href="#" data-external-link="https://ravencoin.network">Explorer </a>` : ''}
            </div>
          </div>
        </div>


        <!-- IPFS Panel -->
        <div class="network-panel">
          <div class="panel-header">
            <div class="network-title">
              <span class="network-icon">I</span>
              <h3>IPFS</h3>
            </div>
            <span class="status-indicator ${ipfsConfig?.gateway ? 'online' : 'offline'}">
              -- ${ipfsConfig?.gateway ? 'Configured' : 'Not Configured'}
            </span>
          </div>
          <div class="panel-body">
            ${!ipfsConfig?.gateway ? `
              <div class="state-section">
                <p class="info-text">Configure IPFS pinning for Pinned Chain Locks</p>
                <div class="button-group">
                  <button class="btn btn-primary" data-wallet-action="config-ipfs">Configure IPFS</button>
                </div>
              </div>
            ` : `
              <div class="state-section">
                <div class="info-row">
                  <span class="label">Gateway:</span>
                  <code class="address">${ipfsConfig.gateway}</code>
                </div>
                <div class="info-row">
                  <span class="label">Pinning:</span>
                  <span class="value">${ipfsConfig.pinningService || 'None'}</span>
                </div>
                <div class="button-group">
                  <button class="btn btn-secondary" data-wallet-action="config-ipfs">Edit Config</button>
                  <button class="btn btn-ghost" data-wallet-action="test-ipfs">Test Connection</button>
                </div>
              </div>
            `}
          </div>
          <div class="panel-footer">
            <span class="network-label">Distributed Storage</span>
            <a href="#" data-external-link="https://ipfs.io">Learn More </a>
          </div>
        </div>

      </div>
      ${renderWalletModal()}
    </div>
  `;
}

function renderWalletModal() {
  const walletModal = State.get('walletModal');
  const walletModalData = State.get('walletModalData') || {};

  if (!walletModal) return '';

  let modalContent = '';
  let modalTitle = '';

  switch (walletModal) {
    case 'rvn-create':
      modalTitle = 'Create RVN Wallet';
      modalContent = `
        <form id="wallet-modal-form">
          <div class="form-group">
            <label>Password (min 8 characters):</label>
            <input type="password" id="modal-password" minlength="8" required />
          </div>
          <div class="form-group">
            <label>Confirm Password:</label>
            <input type="password" id="modal-confirm-password" required />
          </div>
          <div id="modal-error" class="error-message" style="display: none;"></div>
          <div class="modal-actions">
            <button type="button" class="btn btn-secondary" data-wallet-action="close-modal">Cancel</button>
            <button type="submit" class="btn btn-primary">Create Wallet</button>
          </div>
        </form>
      `;
      break;

    case 'rvn-import':
      modalTitle = 'Import RVN Wallet';
      modalContent = `
        <form id="wallet-modal-form">
          <div class="form-group">
            <label>Recovery Phrase (12 words):</label>
            <textarea id="modal-mnemonic" rows="3" placeholder="word1 word2 word3..." required></textarea>
          </div>
          <div class="form-group">
            <label>New Password:</label>
            <input type="password" id="modal-password" minlength="8" required />
          </div>
          <div class="form-group">
            <label>Confirm Password:</label>
            <input type="password" id="modal-confirm-password" required />
          </div>
          <div id="modal-error" class="error-message" style="display: none;"></div>
          <div class="modal-actions">
            <button type="button" class="btn btn-secondary" data-wallet-action="close-modal">Cancel</button>
            <button type="submit" class="btn btn-primary">Import Wallet</button>
          </div>
        </form>
      `;
      break;

    case 'rvn-unlock':
      modalTitle = 'Unlock RVN Wallet';
      modalContent = `
        <form id="wallet-modal-form">
          <div class="form-group">
            <label>Password:</label>
            <input type="password" id="modal-password" required />
          </div>
          <div id="modal-error" class="error-message" style="display: none;"></div>
          <div class="modal-actions">
            <button type="button" class="btn btn-secondary" data-wallet-action="close-modal">Cancel</button>
            <button type="submit" class="btn btn-primary">Unlock</button>
          </div>
        </form>
      `;
      break;

    case 'rvn-mnemonic':
      modalTitle = 'Incomplete Save Your Recovery Phrase';
      modalContent = `
        <div class="mnemonic-display">
          <p class="warning">Write down these 12 words and keep them safe. You will need them to recover your wallet.</p>
          <div class="mnemonic-words">${walletModalData.mnemonic || ''}</div>
          <div class="mnemonic-address">Address: ${walletModalData.address || ''}</div>
        </div>
        <div class="form-group">
          <label>
            <input type="checkbox" id="mnemonic-confirmed" />
            I have written down my recovery phrase
          </label>
        </div>
        <div class="modal-actions">
          <button type="button" class="btn btn-primary" id="complete-wallet-btn" disabled>Continue</button>
        </div>
      `;
      break;

    case 'rvn-settings':
      modalTitle = 'RVN Wallet Settings';
      modalContent = `
        <div class="settings-section">
          <p>Wallet management options</p>
          <div class="button-group vertical">
            <button class="btn btn-danger" id="delete-wallet-btn">Delete Wallet</button>
          </div>
          <p class="warning-text">Make sure you have your recovery phrase before deleting!</p>
        </div>
        <div class="modal-actions">
          <button type="button" class="btn btn-secondary" data-wallet-action="close-modal">Close</button>
        </div>
      `;
      break;

    case 'ipfs-config':
      modalTitle = 'Configure IPFS';
      const config = State.get('ipfsConfig') || {};
      modalContent = `
        <form id="wallet-modal-form">
          <div class="form-group">
            <label>Gateway URL:</label>
            <input type="text" id="modal-gateway" value="${config.gateway || 'https://ipfs.io'}" required />
          </div>
          <div class="form-group">
            <label>Pinning Service:</label>
            <select id="modal-pinning">
              <option value="none" ${config.pinningService === 'none' ? 'selected' : ''}>None</option>
              <option value="pinata" ${config.pinningService === 'pinata' ? 'selected' : ''}>Pinata</option>
            </select>
          </div>
          <div id="pinata-fields" style="display: ${config.pinningService === 'pinata' ? 'block' : 'none'};">
            <div class="form-group">
              <label>Pinata API Key:</label>
              <input type="text" id="modal-pinata-key" value="${config.pinataKey || ''}" />
            </div>
            <div class="form-group">
              <label>Pinata Secret:</label>
              <input type="password" id="modal-pinata-secret" value="${config.pinataSecret || ''}" />
            </div>
          </div>
          <div id="modal-error" class="error-message" style="display: none;"></div>
          <div class="modal-actions">
            <button type="button" class="btn btn-secondary" data-wallet-action="close-modal">Cancel</button>
            <button type="submit" class="btn btn-primary">Save</button>
          </div>
        </form>
      `;
      break;

    default:
      return '';
  }

  return `
    <div class="wallet-modal-overlay">
      <div class="wallet-modal">
        <div class="modal-header">
          <h3>${modalTitle}</h3>
          <button class="modal-close" data-wallet-action="close-modal">x</button>
        </div>
        <div class="modal-body">
          ${modalContent}
        </div>
      </div>
    </div>
  `;
}

function renderGlobalModal() {
  const walletModal = State.get('walletModal');
  
  // --- Blockchain finalize warning (no fee) ---
  if (walletModal === 'blockchain-finalize-warning') {
    return `
      <div class="wallet-modal-overlay">
        <div class="wallet-modal" style="border: 2px solid #f59e0b; box-shadow: 0 8px 32px rgba(245,158,11,0.25);">
          <div class="modal-header" style="background: linear-gradient(135deg, #78350f, #451a03); border-bottom: 1px solid #f59e0b;">
            <h3>Finalize Project</h3>
            <button class="modal-close" data-wallet-action="close-modal">x</button>
          </div>
          <div class="modal-body">
            <p>Finalizing your project permanently closes it to further iterations. Your creative history will be sealed exactly as it is now.</p>
            <p style="margin-top:12px;">If you plan to continue working on this project, use <strong>Checkpoint Project</strong> instead.</p>
            <p style="color:#f59e0b;font-weight:600;margin-top:16px;">This cannot be undone. No fee in blockchain mode.</p>
            <div class="modal-actions" style="margin-top:20px;">
              <button type="button" class="btn btn-secondary" data-wallet-action="close-modal">Cancel</button>
              <button type="button" class="btn btn-primary" data-wallet-action="confirm-blockchain-finalize" style="background:#d97706;border-color:#d97706;">Finalize Project →</button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  // --- Blockchain finalize clone warning (no fee) ---
  if (walletModal === 'blockchain-finalize-clone-warning') {
    const project = State.get('pendingLockProject');
    const projectName = project ? escapeHtml(project.name) : 'this project';
    return `
      <div class="wallet-modal-overlay">
        <div class="wallet-modal" style="border: 2px solid #f59e0b; box-shadow: 0 8px 32px rgba(245,158,11,0.25);">
          <div class="modal-header" style="background: linear-gradient(135deg, #78350f, #451a03); border-bottom: 1px solid #f59e0b;">
            <h3>Finalize Checkpointed Project</h3>
            <button class="modal-close" data-wallet-action="close-modal">x</button>
          </div>
          <div class="modal-body">
            <p>This project has an active checkpoint. Finalizing will create a sealed copy <strong>"${projectName}_final"</strong>.</p>
            <p style="margin-top:12px;">Your checkpointed project remains open. No fee in blockchain mode.</p>
            <div class="modal-actions" style="margin-top:20px;">
              <button type="button" class="btn btn-secondary" data-wallet-action="close-modal">Cancel</button>
              <button type="button" class="btn btn-primary" data-wallet-action="confirm-blockchain-finalize-clone" style="background:#d97706;border-color:#d97706;">Create Finalized Copy →</button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  // --- Blockchain checkpoint confirm (no fee) ---
  if (walletModal === 'blockchain-checkpoint-confirm') {
    return `
      <div class="wallet-modal-overlay">
        <div class="wallet-modal" style="border: 2px solid #3b82f6; box-shadow: 0 8px 32px rgba(59,130,246,0.25);">
          <div class="modal-header" style="background: linear-gradient(135deg, #1e3a8a, #1e40af); border-bottom: 1px solid #3b82f6;">
            <h3>◇ Checkpoint Project</h3>
            <button class="modal-close" data-wallet-action="close-modal">x</button>
          </div>
          <div class="modal-body">
            <p>Your project progress will be sealed and witnessed at this point.</p>
            <p style="margin-top:12px;color:#93c5fd;">No fee in blockchain mode. You can resume adding iterations after checkpointing.</p>
            <div class="modal-actions" style="margin-top:20px;">
              <button type="button" class="btn btn-secondary" data-wallet-action="close-modal">Cancel</button>
              <button type="button" class="btn btn-primary" data-wallet-action="confirm-blockchain-checkpoint">Checkpoint Project →</button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  // --- Stripe payment element modal ---
  if (walletModal === 'stripe-payment') {
    const action = State.get('stripePaymentAction') || '';
    const project = State.get('stripePaymentProject');
    const amount = State.get('stripePaymentAmount');
    const clientSecret = State.get('stripeClientSecret');
    const actionLabels = {
      'finalize': 'Finalize Project — $5.00',
      'finalize-clone': 'Finalize Checkpointed Project — $5.00',
      'checkpoint': 'Checkpoint Project — $5.00',
      'chain-lock-basic': 'Basic Chain Lock — $50.00',
      'chain-lock-pinned': 'Pinned Chain Lock — $65.00'
    };
    return `
      <div class="wallet-modal-overlay">
        <div class="wallet-modal" style="border:2px solid #635bff;box-shadow:0 8px 32px rgba(99,91,255,0.3);max-width:480px;">
          <div class="modal-header" style="background:linear-gradient(135deg,#1a1870,#231f9e);border-bottom:1px solid #635bff;">
            <h3>💳 Payment</h3>
            <button class="modal-close" data-wallet-action="close-modal">x</button>
          </div>
          <div class="modal-body">
            <div style="background:#0d1117;border:1px solid #30363d;border-radius:6px;padding:10px;margin-bottom:16px;">
              <div style="color:#8b949e;font-size:11px;margin-bottom:4px;">PAYING FOR</div>
              <div style="color:#e6edf3;font-size:14px;font-weight:600;">${actionLabels[action] || action}</div>
              ${project ? `<div style="color:#8b949e;font-size:12px;margin-top:4px;">Project: ${escapeHtml(project.name)}</div>` : ''}
            </div>
            ${clientSecret ? `
              <div id="stripe-payment-element" style="margin-bottom:16px;min-height:120px;">
                <!-- Stripe Payment Element mounts here -->
                <div style="color:#8b949e;font-size:12px;text-align:center;padding:20px;">Loading payment form...</div>
              </div>
              <div id="stripe-payment-error" style="color:#ef4444;font-size:12px;margin-bottom:12px;display:none;"></div>
              <div class="modal-actions">
                <button type="button" class="btn btn-secondary" data-wallet-action="close-modal">Cancel</button>
                <button type="button" class="btn btn-primary" data-wallet-action="stripe-pay" style="background:#635bff;border-color:#635bff;">
                  Pay Now
                </button>
              </div>
            ` : `
              <div style="text-align:center;padding:20px;">
                <div class="spinner" style="margin:0 auto 12px;"></div>
                <p style="color:#8b949e;">Connecting to payment provider...</p>
              </div>
            `}
          </div>
        </div>
      </div>
    `;
  }

  // --- Stripe processing modal ---
  if (walletModal === 'stripe-processing') {
    return `
      <div class="wallet-modal-overlay">
        <div class="wallet-modal" style="border:2px solid #635bff;box-shadow:0 8px 32px rgba(99,91,255,0.3);">
          <div class="modal-header" style="background:linear-gradient(135deg,#1a1870,#231f9e);border-bottom:1px solid #635bff;">
            <h3>Processing...</h3>
          </div>
          <div class="modal-body" style="text-align:center;padding:40px 20px;">
            <div style="font-size:48px;margin-bottom:20px;animation:pulse 1.5s infinite;">⏳</div>
            <p style="font-size:16px;color:#e6edf3;margin-bottom:10px;">Payment confirmed — executing lock...</p>
            <p style="font-size:12px;color:#8b949e;">Verifying payment · Sealing files · Anchoring provenance</p>
            <p style="font-size:12px;color:#8b949e;margin-top:8px;">Please do not close this window.</p>
          </div>
        </div>
      </div>
    `;
  }

  // --- Stripe lock success modal ---
  if (walletModal === 'stripe-lock-success') {
    const result = State.get('stripePaymentResult') || {};
    const action = State.get('stripePaymentAction') || '';
    return `
      <div class="wallet-modal-overlay">
        <div class="wallet-modal" style="border:2px solid #22c55e;box-shadow:0 8px 32px rgba(34,197,94,0.3);">
          <div class="modal-header" style="background:linear-gradient(135deg,#166534,#14532d);border-bottom:1px solid #22c55e;">
            <h3>${action === 'checkpoint' ? '◇ Checkpoint Complete' : '✓ Finalize Complete'}</h3>
          </div>
          <div class="modal-body">
            <div style="text-align:center;margin-bottom:20px;">
              <p style="font-size:18px;color:#22c55e;font-weight:bold;margin:0;">Provenance Sealed</p>
            </div>
            <div style="background:#0d1117;padding:16px;border-radius:8px;margin:16px 0;border:1px solid #30363d;">
              <div style="margin-bottom:8px;">
                <span style="color:#8b949e;font-size:12px;">STATUS</span>
                <div style="color:#22c55e;font-size:13px;font-weight:600;">${action === 'checkpoint' ? 'Checkpointed — resumable' : 'Finalized — sealed'}</div>
              </div>
              ${result.paymentIntentId ? `
              <div>
                <span style="color:#8b949e;font-size:12px;">PAYMENT REFERENCE</span>
                <div style="font-family:'Consolas',monospace;color:#8b949e;font-size:11px;word-break:break-all;">${result.paymentIntentId}</div>
              </div>` : ''}
            </div>
            <div class="modal-actions" style="justify-content:center;">
              <button type="button" class="btn btn-primary" data-wallet-action="close-modal" style="background:#22c55e;border-color:#22c55e;">Continue</button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  // --- Stripe payment error modal ---
  if (walletModal === 'stripe-payment-error') {
    const error = State.get('stripePaymentError') || 'Payment failed. Please try again.';
    return `
      <div class="wallet-modal-overlay">
        <div class="wallet-modal" style="border:2px solid #ef4444;box-shadow:0 8px 32px rgba(239,68,68,0.3);">
          <div class="modal-header" style="background:linear-gradient(135deg,#991b1b,#7f1d1d);border-bottom:1px solid #ef4444;">
            <h3>Payment Failed</h3>
            <button class="modal-close" data-wallet-action="close-modal">x</button>
          </div>
          <div class="modal-body">
            <div style="background:#0d1117;padding:16px;border-radius:8px;border:1px solid #ef4444;margin-bottom:16px;">
              <p style="color:#ef4444;margin:0;font-size:13px;word-break:break-word;">${escapeHtml(error)}</p>
            </div>
            <div class="modal-actions" style="justify-content:center;">
              <button type="button" class="btn btn-secondary" data-wallet-action="close-modal">Close</button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  if (walletModal === 'finalize-warning') {
    return `
      <div class="wallet-modal-overlay">
        <div class="wallet-modal" style="border: 2px solid #f59e0b; box-shadow: 0 8px 32px rgba(245,158,11,0.25);">
          <div class="modal-header" style="background: linear-gradient(135deg, #78350f, #451a03); border-bottom: 1px solid #f59e0b;">
            <h3>Finalize Project</h3>
            <button class="modal-close" data-wallet-action="close-modal">x</button>
          </div>
          <div class="modal-body">
            <p>Finalizing your project permanently closes it to further iterations. Your creative history will be sealed exactly as it is now.</p>
            <p style="margin-top:12px;">If you plan to continue working on this project, use <strong>Checkpoint Project</strong> instead — it preserves your progress and allows you to resume.</p>
            <p style="color:#f59e0b;font-weight:600;margin-top:16px;">This cannot be undone.</p>
            <p style="color:#8b949e;font-size:12px;margin-top:8px;">A $5.00 service fee (5 TSD) applies.</p>
            <div class="modal-actions" style="margin-top:20px;">
              <button type="button" class="btn btn-secondary" data-wallet-action="close-modal">Cancel</button>
              <button type="button" class="btn btn-primary" data-wallet-action="confirm-finalize" style="background:#d97706;border-color:#d97706;">Finalize Project →</button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  if (walletModal === 'finalize-clone-warning') {
    const project = State.get('pendingLockProject');
    const projectName = project ? escapeHtml(project.name) : 'this project';
    return `
      <div class="wallet-modal-overlay">
        <div class="wallet-modal" style="border: 2px solid #f59e0b; box-shadow: 0 8px 32px rgba(245,158,11,0.25);">
          <div class="modal-header" style="background: linear-gradient(135deg, #78350f, #451a03); border-bottom: 1px solid #f59e0b;">
            <h3>Finalize Checkpointed Project</h3>
            <button class="modal-close" data-wallet-action="close-modal">x</button>
          </div>
          <div class="modal-body">
            <p>This project has an active checkpoint. Finalizing will create a sealed copy <strong>"${projectName}_final"</strong> from your current iteration state.</p>
            <p style="margin-top:12px;">Your checkpointed project remains open and can still be resumed. The finalized copy will receive a new project identity (Pre-SCR ID) and its witness history will be cloned from this project.</p>
            <p style="color:#8b949e;font-size:12px;margin-top:12px;">A $5.00 service fee (5 TSD) applies.</p>
            <div class="modal-actions" style="margin-top:20px;">
              <button type="button" class="btn btn-secondary" data-wallet-action="close-modal">Cancel</button>
              <button type="button" class="btn btn-primary" data-wallet-action="confirm-finalize-clone" style="background:#d97706;border-color:#d97706;">Create Finalized Copy →</button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  if (walletModal === 'checkpoint-confirm') {
    return `
      <div class="wallet-modal-overlay">
        <div class="wallet-modal" style="border: 2px solid #3b82f6; box-shadow: 0 8px 32px rgba(59,130,246,0.25);">
          <div class="modal-header" style="background: linear-gradient(135deg, #1e3a8a, #1e40af); border-bottom: 1px solid #3b82f6;">
            <h3>◇ Checkpoint Project</h3>
            <button class="modal-close" data-wallet-action="close-modal">x</button>
          </div>
          <div class="modal-body">
            <p>Your project progress will be sealed and witnessed at this point. A <strong>$5.00 service fee</strong> (5 TSD) applies.</p>
            <p style="margin-top:12px;color:#93c5fd;">You can resume adding iterations after checkpointing.</p>
            <div class="modal-actions" style="margin-top:20px;">
              <button type="button" class="btn btn-secondary" data-wallet-action="close-modal">Cancel</button>
              <button type="button" class="btn btn-primary" data-wallet-action="confirm-checkpoint">Checkpoint Project →</button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  if (walletModal === 'tsd-insufficient') {
    const data = State.get('walletModalData') || {};
    return `
      <div class="wallet-modal-overlay">
        <div class="wallet-modal" style="border: 2px solid #ef4444; box-shadow: 0 8px 32px rgba(239,68,68,0.3);">
          <div class="modal-header" style="background: linear-gradient(135deg, #991b1b, #7f1d1d); border-bottom: 1px solid #ef4444;">
            <h3>Insufficient TSD Balance</h3>
            <button class="modal-close" data-wallet-action="close-modal">x</button>
          </div>
          <div class="modal-body">
            <p>${data.error || 'Not enough TSD to complete this action.'}</p>
            <p style="color:#8b949e;font-size:12px;margin-top:8px;">Add TSD in the Testnet Wallet tab using the Add TSD buttons.</p>
            <div class="modal-actions" style="margin-top:20px;">
              <button type="button" class="btn btn-secondary" data-wallet-action="close-modal">Close</button>
            </div>
          </div>
        </div>
      </div>
    `;
  }


  // --- TSD chain lock confirm (fiat mode) ---
  if (walletModal === 'tsd-chain-lock-confirm') {
    const project = State.get('pendingLockProject');
    const projectName = project ? escapeHtml(project.name) : 'this project';
    return `
      <div class="wallet-modal-overlay">
        <div class="wallet-modal" style="border: 2px solid #a855f7; box-shadow: 0 8px 32px rgba(168,85,247,0.3);">
          <div class="modal-header" style="background: linear-gradient(135deg, #4c1d95, #5b21b6); border-bottom: 1px solid #a855f7;">
            <h3>⛓ Chain Lock — TSD Payment</h3>
            <button class="modal-close" data-wallet-action="close-modal">x</button>
          </div>
          <div class="modal-body">
            <p>You are about to chain lock <strong>${projectName}</strong>.</p>
            <p style="margin-top:12px;">The Oracle will anchor your provenance package to the Ravencoin blockchain, IPFS, and Arweave on your behalf.</p>
            <div style="background:#1e1b4b;border:1px solid #4c1d95;border-radius:6px;padding:12px;margin:16px 0;">
              <div style="display:flex;justify-content:space-between;color:#e6edf3;font-size:13px;margin-bottom:6px;">
                <span>Basic Chain Lock</span><span style="color:#a855f7;font-weight:600;">50 TSD</span>
              </div>
              <div style="display:flex;justify-content:space-between;color:#e6edf3;font-size:13px;">
                <span>Pinned Chain Lock (IPFS)</span><span style="color:#a855f7;font-weight:600;">65 TSD</span>
              </div>
            </div>
            <p style="color:#f59e0b;font-weight:600;font-size:13px;">This action is permanent and cannot be undone.</p>
            <div class="modal-actions" style="margin-top:20px;">
              <button type="button" class="btn btn-secondary" data-wallet-action="close-modal">Cancel</button>
              <button type="button" class="btn btn-primary" data-wallet-action="confirm-tsd-chain-lock" data-lock-tier="basic" style="background:#7c3aed;border-color:#7c3aed;">Basic Lock (50 TSD) →</button>
              <button type="button" class="btn btn-primary" data-wallet-action="confirm-tsd-chain-lock" data-lock-tier="pinned" style="background:#6d28d9;border-color:#6d28d9;margin-left:6px;">Pinned Lock (65 TSD) →</button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  if (walletModal === 'confirm-chain-lock') {
    const pendingProject = State.get('pendingLockProject');
    return `
      <div class="wallet-modal-overlay">
        <div class="wallet-modal">
          <div class="modal-header">
            <h3> Confirm Chain Lock</h3>
            <button class="modal-close" data-wallet-action="close-modal">x</button>
          </div>
          <div class="modal-body">
            <p>You are about to lock <strong>${pendingProject?.name}</strong> to the Ravencoin blockchain.</p>
            <p class="warning">This action is permanent and will cost ~500 RVN.</p>
            <form id="wallet-modal-form">
              <div class="form-group">
                <label>Enter wallet password to confirm:</label>
                <input type="password" id="modal-password" required />
              </div>
              <div id="modal-error" class="error-message" style="display: none;"></div>
              <div class="modal-actions">
                <button type="button" class="btn btn-secondary" data-wallet-action="close-modal">Cancel</button>
                <button type="submit" class="btn btn-primary">Lock to Blockchain</button>
              </div>
            </form>
          </div>
        </div>
      </div>
    `;
  }
  
  if (walletModal === 'confirm-training-lock') {
    const pendingLock = State.get('pendingTrainingLock');
    return `
      <div class="wallet-modal-overlay">
        <div class="wallet-modal">
          <div class="modal-header">
            <h3> Lock Training Run</h3>
            <button class="modal-close" data-wallet-action="close-modal">x</button>
          </div>
          <div class="modal-body">
            <p>You are about to lock training run #${pendingLock?.trainingId} to the Ravencoin blockchain.</p>
            <p class="warning">This action is permanent and will cost ~500 RVN.</p>
            <form id="wallet-modal-form">
              <div class="form-group">
                <label>Enter wallet password to confirm:</label>
                <input type="password" id="modal-password" required />
              </div>
              <div id="modal-error" class="error-message" style="display: none;"></div>
              <div class="modal-actions">
                <button type="button" class="btn btn-secondary" data-wallet-action="close-modal">Cancel</button>
                <button type="submit" class="btn btn-primary">Lock to Blockchain</button>
              </div>
            </form>
          </div>
        </div>
      </div>
    `;
  }
  
  if (walletModal === 'training-folder-info') {
    const vaultPath = State.get('trainingVaultPath') || '';
    return `
      <div class="wallet-modal-overlay">
        <div class="wallet-modal training-folder-modal" style="margin-top: 100px; border: 2px solid #4a90d9; box-shadow: 0 8px 32px rgba(74, 144, 217, 0.3);">
          <div class="modal-header" style="background: linear-gradient(135deg, #2d3748, #1a202c); border-bottom: 1px solid #4a90d9;">
            <h3>Training Project Created</h3>
            <button class="modal-close" data-wallet-action="close-modal">x</button>
          </div>
          <div class="modal-body">
            <p><strong>Important:</strong> Set your Kohya output directory to this folder:</p>
            <div class="vault-path-display" style="background: #0d1117; padding: 12px; border-radius: 6px; margin: 12px 0; word-break: break-all; font-family: 'Consolas', monospace; border: 1px solid #30363d; color: #58a6ff;">
              ${vaultPath}
            </div>
            <p style="color: #8b949e; font-size: 12px; margin-bottom: 16px;">All training outputs (TOML, JSON, checkpoints, final model) should be saved to this folder for proper provenance tracking.</p>
            <div class="modal-actions" style="display: flex; gap: 8px; justify-content: flex-end;">
              <button type="button" class="btn btn-secondary" id="browse-vault-path-btn" title="Open folder in explorer">Open Folder</button>
              <button type="button" class="btn btn-secondary" id="copy-vault-path-btn"> Copy Path</button>
              <button type="button" class="btn btn-primary" data-wallet-action="close-modal">Got it</button>
            </div>
          </div>
        </div>
      </div>
    `;
  }
  
if (walletModal === 'chain-lock-success') {
    const result = State.get('chainLockResult') || {};
    return `
      <div class="wallet-modal-overlay">
        <div class="wallet-modal" style="border: 2px solid #22c55e; box-shadow: 0 8px 32px rgba(34, 197, 94, 0.3);">
          <div class="modal-header" style="background: linear-gradient(135deg, #166534, #14532d); border-bottom: 1px solid #22c55e;">
            <h3>Chain Lock Complete!</h3>
          </div>
          <div class="modal-body">
            <div style="text-align: center; margin-bottom: 20px;">
              <p style="font-size: 18px; color: #22c55e; font-weight: bold; margin: 0;">Provenance Anchored</p>
            </div>
            <div style="background: #0d1117; padding: 16px; border-radius: 8px; margin: 16px 0; border: 1px solid #30363d;">
              <div style="margin-bottom: 12px;">
                <span style="color: #8b949e; font-size: 12px;">ASSET ID</span>
                <div style="font-family: 'Consolas', monospace; color: #58a6ff; font-size: 16px; font-weight: bold;">${result.scrId || 'N/A'}</div>
              </div>
              <div style="margin-bottom: 12px;">
                <span style="color: #8b949e; font-size: 12px;">RAVENCOIN</span>
                <div style="font-family: 'Consolas', monospace; color: ${result.txId ? '#22c55e' : '#ef4444'}; font-size: 11px; word-break: break-all;">${result.txId ? result.txId : 'Failed'}</div>
              </div>
              <div style="margin-bottom: 12px;">
                <span style="color: #8b949e; font-size: 12px;">IPFS</span>
                <div style="font-family: 'Consolas', monospace; color: ${result.ipfsCid ? '#22c55e' : '#ef4444'}; font-size: 11px; word-break: break-all;">${result.ipfsCid || result.ipfsError || 'Not configured'}</div>
              </div>
              <div>
                <span style="color: #8b949e; font-size: 12px;">ARWEAVE</span>
                <div style="font-family: 'Consolas', monospace; color: ${result.arweaveTxId ? '#22c55e' : '#ef4444'}; font-size: 11px; word-break: break-all;">${result.arweaveTxId || result.arweaveError || 'Not configured'}</div>
              </div>
            </div>
            <div class="modal-actions" style="justify-content: center; margin-top: 20px;">
              <button type="button" class="btn btn-primary" id="acknowledge-chain-lock-btn" style="background: #22c55e; border-color: #22c55e; min-width: 150px;">Continue</button>
            </div>
          </div>
        </div>
      </div>
    `;
  }
  
 if (walletModal === 'chain-lock-error') {
    const error = State.get('chainLockError') || {};
    const errorMsg = typeof error === 'string' ? error : error.message || 'Unknown error';
    const failedStep = error.failedStep || null;
    return `
      <div class="wallet-modal-overlay">
        <div class="wallet-modal" style="border: 2px solid #ef4444; box-shadow: 0 8px 32px rgba(239, 68, 68, 0.3);">
          <div class="modal-header" style="background: linear-gradient(135deg, #991b1b, #7f1d1d); border-bottom: 1px solid #ef4444;">
            <h3>Chain Lock Failed</h3>
            <button class="modal-close" data-wallet-action="close-modal">x</button>
          </div>
          <div class="modal-body">
            <div style="background: #0d1117; padding: 16px; border-radius: 8px; margin: 16px 0; border: 1px solid #30363d;">
              <div style="margin-bottom: 12px;">
                <span style="color: #8b949e; font-size: 12px;">RAVENCOIN</span>
                <div style="font-family: 'Consolas', monospace; color: ${failedStep ? '#22c55e' : '#ef4444'}; font-size: 11px;">${failedStep ? (error.proofTxId || 'Success') : 'Failed'}</div>
              </div>
              <div style="margin-bottom: 12px;">
                <span style="color: #8b949e; font-size: 12px;">IPFS</span>
                <div style="font-family: 'Consolas', monospace; color: ${failedStep === 'arweave' ? '#22c55e' : (failedStep === 'ipfs' ? '#ef4444' : '#8b949e')}; font-size: 11px;">${failedStep === 'arweave' ? (error.ipfsCid || 'Success') : (failedStep === 'ipfs' ? 'Failed' : 'Not attempted')}</div>
              </div>
              <div>
                <span style="color: #8b949e; font-size: 12px;">ARWEAVE</span>
                <div style="font-family: 'Consolas', monospace; color: ${failedStep === 'arweave' ? '#ef4444' : '#8b949e'}; font-size: 11px;">${failedStep === 'arweave' ? 'Failed' : 'Not attempted'}</div>
              </div>
            </div>
            <div style="background: #1c1917; padding: 12px; border-radius: 6px; border: 1px solid #ef4444;">
              <p style="color: #ef4444; margin: 0; font-size: 13px;">${errorMsg}</p>
            </div>
            <div class="modal-actions" style="justify-content: center; margin-top: 20px;">
              <button type="button" class="btn btn-secondary" data-wallet-action="close-modal">Close</button>
            </div>
          </div>
        </div>
      </div>
    `;
  }
  
  if (walletModal === 'chain-lock-progress') {
    return `
      <div class="wallet-modal-overlay">
        <div class="wallet-modal" style="border: 2px solid #3b82f6; box-shadow: 0 8px 32px rgba(59, 130, 246, 0.3);">
          <div class="modal-header" style="background: linear-gradient(135deg, #1e40af, #1e3a8a); border-bottom: 1px solid #3b82f6;">
            <h3>Chain Lock in Progress</h3>
          </div>
          <div class="modal-body" style="text-align: center; padding: 40px 20px;">
            <div style="font-size: 48px; margin-bottom: 20px; animation: pulse 1.5s infinite;">&#9203;</div>
            <p style="font-size: 16px; color: #e5e7eb; margin-bottom: 10px;">Locking to RVN, IPFS, and Arweave...</p>
            <p style="font-size: 12px; color: #8b949e;">This may take a few minutes for large files.</p>
            <p style="font-size: 12px; color: #8b949e; margin-top: 20px;">Please do not close this window.</p>
          </div>
        </div>
      </div>
    `;
  }
  if (walletModal === 'persistent-lock-success') {
    const result = State.get('persistentLockResult') || {};
    return `
      <div class="wallet-modal-overlay">
        <div class="wallet-modal" style="border: 2px solid #8b5cf6; box-shadow: 0 8px 32px rgba(139, 92, 246, 0.3);">
          <div class="modal-header" style="background: linear-gradient(135deg, #5b21b6, #4c1d95); border-bottom: 1px solid #8b5cf6;">
            <h3>Persistent Lock Complete!</h3>
          </div>
          <div class="modal-body">
            <div style="text-align: center; margin-bottom: 20px;">
              <div style="font-size: 48px; margin-bottom: 10px;">LOCKED</div>
              <p style="font-size: 18px; color: #8b5cf6; font-weight: bold; margin: 0;">Provenance Permanently Anchored</p>
            </div>
            <div style="background: #0d1117; padding: 16px; border-radius: 8px; margin: 16px 0; border: 1px solid #30363d;">
              <div style="margin-bottom: 12px;">
                <span style="color: #8b949e; font-size: 12px;">ASSET ID</span>
                <div style="font-family: 'Consolas', monospace; color: #8b5cf6; font-size: 16px; font-weight: bold;">${result.scrId || 'N/A'}</div>
              </div>
              ${result.arweaveTxId ? `
              <div style="margin-bottom: 12px;">
                <span style="color: #8b949e; font-size: 12px;">ARWEAVE TX</span>
                <div style="font-family: 'Consolas', monospace; color: #8b949e; font-size: 11px; word-break: break-all;">${result.arweaveTxId}</div>
              </div>
              ` : ''}
              ${result.ipfsCid ? `
              <div>
                <span style="color: #8b949e; font-size: 12px;">IPFS CID</span>
                <div style="font-family: 'Consolas', monospace; color: #8b949e; font-size: 11px; word-break: break-all;">${result.ipfsCid}</div>
              </div>
              ` : ''}
            </div>
            <p style="color: #8b949e; font-size: 12px; text-align: center;">Your provenance is now on Ravencoin, Arweave, and IPFS.</p>
            <div class="modal-actions" style="justify-content: center; margin-top: 20px;">
              <button type="button" class="btn btn-primary" id="acknowledge-persistent-lock-btn" style="background: #8b5cf6; border-color: #8b5cf6; min-width: 150px;">Continue</button>
            </div>
          </div>
        </div>
      </div>
    `;
  }
  
  if (walletModal === 'persistent-lock-error') {
    const error = State.get('persistentLockError') || 'Unknown error';
    return `
      <div class="wallet-modal-overlay">
        <div class="wallet-modal" style="border: 2px solid #ef4444; box-shadow: 0 8px 32px rgba(239, 68, 68, 0.3);">
          <div class="modal-header" style="background: linear-gradient(135deg, #991b1b, #7f1d1d); border-bottom: 1px solid #ef4444;">
            <h3>Persistent Lock Failed</h3>
            <button class="modal-close" data-wallet-action="close-modal">x</button>
          </div>
          <div class="modal-body">
            <div style="text-align: center; margin-bottom: 20px;">
              <div style="font-size: 48px; margin-bottom: 10px;">ERROR</div>
            </div>
            <div style="background: #0d1117; padding: 16px; border-radius: 8px; margin: 16px 0; border: 1px solid #ef4444;">
              <p style="color: #ef4444; margin: 0; word-break: break-word;">${error}</p>
            </div>
            <p style="color: #8b949e; font-size: 12px; text-align: center;">Check Arweave balance and IPFS configuration, then try again.</p>
            <div class="modal-actions" style="justify-content: center; margin-top: 20px;">
              <button type="button" class="btn btn-secondary" data-wallet-action="close-modal">Close</button>
            </div>
          </div>
        </div>
      </div>
    `;
  }
  return '';
}

function renderDebugConsole(logs) {
  return `
    <div class="debug-console" id="debug-console">
      <div class="debug-header">
        <span>Debug Console</span>
        <button class="close-debug" id="close-debug">x</button>
      </div>
      <div class="debug-log">
        ${logs.map(log => `
          <div class="log-entry ${log.level}">
            <span class="log-time">${log.timestamp}</span>
            <span class="log-level">[${log.level.toUpperCase()}]</span>
            <span class="log-message">${escapeHtml(log.message)}</span>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}
