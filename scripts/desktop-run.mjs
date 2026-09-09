#!/usr/bin/env node
/**
 * desktop-run.mjs — the headless driver for Scruple Desktop Studio.
 *
 * The desktop mirror of scruple-web/scripts/scruple-run.ts, which "runs a
 * workflow through the real /api/runs endpoint — the same path a user hits —
 * without the canvas". Web Studio's user path is an HTTP route, so its driver
 * is a fetch. Desktop Studio's user path is a click in a window that reaches
 * the main process over IPC, so this driver launches the REAL app under xvfb
 * and drives a named scenario through the REAL IPC handlers:
 *
 *     driver → xvfb-run electron . --scenario=spec.json
 *              → renderer → window.scruple.<call> → ipcMain.handle → main
 *
 * WHAT IT ASSERTS ON, AND WHAT IT REFUSES TO ASSERT ON.
 *
 * The app writes a result file saying what it did. That file is a CLAIM. Every
 * assertion is evaluated here, in this process, against the world the app left
 * behind — bytes on disk re-hashed here, an exit code, a nonce this script
 * minted. Nothing is asserted from a log line, and nothing from a pixel
 * (docs/DESIGN.md: llvmpipe returns a blank frame; never gate on it).
 *
 * ⚑ THE AUDIT PASS IS THE POINT. A green run against an app nobody has broken
 * is likelier to mean the assertions are weak than that the app is right — the
 * principle scripts/probe-harness/run.sh already applies on the server side. So
 * `--audit` breaks the run once per mutation and requires that EXACTLY the
 * assertions that mutation targets go red, and that the others stay green. A
 * driver that always exits 0 is not a driver.
 *
 * Usage
 *   node scripts/desktop-run.mjs <scenario>            run it; non-zero if it fails
 *   node scripts/desktop-run.mjs <scenario> --audit    + the mutation sweep
 *   node scripts/desktop-run.mjs <scenario> --break <mutation>   one break
 *   node scripts/desktop-run.mjs <scenario> --expect-fail        invert the verdict
 *   node scripts/desktop-run.mjs --list
 *
 * <scenario> is a name under scenarios/ or a path to a spec JSON.
 *
 * Env
 *   SCRUPLE_APP_URL   default http://127.0.0.1:3902  (the served Next UI)
 */

