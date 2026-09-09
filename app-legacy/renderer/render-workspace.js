/**
 * render-workspace.js - SCRUPLE Studio Workspace Rendering
 *
 * Renders the workspace tab: project details, iteration grid,
 * training run cards, and pre-flight verification panel.
 *
 * Depends on: state.js, api.js
 *
 * SCRUPLE Studio — Patent Pending
 */

function renderWorkspace(project, activeProject, iterations = [], trainingRuns = [], isInterlocked = false) {
  if (!project) {
    return `
      <div class="workspace-empty">
        <h2>No Project Selected</h2>
        <p>Select a project from the sidebar to view details, or create a new one.</p>
      </div>
    `;
  }

  const isActive = activeProject && activeProject.id === project.id;
  const statusLabels = {
    'unlocked': 'Unlocked',
    'checkpointed': 'Checkpointed',
    'local_locked': 'Finalized',
    'chain_locked': 'Chain Locked',
    'persistent_locked': 'Persistent Locked',
    'permanent_locked': 'Permanent Locked'
  };

  const hasIterations = iterations.length > 0;
  const hasTrainingRuns = trainingRuns.length > 0;
  const hasContent = project.type === 'training' ? hasTrainingRuns : hasIterations;
  const showLockSection = !isActive;
  const localDisabled = !hasContent || isInterlocked;
  const chainDisabled = !hasContent || isInterlocked;
  

  return `
    <div class="workspace">
      <div class="workspace-header">
        <div class="workspace-title">
          <h1>${escapeHtml(project.name)}</h1>
          <span class="status-badge ${project.status}">${statusLabels[project.status] || project.status}</span>
          ${isActive ? '<span class="active-badge">Tracking TRACKING</span>' : ''}
        </div>
        <div class="workspace-actions">
          ${!isActive ? `
            <button class="action-btn activate" data-project-id="${project.id}" ${isInterlocked ? 'disabled' : ''}>
              Start Tracking
            </button>
          ` : `
            <button class="action-btn stop" id="stop-tracking-btn">
              Stop Tracking
            </button>
          `}
        </div>
      </div>

      <div class="workspace-stats">
        ${project.type === 'training' ? `
          <div class="stat-card">
            <span class="stat-value">${trainingRuns.length || 0}</span>
            <span class="stat-label">Training Runs</span>
          </div>
        ` : `
          <div class="stat-card">
            <span class="stat-value">${project.iteration_count || 0}</span>
            <span class="stat-label">Iterations</span>
          </div>
        `}
        <div class="stat-card">
          <span class="stat-value">${project.merkle_root ? truncateHash(project.merkle_root) : 'N/A'}</span>
          <span class="stat-label">Merkle Root</span>
        </div>
        ${project.scr_id ? `
          <div class="stat-card highlight">
            <span class="stat-value">${project.scr_id}</span>
            <span class="stat-label">SCR ID</span>
          </div>
        ` : ''}
      </div>

      <!-- Training Runs Section (training projects only) -->
      ${project.type === 'training' ? `
        <div class="workspace-training">
          <h2>Training Runs</h2>
          ${renderPreflightPanel()}
          <div class="training-runs-scroll">
            ${trainingRuns.length > 0 ? 
              [...trainingRuns].reverse().map(run => renderTrainingCard(run, trainingRuns)).join('') :
              '<p class="training-empty">No training runs captured yet. Start training in Kohya to see them here.</p>'
            }
          </div>
        </div>
      ` : ''}
      
<!-- Iterations Section (txt2img projects only) -->
      ${project.type !== 'training' ? `
        <div class="workspace-iterations">
          <h2>Iterations</h2>
          ${iterations.length === 0 ? `
            <div class="iterations-empty">
              <p>No iterations captured yet. Generate images in ComfyUI to see them here.</p>
            </div>
          ` : `
            <div class="iterations-grid">
              ${iterations.map(iter => `
                <div class="iteration-card">
                  <div class="iteration-image" data-project="${project.name}" data-image="${iter.image_filename || ''}">
                    <span class="image-placeholder">[IMG]</span>
                  </div>
                  <div class="iteration-details">
                    <div class="iteration-header">
                      <span class="iteration-number">#${iter.run_sequence}</span>
                      ${iter.parent_training_id ? `<span class="training-link" title="From training #${iter.parent_training_id}">[T]</span>` : ''}
                      <span class="iteration-ci">
                        <span class="ci-dot ci-placeholder"></span>
                        <span class="ci-value">--</span>
                      </span>
                    </div>
                    <div class="iteration-hash">
                      <span class="label">Leaf:</span>
                      <code>${iter.leaf_hash ? iter.leaf_hash.substring(0, 16) + '...' : 'N/A'}</code>
                    </div>
                    <div class="iteration-time">
                      ${iter.created_at ? new Date(iter.created_at).toLocaleString() : ''}
                    </div>
                  </div>
                </div>
              `).join('')}
            </div>
          `}
        </div>
      ` : ''}
      
      ${showLockSection ? `
        <div class="workspace-lock-section">
          <h2>Lock Project</h2>
          ${!hasContent ? `
            <p class="lock-hint">${project.type === 'training' ? 'Complete at least one training run to enable locking.' : 'Generate at least one iteration to enable locking.'}</p>
          ` : `
            <p class="lock-hint">Finalize to permanently seal your creative history, or Checkpoint to preserve progress and keep working.</p>
          `}
          <div class="lock-buttons-row">
            <button class="lock-btn-large local" data-lock="local" ${localDisabled ? 'disabled' : ''}>
              <span class="icon"></span>
              <span class="title">Finalize Project</span>
              <span class="desc">Permanently seal this project</span>
            </button>
            <button class="lock-btn-large checkpoint" data-lock="checkpoint" ${localDisabled ? 'disabled' : ''}>
              <span class="icon">◇</span>
              <span class="title">Checkpoint Project</span>
              <span class="desc">Seal progress, keep working</span>
            </button>
            <button class="lock-btn-large chain" data-lock="chain" ${chainDisabled ? 'disabled' : ''}>
              <span class="icon"></span>
              <span class="title">Chain Lock</span>
              <span class="desc">RVN + IPFS + Arweave</span>
            </button>
            
          </div>
        </div>
      ` : ''}
    </div>
  `;
}

