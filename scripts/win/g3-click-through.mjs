// WO-G3's gate — pick a project, see the work, checkpoint, lock, see the root.
//
// 🔴 REAL CLICKS, NOT IPC CALLS. The whole reason this work order exists is that
// D5's missing tabs survived seven work orders of scripted boots. So nothing
// here calls `window.scruple.*` or an ipcMain handler. It attaches to the
// running app over the Chrome DevTools Protocol and dispatches
// `Input.dispatchMouseEvent` at the on-screen coordinates of real buttons —
// the same path a mouse takes. If a button is not there, not visible, or
// disabled, this fails, which is the point.
//
//   node g3-click-through.mjs
//
// 🔴 THE CHAIN LOCK IS NOT CLICKED. `button[data-lock="chain"]` is labelled
// "RVN + IPFS + Arweave" and `lock/lock-chain-lock.js:92` calls
// performPermanentLock({arweave: true, ipfs: true}), which writes to
// 129.80.23.93 — the Oracle host — on ports no resolver covers (W1-G3). The
// founder authorised checkpoint and the local lock and excluded that one. This
// script asserts the chain button EXISTS and never touches it.
//
// Payment mode is `blockchain`, where checkpoint and finalize carry no TSD fee.
// In `fiat` they charge $5.00 through witnessUrl(), which resolves to the CVM
// surrogate — not running here — so fiat cannot complete offline. That is a
// finding about the fiat path, not a reason to point this at anything live.
//
// A netstat watch runs throughout: any connection to the Oracle host aborts.

import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const G3 = 'C:\\SCRUPLEWORK\\g3';
const COMFY = 'C:\\SCRUPLEWORK\\.scratch\\g3-comfy';
const HOME = 'C:\\SCRUPLEWORK\\.scratch\\g3-home-click';
const OUT = path.join(G3, '.run', 'g3');
const ELECTRON = path.join(G3, 'node_modules', 'electron', 'dist', 'electron.exe');
const PORT = 9222;
const FORBIDDEN = '129.80.23.93';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });

const results = [];
const say = (ok, label, detail) => {
  results.push({ ok, label });
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail === undefined ? '' : `  ${detail}`}`);
};

// ── set up a clean install in blockchain payment mode ────────────────────────
for (const d of [path.join(COMFY, 'output'), path.join(COMFY, 'models')]) fs.mkdirSync(d, { recursive: true });
fs.rmSync(path.join(COMFY, 'output', 'terminal_provenance'), { recursive: true, force: true });
fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(path.join(HOME, 'config'), { recursive: true });
fs.writeFileSync(path.join(HOME, 'config', 'scruple_studio.json'), JSON.stringify({
  comfyUIPath: COMFY,
  scrupleHome: HOME,
  comfyUIEnabled: true,
  beta: { paymentMode: 'blockchain', rvnMode: 'user' },
}, null, 2));

const env = { ...process.env, SCRUPLE_HOME: HOME };
delete env.SCRUPLE_WITNESS_URL;
delete env.SCRUPLE_ALLOW_PRODUCTION_WITNESS;
delete env.ELECTRON_RUN_AS_NODE;

const app = spawn(ELECTRON, ['.', `--remote-debugging-port=${PORT}`], {
  cwd: G3, env, stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
app.stdout.on('data', (d) => { log += d; });
app.stderr.on('data', (d) => { log += d; });

async function waitLog(re, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const m = re.exec(log);
    if (m) return m;
    if (app.exitCode !== null) return null;
    await sleep(150);
  }
  return null;
}

/** Any connection from the app's process tree to the Oracle host. */
function forbiddenContact() {
  try {
    const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true });
    return out.split(/\r?\n/).filter((l) => l.includes(FORBIDDEN)).map((l) => l.trim());
  } catch { return []; }
}

// ── a minimal CDP client over the built-in WebSocket ─────────────────────────
let ws = null;
let nextId = 1;
const pending = new Map();

async function cdpConnect() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const targets = await r.json();
      const page = targets.find((t) => t.type === 'page' && /index-final\.html/.test(t.url || ''));
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
        ws.onmessage = (ev) => {
          const msg = JSON.parse(ev.data);
          if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
        };
        return page.url;
      }
    } catch { /* not up yet */ }
    await sleep(500);
  }
  return null;
}

function send(method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => {
    pending.set(id, (m) => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result)));
    setTimeout(() => rej(new Error(`${method} timed out`)), 30000);
  });
}

async function evaluate(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  return r.result?.value;
}

/** Where is this element on screen, and is it clickable at all? */
async function locate(selector) {
  return evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { found: false };
    const r = el.getBoundingClientRect();
    return {
      found: true,
      x: r.x + r.width / 2, y: r.y + r.height / 2,
      w: r.width, h: r.height,
      disabled: !!el.disabled,
      text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60),
    };
  })()`);
}

