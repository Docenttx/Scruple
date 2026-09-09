/**
 * ipc-blender-generate.js — `scruple:blender-generate`: ONE GENERATION,
 * STARTED INSIDE BLENDER, THROUGH THE GATE.
 *
 * WO-E6, and it is the far end of `docs/BLENDER.md`'s opening claim. Everything
 * before this work order arranged the two halves separately: WO-D4 put the
 * model fingerprints on a leaf from a generation this app submitted, and WO-E4
 * put the scene facts on a leaf from an announcement this app's driver
 * triggered. Neither started in Blender. This does.
 *
 * WHAT THIS PROCESS DOES, AND WHAT IT DELIBERATELY DOES NOT
 * ---------------------------------------------------------------------------
 * It launches Blender — `docs/DESIGN.md`'s first bullet says the app "launches
 * ComfyUI, Kohya and (later) Blender", and launching is what turns
 * configuration into measurement, exactly as ipc-comfy.js argues for ComfyUI.
 *
 * It does NOT generate. No request in this file goes to the gate, to ComfyUI or
 * to anything else; this process spawns a Blender and waits for a file. The
 * `/prompt`, the `/ws` and the `/view` are all made by a THIRD-PARTY bridge
 * add-on inside that Blender, from its own code, using an address it keeps in
 * its own preferences. `docs/BLENDER.md`: "we do not fork a bridge, vendor one,
 * or ask users to switch."
 *
 * ⚑ WHAT THE RENDERER MAY CHOOSE. A workflow, and the three scene facts a user
 * would have set before pressing Generate (scene name, frame, camera name).
 * That is the entire list, and it is the same rule ipc-comfy.js states: the
 * Blender binary, the profile, the announcement directory, the bridge's base
 * folder and — above all — THE ADDRESS THE BRIDGE IS POINTED AT come from the
 * environment and from the live gate session in this process. A page that could
 * name the target could point the bridge past the gate and then report that it
 * had not.
 *
 * ⚑ THE ADDRESS IS THE WHOLE INTEGRATION AND IT IS ALSO THE CONTROL.
 * `SCRUPLE_BLENDER_BRIDGE_TARGET=upstream` points the same bridge at ComfyUI
 * directly — the mutation WO-E6's control (b) asks for. What comes back then is
 * not nothing: the output-volume watcher still catches the file and the leaf is
 * BLIND and carries no graph (finding D4-2). Bypassing the gate produces a
 * thinner record, never an absent one, and the reply says which it was rather
 * than leaving it to be diagnosed from a missing leaf.
 *
 * 🔴 The rails are enforced here rather than remembered: this refuses to point
 * a bridge at :5799 or :3001.
 */

'use strict';

const { ipcMain, BrowserWindow } = require('electron');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { SERVER_NONCE } = require('./ipc-ping');
const { comfySession } = require('./ipc-comfy');
const { resolveBinary } = require('./ipc-blender');

const ROOT = process.env.SCRUPLE_DESKTOP_ROOT || path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'e6-blender-generate.py');
const TIMEOUT_MS = Number(process.env.SCRUPLE_BLENDER_GENERATE_TIMEOUT_MS || 600000);

/** Every Blender this handler started, so none of them outlives the app. */
const children = new Set();

function parseReport(stdout) {
  const open = stdout.indexOf('<<<E6_BLENDER');
  const close = stdout.indexOf('E6_BLENDER>>>');
  if (open === -1 || close === -1) return null;
  try {
    return JSON.parse(stdout.slice(stdout.indexOf('\n', open) + 1, close));
  } catch {
    return null;
  }
}

