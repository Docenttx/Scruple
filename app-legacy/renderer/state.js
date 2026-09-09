/**
 * state.js - SCRUPLE Studio Reactive State
 *
 * Simple reactive state container. Loaded first — no dependencies.
 * All other renderer files depend on State being defined.
 *
 * SCRUPLE Studio — Patent Pending
 */

// ============================================================================
// SIMPLE REACTIVE FRAMEWORK (No React dependency for simplicity)
// ============================================================================

const State = {
  data: {},
  subscribers: [],
  renderPending: false,
  
  set(key, value) {
    this.data[key] = value;
    this.scheduleNotify();
  },
  
  // Update state without triggering re-render (for logs, etc.)
  setSilent(key, value) {
    this.data[key] = value;
  },
  
  get(key) {
    return this.data[key];
  },
  
  subscribe(callback) {
    this.subscribers.push(callback);
  },
  
  // Debounced notify - batches rapid state changes into single render
  scheduleNotify() {
    if (this.renderPending) return;
    this.renderPending = true;
    requestAnimationFrame(() => {
      this.renderPending = false;
      this.notify();
    });
  },
  
  notify() {
    this.subscribers.forEach(cb => cb(this.data));
  }
};

// ============================================================================
// APPLICATION STATE
// ============================================================================

State.set('needsSetup', true);
State.set('isLoading', true);
State.set('sessionId', null);
State.set('port', null);
State.set('config', null);
State.set('projects', []);
State.set('activeProject', null);
State.set('selectedProject', null);
State.set('isInterlocked', false);
State.set('logs', []);
State.set('comfyConnected', false);
State.set('currentView', 'comfyui');
State.set('iterations', []);

// Wallet state
State.set('rvnStatus', null);
State.set('rvnLoading', true);
State.set('arweaveConnected', false);
State.set('arweaveAddress', null);
State.set('arweaveBalance', 0);
State.set('ipfsConfig', null);
State.set('walletModal', null);
State.set('walletModalData', {});

// Kohya_ss / Training state
State.set('kohyaConnected', false);
State.set('kohyaPort', null);
State.set('trainingRuns', []);
State.set('pendingTraining', null);

// Connection retry state - prevent infinite error loops
State.set('comfyUIEnabled', true);
State.set('kohyaEnabled', false);
State.set('comfyRetryCount', 0);
State.set('comfyRetryPaused', false);  // true = stopped retrying, show manual retry
State.set('kohyaRetryCount', 0);
State.set('kohyaRetryPaused', false);
const MAX_AUTO_RETRIES = 3;  // Max automatic retries before pausing

// Pre-flight state (Phase 7)
State.set('preflightStatus', null);
State.set('preflightRunning', false);

// Network tab — testnet default, mainnet requires confirmation
State.set('activeNetwork', 'testnet');

// Network tab visibility (controlled by Window menu)
State.set('testnetEnabled', true);
State.set('mainnetEnabled', false);
