// Does the Windows port ledger actually SEE what is listening — including the
// thing it exists to catch?
//
// ⚑ THE FACT THIS PROTECTS. `upstream-is-loopback-only` is H-4 §2's "the only
// route to the tenant": a ComfyUI bound to 0.0.0.0 is reachable without passing
// the capture gate, and every artifact taken that way has no leaf. Before the
// netstat source, Windows could not measure it, the `upstream-listens-wide`
// mutation was NOT caught, and `comfy-generate` went green anyway.
//
// So a green ledger is not enough. This binds real sockets and requires the
// ledger to tell them apart:
//
//   loopback socket on 127.0.0.1  → seen, owned by THIS pid, allLoopback true
//   wildcard socket on 0.0.0.0    → seen, owned by THIS pid, allLoopback FALSE
//
// 🔴 THE SECOND ONE IS THE CONTROL. If it does not come back false, the ledger
// cannot distinguish a confined upstream from an exposed one, and every
// confinement assertion on this platform is decoration. A run where it is not
// demonstrated is INCONCLUSIVE, not a pass.
//
// And the parse itself is cross-checked against `Get-NetTCPConnection`, which
// is a different mechanism (CIM, not text) and is NOT locale-dependent — the
// point being that `netstat`'s state column IS localised, which is why this
// parser keys on the wildcard foreign address instead.
//
//   node scripts/win/port-ledger-win-control.mjs

import { execFileSync } from 'node:child_process';
import net from 'node:net';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const require_ = createRequire(import.meta.url);
const { portLedger, listenersOn, sourceState, ownershipOf, processParents } =
  require_(join(REPO, 'app', 'comfy', 'ports.js'));

if (process.platform !== 'win32') {
  console.log(`this control is about the win32 source; platform is ${process.platform}`);
  process.exit(0);
}

const listen = (host) => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, host, () => resolve({ server: s, port: s.address().port }));
});

