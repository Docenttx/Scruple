/**
 * render-blender.js — WO-G4. The Blender tab.
 *
 * ⚑ THE ONE PLACE THIS TAB CANNOT COPY COMFYUI, AND WHY.
 *
 * ComfyUI and Kohya_ss are web applications. Their tabs are `<webview>` elements
 * pointed at `http://127.0.0.1:8188` and `:7860`, and when the app is not
 * answering, an overlay covers the webview and says so.
 *
 * Blender is a native application. There is no URL to embed and no headless mode
 * that would put a viewport in a browser frame. So this container is the OVERLAY
 * WITHOUT THE WEBVIEW: the same `webview-overlay` / `overlay-content` classes,
 * the same `status-icon`, the same `retry-btn` — because the user already knows
 * that shape and a new one would be new friction — with a state panel where the
 * embedded page would be.
 *
 * That is the only difference from the existing pattern, it is forced by what
 * Blender is rather than chosen, and `docs/G4-BLENDER-TAB.md` enumerates it
 * because the G-series gate refuses a difference nobody justified.
 *
 * ⚑ TWO READINGS, TWO COSTS, AND THEY MUST NOT BE COLLAPSED.
 *
 *   IS THERE A BLENDER   `fs.existsSync` on the resolved binary, via
 *                        `scruple.profile()`. Instant. It decides whether the
 *                        TAB EXISTS at all.
 *   WHAT IS IN IT        `scruple.blender()` starts a headless Blender and asks
 *                        it — version, addon, bridge. Half a minute on some
 *                        boxes (finding E3-2, aarch64 under qemu). It fills the
 *                        PANEL, on demand.
 *
 * Putting the second behind the first would make every render of every tab wait
 * for a Blender, and a machine whose Blender hangs would take the whole window
 * with it. app/main-modular.js made the same split for the same reason.
 */

/* global State */

/** Has the machine got a Blender at all? Cheap, and it gates the tab. */
function blenderIsPresent() {
  return State.get('blenderEnabled') === true;
}

function fieldRow(label, value, hint) {
  return `
    <div class="blender-field">
      <span class="blender-field-label">${escapeHtml(label)}</span>
      <span class="blender-field-value">${escapeHtml(value == null ? '—' : String(value))}</span>
      ${hint ? `<span class="blender-field-hint">${escapeHtml(hint)}</span>` : ''}
    </div>`;
}

/**
 * The panel inside the Blender tab.
 *
 * `m` is whatever `scruple.blender()` last answered, or null if nothing has
 * asked yet. ⚑ NOTHING IS INVENTED WHEN IT IS NULL. A panel that filled in a
 * plausible version number would pass every assertion anyone would think to
 * write and be a lie; it says it has not measured, and offers the button that
 * measures.
 */
function renderBlenderPanel(m) {
  if (!m) {
    return `
      <div class="webview-overlay" id="blender-overlay">
        <div class="overlay-content">
          <div class="status-icon">?</div>
          <h2>Blender Not Measured</h2>
          <p>This machine has a Blender. Nothing has asked it anything yet.</p>
          <p class="help-hint">Measuring starts a headless Blender and can take
             half a minute.</p>
          <button id="measure-blender" class="retry-btn">Measure Blender</button>
        </div>
      </div>`;
  }

  if (m.state === 'absent') {
    // Reachable only if the binary went away between the profile reading and
    // this one. Kept because "it was there a moment ago" is exactly the case a
    // user needs told, rather than an empty panel.
    return `
      <div class="webview-overlay" id="blender-overlay">
        <div class="overlay-content">
          <div class="status-icon disconnected">X</div>
          <h2>Blender Not Found</h2>
          <p>${escapeHtml((m.binary && m.binary.reason) || 'no Blender where this app looks')}</p>
          <button id="measure-blender" class="retry-btn">Look Again</button>
        </div>
      </div>`;
  }

  const addon = m.addon || {};
  const bridge = m.bridge || {};
  const version = m.version || {};

  return `
    <div class="blender-panel">
      <div class="blender-panel-header">
        <h2>Blender</h2>
        <button id="measure-blender" class="retry-btn">Re-measure</button>
      </div>
      <div class="blender-fields">
        ${fieldRow('Binary', m.binary && m.binary.path, m.binary && m.binary.source)}
        ${fieldRow('Version', version.value, version.state === 'unread' ? version.reason : null)}
        ${fieldRow('Scruple addon', addon.module
            ? (addon.enabled ? `${addon.module} — enabled` : `${addon.module} — installed, NOT enabled`)
            : (addon.state === 'unread' ? null : 'not installed'),
          addon.state === 'unread' ? addon.reason : null)}
        ${fieldRow('Bridge', bridge.address, bridge.state === 'unread' ? bridge.reason : null)}
        ${fieldRow('Gate', bridge.gateUrl,
          bridge.gateUrl ? null : 'no capture gate is running — a generation would not be witnessed')}
        ${fieldRow('Profile', m.profileDir, m.profileDir ? null : 'Blender default profile')}
        ${fieldRow('Measured at', m.at)}
      </div>
      ${!bridge.gateUrl ? `
        <p class="blender-note">
          ⚑ Work done in this Blender is not witnessed until a gate is running.
          The tab shows what is here; it does not claim what is not.
        </p>` : ''}
    </div>`;
}

/** The container, gated exactly as ComfyUI's is: absent, never empty. */
function renderBlenderContainer(currentView) {
  if (!blenderIsPresent()) return '';
  return `<div class="blender-container ${currentView === 'blender' ? 'visible' : 'hidden'}">
    ${renderBlenderPanel(State.get('blenderMeasurement'))}
  </div>`;
}

/** The tab button, in the same shape and the same gating as its neighbours. */
function renderBlenderTab(currentView) {
  if (!blenderIsPresent()) return '';
  return `<button class="view-toggle-btn ${currentView === 'blender' ? 'active' : ''}" data-view="blender">Blender</button>`;
}
