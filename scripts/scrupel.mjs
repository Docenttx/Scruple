#!/usr/bin/env node
// scrupel — Scruple Web test/dev CLI.
//
// Authenticates against a running scruple-web instance via the
// dev-only /api/dev/session route (gated on NODE_ENV=development +
// SCRUPLE_DEV_AUTH=1 + a shared secret). Then exposes a small
// command set that mirrors what a real user does:
//
//   scrupel login [email]
//   scrupel whoami
//   scrupel projects                 — list projects
//   scrupel project new <name>       — create txt2img project
//   scrupel project view <id>        — show one project + iters
//   scrupel project activate <id>    — start tracking
//   scrupel project deactivate
//   scrupel iters <projectId>        — list iterations
//   scrupel generate <projectId> "<prompt>" [--workflow=<id>]
//   scrupel lock <kind> <projectId>  — kind = local|checkpoint|chain
//   scrupel health                   — call /api/health
//   scrupel rvn                      — RVN wallet snapshot
//   scrupel tsd                      — TSD balance
//   scrupel verify <manifestFile>    — POST /api/verify
//   scrupel raw <method> <path> [json]
//
// Cookie persisted to ~/.scruple-test-cookie. Override base URL via
// SCRUPEL_BASE (defaults to http://127.0.0.1:3001).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const BASE = process.env.SCRUPEL_BASE || 'http://127.0.0.1:3001';
const COOKIE_FILE = path.join(os.homedir(), '.scruple-test-cookie');
const DEV_SECRET = process.env.SCRUPLE_DEV_AUTH_SECRET || '';

const COMMANDS = {
  login,
  whoami,
  projects: listProjects,
  project: projectCmd,
  iters: listIters,
  generate,
  lock,
  health,
  rvn,
  tsd,
  verify,
  raw,
  help: showHelp,
};

async function main() {
  const [, , cmd, ...args] = process.argv;
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') return showHelp();
  const fn = COMMANDS[cmd];
  if (!fn) {
    console.error(`Unknown command: ${cmd}\n`);
    showHelp();
    process.exit(2);
  }
  try {
    await fn(args);
  } catch (e) {
    console.error(red('error: ') + (e?.message ?? String(e)));
    if (process.env.SCRUPEL_DEBUG) console.error(e);
    process.exit(1);
  }
}

function showHelp() {
  console.log(`scrupel — Scruple Web test CLI

Commands:
  login [email]                  Authenticate as a dev user. Default test@scruple.dev.
  whoami                         Show the current logged-in user.

  projects                       List projects.
  project new <name>             Create a txt2img project.
  project view <id>              Show project + iterations.
  project activate <id>          Set the project as actively tracked.
  project deactivate             Stop tracking.

  iters <projectId>              List iterations for a project.
  generate <projectId> "<prompt>" [--workflow=<id>]
                                 Fire a generation through /api/generate.
  lock <kind> <projectId>        kind = local | checkpoint | chain.

  health                         Aggregate health endpoint.
  rvn [--network=mainnet|testnet]  RVN wallet snapshot.
  tsd                            TSD balance.

  verify <manifestFile>          POST /api/verify with a manifest JSON file.

  raw <method> <path> [bodyJson] Raw HTTP call to any route.

Env:
  SCRUPEL_BASE                   Base URL (default http://127.0.0.1:3001)
  SCRUPLE_DEV_AUTH_SECRET        Required for 'login' — matches scruple-web's env.
  SCRUPEL_DEBUG=1                Verbose error output.
`);
}

// ── Auth ───────────────────────────────────────────────────────────────────

async function login([emailArg]) {
  if (!DEV_SECRET) {
    fail('SCRUPLE_DEV_AUTH_SECRET not set. Add it to your shell env or .env.local.');
  }
  const email = emailArg || 'test@scruple.dev';
  const url = new URL('/api/dev/session', BASE);
  url.searchParams.set('email', email);
  url.searchParams.set('secret', DEV_SECRET);
  const res = await fetch(url, { redirect: 'manual' });
  if (!res.ok) {
    fail(`Login failed: HTTP ${res.status}. Make sure NODE_ENV=development and SCRUPLE_DEV_AUTH=1 on the server.`);
  }
  const setCookie = res.headers.get('set-cookie');
  if (!setCookie) fail('No Set-Cookie header in response');
  const cookieValue = setCookie.split(';')[0]; // "name=value"
  fs.writeFileSync(COOKIE_FILE, cookieValue, { mode: 0o600 });
  const body = await res.json();
  console.log(green('✓ logged in as ') + body.email + grey(` (user ${body.userId})`));
}

async function whoami() {
  const data = await api('GET', '/api/health'); // tickets through auth as a side-effect
  void data;
  // We can't trivially get the user info via existing endpoints — print the cookie status
  if (!fs.existsSync(COOKIE_FILE)) {
    console.log(grey('not logged in'));
    return;
  }
  const c = fs.readFileSync(COOKIE_FILE, 'utf8');
  console.log(green('cookie present: ') + c.slice(0, 30) + '…');
}

// ── Projects ───────────────────────────────────────────────────────────────

async function listProjects() {
  const data = await api('GET', '/api/projects');
  const rows = data.projects ?? data;
  if (!Array.isArray(rows)) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  if (rows.length === 0) {
    console.log(grey('(no projects)'));
    return;
  }
  for (const p of rows) {
    console.log(`  ${p.is_active ? green('●') : grey('○')} ${pad(String(p.id), 4)} ${pad(p.name, 32)} ${grey(p.status)} ${grey(`${p.iteration_count} iter`)}`);
  }
}

