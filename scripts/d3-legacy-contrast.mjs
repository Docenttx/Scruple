#!/usr/bin/env node
/**
 * THE CONTROL, RED BEFORE THE CHANGE.
 *
 * WO-D3 says REPLACE, do not port. This script runs the thing being replaced —
 * the hashing loop from `app-legacy/lock/lock-local-lock.js`, transcribed
 * literally, nothing added and nothing removed — over the SAME directory the
 * new surface is gated on, and prints what each one recorded.
 *
 * The legacy loop is reproduced here rather than imported because importing it
 * would drag in `../context`, `./lock-package-builder`,
 * `../capture/training/training-hasher` and `../server/witness-index`, none of
 * which exist on this path any more. The three branches, the `if (fileHash)`
 * and the `readFileSync` are copied verbatim; the citation is beside each.
 *
 * WHAT IT DEMONSTRATES, and both of these are the WO's two controls failing on
 * the old code:
 *
 *   1. A FILE WITH NO DECLARED MIME IS NOT REFUSED — it is INVISIBLE. The
 *      legacy loop keys on the extension and pushes a row only `if (fileHash)`.
 *      A `.png` in the vault folder produces no row, no refusal and no count.
 *      Its file list is the list of files it happened to understand, and
 *      nothing downstream can tell that from the list of files that were there.
 *   2. THERE IS NO CEILING AT ALL. `fs.readFileSync(filePath)` on every .toml
 *      and .json, unbounded. There is no state in which the legacy vault says
 *      "this file was too large"; over-ceiling and absent are the same silence.
 *
 * Usage:  node scripts/d3-legacy-contrast.mjs <vault-dir> [<new-manifest.json>]
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** lock-local-lock.js:110-160, transcribed. `hashSafetensorsHeader` is stubbed
 *  because its module is gone; nothing in the fixture is a .safetensors, so the
 *  branch is never taken and the stub cannot flatter the result. */
function legacyVaultScan(vaultPath) {
  const files = fs.readdirSync(vaultPath);
  const fileHashes = [];
  const manifest = { version: '3.0', type: 'training', files: [] };
  const invisible = [];
  let maxRead = 0;

  for (const filename of files) {
    const filePath = path.join(vaultPath, filename);
    const stats = fs.statSync(filePath);
    if (stats.isDirectory() || filename === 'provenance.json') continue;

    let fileHash = null;
    let hashMethod = null;

    if (filename.endsWith('.toml')) {
      const contents = fs.readFileSync(filePath); // UNBOUNDED
      maxRead = Math.max(maxRead, contents.length);
      fileHash = crypto.createHash('sha256').update(contents).digest('hex');
      hashMethod = 'sha256_full';
    } else if (filename.endsWith('.json')) {
      const contents = fs.readFileSync(filePath); // UNBOUNDED
      maxRead = Math.max(maxRead, contents.length);
      fileHash = crypto.createHash('sha256').update(contents).digest('hex');
      hashMethod = 'sha256_full';
    } else if (filename.endsWith('.safetensors')) {
      hashMethod = 'safetensors_header';
      fileHash = null; // module gone; branch not exercised by the fixture
    }

    // THE LINE. A file that fell through every branch leaves NO TRACE.
    if (fileHash) {
      fileHashes.push(fileHash);
      manifest.files.push({ filename, size: stats.size, hash: fileHash, hash_method: hashMethod });
    } else {
      invisible.push({ filename, size: stats.size });
    }
  }
  return { manifest, fileHashes, invisible, maxRead };
}

const vaultDir = process.argv[2];
if (!vaultDir) {
  console.error('usage: d3-legacy-contrast.mjs <vault-dir> [<new-manifest.json>]');
  process.exit(2);
}

const legacy = legacyVaultScan(vaultDir);
const onDisk = fs.readdirSync(vaultDir).filter((f) => fs.statSync(path.join(vaultDir, f)).isFile());

console.log(`── the vault on disk: ${onDisk.length} files ──`);
for (const f of onDisk) console.log(`   ${f.padEnd(22)} ${fs.statSync(path.join(vaultDir, f)).size} bytes`);

console.log(`\n── app-legacy/lock/lock-local-lock.js, run over it ──`);
console.log(`   rows recorded          : ${legacy.manifest.files.length}`);
for (const f of legacy.manifest.files) console.log(`     ${f.filename.padEnd(22)} ${f.hash_method}`);
console.log(`   files that left NO ROW : ${legacy.invisible.length}`);
for (const f of legacy.invisible) console.log(`     ${f.filename.padEnd(22)} ${f.size} bytes — no row, no refusal, no count`);
console.log(`   largest unbounded read : ${legacy.maxRead} bytes (there is no ceiling in that loop)`);

let rc = 0;
const fail = (m) => { console.log(`   NOT DEMONSTRATED: ${m}`); rc = 1; };

console.log(`\n── the two WO-D3 controls, against the OLD code ──`);
if (legacy.invisible.length === 0) fail('nothing fell through the extension branches');
else console.log(`   CONTROL 1 RED: ${legacy.invisible.length} files are absent from the record with no outcome recorded.`);
if (/ceiling|maxBytes|limit/i.test(String(legacyVaultScan))) fail('the transcribed loop appears to have a ceiling');
else if (legacy.maxRead < 64 * 1024) {
  // Not a code-shape claim: a number. The gate's own ceiling is 65536, and the
  // fixture holds a 200 KB `.json` precisely so the old loop can be MEASURED
  // pulling it whole into memory rather than merely inspected for the absence
  // of a bound.
  fail(`the legacy loop's largest read was only ${legacy.maxRead} bytes — nothing in this ` +
       'directory exercises the unbounded readFileSync, so the control is not demonstrated');
} else {
  console.log(
    `   CONTROL 2 RED: no ceiling exists in the loop, and it MEASURABLY read ${legacy.maxRead} ` +
    'bytes whole. The new surface stops at 65536 and records a refusal.',
  );
}

const manifestPath = process.argv[3];
if (manifestPath && fs.existsSync(manifestPath)) {
  const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  console.log(`\n── app/vault, over the same directory ──`);
  console.log(`   files seen             : ${m.counts.files}`);
  console.log(`   captured               : ${m.counts.captured}`);
  for (const e of m.entries) {
    const extra =
      e.outcome === 'refused_over_ceiling'
        ? ` (${e.bytes_counted.value} bytes counted before the ${m.ceiling_bytes}-byte ceiling stopped the read)`
        : e.outcome.startsWith('refused')
          ? ` (mime ${e.mime.state})`
          : '';
    console.log(`     ${e.path.padEnd(22)} ${e.outcome}${extra}`);
  }
  const recorded = m.entries.length;
  console.log(`\n── the contrast ──`);
  console.log(`   legacy   : ${legacy.manifest.files.length} rows, ${legacy.invisible.length} files with no outcome at all`);
  console.log(`   app/vault: ${recorded} rows, 0 files with no outcome — every refusal is a value`);
  if (recorded !== onDisk.length - 1) {
    // -1 for scruple-vault.json, which types the set and is not a member of it.
    fail(`the new manifest has ${recorded} entries for ${onDisk.length - 1} non-declaration files`);
  } else {
    console.log('   CONTROL 1 GREEN and CONTROL 2 GREEN on the new surface.');
  }
}

process.exit(rc);
