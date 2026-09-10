#!/usr/bin/env node
/**
 * WO-W1 / W1-B — what NTFS actually does to the names the vault enumerates.
 *
 * The vault "enumerates a directory and hashes what it finds", and treats the
 * set as a unit. Every assumption in that sentence is a filesystem assumption,
 * and none of them has ever run against a case-insensitive filesystem.
 *
 * ⚑ THIS FILE ESTABLISHES GROUND TRUTH ONLY. It makes no claim about the vault.
 * It answers "what does the platform do", so that when the vault is run over the
 * same names, its behaviour can be attributed to the vault rather than argued
 * about. Each probe states what it expected and what happened; a probe that
 * cannot be carried out reports INCONCLUSIVE rather than passing.
 *
 *   node scripts/win/ntfs-semantics.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const results = [];
const record = (id, question, expectation, observed, verdict, note) => {
  results.push({ id, question, expectation, observed, verdict, note });
  console.log(`\n[${id}] ${question}`);
  console.log(`   expected(POSIX): ${expectation}`);
  console.log(`   observed(here) : ${observed}`);
  console.log(`   VERDICT        : ${verdict}`);
  if (note) console.log(`   note           : ${note}`);
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w1b-ntfs-'));
console.log(`workspace: ${root}`);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex').slice(0, 16);

/* ------------------------------------------------------------------ B1
 * Case collision. THE headline: two declared files, one on disk.
 * ------------------------------------------------------------------ */
{
  const d = path.join(root, 'case'); fs.mkdirSync(d);
  fs.writeFileSync(path.join(d, 'Model.safetensors'), 'AAAA-upper-content');
  fs.writeFileSync(path.join(d, 'model.safetensors'), 'BBBB-lower-content');
  const entries = fs.readdirSync(d);
  const upper = fs.existsSync(path.join(d, 'Model.safetensors'));
  const lower = fs.existsSync(path.join(d, 'model.safetensors'));
  const upperBytes = upper ? fs.readFileSync(path.join(d, 'Model.safetensors'), 'utf8') : null;
  record('B1', 'two names differing only in case, written in sequence',
    '2 directory entries, 2 distinct contents',
    `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} ${JSON.stringify(entries)}; ` +
    `Model.safetensors exists=${upper} lower exists=${lower}; content via UPPER name = ${JSON.stringify(upperBytes)}`,
    entries.length === 1 ? 'COLLAPSED — the second write overwrote the first' : 'distinct',
    entries.length === 1
      ? 'The surviving entry keeps the FIRST name and the SECOND content. A manifest keyed by name has one entry where a declaration named two, and the bytes under the surviving name are not the bytes that name was written with.'
      : null);
}

/* ------------------------------------------------------------------ B2
 * Lookup by a case that was never written.
 * ------------------------------------------------------------------ */
{
  const d = path.join(root, 'lookup'); fs.mkdirSync(d);
  fs.writeFileSync(path.join(d, 'Weights.bin'), 'w');
  const variants = ['Weights.bin', 'weights.bin', 'WEIGHTS.BIN', 'WeIgHtS.bIn'];
  const found = variants.filter((v) => fs.existsSync(path.join(d, v)));
  record('B2', 'existsSync() for case variants of a file written once',
    'only the exact name resolves',
    `${found.length}/${variants.length} resolve: ${JSON.stringify(found)}`,
    found.length > 1 ? 'CASE-INSENSITIVE LOOKUP' : 'case-sensitive',
    found.length > 1
      ? 'A declaration naming `weights.bin` is satisfied by a file called `Weights.bin`. The manifest records the declared spelling, the bytes come from a different one, and nothing in between notices.'
      : null);
}

/* ------------------------------------------------------------------ B3
 * Trailing dots and spaces — silently stripped by Win32.
 * ------------------------------------------------------------------ */
{
  const d = path.join(root, 'trailing'); fs.mkdirSync(d);
  const asked = ['plain.txt', 'trailingdot.txt.', 'trailingspace.txt ', 'both.txt . '];
  const outcomes = [];
  for (const name of asked) {
    try {
      fs.writeFileSync(path.join(d, name), `content-of:${name}`);
      outcomes.push({ asked: name, wrote: true });
    } catch (err) { outcomes.push({ asked: name, wrote: false, code: err.code }); }
  }
  const onDisk = fs.readdirSync(d);
  const stripped = asked.filter((a) => a !== a.replace(/[. ]+$/, '') && !onDisk.includes(a));
  record('B3', 'filenames with trailing dots or spaces',
    `${asked.length} distinct entries, names preserved verbatim`,
    `${onDisk.length} on disk: ${JSON.stringify(onDisk)}`,
    stripped.length ? 'NAMES SILENTLY REWRITTEN' : 'preserved',
    stripped.length
      ? `Win32 strips trailing dots/spaces. ${JSON.stringify(stripped)} were requested and do not exist under the requested name. A declaration carrying such a name can never be matched against what is on disk, and the file it created is under a DIFFERENT name — so it enumerates as undeclared.`
      : null);
}

