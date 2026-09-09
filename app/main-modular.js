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

const { app, BrowserWindow, session } = require('electron');
const path = require('path');

const { registerIpc } = require('./ipc-ping');
const { registerCaptureIpc } = require('./ipc-capture');
const { registerVaultIpc } = require('./ipc-vault');
const { registerComfyIpc, shutdownComfy } = require('./ipc-comfy');
const { registerProfileIpc } = require('./ipc-profile');
const { registerBlenderIpc, installedAppIds, shutdownBlender } = require('./ipc-blender');
const { registerReceiptIpc } = require('./ipc-receipt');
const { registerCredentialIpc } = require('./ipc-credential');

const APP_URL = process.env.SCRUPLE_APP_URL || 'http://127.0.0.1:3902';

// WO-D5. The dashboard is one route on the served app; which SHAPE it draws is
// the server's answer to "which deployment is asking".
const APP_ROUTE = process.env.SCRUPLE_APP_ROUTE || '/studio';

/**
 * How this deployment announces itself.
 *
 * A served app IS the web deployment — that is not an assumption, it is what
 * the server is. Desktop Studio is the exception, so Desktop Studio is what has
 * to speak up, and it does it with a request header rather than a query
 * parameter: the header rides on the document request, on every client-side
 * navigation and on every API call the page makes, and there is no URL for a
 * user to edit into a shape their build does not have.
 *
 * `SCRUPLE_PROFILE` exists so scripts/desktop-run.mjs can make this app lie
 * about itself (`profile-lie`) or say nothing at all (`no-profile-header`).
 * Both are mutations; both must redden the dashboard assertions, and if they do
 * not then the shape was never coming from the header in the first place.
 */
const PROFILE = process.env.SCRUPLE_PROFILE === undefined ? 'desktop' : process.env.SCRUPLE_PROFILE;

/**
 * ⚑ WO-E5. THE SECOND ANNOUNCEMENT: what is on this box.
 *
 * The profile header says which DEPLOYMENT is asking. This says which local
 * apps the machine actually has, and the server needs it because one region —
 * Blender's — must be ABSENT rather than empty when there is no Blender, and
 * "is there a Blender on your laptop" is not a question a server can answer.
 * /data/scruple-web/lib/v2/deployment.ts carries the argument.
 *
 * MEASURED, at the moment the header is built, by `fs.existsSync` and nothing
 * else — no launch, no version, no probe. Those are the region's CONTENTS and
 * they come over the bridge, on demand, from ipc-blender.js. A header that
 * waited for a headless Blender would delay the first document request by half
 * a minute on this box (finding E3-2: aarch64 under qemu).
 *
 * `SCRUPLE_HOST_APPS` overrides it, and exists for exactly one reason:
 * scripts/desktop-run.mjs must be able to make this app lie about what it has,
 * the way `SCRUPLE_PROFILE` lets it lie about what it is. Both are mutations
 * and both must move the dashboard, or the shape was never coming from the
 * announcement.
 */
function announcedApps() {
  // `off` is the only way to send NO header, because the empty string is
  // already taken and means something else: an announcement of nothing. The
  // server keeps those two apart — "the host looked and found none" and
  // "nothing has measured this machine" have different fixes — so the driver
  // has to be able to produce both.
  if (process.env.SCRUPLE_HOST_APPS_HEADER === 'off') return undefined;
  if (process.env.SCRUPLE_HOST_APPS !== undefined) return process.env.SCRUPLE_HOST_APPS;
  return installedAppIds().join(',');
}

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

  const target = new URL(APP_ROUTE, APP_URL).toString();
  console.log(`[main] loading ${target}`);
  mainWindow.loadURL(target);

  return { window: mainWindow, navigation: () => lastNavigation };
}

app.whenReady().then(async () => {
  // Set BEFORE the window is created, on the default session, so the very first
  // document request already carries it. Announcing after the load would race
  // the thing being announced to.
  if (PROFILE !== '') {
    const apps = announcedApps();
    session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
      const requestHeaders = { ...details.requestHeaders, 'x-scruple-profile': PROFILE };
      // An EMPTY announcement is still an announcement — "I looked, and there
      // is nothing" — and it is not the same answer as no header at all. The
      // server keeps those apart and so does this.
      if (apps !== undefined) requestHeaders['x-scruple-host-apps'] = apps;
      callback({ requestHeaders });
    });
    console.log(`[main] announcing x-scruple-profile: ${PROFILE}`);
    console.log(`[main] announcing x-scruple-host-apps: ${apps === '' ? '(nothing)' : apps}`);
  } else {
    console.log('[main] announcing nothing — no profile header on this run');
  }

  registerIpc();
  registerProfileIpc();
  registerBlenderIpc();
  registerCaptureIpc();
  registerVaultIpc();
  registerComfyIpc();
  registerReceiptIpc();
  registerCredentialIpc();
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
      // Whatever happened, nothing this process started outlives it — see
      // shutdownComfy() in ipc-comfy.js. A scenario that failed at its second
      // step never reached `comfyStop`.
      shutdownComfy();
      shutdownBlender();
      app.exit(completed ? 0 : EXIT_SCENARIO_INCOMPLETE);
    } catch (err) {
      console.error(`[main] scenario threw: ${err && err.stack ? err.stack : err}`);
      shutdownComfy();
      shutdownBlender();
      app.exit(EXIT_SCENARIO_INCOMPLETE);
    }
    return;
  }

  if (!probeArg) return;

  const { runProbe } = require('./probe');
  try {
    const ok = await runProbe(probeArg.slice('--probe='.length), window, navigation);
    shutdownBlender();
    app.exit(ok ? 0 : EXIT_PROBE_FAILED);
  } catch (err) {
    console.error(`[main] probe threw: ${err && err.stack ? err.stack : err}`);
    shutdownBlender();
    app.exit(EXIT_PROBE_FAILED);
  }
});

// ⚑ Nothing this process started outlives it — the rails for this series say
// to reap what you orphan, and a headless Blender the dashboard began measuring
// is exactly that. `app.exit()` does not fire `will-quit`, so the scenario and
// probe paths above call it explicitly as well.
app.on('will-quit', () => { shutdownComfy(); shutdownBlender(); });
app.on('window-all-closed', () => app.quit());
