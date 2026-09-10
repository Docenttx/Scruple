/**
 * ports.js — WHO IS LISTENING, read from the kernel.
 *
 * WO-D4 asks the app to know "the upstream address, the model directory, and
 * that nothing else is listening on it". The first two are configuration the
 * app chose. The third is not a thing you can choose: it is a fact about the
 * machine at a moment, and the only honest way to have it is to go and look.
 *
 * SO THIS DOES NOT PROBE, IT ENUMERATES. A `connect()` to the port would tell
 * us something answered — which is what the app already knows, having started
 * it — and would say nothing about whether a SECOND process is also bound, or
 * whether the upstream is reachable from outside this box. `/proc/net/tcp` and
 * `/proc/net/tcp6` list every listening socket with its local address and its
 * inode; `/proc/<pid>/fd` maps the inode to the process holding it. Both are
 * the kernel's own record.
 *
 * WHAT THE LEDGER IS FOR, precisely:
 *
 *   the gate port      exactly one listener, and it is the gate's pid. More
 *                      than one is impossible on the same address, but the
 *                      same PORT on a DIFFERENT address is not, and a second
 *                      binding on 0.0.0.0 beside ours on 127.0.0.1 is a
 *                      second route to the tenant.
 *   the upstream port  exactly one listener, it is the ComfyUI we launched,
 *                      and it is bound to LOOPBACK. An upstream on 0.0.0.0 is
 *                      a ComfyUI anything on the network can reach directly,
 *                      and every byte taken that way leaves through no gate
 *                      and gets no leaf. That is the property H-4 §2 calls
 *                      "the only route to the tenant", measured rather than
 *                      assumed.
 *
 * ⚑ IT IS A SNAPSHOT AND IT SAYS SO. `observedAt` is the only instant this
 * function can speak for — the same honesty the vault's snapshot carries. A
 * process that binds a second socket a second later is not covered by it, and
 * pretending otherwise would be worse than not looking.
 */

'use strict';

const fs = require('fs');
const { execFileSync } = require('child_process');

const LISTEN = '0A';

/* ------------------------------------------------------------------------ *
 * WINDOWS HAS THE SAME FACT, IN A DIFFERENT PLACE.
 *
 * The `unavailable` reading below used to say "a Windows equivalent would be
 * GetExtendedTcpTable or netstat -ano; WO-W1 puts that out of scope". It is in
 * scope now, and the reason it matters is not tidiness: with no ledger, the
 * `upstream-listens-wide` mutation — which launches ComfyUI on 0.0.0.0, a real
 * second route to the tenant that bypasses the gate — was NOT CAUGHT on
 * Windows. The scenario went green. That control is the only evidence for
 * H-4 §2's "the only route to the tenant", and an uncatchable control is scored
 * INCONCLUSIVE, never a pass.
 *
 * `netstat -ano` gives the same three things `/proc/net/tcp` plus `/proc/<pid>/fd`
 * give: local address, port, and the pid holding the socket. It needs no
 * elevation.
 *
 * 🔴 LISTENERS ARE IDENTIFIED BY STRUCTURE, NOT BY THE WORD "LISTENING".
 * That column is LOCALISED — German Windows prints `ABHÖREN`, French `À L'ÉCOUTE`
 * — so matching the English string would silently find zero listeners on a
 * non-English machine and report `count: 0`, which is the manufactured-false
 * reading this whole section exists to prevent. A listening TCP socket is
 * instead recognised by its FOREIGN address being the wildcard (`0.0.0.0:0` or
 * `[::]:0`), which no locale translates. The state token is captured anyway and
 * reported, so the record says what the OS called it.
 * ------------------------------------------------------------------------ */

/** `127.0.0.1:8188` / `[::1]:8188` / `[::]:8188` → { addr, port, family }. */
function parseWinAddr(text) {
  const v6 = /^\[(.+)\]:(\d+)$/.exec(text);
  if (v6) return { addr: v6[1].toLowerCase(), port: Number(v6[2]), family: 6 };
  const i = text.lastIndexOf(':');
  if (i < 0) return null;
  const port = Number(text.slice(i + 1));
  if (!Number.isInteger(port)) return null;
  return { addr: text.slice(0, i), port, family: 4 };
}

const WIN_WILDCARD_FOREIGN = new Set(['0.0.0.0:0', '[::]:0', '*:*']);