/**
 * Render a training run card with lineage visualization (Phase 7)
 */
function renderTrainingCard(run, allRuns = []) {
  const statusLabels = {
    'pending': 'Pending',
    'running': 'Training...',
    'complete': 'Complete',
    'incomplete': 'Failed'
  };
  
  const lineageIcons = {
    'ROOT': 'Root',
    'VERSION': 'Version',
    'BRANCH': 'Branch'
  };

  const isLocked = run.is_locked === 1;
  
  // Build lineage indicator
  let lineageClass = (run.lineage_type || 'ROOT').toLowerCase();
  let lineageIcon = lineageIcons[run.lineage_type] || 'Root';
  
  // Check if this is part of a locked chain
  const hasLockedAncestors = run.parent_run_id && 
    allRuns.some(r => r.id === run.parent_run_id && r.is_locked);
  
  return `
    <div class="training-card ${run.status} ${lineageClass} ${isLocked ? 'locked' : ''} ${hasLockedAncestors ? 'locked-chain' : ''}" data-run-id="${run.id}">
      <div class="training-header">
        <span class="lineage-indicator" title="${run.lineage_type || 'ROOT'}">${lineageIcon}</span>
        <span class="training-name">${escapeHtml(run.output_filename || 'Training #' + run.id)}</span>
        <span class="training-status">${statusLabels[run.status] || run.status}</span>
        ${isLocked ? `<span class="lock-indicator" title="Locked"></span>` : ''}
        ${run.input_witness_id ? `<span class="witness-indicator" title="Witnessed">Secured</span>` : ''}
      </div>
      
      ${run.parent_run_id ? `
        <div class="lineage-connector">
          <span class="connector-line"></span>
          <span class="parent-ref">-> from Run #${run.parent_run_id}</span>
        </div>
      ` : ''}
      
      <div class="training-details">
        <div class="detail-row">
          <span class="label">Base Model:</span>
          <span class="value">${run.base_model_path ? run.base_model_path.split(/[\\\/]/).pop() : 'N/A'}</span>
        </div>
        <div class="detail-row">
          <span class="label">Network:</span>
          <span class="value">dim=${run.network_dim || '?'}, a=${run.network_alpha || '?'}</span>
        </div>
        <div class="detail-row">
          <span class="label">Dataset:</span>
          <span class="value">${run.image_count || 0} images, ${run.caption_count || 0} captions</span>
        </div>
        ${run.dataset_merkle ? `
          <div class="detail-row">
            <span class="label">Dataset Merkle:</span>
            <code class="value small">${truncateHash(run.dataset_merkle)}</code>
          </div>
        ` : ''}
        ${run.header_hash ? `
          <div class="detail-row">
            <span class="label">Model Hash:</span>
            <code class="value small">${truncateHash(run.header_hash)}</code>
          </div>
        ` : ''}
        ${run.parent_seal ? `
          <div class="detail-row">
            <span class="label">Parent Seal:</span>
            <code class="value small">${truncateHash(run.parent_seal)}</code>
          </div>
        ` : ''}
        ${run.scr_id ? `
          <div class="detail-row highlight">
            <span class="label">SCR ID:</span>
            <span class="value scr-id">${run.scr_id}</span>
          </div>
        ` : ''}
        ${run.ipfs_cid ? `
          <div class="detail-row">
            <span class="label">IPFS CID:</span>
            <code class="value small">${truncateHash(run.ipfs_cid)}</code>
          </div>
        ` : ''}
      </div>
      
      <div class="training-time">
        ${run.completed_at ? `Completed: ${new Date(run.completed_at).toLocaleString()}` : 
          run.started_at ? `Started: ${new Date(run.started_at).toLocaleString()}` : 
          run.created_at ? `Created: ${new Date(run.created_at).toLocaleString()}` : ''}
      </div>
      
      ${isLocked ? `
        <div class="training-locked-badge">
          <span class="badge">LOCKED</span>
          ${run.lock_txid ? `<code class="txid" title="${run.lock_txid}">TX: ${truncateHash(run.lock_txid)}</code>` : ''}
        </div>
      ` : ''}
    </div>
  `;
}

