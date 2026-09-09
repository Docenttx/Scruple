#!/usr/bin/env node
/**
 * d1-ipc-ping.mjs — WO-D1's gate.
 *
 * Launches the real Electron app under xvfb, against the served app, and checks
 * a scripted ping round-tripped main<->renderer. It asserts on the report the
 * app left on disk and on the process's exit code — never on log lines, and
 * never on pixels (docs/DESIGN.md: screenshots come back blank under llvmpipe).
 *
 *   node scripts/d1-ipc-ping.mjs                 # gate: must pass
 *   node scripts/d1-ipc-ping.mjs --url http://127.0.0.1:1     # control: must fail
 *   node scripts/d1-ipc-ping.mjs --app-dir <copy-without-preload>  # control: must fail
 *
 * --expect-fail inverts the verdict, so a control can be run in CI as itself.
 */

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
}
const expectFail = process.argv.includes('--expect-fail');
const appURL = arg('--url', process.env.SCRUPLE_APP_URL || 'http://127.0.0.1:3902');
const appDir = resolve(arg('--app-dir', REPO));
const timeoutMs = Number(arg('--timeout', '120000'));
const label = arg('--label', 'gate');

const clientNonce = randomBytes(12).toString('hex');
const runDir = join(REPO, '.run', 'd1');
mkdirSync(runDir, { recursive: true });
const reportPath = join(runDir, `report-${label}-${Date.now()}.json`);
rmSync(reportPath, { force: true });

const electron = join(REPO, 'node_modules', '.bin', 'electron');

console.log(`── WO-D1 ${label} ──`);
console.log(`   app dir : ${appDir}`);
console.log(`   app url : ${appURL}`);
console.log(`   nonce   : ${clientNonce}   (minted here, not by the app)`);

const child = spawn(
  'xvfb-run',
  ['-a', '-s', '-screen 0 1280x900x24', electron, appDir, '--probe=ping'],
  {
    cwd: appDir,
    env: {
      ...process.env,
      SCRUPLE_APP_URL: appURL,
      SCRUPLE_D1_REPORT: reportPath,
      SCRUPLE_D1_CLIENT_NONCE: clientNonce,
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  }
);

let out = '';
child.stdout.on('data', (d) => { out += d; process.stdout.write(`   | ${d}`); });
child.stderr.on('data', (d) => { out += d; });

let timedOut = false;
const killer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);

const exitCode = await new Promise((res) => {
  child.on('close', (code, signal) => { clearTimeout(killer); res(signal ? `signal:${signal}` : code); });
});

// ── verdict, from side effects only ────────────────────────────────────────
const failures = [];
const assert = (id, cond, detail) => {
  if (!cond) failures.push(`${id}${detail === undefined ? '' : `  (${JSON.stringify(detail)})`}`);
  console.log(`   ${cond ? 'PASS' : 'FAIL'}  ${id}`);
};

assert('process-did-not-hang', !timedOut, { timeoutMs });
assert('exit-code-0', exitCode === 0, { exitCode });
assert('report-written', existsSync(reportPath), reportPath);

let report = null;
if (existsSync(reportPath)) {
  report = JSON.parse(readFileSync(reportPath, 'utf8'));
  assert('report-ok', report.ok === true);
  assert('every-app-check-passed', report.checks.every((c) => c.pass),
    report.checks.filter((c) => !c.pass).map((c) => c.id));
  // Checked here, against a nonce this script minted: the value travelled
  // harness -> renderer -> main -> renderer -> report.
  assert('our-nonce-round-tripped', report.ping && report.ping.echo === clientNonce,
    report.ping && report.ping.echo);
  assert('page-came-from-app-url', report.renderer && report.renderer.origin === new URL(appURL).origin,
    report.renderer && report.renderer.origin);
  assert('http-status-200', report.navigation && report.navigation.httpResponseCode === 200,
    report.navigation);
}

const passed = failures.length === 0;
console.log('');
if (report && report.ping && report.ping.versions) {
  const v = report.ping.versions;
  console.log(`   observed via IPC : electron ${v.electron} · chromium ${v.chrome} · node ${v.node} · v8 ${v.v8}`);
  console.log(`   renderer UA      : ${report.renderer.userAgent}`);
  console.log(`   page             : ${report.renderer.href}  (${report.renderer.bodyChars} chars, title ${JSON.stringify(report.renderer.title)})`);
  console.log(`   main pid         : ${report.ping.mainPid}`);
}
console.log(`   report           : ${reportPath}`);
console.log(`   verdict          : ${passed ? 'PASS' : 'FAIL'}${failures.length ? ` — ${failures.join('; ')}` : ''}`);

if (expectFail) {
  console.log(`   expected         : FAIL (control)`);
  console.log(passed ? '── CONTROL DID NOT FIRE — this is a problem ──' : '── control fired as required ──');
  process.exit(passed ? 1 : 0);
}
process.exit(passed ? 0 : 1);
