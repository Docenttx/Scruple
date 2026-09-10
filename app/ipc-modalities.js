/**
 * ipc-modalities.js — `scruple:modalities`: put §9.1 and §9.2 on an artifact.
 *
 * WHAT A LOCK ACTUALLY OWES THE ARTIFACT
 *
 * Scruple Standard v1.7 §9 calls these OUTPUT MODALITIES, and they are peers:
 *
 *   §9.1  a C2PA content credential — in-band signed metadata
 *   §9.2  an imperceptible watermark whose payload encodes a signing timestamp
 *   §9.3  a chain lock, which carries a watermark OF ITS OWN whose body is the
 *         SCR_ID rather than a time
 *
 * Both §9.1 and §9.2 implement Section 1 mandatory marking measures of the
 * **EU AI Act Article 50 Code of Practice**. ⚑ Watermarking is NOT part of C2PA
 * and must never borrow its conformance language: they are two ways of
 * satisfying one obligation, and a verifier reaches them by different means —
 * C2PA with standard tooling, the watermark with nothing but the pixels.
 *
 * THE TIER IS THE APP'S OWN BUTTON
 *
 *   checkpoint          -> tier 2  checkpoint         §9.2, timestamp body
 *   local disc lock     -> tier 3  local-lock         §9.2, timestamp body
 *   single chain lock   -> tier 4  chain-lock-basic   §9.3, SCR_ID body
 *   persistent + pinned -> tier 5  chain-lock-pinned  §9.3, SCR_ID + hint
 *
 * That ladder was not invented here. It is `lib/watermark/embed.ts`'s, and it
 * already mapped onto these buttons before anything called it from the desktop.
 *
 * ⚑ WHO IS ALLOWED TO DO WHICH PART, AND WHY THE SPLIT IS NOT ARBITRARY
 *
 *   the PAYLOAD is minted by the SERVER (/api/scruple/watermark/payload). For
 *     tiers 1-3 its body is a SIGNING TIMESTAMP; a time this laptop invented is
 *     a claim about this laptop's clock, not about a signing event. For tiers
 *     4-5 its body is the SCR_ID, which the desktop does not assign.
 *   the EMBED happens HERE, because embedding is not signing. The mark carries
 *     no key and proves nothing alone; what binds it is the credential signed
 *     afterwards, over the derivative bytes.
 *   the SIGNATURE is the SERVER's, through `scruple:credential`. docs/DESIGN.md:
 *     "The key is deliberately somewhere the desktop cannot reach; that is the
 *     custody claim, not a limitation to engineer around."
 *
 * ORDER: watermark FIRST, then sign. The artifact the public receives is the
 * derivative, so the derivative is what the credential must cover. Signing the
 * master and then watermarking it would invalidate the signature it just made;
 * signing the master and shipping the derivative would ship an artifact whose
 * credential is about different bytes.
 *
 * ⚑ THE MASTER IS NEVER TOUCHED. WATERMARK_DESIGN §4.3: masters stay clean. The
 * derivative is a new file beside it, and a caller that wanted the master
 * modified in place would have to ask for something this channel cannot do.
 */

'use strict';

const { ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');

const WEB_ROOT = process.env.SCRUPLE_WEB_ROOT || '/data/scruple-web';
const WATERMARK_CLI = path.join(WEB_ROOT, 'services', 'watermark', 'cli.py');
const HTTP_TIMEOUT_MS = Number(process.env.SCRUPLE_MODALITIES_TIMEOUT_MS || 120000);
const EMBED_TIMEOUT_MS = Number(process.env.SCRUPLE_WATERMARK_TIMEOUT_MS || 180000);

/** The app's actions, in the Standard's terms. No other tier is reachable. */
const TIER_FOR_ACTION = Object.freeze({
  checkpoint: 'checkpoint',              // 2
  'local-lock': 'local-lock',            // 3
  'chain-lock': 'chain-lock-basic',      // 4
  'chain-lock-pinned': 'chain-lock-pinned', // 5
});

function refuse(code, error, extra = {}) {
  // `tier` rides on every refusal that has one. A caller reading
  // `credential_refused` needs to know WHICH tier the server would not sign, or
  // it cannot tell a project-state problem from a wrong-tier request.
  return { ok: false, code, error, ...extra };
}

async function withTimeout(url, init, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } finally {
    clearTimeout(t);
  }
}

function runWatermarkCli(job) {
  return new Promise((resolve) => {
    const child = execFile(
      process.env.SCRUPLE_PYTHON || 'python3',
      [WATERMARK_CLI],
      { timeout: EMBED_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        // stdout may carry more than the answer, so the RESULT is the last line
        // that parses. Taking the whole stream works until someone adds a print.
        const lines = String(stdout || '').trim().split('\n').reverse();
        for (const line of lines) {
          if (!line.trim().startsWith('{')) continue;
          try { return resolve(JSON.parse(line)); } catch { /* keep looking */ }
        }
        resolve({
          ok: false,
          error: `watermark cli produced no JSON${err ? `: ${err.message}` : ''}`,
          stderr: String(stderr || '').split('\n').slice(-4),
        });
      }
    );
    child.stdin.end(JSON.stringify(job));
  });
}

