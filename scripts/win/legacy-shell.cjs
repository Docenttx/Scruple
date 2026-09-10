// Render the CANON interface — app-legacy's real renderer — and enumerate what
// it actually puts on screen.
//
// ⚑ WHAT THIS IS. `app-legacy/main-modular.js` cannot be loaded: five of its
// module-level requires are under `app-legacy/capture/`, a directory that has
// never existed in this repository (see scripts/win/legacy-require-probe.cjs).
// So the app cannot be started the ordinary way, and until it can, nobody has
// SEEN the canon UI on this project.
//
// This is a harness that supplies the one thing that is missing — a main
// process — and nothing else. It uses:
//
//   the real app-legacy/preload.js        (not a reimplementation)
//   the real app-legacy/index-final.html  (and every renderer/*.js it loads)
//   the real renderer/styles/*.css
//   the same webPreferences as main-modular.js:91-105, copied field for field
//
// ⚑ AND WHAT IT IS NOT. It is NOT "the legacy app running". Every IPC handler
// here is a stub. It answers the question "what interface does this renderer
// draw, given a config" — which is exactly WO-G1's gate — and it answers no
// question at all about whether the legacy MAIN process works on Electron 38.
// Do not let a screenshot from this stand in for that.
//
// 🔴 THE STUBS DO NOT INVENT FACTS. Where the real handler would return data
// this harness does not have, it returns an empty collection or an explicit
// `{ unavailable: true, reason }` — never a plausible-looking value. A harness
// that returned a fake wallet balance would render a screen that has never
// existed, which is the D5 failure in miniature.
//
//   electron scripts/win/legacy-shell.cjs --label default --config "{}"
//
// Every channel the renderer actually invoked is recorded and reported, because
// that list is the real IPC surface G1 has to satisfy, measured rather than
// guessed.

const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const LEGACY = path.join(__dirname, '..', '..', 'app-legacy');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const label = arg('label', 'default');
const outDir = arg('out', path.join(__dirname, '..', '..', '.run', 'legacy-shell'));
// `--config-file` exists because PowerShell strips the inner double quotes out
// of a JSON literal on its way to a native executable, so `--config` is only
// usable from a shell that does not. Prefer the file.
let config;
const configFile = arg('config-file', null);
try {
  // Windows PowerShell 5.1's `Out-File -Encoding utf8` writes a BOM, and
  // JSON.parse rejects it. Strip it rather than making every caller remember.
  const raw = configFile ? fs.readFileSync(configFile, 'utf8').replace(/^﻿/, '') : arg('config', '{}');
  config = JSON.parse(raw);
} catch (e) {
  console.error(`config is not JSON: ${e.message}`);
  process.exit(2);
}

fs.mkdirSync(outDir, { recursive: true });

/** Every channel the renderer reached for, in call order, with how it was answered. */
const calls = [];

// The channels preload.js exposes. Taken from app-legacy/preload.js, which is
// the contract the renderer is written against.
const CHANNELS = [
  'get-state', 'setup-comfyui-path', 'setup-paths', 'browse-folder', 'browse-file',
  'get-projects', 'get-project', 'get-iterations', 'read-image', 'create-project',
  'archive-project', 'activate-project', 'deactivate-project',
  'local-disc-lock', 'single-chain-lock', 'persistent-chain-lock', 'checkpoint-project',
  'tsd-balance', 'tsd-fund', 'tsd-pay',
  'get-training-runs', 'get-all-training-runs', 'get-training-run', 'lock-training-run',
  'detect-kohya-port', 'get-capture-status', 'get-witness-status', 'set-interlock',
  'rvn-wallet-status', 'rvn-wallet-create', 'rvn-wallet-import', 'rvn-wallet-unlock',
  'rvn-wallet-lock', 'rvn-wallet-delete', 'rvn-wallet-verify-password',
  'rvn-get-balance', 'rvn-get-address', 'rvn-get-fee-quote', 'rvn-get-costs',
  'rvn-get-rvn-price', 'rvn-check-asset-exists', 'rvn-get-asset-data', 'rvn-verify-proof',
  'ipfs-get-config', 'ipfs-save-config', 'ipfs-test-connection',
  'arweave-import-key', 'arweave-get-status', 'arweave-disconnect',
  'arweave-get-balance', 'arweave-mint-test-ar', 'preflight-training',
  'open-folder',
];