/** Every listening TCP socket Windows reports, with the pid holding it. */
function win32Listeners() {
  const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15000,
  });
  const rows = [];
  for (const line of out.split(/\r?\n/)) {
    const f = line.trim().split(/\s+/);
    // proto local foreign state pid
    if (f.length < 5) continue;
    if (!/^TCP$/i.test(f[0])) continue;
    if (!WIN_WILDCARD_FOREIGN.has(f[2])) continue;
    const local = parseWinAddr(f[1]);
    if (!local) continue;
    const pid = Number(f[f.length - 1]);
    if (!Number.isInteger(pid)) continue;
    rows.push({ ...local, pid, cmd: null, osState: f[3] });
  }
  return rows;
}

/**
 * Is `netstat -ano` actually usable, and if not, precisely why.
 *
 * The same three states as procfs, decided the same way: it ran and produced
 * parseable rows (`measured`), it exists but refused us (`refused`), or it is
 * not there (`unavailable`). ⚑ Zero rows is treated as `unavailable`, not as
 * "nothing is listening" — this process has a listening socket of its own by
 * the time anyone asks, so an empty table means the parse failed, and reporting
 * `count: 0` off it would be the false reading again.
 */
function win32SourceState() {
  const source = 'netstat -ano -p TCP';
  try {
    const rows = win32Listeners();
    if (rows.length === 0) {
      return {
        state: 'unavailable',
        code: 'netstat_no_rows',
        reason: `${source} ran but produced no listening rows; the output format was not recognised. Not reported as "nothing is listening": this process is itself listening.`,
        platform: process.platform,
        files: { [source]: { state: 'unavailable', code: 'netstat_no_rows', reason: null } },
      };
    }
    return {
      state: 'measured',
      code: null,
      reason: null,
      platform: process.platform,
      kind: 'netstat',
      files: { [source]: { state: 'measured', code: null, reason: null } },
    };
  } catch (err) {
    const code = (err && err.code) || 'UNKNOWN';
    const refused = code === 'EACCES' || code === 'EPERM';
    return {
      state: refused ? 'refused' : 'unavailable',
      code: refused ? 'netstat_unreadable' : 'netstat_absent',
      reason: refused
        ? `${source} exists but this process may not run it (${code})`
        : `${source} could not be run (${code}); no port ledger is possible on this host`,
      platform: process.platform,
      files: { [source]: { state: refused ? 'refused' : 'unavailable', code, reason: null } },
    };
  }
}

/* ------------------------------------------------------------------------ *
 * WO-W1: the reading has to survive a platform with no /proc, and it has to
 * survive it HONESTLY.
 *
 * ⚑ Before this, every read here was wrapped in `catch { return [] }`. On
 * Windows that produced a ledger reading `count: 0`, `allOwnedByExpected:
 * false`, `allLoopback: false` — which is not a degraded measurement, it is a
 * FALSE ONE. `count: 0` asserts that nobody is listening on the gate port. The
 * truth is that nobody looked. `allLoopback: false` is worse still: it is the
 * exact shape of the finding the ledger exists to raise ("an upstream on
 * 0.0.0.0 is reachable without passing the gate"), manufactured out of a
 * missing file.
 *
 * So the three WO-D5 states apply here, and they are DISTINGUISHED by why the
 * read did not happen, not merely by that it did not:
 *
 *   measured     the kernel tables are there and readable; the numbers are real
 *   refused      they exist and this process may not read them (EACCES/EPERM) —
 *                a permissions fact about this run, fixable by changing who runs
 *   unavailable  they are not there at all (ENOENT) — a fact about the platform,
 *                not fixable by permissions, and no port ledger is possible
 *
 * Every count and every boolean that cannot be measured is **null**, never
 * false and never absent. A reader can tell "nobody is listening" from "nobody
 * looked" without inferring it from a zero.
 * ------------------------------------------------------------------------ */

const PROC_SOURCES = ['/proc/net/tcp', '/proc/net/tcp6'];

/**
 * Can the kernel's socket tables be read at all, and if not, precisely why.
 *
 * `sources` is a parameter ONLY so the control in
 * scripts/win/host-facts-control.mjs can demonstrate all three states in one
 * run — WO-W1 requires that `measured`, `unavailable` and `refused` be shown to
 * be reachable and to read differently, and on a box with no /proc at all only
 * one of the three would ever occur naturally. Production callers pass nothing.
 */
