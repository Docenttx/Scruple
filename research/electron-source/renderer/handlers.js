/**
 * handlers.js - SCRUPLE Studio DOM Event Handlers
 *
 * Sets up DOM event delegation after each render cycle.
 * Called by renderMainApp on every render.
 *
 * Depends on: state.js, api.js, render-main.js
 * (all functions referenced here are globally available)
 *
 * SCRUPLE Studio — Patent Pending
 */

function setupMainAppHandlers() {
  document.querySelectorAll('.view-toggle-btn[data-view]').forEach(btn => {
    btn.addEventListener('click', () => {
      State.set('currentView', btn.dataset.view);
      if (btn.dataset.walletMode) {
        State.set('walletMode', btn.dataset.walletMode);
      }
      renderApp();
    });
  });

  document.querySelectorAll('.project-main.clickable').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const projectId = parseInt(el.dataset.viewProject);
      const projects = State.get('projects') || [];
      const project = projects.find(p => p.id === projectId);
      if (project) viewProject(project);
    });
  });

  document.querySelectorAll('.select-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const projectId = parseInt(btn.dataset.projectId);
      const projects = State.get('projects') || [];
      const project = projects.find(p => p.id === projectId);
      if (project) viewProject(project);
    });
  });

  document.querySelectorAll('.activate-btn, .action-btn.activate').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const projectId = parseInt(btn.dataset.projectId);
      const projects = State.get('projects') || [];
      const project = projects.find(p => p.id === projectId);
      if (project) activateProjectTracking(project);
    });
  });

  document.querySelectorAll('.stop-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await deactivateProject();
    });
  });

  document.querySelectorAll('.archive-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const projectId = parseInt(btn.dataset.projectId);
      const projects = State.get('projects') || [];
      const project = projects.find(p => p.id === projectId);
      if (project && confirm(`Archive project "${project.name}"?\n\nIt will be hidden from the workspace but can be restored later.`)) {
        try {
          const result = await window.scruple.archiveProject(projectId);
          if (result.success) {
            addLog('info', 'Archived project: ' + project.name);
            await fetchProjects();
            State.set('selectedProject', null);
          } else {
            addLog('error', 'Archive failed: ' + result.error);
          }
        } catch (error) {
          addLog('error', 'Archive error: ' + error.message);
        }
      }
    });
  });

  const stopTrackingBtn = document.getElementById('stop-tracking-btn');
  if (stopTrackingBtn) {
    stopTrackingBtn.addEventListener('click', async () => {
      await deactivateProject();
    });
  }

  const newProjectBtn = document.getElementById('new-project-btn');
  const newProjectForm = document.getElementById('new-project-form');
  
  if (newProjectBtn) {
    newProjectBtn.addEventListener('click', () => {
      newProjectForm.style.display = 'block';
      document.getElementById('new-project-name').focus();
    });
  }

  if (newProjectForm) {
    const form = newProjectForm.querySelector('form');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = document.getElementById('new-project-name').value.trim();
      const type = document.getElementById('new-project-type').value;
      if (name) {
        await createProject(name, type);
        document.getElementById('new-project-name').value = '';
        document.getElementById('new-project-type').value = 'txt2img';
        newProjectForm.style.display = 'none';
      }
    });

    document.getElementById('cancel-new-project').addEventListener('click', () => {
      newProjectForm.style.display = 'none';
    });
  }

  // Lock / Checkpoint buttons — modal-gated flows
  document.querySelectorAll('.lock-btn, .lock-btn-large').forEach(btn => {
    btn.addEventListener('click', () => {
      const lockType = btn.dataset.lock;
      const project = State.get('selectedProject');

      if (lockType === 'local') {
        if (!project) return;
        const paymentMode = State.get('paymentMode') || 'fiat';
        if (paymentMode === 'blockchain') {
          // Blockchain mode — no TSD fee, direct confirmation
          if (project.status === 'checkpointed') {
            State.set('walletModal', 'blockchain-finalize-clone-warning');
          } else {
            State.set('walletModal', 'blockchain-finalize-warning');
          }
        } else {
          // Fiat mode — TSD fee gate
          if (project.status === 'checkpointed') {
            State.set('walletModal', 'finalize-clone-warning');
          } else {
            State.set('walletModal', 'finalize-warning');
          }
        }
        State.set('pendingLockProject', project);
        renderApp();
      } else if (lockType === 'checkpoint') {
        if (!project) return;
        const paymentMode = State.get('paymentMode') || 'fiat';
        if (paymentMode === 'blockchain') {
          State.set('walletModal', 'blockchain-checkpoint-confirm');
        } else {
          State.set('walletModal', 'checkpoint-confirm');
        }
        State.set('pendingLockProject', project);
        renderApp();
      } else {
        // chain lock — route by payment mode
        if (!project) return;
        const walletMode = State.get('walletMode') || 'fiat';
        if (walletMode === 'fiat') {
          // Fiat/TSD flow — TSD gate handles payment, no RVN password needed
          State.set('walletModal', 'tsd-chain-lock-confirm');
          State.set('pendingLockProject', project);
          renderApp();
        } else {
          // Blockchain flow — RVN wallet password required
          if (!confirm('This will permanently lock the project. Continue?')) return;
          performLock(lockType);
        }
      }
    });
  });

  // Training lock buttons
  document.querySelectorAll('.training-lock-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const trainingId = parseInt(btn.dataset.trainingId);
      const lockType = btn.dataset.lock;
      if (lockType !== 'local') {
        if (!confirm('This will permanently lock the training run. Continue?')) return;
      }
      performTrainingLock(trainingId, lockType);
    });
  });

  const toggleDebugBtn = document.getElementById('toggle-debug');
  if (toggleDebugBtn) {
    toggleDebugBtn.addEventListener('click', () => {
      const debugConsole = document.getElementById('debug-console');
      if (debugConsole) debugConsole.classList.toggle('visible');
    });
  }

  const closeDebugBtn = document.getElementById('close-debug');
  if (closeDebugBtn) {
    closeDebugBtn.addEventListener('click', () => {
      const debugConsole = document.getElementById('debug-console');
      if (debugConsole) debugConsole.classList.remove('visible');
    });
  }

  const retryComfyBtn = document.getElementById('retry-comfy');
  if (retryComfyBtn) {
    retryComfyBtn.addEventListener('click', () => {
      // Reset retry state
      State.set('comfyRetryCount', 0);
      State.set('comfyRetryPaused', false);
      addLog('info', 'Retrying ComfyUI connection...');
      
      const webview = document.getElementById('comfy-webview');
      if (webview) {
        try { webview.reload(); } catch (e) {}
      }
      renderApp();  // Update UI to show "Connecting..." state
    });
  }

  const retryKohyaBtn = document.getElementById('retry-kohya');
  if (retryKohyaBtn) {
    retryKohyaBtn.addEventListener('click', async () => {
      // Reset retry state
      State.set('kohyaRetryCount', 0);
      State.set('kohyaRetryPaused', false);
      addLog('info', 'Detecting Kohya_ss...');
      
      await detectKohyaPort();
      renderApp();
    });
  }
  
  loadIterationImages();
  setupWalletHandlers();
}

