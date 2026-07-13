// scripts/smoke-verify-leaf-v24.mjs
//
// Smoke for WO-A4 — scruple-verify CLI correctly re-derives leaf_hash
// for v2.4 leaves and additionally re-derives workflow_hash from the
// raw workflow_api_json when attached to the proof.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, '..', 'packages', 'scruple-verify', 'src', 'cli.mjs');

// Reimplement the canonical hash locally so this smoke doesn't depend
// on the CLI internals it's testing.
function canonicalize(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalize).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(v[k])).join(',') + '}';
}
function sha256(s) { return createHash('sha256').update(s, 'utf8').digest('hex'); }

const workflow = {
  '3': { class_type: 'KSampler', inputs: { seed: 1234, steps: 20, model: ['4', 0] } },
  '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'sd_xl_base_1.0.safetensors' } },
};
const workflowHash = sha256(canonicalize(workflow));

// Build a v2.4 canonical leaf preimage + hash.
const leaf = {
  tenant_id: 'TEN_smoke',
  principal_id: '',
  stream_id: 'STR_smoke',
  tenant_seq: 1,
  event_time: '2026-07-13T00:00:00.000Z',
  payload_hash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
  workflow_hash: workflowHash,
  machine_manifest_hash: '',
  dims: {},
};
const canonicalLeaf =
  '{' +
  ['tenant_id', 'principal_id', 'stream_id', 'tenant_seq', 'event_time', 'payload_hash', 'workflow_hash', 'machine_manifest_hash', 'dims']
    .map((k) => JSON.stringify(k) + ':' + JSON.stringify(leaf[k]))
    .join(',') +
  '}';
const leafHash = sha256(canonicalLeaf);

// Build a minimum proof — bypasses the checkpoint / trust-manifest steps
// by hitting them with things they'll flag but not for the reason we care
// about (we test the leaf + workflow re-derivation steps here).
const proof = {
  leaf: {
    ...leaf,
    leaf_scheme: 'v2.4',
    leaf_hash: `sha256:${leafHash}`,
  },
  workflow_api_json: workflow,
  inclusion: [],
  checkpoint: {
    witness_key_id: 'not-a-real-key',
    witness_sig: '0000',
    bundle: {
      merkle_root: leafHash, // single leaf → merkle root = leaf hash
    },
  },
};

const proofPath = path.join(os.tmpdir(), `scruple-verify-v24-smoke-${process.pid}.json`);
fs.writeFileSync(proofPath, JSON.stringify(proof, null, 2));

// Run CLI. It will FAIL overall because we have no real trust manifest,
// but the leaf + workflow steps should show "ok".
const res = spawnSync('node', [CLI, 'leaf', '--proof', proofPath], {
  encoding: 'utf-8',
});
fs.unlinkSync(proofPath);
const combined = (res.stdout ?? '') + (res.stderr ?? '');
process.stdout.write(combined);

// Only the two WO-A4 additions are the target of this smoke — the
// checkpoint/trust-manifest step is exercised by the pre-existing
// v2.3 smoke and doesn't need re-testing here.
const wantLeaf = 'ok   — leaf_hash re-derives from canonical fields (v2.4)';
const wantWorkflow = 'ok   — workflow_hash re-derives from raw workflow_api_json';

let failed = false;
if (!combined.includes(wantLeaf)) { console.error('\nFAIL — expected step:', wantLeaf); failed = true; }
if (!combined.includes(wantWorkflow)) { console.error('\nFAIL — expected step:', wantWorkflow); failed = true; }
if (failed) process.exit(1);

console.log('\nv2.4 verify smoke — leaf + workflow re-derivation pass');

// Negative: tamper the workflow → workflow_hash step should FAIL.
const tamperedProof = {
  ...proof,
  workflow_api_json: { ...workflow, '3': { ...workflow['3'], inputs: { ...workflow['3'].inputs, seed: 9999 } } },
};
fs.writeFileSync(proofPath, JSON.stringify(tamperedProof, null, 2));
const res2 = spawnSync('node', [CLI, 'leaf', '--proof', proofPath], { encoding: 'utf-8' });
fs.unlinkSync(proofPath);
const combined2 = (res2.stdout ?? '') + (res2.stderr ?? '');
process.stdout.write(combined2);
if (!combined2.includes('FAIL — workflow_hash re-derives from raw workflow_api_json')) {
  console.error('\nFAIL — expected tampered workflow to be caught');
  process.exit(1);
}
console.log('\nv2.4 verify smoke — tampered workflow_api_json correctly rejected');
