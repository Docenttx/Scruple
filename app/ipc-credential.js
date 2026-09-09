/**
 * ipc-credential.js — `scruple:credential`: ask the SERVER for a C2PA
 * credential over an artifact this machine produced.
 *
 * ⚑ THE HANDLER IS AN HTTP CALL, AND THAT IS THE ARCHITECTURE, NOT A SHORTCUT.
 * docs/DESIGN.md: "Everything requiring a signature — C2PA credentials, H-1
 * leaf signatures — happens on the server. The key is deliberately somewhere
 * the desktop cannot reach; that is the custody claim, not a limitation to
 * engineer around." So there is no signing code in this file, no key path, no
 * certificate and nothing to configure that could become one. What this app
 * contributes is what only it has: the bytes, and the measurements around them.
 *
 * In this sandbox the far end of that call signs through the CVM surrogate —
 * `signing_mode: 'kms-http'`, `signer_identity: … surrogate=true`. 🔴 The
 * surrogate is SOFTWARE-backed. A credential it signs is exactly as good as a
 * software key in a process, and `signer_identity` says so on every signature,
 * true or false, because an absent flag reads as "not a surrogate".
 *
 * THE THREE THINGS THIS HANDLER MUST NOT GUESS
 * ---------------------------------------------------------------------------
 *   the PROJECT   asked of `GET /api/projects` with this deployment's key. If
 *                 the answer is not exactly one project the handler REFUSES
 *                 and says how many it saw — signing an artifact into the
 *                 wrong chain is worse than not signing it.
 *   the LEAF      asked of `GET /api/v2/verify/{content_hash}`, the public
 *                 door, so the iteration named on the credential request is
 *                 one the server itself associates with these bytes.
 *   the SOURCE TYPE  never inferred. lib/c2pa/signAsset.ts refuses to guess it
 *                 from the product or the extension, and neither does this:
 *                 it is the field that decides whether the manifest asserts
 *                 "generative AI made this", and only the caller knows.
 *
 * WHAT THE RENDERER MAY CHOOSE. The artifact, its content hash, the tier and
 * the declared source type — the same rule ipc-capture.js applies to a path a
 * user picked. The server URL and the API key are configuration and are read
 * from the environment here, never from the invoke payload.
 *
 * ⚑ WHY THE ARTIFACT IS STAGED UNDER ITS PRODUCER'S FILENAME.
 * The run store is CONTENT-ADDRESSED, so an artifact on disk is called
 * `store/87/87215d7a…` and has no extension. The signer types an asset from
 * its path and refuses `application/octet-stream` in terms worth repeating —
 * "it is not a format, it is the absence of one. Declare the real MIME" — which
 * is the vault's discipline (docs/VAULT.md) enforced one tier up. So the bytes
 * are copied to a staging directory under the name COMFYUI GAVE THEM, and the
 * copy is re-hashed against the digest the caller named before anything is
 * signed. The type therefore comes from the producer, never from a guess here,
 * and a copy that did not survive the copy is a refusal rather than a
 * signature over different bytes.
 */

'use strict';

const { ipcMain, BrowserWindow } = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const HTTP_TIMEOUT_MS = Number(process.env.SCRUPLE_CREDENTIAL_TIMEOUT_MS || 120000);

async function callJson(url, init) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal });
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