function sourceState(sources = PROC_SOURCES) {
  // Windows has no procfs and never will; asking about it there would always
  // answer `unavailable` and hide a source that does work. The explicit
  // `sources` argument still routes to the procfs path so that
  // scripts/win/host-facts-control.mjs can demonstrate all three states here.
  if (process.platform === 'win32' && sources === PROC_SOURCES) {
    return win32SourceState();
  }
  const files = {};
  let readable = 0;
  let refused = 0;

  for (const file of sources) {
    try {
      // ⚑ An actual open(), not access(R_OK). On Windows, access() reports on
      // file ATTRIBUTES and largely ignores ACLs, so a file this process is
      // forbidden to read still answers "readable" — which would turn a
      // `refused` into a false `measured`. Opening it is the only answer that
      // cannot be wrong, and it is what the caller is about to do anyway.
      fs.closeSync(fs.openSync(file, 'r'));
      files[file] = { state: 'measured', code: null, reason: null };
      readable++;
    } catch (err) {
      const code = (err && err.code) || 'UNKNOWN';
      if (code === 'EACCES' || code === 'EPERM') {
        files[file] = {
          state: 'refused',
          code,
          reason: `${file} exists but this process may not read it (${code})`,
        };
        refused++;
      } else {
        files[file] = {
          state: 'unavailable',
          code,
          reason: `${file} is not present (${code}); platform ${process.platform} has no procfs`,
        };
      }
    }
  }

  if (readable === sources.length) {
    return { state: 'measured', code: null, reason: null, platform: process.platform, files };
  }
  // A partial read is not a measurement: tcp6 missing while tcp is readable
  // would hide every IPv6 listener and the ledger would look complete.
  if (refused > 0) {
    return {
      state: 'refused',
      code: 'procfs_unreadable',
      reason: `the kernel socket tables exist but are not readable by this process; ${refused} of ${sources.length} refused`,
      platform: process.platform,
      files,
    };
  }
  return {
    state: 'unavailable',
    code: 'procfs_absent',
    reason: `no procfs on platform ${process.platform}: the port ledger reads /proc/net/tcp, /proc/net/tcp6 and /proc/<pid>/fd, none of which exist here. A Windows equivalent would be GetExtendedTcpTable or netstat -ano; WO-W1 puts that out of scope, so this reading degrades rather than guessing.`,
    platform: process.platform,
    files,
  };
}

/** The side of the ledger we could not measure. Nulls, not falses. */
function unmeasuredSide(port, expectedPid, src) {
  return {
    port,
    expectedPid,
    state: src.state,
    reasonCode: src.code,
    reason: src.reason,
    listeners: null,
    count: null,
    allOwnedByExpected: null,
    ownership: null,
    allLoopback: null,
  };
}

/** '0100007F:1F90' → { addr: '127.0.0.1', port: 8080 }. IPv4 is little-endian
 *  per 32-bit word; IPv6 is four such words. */
function decodeAddr(hex, family) {
  const [addrHex, portHex] = hex.split(':');
  const port = parseInt(portHex, 16);
  if (family === 4) {
    const b = addrHex.match(/../g).reverse().map((h) => parseInt(h, 16));
    return { addr: b.join('.'), port };
  }
  // Four 32-bit words, each byte-reversed, then rendered as eight groups.
  const words = addrHex.match(/.{8}/g).map((w) => w.match(/../g).reverse().join(''));
  const flat = words.join('');
  const groups = flat.match(/.{4}/g).map((g) => g.replace(/^0+/, '') || '0');
  const full = groups.join(':');
  // ::ffff:7f00:0001 is IPv4-mapped loopback; rendered as what it is.
  const v4mapped = /^0:0:0:0:0:ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(full);
  if (v4mapped) {
    const hi = parseInt(v4mapped[1], 16), lo = parseInt(v4mapped[2], 16);
    return { addr: `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`, port };
  }
  return { addr: full, port };
}

function readTable(file, family) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const rows = [];
  for (const line of text.trim().split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10 || f[3] !== LISTEN) continue;
    const { addr, port } = decodeAddr(f[1], family);
    rows.push({ addr, port, family, inode: Number(f[9]) });
  }
  return rows;
}

