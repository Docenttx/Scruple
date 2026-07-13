// scripts/smoke-trust-labeler.mjs
//
// Smoke for WO-B2 — trust labeler correctly buckets packs into
// trusted / listed / unknown given a synthetic trust list.

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const tsx = require.resolve('tsx/cli');

const asserts = `
import { labelManifest, summarizeLabels } from '../lib/trust/label';
import { _setTrustListForTesting } from '../lib/trust/comfyorg';

_setTrustListForTesting([
  { packName: 'comfyui-easy-use',       repository: 'https://github.com/yolain/ComfyUI-Easy-Use', latestCommitSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', tags: ['verified-publisher'] },
  { packName: 'comfyui-videohelpersuite', repository: 'Kosinkadink/ComfyUI-VideoHelperSuite',       latestCommitSha: null, tags: [] },
]);

const packs = [
  { pack: 'ComfyUI-Easy-Use', commit_sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', contents_hash: 'hh1' },       // trusted
  { pack: 'ComfyUI-VideoHelperSuite', commit_sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', contents_hash: 'hh2' }, // trusted (no pin in list)
  { pack: 'ComfyUI-Easy-Use', commit_sha: 'cccccccccccccccccccccccccccccccccccccccc', contents_hash: 'hh3' },       // listed (commit drift)
  { pack: 'jane-doe-experimental-pack', commit_sha: 'dddddddddddddddddddddddddddddddddddddddd', contents_hash: 'hh4' }, // unknown
];

const labeled = labelManifest(packs, [
  { packName: 'comfyui-easy-use',       repository: 'https://github.com/yolain/ComfyUI-Easy-Use', latestCommitSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', tags: ['verified-publisher'] },
  { packName: 'comfyui-videohelpersuite', repository: 'Kosinkadink/ComfyUI-VideoHelperSuite',       latestCommitSha: null, tags: [] },
]);

function eq(label, got, want) {
  if (got !== want) { console.error('FAIL', label, 'got=', got, 'want=', want); process.exit(1); }
  console.log('OK  ', label);
}
eq('#0 trusted (commit match)', labeled[0].trust, 'trusted');
eq('#0 tags surfaced', JSON.stringify(labeled[0].trust_tags), '["verified-publisher"]');
eq('#1 trusted (no commit pin)', labeled[1].trust, 'trusted');
eq('#2 listed (commit drift)', labeled[2].trust, 'listed');
eq('#3 unknown', labeled[3].trust, 'unknown');
eq('#3 no repository surfaced', labeled[3].trust_repository, undefined);

const s = summarizeLabels(labeled);
if (s.total !== 4 || s.trusted !== 2 || s.listed !== 1 || s.unknown !== 1) {
  console.error('FAIL summary', s); process.exit(1);
}
console.log('OK   summary');
console.log('\\ntrust labeler smoke — all assertions PASS');
`;
const p = path.join(__dirname, '_trust_asserts.ts');
fs.writeFileSync(p, asserts);
const r = spawnSync('node', [tsx, p], {
  cwd: path.join(__dirname, '..'),
  stdio: 'inherit',
});
fs.unlinkSync(p);
process.exit(r.status ?? 1);