function registerBlenderGenerateIpc() {
  ipcMain.handle('scruple:blender-generate', async (event, req) => {
    const at = new Date().toISOString();
    const sender = BrowserWindow.fromWebContents(event.sender);
    const base = { ok: false, at, mainPid: process.pid, serverNonce: SERVER_NONCE,
                   senderWindowId: sender ? sender.id : null };
    const refuse = (reason, extra) => ({ ...base, outcome: 'refused', reason, ...(extra || {}) });

    if (!req || typeof req.workflow !== 'object' || req.workflow === null) {
      return refuse('no workflow given');
    }
    const session = comfySession();
    if (!session || !session.gateUrl) return refuse('no ComfyUI session; launch first');

    const binary = resolveBinary();
    if (!binary.exists) return refuse(`no Blender to launch: ${binary.reason}`, { binary });
    if (!fs.existsSync(SCRIPT)) return refuse(`the in-Blender script is missing: ${SCRIPT}`);

    // WHERE THE BRIDGE IS POINTED. From the session, never from the payload.
    const around = process.env.SCRUPLE_BLENDER_BRIDGE_TARGET === 'upstream';
    const target = around ? session.upstreamUrl : session.gateUrl;
    if (!target) return refuse('the session has no address to point the bridge at');
    if (target.includes(':5799') || target.includes(':3001')) {
      return refuse(`refusing: ${target} is production`);
    }

    const stateDir = process.env.SCRUPLE_COMFY_STATE
      || path.join(ROOT, '.run', 'e6', 'blender-state');
    const runDir = path.join(stateDir, 'blender');
    const bridgeBase = path.join(runDir, 'bridge-base');
    fs.mkdirSync(bridgeBase, { recursive: true });

    // The workflow, as a file, because that is how this bridge's own import
    // operator takes one — its README asks for an API-format export.
    const workflowPath = path.join(runDir, 'workflow.json');
    fs.writeFileSync(workflowPath, JSON.stringify(req.workflow, null, 2));
    const reportPath = path.join(runDir, 'report.json');
    fs.rmSync(reportPath, { force: true });

    const hostDir = process.env.SCRUPLE_COMFY_HOST_DIR || null;

    const args = [
      '--background', '--python', SCRIPT, '--',
      '--target', target,
      '--workflow', workflowPath,
      '--base-folder', bridgeBase,
      '--report', reportPath,
      '--timeout', String(Math.floor(TIMEOUT_MS / 2000)),
      ...(hostDir ? ['--host-dir', hostDir] : []),
      ...(typeof req.scene === 'string' ? ['--scene', req.scene] : []),
      ...(req.frame !== undefined ? ['--frame', String(req.frame)] : []),
      ...(typeof req.camera === 'string' ? ['--camera', req.camera] : []),
      ...(process.env.SCRUPLE_BLENDER_ANNOUNCE === 'off' ? ['--announce', 'off'] : []),
      // ⚑ WO-E6's control (c), and it runs on EVERY generation rather than
      // under a mutation. A second announcement, of a real scene, valid
      // against the addon's own schema, written under an id nothing was
      // submitted with. It must reach no leaf, ever — so it is asserted on the
      // clean run, where a leaf claiming it would be the defect.
      //
      // The scene name and the id may come from the page for the reason WO-D6
      // gives for the prompt id: CHOOSING THEM GRANTS NOTHING. The
      // announcement directory is named by this process from the environment,
      // and an id nobody submitted reads back as nothing at all.
      ...(typeof req.phantomScene === 'string' && typeof req.phantomPromptId === 'string'
        ? ['--phantom-scene', req.phantomScene, '--phantom-prompt-id', req.phantomPromptId,
           // The mutation that makes the control demonstrable: the SAME
           // phantom announcement, under the prompt id the bridge really
           // submitted. Then it does reach the leaf — which is how we know
           // the id is what kept it off.
           ...(process.env.SCRUPLE_E6_PHANTOM_UNDER_REAL_ID === '1' ? ['--phantom-under-real-id', '1'] : [])]
        : []),
    ];

    const env = { ...process.env };
    // The announcement directory has to be in the environment BEFORE Blender
    // starts: the Scruple addon declares itself in register(), which Blender
    // runs while enabling it from saved preferences — before the script's
    // first line. Setting it inside would prove the wrong thing.
    if (hostDir) env.SCRUPLE_COMFY_HOST_DIR = hostDir;
    else delete env.SCRUPLE_COMFY_HOST_DIR;
    if (process.env.SCRUPLE_BLENDER_PROFILE) {
      env.BLENDER_USER_RESOURCES = process.env.SCRUPLE_BLENDER_PROFILE;
    }

    const started = Date.now();
    const outcome = await new Promise((resolve) => {
      let child;
      try {
        child = spawn(binary.path, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (err) {
        resolve({ ok: false, reason: `could not start ${binary.path}: ${String(err.message || err)}` });
        return;
      }
      children.add(child);
      let out = '';
      let errOut = '';
      child.stdout.on('data', (d) => { out += d; process.stdout.write(`   |blender| ${d}`); });
      child.stderr.on('data', (d) => { errOut += d; });
      let timedOut = false;
      const killer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, TIMEOUT_MS);
      child.on('error', (err) => {
        clearTimeout(killer); children.delete(child);
        resolve({ ok: false, reason: `${binary.path} failed to run: ${String(err.message || err)}` });
      });
      child.on('close', (code, signal) => {
        clearTimeout(killer); children.delete(child);
        resolve({
          ok: !timedOut && code === 0, code, signal, stdout: out, stderr: errOut,
          reason: timedOut ? `Blender did not finish within ${TIMEOUT_MS}ms`
            : (code === 0 ? null : `Blender exited ${signal || code}`),
        });
      });
    });

    // The report is read OFF DISK, not out of stdout, when Blender wrote one:
    // a file that exists is an observable and a line on a pipe is a log. The
    // stdout copy is the fallback for a Blender that died before writing.
    const report = fs.existsSync(reportPath)
      ? JSON.parse(fs.readFileSync(reportPath, 'utf8'))
      : parseReport(outcome.stdout || '');
    if (!report) {
      const logPath = path.join(runDir, 'blender.log');
      fs.writeFileSync(logPath, `${outcome.stdout || ''}\n${outcome.stderr || ''}`);
      return refuse(outcome.reason || 'Blender produced no report', { logPath, code: outcome.code });
    }

    // The artifacts the BRIDGE downloaded into ITS OWN outputs folder, copied
    // into the run store and re-hashed here. The hash the driver asserts on is
    // taken from the bytes on disk in both places.
    const store = process.env.SCRUPLE_RUN_STORE;
    const images = [];
    for (const d of report.downloads || []) {
      const buf = fs.readFileSync(d.path);
      const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
      let storePath = d.path;
      if (store) {
        storePath = path.join(store, sha256.slice(0, 2), sha256);
        fs.mkdirSync(path.dirname(storePath), { recursive: true });
        fs.writeFileSync(storePath, buf);
      }
      images.push({ bridgePath: d.path, storePath, sha256, bytes: buf.length,
                    agreesWithBlender: sha256 === d.sha256 });
    }

    return {
      ...base,
      ok: outcome.ok && images.length > 0 && !report.error,
      outcome: report.error ? 'blender-error' : (images.length ? 'generated' : 'no-artifacts'),
      // Recorded, never inferred: which address the bridge was given, and
      // whether that address was the gate.
      target,
      viaGate: !around,
      gateUrl: session.gateUrl,
      upstreamUrl: session.upstreamUrl,
      blender: binary,
      promptId: report.prompt_id || null,
      hostDir,
      announcePath: hostDir && report.prompt_id
        ? path.join(hostDir, 'announce', `${report.prompt_id}.json`) : null,
      workflowPath,
      reportPath,
      images,
      blenderReport: report,
      elapsedMs: Date.now() - started,
      blenderExit: { code: outcome.code, signal: outcome.signal, reason: outcome.reason },
    };
  });
}

function shutdownBlenderGenerate() {
  for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
  children.clear();
}

module.exports = { registerBlenderGenerateIpc, shutdownBlenderGenerate };
