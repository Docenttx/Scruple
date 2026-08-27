#!/usr/bin/env node
//
// Compute the witness server's tamper-surface hash.
//
// WHY THIS EXISTS
//
// Standard §3 says a baseline covers "the code, configuration, and
// attested compute environment" of an integration, and §4 says silent
// modification must be cryptographically impossible. Until 2026-08-26 the
// witness server was not in git, which made it the one component of the
// system that could not be measured — while being the component that
// computes everyone else's baseline. The thing deciding what counts as
// unmodified was itself unmeasurable.
//
// This produces the hash that closes that circle. It is deliberately
// simple and deliberately explicit about what it covers.
//
// WHAT IT COVERS: the tracked source files below, by content.
// WHAT IT DOES NOT COVER: node_modules (pinned by package-lock, not
// hashed here), the Node runtime, the OS, the systemd unit and its
// environment, or the machine. A matching hash means "the source is what
// we think it is", not "the server is trustworthy". Do not let it be
// read as the stronger claim.
//
// Usage:
//   node tamper-surface.mjs                 # hash the repo copy
//   node tamper-surface.mjs /opt/scruple-witness   # hash a deployment
//   node tamper-surface.mjs --json

import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Explicit list, not a directory walk. A walk would silently include
// whatever someone drops in the directory, which is the opposite of a
// tamper surface: adding a file must change the hash for a reason we can
// name, not because the glob happened to widen.
export const TRACKED = [
  'server.js',
  'arweave-treasury.js',
  'ipfs-pinner.js',
  'testnet-locker.js',
  'package.json',
  'package-lock.json',
];

export function tamperSurface(dir) {
  const entries = TRACKED.map((rel) => {
    const p = path.join(dir, rel);
    if (!existsSync(p)) return { file: rel, sha256: null, missing: true };
    const sha256 = createHash('sha256').update(readFileSync(p)).digest('hex');
    return { file: rel, sha256, missing: false };
  });

  // Canonical form: sorted "sha256  filename" lines, newline separated,
  // trailing newline. Stable across platforms and easy to reproduce by
  // hand with sha256sum, which matters when a reviewer wants to check it
  // without running our code.
  const canonical = entries
    .map((e) => `${e.sha256 ?? 'MISSING'}  ${e.file}`)
    .sort()
    .join('\n') + '\n';

  return {
    tamper_surface_hash: createHash('sha256').update(canonical).digest('hex'),
    files: entries,
    canonical,
    complete: entries.every((e) => !e.missing),
  };
}

const isMain = process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const args = process.argv.slice(2).filter((a) => a !== '--json');
  const asJson = process.argv.includes('--json');
  const dir = args[0] ?? path.dirname(fileURLToPath(import.meta.url));
  const result = tamperSurface(dir);

  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`tamper surface of ${dir}`);
    for (const f of result.files) {
      console.log(`  ${f.sha256 ?? 'MISSING'.padEnd(64)}  ${f.file}`);
    }
    console.log(`\n  hash: ${result.tamper_surface_hash}`);
    if (!result.complete) console.log('  INCOMPLETE — a tracked file is missing.');
  }
  process.exit(result.complete ? 0 : 1);
}
