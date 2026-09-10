// The pid the app records for ComfyUI is not the pid that serves it, and the
// kill that is supposed to stop it therefore misses.
//
// ⚑ WHERE THIS COMES FROM. `app/ipc-comfy.js` does
// `spawn(cfg.python, [main.py, …])` and keeps `comfy.pid` as "the ComfyUI we
// launched". Two things depend on that pid being right:
//
//   1. `portLedger`'s `allOwnedByExpected` — the assertion
//      `upstream-held-by-the-comfyui-we-launched`, which is how the app claims
//      the process on the upstream port is the one it started rather than
//      something that got there first.
//   2. `killSession()` and `comfy.kill('SIGTERM')`. The comment on
//      `shutdownComfy()` states the stake exactly: "a ComfyUI spawned by a
//      process that has exited does not exit with it — it keeps a port and
//      700 MB of torch. An overnight loop that leaks one per failed run stops
//      being an overnight loop."
//
// On Windows a virtualenv's `Scripts\python.exe` is a LAUNCHER STUB. It does
// not `exec` — Windows has no exec — it starts the real interpreter as a
// SEPARATE PROCESS. So the pid Node holds belongs to the stub.
//
//   node scripts/win/comfy-pid-probe.mjs
//
// VERIFY BY SIDE EFFECT. A real Python HTTP listener is started through the
// same venv interpreter the app uses, then killed the same way the app kills
// it, and the question is asked of the operating system afterwards:
//
//   observable  is the port still held after `.kill()` returned?
//   CONTROL     the same sequence against a listener started with the RESOLVED
//               interpreter (`sys.executable` reported by the stub's child)
//               must stop cleanly. If that also leaks, the leak is not about
//               the stub and this probe proves nothing about it.
//
// Nothing here touches the app's own sandbox, ComfyUI, or any configured port.

import { execFileSync, spawn } from 'node:child_process';
import net from 'node:net';

const VENV = process.env.SCRUPLE_PYTHON || 'C:\\SCRUPLEWORK\\comfyui\\.venv\\Scripts\\python.exe';

if (process.platform !== 'win32') {
  console.log(`this probe is about the win32 venv stub; platform is ${process.platform}`);
  process.exit(0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A free port, released before use — good enough for a probe. */
async function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** Who holds this port right now, per the OS. Structural parse: a listening
 *  row's FOREIGN address is the wildcard, which no locale translates. */
function holders(port) {
  let out;
  try {
    out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true });
  } catch {
    return null;
  }
  const rows = [];
  for (const line of out.split(/\r?\n/)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 5 || !/^TCP$/i.test(f[0])) continue;
    if (!['0.0.0.0:0', '[::]:0', '*:*'].includes(f[2])) continue;
    const i = f[1].lastIndexOf(':');
    if (Number(f[1].slice(i + 1)) !== port) continue;
    rows.push(Number(f[f.length - 1]));
  }
  return rows;
}

const SERVER = (port) =>
  'import http.server,os,sys,threading\n' +
  `print(os.getpid(), flush=True)\n` +
  `http.server.HTTPServer(("127.0.0.1", ${port}), http.server.SimpleHTTPRequestHandler).serve_forever()\n`;

async function trial(label, interpreter) {
  const port = await freePort();
  const child = spawn(interpreter, ['-c', SERVER(port)], { stdio: ['ignore', 'pipe', 'pipe'] });

  let selfPid = null;
  child.stdout.on('data', (d) => {
    const m = /^(\d+)/.exec(String(d).trim());
    if (m && selfPid === null) selfPid = Number(m[1]);
  });

  // Wait for it to actually be listening.
  for (let i = 0; i < 100 && (holders(port) || []).length === 0; i += 1) await sleep(100);

  const before = holders(port) || [];
  const spawnedPid = child.pid;

  // Exactly what the app does.
  child.kill('SIGTERM');
  await sleep(1500);

  const after = holders(port) || [];

  console.log(`\n── ${label}`);
  console.log(`   interpreter      : ${interpreter}`);
  console.log(`   node's child.pid : ${spawnedPid}`);
  console.log(`   python's own pid : ${selfPid ?? 'not reported'}`);
  console.log(`   pid(s) holding   : ${before.join(', ') || 'none'}`);
  console.log(`   pid matches      : ${before.includes(spawnedPid) ? 'YES' : 'NO — the recorded pid does not hold the port'}`);
  console.log(`   after kill()     : ${after.length ? `STILL HELD by ${after.join(', ')}` : 'released'}`);

  // Do not leave a listener behind either way.
  for (const pid of after) {
    try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { /* gone */ }
  }

  return { spawnedPid, selfPid, before, after, matched: before.includes(spawnedPid), leaked: after.length > 0 };
}

// What does the stub say the real interpreter is?
let resolved = null;
try {
  resolved = execFileSync(VENV, ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8', windowsHide: true }).trim();
} catch (e) {
  console.error(`cannot run ${VENV}: ${e.message}`);
  process.exit(2);
}

const base = execFileSync(VENV, ['-c', 'import sys; print(getattr(sys, "_base_executable", sys.executable))'], { encoding: 'utf8', windowsHide: true }).trim();

console.log(`venv python      : ${VENV}`);
console.log(`sys.executable   : ${resolved}`);
console.log(`_base_executable : ${base}`);

const viaVenv = await trial('through the venv stub — what the app does', VENV);
const viaBase = await trial('CONTROL — through the base interpreter directly', base);

console.log('\n════ result ════');
if (viaBase.leaked) {
  console.log(
    'INCONCLUSIVE — the control leaked too, so the leak is not attributable to the\n' +
    'venv stub. Something else on this machine is keeping the port.',
  );
  process.exit(2);
}
if (!viaVenv.matched && viaVenv.leaked) {
  console.log(
    '⚑ FINDING, both halves.\n' +
    `  The pid the app records (${viaVenv.spawnedPid}) is not the pid holding the port\n` +
    `  (${viaVenv.before.join(', ')}), so \`upstream-held-by-the-comfyui-we-launched\` cannot\n` +
    '  be satisfied — the app cannot show the process on the upstream port is the\n' +
    '  one it started.\n' +
    '  And killing that pid LEFT THE SERVER RUNNING. The control, launched through\n' +
    '  the resolved interpreter, stopped cleanly — so this is the venv stub.\n' +
    '  That is the leak `shutdownComfy()`\'s comment exists to prevent, made certain\n' +
    '  rather than merely possible, on the platform where an overnight loop runs.',
  );
} else if (!viaVenv.matched) {
  console.log(
    '⚑ FINDING (attribution only). The recorded pid does not hold the port, so the\n' +
    'ownership assertion cannot pass — but the kill still stopped the server, so the\n' +
    'leak half is NOT demonstrated and must not be claimed.',
  );
} else {
  console.log('No finding: the recorded pid holds the port and the kill released it.');
}
