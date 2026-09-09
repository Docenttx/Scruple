/**
 * page-ready.js — "has the window actually got a page in it".
 *
 * Extracted from probe.js so the WO-D1 probe and the WO-D2 scenario runner
 * agree on what loaded means. `did-finish-load` fires for a 404 body too, so
 * this only promises the navigation settled; the HTTP status is checked by the
 * caller, against `did-navigate`.
 */

'use strict';

const DEFAULT_TIMEOUT_MS = 60000;

function waitForLoad(wc, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    if (!wc.isLoading() && wc.getURL() && wc.getURL() !== 'about:blank') return resolve();
    const timer = setTimeout(
      () => reject(new Error(`page did not finish loading within ${timeoutMs}ms`)),
      timeoutMs
    );
    wc.once('did-finish-load', () => { clearTimeout(timer); resolve(); });
    wc.once('did-fail-load', (_e, code, desc, url) => {
      clearTimeout(timer);
      reject(new Error(`did-fail-load ${url}: ${desc} (${code})`));
    });
  });
}

module.exports = { waitForLoad, DEFAULT_TIMEOUT_MS };