const problems = [];
const say = (ok, label, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail === undefined ? '' : `  ${JSON.stringify(detail)}`}`);
  if (!ok) problems.push(label);
};

const src = sourceState();
console.log(`source: ${src.state}${src.kind ? ` (${src.kind})` : ''}${src.code ? ` ${src.code}` : ''}`);
if (src.state !== 'measured') {
  console.log(`\nINCONCLUSIVE — the source is ${src.state}: ${src.reason}`);
  process.exit(2);
}

const loop = await listen('127.0.0.1');
const wide = await listen('0.0.0.0');

try {
  const me = process.pid;

  // ── 1. Both sockets are found at all, and attributed to this process. ────
  const seenLoop = listenersOn([loop.port]);
  const seenWide = listenersOn([wide.port]);
  say(seenLoop.length > 0, 'the loopback socket is seen', seenLoop.map((l) => `${l.addr}:${l.port} pid=${l.pid}`));
  say(seenWide.length > 0, 'the wildcard socket is seen', seenWide.map((l) => `${l.addr}:${l.port} pid=${l.pid}`));
  say(seenLoop.every((l) => l.pid === me), 'the loopback socket is attributed to THIS pid', { me });
  say(seenWide.every((l) => l.pid === me), 'the wildcard socket is attributed to THIS pid', { me });

  // ── 2. The ledger's verdicts. ───────────────────────────────────────────
  const confined = portLedger({
    gatePort: loop.port, gatePid: me, upstreamPort: loop.port, upstreamPid: me,
  });
  say(confined.state === 'measured', 'a ledger over the loopback socket is MEASURED', confined.state);
  say(confined.upstream.allLoopback === true, 'and it reads allLoopback = true', confined.upstream.allLoopback);
  say(confined.upstream.allOwnedByExpected === true, 'and the owner is the expected pid', confined.upstream.allOwnedByExpected);
  say(confined.upstream.count === seenLoop.length, 'and the count matches the listener list', confined.upstream.count);

  const exposed = portLedger({
    gatePort: loop.port, gatePid: me, upstreamPort: wide.port, upstreamPid: me,
  });
  // 🔴 THE CONTROL.
  say(
    exposed.upstream.allLoopback === false,
    '🔴 CONTROL — a 0.0.0.0 upstream reads allLoopback = FALSE',
    { allLoopback: exposed.upstream.allLoopback, addrs: exposed.upstream.listeners.map((l) => l.addr) },
  );
  say(
    exposed.upstream.allOwnedByExpected === true,
    'and it is still correctly attributed — exposure is not confused with a hijack',
    exposed.upstream.allOwnedByExpected,
  );

  // ── 3. A pid that is NOT the owner must not be accepted. ────────────────
  const wrongPid = portLedger({
    gatePort: loop.port, gatePid: me, upstreamPort: loop.port, upstreamPid: me + 100000,
  });
  say(
    wrongPid.upstream.allOwnedByExpected === false,
    'CONTROL — a socket held by a different pid reads allOwnedByExpected = false',
    wrongPid.upstream.allOwnedByExpected,
  );

  // ── 4. A port nobody is on. ─────────────────────────────────────────────
  const closed = await listen('127.0.0.1');
  const freePort = closed.port;
  await new Promise((r) => closed.server.close(r));
  const empty = portLedger({ gatePort: freePort, gatePid: me, upstreamPort: freePort, upstreamPid: me });
  say(empty.upstream.count === 0, 'a port with no listener counts 0 — measured, not null', empty.upstream.count);
  say(empty.upstream.state === 'measured', 'and it is still state=measured', empty.upstream.state);

  // ── 4b. Ownership is resolved against the process TREE. ─────────────────
  // A venv's Scripts\python.exe is a launcher stub: it starts the real
  // interpreter as a SEPARATE process, so the pid the app recorded is a parent
  // of the pid holding the port. That must read as ownership, and an unrelated
  // pid must not.
  const parents = processParents();
  say(parents !== null && parents.size > 0, 'the process tree can be read at all', parents ? parents.size : null);
  if (parents) {
    const myParent = parents.get(me);
    say(ownershipOf(me, me, parents) === 'exact', 'a pid is `exact` against itself');
    say(
      myParent !== undefined && ownershipOf(me, myParent, parents) === 'descendant',
      'this process is a `descendant` of its own parent',
      { me, myParent },
    );
    // 🔴 The control for the tree walk: PID 4 is the Windows System process and
    // is not an ancestor of anything user-launched.
    say(
      ownershipOf(me, 4, parents) === 'foreign',
      '🔴 CONTROL — an unrelated pid reads `foreign`, so the walk is not "always yes"',
      ownershipOf(me, 4, parents),
    );
    say(
      ownershipOf(me, me + 999999, parents) === 'foreign',
      'CONTROL — a pid that does not exist reads `foreign`',
    );
  }

  // ── 5. Cross-check the parse against an independent, non-localised source. ─
  let cim = null;
  try {
    const out = execFileSync('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Get-NetTCPConnection -State Listen | Where-Object { $_.LocalPort -in @(${loop.port},${wide.port}) } | ` +
      'Select-Object LocalAddress,LocalPort,OwningProcess | ConvertTo-Json -Compress',
    ], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
    const parsed = JSON.parse(out.trim() || 'null');
    cim = parsed === null ? [] : (Array.isArray(parsed) ? parsed : [parsed]);
  } catch (e) {
    console.log(`  (Get-NetTCPConnection unavailable: ${String(e.message).split('\n')[0]})`);
  }

  if (cim === null) {
    console.log('ok    cross-check SKIPPED — no independent source available; not scored as agreement');
  } else {
    const ours = [...listenersOn([loop.port]), ...listenersOn([wide.port])];
    const key = (a, p) => `${String(a).toLowerCase().replace(/^::ffff:/, '')}:${p}`;
    const oursSet = new Set(ours.map((l) => key(l.addr, l.port)));
    const cimSet = new Set(cim.map((c) => key(c.LocalAddress, c.LocalPort)));
    const missing = [...cimSet].filter((k) => !oursSet.has(k));
    say(missing.length === 0, 'the netstat parse finds every socket Get-NetTCPConnection finds', { missing, ours: [...oursSet], cim: [...cimSet] });
    const pidsAgree = cim.every((c) => {
      const m = ours.find((l) => key(l.addr, l.port) === key(c.LocalAddress, c.LocalPort));
      return !m || m.pid === c.OwningProcess;
    });
    say(pidsAgree, 'and the two sources agree on the owning pid');
  }
} finally {
  await new Promise((r) => loop.server.close(r));
  await new Promise((r) => wide.server.close(r));
}

console.log('');
if (problems.length) {
  console.log(`FAILED — ${problems.length} check(s): ${problems.join('; ')}`);
  process.exit(1);
}
console.log(
  'The Windows ledger measures, attributes, and — the control — distinguishes a\n' +
  '0.0.0.0 upstream from a confined one. `upstream-listens-wide` is catchable here.',
);