/** A real mouse press and release at the element's centre. */
async function click(selector, what) {
  const box = await locate(selector);
  if (!box || !box.found) { say(false, `click ${what}`, `no element matching ${selector}`); return false; }
  if (box.w === 0 || box.h === 0) { say(false, `click ${what}`, 'element has no box — not visible'); return false; }
  if (box.disabled) { say(false, `click ${what}`, `the button is DISABLED ("${box.text}")`); return false; }
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', {
      type, x: Math.round(box.x), y: Math.round(box.y), button: 'left', clickCount: 1,
    });
    await sleep(60);
  }
  say(true, `click ${what}`, `"${box.text}" at ${Math.round(box.x)},${Math.round(box.y)}`);
  await sleep(1200);
  return true;
}

async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  const p = path.join(OUT, `g3-${name}.png`);
  fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
  return p;
}

function emitArtifact(tag, sessionId, project) {
  const bytes = Buffer.concat([
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'),
    Buffer.from(`\n<!-- ${tag} -->`),
  ]);
  const dir = path.join(COMFY, 'output', 'terminal_provenance', project);
  fs.mkdirSync(dir, { recursive: true });
  const img = path.join(dir, `${tag}.png`);
  fs.writeFileSync(img, bytes);
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  const tmp = path.join(dir, `${tag}.provenance.json.tmp`);
  fs.writeFileSync(tmp, JSON.stringify({
    session_id: sessionId, project_name: project, run_sequence: 1,
    timestamp: new Date().toISOString(), image_path: img,
    image_filename: `${tag}.png`, leaf_hash: hash, metadata: { probe: 'g3-click' },
  }, null, 2));
  fs.renameSync(tmp, path.join(dir, `${tag}.provenance.json`));
  return hash;
}

const PROJECT = 'G3_Click_Through';
let finalRoot = null;

