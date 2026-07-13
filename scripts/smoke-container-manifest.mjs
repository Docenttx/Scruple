// scripts/smoke-container-manifest.mjs
//
// Smoke for WO-B1 — container_manifest.py enumerates custom_nodes/,
// resolves commit_sha, hashes pack contents, and produces a deterministic
// manifest hash.
//
// Fixture: sets up a fake /custom_nodes/ tree with two packs (one git repo,
// one non-git dir) and verifies:
//   1. Both packs appear in enumerate_custom_nodes(), sorted by name
//   2. The git-init'd pack has a 40-hex commit_sha
//   3. The non-git pack has commit_sha=null
//   4. contents_hash is stable across runs (same tree → same hash)
//   5. contents_hash CHANGES when a byte in the pack is edited
//   6. container_machine_manifest_hash is a 64-hex string

import { spawnSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'container-manifest-smoke-'));
const comfy = path.join(tmp, 'ComfyUI');
const cn = path.join(comfy, 'custom_nodes');
fs.mkdirSync(cn, { recursive: true });

// Pack A — a git repo with one commit
const packA = path.join(cn, 'ComfyUI-A');
fs.mkdirSync(packA);
fs.writeFileSync(path.join(packA, 'node.py'), 'print("A")\n');
fs.writeFileSync(path.join(packA, 'README.md'), '# A\n');
execSync('git init -q && git add . && git -c user.name=x -c user.email=x@x commit -q -m init', { cwd: packA });

// Pack B — plain directory (no .git)
const packB = path.join(cn, 'ComfyUI-B');
fs.mkdirSync(packB);
fs.writeFileSync(path.join(packB, 'node.py'), 'print("B")\n');

// git init ComfyUI itself so comfyui_version can be resolved
execSync(
  'git init -q && git -c user.name=x -c user.email=x@x commit -q --allow-empty -m init && git tag v0.99.0',
  { cwd: comfy },
);

const pyProbe = `
import sys, json
sys.path.insert(0, ${JSON.stringify(path.join(process.cwd(), 'modal'))})
from container_manifest import (
    container_machine_manifest, container_machine_manifest_hash,
    enumerate_custom_nodes,
)
COMFY = ${JSON.stringify(comfy)}
CN = ${JSON.stringify(cn)}
packs = enumerate_custom_nodes(CN)
m = container_machine_manifest(COMFY, CN)
h = container_machine_manifest_hash(COMFY, CN)
print(json.dumps({'packs': packs, 'manifest': m, 'hash': h}))
`;

function probe() {
  const r = spawnSync('python3', ['-c', pyProbe], { encoding: 'utf-8', cwd: '/data/scruple-web' });
  if (r.status !== 0) {
    console.error(r.stderr);
    process.exit(1);
  }
  return JSON.parse(r.stdout.trim());
}

let ok = true;
function eq(label, got, want) {
  const pass = JSON.stringify(got) === JSON.stringify(want);
  console.log(pass ? 'OK  ' : 'FAIL', label, pass ? '' : ` got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  if (!pass) ok = false;
}
function check(label, cond, extra = '') {
  console.log(cond ? 'OK  ' : 'FAIL', label, extra);
  if (!cond) ok = false;
}

const r1 = probe();
eq('pack ordering', r1.packs.map(p => p.pack), ['ComfyUI-A', 'ComfyUI-B']);
check('pack A has 40-hex commit_sha', /^[0-9a-f]{40}$/.test(r1.packs[0].commit_sha), r1.packs[0].commit_sha ?? '');
check('pack B commit_sha is null', r1.packs[1].commit_sha === null);
check('manifest hash is 64-hex', /^[0-9a-f]{64}$/.test(r1.hash));
check('comfyui_version resolves via git tag', r1.manifest.comfyui_version === 'v0.99.0');
check('comfyui_commit_sha is 40-hex', /^[0-9a-f]{40}$/.test(r1.manifest.comfyui_commit_sha));

// Determinism — run again, same hash
const r2 = probe();
eq('hash deterministic across runs', r2.hash, r1.hash);

// Sensitivity — edit a file in pack B, hash MUST change
fs.writeFileSync(path.join(packB, 'node.py'), 'print("B tampered")\n');
const r3 = probe();
check('hash changes when pack contents change', r3.hash !== r1.hash);

fs.rmSync(tmp, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