/** inode → pid, by walking /proc. Processes we may not read are skipped, and
 *  a listener whose pid we could not resolve is reported with `pid: null`
 *  rather than dropped — "we could not tell" is not "nobody". */
function inodeOwners(inodes) {
  const want = new Set(inodes);
  const found = new Map();
  let pids;
  try { pids = fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d)); } catch { return found; }
  for (const pid of pids) {
    let fds;
    try { fds = fs.readdirSync(`/proc/${pid}/fd`); } catch { continue; }
    for (const fd of fds) {
      let link;
      try { link = fs.readlinkSync(`/proc/${pid}/fd/${fd}`); } catch { continue; }
      const m = /^socket:\[(\d+)\]$/.exec(link);
      if (!m) continue;
      const ino = Number(m[1]);
      if (!want.has(ino) || found.has(ino)) continue;
      let cmd = null;
      try { cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' '); } catch { /* gone */ }
      found.set(ino, { pid: Number(pid), cmd });
    }
  }
  return found;
}

/** Every listening socket on the given ports, with the process behind it. */
function listenersOn(ports) {
  const wanted = new Set(ports.map(Number));
  if (process.platform === 'win32') {
    // netstat already reports the owning pid, so there is no inode → pid walk.
    return win32Listeners().filter((r) => wanted.has(r.port));
  }
  const rows = [...readTable('/proc/net/tcp', 4), ...readTable('/proc/net/tcp6', 6)]
    .filter((r) => wanted.has(r.port));
  const owners = inodeOwners(rows.map((r) => r.inode));
  return rows.map((r) => ({ ...r, ...(owners.get(r.inode) || { pid: null, cmd: null }) }));
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '0:0:0:0:0:0:0:1']);

/* ------------------------------------------------------------------------ *
 * "THE COMFYUI WE LAUNCHED" IS A TREE, NOT A PID.
 *
 * ⚑ Measured on Windows: a virtualenv's `Scripts\python.exe` is a LAUNCHER
 * STUB. Windows has no `exec`, so it starts the real interpreter as a separate
 * process — `spawn()` returned pid 20356 while the socket was held by 1512
 * (scripts/win/comfy-pid-probe.mjs, with the base interpreter as the control:
 * there the pid matched exactly). So `comfy.pid` names the stub, and
 * `allOwnedByExpected` compared it to the holder and got `false` on every run,
 * mutated or not.
 *
 * 🔴 THE FIX IS NOT TO RELAX THE COMPARISON. "Some process holds the port" is
 * not the claim; the claim is that the process serving the tenant is the one
 * this app started, as against something that was already there or something
 * that replaced it. A descendant of the process we started IS that — a stub's
 * child is our ComfyUI — and an unrelated pid is not.
 *
 * So ownership is resolved against the process TREE and the ledger records
 * WHICH it found, in `ownership`: `exact`, `descendant`, `foreign`, or
 * `unresolved` when the parent map could not be read. A reader can tell a
 * launcher stub from a hijack, which a bare boolean cannot express.
 * ------------------------------------------------------------------------ */

/** pid → ppid for every process we can see, or null if that cannot be read. */
function processParents() {
  if (process.platform === 'win32') {
    try {
      // CIM rather than the deprecated `wmic`, and CSV rather than JSON so a
      // single-row result does not change shape.
      const out = execFileSync('powershell', [
        '-NoProfile', '-NonInteractive', '-Command',
        'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Csv -NoTypeInformation',
      ], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
      const map = new Map();
      for (const line of out.split(/\r?\n/).slice(1)) {
        const m = /^"?(\d+)"?,"?(\d+)"?$/.exec(line.trim());
        if (m) map.set(Number(m[1]), Number(m[2]));
      }
      return map.size ? map : null;
    } catch {
      return null;
    }
  }
  try {
    const map = new Map();
    for (const d of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(d)) continue;
      try {
        const stat = fs.readFileSync(`/proc/${d}/stat`, 'utf8');
        // comm can contain spaces and parentheses; ppid is the field after the
        // state letter, which follows the LAST ')'.
        const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        map.set(Number(d), Number(rest[1]));
      } catch { /* exited between readdir and read */ }
    }
    return map.size ? map : null;
  } catch {
    return null;
  }
}

