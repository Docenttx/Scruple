#!/usr/bin/env node
/**
 * W1-B — can the SHELL re-hash what NODE hashed?
 *
 * This is the sharp version of the trailing-dot / reserved-name probes in
 * ntfs-semantics.mjs, which came back surprisingly permissive: Node created
 * `trailingdot.txt.`, `CON`, and a 1059-character path without complaint. The
 * reason is that Node uses extended-length (`\\?\`) paths internally, which
 * bypass Win32 name normalisation and the 260-character limit.
 *
 * ⚑ SO THE INTERESTING QUESTION IS NOT WHETHER THE VAULT CAN HASH THESE. It is
 * whether ANYTHING ELSE CAN. `docs/WO-D3` stage 4 re-hashes every leaf "FROM THE
 * SHELL, independently of node, of the app and of the sidecar" — that
 * independence is the whole point of the control. If Node can hash a file that
 * `sha256sum` and `Get-FileHash` cannot address, then on Windows the control
 * cannot be run over exactly the files that need it most, and a vault could
 * contain entries no independent tool is able to verify.
 *
 *   node scripts/win/shell-asymmetry.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const GIT_SHA = 'C:\\Program Files\\Git\\usr\\bin\\sha256sum.exe';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w1b-asym-'));
console.log(`workspace: ${root}\n`);

const CASES = [
  { id: 'ordinary', name: 'ordinary.safetensors' },
  { id: 'trailing dot', name: 'trailingdot.safetensors.' },
  { id: 'trailing space', name: 'trailingspace.safetensors ' },
  { id: 'reserved CON', name: 'CON' },
  { id: 'reserved NUL.safetensors', name: 'NUL.safetensors' },
  { id: 'deep path (>260)', name: null },
];

const rows = [];
for (const c of CASES) {
  let full;
  if (c.id.startsWith('deep')) {
    let d = root;
    for (let i = 0; i < 5; i++) { d = path.join(d, 'y'.repeat(60) + i); fs.mkdirSync(d, { recursive: true }); }
    full = path.join(d, 'deep.safetensors');
  } else {
    full = path.join(root, c.name);
  }

  const payload = Buffer.from(`payload-for-${c.id}`);
  let nodeHash = null, nodeErr = null;
  try {
    fs.writeFileSync(full, payload);
    nodeHash = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex').slice(0, 16);
  } catch (err) { nodeErr = err.code; }

  // sha256sum, exactly as the gate scripts use it
  let shaOut = null;
  try {
    const o = execFileSync(GIT_SHA, [full], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    // ⚑ sha256sum ESCAPES its output line: when the filename contains a
    // backslash (i.e. every Windows path) it prefixes the whole line with `\`
    // and backslash-escapes the name. A naive parse reads that `\` as part of
    // the digest and reports a mismatch against a hash that is in fact
    // identical. This probe did exactly that on its first run and would have
    // filed "6 of 6 cannot be verified" when the true answer is different.
    shaOut = o.trim().replace(/^\\/, '').split(/\s+/)[0].slice(0, 16);
  } catch (err) {
    shaOut = `FAILED(${(err.stderr || '').toString().trim().split('\n')[0] || err.code})`;
  }

  // PowerShell Get-FileHash
  let psOut = null;
  try {
    const o = execFileSync('powershell', ['-NoProfile', '-Command',
      `try { (Get-FileHash -LiteralPath '${full.replace(/'/g, "''")}' -Algorithm SHA256).Hash } catch { "ERR:" + $_.Exception.GetType().Name }`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    psOut = o.trim();
    psOut = psOut.startsWith('ERR:') ? `FAILED(${psOut})` : psOut.toLowerCase().slice(0, 16);
  } catch (err) { psOut = `FAILED(${err.code})`; }

  const nodeOk = nodeHash !== null;
  const shaOk = shaOut === nodeHash;
  const psOk = psOut === nodeHash;
  rows.push({ case: c.id, pathLen: full.length, node: nodeErr ?? nodeHash, sha256sum: shaOut, getFileHash: psOut, agree: nodeOk && shaOk && psOk });

  console.log(`[${c.id}]  pathLen=${full.length}`);
  console.log(`   node        ${nodeErr ? `FAILED(${nodeErr})` : nodeHash}`);
  console.log(`   sha256sum   ${shaOut}${shaOk ? '' : '   <-- DISAGREES WITH NODE'}`);
  console.log(`   Get-FileHash ${psOut}${psOk ? '' : '   <-- DISAGREES WITH NODE'}`);
  console.log('');
}

// ⚑ Scored PER TOOL, because the two disagree with each other and the whole
// point is which independent verifier can still do its job. An earlier version
// of this script collapsed both into one "agree" flag and concluded that no
// shell tool could verify any of these — which is false, and would have
// condemned the gate's stage 4 on Windows without cause.
const shaOk = rows.filter((r) => r.sha256sum === r.node).length;
const psOk = rows.filter((r) => r.getFileHash === r.node).length;

console.log('════ summary ════');
console.log(`  ${'case'.padEnd(26)} sha256sum(MSYS)   Get-FileHash(.NET)`);
for (const r of rows) {
  console.log(`  ${r.case.padEnd(26)} ${(r.sha256sum === r.node ? 'agrees' : 'CANNOT READ').padEnd(17)} ${r.getFileHash === r.node ? 'agrees' : 'CANNOT READ'}`);
}
console.log(`\n  sha256sum (Git for Windows / MSYS) : ${shaOk}/${rows.length} verified`);
console.log(`  Get-FileHash (PowerShell / .NET)   : ${psOk}/${rows.length} verified`);
console.log('\n⚑ WO-D3 stage 4 re-hashes every leaf "FROM THE SHELL, independently of node".');
if (shaOk === rows.length) {
  console.log('  That control SURVIVES on Windows, but only because the gates use sha256sum');
  console.log('  from MSYS, which opens these names as happily as Node does. It is not a');
  console.log('  property of "the shell" — it is a property of THAT tool.');
}
if (psOk < rows.length) {
  console.log(`  A Windows-NATIVE verifier cannot do the same job: Get-FileHash fails on`);
  console.log(`  ${rows.length - psOk} of ${rows.length}. Anyone reimplementing the control in PowerShell -- the obvious`);
  console.log('  move on this platform -- would get silence, not an error, on exactly the');
  console.log('  hostile names that most need independent verification.');
}

fs.writeFileSync(path.join(process.cwd(), 'scripts', 'win', 'shell-asymmetry.json'),
  JSON.stringify({ platform: process.platform, node: process.version, at: new Date().toISOString(), rows }, null, 2));
try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* reserved names resist */ }
process.exit(0);