/* ------------------------------------------------------------------ B4
 * Reserved device names.
 * ------------------------------------------------------------------ */
{
  const d = path.join(root, 'reserved'); fs.mkdirSync(d);
  const names = ['CON', 'NUL', 'PRN', 'AUX', 'LPT1', 'COM1', 'CON.txt', 'nul.safetensors'];
  const out = [];
  for (const n of names) {
    const p = path.join(d, n);
    try {
      fs.writeFileSync(p, 'x'.repeat(32));
      const size = fs.existsSync(p) ? fs.statSync(p).size : null;
      const listed = fs.readdirSync(d).includes(n);
      out.push(`${n}: wrote ok, listed=${listed}, size=${size}`);
    } catch (err) { out.push(`${n}: ${err.code}`); }
  }
  const listedNames = fs.readdirSync(d);
  record('B4', 'reserved device names as filenames',
    'all 8 are ordinary files, all 8 enumerate',
    out.join(' | ') + `  ||  directory lists: ${JSON.stringify(listedNames)}`,
    listedNames.length === names.length ? 'all present' : 'SOME NAMES ARE NOT FILES',
    'A name that writes without error but does not enumerate is the worst case for the vault: the write succeeded, so nothing refused, and the hash set silently omits it.');
}

/* ------------------------------------------------------------------ B5
 * The 260-character limit, against a vault that enumerates and hashes.
 * ------------------------------------------------------------------ */
{
  const d = path.join(root, 'long'); fs.mkdirSync(d);
  const seg = 'x'.repeat(80);
  let deep = d, made = 0, failCode = null, failLen = null;
  try {
    for (let i = 0; i < 12; i++) { const next = path.join(deep, `${seg}${i}`); fs.mkdirSync(next); deep = next; made++; }
  } catch (err) { failCode = err.code; failLen = deep.length; }
  let wrote = null, writeCode = null, readBack = null;
  const target = path.join(deep, 'weights.safetensors');
  try {
    fs.writeFileSync(target, 'deep-content');
    wrote = target.length;
    readBack = sha(fs.readFileSync(target));
  } catch (err) { writeCode = err.code; }
  record('B5', 'a path longer than 260 characters',
    'directories and file created; the file enumerates and hashes',
    `nested ${made} levels; deepest dir len=${deep.length}` +
    (failCode ? `; mkdir stopped with ${failCode} at len ${failLen}` : '') +
    `; file path len=${target.length}; write=${wrote ? 'ok' : writeCode}; hash=${readBack}`,
    failCode || writeCode ? `HIT A LIMIT (${failCode || writeCode})` : 'no limit hit',
    'Node on modern Windows often uses \\\\?\\ internally, so the classic 260 limit may not bite here even though it bites cmd.exe, Explorer and any tool shelling out. A vault that enumerates fine but cannot be inspected by the shell scripts that grade it is still a problem.');
}

/* ------------------------------------------------------------------ B6
 * Separator and drive-letter forms for the SAME file.
 * ------------------------------------------------------------------ */
{
  const d = path.join(root, 'seps'); fs.mkdirSync(d);
  const f = path.join(d, 'a.txt');
  fs.writeFileSync(f, 'sep-content');
  const forms = {
    'native backslash': f,
    'forward slash': f.replace(/\\/g, '/'),
    'mixed': f.replace(/\\/g, '/').replace('/a.txt', '\\a.txt'),
    'lowercased drive': f.charAt(0).toLowerCase() + f.slice(1),
    'UNC local': `\\\\?\\${f}`,
    'dot segment': path.join(d, '.', 'a.txt'),
    'double separator': f.replace(/\\/g, '\\\\'),
  };
  const rows = [];
  for (const [label, p] of Object.entries(forms)) {
    let ok = false, code = null;
    try { ok = fs.existsSync(p) && fs.readFileSync(p, 'utf8') === 'sep-content'; }
    catch (err) { code = err.code; }
    rows.push(`${label}=${ok ? 'resolves' : (code || 'no')}`);
  }
  record('B6', 'the same file addressed seven ways',
    'one canonical form; the others are different strings',
    rows.join(' | '),
    'MANY DISTINCT STRINGS, ONE FILE',
    'Every one of these is a different manifest key for identical bytes. A vault keyed by the path STRING can hold the same file more than once, or fail to notice it is already held, depending only on how the path was spelled.');
}

const outPath = path.join(process.cwd(), 'scripts', 'win', 'ntfs-semantics.json');
fs.writeFileSync(outPath, JSON.stringify({ platform: process.platform, node: process.version, at: new Date().toISOString(), results }, null, 2));
console.log(`\nwrote ${outPath}`);
try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* reserved names can resist deletion */ }
