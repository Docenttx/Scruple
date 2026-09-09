/**
 * ipc-blender.js — `scruple:blender`: the Blender ON THIS BOX, measured.
 *
 * WO-E5. The dashboard's Blender region is drawn only when this machine has a
 * Blender (see `installedAppIds()` and the header in main-modular.js), and
 * everything INSIDE it comes from here. The split is WO-D5's, unchanged:
 *
 *   the SERVER answers whether the region applies — but it cannot know that on
 *   its own, so the host announces what it has and the server decides from the
 *   announcement. `/data/scruple-web/lib/v2/deployment.ts` has the argument.
 *
 *   THIS answers what the Blender IS. A version, an addon's enabled state and
 *   a bridge's address are readings taken on this machine and nowhere else.
 *
 * ⚑ FOUR READINGS, EACH WITH ITS OWN STATE, AND NEVER A PLAUSIBLE DEFAULT.
 * `ipc-profile.js` sets the rule for this file and it is followed exactly: a
 * reading that could not be taken is `null` with a reason. In particular
 * "there is no bridge" and "no gate is running, so there is nothing to compare
 * a bridge against" are DIFFERENT ANSWERS and are not collapsed — the second is
 * `unknown`, and a UI that printed "not pointed at the gate" for it would be
 * asserting something nobody measured.
 *
 * ⚑ THE VERSION IS READ FROM THE RUNNING BINARY, in its own launch, because it
 * is the reading that must survive everything else failing: a profile with a
 * broken addon, a Blender too old to have the extensions system (WO-E3 measured
 * 3.0.1 has neither), a probe that throws. `blender --version` is the binary
 * telling us what it is, and it is not `bl_info`, a manifest, or a path.
 *
 * ⚑ IT MEASURES, IT DOES NOT ARRANGE. The probe enables nothing and installs
 * nothing, and `SCRUPLE_COMFY_HOST_DIR` is deliberately STRIPPED from the
 * Blender it starts: enabling the Scruple addon writes a host declaration
 * (WO-E4), and an app that declared a Level-2 host as a side effect of drawing
 * its own dashboard would be arranging the evidence it then reports.
 *
 * Where Blender is looked for, in order, all of it from the environment for the
 * reason ipc-comfy.js and ipc-vault.js already give — a page that could name
 * the binary could point the dashboard at anything:
 *
 *   SCRUPLE_BLENDER_BIN           an explicit binary. Configured-but-absent is
 *                                 reported as that, never fallen through.
 *   SCRUPLE_BLENDER_VENDOR        the app's own tree; default
 *                                 <root>/vendor/blender/bin/blender (WO-E3).
 *   SCRUPLE_BLENDER_SEARCH_PATH   a PATH to search for `blender`; defaults to
 *                                 $PATH. ⚑ On this box that finds 3.0.1, which
 *                                 is a real Blender this app can measure and
 *                                 CANNOT load the addon we ship through the
 *                                 manifest path — so the reading says 3.0.1 and
 *                                 the addon reading says not enabled, which is
 *                                 the truth about that machine.
 */

'use strict';

const { ipcMain, BrowserWindow } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const { SERVER_NONCE } = require('./ipc-ping');
const { comfySession } = require('./ipc-comfy');

const ROOT = process.env.SCRUPLE_DESKTOP_ROOT || path.join(__dirname, '..');
const PROBE = path.join(ROOT, 'scripts', 'e5-blender-probe.py');
const TIMEOUT_MS = Number(process.env.SCRUPLE_BLENDER_PROBE_TIMEOUT_MS || 240000);

/** Every Blender this process started, so none of them outlives it. The rails
 *  for this series say to reap what you orphan and that is not only Xvfb. */
const children = new Set();

/** The version cannot change while the binary does not, so it is cached by
 *  path and read once. */
const versionCache = new Map();

/**
 * ⚑ THE PROBE IS CACHED, AND ITS KEY INCLUDES THE GATE.
 *
 * A dashboard with a Blender panel must not start a Blender per render, so the
 * reading is shared. But it is DATED BY THE GATE IT WAS TAKEN AGAINST: a probe
 * taken before ComfyUI was launched read a bridge's address at a moment when
 * there was nothing for it to be pointed at, and answering `elsewhere` from
 * that afterwards would be reporting a comparison against an address that did
 * not exist yet. When the gate changes, the reading is retaken.
 */
