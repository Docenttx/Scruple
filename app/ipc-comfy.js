/**
 * ipc-comfy.js — `scruple:comfy-launch`, `scruple:comfy-generate`,
 * `scruple:comfy-stop`.
 *
 * docs/DESIGN.md's first bullet, made real: the app "launches ComfyUI, Kohya
 * and (later) Blender, so it knows the binary, the version and the model
 * directory". A gate deployed beside somebody else's ComfyUI knows none of
 * those things — it knows a URL. Launching is what turns configuration into
 * measurement, and it is why the fingerprints can exist at all.
 *
 * THE SHAPE, and the order matters
 * ---------------------------------------------------------------------------
 *   1. bind nothing, ALLOCATE. The gate takes port 0 and reports what the
 *      kernel gave it; ComfyUI needs a number in argv, so one is taken and
 *      released. The ledger below is what settles who actually ended up
 *      holding each.
 *   2. ComfyUI first, on LOOPBACK, under a base directory this app owns —
 *      never the reference checkout, which stays read-only. `--base-directory`
 *      moves models, input, output, temp, user and custom_nodes in one flag,
 *      so there is no configured path that can disagree with another.
 *   3. the gate second, upstream = ComfyUI. It fails loudly and separately.
 *   4. the LEDGER, read from /proc — see app/comfy/ports.js for why it
 *      enumerates rather than probes.
 *
 * WHAT THE RENDERER MAY CHOOSE. A workflow. That is the entire list. The
 * python binary, the ComfyUI checkout, the base directory, the model root, the
 * ports, the API key, the baseline, the state directory, the provisioning
 * token and the artifact store all come from the environment, in this process
 * — the same rule ipc-vault.js applies, for the same reason: a page that could
 * name the model root could point the fingerprinter at a directory it had
 * filled itself.
 *
 * ⚑ TWO CHANNELS, AND THEY ARE NOT THE SAME CHANNEL. The app talks to ComfyUI
 * DIRECTLY to measure it — version, argv, readiness — because the app started
 * it and is entitled to. Every artifact-bearing request goes through the GATE.
 * Mixing those would make the leaf's coverage depend on which URL a caller
 * happened to hold, which is precisely what the ledger exists to rule out.
 */

'use strict';

const { ipcMain, BrowserWindow } = require('electron');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const { portLedger } = require('./comfy/ports');

const LAUNCH_TIMEOUT_MS = Number(process.env.SCRUPLE_COMFY_LAUNCH_TIMEOUT_MS || 240000);
const GENERATE_TIMEOUT_MS = Number(process.env.SCRUPLE_COMFY_GENERATE_TIMEOUT_MS || 180000);

function repoRoot() {
  return process.env.SCRUPLE_DESKTOP_ROOT || path.join(__dirname, '..');
}

/** A port the kernel says is free, released immediately. The ledger is what
 *  establishes who ended up with it — this only avoids a hard-coded guess. */
