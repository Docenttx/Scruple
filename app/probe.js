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
const { waitForLoad } = require('./page-ready');

const LOAD_TIMEOUT_MS = Number(process.env.SCRUPLE_D1_LOAD_TIMEOUT_MS || 60000);

/**
 * Is this page the application's own, or something that merely loaded?
 *
 * Two shapes are legitimate and nothing else is:
 *   - the served Next app, when SCRUPLE_APP_URL points at one (the D5 shape, kept
 *     because G2 embeds a served panel inside Workspace);
 *   - the desktop shell's own entry point, `app-legacy/index-final.html`.
 *
 * about:blank, a data: URL, and any other file on disk all fail — which is the
 * property the original check was defending.
 */
function isTheAppsOwnPage(facts, expectedOrigin) {
  const href = typeof facts.href === 'string' ? facts.href : '';
  if (href.startsWith(expectedOrigin)) return true;
  return href.startsWith('file://') && href.endsWith('/app-legacy/index-final.html');
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
    await waitForLoad(wc, LOAD_TIMEOUT_MS);
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

  // The page really came from the app, not from about:blank or some other file.
  //
  // ⚑ WO-G1 CHANGED WHAT "the app" MEANS, and the assertion had to follow. Under
  // WO-D5 the app WAS the served page, so `origin === expectedOrigin` was the
  // whole test. The shell now loads its own renderer off disk — see
  // docs/G-SERIES-REPORT.md — and a file:// origin is `"file://"` for every file
  // on the machine, so origin alone would accept about:blank's neighbours.
  // The href is therefore the observable, and it must be the app's OWN entry
  // point. This is stricter than what it replaces, not looser.
  check(
    'page-from-app-url',
    isTheAppsOwnPage(result.facts, expectedOrigin),
    result.facts.href
  );
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
    typeof p.senderURL === 'string' && isTheAppsOwnPage({ href: p.senderURL, origin: null }, expectedOrigin),
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
