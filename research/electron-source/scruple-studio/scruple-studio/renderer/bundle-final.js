/**
 * bundle.js - SCRUPLE Studio Renderer Entry Point
 *
 * Initialization only. All application code is in:
 *   state.js             — reactive state
 *   api.js               — API functions and event listeners
 *   render-main.js       — app shell rendering
 *   render-workspace.js  — workspace rendering
 *   render-wallet.js     — wallet and modal rendering
 *   handlers.js          — DOM event handler setup
 *
 * SCRUPLE Studio V3 + Kohya_ss Integration
 * Patent Pending
 */

// ============================================================================
// HANDLER SETUP — extracted to handlers.js
// ============================================================================

// ============================================================================
// INITIALIZATION
// ============================================================================

// Wire renderApp to state changes
State.subscribe(renderApp);

// ============================================================================
// NETWORK TAB — Testnet / Mainnet tab switching with mainnet confirmation
// ============================================================================

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-network]');
  if (!btn) return;

  const network = btn.dataset.network;
  const current = State.get('activeNetwork') || 'testnet';
  if (network === current) {
    // Already on this network — just switch view to wallet
    State.set('currentView', 'wallet');
    return;
  }

  if (network === 'testnet') {
    State.set('activeNetwork', 'testnet');
    State.set('currentView', 'wallet');
    return;
  }

  if (network === 'mainnet') {
    // Show confirmation overlay before activating mainnet
    const overlay = document.createElement('div');
    overlay.id = 'mainnet-confirm-overlay';
    overlay.style.cssText = `
      position: fixed; inset: 0; background: rgba(0,0,0,0.75);
      display: flex; align-items: center; justify-content: center;
      z-index: 9999;
    `;
    overlay.innerHTML = `
      <div style="
        background: #161b22; border: 2px solid #f59e0b;
        border-radius: 12px; padding: 32px; max-width: 420px; width: 90%;
        box-shadow: 0 8px 32px rgba(245,158,11,0.3);
      ">
        <div style="text-align: center; margin-bottom: 20px;">
          <div style="font-size: 40px; margin-bottom: 12px;">⚠️</div>
          <h3 style="color: #f59e0b; margin: 0 0 8px; font-size: 18px;">Activate Mainnet?</h3>
          <p style="color: #8b949e; font-size: 13px; margin: 0;">
            You are switching to <strong style="color: #e6edf3;">Mainnet</strong>.<br>
            Chain locks will use <strong style="color: #ef4444;">real RVN</strong> and real AR.<br>
            Each chain lock burns ~500 RVN.
          </p>
        </div>
        <div style="background: #0d1117; border: 1px solid #30363d; border-radius: 8px; padding: 12px; margin-bottom: 20px;">
          <p style="color: #f59e0b; font-size: 12px; margin: 0; text-align: center;">
            Make sure your mainnet wallets are funded before locking.
          </p>
        </div>
        <div style="display: flex; gap: 12px; justify-content: center;">
          <button id="mainnet-confirm-cancel" style="
            padding: 10px 24px; border-radius: 6px; border: 1px solid #30363d;
            background: transparent; color: #8b949e; cursor: pointer; font-size: 14px;
          ">Cancel</button>
          <button id="mainnet-confirm-ok" style="
            padding: 10px 24px; border-radius: 6px; border: 1px solid #f59e0b;
            background: #f59e0b; color: #000; cursor: pointer; font-size: 14px; font-weight: 700;
          ">Yes, Use Mainnet</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    document.getElementById('mainnet-confirm-cancel').addEventListener('click', () => {
      overlay.remove();
    });

    document.getElementById('mainnet-confirm-ok').addEventListener('click', () => {
      overlay.remove();
      State.set('activeNetwork', 'mainnet');
      State.set('currentView', 'wallet');
    });
  }
});

// ============================================================================
// NETWORK SELECT — legacy dropdown handler (kept for fallback compatibility)
// ============================================================================
document.addEventListener('change', async (e) => {
  if (e.target.dataset.walletAction !== 'set-network') return;
  const network = e.target.value;
  const current = State.get('rvnNetwork') || 'rvn';
  if (network === current) return;

  const result = await window.scruple.rvnSetNetwork(network);
  if (result && result.success) {
    State.set('rvnNetwork', network);
    // Show a non-blocking notification rather than blocking alert
    const msg = result.message || `Network set to ${network === 'rvn-test' ? 'TESTNET' : 'Mainnet'}. Restart SCRUPLE Studio to apply.`;
    // Reuse the log system; also show a temporary banner via state
    State.set('networkChangeNotice', msg);
    renderApp();
    // Clear notice after 8 seconds
    setTimeout(() => { State.set('networkChangeNotice', null); renderApp(); }, 8000);
  } else {
    // Revert the select to current value on failure
    e.target.value = current;
    alert('Failed to change network: ' + ((result && result.error) || 'Unknown error'));
  }
});

// Global form submit handler for wallet modals
// (defined here, not in handlers.js, because it must run exactly once on page load)
document.addEventListener('submit', async (e) => {
  if (e.target.id !== 'wallet-modal-form') return;
  e.preventDefault();
  const modalType = State.get('walletModal');
  const errorEl = document.getElementById('modal-error');
  
  if (modalType === 'rvn-create') {
    const password = document.getElementById('modal-password').value;
    const confirm = document.getElementById('modal-confirm-password').value;
    if (password.length < 8) {
      errorEl.textContent = 'Password must be at least 8 characters';
      errorEl.style.display = 'block';
      return;
    }
    if (password !== confirm) {
      errorEl.textContent = 'Passwords do not match';
      errorEl.style.display = 'block';
      return;
    }
    await createRvnWallet(password);
  } else if (modalType === 'rvn-import') {
    const mnemonic = document.getElementById('modal-mnemonic').value.trim();
    const password = document.getElementById('modal-password').value;
    const confirm = document.getElementById('modal-confirm-password').value;
    if (!mnemonic) {
      errorEl.textContent = 'Please enter recovery phrase';
      errorEl.style.display = 'block';
      return;
    }
    if (password.length < 8) {
      errorEl.textContent = 'Password must be at least 8 characters';
      errorEl.style.display = 'block';
      return;
    }
    if (password !== confirm) {
      errorEl.textContent = 'Passwords do not match';
      errorEl.style.display = 'block';
      return;
    }
    await importRvnWallet(mnemonic, password);
  } else if (modalType === 'rvn-unlock') {
    const password = document.getElementById('modal-password').value;
    if (!password) {
      errorEl.textContent = 'Please enter password';
      errorEl.style.display = 'block';
      return;
    }
    await unlockRvnWallet(password);
  } else if (modalType === 'confirm-chain-lock') {
    const password = document.getElementById('modal-password').value;
    if (!password) {
      errorEl.textContent = 'Please enter password';
      errorEl.style.display = 'block';
      return;
    }
    const pendingProject = State.get('pendingLockProject');
    State.set('walletModal', null);
    State.set('pendingLockProject', null);
    await executeChainLock(pendingProject.id, password);
  } else if (modalType === 'confirm-training-lock') {
    const password = document.getElementById('modal-password').value;
    if (!password) {
      errorEl.textContent = 'Please enter password';
      errorEl.style.display = 'block';
      return;
    }
    const pendingLock = State.get('pendingTrainingLock');
    State.set('walletModal', null);
    State.set('pendingTrainingLock', null);
    await executeTrainingChainLock(pendingLock.trainingId, password);
  } else if (modalType === 'ipfs-config') {
    const config = {
      gateway: document.getElementById('modal-gateway').value,
      pinningService: document.getElementById('modal-pinning').value
    };
    if (config.pinningService === 'pinata') {
      config.pinataKey = document.getElementById('modal-pinata-key').value;
      config.pinataSecret = document.getElementById('modal-pinata-secret').value;
    }
    await saveIpfsConfig(config);
  }
});

// Boot
document.addEventListener('DOMContentLoaded', async () => {
  console.log('[RENDERER] DOMContentLoaded fired');
  setupEventListeners();

  // Load active network from main process config before first render
  try {
    const netResult = await window.scruple.rvnGetNetwork();
    if (netResult && netResult.network) {
      State.set('rvnNetwork', netResult.network);
    }
  } catch (e) {
    console.warn('[RENDERER] Could not load network setting:', e.message);
  }

  initializeApp();
});