/** `exact` | `descendant` | `foreign`, or `unresolved` with no parent map. */
function ownershipOf(pid, expectedPid, parents) {
  if (pid === expectedPid) return 'exact';
  if (!parents) return 'unresolved';
  const seen = new Set();
  let cur = parents.get(pid);
  while (cur !== undefined && cur !== 0 && !seen.has(cur)) {
    if (cur === expectedPid) return 'descendant';
    seen.add(cur);
    cur = parents.get(cur);
  }
  return 'foreign';
}

/**
 * Resolve every listener's relationship to the pid we expected.
 *
 * The parent map is only fetched when at least one listener is not an exact
 * match — on Linux that is the normal case and costs nothing, and on Windows it
 * avoids spawning PowerShell on every ledger read.
 */
function resolveOwnership(listeners, expectedPid) {
  if (listeners.length === 0) {
    return { listeners, allOwnedByExpected: false, ownership: 'foreign' };
  }
  const needTree = listeners.some((l) => l.pid !== expectedPid);
  const parents = needTree ? processParents() : null;
  const marked = listeners.map((l) => ({ ...l, ownership: ownershipOf(l.pid, expectedPid, parents) }));
  const kinds = new Set(marked.map((l) => l.ownership));
  return {
    listeners: marked,
    // A descendant of the process we started IS the process we started, for
    // this claim. `unresolved` is not accepted: we could not tell.
    allOwnedByExpected: marked.every((l) => l.ownership === 'exact' || l.ownership === 'descendant'),
    ownership: kinds.has('foreign') ? 'foreign'
      : kinds.has('unresolved') ? 'unresolved'
        : kinds.has('descendant') ? 'descendant' : 'exact',
  };
}

/**
 * The ledger the scenario asserts on.
 *
 * Everything here is a MEASUREMENT, including the counts. Nothing asserts;
 * `scripts/desktop-run.mjs` does that, in another process, and it can only do
 * it because these are numbers and pids rather than a verdict.
 */
function portLedger({ gatePort, gatePid, upstreamPort, upstreamPid }) {
  const source = sourceState();

  // No tables, no ledger. Returning the same shape with nulls keeps every
  // consumer's field lookups valid while making it impossible to read a
  // measurement out of this object that nobody took.
  if (source.state !== 'measured') {
    return {
      observedAt: new Date().toISOString(),
      state: source.state,
      source,
      gate: unmeasuredSide(gatePort, gatePid, source),
      upstream: unmeasuredSide(upstreamPort, upstreamPid, source),
    };
  }

  const gate = resolveOwnership(listenersOn([gatePort]), gatePid);
  const upstream = resolveOwnership(listenersOn([upstreamPort]), upstreamPid);
  return {
    observedAt: new Date().toISOString(),
    state: 'measured',
    source,
    gate: {
      port: gatePort,
      expectedPid: gatePid,
      state: 'measured',
      reasonCode: null,
      reason: null,
      listeners: gate.listeners,
      count: gate.listeners.length,
      // The process we started, holding the socket we published. A gate the app
      // did not start, on the port the app told the renderer to use, is the
      // shape of a hijack. `ownership` says whether that was the pid itself or
      // a child of it, so a launcher stub does not read as a hijack.
      allOwnedByExpected: gate.allOwnedByExpected,
      ownership: gate.ownership,
      allLoopback: gate.listeners.length > 0 && gate.listeners.every((l) => LOOPBACK.has(l.addr)),
    },
    upstream: {
      port: upstreamPort,
      expectedPid: upstreamPid,
      state: 'measured',
      reasonCode: null,
      reason: null,
      listeners: upstream.listeners,
      count: upstream.listeners.length,
      allOwnedByExpected: upstream.allOwnedByExpected,
      ownership: upstream.ownership,
      // THE ONE THAT MATTERS. A ComfyUI on 0.0.0.0 is reachable without
      // passing the gate, and an artifact taken that way has no leaf.
      allLoopback: upstream.listeners.length > 0 && upstream.listeners.every((l) => LOOPBACK.has(l.addr)),
    },
  };
}

module.exports = {
  portLedger, listenersOn, decodeAddr, sourceState,
  // Exported for scripts/win/port-ledger-win-control.mjs, which cross-checks
  // this parse against Get-NetTCPConnection — an independent source — and
  // against sockets it binds itself.
  win32Listeners, win32SourceState, parseWinAddr,
  processParents, ownershipOf, resolveOwnership,
};
