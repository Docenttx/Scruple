/**
 * scenario.js — the main-process half of the headless driver.
 *
 * `--scenario=<path-to-spec.json>` makes the app run a scenario and exit. Each
 * step is dispatched by asking the RENDERER to call the bridge:
 *
 *     renderer → window.scruple.<call>(args) → ipcRenderer.invoke
 *              → ipcMain.handle → main → back
 *
 * which is the path a user's click takes. Calling the handler function directly
 * in main would be quicker and would prove nothing about the seam, so it is not
 * done; the fake-bridge mutation in scripts/d2-gate.sh is what keeps that
 * honest, because a bridge answering locally still satisfies "a value came
 * back".
 *
 * ⚑ THIS FILE GRADES NOTHING. It records what happened and writes it to
 * SCRUPLE_SCENARIO_RESULT. Every assertion in the scenario is evaluated by
 * scripts/desktop-run.mjs, in a different process, against the filesystem —
 * because an app that decides whether its own run passed is a log line with
 * extra steps, and WO-D2 says assert on side effects, never on logs.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const { SERVER_NONCE } = require('./ipc-ping');
const { waitForLoad } = require('./page-ready');
const { interpolate } = require('./interpolate');

const LOAD_TIMEOUT_MS = Number(process.env.SCRUPLE_LOAD_TIMEOUT_MS || 60000);
const STEP_TIMEOUT_MS = Number(process.env.SCRUPLE_STEP_TIMEOUT_MS || 60000);

/**
 * Dispatch one step through the renderer. The reply is wrapped rather than
 * returned bare so a throw on the bridge is a recorded outcome and not a
 * rejected promise that loses which step it came from.
 */
async function callBridge(wc, call, args) {
  const js = `(async () => {
    if (!window.scruple) return { __bridge: false, error: 'window.scruple is undefined' };
    if (typeof window.scruple[${JSON.stringify(call)}] !== 'function') {
      return { __bridge: false, error: 'window.scruple.' + ${JSON.stringify(call)} + ' is not a function' };
    }
    try { return { __bridge: true, value: await window.scruple[${JSON.stringify(call)}](...${JSON.stringify(args)}) }; }
    catch (e) { return { __bridge: true, error: String(e && e.message ? e.message : e) }; }
  })()`;
  const timeout = new Promise((_r, rej) =>
    setTimeout(() => rej(new Error(`step "${call}" did not answer within ${STEP_TIMEOUT_MS}ms`)), STEP_TIMEOUT_MS)
  );
  return Promise.race([wc.executeJavaScript(js, true), timeout]);
}

async function runScenario(specPath, window, navigation) {
  const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
  const appURL = process.env.SCRUPLE_APP_URL || 'http://127.0.0.1:3902';

  const result = {
    scenario: spec.scenario || path.basename(specPath, '.json'),
    specPath,
    startedAt: new Date().toISOString(),
    appURL,
    expectedOrigin: new URL(appURL).origin,
    // Minted in main, never injected into a page. An assertion that finds this
    // value in a step's reply knows the reply came from this process.
    serverNonce: SERVER_NONCE,
    mainPid: process.pid,
    runStore: process.env.SCRUPLE_RUN_STORE || null,
    versions: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      v8: process.versions.v8,
    },
    navigation: null,
    renderer: null,
    // What the driver decided before launching: the nonce it minted, the run
    // directory it made, the origin it expects. Echoed back so an assertion can
    // compare a reply against a value this process did not choose.
    driver: spec.driver || {},
    fixtures: spec.fixtures || {},
    steps: {},
    stepOrder: [],
    error: null,
  };

  const write = () => {
    result.finishedAt = new Date().toISOString();
    const dest = process.env.SCRUPLE_SCENARIO_RESULT;
    if (!dest) return;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, JSON.stringify(result, null, 2));
    console.log(`[scenario] wrote ${dest}`);
  };

  const wc = window.webContents;
  try {
    await waitForLoad(wc, LOAD_TIMEOUT_MS);
  } catch (err) {
    result.error = `page did not load: ${err.message}`;
    write();
    return false;
  }
  result.navigation = navigation();

  // The page is real and came from the served app, not about:blank.
  try {
    result.renderer = await wc.executeJavaScript(`({
      origin: window.location.origin,
      href: window.location.href,
      title: document.title,
      bodyChars: document.body ? document.body.innerHTML.length : 0,
      hasBridge: !!(window.scruple),
      bridgeHost: window.scruple ? window.scruple.host : null,
      bridgeMethods: window.scruple ? Object.keys(window.scruple).sort() : [],
    })`, true);
  } catch (err) {
    result.error = `renderer did not answer: ${err.message}`;
    write();
    return false;
  }

  for (const step of spec.steps || []) {
    const id = step.as || step.call;
    const record = { call: step.call, as: id, startedAt: new Date().toISOString() };
    result.stepOrder.push(id);
    result.steps[id] = record;
    try {
      // Resolved here so a step can use a fixture path or an earlier reply.
      record.args = interpolate(step.args || [], {
        driver: result.driver, fixtures: result.fixtures, steps: result.steps, env: process.env,
      });
      const reply = await callBridge(wc, step.call, record.args);
      record.reachedBridge = reply.__bridge === true;
      record.error = reply.error || null;
      record.value = reply.value === undefined ? null : reply.value;
    } catch (err) {
      record.reachedBridge = false;
      record.error = String(err && err.message ? err.message : err);
      record.value = null;
    }
    record.finishedAt = new Date().toISOString();
    console.log(`[scenario] step ${id} (${step.call}) ${record.error ? `ERROR ${record.error}` : 'returned'}`);
    // A step that could not be dispatched leaves the rest unrun rather than
    // cascading confusing failures; the driver sees the gap in stepOrder.
    if (record.error && step.required !== false) {
      result.error = `step "${id}" failed: ${record.error}`;
      break;
    }
  }

  write();
  // The app's exit code says only "the run completed", not "the run passed".
  // Passing is the driver's verdict.
  return result.error === null;
}

module.exports = { runScenario };