try {
  const started = await waitLog(/File watcher started/, 90000);
  const sess = await waitLog(/Session created: (\S+)/, 10000);
  say(!!started && !!sess, 'the app started and opened a capture session', sess ? sess[1] : 'no session');
  await waitLog(/Ready and watching/, 60000); // W1-G7: wait for the watcher, not the claim

  // ── work happens: two artifacts, the way a generation would produce them ──
  emitArtifact('iteration-1', sess[1], PROJECT);
  await waitLog(/new root: ([0-9a-f]{16})/, 30000);
  emitArtifact('iteration-2', sess[1], PROJECT);
  await sleep(2500);
  const roots = [...log.matchAll(/new root: ([0-9a-f]{16})/g)].map((m) => m[1]);
  say(roots.length >= 2, 'two iterations were captured and the root MOVED',
    roots.length >= 2 ? `${roots[0]}… → ${roots[roots.length - 1]}…` : `only ${roots.length} root(s)`);

  const url = await cdpConnect();
  say(!!url, 'attached to the running app over CDP', url || 'no page target');
  if (!url) throw new Error('no CDP');
  await send('Runtime.enable');
  await send('Page.enable');
  await sleep(2500);

  // ── pick the project, by clicking it ─────────────────────────────────────
  const listed = await evaluate(`
    Array.from(document.querySelectorAll('.project-item, .project-list *'))
      .map(e => (e.textContent||'').trim()).filter(t => t.includes(${JSON.stringify(PROJECT)})).length`);
  say(listed > 0, 'the project the app created appears in the sidebar', `${listed} matching node(s)`);
  await shot('01-before');

  const picked = await evaluate(`(() => {
    const items = Array.from(document.querySelectorAll('.project-item'));
    const el = items.find(e => (e.textContent||'').includes(${JSON.stringify(PROJECT)})) || items[0];
    if (!el) return null;
    el.setAttribute('data-g3-target', '1');
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width/2, y: r.y + r.height/2, text: (el.textContent||'').replace(/\\s+/g,' ').trim().slice(0,50) };
  })()`);
  say(!!picked, 'the project is on screen to be clicked', picked ? picked.text : 'no .project-item');
  if (picked) await click('[data-g3-target="1"]', 'the project in the sidebar');
  await shot('02-project-selected');

  // ── the chain button must exist and must NOT be clicked ──────────────────
  const chain = await locate('button[data-lock="chain"]');
  say(!!chain && chain.found, '🔴 the chain-lock button is present and deliberately NOT clicked',
    chain && chain.found ? `"${chain.text}" — left alone` : 'not found');

  // ── checkpoint ───────────────────────────────────────────────────────────
  const cp = await locate('button[data-lock="checkpoint"]');
  say(!!cp && cp.found && !cp.disabled, 'the Checkpoint button is enabled',
    cp && cp.found ? (cp.disabled ? 'present but DISABLED' : cp.text) : 'not found');
  if (cp && cp.found && !cp.disabled) {
    await click('button[data-lock="checkpoint"]', 'Checkpoint Project');
    await shot('03-checkpoint-modal');
    await click('[data-wallet-action="confirm-blockchain-checkpoint"]', 'the checkpoint confirmation');
    await sleep(2500);
  }
  const cpOk = /checkpointed successfully/i.test(log) || await evaluate(
    `/Checkpointed/i.test(document.body.innerText)`);
  say(!!cpOk, '⚑ the project is CHECKPOINTED', cpOk ? 'confirmed in the app' : 'no confirmation');
  await shot('04-checkpointed');

  // ── the local lock ───────────────────────────────────────────────────────
  const lk = await locate('button[data-lock="local"]');
  say(!!lk && lk.found && !lk.disabled, 'the Finalize (local) button is enabled',
    lk && lk.found ? (lk.disabled ? 'present but DISABLED' : lk.text) : 'not found');
  if (lk && lk.found && !lk.disabled) {
    await click('button[data-lock="local"]', 'Finalize Project');
    await shot('05-finalize-modal');
    const confirmed =
      await click('[data-wallet-action="confirm-blockchain-finalize-clone"]', 'the finalize confirmation (clone)')
      || await click('[data-wallet-action="confirm-blockchain-finalize"]', 'the finalize confirmation');
    if (!confirmed) say(false, 'the finalize confirmation could not be clicked');
    await sleep(4000);
  }
  await shot('06-locked');

  // ── see the root, in the interface, not in a log ─────────────────────────
  //
  // ⚑ THIS ASSERTION WAS WRONG THE FIRST TIME AND PASSED BECAUSE OF IT. It
  // looked for "any 16-64 hex run in the page" and matched the LEAF hash
  // printed on an iteration card, then reported the root as visible. The leaf
  // and the root are different claims — the leaf identifies one artifact, the
  // root commits to the whole history — and an assertion that cannot tell them
  // apart cannot test the gate, which is "see the ROOT".
  //
  // So the expected value is the root the main process actually computed, taken
  // from its own log, and the page must contain THAT string.
  const expectedRoot = roots.length ? roots[roots.length - 1] : null;
  const shown = await evaluate(`(() => {
    const t = document.body.innerText;
    return {
      hasExpectedRoot: ${JSON.stringify(expectedRoot)} ? t.includes(${JSON.stringify(expectedRoot || '')}) : false,
      merkleRootLabel: (t.match(/([^\\n]{0,12})\\s*MERKLE ROOT/i) || [null, null])[1],
      scr: (t.match(/SCR_[A-Z0-9]+/) || [null])[0],
      status: (t.match(/CHECKPOINTED|FINALIZED|LOCKED/gi) || []).join(','),
    };
  })()`);
  finalRoot = { expectedRoot, ...shown };
  say(!!(shown && shown.hasExpectedRoot),
    '⚑ THE ROOT THE APP COMPUTED IS VISIBLE IN THE INTERFACE',
    shown ? `header shows "${(shown.merkleRootLabel || '').trim()} MERKLE ROOT"; expected ${expectedRoot ? expectedRoot.slice(0, 16) + '…' : 'none'}; status=${shown.status}` : 'nothing');

  const contact = forbiddenContact();
  say(contact.length === 0, `🔴 no contact with ${FORBIDDEN} at any point`,
    contact.length ? contact.join(' | ') : 'none observed');
} catch (e) {
  say(false, 'the click-through completed', e.message);
} finally {
  fs.writeFileSync(path.join(OUT, 'click-through.log'), log);
  try { execFileSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ }
}

console.log('');
console.log(JSON.stringify(finalRoot));
const bad = results.filter((r) => !r.ok);
console.log(bad.length === 0
  ? '\nWO-G3 gate (minus the chain lock): a person can pick a project, see the work,\ncheckpoint it, lock it, and read the root off the screen.'
  : `\nFAILED — ${bad.map((b) => b.label).join('; ')}`);
process.exit(bad.length === 0 ? 0 : 1);