let probeCache = { key: null, promise: null };

function isExecutable(p) {
  try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); }
  catch { return false; }
}

/**
 * Where Blender is, and HOW IT WAS FOUND. The source matters: "the one this
 * app ships" and "whatever was on PATH" are different claims about the same
 * path string, and the region prints both.
 */
function resolveBinary() {
  const explicit = process.env.SCRUPLE_BLENDER_BIN;
  if (explicit) {
    return {
      path: explicit,
      source: 'configured',
      exists: isExecutable(explicit),
      // A configured binary that is not there is NOT a reason to go looking
      // somewhere else. Falling through would answer a question the operator
      // did not ask and would hide a broken configuration behind a working
      // dashboard.
      reason: isExecutable(explicit)
        ? 'SCRUPLE_BLENDER_BIN'
        : `SCRUPLE_BLENDER_BIN is set to ${explicit} and there is no executable there`,
    };
  }
  const vendored = process.env.SCRUPLE_BLENDER_VENDOR
    || path.join(ROOT, 'vendor', 'blender', 'bin', 'blender');
  if (isExecutable(vendored)) {
    return { path: vendored, source: 'vendored', exists: true, reason: 'the Blender in this app’s own tree' };
  }
  const searchPath = process.env.SCRUPLE_BLENDER_SEARCH_PATH === undefined
    ? (process.env.PATH || '')
    : process.env.SCRUPLE_BLENDER_SEARCH_PATH;
  for (const dir of searchPath.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, 'blender');
    if (isExecutable(candidate)) {
      return { path: candidate, source: 'search-path', exists: true, reason: `found on the search path in ${dir}` };
    }
  }
  return {
    path: null,
    source: 'none',
    exists: false,
    reason: vendored
      ? `no executable at ${vendored} and none named "blender" on the search path`
      : 'nothing configured and nothing on the search path',
  };
}

/**
 * ⚑ THE ANNOUNCEMENT. Which local apps this machine HAS, by looking, at the
 * moment it is asked. This is what rides on `x-scruple-host-apps`, and it is
 * `fs` and nothing else: no version, no launch, no probe — the header is built
 * before the first document request and must not wait for a Blender.
 *
 * Kohya is never announced: docs/STATE.md §5, its IPC has not been rewritten
 * onto the SDK, so whatever is on the disk this app cannot use. Announcing it
 * would put a region on the screen for a thing that cannot be driven.
 */
function installedAppIds() {
  const ids = [];
  const comfyMain = process.env.SCRUPLE_COMFY_MAIN;
  if (comfyMain && fs.existsSync(comfyMain)) ids.push('comfyui');
  if (resolveBinary().exists) ids.push('blender');
  return ids;
}

function run(bin, args, { timeoutMs }) {
  return new Promise((resolve) => {
    // The environment the probe gets, and the two things taken OUT of it:
    // SCRUPLE_COMFY_HOST_DIR, so measuring cannot declare a host (see the
    // header), and BLENDER_USER_RESOURCES, which is set only when this app was
    // told which profile to look at.
    const env = { ...process.env };
    delete env.SCRUPLE_COMFY_HOST_DIR;
    delete env.BLENDER_USER_RESOURCES;
    if (process.env.SCRUPLE_BLENDER_PROFILE) {
      env.BLENDER_USER_RESOURCES = process.env.SCRUPLE_BLENDER_PROFILE;
    }
    let child;
    try {
      child = spawn(bin, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ ok: false, reason: `could not start ${bin}: ${String(err && err.message || err)}` });
      return;
    }
    children.add(child);
    let out = '';
    let errOut = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { errOut += d; });
    const killer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    let timedOut = false;
    child.on('error', (err) => {
      clearTimeout(killer);
      children.delete(child);
      resolve({ ok: false, reason: `${bin} failed to run: ${String(err && err.message || err)}` });
    });
    child.on('close', (code, signal) => {
      clearTimeout(killer);
      children.delete(child);
      resolve({
        ok: !timedOut && code === 0,
        code, signal, stdout: out, stderr: errOut,
        reason: timedOut
          ? `${bin} did not answer within ${timeoutMs}ms`
          : (code === 0 ? null : `${bin} exited ${signal || code}`),
      });
    });
  });
}

