// WO-G3 — does the real app actually capture, on Windows?
//
// Everything before this showed the app OPENS. This asks the product question:
// an artifact appears where the app is watching, and a leaf, a Merkle root and
// a tracked project come out the other side.
//
// It drives `app-legacy`'s REAL capture contract, which is a file contract: the
// ComfyUI-side node writes a PNG, hashes it, and atomically renames a
// `.provenance.json` beside it. `capture/comfyui/watcher.js` picks that up,
// checks the session id, re-hashes the image ITSELF, and only then emits a leaf.
// Nothing here calls into the app; files are placed exactly where a generation
// would place them.
//
//   node g3-capture-probe.mjs [--race-trials N]
//
// VERIFY BY SIDE EFFECT, AND THE TWO GUARDS ARE THE POINT:
//
//   valid      a correct pair        → a leaf, a project, a NEW ROOT
//   CONTROL A  wrong session_id      → "Session mismatch", NO leaf
//   CONTROL B  right session, wrong  → "HASH MISMATCH", NO leaf. The watcher
//              leaf_hash               does not trust the writer's hash, and
//                                      this is the only thing proving it
//
// If either guard fails to fire, the valid case proves nothing — an ingester
// that accepts everything accepts the good one too. Scored INCONCLUSIVE.
//
// ⚑ EVERY CASE GETS ITS OWN BYTES. Identical images hash identically, and a
// second leaf with the same hash is indistinguishable in the log from the first
// one being re-reported. Each case appends a unique tail to the PNG (decoders
// ignore trailing bytes; the watcher only hashes the file).
//
// ⚑ AND EVERY CASE IS SCOPED BY NAME, not by a log offset. The startup race
// below means events can arrive in an order the probe did not choose, and an
// offset-based read silently attributes one case's outcome to another — which
// it did, on the first version of this file.

import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const G3 = 'C:\\SCRUPLEWORK\\g3';
const COMFY = 'C:\\SCRUPLEWORK\\.scratch\\g3-comfy';
const ELECTRON = path.join(G3, 'node_modules', 'electron', 'dist', 'electron.exe');
const RACE_TRIALS = Number((process.argv.find((a) => a.startsWith('--race-trials=')) || '=3').split('=')[1]) || 3;

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const bytesFor = (tag) => Buffer.concat([PNG, Buffer.from(`\n<!-- ${tag} -->`)]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Put `n` ordinary files in the watched tree before the app starts.
 *
 * ⚑ THIS IS THE REAL DEPLOYMENT, not a stress test. chokidar scans the tree
 * before emitting `ready`, so the drop window is a function of how much is
 * already there — and the folder being watched is a ComfyUI output directory,
 * which on any working artist's machine holds thousands of images. An empty
 * probe directory is the BEST case and is the one least like a user.
 */
function prefill(n) {
  const root = path.join(COMFY, 'output', 'terminal_provenance');
  for (let i = 0; i < n; i += 1) {
    const dir = path.join(root, `old_project_${i % 8}`);
    if (i < 8) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `prior_${i}.png`), PNG);
  }
  return n;
}

