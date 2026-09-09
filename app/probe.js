/**
 * probe.js — the scripted round trip behind `--probe=ping`.
 *
 * Not a test framework and not a driver; WO-D2 builds the driver. This is the
 * smallest thing that can answer WO-D1's question — "is the process real and does
 * the bridge carry a message both ways" — and record the answer somewhere a
 * caller with no screen can read it.
 *
 * It asserts on side effects, not on log lines: a JSON report on disk, an HTTP
 * status the server actually returned, and a nonce that could only have come
 * from the main process.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { SERVER_NONCE } = require('./ipc-ping');

const LOAD_TIMEOUT_MS = Number(process.env.SCRUPLE_D1_LOAD_TIMEOUT_MS || 60000);

function waitForLoad(wc) {
  return new Promise((resolve, reject) => {
    if (!wc.isLoading() && wc.getURL() && wc.getURL() !== 'about:blank') return resolve();
    const timer = setTimeout(
      () => reject(new Error(`page did not finish loading within ${LOAD_TIMEOUT_MS}ms`)),
      LOAD_TIMEOUT_MS
    );
    wc.once('did-finish-load', () => { clearTimeout(timer); resolve(); });
    wc.once('did-fail-load', (_e, code, desc, url) => {
      clearTimeout(timer);
      reject(new Error(`did-fail-load ${url}: ${desc} (${code})`));
    });
  });
}

async function runProbe(name, window, navigation) {
  if (name !== 'ping') throw new Error(`unknown probe: ${name}`);

  const appURL = process.env.SCRUPLE_APP_URL || 'http://127.0.0.1:3902';
  const expectedOrigin = new URL(appURL).origin;
  // The caller's nonce, when there is one. A harness that supplies its own nonce
  // is checking a value the app never chose.
  const clientNonce = process.env.SCRUPLE_D1_CLIENT_NONCE || crypto.randomBytes(8).toString('hex');

  const report = {
    probe: 'ping',
    startedAt: new Date().toISOString(),
    appURL,
    expectedOrigin,
    clientNonce,
    mainPid: process.pid,
    mainVersions: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      v8: process.versions.v8,
    },
    navigation: null,
    renderer: null,
    ping: null,
    rendererError: null,
    checks: [],
    ok: false,
  };

  const check = (id, pass, detail) => {
    report.checks.push({ id, pass: !!pass, detail: detail === undefined ? null : detail });
    return !!pass;
  };

  const wc = window.webContents;
  try {
    await waitForLoad(wc);
  } catch (err) {
    check('page-loads', false, String(err && err.message ? err.message : err));
    return finish(report);
  }

  report.navigation = navigation();
  check('page-loads', true, wc.getURL());
  check(
    'http-200',
    report.navigation && report.navigation.httpResponseCode === 200,
    report.navigation
  );

  const js = `(async () => {
    const facts = {
      origin: window.location.origin,
      href: window.location.href,
      title: document.title,
      bodyChars: document.body ? document.body.innerHTML.length : 0,
      userAgent: navigator.userAgent,
      hasBridge: !!(window.scruple && typeof window.scruple.ping === 'function'),
      bridgeHost: window.scruple ? window.scruple.host : null,
    };
    if (!facts.hasBridge) return { facts, ping: null, error: 'window.scruple.ping is not a function' };
    try { return { facts, ping: await window.scruple.ping(${JSON.stringify(clientNonce)}), error: null }; }
    catch (e) { return { facts, ping: null, error: String(e) }; }
  })()`;

  let result;
  try {
    result = await wc.executeJavaScript(js, true);
  } catch (err) {
    check('renderer-responds', false, String(err && err.message ? err.message : err));
    return finish(report);
  }
  check('renderer-responds', true);

  report.renderer = result.facts;
  report.ping = result.ping;
  report.rendererError = result.error;

  // The page really came from the served app, not from about:blank or a file.
  check('page-from-app-url', result.facts.origin === expectedOrigin, result.facts.origin);
  check('page-has-content', result.facts.bodyChars > 200, result.facts.bodyChars);

  // The bridge exists and answers. Without a preload there is nothing to call.
  check('bridge-present', result.facts.hasBridge, result.facts.bridgeHost);
  check('ping-no-error', result.error === null, result.error);

  const p = result.ping || {};
  check('ping-pong', p.pong === true, p.pong);
  // renderer -> main: the handler saw the caller's nonce.
  check('ping-echoes-client-nonce', p.echo === clientNonce, p.echo);
  // main -> renderer: a value the page had no way to invent.
  check('ping-carries-server-nonce', p.serverNonce === SERVER_NONCE, p.serverNonce);
  check('ping-from-this-main', p.mainPid === process.pid, p.mainPid);
  check('ping-sender-is-window', p.senderWindowId === window.id, p.senderWindowId);
  check(
    'ping-sender-url-is-app',
    typeof p.senderURL === 'string' && p.senderURL.startsWith(expectedOrigin),
    p.senderURL
  );
  check(
    'ping-reports-versions',
    !!(p.versions && p.versions.electron && p.versions.chrome),
    p.versions
  );

  return finish(report);
}

function finish(report) {
  report.ok = report.checks.length > 0 && report.checks.every((c) => c.pass);
  report.finishedAt = new Date().toISOString();

  const dest = process.env.SCRUPLE_D1_REPORT;
  if (dest) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, JSON.stringify(report, null, 2));
    console.log(`[probe] wrote ${dest}`);
  }
  for (const c of report.checks) {
    console.log(`[probe] ${c.pass ? 'PASS' : 'FAIL'}  ${c.id}  ${JSON.stringify(c.detail)}`);
  }
  console.log(`[probe] ok=${report.ok}`);
  return report.ok;
}

module.exports = { runProbe };
