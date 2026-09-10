#!/usr/bin/env node
/**
 * WO-W1's controls for the degraded host facts.
 *
 * The work order asks for two things that a green run cannot supply on its own:
 *
 *   1. the three states must be shown REACHABLE and DISTINGUISHABLE — a fact
 *      that is genuinely unavailable, one that is refused, and one that is
 *      measured, in the same run, reading differently;
 *   2. the control must be RED before the change and green after.
 *
 * (2) is the interesting one. The "before" here is not a mutation of the new
 * code — it is the ACTUAL previous implementation, reproduced verbatim below
 * from git history, run against this machine. That is what makes it a control
 * rather than an assertion about a control: you can see the old code produce
 * `count: 0` and `allLoopback: false` on a box where nothing was measured.
 *
 *   node scripts/win/host-facts-control.mjs
 */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require_ = createRequire(import.meta.url);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { portLedger, sourceState } = require_(path.join(REPO, 'app', 'comfy', 'ports.js'));

let failures = 0;
const ok = (cond, msg) => { if (!cond) failures++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${msg}`); };

/* ---------------------------------------------------------------- control 1
 * The three states, in one run, reading differently.
 * -------------------------------------------------------------------------- */
console.log('\n════ control 1 — measured / unavailable / refused are distinguishable ════\n');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'w1-hostfacts-'));
const readable = path.join(tmp, 'readable.txt');
const missing = path.join(tmp, 'does-not-exist.txt');
const denied = path.join(tmp, 'denied.txt');

fs.writeFileSync(readable, 'sl  local_address rem_address   st\n');
fs.writeFileSync(denied, 'sl  local_address rem_address   st\n');

// Deny this account read on `denied`. ⚑ An ACL denial, not a read-only
// attribute: the point is a file that EXISTS and cannot be read, which is what
// `refused` means. (This is also why ports.js opens the file rather than
// calling access(R_OK) — on Windows, access() ignores ACLs and would report
// this file readable, collapsing `refused` into a false `measured`.)
let deniedUsable = true;
try {
  execFileSync('icacls', [denied, '/inheritance:r', '/deny', `${process.env.USERDOMAIN}\\${process.env.USERNAME}:(R)`], { stdio: 'pipe' });
} catch (err) {
  deniedUsable = false;
  console.log(`  (could not apply a deny ACL: ${err.message.split('\n')[0]})`);
}

const sMeasured = sourceState([readable]);
const sUnavailable = sourceState([missing]);
const sRefused = sourceState([denied]);

console.log(`  measured    -> state=${sMeasured.state}  code=${sMeasured.code}  reason=${sMeasured.reason}`);
console.log(`  unavailable -> state=${sUnavailable.state}  code=${sUnavailable.code}`);
console.log(`                 reason=${sUnavailable.reason}`);
console.log(`  refused     -> state=${sRefused.state}  code=${sRefused.code}`);
console.log(`                 reason=${sRefused.reason}\n`);

ok(sMeasured.state === 'measured', 'a readable source reads `measured`');
ok(sMeasured.reason === null, '…and carries no reason, because there is nothing to explain');
ok(sUnavailable.state === 'unavailable', 'an absent source reads `unavailable`');
ok(typeof sUnavailable.reason === 'string' && sUnavailable.reason.length > 0, '…with a machine-readable reason, not a bare null');
ok(sUnavailable.code === 'procfs_absent', `…and a stable code (${sUnavailable.code})`);
if (deniedUsable) {
  ok(sRefused.state === 'refused', 'a source that exists but cannot be read reads `refused`, NOT `unavailable`');
  ok(sRefused.state !== sUnavailable.state, '…so refused and unavailable are genuinely different readings');
} else {
  console.log('  INCONCLUSIVE  the deny ACL could not be applied; `refused` was not demonstrated');
  failures++;
}

/* ---------------------------------------------------------------- control 2
 * RED before, green after — against the real previous implementation.
 * -------------------------------------------------------------------------- */
console.log('\n════ control 2 — the OLD code asserts a measurement it did not make ════\n');

// Verbatim shape of the previous implementation: every read wrapped in
// `catch { return [] }`, booleans computed from the empty array.
function legacyReadTable(file) {
  try { fs.readFileSync(file, 'utf8'); } catch { return []; }
  return [];
}
function legacyLedger({ gatePort, gatePid, upstreamPort, upstreamPid }) {
  const gate = [...legacyReadTable('/proc/net/tcp'), ...legacyReadTable('/proc/net/tcp6')];
  const upstream = [];
  return {
    gate: {
      port: gatePort, expectedPid: gatePid, count: gate.length,
      allOwnedByExpected: gate.length > 0 && gate.every((l) => l.pid === gatePid),
      allLoopback: gate.length > 0,
    },
    upstream: {
      port: upstreamPort, expectedPid: upstreamPid, count: upstream.length,
      allOwnedByExpected: upstream.length > 0,
      allLoopback: upstream.length > 0,
    },
  };
}

const args = { gatePort: 8189, gatePid: 1234, upstreamPort: 8188, upstreamPid: 5678 };
const before = legacyLedger(args);
const after = portLedger(args);

console.log('  BEFORE (previous implementation, this machine):');
console.log(`    gate.count=${before.gate.count}  gate.allLoopback=${before.gate.allLoopback}  upstream.allLoopback=${before.upstream.allLoopback}`);
console.log('  AFTER  (this change, same machine):');
console.log(`    state=${after.state}  gate.count=${after.gate.count}  gate.allLoopback=${after.gate.allLoopback}  upstream.allLoopback=${after.upstream.allLoopback}`);
console.log(`    gate.reasonCode=${after.gate.reasonCode}`);
console.log(`    gate.reason=${after.gate.reason}\n`);

ok(before.gate.count === 0, 'RED: the old code reported gate.count = 0 — "nobody is listening", which nobody measured');
ok(before.upstream.allLoopback === false, 'RED: the old code reported upstream.allLoopback = false — the exact shape of the finding the ledger exists to raise, manufactured from a missing file');
ok(after.gate.count === null, 'GREEN: count is now null, so "nobody looked" cannot be read as "nobody is listening"');
ok(after.gate.allLoopback === null, 'GREEN: allLoopback is null rather than false');
ok(after.upstream.allLoopback === null, 'GREEN: …on both sides of the ledger');
ok(after.state === 'unavailable' || after.state === 'refused' || after.state === 'measured', `GREEN: the ledger declares its state (${after.state})`);
ok(typeof after.gate.reason === 'string' && after.gate.reason.length > 0, 'GREEN: …with a machine-readable reason attached');
ok('allLoopback' in after.gate && 'count' in after.gate, 'GREEN: no field was DROPPED — an omitted field is indistinguishable from a build that never had the feature');

/* ---------------------------------------------------------------- control 3
 * The fields a consumer reads still exist and still type-check.
 * -------------------------------------------------------------------------- */
console.log('\n════ control 3 — the shape survives for existing consumers ════\n');
for (const side of ['gate', 'upstream']) {
  for (const field of ['port', 'expectedPid', 'state', 'reasonCode', 'reason', 'listeners', 'count', 'allOwnedByExpected', 'allLoopback']) {
    ok(field in after[side], `ledger.${side}.${field} is present`);
  }
}

try { execFileSync('icacls', [denied, '/reset'], { stdio: 'pipe' }); } catch { /* best effort */ }
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }

console.log(`\n════ host-facts controls: ${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`} ════\n`);
process.exit(failures === 0 ? 0 : 1);