function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

/**
 * Put the modalities on one artifact.
 *
 * @param {{action:string, assetPath:string, outputPath?:string,
 *          scrId?:string, pinnedHint?:number,
 *          digitalSourceType:string, projectId?:number}} req
 */
async function applyModalities(req) {
  const tier = TIER_FOR_ACTION[req && req.action];
  if (!tier) {
    return refuse('unknown_action',
      `action must be one of ${Object.keys(TIER_FOR_ACTION).join(', ')}; got ${JSON.stringify(req && req.action)}`);
  }
  if (!req.assetPath || !path.isAbsolute(req.assetPath)) {
    return refuse('bad_asset_path', 'assetPath must be an absolute path');
  }
  if (!fs.existsSync(req.assetPath)) {
    return refuse('asset_not_found', `no such file: ${req.assetPath}`);
  }
  // Never inferred — not from the tier, not from the extension. It is the field
  // that decides whether the manifest asserts that generative AI made these
  // bytes, and only the caller knows. lib/c2pa/signAsset.ts refuses to guess it
  // and so does this.
  if (typeof req.digitalSourceType !== 'string' || !req.digitalSourceType.trim()) {
    return refuse('digital_source_type_required',
      'the caller must declare digitalSourceType; it is the claim, not a detail');
  }

  const appUrl = process.env.SCRUPLE_APP_URL || 'http://127.0.0.1:3902';
  const apiKey = process.env.SCRUPLE_CREDENTIAL_API_KEY;
  if (!apiKey) return refuse('no_api_key', 'SCRUPLE_CREDENTIAL_API_KEY is not set');

  const masterHash = sha256File(req.assetPath);

  // ── §9.2 / §9.3 · the payload, minted by the server ────────────────────────
  let payload;
  try {
    const res = await withTimeout(`${appUrl}/api/scruple/watermark/payload`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ tier, scr_id: req.scrId, pinned_hint: req.pinnedHint }),
    }, HTTP_TIMEOUT_MS);
    payload = await res.json();
    if (!res.ok) return refuse('payload_refused', `server refused the payload: ${JSON.stringify(payload)}`);
  } catch (e) {
    return refuse('payload_unreachable', `could not reach the payload endpoint: ${e.message}`);
  }

  // ── the embed · here, because embedding is not signing ─────────────────────
  const outputPath = req.outputPath || req.assetPath.replace(/(\.[^.]+)$/, '.wm$1');
  const embed = await runWatermarkCli({
    action: 'embed',
    input_path: req.assetPath,
    output_path: outputPath,
    output_format: (path.extname(req.assetPath).slice(1) || 'png').toUpperCase(),
    payload_hex: payload.payload_hex,
  });
  if (!embed.ok) return refuse('embed_failed', embed.error || 'watermark embed failed', { embed });

  // ⚑ PROVE THE MARK IS THERE BEFORE CLAIMING IT IS. An embed that reported
  // success and produced an unmarked file would otherwise be indistinguishable
  // from one that worked, and the difference only shows up when someone
  // downstream tries to verify.
  const back = await runWatermarkCli({ action: 'decode', input_path: outputPath });
  if (!back.ok || !back.decoded) {
    return refuse('embed_unverifiable',
      'the derivative was written but the detector could not read the payload back out', { decode: back });
  }

  // ── §9.1 · the credential, signed by a key this machine cannot reach ───────
  let credential = null;
  try {
    const res = await withTimeout(`${appUrl}/api/scruple/c2pa/sign`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        project_id: req.projectId,
        asset_path: outputPath,
        product: 'studio',
        tier: tier.startsWith('chain') ? 'chain' : (tier === 'local-lock' ? 'local' : 'witnessed'),
        digital_source_type: req.digitalSourceType,
        title: req.title || path.basename(req.assetPath),
      }),
    }, HTTP_TIMEOUT_MS);
    credential = await res.json();
    if (!res.ok) {
      // A refusal from the signer is NOT an outage and must not be smoothed
      // into one. The derivative exists and is watermarked; what is missing is
      // the credential, and the caller is told exactly that.
      return refuse('credential_refused',
        `the server refused to sign: ${JSON.stringify(credential)}`,
        { tier, derivative: { path: outputPath, payload: back.decoded, master_sha256: masterHash } });
    }
  } catch (e) {
    return refuse('credential_unreachable', `could not reach the signer: ${e.message}`,
      { tier, derivative: { path: outputPath, payload: back.decoded, master_sha256: masterHash } });
  }

  return {
    ok: true,
    tier,
    master: { path: req.assetPath, sha256: masterHash },
    // §9.2 / §9.3 — read back OUT of the file, never echoed from the request.
    watermark: { path: outputPath, payload: back.decoded, payload_hex: payload.payload_hex },
    // §9.1
    credential,
  };
}

function registerModalitiesIpc() {
  ipcMain.handle('scruple:modalities', async (_e, req) => applyModalities(req));
}

module.exports = { registerModalitiesIpc, applyModalities, TIER_FOR_ACTION };
