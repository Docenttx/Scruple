/**
 * ipc-receipt.js — `scruple:receipts`: what the SERVER will tell anyone about
 * the leaves this machine produced.
 *
 * WO-D7 runs the whole flow and the last two stations on it are the ones a
 * user actually ends up holding: a RECEIPT and a RESOLUTION. Everything before
 * them is Scruple talking to itself.
 *
 * ⚑ THIS HANDLER SENDS NO CREDENTIAL, AND THAT IS THE POINT.
 * `/api/v2/verify`, `/api/v2/receipt` and `/api/v2/resolve` are public and
 * unauthenticated by design — the receipt route's own header says "a receipt
 * whose verification requires the issuer's cooperation is not much of a
 * receipt". So this asks them the way a stranger holding the file would, with
 * no Authorization header at all. A handler that authenticated here would be
 * proving something weaker than the thing being claimed, and would hide the
 * day the routes stopped being public.
 *
 * WHAT THE RENDERER MAY CHOOSE. A list of content hashes. That is a public
 * identifier for bytes — it is the whole input to `/api/v2/verify/{hash}`, and
 * a page that names one learns nothing it could not learn by hashing a file it
 * already has. The server URL is configuration and comes from the environment,
 * in this process, for the reason every other handler here gives.
 *
 * ⚑ IT REPORTS, IT DOES NOT GRADE. Three states arrive as HTTP 200 from
 * /api/v2/resolve — `resolvable`, `evidence_expired`, `unresolvable` — and
 * this handler carries whichever came back. scripts/desktop-run.mjs asks the
 * same routes again, from another process, and that second answer is what the
 * gate reads: the app's reply is a claim, like every other reply here.
 */

'use strict';

const { ipcMain, BrowserWindow } = require('electron');

const HTTP_TIMEOUT_MS = Number(process.env.SCRUPLE_RECEIPT_TIMEOUT_MS || 30000);

/**
 * GET a v2 route and unwrap it.
 *
 * `v2Ok` wraps some routes in `data` and returns others bare — d3-sandbox.ts
 * found that out by assuming, so both are read here rather than one being
 * guessed at. A non-2xx is DATA, not an exception: a 404 from the receipt
 * route is the answer for a leaf nobody issued, and turning it into a throw
 * would lose it.
 */
async function getJson(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* not JSON is a fact too */ }
    const data = body && typeof body === 'object' && body.data !== undefined ? body.data : body;
    return { status: res.status, ok: res.ok, data, raw: body === null ? text.slice(0, 400) : null };
  } catch (err) {
    return { status: 0, ok: false, data: null, raw: String(err && err.message ? err.message : err) };
  } finally {
    clearTimeout(t);
  }
}

function registerReceiptIpc() {
  ipcMain.handle('scruple:receipts', async (event, req) => {
    const at = new Date().toISOString();
    const sender = BrowserWindow.fromWebContents(event.sender);
    const base = { ok: false, at, mainPid: process.pid, senderWindowId: sender ? sender.id : null };
    const refuse = (reason, extra) => ({ ...base, outcome: 'refused', reason, ...(extra || {}) });

    const appUrl = process.env.SCRUPLE_APP_URL || 'http://127.0.0.1:3902';
    const hashes = req && Array.isArray(req.contentHashes) ? req.contentHashes : null;
    if (!hashes || hashes.length === 0) return refuse('no contentHashes given');

    // Deduplicated, because one flow hashes the same bytes from two stations
    // and a table with the same row twice is not two pieces of evidence.
    const seen = new Set();
    const rows = [];
    for (const h of hashes) {
      if (typeof h !== 'string' || !/^[0-9a-f]{64}$/.test(h)) {
        rows.push({ contentHash: String(h), found: false, error: 'not a sha-256 hex digest' });
        continue;
      }
      if (seen.has(h)) continue;
      seen.add(h);

      // 1. bytes → leaf. The route a stranger with only a file would use.
      const verify = await getJson(`${appUrl}/api/v2/verify/${h}`);
      const v = verify.data || {};
      if (!verify.ok || v.found !== true) {
        rows.push({
          contentHash: h, found: false, verifyStatus: verify.status,
          note: v.note || verify.raw || null,
        });
        continue;
      }
      // ⚑ The verify route answers `ORDER BY id DESC LIMIT 1`. One generation
      // through the gate makes TWO leaves over the same bytes, so this is the
      // NEWEST leaf for these bytes and not the only one. The driver enumerates
      // every leaf for the table; this station reports what the public door
      // actually hands back, which is one.
      const leafId = v.leaf && v.leaf.leaf_id ? String(v.leaf.leaf_id) : null;

      // 2. leaf → receipt. What the user was given.
      const receipt = leafId ? await getJson(`${appUrl}/api/v2/receipt/${leafId}`) : null;
      const r = (receipt && receipt.data) || {};
      // 3. leaf → resolution. Whether the evidence behind it can still be got.
      const resolved = leafId ? await getJson(`${appUrl}/api/v2/resolve/${leafId}`) : null;
      const s = (resolved && resolved.data) || {};

      rows.push({
        contentHash: h,
        found: true,
        leafId,
        leafHash: (v.leaf && v.leaf.leaf_hash) || null,
        witnessed: v.witnessed === true,
        baselineRef: (v.leaf && v.leaf.baseline_ref) || null,
        // H-1's disclosure, carried rather than summarised: `unsigned` on this
        // sandbox is a fact about the witness's configuration, not a defect in
        // the flow, and STATE.md says so.
        signatureState: (v.signature && v.signature.state) || null,
        independentlyVerifiable: v.independently_verifiable === true,
        signerSurrogate: v.signature ? v.signature.leaf_signer_surrogate : null,
        receiptStatus: receipt ? receipt.status : null,
        receiptContentHash: r.content_hash || null,
        basis: r.attestation_basis ? r.attestation_basis.basis : null,
        profile: r.attestation_basis ? r.attestation_basis.profile : null,
        mime: r.mime || null,
        resolveStatus: resolved ? resolved.status : null,
        resolution: s.resolution || null,
        resolutionReason: s.reason || null,
        settlement: s.settlement ? s.settlement.state : null,
        retainedUntil: s.evidence ? s.evidence.retained_until : null,
      });
    }

    const found = rows.filter((x) => x.found);
    return {
      ...base,
      // "Every hash reached a leaf, every leaf had a receipt, every receipt
      // resolved." Said here so a run that half-worked cannot read as a run
      // that worked; graded independently by the driver either way.
      ok: rows.length > 0 && rows.every((x) => x.found && x.receiptStatus === 200 && x.resolution === 'resolvable'),
      outcome: 'read',
      appUrl,
      credentialSent: false,
      counts: {
        asked: rows.length,
        found: found.length,
        receipted: found.filter((x) => x.receiptStatus === 200).length,
        resolvable: found.filter((x) => x.resolution === 'resolvable').length,
      },
      rows,
    };
  });
}

module.exports = { registerReceiptIpc };