function allocatePort(host) {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, host, () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

async function waitFor(fn, timeoutMs, everyMs = 500) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

/** The live session. One at a time: two ComfyUIs under one base directory
 *  would write into the same output volume and the watcher could not say
 *  which run a file belonged to. */
let session = null;

function killSession() {
  if (!session) return;
  for (const p of [session.gate, session.comfy]) {
    if (p && p.exitCode === null && !p.killed) { try { p.kill('SIGKILL'); } catch { /* gone */ } }
  }
  session = null;
}

function registerComfyIpc() {
  ipcMain.handle('scruple:comfy-launch', async (event) => {
    const at = new Date().toISOString();
    const sender = BrowserWindow.fromWebContents(event.sender);
    const base = { ok: false, at, mainPid: process.pid, senderWindowId: sender ? sender.id : null };
    const refuse = (reason, extra) => ({ ...base, outcome: 'refused', reason, ...(extra || {}) });

    if (session) return refuse('a ComfyUI session is already running');

    const cfg = {
      python: process.env.SCRUPLE_COMFY_PYTHON || 'python3',
      comfyMain: process.env.SCRUPLE_COMFY_MAIN,
      baseDir: process.env.SCRUPLE_COMFY_BASE,
      // 127.0.0.1 unless something deliberately widened it. The mutation that
      // widens it is how we know the ledger's loopback reading is a
      // measurement and not a constant.
      listen: process.env.SCRUPLE_COMFY_LISTEN || '127.0.0.1',
      apiKey: process.env.SCRUPLE_COMFY_API_KEY,
      baselineRef: process.env.SCRUPLE_COMFY_BASELINE_REF,
      stateDir: process.env.SCRUPLE_COMFY_STATE,
      storeDir: process.env.SCRUPLE_RUN_STORE,
      token: process.env.SCRUPLE_COMFY_PROVISIONING_TOKEN || null,
      appUrl: process.env.SCRUPLE_APP_URL || 'http://127.0.0.1:3902',
      fingerprints: (process.env.SCRUPLE_COMFY_FINGERPRINTS || 'on') !== 'off',
      // WO-D6. WHERE A HOST DECLARES ITSELF. Configuration, from the
      // environment, for the reason the model root is: a page that could name
      // this directory could drop its own `scruple-host.json` in it and have
      // the leaf carry any meaning it liked. Unset is LEVEL 1 and is not an
      // error — Level 1 is the integration that costs a host nothing.
      hostDir:
        (process.env.SCRUPLE_COMFY_HOST_ADAPTER || 'on') === 'off'
          ? null
          : process.env.SCRUPLE_COMFY_HOST_DIR || null,
      modelCeiling: process.env.SCRUPLE_COMFY_MODEL_CEILING_BYTES
        ? Number(process.env.SCRUPLE_COMFY_MODEL_CEILING_BYTES)
        : undefined,
    };
    for (const [k, envName] of [
      ['comfyMain', 'SCRUPLE_COMFY_MAIN'],
      ['baseDir', 'SCRUPLE_COMFY_BASE'],
      ['apiKey', 'SCRUPLE_COMFY_API_KEY'],
      ['baselineRef', 'SCRUPLE_COMFY_BASELINE_REF'],
      ['stateDir', 'SCRUPLE_COMFY_STATE'],
      ['storeDir', 'SCRUPLE_RUN_STORE'],
    ]) {
      if (!cfg[k]) return refuse(`${envName} is not set`);
    }
    if (!fs.existsSync(cfg.comfyMain)) return refuse(`no ComfyUI entry point at ${cfg.comfyMain}`);

    const modelRoot = path.join(cfg.baseDir, 'models');
    for (const d of ['models', 'input', 'output', 'temp', 'user', 'custom_nodes']) {
      fs.mkdirSync(path.join(cfg.baseDir, d), { recursive: true });
    }
    fs.mkdirSync(cfg.stateDir, { recursive: true, mode: 0o700 });

    const upstreamPort = await allocatePort('127.0.0.1');
    const upstreamUrl = `http://127.0.0.1:${upstreamPort}`;
    const logDir = path.join(cfg.stateDir, 'logs');
    fs.mkdirSync(logDir, { recursive: true });

    // ── 1. ComfyUI ─────────────────────────────────────────────────────
    const comfyArgs = [
      cfg.comfyMain, '--cpu', '--listen', cfg.listen, '--port', String(upstreamPort),
      '--base-directory', cfg.baseDir, '--disable-auto-launch',
    ];
    const comfyLog = fs.openSync(path.join(logDir, 'comfyui.log'), 'a');
    const comfy = spawn(cfg.python, comfyArgs, {
      cwd: path.dirname(cfg.comfyMain),
      stdio: ['ignore', comfyLog, comfyLog],
    });
    session = { comfy, gate: null };

    // Measured on the app's own channel, straight to the process it started.
    const stats = await waitFor(async () => {
      if (comfy.exitCode !== null) throw new Error(`comfyui exited ${comfy.exitCode}`);
      const r = await fetch(`${upstreamUrl}/system_stats`, { signal: AbortSignal.timeout(3000) });
      return r.ok ? r.json() : null;
    }, LAUNCH_TIMEOUT_MS);
    if (!stats) {
      killSession();
      return refuse('ComfyUI did not answer /system_stats', {
        comfyLog: path.join(logDir, 'comfyui.log'), comfyExit: comfy.exitCode,
      });
    }

    // ── 2. the gate ────────────────────────────────────────────────────
    const root = repoRoot();
    const runner = path.join(root, 'scripts', 'tsx.sh');
    const entry = path.join(root, 'app', 'comfy', 'gate.ts');
    if (!fs.existsSync(runner) || !fs.existsSync(entry)) {
      killSession();
      return refuse(`gate sidecar not found under ${root}`);
    }
    const gateState = path.join(cfg.stateDir, 'gate');
    fs.mkdirSync(gateState, { recursive: true, mode: 0o700 });
    const readyPath = path.join(gateState, 'ready.json');
    const gateResultPath = path.join(gateState, 'result.json');
    // Asking the gate to drain is a file, not a signal — Windows has none.
    // See the comment on `stopPath` in app/comfy/gate.ts.
    const gateStopPath = path.join(gateState, 'stop');
    for (const p of [readyPath, gateResultPath, gateStopPath]) fs.rmSync(p, { force: true });
    const gateRequestPath = path.join(gateState, 'request.json');
    fs.writeFileSync(
      gateRequestPath,
      JSON.stringify({
        upstreamUrl,
        listenHost: '127.0.0.1',
        // 0: the kernel chooses and the gate reports back. Nothing here
        // guesses a port that something else might already hold.
        listenPort: 0,
        comfyBaseDir: cfg.baseDir,
        modelRoot,
        stateDir: gateState,
        appUrl: cfg.appUrl,
        apiKey: cfg.apiKey,
        baselineRef: cfg.baselineRef,
        provisioningToken: cfg.token,
        readyPath,
        resultPath: gateResultPath,
        stopPath: gateStopPath,
        ...(cfg.modelCeiling ? { modelCeilingBytes: cfg.modelCeiling } : {}),
        fingerprints: cfg.fingerprints,
        hostDir: cfg.hostDir,
      }, null, 2),
      { mode: 0o600 },
    );

    const gate = spawn('bash', [runner, entry, gateRequestPath], {
      cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    session.gate = gate;
    let gateLog = '';
    gate.stdout.on('data', (d) => { gateLog += d; process.stdout.write(`   |gate| ${d}`); });
    gate.stderr.on('data', (d) => { gateLog += d; process.stdout.write(`   |gate!| ${d}`); });
    gate.on('close', () => { fs.writeFileSync(path.join(logDir, 'gate.log'), gateLog); });

    const ready = await waitFor(async () => {
      if (gate.exitCode !== null) throw new Error(`gate exited ${gate.exitCode}`);
      return fs.existsSync(readyPath) ? JSON.parse(fs.readFileSync(readyPath, 'utf8')) : null;
    }, LAUNCH_TIMEOUT_MS, 300);
    if (!ready) {
      fs.writeFileSync(path.join(logDir, 'gate.log'), gateLog);
      killSession();
      return refuse('the gate never reported ready', { gateLog: path.join(logDir, 'gate.log') });
    }

    // ── 3. the ledger ──────────────────────────────────────────────────
    const ledger = portLedger({
      gatePort: ready.listenPort, gatePid: ready.pid,
      upstreamPort, upstreamPid: comfy.pid,
    });

    Object.assign(session, {
      gateUrl: ready.gateUrl, upstreamUrl, modelRoot, baseDir: cfg.baseDir,
      gateResultPath, gateStopPath, logDir, upstreamPort, gatePort: ready.listenPort, gateSidecarPid: ready.pid,
      storeDir: cfg.storeDir,
      // Kept on the session so `scruple:profile` can report what is running
      // WITHOUT asking ComfyUI again. Re-measuring on every dashboard render
      // would put a page in a position to make this process talk to a tenant.
      adapter: ready.adapter,
      hostHook: ready.hostHook || null,
      version: stats.system ? stats.system.comfyui_version : null,
    });

    return {
      ...base,
      ok: true,
      outcome: 'launched',
      // THE BINARY, THE VERSION, THE MODEL DIRECTORY — the three things
      // docs/DESIGN.md says launching is what buys you.
      comfy: {
        python: cfg.python,
        entry: cfg.comfyMain,
        pid: comfy.pid,
        version: stats.system ? stats.system.comfyui_version : null,
        pythonVersion: stats.system ? stats.system.python_version : null,
        torchVersion: stats.system ? stats.system.pytorch_version : null,
        argv: stats.system ? stats.system.argv : null,
        listen: cfg.listen,
        upstreamUrl,
      },
      modelRoot,
      baseDir: cfg.baseDir,
      // What is IN the model store, by name only. The bytes are the
      // fingerprinter's business and deliberately not re-answered here.
      modelFiles: fs.existsSync(path.join(modelRoot, 'upscale_models'))
        ? fs.readdirSync(path.join(modelRoot, 'upscale_models')).sort()
        : [],
      gate: {
        pid: ready.pid,
        url: ready.gateUrl,
        componentId: ready.componentId,
        buildMeasurement: ready.buildMeasurement,
        adapter: ready.adapter,
        // WO-D6. Which LEVEL this deployment came up at, read off the gate's
        // own ready file — including a declaration it refused, which is Level
        // 1 with a reason rather than Level 1 by silence.
        hostHook: ready.hostHook || null,
        assurance: ready.assurance,
        watchedVolumes: ready.watchedVolumes,
      },
      ledger,
      logDir,
    };
  });

  ipcMain.handle('scruple:comfy-generate', async (event, req) => {
    const at = new Date().toISOString();
    const sender = BrowserWindow.fromWebContents(event.sender);
    const base = { ok: false, at, mainPid: process.pid, senderWindowId: sender ? sender.id : null };
    const refuse = (reason, extra) => ({ ...base, outcome: 'refused', reason, ...(extra || {}) });

    if (!session || !session.gateUrl) return refuse('no ComfyUI session; launch first');
    if (!req || typeof req.workflow !== 'object' || req.workflow === null) {
      return refuse('no workflow given');
    }
    // WO-D6. A HOST MAY CHOOSE ITS OWN PROMPT ID, and ComfyUI supports it:
    // server.py does `prompt_id = str(json_data.get("prompt_id", uuid4()))`.
    // That is the correlation a Level-2 host announces against — it writes
    // `announce/<id>.json` before it submits, and the gate's correlator keys
    // outputs to prompts by the same id, so the announcement and the
    // observation meet with no new plumbing.
    //
    // ⚑ AND IT GRANTS NOTHING. The announcement directory is named by THIS
    // process from the environment and is not reachable from a workflow; an
    // id nobody announced reads back as `declined`, and a document that does
    // not satisfy the host's own declared schema reads back as `declined`
    // too. The worst a chosen id can do is make a leaf say less.
    const hostPromptId =
      typeof req.promptId === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(req.promptId)
        ? req.promptId
        : null;

    // THE ONE PLACE THE TENANT PATH IS CHOSEN, and it is chosen from the
    // ENVIRONMENT, never from the payload. `SCRUPLE_COMFY_BYPASS_GATE=1` sends
    // the generation straight at ComfyUI — the control that shows the leaf is
    // caused by the gate being in the path rather than by the generation
    // having happened.
    const bypass = process.env.SCRUPLE_COMFY_BYPASS_GATE === '1';
    const endpoint = bypass ? session.upstreamUrl : session.gateUrl;

    const deadline = Date.now() + GENERATE_TIMEOUT_MS;
    let promptId = null;
    try {
      const r = await fetch(`${endpoint}/prompt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          prompt: req.workflow,
          ...(hostPromptId ? { prompt_id: hostPromptId } : {}),
        }),
        signal: AbortSignal.timeout(30000),
      });
      const body = await r.json();
      if (!r.ok || !body.prompt_id) {
        return refuse(`/prompt refused (${r.status})`, { body, endpoint, viaGate: !bypass });
      }
      promptId = body.prompt_id;
    } catch (e) {
      return refuse(`/prompt failed: ${String(e.message || e)}`, { endpoint, viaGate: !bypass });
    }

    let history = null;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`${endpoint}/history/${promptId}`, { signal: AbortSignal.timeout(10000) });
        const h = await r.json();
        const entry = h[promptId];
        if (entry && entry.status && entry.status.completed) { history = entry; break; }
        if (entry && entry.status && entry.status.status_str === 'error') { history = entry; break; }
      } catch { /* the run is still going, or the gate is buffering */ }
      await new Promise((res) => setTimeout(res, 300));
    }
    if (!history) return refuse('the prompt never completed', { promptId, endpoint });
    if (history.status.status_str !== 'success') {
      return refuse(`ComfyUI reported ${history.status.status_str}`, { promptId, status: history.status });
    }

    // ── the artifacts, fetched BACK THROUGH THE SAME ENDPOINT ──────────
    // A file read off the output volume would be an as-written copy that
    // never crossed the gate, and the leaf under test is the one the gate
    // makes from the bytes the consumer received.
    const images = [];
    for (const [nodeId, out] of Object.entries(history.outputs || {})) {
      for (const img of out.images || []) {
        const q = new URLSearchParams({
          filename: img.filename, subfolder: img.subfolder || '', type: img.type || 'output',
        });
        const r = await fetch(`${endpoint}/view?${q}`, { signal: AbortSignal.timeout(30000) });
        if (!r.ok) {
          images.push({ nodeId, filename: img.filename, status: r.status, sha256: null, bytes: null, storePath: null });
          continue;
        }
        const buf = Buffer.from(await r.arrayBuffer());
        const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
        const storePath = path.join(session.storeDir, sha256.slice(0, 2), sha256);
        fs.mkdirSync(path.dirname(storePath), { recursive: true });
        fs.writeFileSync(storePath, buf);
        images.push({
          nodeId, filename: img.filename, subfolder: img.subfolder || '', type: img.type || 'output',
          status: r.status, sha256, bytes: buf.length, storePath,
          contentType: r.headers.get('content-type'),
        });
      }
    }

    return {
      ...base,
      ok: images.length > 0 && images.every((i) => i.sha256),
      outcome: images.length ? 'generated' : 'no-artifacts',
      promptId,
      // Recorded so an assertion can check that ComfyUI honoured the id the
      // host chose, rather than assuming it did.
      hostChosePromptId: hostPromptId !== null && hostPromptId === promptId,
      endpoint,
      // Recorded, not inferred. A run that bypassed the gate must say so on
      // its own record rather than be diagnosed from a missing leaf.
      viaGate: !bypass,
      gateUrl: session.gateUrl,
      upstreamUrl: session.upstreamUrl,
      images,
      // Re-read after the generation: the point is not that it was true at
      // launch, it is that it was true across the run.
      ledger: portLedger({
        gatePort: session.gatePort, gatePid: session.gateSidecarPid,
        upstreamPort: session.upstreamPort, upstreamPid: session.comfy.pid,
      }),
    };
  });

  ipcMain.handle('scruple:comfy-stop', async (event) => {
    const at = new Date().toISOString();
    const sender = BrowserWindow.fromWebContents(event.sender);
    const base = { ok: false, at, mainPid: process.pid, senderWindowId: sender ? sender.id : null };
    if (!session) return { ...base, outcome: 'refused', reason: 'no session' };

    const { gate, comfy, gateResultPath, gateStopPath } = session;
    // ASK THE GATE TO DRAIN, then let it write the result file. Its handler
    // drains the queue and records every enrichment; killing it outright would
    // lose all of them and anything store-and-forward was still holding.
    //
    // 🔴 THE REQUEST IS A FILE BECAUSE WINDOWS HAS NO SIGNALS. `.kill('SIGTERM')`
    // there is `TerminateProcess` — no handler runs, no result is written, and
    // the records this shutdown exists to preserve are destroyed by it. That
    // was measured on a real run (W1-E3 in docs/FINDINGS-WIN.md), which also
    // spent this function's whole 30s timeout waiting for a file that could
    // never appear.
    //
    // Both are sent where both exist. The gate guards against re-entry, so on
    // POSIX the signal wins the race and that platform's behaviour is
    // unchanged; on Windows the file is the only one that arrives.
    if (gate && gate.exitCode === null) {
      if (gateStopPath) {
        try {
          fs.writeFileSync(gateStopPath, `${new Date().toISOString()}\n`);
        } catch (e) {
          // Fall through to the signal — on POSIX it is sufficient on its own.
          console.error(`[comfy] could not write the gate stop file: ${e.message}`);
        }
      }
      gate.kill('SIGTERM');
    }
    const gateResult = await waitFor(
      async () => (fs.existsSync(gateResultPath) ? JSON.parse(fs.readFileSync(gateResultPath, 'utf8')) : null),
      30000, 200,
    );
    if (comfy && comfy.exitCode === null) comfy.kill('SIGTERM');
    const logDir = session.logDir;
    session = null;

    return {
      ...base,
      ok: gateResult !== null,
      outcome: gateResult ? 'stopped' : 'gate-wrote-no-result',
      gateResult,
      logDir,
    };
  });
}

/**
 * THE SAFETY NET. A scenario that fails at its second step never reaches
 * `comfyStop`, and a ComfyUI spawned by a process that has exited does not
 * exit with it — it keeps a port and 700 MB of torch. An overnight loop that
 * leaks one per failed run stops being an overnight loop. SIGKILL rather than
 * SIGTERM here: by the time this runs the app is going away, nobody is waiting
 * for the gate's result file, and a clean drain that hangs would hold the
 * process open.
 */
function shutdownComfy() {
  killSession();
}

/**
 * A READ-ONLY VIEW of the live session, for `scruple:profile`.
 *
 * Returns null when nothing is running, which is a fact the dashboard renders
 * as "not started" rather than as an empty panel. Deliberately a copy: a caller
 * that could reach into `session` could kill a child process from a render.
 */
function comfySession() {
  if (!session) return null;
  return {
    gateUrl: session.gateUrl || null,
    upstreamUrl: session.upstreamUrl || null,
    modelRoot: session.modelRoot || null,
    adapter: session.adapter || null,
    hostHook: session.hostHook || null,
    version: session.version || null,
    running: !!(session.comfy && session.comfy.exitCode === null),
  };
}

module.exports = { registerComfyIpc, portLedger, shutdownComfy, comfySession };
