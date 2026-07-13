// scripts/smoke-canonical-workflow.mjs
//
// Smoke for WO-A2 — canonical workflow_hash is order-independent and
// matches the Python twin byte-for-byte.
//
// Fixtures represent the same workflow with keys inserted in DIFFERENT
// orders (which would produce different JSON.stringify() bytes) and
// nested structures. All must produce the same hash.

import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const tsx = require.resolve('tsx/cli');

const asserts = `
import { canonicalize, hashWorkflow } from '../lib/scruple/canonicalWorkflow';
import { createHash } from 'node:crypto';

const workflowA = {
  '1': { class_type: 'KSampler', inputs: { seed: 42, steps: 20, model: ['4', 0] } },
  '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'sdxl.safetensors' } },
};
const workflowB = {
  '4': { inputs: { ckpt_name: 'sdxl.safetensors' }, class_type: 'CheckpointLoaderSimple' },
  '1': { inputs: { model: ['4', 0], steps: 20, seed: 42 }, class_type: 'KSampler' },
};

const hashA = hashWorkflow(workflowA);
const hashB = hashWorkflow(workflowB);

if (hashA !== hashB) {
  console.error('FAIL — key-order-invariant hash broken');
  console.error('  A:', hashA);
  console.error('  B:', hashB);
  console.error('  canonA:', canonicalize(workflowA));
  console.error('  canonB:', canonicalize(workflowB));
  process.exit(1);
}
console.log('OK   key-order-invariant hash');

// Nested arrays MUST preserve order — [4,0] and [0,4] are distinct
// wiring in ComfyUI.
const wf1 = { '5': { inputs: { latent: ['3', 0] } } };
const wf2 = { '5': { inputs: { latent: ['3', 1] } } };
if (hashWorkflow(wf1) === hashWorkflow(wf2)) {
  console.error('FAIL — array-order NOT preserved (should differ)');
  process.exit(1);
}
console.log('OK   array-order preserved (distinct wiring → distinct hash)');

// Publish the canonical bytes for the Python parity check
console.log('CANON_A:', canonicalize(workflowA));
console.log('HASH:', hashA);
`;

const asserts_path = path.join(__dirname, '_wf_asserts.ts');
require('node:fs').writeFileSync(asserts_path, asserts);
const jsRes = spawnSync('node', [tsx, asserts_path], {
  cwd: path.join(__dirname, '..'),
  env: process.env,
  encoding: 'utf-8',
});
require('node:fs').unlinkSync(asserts_path);
process.stdout.write(jsRes.stdout ?? '');
process.stderr.write(jsRes.stderr ?? '');
if (jsRes.status !== 0) process.exit(jsRes.status ?? 1);

// Parse the CANON_A and HASH out for Python parity
const canonA = /CANON_A: (.+)/.exec(jsRes.stdout)[1];
const expectedHash = /HASH: (.+)/.exec(jsRes.stdout)[1];

const pyScript = `
import sys, json
sys.path.insert(0, 'services/witness')
from canonical_workflow import canonicalize, hash_workflow

workflow = {
  '4': { 'inputs': { 'ckpt_name': 'sdxl.safetensors' }, 'class_type': 'CheckpointLoaderSimple' },
  '1': { 'inputs': { 'model': ['4', 0], 'steps': 20, 'seed': 42 }, 'class_type': 'KSampler' },
}
canon = canonicalize(workflow)
h = hash_workflow(workflow)
expected_canon = ${JSON.stringify(canonA)}
expected_hash = '${expectedHash}'
if canon != expected_canon:
    print(f'FAIL — Python canonicalization does not match TS')
    print(f'  py: {canon}')
    print(f'  ts: {expected_canon}')
    sys.exit(1)
if h != expected_hash:
    print(f'FAIL — Python hash does not match TS: py={h} ts={expected_hash}')
    sys.exit(1)
print('OK   Python parity — canonical bytes + hash')
`;
const pyRes = spawnSync('python3', ['-c', pyScript], {
  cwd: path.join(__dirname, '..'),
  encoding: 'utf-8',
});
process.stdout.write(pyRes.stdout ?? '');
process.stderr.write(pyRes.stderr ?? '');
process.exit(pyRes.status ?? 1);