/** The version, from the binary itself. `Blender 4.2.23 LTS` → `4.2.23`. */
async function readVersion(bin) {
  const r = await run(bin, ['--version'], { timeoutMs: TIMEOUT_MS });
  if (!r.ok) return { state: 'unread', value: null, tuple: null, reason: r.reason };
  const m = /^Blender\s+([0-9]+(?:\.[0-9]+)*)(.*)$/m.exec(r.stdout || '');
  if (!m) {
    return {
      state: 'unread',
      value: null,
      tuple: null,
      reason: `${bin} answered without a version line: ${(r.stdout || '').slice(0, 120)}`,
    };
  }
  return {
    state: 'measured',
    value: m[1],
    tuple: m[1].split('.').map(Number),
    label: `Blender ${m[1]}${m[2] ? m[2] : ''}`.trim(),
    readFrom: bin,
    reason: 'read from the running binary’s own --version',
  };
}

function parseProbe(stdout) {
  const open = stdout.indexOf('<<<E5_PROBE');
  const close = stdout.indexOf('E5_PROBE>>>');
  if (open === -1 || close === -1) return null;
  const body = stdout.slice(stdout.indexOf('\n', open) + 1, close);
  try { return JSON.parse(body); } catch { return null; }
}

/** Two addresses are the same place. `localhost` and `127.0.0.1` are, and a
 *  trailing slash never was a difference. */
function normalise(addr) {
  if (!addr) return null;
  const withScheme = /:\/\//.test(addr) ? addr : `http://${addr}`;
  let u;
  try { u = new URL(withScheme); } catch { return null; }
  const host = u.hostname === 'localhost' ? '127.0.0.1' : u.hostname;
  const port = u.port || (u.protocol === 'https:' ? '443' : '80');
  return `${host}:${port}`;
}

/**
 * ⚑ WHETHER A BRIDGE IS POINTED AT THE GATE — a comparison, made here, between
 * two things this process did not invent: an address a bridge keeps in its own
 * preferences (read out of the running Blender) and the address the gate is
 * actually listening on (the gate binds port 0 and reports back, so nobody can
 * guess it, including us).
 *
 * FIVE ANSWERS, and the last two are the ones a two-valued version would lose:
 *   at-the-gate  a bridge's address IS the gate's
 *   elsewhere    a bridge is configured and it points somewhere else
 *   none         no enabled addon keeps an address at all
 *   unknown      there is no gate running, so nothing to compare against
 *   unread       Blender could not be asked
 */
function bridgeState(probe, session) {
  const gateUrl = session && session.gateUrl ? session.gateUrl : null;
  const gate = normalise(gateUrl);
  const found = [];
  for (const b of (probe.bridges || [])) {
    if (!b.addresses) continue;
    for (const a of b.addresses) {
      // A bridge that keeps its host and its port in two properties is one
      // address, not a hostname with no port.
      const hasPort = /:\d+(\/|$)/.test(a.value);
      const port = (b.ports || [])[0];
      const value = !hasPort && port ? `${a.value.replace(/\/+$/, '')}:${port.value}` : a.value;
      found.push({ module: b.module, prop: a.prop, address: value, normalised: normalise(value) });
    }
  }
  if (found.length === 0) {
    return {
      state: 'none',
      address: null,
      gateUrl,
      candidates: [],
      reason: 'no enabled Blender addon keeps a ComfyUI address in its preferences, so nothing on this machine is pointed anywhere',
    };
  }
  if (!gate) {
    return {
      state: 'unknown',
      address: found[0].address,
      gateUrl: null,
      candidates: found,
      reason: `${found.length} bridge address(es) configured, and no gate is running in this app to compare them against`,
    };
  }
  const hit = found.find((f) => f.normalised && f.normalised === gate);
  if (hit) {
    return {
      state: 'at-the-gate',
      address: hit.address,
      module: hit.module,
      gateUrl,
      candidates: found,
      reason: `${hit.module}.${hit.prop} is the address the gate is listening on`,
    };
  }
  return {
    state: 'elsewhere',
    address: found[0].address,
    module: found[0].module,
    gateUrl,
    candidates: found,
    reason: `configured, but not at ${gateUrl} — a generation sent there does not pass the gate and gets no leaf`,
  };
}

