#!/usr/bin/env node
/**
 * W1-D — does a SIGTERM handler run on Windows?
 *
 * `app/ipc-comfy.js` stops the capture gate like this, and says why:
 *
 *     // SIGTERM, not SIGKILL: the gate's handler drains the queue and writes
 *     // the result file. Killing it would lose every enrichment record and any
 *     // event store-and-forward was still holding.
 *     if (gate && gate.exitCode === null) gate.kill('SIGTERM');
 *
 * The whole graceful-shutdown contract rests on that handler running. On
 * Windows there are no POSIX signals; `child.kill('SIGTERM')` maps to
 * TerminateProcess, which is unconditional. If that is what happens here, the
 * comment describes the Linux behaviour and the Windows behaviour is precisely
 * the outcome the comment says it is avoiding.
 *
 * ⚑ MEASURED, NOT ASSERTED, AND WITH A CONTROL. A child that simply fails to
 * write its file proves nothing on its own — it might have crashed, or never
 * reached its handler for an unrelated reason. So the same child, in the same
 * script, is also asked to write the file on a normal path. If the control
 * writes and the signalled one does not, the handler is what did not run.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w1d-sigterm-'));
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// A stand-in for the gate: it installs a SIGTERM handler that "drains" by
// writing a result file, exactly as the real gate does.
const CHILD = `
const fs = require('node:fs');
const out = process.argv[2];
const mode = process.argv[3];
process.on('SIGTERM', () => {
  fs.writeFileSync(out, JSON.stringify({ drained: true, via: 'SIGTERM handler' }));
  process.exit(0);
});
if (mode === 'control') {
  // The control path: the same write, reached without any signal at all.
  setTimeout(() => {
    fs.writeFileSync(out, JSON.stringify({ drained: true, via: 'normal exit' }));
    process.exit(0);
  }, 300);
}
process.stdout.write('ready\\n');
setInterval(() => {}, 1000);
`;

const childPath = path.join(dir, 'gate-stub.cjs');
fs.writeFileSync(childPath, CHILD);

async function run(label, mode, signal) {
  const out = path.join(dir, `${label}.json`);
  const child = spawn(process.execPath, [childPath, out, mode], { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((r) => child.stdout.once('data', r)); // wait for 'ready'

  if (signal) {
    await delay(150);
    child.kill(signal);
  }
  const code = await new Promise((r) => child.on('close', (c, s) => r(s ? `signal:${s}` : c)));
  await delay(200);

  const wrote = fs.existsSync(out);
  const body = wrote ? JSON.parse(fs.readFileSync(out, 'utf8')) : null;
  console.log(`[${label}]`);
  console.log(`   signal sent : ${signal ?? '(none)'}`);
  console.log(`   exit        : ${code}`);
  console.log(`   result file : ${wrote ? `WRITTEN — ${body.via}` : 'NOT WRITTEN'}`);
  console.log('');
  return wrote;
}

console.log(`platform: ${process.platform}   node: ${process.version}\n`);

const control = await run('control (no signal, normal path)', 'control', null);
const term = await run('SIGTERM (what ipc-comfy.js sends)', 'signal', 'SIGTERM');
const kill = await run('SIGKILL (for contrast)', 'signal', 'SIGKILL');

console.log('════ verdict ════');
if (!control) {
  console.log('INCONCLUSIVE — the control did not write either, so nothing here is attributable');
  process.exit(3);
}
console.log('  control wrote the file, so the child and the write path work.');
if (term) {
  console.log('  SIGTERM handler RAN — graceful shutdown works on this platform.');
} else {
  console.log('  🔴 SIGTERM handler DID NOT RUN. The child was terminated outright.');
  console.log('     On this platform `kill("SIGTERM")` is indistinguishable from SIGKILL,');
  console.log('     so app/ipc-comfy.js\'s drain never happens: no queue drain, no result');
  console.log('     file, and every enrichment record the gate was holding is lost —');
  console.log('     which is exactly what its comment says SIGTERM was chosen to avoid.');
}
console.log(`  SIGKILL handler ran: ${kill ? 'yes (unexpected)' : 'no (expected)'}`);

try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
process.exit(0);