function registerCredentialIpc() {
  ipcMain.handle('scruple:credential', async (event, req) => {
    const at = new Date().toISOString();
    const sender = BrowserWindow.fromWebContents(event.sender);
    const base = { ok: false, at, mainPid: process.pid, senderWindowId: sender ? sender.id : null };
    const refuse = (reason, extra) => ({ ...base, outcome: 'refused', reason, ...(extra || {}) });

    const appUrl = process.env.SCRUPLE_APP_URL || 'http://127.0.0.1:3902';
    const apiKey = process.env.SCRUPLE_CREDENTIAL_API_KEY;
    if (!apiKey) return refuse('SCRUPLE_CREDENTIAL_API_KEY is not set');
    if (!req || typeof req.assetPath !== 'string' || !req.assetPath) return refuse('no assetPath given');
    if (typeof req.digitalSourceType !== 'string' || !req.digitalSourceType) {
      // The same refusal the route makes, made one tier earlier so the
      // reason arrives with the caller rather than as a 400 to decode.
      return refuse('no digitalSourceType declared — it is never inferred');
    }
    const tier = typeof req.tier === 'string' ? req.tier : 'bare';
    const auth = { authorization: `Bearer ${apiKey}` };

    // 0. STAGE THE BYTES UNDER A NAME THAT CARRIES THEIR TYPE.
    let assetPath = path.resolve(req.assetPath);
    let stagedPath = null;
    if (typeof req.assetName === 'string' && req.assetName) {
      const name = path.basename(req.assetName);
      if (name !== req.assetName || name.startsWith('.')) return refuse(`assetName "${req.assetName}" is not a plain filename`);
      const storeDir = process.env.SCRUPLE_RUN_STORE;
      if (!storeDir) return refuse('SCRUPLE_RUN_STORE is not set');
      const dir = path.join(storeDir, 'credential');
      fs.mkdirSync(dir, { recursive: true });
      stagedPath = path.join(dir, name);
      try { fs.copyFileSync(assetPath, stagedPath); }
      catch (err) { return refuse(`could not stage the asset: ${String(err.message || err)}`); }
      // The copy is the thing that gets signed, so the copy is what gets
      // checked. A digest taken before the copy would say nothing about it.
      const staged = crypto.createHash('sha256').update(fs.readFileSync(stagedPath)).digest('hex');
      if (typeof req.contentHash === 'string' && staged !== req.contentHash) {
        return refuse('the staged copy does not hash to the digest given', { staged, expected: req.contentHash });
      }
      assetPath = stagedPath;
    }

    // 1. WHICH PROJECT HOLDS THIS DEPLOYMENT'S CHAIN. Asked, not assumed.
    const projects = await callJson(`${appUrl}/api/projects?limit=50`, { headers: auth });
    if (!projects.ok) {
      return refuse(`could not list projects (${projects.status})`, { detail: projects.raw });
    }
    const list = Array.isArray(projects.data)
      ? projects.data
      : (projects.data && Array.isArray(projects.data.projects) ? projects.data.projects : []);
    if (list.length !== 1) {
      return refuse(`this key sees ${list.length} projects; refusing to choose one`, {
        projectIds: list.map((p) => p.id),
      });
    }
    const project = list[0];

    // 2. WHICH LEAF COVERS THESE BYTES. The public door, so the association is
    //    the server's and not ours.
    let iterationId = null;
    let leafHash = null;
    if (typeof req.contentHash === 'string' && /^[0-9a-f]{64}$/.test(req.contentHash)) {
      const verify = await callJson(`${appUrl}/api/v2/verify/${req.contentHash}`);
      const v = verify.data || {};
      if (verify.ok && v.found === true && v.leaf) {
        iterationId = Number(v.leaf.leaf_id);
        leafHash = v.leaf.leaf_hash;
      }
    }

    // 3. THE SIGNATURE, WHICH HAPPENS SOMEWHERE THIS PROCESS CANNOT REACH.
    const signReq = {
      project_id: project.id,
      ...(iterationId ? { iteration_id: iterationId } : {}),
      asset_path: assetPath,
      product: 'studio',
      tier,
      digital_source_type: req.digitalSourceType,
      ...(req.title ? { title: req.title } : {}),
    };
    const signed = await callJson(`${appUrl}/api/scruple/c2pa/sign`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify(signReq),
    });
    const d = signed.data || {};

    if (!signed.ok || d.ok !== true) {
      // A REFUSAL IS A RECORDED OUTCOME, the discipline docs/VAULT.md sets for
      // the vault applied here: the signer declining is a fact about this run
      // and it is returned, with the route's machine-readable `code`, rather
      // than being flattened into "no credential".
      return refuse(`the signer refused (${signed.status})`, {
        request: signReq, stagedPath, projectId: project.id, iterationId, leafHash,
        // BOTH halves of the route's refusal. `error` names the tier and
        // `reason` says what is missing — "project has no SCR-ID (never
        // witnessed)" — and only the second one is actionable.
        signerCode: d.code || null,
        signerError: [d.error, d.reason].filter(Boolean).join(' — ') || signed.raw || null,
      });
    }

    return {
      ...base,
      ok: true,
      outcome: 'signed',
      appUrl,
      request: signReq,
      stagedPath,
      projectId: project.id,
      iterationId,
      leafHash,
      signedPath: d.signed_path,
      bytes: d.bytes,
      tier: d.tier,
      scrId: d.scr_id || null,
      // Carried verbatim. `local` here would mean the server signed with a key
      // on its own disk and the surrogate was never involved — a different
      // custody claim wearing the same response shape, and the gate reads
      // these two fields for exactly that reason.
      signingMode: d.signing_mode || null,
      signerIdentity: d.signer_identity || null,
      // Fail-open on the server's side and reported here rather than hidden:
      // the sign event's own leaf is emitted to an internal stream, and not
      // emitting it must never block the credential.
      witness: d.witness || null,
      witnessError: d.witness_error || null,
    };
  });
}

module.exports = { registerCredentialIpc };
