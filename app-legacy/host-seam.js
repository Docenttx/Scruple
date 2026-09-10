/**
 * host-seam.js — WO-G1. The D/E-series host capabilities, attached to the app.
 *
 * WHAT THIS IS
 *
 * Two things were built in parallel. `main-modular.js` is SCRUPLE Studio: tabs,
 * projects, checkpoint/lock/mint, wallets — the interface a person uses, and the
 * one WO-D5 replaced with a diagnostics page. `app/` is the host seam the D and E
 * series proved out: ping, profile, capture, the vault, ComfyUI, Blender,
 * receipts, credentials.
 *
 * G1 puts the interface back and keeps the seam. This module is the join, and it
 * is a module rather than nine `require`s inside main-modular.js for one reason:
 * when the seam moves under the SDK in G2, exactly one file changes and the diff
 * says what moved.
 *
 * ⚑ The handlers still LIVE in `app/`. Nothing was copied — copying would give us
 * two implementations of `scruple:vault-capture` and one of them would rot. The
 * relative require is the honest statement that `app/` is a library here and the
 * application is this directory.
 */

'use strict';

const path = require('path');

const HOST_DIR = path.join(__dirname, '..', 'app');

const { registerIpc } = require(path.join(HOST_DIR, 'ipc-ping'));
const { registerCaptureIpc } = require(path.join(HOST_DIR, 'ipc-capture'));
const { registerVaultIpc } = require(path.join(HOST_DIR, 'ipc-vault'));
const { registerComfyIpc, shutdownComfy } = require(path.join(HOST_DIR, 'ipc-comfy'));
const { registerProfileIpc } = require(path.join(HOST_DIR, 'ipc-profile'));
const { registerBlenderIpc, installedAppIds, shutdownBlender } = require(path.join(HOST_DIR, 'ipc-blender'));
const { registerBlenderGenerateIpc, shutdownBlenderGenerate } = require(path.join(HOST_DIR, 'ipc-blender-generate'));
const { registerReceiptIpc } = require(path.join(HOST_DIR, 'ipc-receipt'));
const { registerCredentialIpc } = require(path.join(HOST_DIR, 'ipc-credential'));

// Exit codes, unchanged from app/main-modular.js so the D-series gates read the
// same numbers they always did.
const EXIT_PROBE_FAILED = 12;
const EXIT_SCENARIO_INCOMPLETE = 13;

/**
 * How this deployment announces itself, and what is on this box.
 *
 * ⚑ CHANGED IN G1, and this is a difference the gate requires me to justify.
 *
 * In `app/main-modular.js` these headers rode on every request the window made,
 * because every request the window made went to the served Next app. This window
 * loads `index-final.html` off disk, so the headers now have no document request
 * to ride on — the announcement is still made, but it only reaches a served page
 * once one is embedded (that is G2's Workspace panel, not this work order).
 *
 * The function stays, and stays here, because `SCRUPLE_PROFILE=off` and
 * `SCRUPLE_HOST_APPS` are how scripts/desktop-run.mjs makes the app LIE about
 * itself. Deleting them would remove the mutations before the thing they mutate
 * exists again.
 */
function announceProfile(session) {
  const profile = process.env.SCRUPLE_PROFILE === undefined ? 'desktop' : process.env.SCRUPLE_PROFILE;
  if (profile === '') {
    console.log('[host] announcing nothing — no profile header on this run');
    return;
  }

  const override = process.env.SCRUPLE_HOST_APPS;
  const apps = override === 'off' ? undefined : (override !== undefined ? override : installedAppIds().join(','));

  session.webRequest.onBeforeSendHeaders((details, callback) => {
    const requestHeaders = { ...details.requestHeaders, 'x-scruple-profile': profile };
    if (apps !== undefined) requestHeaders['x-scruple-host-apps'] = apps;
    callback({ requestHeaders });
  });
  console.log(`[host] announcing x-scruple-profile: ${profile}`);
  console.log(`[host] announcing x-scruple-host-apps: ${apps === undefined ? '(no header)' : apps === '' ? '(nothing)' : apps}`);
}

/** Register every host channel. Order matches app/main-modular.js. */
function registerHostIpc() {
  registerIpc();
  registerProfileIpc();
  registerBlenderIpc();
  registerBlenderGenerateIpc();
  registerCaptureIpc();
  registerVaultIpc();
  registerComfyIpc();
  registerReceiptIpc();
  registerCredentialIpc();
  console.log('[host] 9 host IPC modules registered');
}

/** Reap what this seam started. Called on will-quit AND before every app.exit(). */
function shutdownHost() {
  shutdownComfy();
  shutdownBlender();
  shutdownBlenderGenerate();
}

/**
 * Run a `--probe=` or `--scenario=` if the command line asked for one.
 *
 * @returns false when there was nothing to run — the human case, where the app
 *          simply stays open.
 */
async function runHostDriver(window, navigation, argv) {
  const probeArg = argv.find((a) => a.startsWith('--probe='));
  const scenarioArg = argv.find((a) => a.startsWith('--scenario='));
  if (!probeArg && !scenarioArg) return false;

  const { app } = require('electron');

  if (scenarioArg) {
    const { runScenario } = require(path.join(HOST_DIR, 'scenario'));
    try {
      // Exit 0 means "ran to the end", NOT "passed". scripts/desktop-run.mjs
      // decides that from the side effects on disk.
      const completed = await runScenario(scenarioArg.slice('--scenario='.length), window, navigation);
      shutdownHost();
      app.exit(completed ? 0 : EXIT_SCENARIO_INCOMPLETE);
    } catch (err) {
      console.error(`[host] scenario threw: ${err && err.stack ? err.stack : err}`);
      shutdownHost();
      app.exit(EXIT_SCENARIO_INCOMPLETE);
    }
    return true;
  }

  const { runProbe } = require(path.join(HOST_DIR, 'probe'));
  try {
    const ok = await runProbe(probeArg.slice('--probe='.length), window, navigation);
    shutdownHost();
    app.exit(ok ? 0 : EXIT_PROBE_FAILED);
  } catch (err) {
    console.error(`[host] probe threw: ${err && err.stack ? err.stack : err}`);
    shutdownHost();
    app.exit(EXIT_PROBE_FAILED);
  }
  return true;
}

module.exports = { announceProfile, registerHostIpc, shutdownHost, runHostDriver };