/**
 * Initiate Stripe payment flow for a given action.
 * Replaces requestTsdAuth — mounts Stripe Payment Element in modal.
 */
async function initiateStripePayment(action, project, options) {
  await performStripePaymentAndLock(action, project, options || {});
}

/**
 * Perform a project checkpoint (seal progress, allow resumption).
 */
async function performCheckpoint(projectId, authToken) {
  try {
    const result = await window.scruple.checkpointProject(projectId, authToken);
    if (result.success) {
      addLog('info', 'Project checkpointed successfully');
      await fetchProjects();
      const projects = State.get('projects') || [];
      const updated = projects.find(p => p.id === projectId);
      if (updated) State.set('selectedProject', updated);
      renderApp();
    } else {
      addLog('error', 'Checkpoint failed: ' + result.error);
    }
  } catch (err) {
    addLog('error', 'Checkpoint error: ' + err.message);
  }
}

function setupWalletHandlers() {
  document.querySelectorAll('[data-wallet-action]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      const action = btn.dataset.walletAction;
      
      switch (action) {
        case 'create-rvn':
          State.set('walletModal', 'rvn-create');
          renderApp();
          break;
        case 'import-rvn':
          State.set('walletModal', 'rvn-import');
          renderApp();
          break;
        case 'unlock-rvn':
          State.set('walletModal', 'rvn-unlock');
          renderApp();
          break;
        case 'lock-rvn':
          await lockRvnWallet();
          break;
        case 'settings-rvn':
          State.set('walletModal', 'rvn-settings');
          renderApp();
          break;
        case 'refresh-rvn':
          await refreshRvnWallet();
          break;
        case 'connect-arweave':
          await connectArweave();
          break;
        case 'disconnect-arweave':
          await disconnectArweave();
          break;
        case 'config-ipfs':
          State.set('walletModal', 'ipfs-config');
          renderApp();
          break;
        case 'test-ipfs':
          await testIpfsConnection();
          break;

        // --- Finalize confirm (non-checkpointed project) ---
        case 'confirm-finalize': {
          const project = State.get('pendingLockProject');
          if (!project) break;
          await initiateStripePayment('finalize', project);
          break;
        }

        // --- Finalize confirm (checkpointed project — clone flow) ---
        case 'confirm-finalize-clone': {
          const project = State.get('pendingLockProject');
          if (!project) break;
          await initiateStripePayment('finalize-clone', project);
          break;
        }

        // --- Checkpoint confirm ---
        case 'confirm-checkpoint': {
          const project = State.get('pendingLockProject');
          if (!project) break;
          await initiateStripePayment('checkpoint', project);
          break;
        }

        // --- Blockchain finalize (no TSD fee) ---
        case 'confirm-blockchain-finalize': {
          State.set('walletModal', null);
          renderApp();
          const project = State.get('pendingLockProject');
          if (!project) break;
          addLog('info', 'Blockchain mode — finalizing project...');
          await performLock('local', project.id, null);
          State.set('pendingLockProject', null);
          break;
        }

        // --- Blockchain finalize clone (no TSD fee) ---
        case 'confirm-blockchain-finalize-clone': {
          State.set('walletModal', null);
          renderApp();
          const project = State.get('pendingLockProject');
          if (!project) break;
          addLog('info', 'Blockchain mode — cloning and finalizing...');
          try {
            const result = await window.scruple.localDiscLock(project.id, null);
            if (result.success) {
              addLog('info', 'Finalized clone created: ' + (result.clonedName || ''));
              await fetchProjects();
              renderApp();
            } else {
              addLog('error', 'Finalize clone failed: ' + result.error);
            }
          } catch (err) {
            addLog('error', 'Finalize clone error: ' + err.message);
          }
          State.set('pendingLockProject', null);
          break;
        }

        // --- Blockchain checkpoint (no TSD fee) ---
        case 'confirm-blockchain-checkpoint': {
          State.set('walletModal', null);
          renderApp();
          const project = State.get('pendingLockProject');
          if (!project) break;
          addLog('info', 'Blockchain mode — checkpointing project...');
          await performCheckpoint(project.id, null);
          State.set('pendingLockProject', null);
          break;
        }

        // --- Stripe chain lock confirm (fiat mode) ---
        case 'confirm-tsd-chain-lock': {
          const project = State.get('pendingLockProject');
          if (!project) break;
          const lockTier = btn.dataset.lockTier || 'basic';
          const stripeAction = lockTier === 'pinned' ? 'chain-lock-pinned' : 'chain-lock-basic';
          await initiateStripePayment(stripeAction, project, { lockTier });
          break;
        }

        // --- Stripe payment — user clicks Pay button in payment modal ---
        case 'stripe-pay': {
          await executeStripePayment();
          break;
        }

        case 'close-modal':
          State.set('walletModal', null);
          State.set('walletModalData', {});
          State.set('pendingLockProject', null);
          State.set('pendingTrainingLock', null);
          renderApp();
          break;
      }
    });
  });
  
  document.querySelectorAll('[data-copy]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const text = btn.dataset.copy;
      if (text) copyToClipboard(text);
    });
  });
  
  document.querySelectorAll('[data-external-link]').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const url = link.dataset.externalLink;
      if (url) window.scruple.openExternal(url);
    });
  });
  
  const mnemonicCheckbox = document.getElementById('mnemonic-confirmed');
  const completeBtn = document.getElementById('complete-wallet-btn');
  if (mnemonicCheckbox && completeBtn) {
    mnemonicCheckbox.addEventListener('change', () => {
      completeBtn.disabled = !mnemonicCheckbox.checked;
    });
    completeBtn.addEventListener('click', async () => {
      State.set('walletModal', null);
      State.set('walletModalData', {});
      await refreshRvnWallet();
    });
  }
  
  const deleteBtn = document.getElementById('delete-wallet-btn');
  if (deleteBtn) {
    deleteBtn.addEventListener('click', deleteRvnWallet);
  }
  
  const copyVaultPathBtn = document.getElementById('copy-vault-path-btn');
  if (copyVaultPathBtn) {
    copyVaultPathBtn.addEventListener('click', () => {
      const vaultPath = State.get('trainingVaultPath');
      if (vaultPath) {
        copyToClipboard(vaultPath);
        copyVaultPathBtn.textContent = 'Copied!';
        setTimeout(() => {
          copyVaultPathBtn.textContent = ' Copy Path';
        }, 2000);
      }
    });
  }
  
  const browseVaultPathBtn = document.getElementById('browse-vault-path-btn');
  if (browseVaultPathBtn) {
    browseVaultPathBtn.addEventListener('click', () => {
      const vaultPath = State.get('trainingVaultPath');
      if (vaultPath) {
        window.scruple.openFolder(vaultPath);
      }
    });
  }
  
  const acknowledgeChainLockBtn = document.getElementById('acknowledge-chain-lock-btn');
  if (acknowledgeChainLockBtn) {
    acknowledgeChainLockBtn.addEventListener('click', acknowledgeChainLockSuccess);
  }

  const pinningSelect = document.getElementById('modal-pinning');
  const pinataFields = document.getElementById('pinata-fields');
  if (pinningSelect && pinataFields) {
    pinningSelect.addEventListener('change', () => {
      pinataFields.style.display = pinningSelect.value === 'pinata' ? 'block' : 'none';
    });
  }
}

async function loadIterationImages() {
  const imageElements = document.querySelectorAll('.iteration-image[data-project][data-image]');
  for (const el of imageElements) {
    const projectName = el.dataset.project;
    const imageFilename = el.dataset.image;
    if (projectName && imageFilename) {
      try {
        const dataUrl = await window.scruple.readImage(projectName, imageFilename);
        if (dataUrl) {
          el.innerHTML = `<img src="${dataUrl}" alt="Iteration">`;
        }
      } catch (e) {}
    }
  }
  
  const thumbElements = document.querySelectorAll('.iteration-thumb[data-project][data-image]');
  for (const el of thumbElements) {
    const projectName = el.dataset.project;
    const imageFilename = el.dataset.image;
    if (projectName && imageFilename) {
      try {
        const dataUrl = await window.scruple.readImage(projectName, imageFilename);
        if (dataUrl) {
          el.innerHTML = `<img src="${dataUrl}" alt="Thumbnail">`;
        }
      } catch (e) {}
    }
  }
}
