#!/usr/bin/env node
//
// Does the deployed witness server match the tracked source?
//
// Putting code in git does not make a deployment track it. /opt/scruple-
// witness/ has been edited in place for months under a convention of
// saving server.js.bak.<unix_ts> beside each change — eleven such files
// exist, preserved under history/. Nothing enforced that the repo and the
// box agreed, because until now there was no repo.
//
// This is the enforcement. Run it before trusting a baseline: if the
// deployment does not match the source, the tamper-surface hash the
// source produces describes code that is not running.
//
// Exit 0 = match. Exit 1 = drift. Exit 2 = could not tell.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tamperSurface, TRACKED } from './tamper-surface.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEPLOYED = process.argv[2] ?? '/opt/scruple-witness';

if (!existsSync(DEPLOYED)) {
  console.error(`Cannot check: ${DEPLOYED} does not exist on this host.`);
  console.error('This is expected off the deployment box. Exit 2 means unknown, not clean.');
  process.exit(2);
}

const repo = tamperSurface(HERE);
const live = tamperSurface(DEPLOYED);

if (repo.tamper_surface_hash === live.tamper_surface_hash) {
  console.log(`MATCH  ${repo.tamper_surface_hash}`);
  console.log('The deployment is running the tracked source.');
  process.exit(0);
}

console.log('DRIFT — the deployment is not running the tracked source.\n');
console.log(`  repo   ${repo.tamper_surface_hash}`);
console.log(`  live   ${live.tamper_surface_hash}\n`);

for (const rel of TRACKED) {
  const r = repo.files.find((f) => f.file === rel);
  const l = live.files.find((f) => f.file === rel);
  if (r?.sha256 === l?.sha256) continue;
  const state = !l?.sha256 ? 'missing on the box'
    : !r?.sha256 ? 'missing in the repo'
    : 'differs';
  console.log(`  ${rel}: ${state}`);
}

console.log('\nA baseline computed from the repo describes code that is not running.');
process.exit(1);