import { spawn } from 'node:child_process';
import { createHash, randomBytes, createHmac } from 'node:crypto';
import {
  cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync,
  statSync, truncateSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require_ = createRequire(import.meta.url);
// One implementation of ${...}, shared with the main-process runner.
const { interpolate } = require_(join(REPO, 'app', 'interpolate.js'));

// ── mutations ──────────────────────────────────────────────────────────────
// A mutation only knows how to break something. WHAT THAT MUST DO is declared
// by the scenario, in its `audit` block, because the answer depends on which
// assertions the scenario makes: `no-bridge` reddens seven things in
// capture-file and six in ping, and neither number is a property of the
// mutation.
//
// The sweep requires the declared set EXACTLY. More red than declared means an
// assertion is coupled to something it should not care about; less means the
// assertion does not actually test what it claims to. Both are findings.
const MUTATIONS = {
  'store-truncate': {
    when: 'after',
    describe: 'chop the last 4 KiB off the copy the app stored',
    apply(ctx) {
      const p = ctx.resolve('${steps.cap.value.storePath}');
      truncateSync(p, Math.max(0, statSync(p).size - 4096));
      return `truncated ${p}`;
    },
  },
  'store-delete': {
    when: 'after',
    describe: 'delete the copy the app stored',
    apply(ctx) {
      const p = ctx.resolve('${steps.cap.value.storePath}');
      rmSync(p, { force: true });
      return `deleted ${p}`;
    },
  },
  'source-swap': {
    when: 'before',
    describe: 'rewrite the source file AFTER the driver hashed it, before the app reads it',
    apply(ctx) {
      const f = ctx.fixtures.src;
      writeFileSync(f.path, deterministicBytes('swapped-under-the-app', f.bytes));
      return `rewrote ${f.path} with different bytes of the same length`;
    },
  },
  'fake-bridge': {
    when: 'app-dir',
    describe: 'a preload that answers in the renderer and never reaches main',
    apply(ctx) {
      writeFileSync(join(ctx.appDir, 'app', 'preload.js'), FAKE_PRELOAD);
      return `replaced preload.js in ${ctx.appDir}`;
    },
  },
  'no-bridge': {
    when: 'app-dir',
    describe: 'no preload at all — window.scruple is undefined',
    apply(ctx) {
      rmSync(join(ctx.appDir, 'app', 'preload.js'), { force: true });
      return `removed preload.js from ${ctx.appDir}`;
    },
  },
  'assert-expectation': {
    when: 'spec',
    describe: "rewrite one assertion's expected value to a wrong constant",
    // The WO's own control: "deliberately break the assertion". The scenario
    // says which one, by listing exactly one id under audit.assert-expectation.
    apply(ctx) {
      const id = (ctx.spec.audit || {})['assert-expectation'];
      if (!id || id.length !== 1) throw new Error('audit.assert-expectation must name exactly one assertion id');
      const a = ctx.spec.assert.find((x) => x.id === id[0]);
      if (!a) throw new Error(`no assertion "${id[0]}" in this scenario`);
      a.expected = '<<a value the app will never report>>';
      return `${id[0]} now expects a value nothing can satisfy`;
    },
  },
};

const FAKE_PRELOAD = `// MUTATION ONLY: answers in the renderer; never reaches the main process.
const { contextBridge } = require('electron');
const reply = (nonce) => ({
  ok: true, pong: true, outcome: 'captured', echo: nonce,
  serverNonce: 'deadbeefdeadbeefdeadbeefdeadbeef', mainPid: 1, senderWindowId: 1,
  versions: { electron: 'x', chrome: 'x', node: 'x', v8: 'x' },
});
contextBridge.exposeInMainWorld('scruple', {
  host: 'electron',
  ping: async (nonce) => reply(nonce),
  captureFile: async (req) => ({ ...reply(null), sourcePath: req.path, storePath: req.path, sha256: 'f'.repeat(64), bytes: 0 }),
});
`;

// ── assertion kinds ────────────────────────────────────────────────────────
// Every one of these looks at the filesystem or at a value the app could not
// have chosen. None looks at stdout.
const KINDS = {
  'app-completed': (a, ctx) => ({
    pass: ctx.exitCode === 0 && ctx.result !== null && ctx.result.error === null,
    detail: { exitCode: ctx.exitCode, appError: ctx.result ? ctx.result.error : 'no result file' },
  }),
  equals: (a, ctx) => {
    const actual = ctx.resolve(a.actual);
    const expected = ctx.resolve(a.expected);
    return { pass: Object.is(actual, expected), detail: { actual, expected } };
  },
  'at-least': (a, ctx) => {
    const actual = ctx.resolve(a.actual);
    return { pass: typeof actual === 'number' && actual >= a.min, detail: { actual, min: a.min } };
  },
  'non-empty': (a, ctx) => {
    const actual = ctx.resolve(a.actual);
    return { pass: actual !== null && actual !== undefined && actual !== '', detail: { actual } };
  },
  'ends-with': (a, ctx) => {
    const actual = String(ctx.resolve(a.actual));
    const suffix = String(ctx.resolve(a.suffix));
    return { pass: actual.endsWith(suffix), detail: { actual, suffix } };
  },
  'step-succeeded': (a, ctx) => {
    const step = ctx.result && ctx.result.steps ? ctx.result.steps[a.step] : null;
    if (!step) return { pass: false, detail: `step "${a.step}" never ran` };
    const v = step.value;
    return {
      pass: step.error === null && step.reachedBridge === true && !!v && v.ok !== false,
      detail: { error: step.error, reachedBridge: step.reachedBridge, ok: v ? v.ok : null, reason: v ? v.reason : null },
    };
  },
  // The reply carries the pid of the process that wrote the result file. A
  // renderer-local stub would have to guess it, and the fake-bridge mutation
  // shows that it cannot.
  'reached-main': (a, ctx) => {
    const step = ctx.result && ctx.result.steps ? ctx.result.steps[a.step] : null;
    if (!step || !step.value) return { pass: false, detail: `step "${a.step}" returned nothing` };
    const v = step.value;
    const pidOk = Number.isInteger(v.mainPid) && v.mainPid === ctx.result.mainPid;
    const nonceOk = v.serverNonce === undefined || v.serverNonce === ctx.result.serverNonce;
    return { pass: pidOk && nonceOk, detail: { replyPid: v.mainPid, mainPid: ctx.result.mainPid, nonceOk } };
  },
  'file-exists': (a, ctx) => {
    const p = ctx.resolve(a.path);
    return { pass: typeof p === 'string' && existsSync(p) && statSync(p).isFile(), detail: p };
  },
  'file-absent': (a, ctx) => {
    const p = ctx.resolve(a.path);
    return { pass: !existsSync(p), detail: p };
  },
  // The one docs/DESIGN.md names. Read the bytes HERE and hash them HERE.
  'file-rehashes': (a, ctx) => {
    const p = ctx.resolve(a.path);
    const want = ctx.resolve(a.sha256);
    if (typeof p !== 'string' || !existsSync(p)) return { pass: false, detail: { path: p, why: 'no such file' } };
    const got = createHash('sha256').update(readFileSync(p)).digest('hex');
    return { pass: got === want, detail: { path: p, onDisk: got, recorded: want } };
  },
  'file-bytes': (a, ctx) => {
    const p = ctx.resolve(a.path);
    const want = ctx.resolve(a.bytes);
    if (typeof p !== 'string' || !existsSync(p)) return { pass: false, detail: { path: p, why: 'no such file' } };
    const got = statSync(p).size;
    return { pass: got === want, detail: { path: p, onDisk: got, expected: want } };
  },
};

// ── helpers ────────────────────────────────────────────────────────────────

/** Fixture bytes that are the same on every run, so a digest can be compared across runs. */
function deterministicBytes(seed, n) {
  const out = Buffer.alloc(n);
  let filled = 0, counter = 0;
  while (filled < n) {
    const block = createHmac('sha256', seed).update(String(counter++)).digest();
    block.copy(out, filled, 0, Math.min(block.length, n - filled));
    filled += block.length;
  }
  return out;
}

function argValue(name, fallback) {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
}

function resolveScenario(nameOrPath) {
  if (nameOrPath.endsWith('.json')) return resolve(nameOrPath);
  const p = join(REPO, 'scenarios', `${nameOrPath}.json`);
  if (!existsSync(p)) {
    const have = readdirSync(join(REPO, 'scenarios')).map((f) => basename(f, '.json'));
    throw new Error(`no scenario "${nameOrPath}"; have: ${have.join(', ')}`);
  }
  return p;
}

// ── one run ────────────────────────────────────────────────────────────────

async function runOnce({ specPath, label, appURL, breaks, timeoutMs, quiet }) {
  const spec = JSON.parse(readFileSync(specPath, 'utf8'));
  const runDir = join(REPO, '.run', 'd2', `${label}-${Date.now()}`);
  const sourceDir = join(runDir, 'source');
  const storeDir = join(runDir, 'store');
  mkdirSync(sourceDir, { recursive: true });
  mkdirSync(storeDir, { recursive: true });

  const nonce = randomBytes(12).toString('hex');
  const resultPath = join(runDir, 'result.json');
  const reportPath = join(runDir, 'report.json');
  const applied = [];

  // Fixtures: written and hashed HERE, before the app has seen them, so the
  // digest the app reports is being compared against one it did not produce.
  const fixtures = {};
  for (const [id, f] of Object.entries(spec.fixtures || {})) {
    const bytes = deterministicBytes(f.seed || id, f.bytes);
    const path_ = join(sourceDir, f.name || id);
    writeFileSync(path_, bytes);
    fixtures[id] = {
      ...f, path: path_, bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  }

  // An app directory of our own only when a mutation needs to change the app.
  const dirMutations = breaks.filter((b) => MUTATIONS[b].when === 'app-dir');
  let appDir = REPO;
  if (dirMutations.length) {
    appDir = join(runDir, 'app-under-test');
    mkdirSync(appDir, { recursive: true });
    cpSync(join(REPO, 'app'), join(appDir, 'app'), { recursive: true });
    cpSync(join(REPO, 'package.json'), join(appDir, 'package.json'));
  }

  const ctxEarly = { fixtures, appDir, spec, runDir };
  for (const b of breaks) {
    const m = MUTATIONS[b];
    if (m.when === 'after') continue;
    applied.push({ mutation: b, what: m.apply(ctxEarly) });
  }

  // The spec the app actually reads: fixtures materialised, driver block filled.
  const materialised = {
    ...spec,
    fixtures,
    driver: { nonce, appURL, expectedOrigin: new URL(appURL).origin, runDir, storeDir },
  };
  const materialisedPath = join(runDir, 'spec.json');
  writeFileSync(materialisedPath, JSON.stringify(materialised, null, 2));

  const electron = join(REPO, 'node_modules', '.bin', 'electron');
  const child = spawn(
    'xvfb-run',
    ['-a', '-s', '-screen 0 1280x900x24', electron, appDir, `--scenario=${materialisedPath}`],
    {
      cwd: appDir,
      env: {
        ...process.env,
        SCRUPLE_APP_URL: appURL,
        SCRUPLE_RUN_STORE: storeDir,
        SCRUPLE_SCENARIO_RESULT: resultPath,
        ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );

  let appLog = '';
  child.stdout.on('data', (d) => { appLog += d; if (!quiet) process.stdout.write(`   | ${d}`); });
  child.stderr.on('data', (d) => { appLog += d; });

  let timedOut = false;
  const killer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
  const exitCode = await new Promise((res) => {
    child.on('close', (code, signal) => { clearTimeout(killer); res(signal ? `signal:${signal}` : code); });
  });
  writeFileSync(join(runDir, 'app.log'), appLog);

  const result = existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, 'utf8')) : null;

  const ctx = {
    exitCode, timedOut, result, fixtures, appDir, runDir, storeDir,
    // Deliberately allowed to THROW. The assertion loop turns that into a
    // failed check. An earlier version caught it and returned a placeholder
    // string, and the audit sweep found the hole: under `no-bridge` there is no
    // reply to read a version out of, and `non-empty` was happily passing on
    // "<<unresolved: …>>". A reference that does not resolve is a failed
    // assertion, never a satisfied one.
    resolve: (v) => interpolate(v, { ...(result || {}), fixtures, driver: materialised.driver }),
  };

  for (const b of breaks) {
    const m = MUTATIONS[b];
    if (m.when !== 'after') continue;
    applied.push({ mutation: b, what: m.apply(ctx) });
  }

  // ── the verdict ──────────────────────────────────────────────────────────
  const checks = [];
  const add = (id, pass, detail, note) => checks.push({ id, pass: !!pass, detail: detail ?? null, note: note ?? null });

  // Two the driver always makes, whatever the scenario says.
  add('process-did-not-hang', !timedOut, { timeoutMs });
  add('result-written', result !== null, resultPath);

  for (const a of materialised.assert || []) {
    const kind = KINDS[a.kind];
    if (!kind) { add(a.id || a.kind, false, `unknown assertion kind "${a.kind}"`); continue; }
    if (result === null && a.kind !== 'app-completed') { add(a.id || a.kind, false, 'no result file', a.note); continue; }
    let outcome;
    try { outcome = kind(a, ctx); } catch (err) { outcome = { pass: false, detail: String(err.message || err) }; }
    add(a.id || a.kind, outcome.pass, outcome.detail, a.note);
  }

  const failed = checks.filter((c) => !c.pass).map((c) => c.id);
  const report = {
    spec: materialised,
    scenario: materialised.scenario, label, appURL, runDir, specPath, exitCode, timedOut,
    breaks: applied, passed: failed.length === 0, failed,
    checks,
    versions: result ? result.versions : null,
    page: result && result.renderer ? { href: result.renderer.href, bodyChars: result.renderer.bodyChars, bridgeMethods: result.renderer.bridgeMethods } : null,
  };
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  report.reportPath = reportPath;
  return report;
}

function printReport(r) {
  for (const c of r.checks) {
    console.log(`   ${c.pass ? 'PASS' : 'FAIL'}  ${c.id}${c.pass ? '' : `  ${JSON.stringify(c.detail)}`}`);
  }
  if (r.versions) {
    console.log(`   electron ${r.versions.electron} · chromium ${r.versions.chrome} · node ${r.versions.node}`);
  }
  if (r.page) console.log(`   page ${r.page.href} (${r.page.bodyChars} chars) · bridge [${(r.page.bridgeMethods || []).join(', ')}]`);
  console.log(`   run  ${r.runDir}`);
  console.log(`   ${r.passed ? 'PASSED' : `FAILED — ${r.failed.join(', ')}`}`);
}

// ── main ───────────────────────────────────────────────────────────────────

if (process.argv.includes('--list')) {
  console.log('scenarios:');
  for (const f of readdirSync(join(REPO, 'scenarios'))) {
    const s = JSON.parse(readFileSync(join(REPO, 'scenarios', f), 'utf8'));
    console.log(`  ${basename(f, '.json').padEnd(16)} ${s.description}`);
  }
  console.log('\nmutations:');
  for (const [k, m] of Object.entries(MUTATIONS)) console.log(`  ${k.padEnd(20)} ${m.describe}`);
  process.exit(0);
}

const target = process.argv[2];
if (!target || target.startsWith('--')) {
  console.error('usage: desktop-run.mjs <scenario> [--audit] [--break <mutation>] [--expect-fail]');
  console.error('       desktop-run.mjs --list');
  process.exit(2);
}

const specPath = resolveScenario(target);
const appURL = argValue('--url', process.env.SCRUPLE_APP_URL || 'http://127.0.0.1:3902');
const timeoutMs = Number(argValue('--timeout', '180000'));
const expectFail = process.argv.includes('--expect-fail');
const audit = process.argv.includes('--audit');
const oneBreak = argValue('--break', null);
if (oneBreak && !MUTATIONS[oneBreak]) {
  console.error(`unknown mutation "${oneBreak}"; have: ${Object.keys(MUTATIONS).join(', ')}`);
  process.exit(2);
}

console.log(`── desktop-run · ${basename(specPath)} ──`);
console.log(`   app url : ${appURL}`);

const clean = await runOnce({
  specPath, label: oneBreak ? `break-${oneBreak}` : 'clean', appURL,
  breaks: oneBreak ? [oneBreak] : [], timeoutMs, quiet: false,
});
printReport(clean);

if (!audit) {
  if (expectFail) {
    console.log(`\n   expected FAIL${oneBreak ? ` (mutation ${oneBreak})` : ''}`);
    console.log(clean.passed ? '── THE BREAK DID NOT FIRE — that is the problem ──' : '── the break fired as required ──');
    process.exit(clean.passed ? 1 : 0);
  }
  process.exit(clean.passed ? 0 : 1);
}

// ── the audit sweep ────────────────────────────────────────────────────────
// Break it once per mutation. Each must redden exactly what it targets.
if (!clean.passed) {
  console.log('\n── the clean run failed; the sweep would be meaningless. Stopping. ──');
  process.exit(1);
}
const declared = clean.spec.audit || {};
const unknown = Object.keys(declared).filter((k) => !MUTATIONS[k]);
if (unknown.length) {
  console.log(`\n── ${basename(specPath)} declares mutations that do not exist: ${unknown.join(', ')} ──`);
  process.exit(2);
}
if (!Object.keys(declared).length) {
  console.log('\n── this scenario declares no audit block; there is nothing to sweep ──');
  process.exit(2);
}
let rc = 0;
const rows = [];

for (const [name, targets] of Object.entries(declared)) {
  const m = MUTATIONS[name];
  process.stdout.write(`\n── mutation ${name} — ${m.describe}\n`);
  let r;
  try {
    r = await runOnce({ specPath, label: `audit-${name}`, appURL, breaks: [name], timeoutMs, quiet: true });
  } catch (err) {
    rows.push([name, 'ERROR', String(err.message || err)]); rc = 1; continue;
  }
  const red = new Set(r.failed);
  const missing = targets.filter((id) => !red.has(id));
  const extra = [...red].filter((id) => !targets.includes(id));
  let verdict, detail;
  if (r.passed) { verdict = 'NOT CAUGHT'; detail = 'the run still passed'; rc = 1; }
  else if (missing.length) { verdict = 'MISSED'; detail = `declared red, stayed green: ${missing.join(', ')}`; rc = 1; }
  else if (extra.length) { verdict = 'OVERREACH'; detail = `red but not declared: ${extra.join(', ')}`; rc = 1; }
  else { verdict = 'caught'; detail = `${targets.length} red exactly: ${targets.join(', ')}`; }
  rows.push([name, verdict, detail]);
  console.log(`   ${verdict}: ${detail}`);
}

console.log('\n════ audit sweep ════');
for (const [name, verdict, detail] of rows) {
  console.log(`  ${name.padEnd(20)} ${verdict.padEnd(11)} ${detail}`);
}
console.log(rc === 0
  ? '\n════ scenario PASSES and every mutation was caught by exactly what it targets ════'
  : '\n════ SWEEP NOT CLEAN — see above ════');
process.exit(rc);
