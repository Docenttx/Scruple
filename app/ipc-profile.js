/**
 * ipc-profile.js — `scruple:profile`: what THIS MACHINE has.
 *
 * WO-D5 splits the dashboard's facts in two, and the split is the honest part:
 *
 *   the SERVER answers which REGIONS apply — /api/v2/capabilities?profile=…,
 *   because "applicability is not secret". It is a fact about the SHAPE of a
 *   deployment and the server owns it.
 *
 *   THIS answers what is actually on the box — where the models are, whether
 *   the gate is holding a port, what the vault's ceiling is. The server cannot
 *   know any of it and must not pretend to; a dashboard that printed a version
 *   number the server made up would be manufacturing a measurement.
 *
 * ⚑ IT MEASURES, IT DOES NOT ASSERT. Every field here is read at call time:
 * `fs.existsSync` on a configured path, the live session object from
 * ipc-comfy.js, `os` for the machine. Where there is nothing to read the answer
 * is `null` with a reason, never a plausible default — the same three-valued
 * discipline the vault surface uses (docs/VAULT.md), applied to a UI.
 *
 * Nothing here is chosen by the renderer. The paths come from the environment,
 * in this process, for the reason ipc-comfy.js and ipc-vault.js already give: a
 * page that could name the model root could point the dashboard at a directory
 * it had filled itself.
 */

'use strict';

const { ipcMain, BrowserWindow, app } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { SERVER_NONCE } = require('./ipc-ping');
const { comfySession } = require('./ipc-comfy');
const { resolveBinary } = require('./ipc-blender');

/** Count the files under a directory, to a ceiling, without reading any. A
 *  count is a measurement; "some models" is not. */
function countFiles(root, ceiling = 10000) {
  let n = 0;
  const walk = (dir) => {
    if (n >= ceiling) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (n >= ceiling) return;
      if (e.isDirectory()) walk(path.join(dir, e.name));
      else if (e.isFile()) n++;
    }
  };
  if (!root) return null;
  if (!fs.existsSync(root)) return null;
  walk(root);
  return n;
}

function blender() {
  const bin = resolveBinary();
  return {
    id: 'blender',
    name: 'Blender',
    available: bin.exists,
    detail: bin.exists
      ? `${bin.path} (${bin.source})`
      : `no Blender where this app looks: ${bin.reason}`,
  };
}

function appsOnThisMachine() {
  const comfyMain = process.env.SCRUPLE_COMFY_MAIN || null;
  const session = comfySession();

  const comfy = {
    id: 'comfyui',
    name: 'ComfyUI',
    // "available" means THIS APP CAN LAUNCH IT: there is a main.py where the
    // environment says there is one. Not "it is running", which is a different
    // question answered by `gate.running` below.
    available: !!(comfyMain && fs.existsSync(comfyMain)),
    detail: comfyMain
      ? (fs.existsSync(comfyMain)
          ? (session && session.version ? `${session.version} · ${comfyMain}` : comfyMain)
          : `configured but absent: ${comfyMain}`)
      : 'no SCRUPLE_COMFY_MAIN configured',
  };

  return [
    comfy,
    {
      id: 'kohya',
      name: 'Kohya',
      available: false,
      detail: 'the legacy training IPC has not been rewritten onto the SDK yet',
    },
    // ⚑ WO-E5. From WO-D5 until now this entry carried a hard-coded sentence
    // saying Blender was absent, and docs/STATE.md §0 opened on it — which is
    // why scripts/e5-gate.sh greps this file for that sentence and requires
    // ZERO occurrences, including in a comment. It is a MEASUREMENT
    // now — the same `resolveBinary()` the announcement header is built from,
    // so what the dashboard's app list says and what the server was told cannot
    // drift apart. The version, the addon and the bridge are NOT here: they
    // cost a Blender launch and they belong to `scruple:blender`, which the
    // Blender region calls when there is a Blender region to fill.
    blender(),
  ];
}

function registerProfileIpc() {
  ipcMain.handle('scruple:profile', (event) => {
    const sender = BrowserWindow.fromWebContents(event.sender);
    const session = comfySession();
    const modelRoot = process.env.SCRUPLE_COMFY_BASE
      ? path.join(process.env.SCRUPLE_COMFY_BASE, 'models')
      : null;

    return {
      ok: true,
      host: 'electron',
      profile: 'desktop',
      // The same evidence ping carries, for the same reason: a renderer-side
      // stub cannot know either of these, so an assertion that finds them knows
      // the reply came from this process.
      serverNonce: SERVER_NONCE,
      mainPid: process.pid,
      senderWindowId: sender ? sender.id : null,
      machine: { platform: os.platform(), arch: os.arch(), cpus: os.cpus().length },
      appVersion: app.getVersion(),
      apps: appsOnThisMachine(),
      gate: session
        ? {
            url: session.gateUrl || null,
            upstream: session.upstreamUrl || null,
            adapter: session.adapter || null,
            running: !!session.running,
          }
        : null,
      vault: process.env.SCRUPLE_VAULT_STATE || process.env.SCRUPLE_VAULT_DIR
        ? {
            dir: process.env.SCRUPLE_VAULT_DIR || null,
            state: process.env.SCRUPLE_VAULT_STATE || null,
            ceilingBytes: process.env.SCRUPLE_VAULT_CEILING_BYTES
              ? Number(process.env.SCRUPLE_VAULT_CEILING_BYTES)
              : null,
            configured: true,
          }
        : null,
      modelStore: modelRoot
        ? { root: modelRoot, files: countFiles(modelRoot) }
        : null,
      at: new Date().toISOString(),
    };
  });
}

module.exports = { registerProfileIpc };
