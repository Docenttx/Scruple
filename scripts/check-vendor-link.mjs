#!/usr/bin/env node
/**
 * Verify that every path reached through `vendor/scruple-web` actually resolves.
 *
 * WHY A SCRIPT AND NOT A NUMBER. The travel-laptop README used to say "14 SDK
 * imports must resolve". That number was wrong when written (it counted unique
 * path strings from one glob that missed a second SDK file) and would have gone
 * stale anyway the first time an import was added. A canary you maintain by hand
 * is a canary that lies to you eventually. This counts.
 *
 * WHAT IT CATCHES. The link is machine-specific and is deliberately NOT in git
 * (see .gitignore). Until WO-E7's laptop run it WAS committed, mode 120000, with
 * the absolute content `/data/scruple-web` — which resolved on the build box and
 * on nothing else. Git for Windows also ships `core.symlinks=false`, so a clone
 * there materializes it as a 17-byte TEXT FILE containing that path, which is
 * not a link at all and fails in a way that looks like a missing dependency.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LINK = path.join(REPO, 'vendor', 'scruple-web');
const say = (s) => process.stdout.write(`[vendor-link] ${s}\n`);

// The link itself, before anything that goes through it. lstat first: existsSync
// FOLLOWS a symlink, so a link pointing at empty space reads as "not there" and
// gets diagnosed as "you forgot to create it" when in fact you created it wrong.
let lst = null;
try { lst = fs.lstatSync(LINK); } catch { /* genuinely absent */ }
if (lst && lst.isSymbolicLink() && !fs.existsSync(LINK)) {
  say(`FAIL vendor/scruple-web is a link that points at nothing.`);
  say(`       target: ${fs.readlinkSync(LINK)}`);
  say(`       Relative targets climb TWO levels (out of vendor/, then out of the`);
  say(`       repo) and assume the server clone is a SIBLING directory.`);
  process.exit(2);
}
if (!fs.existsSync(LINK)) {
  say(`FAIL vendor/scruple-web does not exist. Create it — it is NOT shipped:`);
  say(`       ln -s ../../scruple-web vendor/scruple-web        (macOS/Linux, sibling clones)`);
  say(`       mklink /J scruple-web ..\\..\\scruple-web          (Windows, from vendor\\)`);
  process.exit(2);
}
const st = lst ?? fs.lstatSync(LINK);
if (st.isFile()) {
  say(`FAIL vendor/scruple-web is a regular file, not a link — ${st.size} bytes.`);
  say(`       That is Git for Windows with core.symlinks=false checking out the`);
  say(`       blob's TEXT. Delete it and put a junction in its place.`);
  process.exit(2);
}
if (!fs.existsSync(path.join(LINK, 'package.json'))) {
  say(`FAIL vendor/scruple-web resolves to nothing usable (no package.json behind it).`);
  say(`       -> ${fs.existsSync(LINK) ? fs.realpathSync.native(path.dirname(LINK)) : '?'}`);
  process.exit(2);
}

const REF = /vendor\/scruple-web\/[A-Za-z0-9/._-]+/g;
const files = [];
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'vendor' || e.name.startsWith('.')) continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(ts|tsx|js|mjs|sh)$/.test(e.name)) files.push(p);
  }
};
for (const d of ['app', 'scripts']) { const p = path.join(REPO, d); if (fs.existsSync(p)) walk(p); }

const resolves = (rel) => {
  const f = path.join(REPO, rel);
  return ['', '.ts', '.tsx', '.js', '.mjs'].some((x) => fs.existsSync(f + x)) || fs.existsSync(path.join(f, 'index.ts'));
};

let refs = 0, bad = 0;
const byFile = new Map();
for (const f of files) {
  for (const m of fs.readFileSync(f, 'utf8').matchAll(REF)) {
    refs++;
    if (!resolves(m[0])) { bad++; byFile.set(f, [...(byFile.get(f) ?? []), m[0]]); }
  }
}
say(`files scanned=${files.length}  references=${refs}  unresolved=${bad}`);
for (const [f, ps] of byFile) for (const p of ps) say(`  MISSING ${path.relative(REPO, f)} -> ${p}`);
if (bad) { say('FAIL the link exists but does not point at a usable server tree'); process.exit(1); }
say('OK every path through vendor/scruple-web resolves');
