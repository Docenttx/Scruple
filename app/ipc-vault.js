/**
 * ipc-vault.js — `scruple:vault-capture`, the vault seam.
 *
 * The renderer names a DIRECTORY. Everything else comes from configuration.
 *
 * WHAT THE RENDERER MAY CHOOSE, AND WHAT IT MAY NOT
 * -----------------------------------------------------------------
 * A page may say "lock this vault", because picking a folder is what a user
 * does. A page may NOT choose:
 *
 *   the ceiling      — a renderer that could raise the ceiling could make an
 *                      over-ceiling refusal disappear, which is precisely the
 *                      fact WO-D3 requires to be recorded.
 *   the store        — a renderer that could name the destination could write
 *                      anywhere this app can (the same rule ipc-capture.js
 *                      already applies to SCRUPLE_RUN_STORE).
 *   the API key, the baseline, the state directory, the provisioning token.
 *
 * All of those are read from the environment here, in the main process, and
 * are never accepted from the invoke payload even if one is present.
 *
 * WHY THE WORK HAPPENS IN A CHILD PROCESS
 * -----------------------------------------------------------------
 * app/vault/run.ts's header has the argument. In one line: the SDK is the
 * server repo's TypeScript and the IK is a sealed key, and neither belongs in
 * the process that also runs a BrowserWindow.
 *
 * This handler is therefore a LAUNCHER and a REPORTER. It does not hash, does
 * not decide a MIME, does not talk to the witness. It returns what the sidecar
 * wrote, plus the pid of THIS process — which is what lets the driver's
 * `reached-main` assertion tell a real reply from a renderer-side liar.
 */

'use strict';

const { ipcMain, BrowserWindow } = require('electron');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

/** How long a vault run may take before the main process stops waiting. */
const RUN_TIMEOUT_MS = Number(process.env.SCRUPLE_VAULT_TIMEOUT_MS || 180000);

function repoRoot() {
  // Set by scripts/desktop-run.mjs when a mutation runs the app out of a COPY
  // of app/. Without it a copied app would find no scripts/ and no vendor/,
  // and `fake-bridge` would fail for a reason that has nothing to do with the
  // preload it is meant to be testing.
  return process.env.SCRUPLE_DESKTOP_ROOT || path.join(__dirname, '..');
}

function registerVaultIpc() {
  ipcMain.handle('scruple:vault-capture', async (event, req) => {
    const at = new Date().toISOString();
    const sender = BrowserWindow.fromWebContents(event.sender);
    const base = { ok: false, at, mainPid: process.pid, senderWindowId: sender ? sender.id : null };
    const refuse = (reason, extra) => ({ ...base, outcome: 'refused', reason, ...(extra || {}) });

    if (!req || typeof req.vaultDir !== 'string' || req.vaultDir === '') {
      return refuse('no vaultDir given');
    }

    const cfg = {
      appUrl: process.env.SCRUPLE_APP_URL || 'http://127.0.0.1:3902',
      apiKey: process.env.SCRUPLE_VAULT_API_KEY,
      baselineRef: process.env.SCRUPLE_VAULT_BASELINE_REF,
      stateDir: process.env.SCRUPLE_VAULT_STATE,
      storeDir: process.env.SCRUPLE_RUN_STORE,
      token: process.env.SCRUPLE_VAULT_PROVISIONING_TOKEN || null,
      ceiling: process.env.SCRUPLE_VAULT_CEILING_BYTES
        ? Number(process.env.SCRUPLE_VAULT_CEILING_BYTES)
        : undefined,
    };
    for (const [k, envName] of [
      ['apiKey', 'SCRUPLE_VAULT_API_KEY'],
      ['baselineRef', 'SCRUPLE_VAULT_BASELINE_REF'],
      ['stateDir', 'SCRUPLE_VAULT_STATE'],
      ['storeDir', 'SCRUPLE_RUN_STORE'],
    ]) {
      if (!cfg[k]) return refuse(`${envName} is not set`);
    }

    const root = repoRoot();
    const runner = path.join(root, 'scripts', 'tsx.sh');
    const entry = path.join(root, 'app', 'vault', 'run.ts');
    if (!fs.existsSync(runner) || !fs.existsSync(entry)) {
      return refuse(`vault sidecar not found under ${root}`);
    }

    const vaultId = typeof req.vaultId === 'string' && req.vaultId ? req.vaultId : `vault-${crypto.randomBytes(6).toString('hex')}`;
    const work = path.join(cfg.stateDir, vaultId);
    fs.mkdirSync(work, { recursive: true, mode: 0o700 });
    const requestPath = path.join(work, 'request.json');
    const resultPath = path.join(work, 'result.json');
    fs.writeFileSync(
      requestPath,
      JSON.stringify(
        {
          vaultDir: path.resolve(req.vaultDir),
          vaultId,
          ...(cfg.ceiling ? { ceilingBytes: cfg.ceiling } : {}),
          stateDir: work,
          storeDir: cfg.storeDir,
          appUrl: cfg.appUrl,
          apiKey: cfg.apiKey,
          baselineRef: cfg.baselineRef,
          provisioningToken: cfg.token,
          resultPath,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );

    const child = spawn('bash', [runner, entry, requestPath], {
      cwd: root,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; process.stdout.write(`   |vault| ${d}`); });
    child.stderr.on('data', (d) => { out += d; process.stdout.write(`   |vault!| ${d}`); });

    let timedOut = false;
    const killer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, RUN_TIMEOUT_MS);
    const exitCode = await new Promise((res) => {
      child.on('close', (code, signal) => { clearTimeout(killer); res(signal ? `signal:${signal}` : code); });
      child.on('error', (err) => { clearTimeout(killer); res(`spawn-error:${err.code || err.message}`); });
    });
    fs.writeFileSync(path.join(work, 'sidecar.log'), out);

    if (!fs.existsSync(resultPath)) {
      return refuse('the sidecar wrote no result', { exitCode, timedOut, sidecarLog: path.join(work, 'sidecar.log') });
    }
    const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));

    return {
      ...base,
      // The sidecar's own verdict, relayed. This handler does not second-guess
      // it and does not grade it: the driver re-hashes the bytes and reads the
      // witness, in another process, and that is what decides.
      ok: result.ok === true && exitCode === 0,
      outcome: result.ok === true ? 'vaulted' : 'refused',
      reason: result.error,
      exitCode,
      timedOut,
      vaultId,
      vaultDir: result.vaultDir,
      requestPath,
      resultPath,
      sidecarLog: path.join(work, 'sidecar.log'),
      sidecarPid: result.sidecarPid,
      componentId: result.componentId,
      buildMeasurement: result.buildMeasurement,
      assurance: result.assurance,
      manifest: result.manifest,
      counts: result.counts,
      entries: result.entries,
      emitted: result.emitted,
      queueDepth: result.queueDepth,
    };
  });
}

module.exports = { registerVaultIpc };