// Collections are empty; single values are explicitly unavailable. Neither
// shape is a guess about what the real handler would have said.
const EMPTY_LIST = new Set([
  'get-projects', 'get-iterations', 'get-training-runs', 'get-all-training-runs',
]);

function answer(channel) {
  if (channel === 'get-state') {
    return { needsSetup: false, sessionId: `harness-${label}`, port: 0, config };
  }
  if (EMPTY_LIST.has(channel)) return [];
  return { unavailable: true, reason: `no main process — ${channel} is stubbed by legacy-shell.cjs` };
}

for (const channel of CHANNELS) {
  ipcMain.handle(channel, (_e, ...args) => {
    const value = answer(channel);
    calls.push({ channel, args: args.length, answered: Array.isArray(value) ? 'empty-list' : (value.unavailable ? 'unavailable' : 'state') });
    return value;
  });
}

// What the renderer asked for that preload.js does not expose shows up as a
// TypeError in the page, not as an IPC call — so console messages are captured
// too, and reported separately.
const pageErrors = [];

app.whenReady().then(async () => {
  // main-modular.js:91-105, field for field.
  const win = new BrowserWindow({
    width: 1600,
    height: 900,
    minWidth: 1200,
    minHeight: 700,
    title: 'SCRUPLE Studio',
    webPreferences: {
      preload: path.join(LEGACY, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
    show: false,
    backgroundColor: '#0a0f1c',
  });

  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) pageErrors.push(message);
  });

  await win.loadFile(path.join(LEGACY, 'index-final.html'));
  win.show();

  // The renderer boots on DOMContentLoaded and renders on the first State
  // change. Wait for the shell it draws rather than for a fixed delay, so a
  // slow machine does not read as an empty UI.
  const appeared = await win.webContents.executeJavaScript(`
    new Promise((resolve) => {
      const done = () => !!document.querySelector('.app-container');
      if (done()) return resolve(true);
      const t = setTimeout(() => { obs.disconnect(); resolve(done()); }, 15000);
      const obs = new MutationObserver(() => {
        if (done()) { clearTimeout(t); obs.disconnect(); resolve(true); }
      });
      obs.observe(document.getElementById('root'), { childList: true, subtree: true });
    })
  `);

  // Enumerate what is actually on screen. Structure, not a screenshot — a
  // screenshot is evidence for a person and this is evidence for a diff.
  const observed = await win.webContents.executeJavaScript(`
    (() => {
      const q = (s) => Array.from(document.querySelectorAll(s));
      const vis = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      return {
        title: document.title,
        loadingScreenStillUp: !!document.querySelector('.loading-screen'),
        tabs: q('.view-toggle-btn').map((b) => ({
          label: b.textContent.trim(),
          view: b.dataset.view || null,
          walletMode: b.dataset.walletMode || null,
          active: b.classList.contains('active'),
          visible: vis(b),
        })),
        containers: {
          comfy: q('.comfy-webview-container').length,
          kohya: q('.kohya-webview-container').length,
          workspace: q('.workspace-container').length,
          wallet: q('.wallet-container').length,
        },
        sidebar: {
          present: !!document.querySelector('.sidebar'),
          activeProjectSection: !!document.querySelector('.active-project-section'),
          projectList: !!document.querySelector('.project-list'),
          sidebarFooter: !!document.querySelector('.sidebar-footer'),
          projectItems: q('.project-item').length,
        },
        webviews: q('webview').map((w) => ({ id: w.id, src: w.getAttribute('src') })),
      };
    })()
  `);

  const png = await win.webContents.capturePage();
  const shotPath = path.join(outDir, `legacy-${label}.png`);
  fs.writeFileSync(shotPath, png.toPNG());

  const report = {
    label,
    config,
    appContainerRendered: appeared,
    observed,
    screenshot: shotPath,
    screenshotBytes: fs.statSync(shotPath).size,
    ipcChannelsCalled: [...new Set(calls.map((c) => c.channel))],
    ipcCallCount: calls.length,
    pageErrors,
  };
  fs.writeFileSync(path.join(outDir, `legacy-${label}.json`), JSON.stringify(report, null, 2));

  console.log(`<<<LEGACY_SHELL${JSON.stringify(report)}LEGACY_SHELL>>>`);
  win.destroy();
  app.quit();
});

app.on('window-all-closed', () => app.quit());