async function projectCmd([sub, ...rest]) {
  if (sub === 'new') {
    // `type` must be one of the route's enum: image | video | training | cad
    // (app/api/projects/route.ts CreateBody). This read 'txt2img' — a
    // vocabulary that no longer exists — so every `project new` 400'd on
    // "Invalid body" while looking like a CLI-side argument problem.
    const type = (rest[0] === '--type' && rest[1]) ? rest.splice(0, 2)[1] : 'image';
    const name = rest.join(' ');
    if (!name) fail('Usage: scrupel project new [--type image|video|training|cad] "<name>"');
    const data = await api('POST', '/api/projects', { name, type });
    console.log(green('✓ created ') + data.project?.id + grey(` (${data.project?.name})`));
  } else if (sub === 'view') {
    const id = rest[0];
    const proj = await api('GET', `/api/projects/${id}`);
    console.log(JSON.stringify(proj, null, 2));
  } else if (sub === 'activate') {
    const id = rest[0];
    await api('POST', `/api/projects/${id}/activate`);
    console.log(green('✓ tracking ') + id);
  } else if (sub === 'deactivate') {
    await api('POST', `/api/projects/deactivate`);
    console.log(green('✓ stopped tracking'));
  } else {
    fail('Usage: scrupel project new [--type <t>] <name> | view <id> | activate <id> | deactivate');
  }
}

async function listIters([projectId]) {
  if (!projectId) fail('Usage: scrupel iters <projectId>');
  const data = await api('GET', `/api/projects/${projectId}/iterations`);
  const rows = data.iterations ?? data;
  if (!Array.isArray(rows) || rows.length === 0) {
    console.log(grey('(no iterations)'));
    return;
  }
  for (const it of rows) {
    console.log(`  ${pad(`#${it.run_sequence}`, 6)} ${grey(it.leaf_hash?.slice(0, 14) ?? '?')} ${grey(it.created_at ?? '')}`);
  }
}

async function generate(args) {
  const projectId = args[0];
  const prompt = args[1];
  if (!projectId || !prompt) fail('Usage: scrupel generate <projectId> "<prompt>" [--workflow=<id>]');
  const workflow = args.find(a => a.startsWith('--workflow='))?.split('=')[1];
  const body = { projectId: Number(projectId), prompt };
  if (workflow) body.workflow = workflow;
  const data = await api('POST', '/api/generate', body);
  console.log(JSON.stringify(data, null, 2));
}

async function lock([kind, projectId]) {
  if (!kind || !projectId) fail('Usage: scrupel lock <kind> <projectId>');
  const data = await api('POST', `/api/lock/${kind}`, { projectId: Number(projectId) });
  console.log(JSON.stringify(data, null, 2));
}

async function health() {
  const data = await api('GET', '/api/health');
  for (const k of ['witness', 'rvn', 'stripe']) {
    const s = data[k];
    if (!s) continue;
    const dot = s.ok === true ? green('●') : s.ok === false ? red('●') : grey('●');
    console.log(`  ${dot} ${pad(s.label, 10)} ${s.detail ? grey(s.detail) : ''}`);
  }
  console.log(grey(`  checked ${data.checkedAt}`));
}

async function rvn(args) {
  const network = args.find(a => a.startsWith('--network='))?.split('=')[1] || 'mainnet';
  const data = await api('GET', `/api/wallet/rvn?network=${network}`);
  console.log(JSON.stringify(data, null, 2));
}

async function tsd() {
  const data = await api('GET', '/api/wallet/tsd');
  console.log(JSON.stringify(data, null, 2));
}

async function verify([file]) {
  if (!file) fail('Usage: scrupel verify <manifestFile>');
  const body = JSON.parse(fs.readFileSync(file, 'utf8'));
  const data = await api('POST', '/api/verify', body);
  console.log(JSON.stringify(data, null, 2));
}

async function raw([method, p, bodyJson]) {
  if (!method || !p) fail('Usage: scrupel raw <method> <path> [bodyJson]');
  const body = bodyJson ? JSON.parse(bodyJson) : undefined;
  const data = await api(method.toUpperCase(), p, body);
  console.log(JSON.stringify(data, null, 2));
}

// ── HTTP helpers ───────────────────────────────────────────────────────────

async function api(method, p, body) {
  const url = p.startsWith('http') ? p : `${BASE}${p}`;
  const headers = { 'Content-Type': 'application/json' };
  if (fs.existsSync(COOKIE_FILE)) {
    headers.Cookie = fs.readFileSync(COOKIE_FILE, 'utf8');
  }
  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} — ${json.error ?? json.detail ?? text.slice(0, 200)}`);
    err.body = json;
    throw err;
  }
  return json;
}

// ── tiny terminal helpers ──────────────────────────────────────────────────

function green(s) { return `\x1b[32m${s}\x1b[0m`; }
function red(s) { return `\x1b[31m${s}\x1b[0m`; }
function grey(s) { return `\x1b[90m${s}\x1b[0m`; }
function pad(s, n) { return String(s).padEnd(n, ' '); }

function fail(msg) {
  console.error(red('error: ') + msg);
  process.exit(2);
}

main();