function versionOf(bin) {
  if (!versionCache.has(bin)) versionCache.set(bin, readVersion(bin));
  return versionCache.get(bin);
}

async function measure() {
  const binary = resolveBinary();
  const at = new Date().toISOString();
  if (!binary.exists) {
    // The one shape in which there is nothing to measure. Note what this is
    // NOT: it is not `ok: false`. The reading succeeded and its answer is that
    // this machine has no Blender where this app looks.
    return {
      ok: true,
      state: 'absent',
      binary,
      version: { state: 'unread', value: null, reason: binary.reason },
      addon: { state: 'unread', module: null, enabled: null, reason: binary.reason },
      bridge: { state: 'unread', address: null, gateUrl: null, reason: binary.reason },
      profileDir: process.env.SCRUPLE_BLENDER_PROFILE || null,
      at,
    };
  }

  const session = comfySession();
  const gateUrl = session && session.gateUrl ? session.gateUrl : null;
  const key = `${binary.path}|${process.env.SCRUPLE_BLENDER_PROFILE || ''}|${gateUrl || 'no-gate'}`;
  if (probeCache.key !== key) {
    probeCache = {
      key,
      promise: fs.existsSync(PROBE)
        ? run(binary.path, ['--background', '--python', PROBE], { timeoutMs: TIMEOUT_MS })
        : Promise.resolve({ ok: false, reason: `the probe script is missing: ${PROBE}` }),
    };
  }
  const [version, probeRun] = await Promise.all([versionOf(binary.path), probeCache.promise]);
  const probe = probeRun.ok ? parseProbe(probeRun.stdout || '') : null;

  let addon;
  let bridge;
  if (!probe || probe.error) {
    const reason = probe && probe.error
      ? `the probe reported ${probe.error}`
      : (probeRun.reason || 'Blender answered but printed no probe document');
    addon = { state: 'unread', module: null, enabled: null, reason };
    bridge = { state: 'unread', address: null, gateUrl: null, reason };
  } else {
    addon = {
      state: 'measured',
      module: probe.addon_module,
      enabled: !!probe.addon_enabled,
      viaManifest: !!probe.addon_via_manifest,
      panels: (probe.addon_panels || []).length,
      operators: probe.addon_operators || [],
      reason: probe.addon_enabled
        ? `enabled in ${probe.user_resources_config}, loaded ${probe.addon_via_manifest ? 'through blender_manifest.toml' : 'as a legacy bl_info addon'}`
        : `the Blender at ${binary.path} has ${(probe.enabled_addons || []).length} addon(s) enabled and none of them is Scruple’s`,
    };
    bridge = bridgeState(probe, session);
  }

  return {
    ok: true,
    state: 'measured',
    binary,
    version,
    addon,
    bridge,
    profileDir: process.env.SCRUPLE_BLENDER_PROFILE || null,
    blenderUserResources: probe ? probe.user_resources_config : null,
    enabledAddons: probe ? probe.enabled_addons : null,
    at,
  };
}

/** The caching is inside `measure()`, keyed on what the reading depends on. */
function measureOnce() {
  return measure();
}

function shutdownBlender() {
  for (const c of children) {
    try { c.kill('SIGKILL'); } catch { /* already gone */ }
  }
  children.clear();
}

function registerBlenderIpc() {
  ipcMain.handle('scruple:blender', async (event) => {
    const sender = BrowserWindow.fromWebContents(event.sender);
    const m = await measureOnce();
    return {
      ...m,
      host: 'electron',
      // The same evidence every other handler carries: a renderer-side stub
      // cannot know either of these, so an assertion that finds them knows the
      // reply came from this process and not from the page.
      serverNonce: SERVER_NONCE,
      mainPid: process.pid,
      senderWindowId: sender ? sender.id : null,
    };
  });
}

module.exports = { registerBlenderIpc, installedAppIds, shutdownBlender, resolveBinary };