function startApp(homeSuffix, { keepTree = false } = {}) {
  const home = `C:\\SCRUPLEWORK\\.scratch\\g3-home-${homeSuffix}`;
  for (const d of [path.join(COMFY, 'output'), path.join(COMFY, 'models')]) fs.mkdirSync(d, { recursive: true });
  fs.rmSync(home, { recursive: true, force: true });
  if (!keepTree) fs.rmSync(path.join(COMFY, 'output', 'terminal_provenance'), { recursive: true, force: true });
  fs.mkdirSync(path.join(home, 'config'), { recursive: true });
  fs.writeFileSync(
    path.join(home, 'config', 'scruple_studio.json'),
    JSON.stringify({ comfyUIPath: COMFY, scrupleHome: home }, null, 2),
  );

  const env = { ...process.env, SCRUPLE_HOME: home };
  delete env.SCRUPLE_WITNESS_URL;
  delete env.SCRUPLE_ALLOW_PRODUCTION_WITNESS;
  delete env.ELECTRON_RUN_AS_NODE;

  const app = spawn(ELECTRON, ['.'], { cwd: G3, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const state = { app, home, log: '' };
  app.stdout.on('data', (d) => { state.log += d; });
  app.stderr.on('data', (d) => { state.log += d; });
  return state;
}

async function waitFor(state, re, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const m = re.exec(state.log);
    if (m) return m;
    if (state.app.exitCode !== null) return null;
    await sleep(150);
  }
  return null;
}

function emit(name, { sessionId, hash, project, bytes }) {
  const dir = path.join(COMFY, 'output', 'terminal_provenance', project);
  fs.mkdirSync(dir, { recursive: true });
  const img = path.join(dir, `${name}.png`);
  fs.writeFileSync(img, bytes);
  const doc = {
    session_id: sessionId, project_name: project, run_sequence: 1,
    timestamp: new Date().toISOString(), image_path: img,
    image_filename: `${name}.png`, leaf_hash: hash, metadata: { probe: 'g3-capture' },
  };
  const tmp = path.join(dir, `${name}.provenance.json.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2));
  fs.renameSync(tmp, path.join(dir, `${name}.provenance.json`));
}

/** Everything the watcher logged about ONE file, from its "Processing" line to
 *  the next one. Scoping by name is what makes concurrent cases readable. */
function scopeFor(log, name) {
  const start = log.indexOf(`Processing: ${name}.provenance.json`);
  if (start < 0) return null;
  const next = log.indexOf('[WATCHER] Processing: ', start + 10);
  return log.slice(start, next < 0 ? undefined : next);
}

const kill = (state) => {
  try { execFileSync('taskkill', ['/PID', String(state.app.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ }
};

const results = [];
const say = (ok, label, detail) => {
  results.push({ ok, label });
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail === undefined ? '' : `  ${detail}`}`);
};

// ─────────────────────────────────────────────────────────────────────────────
// PART 1 — the capture path, with the watcher genuinely watching.
// ─────────────────────────────────────────────────────────────────────────────
const main = startApp('capture');
try {
  const started = await waitFor(main, /File watcher started: (.+)/, 90000);
  say(!!started, 'the app completed initialize() and started the file watcher',
    started ? started[1].trim() : 'never started');
  if (!started) throw new Error('no watcher');

  const sess = await waitFor(main, /Session created: (\S+)/, 5000);
  const sessionId = sess ? sess[1] : 'unknown';
  say(!!sess, 'a capture session exists', sessionId);

  // Wait for chokidar itself, not for the app's claim about it. See PART 2.
  const ready = await waitFor(main, /Ready and watching/, 60000);
  say(!!ready, 'chokidar reached `ready`');
  await sleep(500);

  const cases = [
    { name: 'valid', tag: 'valid', session: sessionId, truthful: true },
    { name: 'ghost', tag: 'ghost', session: 'not-this-session', truthful: true },
    { name: 'tampered', tag: 'tampered', session: sessionId, truthful: false },
  ];
  for (const c of cases) {
    const bytes = bytesFor(c.tag);
    const real = crypto.createHash('sha256').update(bytes).digest('hex');
    emit(c.name, {
      sessionId: c.session, project: 'G3_Probe_Project', bytes,
      hash: c.truthful ? real : 'f'.repeat(64),
    });
    await waitFor(main, new RegExp(`Processing: ${c.name}\\.provenance\\.json`), 20000);
    await sleep(1200);
  }
  await sleep(1500);

  const sValid = scopeFor(main.log, 'valid');
  const sGhost = scopeFor(main.log, 'ghost');
  const sTamper = scopeFor(main.log, 'tampered');

  say(!!sValid && /Hash verified/.test(sValid), 'the watcher re-hashed the image and agreed');
  say(!!sValid && /Emitting verified leaf/.test(sValid), '⚑ the artifact became a LEAF');
  const root = /new root: ([0-9a-f]{16})/.exec(main.log);
  say(!!root, '⚑ and the leaf became a MERKLE ROOT', root ? `${root[1]}…` : 'no root');
  const added = /Leaf added to project (\S+)/.exec(main.log);
  say(!!added, 'in a tracked project the app created itself', added ? added[1] : 'none');

  say(!!sGhost && /Session mismatch/.test(sGhost) && !/Emitting verified leaf/.test(sGhost),
    '🔴 CONTROL — a file from another session is REFUSED',
    sGhost ? 'Session mismatch, no leaf' : 'never processed');

  say(!!sTamper && /HASH MISMATCH/.test(sTamper) && !/Emitting verified leaf/.test(sTamper),
    '🔴 CONTROL — a claimed hash that is not the bytes is REFUSED',
    sTamper ? 'HASH MISMATCH, no leaf' : 'never processed');

  fs.writeFileSync(path.join(G3, '.run', 'g3', 'capture-probe.log'), main.log);
} finally {
  kill(main);
}

// ─────────────────────────────────────────────────────────────────────────────
// PART 2 — 🔴 THE STARTUP RACE, measured over several launches because it IS a
// race and a single run proves nothing either way.
//
// `await fileWatcher.start()` resolves once chokidar has been CONSTRUCTED, not
// once it is READY — chokidar scans the tree afterwards and only then emits
// `ready`. main-modular.js logs "File watcher started" at the earlier moment and
// the app reports `initialized` to the renderer. With `ignoreInitial: true`,
// anything landing in that window is treated as pre-existing: not deferred,
// DROPPED, permanently and silently.
//
// The window grows with the size of the watched tree, so a user whose ComfyUI
// output folder holds thousands of files has a much larger one than this
// almost-empty probe does.
// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n── the startup race, ${RACE_TRIALS} launch(es) ──`);
let dropped = 0;
let trials = 0;
for (let i = 0; i < RACE_TRIALS; i += 1) {
  const s = startApp(`race-${i}`);
  try {
    const started = await waitFor(s, /File watcher started/, 90000);
    const sess = await waitFor(s, /Session created: (\S+)/, 5000);
    if (!started || !sess) continue;
    // The instant the app says the watcher is running — which is exactly when an
    // already-running ComfyUI would finish a generation.
    const bytes = bytesFor(`race-${i}`);
    emit('in-the-window', {
      sessionId: sess[1], project: 'G3_Race', bytes,
      hash: crypto.createHash('sha256').update(bytes).digest('hex'),
    });
    await waitFor(s, /Ready and watching/, 60000);
    await sleep(2500);
    trials += 1;
    const seen = /Processing: in-the-window\.provenance\.json/.test(s.log);
    if (!seen) dropped += 1;
    console.log(`   trial ${i + 1}: ${seen ? 'processed' : 'DROPPED — never processed, never a leaf'}`);
  } finally {
    kill(s);
  }
}
// The same trial once more, against a tree the size a real user's ComfyUI
// output folder actually is. If the window is a function of the scan, this is
// where it stops being intermittent.
const PREFILL = Number((process.argv.find((a) => a.startsWith('--prefill=')) || '=0').split('=')[1]) || 0;
if (PREFILL > 0) {
  console.log(`\n── the same race, with ${PREFILL} files already in the watched tree ──`);
  fs.rmSync(path.join(COMFY, 'output', 'terminal_provenance'), { recursive: true, force: true });
  const t0 = Date.now();
  prefill(PREFILL);
  console.log(`   prefilled in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const s = startApp('race-big', { keepTree: true });
  try {
    const started = await waitFor(s, /File watcher started/, 120000);
    const sess = await waitFor(s, /Session created: (\S+)/, 5000);
    if (started && sess) {
      const tStart = Date.now();
      const bytes = bytesFor('race-big');
      emit('in-the-window', {
        sessionId: sess[1], project: 'G3_Race', bytes,
        hash: crypto.createHash('sha256').update(bytes).digest('hex'),
      });
      const rdy = await waitFor(s, /Ready and watching/, 180000);
      const windowMs = Date.now() - tStart;
      await sleep(3000);
      const seen = /Processing: in-the-window\.provenance\.json/.test(s.log);
      trials += 1;
      if (!seen) dropped += 1;
      console.log(
        `   window between "started" and \`ready\`: ${(windowMs / 1000).toFixed(1)}s` +
        `${rdy ? '' : ' (ready never arrived)'}`,
      );
      console.log(`   result: ${seen ? 'processed' : 'DROPPED — never processed, never a leaf'}`);
    }
  } finally {
    kill(s);
    fs.rmSync(path.join(COMFY, 'output', 'terminal_provenance'), { recursive: true, force: true });
  }
}

say(trials > 0, `the race was exercised ${trials} time(s)`, `${dropped} dropped`);
if (dropped > 0) {
  console.log(
    `\n⚑ FINDING — ${dropped} of ${trials} artifacts written in the window between\n` +
    '  "File watcher started" and chokidar `ready` were never processed. The app had\n' +
    '  already told the renderer it was initialised. Nothing reports the loss.',
  );
} else if (trials > 0) {
  console.log(
    `\nThe race did not reproduce in ${trials} trial(s) — NOT evidence that it cannot.\n` +
    '  The ordering is still wrong (`started` is logged before `ready` arrives) and the\n' +
    '  window scales with the size of the watched tree.',
  );
}

const controls = results.filter((r) => r.label.includes('CONTROL'));
const bad = results.filter((r) => !r.ok);
console.log('');
if (controls.some((c) => !c.ok)) {
  console.log('INCONCLUSIVE — a guard did not fire, so the valid case proves nothing.');
  process.exit(2);
}
console.log(bad.length === 0
  ? 'The capture path works on Windows, and both guards refuse what they exist to refuse.'
  : `FAILED — ${bad.map((b) => b.label).join('; ')}`);
process.exit(bad.length === 0 ? 0 : 1);
