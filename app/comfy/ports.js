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

const LISTEN = '0A';

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
  const rows = [...readTable('/proc/net/tcp', 4), ...readTable('/proc/net/tcp6', 6)]
    .filter((r) => wanted.has(r.port));
  const owners = inodeOwners(rows.map((r) => r.inode));
  return rows.map((r) => ({ ...r, ...(owners.get(r.inode) || { pid: null, cmd: null }) }));
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '0:0:0:0:0:0:0:1']);

/**
 * The ledger the scenario asserts on.
 *
 * Everything here is a MEASUREMENT, including the counts. Nothing asserts;
 * `scripts/desktop-run.mjs` does that, in another process, and it can only do
 * it because these are numbers and pids rather than a verdict.
 */
function portLedger({ gatePort, gatePid, upstreamPort, upstreamPid }) {
  const gate = listenersOn([gatePort]);
  const upstream = listenersOn([upstreamPort]);
  return {
    observedAt: new Date().toISOString(),
    gate: {
      port: gatePort,
      expectedPid: gatePid,
      listeners: gate,
      count: gate.length,
      // The pid we started, holding the socket we published. A gate the app
      // did not start, on the port the app told the renderer to use, is the
      // shape of a hijack.
      allOwnedByExpected: gate.length > 0 && gate.every((l) => l.pid === gatePid),
      allLoopback: gate.length > 0 && gate.every((l) => LOOPBACK.has(l.addr)),
    },
    upstream: {
      port: upstreamPort,
      expectedPid: upstreamPid,
      listeners: upstream,
      count: upstream.length,
      allOwnedByExpected: upstream.length > 0 && upstream.every((l) => l.pid === upstreamPid),
      // THE ONE THAT MATTERS. A ComfyUI on 0.0.0.0 is reachable without
      // passing the gate, and an artifact taken that way has no leaf.
      allLoopback: upstream.length > 0 && upstream.every((l) => LOOPBACK.has(l.addr)),
    },
  };
}

module.exports = { portLedger, listenersOn, decodeAddr };
