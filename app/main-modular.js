/**
 * main-modular.js — Scruple Desktop Studio, main process.
 *
 * WO-D1 reduces this to a shell. It is deliberately small:
 *
 *   - it opens ONE BrowserWindow pointed at the served Next UI ($SCRUPLE_APP_URL).
 *     There is no bundled renderer and no local Next server — see docs/DESIGN.md,
 *     "Not bundled". index-final.html and the renderer/ bundle in app-legacy/ are
 *     not loaded by this process and are not on the path to being loaded.
 *   - it registers the IPC seam the preload bridge exposes. Today that is one
 *     handler, `scruple:ping`. The lock/project/settings/training/wallet handlers
 *     in app-legacy/ipc/ land here as they are rewritten onto the SDK.
 *   - it fails loudly. A window that could not load its page is not a running
 *     app, and this process exits non-zero rather than sitting there looking alive.
 */

'use strict';

const { app, BrowserWindow } = require('electron');
const path = require('path');

const { registerIpc } = require('./ipc-ping');
const { registerCaptureIpc } = require('./ipc-capture');

const APP_URL = process.env.SCRUPLE_APP_URL || 'http://127.0.0.1:3902';

// Exit codes are the process's only unambiguous channel to a headless driver.
const EXIT_LOAD_FAILED = 3;
const EXIT_PROBE_FAILED = 4;
const EXIT_SCENARIO_INCOMPLETE = 5;

// llvmpipe on this box has no usable GPU path and Chromium's GPU process will
// crash-loop trying to find one. The window still composites in software; the
// only thing we lose is a screenshot, which docs/DESIGN.md already tells us is
// blank here and which nothing may gate on.
app.disableHardwareAcceleration();

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 900,
    minWidth: 1200,
    minHeight: 700,
    title: 'Scruple Desktop Studio',
    backgroundColor: '#0a0f1c',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const wc = mainWindow.webContents;

  // Record what the server actually answered. `did-finish-load` fires for a 404
  // page too, so the status code is the observable, not the event.
  let lastNavigation = null;
  wc.on('did-navigate', (_e, url, httpResponseCode, httpStatusText) => {
    lastNavigation = { url, httpResponseCode, httpStatusText };
  });

  wc.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return;
    console.error(
      `[main] load FAILED ${validatedURL}: ${errorDescription} (${errorCode})`
    );
    app.exit(EXIT_LOAD_FAILED);
  });

  wc.on('render-process-gone', (_e, details) => {
    console.error(`[main] renderer gone: ${JSON.stringify(details)}`);
    app.exit(EXIT_LOAD_FAILED);
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });

  console.log(`[main] loading ${APP_URL}`);
  mainWindow.loadURL(APP_URL);

  return { window: mainWindow, navigation: () => lastNavigation };
}

app.whenReady().then(async () => {
  registerIpc();
  registerCaptureIpc();
  const { window, navigation } = createWindow();

  // --probe=ping drives WO-D1's scripted round trip and exits.
  // --scenario=<spec.json> drives a WO-D2 scenario and exits.
  // With neither, the app just runs, which is what a human gets.
  const probeArg = process.argv.find((a) => a.startsWith('--probe='));
  const scenarioArg = process.argv.find((a) => a.startsWith('--scenario='));

  if (scenarioArg) {
    const { runScenario } = require('./scenario');
    try {
      // Exit 0 means "the scenario ran to the end", NOT "the scenario passed".
      // scripts/desktop-run.mjs decides that, from the side effects on disk.
      const completed = await runScenario(scenarioArg.slice('--scenario='.length), window, navigation);
      app.exit(completed ? 0 : EXIT_SCENARIO_INCOMPLETE);
    } catch (err) {
      console.error(`[main] scenario threw: ${err && err.stack ? err.stack : err}`);
      app.exit(EXIT_SCENARIO_INCOMPLETE);
    }
    return;
  }

  if (!probeArg) return;

  const { runProbe } = require('./probe');
  try {
    const ok = await runProbe(probeArg.slice('--probe='.length), window, navigation);
    app.exit(ok ? 0 : EXIT_PROBE_FAILED);
  } catch (err) {
    console.error(`[main] probe threw: ${err && err.stack ? err.stack : err}`);
    app.exit(EXIT_PROBE_FAILED);
  }
});

app.on('window-all-closed', () => app.quit());
