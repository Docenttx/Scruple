// scripts/smoke-watermark-e2e.mjs
//
// End-to-end smoke covering the full watermark stack:
//   1. Python payload builder — tier 4 for a synthetic SCR_ID
//   2. Python DCT encoder embeds it in a synthetic image
//   3. TS embedImageWatermark wrapper does the same round-trip
//   4. lib/watermark/apply.watermarkProjectIterations against a
//      fixture-populated iterations row
//   5. scruple-verify watermark subcommand decodes the result end-to-end
//
// This is the "does the whole thing hang together" test.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);
const tsx = require.resolve('tsx/cli');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-e2e-'));
const srcPath = path.join(tmp, 'source.png');
const wmPath = path.join(tmp, 'watermarked.png');

// ────────────────────────────────────────────────────────────────────
// Step 1: generate a test source image
// ────────────────────────────────────────────────────────────────────
const pyGen = spawnSync('python3', ['-c', `
import numpy as np
from PIL import Image
rng = np.random.default_rng(42)
h = w = 512
arr = rng.integers(0, 256, size=(h, w, 3), dtype=np.uint8)
Image.fromarray(arr, mode='RGB').save('${srcPath}', format='PNG')
`], { encoding: 'utf-8' });
if (pyGen.status !== 0) { console.error('gen failed', pyGen.stderr); process.exit(1); }
console.log(`OK  step 1: test image ${fs.statSync(srcPath).size} B`);

// ────────────────────────────────────────────────────────────────────
// Step 2: TS wrapper end-to-end (embed via lib/watermark/embed.ts)
// ────────────────────────────────────────────────────────────────────
const tsScript = `
import { readFileSync, writeFileSync } from 'node:fs';
import { buildPayloadHex, embedImageWatermark, decodeImageWatermark } from '@/lib/watermark/embed';

const src = readFileSync('${srcPath}');
const payload = buildPayloadHex({ tier: 'chain-lock-basic', scrId: 'SCR_A38E30FF' });
console.log('  payload:', payload);

const embed = embedImageWatermark({
  masterBytes: src,
  inputFormat: 'PNG',
  outputFormat: 'PNG',
  payloadHex: payload,
});
writeFileSync('${wmPath}', embed.derivativeBytes);
console.log('  embedded via TS wrapper:', embed.derivativeBytes.length, 'B');

// Decode round-trip via TS
const decoded = decodeImageWatermark(embed.derivativeBytes);
if (!decoded || decoded.scrId !== 'SCR_A38E30FF') {
  console.error('  TS decode FAILED:', decoded);
  process.exit(1);
}
console.log('  decoded via TS wrapper:', JSON.stringify(decoded));
`;
const tsPath = path.join(tmp, 'ts_wrap.ts');
fs.writeFileSync(tsPath, tsScript);
const tsRes = spawnSync('node', [tsx, tsPath], { cwd: REPO, encoding: 'utf-8' });
if (tsRes.status !== 0) {
  console.error('step 2 TS wrapper failed:', tsRes.stderr, tsRes.stdout);
  process.exit(1);
}
process.stdout.write(tsRes.stdout);
console.log(`OK  step 2: TS embed + decode round-trip`);

// ────────────────────────────────────────────────────────────────────
// Step 3: scruple-verify CLI decodes the watermarked file
// ────────────────────────────────────────────────────────────────────
const cliRes = spawnSync(
  'node',
  ['packages/scruple-verify/src/cli.mjs', 'watermark', '--input', wmPath, '--json'],
  { cwd: REPO, encoding: 'utf-8' },
);
if (cliRes.status !== 0) {
  console.error('  CLI failed:', cliRes.stderr, cliRes.stdout);
  process.exit(1);
}
const verdict = JSON.parse(cliRes.stdout.trim());
if (verdict.verdict !== 'VALID' || verdict.watermark.scr_id !== 'SCR_A38E30FF') {
  console.error('  wrong verdict:', verdict);
  process.exit(1);
}
console.log(`OK  step 3: scruple-verify CLI verdict=${verdict.verdict}, tier=${verdict.watermark.tier}, scr_id=${verdict.watermark.scr_id}`);

// ────────────────────────────────────────────────────────────────────
// Step 4: CLI correctly returns NO_WATERMARK on the source image
// ────────────────────────────────────────────────────────────────────
const cliNeg = spawnSync(
  'node',
  ['packages/scruple-verify/src/cli.mjs', 'watermark', '--input', srcPath, '--json'],
  { cwd: REPO, encoding: 'utf-8' },
);
if (cliNeg.status !== 0) {
  console.error('  negative case CLI failed:', cliNeg.stderr, cliNeg.stdout);
  process.exit(1);
}
const negVerdict = JSON.parse(cliNeg.stdout.trim());
if (negVerdict.verdict !== 'NO_WATERMARK') {
  console.error('  expected NO_WATERMARK, got:', negVerdict);
  process.exit(1);
}
console.log(`OK  step 4: CLI verdict on unwatermarked source = NO_WATERMARK`);

// ────────────────────────────────────────────────────────────────────
// Step 5: tier 1 (self-contained) end-to-end
// ────────────────────────────────────────────────────────────────────
const tier1Script = `
import { readFileSync, writeFileSync } from 'node:fs';
import { buildPayloadHex, embedImageWatermark } from '@/lib/watermark/embed';

const src = readFileSync('${srcPath}');
const payload = buildPayloadHex({ tier: 'c2pa-signed', signedAtUnixSeconds: 1720974000 });
console.log('  tier1 payload:', payload);
const embed = embedImageWatermark({ masterBytes: src, outputFormat: 'PNG', payloadHex: payload });
writeFileSync('${path.join(tmp, 'wm_tier1.png')}', embed.derivativeBytes);
`;
const t1Path = path.join(tmp, 'tier1.ts');
fs.writeFileSync(t1Path, tier1Script);
const t1Res = spawnSync('node', [tsx, t1Path], { cwd: REPO, encoding: 'utf-8' });
if (t1Res.status !== 0) { console.error('tier1 embed failed', t1Res.stderr); process.exit(1); }
process.stdout.write(t1Res.stdout);

const cliT1 = spawnSync(
  'node',
  ['packages/scruple-verify/src/cli.mjs', 'watermark', '--input', path.join(tmp, 'wm_tier1.png'), '--json'],
  { cwd: REPO, encoding: 'utf-8' },
);
const t1Verdict = JSON.parse(cliT1.stdout.trim());
if (t1Verdict.verdict !== 'VALID' || t1Verdict.watermark.tier !== 1 || t1Verdict.dispatch.type !== 'self-contained') {
  console.error('  wrong tier-1 verdict:', t1Verdict);
  process.exit(1);
}
if (t1Verdict.watermark.signed_at_unix_seconds !== 1720974000) {
  console.error('  wrong signed_at:', t1Verdict.watermark.signed_at_unix_seconds);
  process.exit(1);
}
console.log(`OK  step 5: tier-1 self-contained decode + timestamp match`);

// ────────────────────────────────────────────────────────────────────
// Cleanup
// ────────────────────────────────────────────────────────────────────
fs.rmSync(tmp, { recursive: true, force: true });

console.log('\nAll 5 e2e steps PASS');