/**
 * Render the pre-flight checklist panel (Phase 7)
 */
function renderPreflightPanel() {
  const status = State.get('preflightStatus');
  const isRunning = State.get('preflightRunning');
  
  if (!status && !isRunning) {
    return `
      <div class="preflight-panel idle">
        <h4>PRE-FLIGHT CHECKLIST</h4>
        <p class="help-text">Pre-flight will verify all input files before training starts.</p>
        <button class="preflight-start-btn" onclick="startPreflight()">
          Start Pre-Flight
        </button>
      </div>
    `;
  }
  
  const renderItem = (label, data) => {
    if (!data) return '';
    
    if (data.status === 'pending') {
      return `<div class="preflight-item pending">[ ] ${label} (waiting)</div>`;
    }
    if (data.status === 'hashing') {
      const percent = Math.round((data.progress || 0) * 100);
      const eta = data.etaSeconds ? ` (${Math.round(data.etaSeconds)}s remaining)` : '';
      return `
        <div class="preflight-item hashing">
          <div class="progress-bar">
            <div class="progress-fill" style="width: ${percent}%"></div>
          </div>
          <span class="label">${label} ${percent}%${eta}</span>
        </div>
      `;
    }
    if (data.status === 'complete') {
      const hash = data.hash || data.merkleRoot;
      return `
        <div class="preflight-item complete">
          [OK] ${label} ${data.cached ? '(cached)' : ''}
          ${hash ? `<code>${truncateHash(hash)}</code>` : ''}
        </div>
      `;
    }
    return '';
  };
  
  return `
    <div class="preflight-panel ${isRunning ? 'running' : 'complete'}">
      <h4>PRE-FLIGHT CHECKLIST</h4>
      ${status?.baseModel ? renderItem('Base Model', status.baseModel) : ''}
      ${status?.dataset ? renderItem('Dataset', status.dataset) : ''}
      ${status?.checkpoint ? renderItem('Checkpoint', status.checkpoint) : ''}
      ${status?.errors?.length > 0 ? `
        <div class="preflight-errors">
          ${status.errors.map(e => `<div class="error">${e.type}: ${e.error}</div>`).join('')}
        </div>
      ` : ''}
      ${status?.verified !== undefined ? `
        <div class="preflight-result ${status.verified ? 'verified' : 'failed'}">
          ${status.verified ? 'All inputs verified' : 'Incomplete Verification incomplete'}
        </div>
      ` : ''}
    </div>
  `;
}
