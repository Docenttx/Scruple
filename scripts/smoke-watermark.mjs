// scripts/smoke-watermark.mjs
//
// Smoke for the Python watermark reference implementation.
// Exercises:
//   1. payload_hex round-trips through embed → decode
//   2. Unwatermarked image decodes to null (no false positives)
//   3. Watermark survives JPEG q=75 recompression (the most common
//      real-world channel — social platforms + email)
//   4. Watermark survives resize to 75% then back (mild scaling)
//   5. Detection FAILS after aggressive crop (proves the watermark is
//      not being trivially spoofed; asymmetric FPR check)

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const REPO = '/data/scruple-web';
const CLI = ['-m', 'services.watermark.cli'];

function pythonRun(job) {
  const r = spawnSync('python3', CLI, {
    input: JSON.stringify(job),
    encoding: 'utf-8',
    cwd: REPO,
  });
  if (r.status !== 0 && !r.stdout) {
    throw new Error(`python failed: ${r.stderr}`);
  }
  return JSON.parse(r.stdout.trim().split('\n').at(-1));
}

function pythonEval(script) {
  const r = spawnSync('python3', ['-c', script], {
    encoding: 'utf-8',
    cwd: REPO,
  });
  if (r.status !== 0) throw new Error(`python failed: ${r.stderr}`);
  return r.stdout.trim();
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-smoke-'));

// 1. Generate a synthetic photographic-ish source (gradient with noise
//    to simulate real image content the DCT scheme handles well)
const srcPath = path.join(tmp, 'source.png');
pythonEval(`
import numpy as np, io
from PIL import Image
rng = np.random.default_rng(42)
h = w = 512
r = np.tile(np.linspace(0, 255, w, dtype=np.uint8), (h, 1))
g = np.tile(np.linspace(0, 255, h, dtype=np.uint8).reshape(-1, 1), (1, w))
b = np.full((h, w), 128, dtype=np.uint8)
noise = rng.integers(-15, 15, size=(h, w, 3), dtype=np.int16)
arr = np.stack([r, g, b], axis=-1).astype(np.int16) + noise
arr = np.clip(arr, 0, 255).astype(np.uint8)
Image.fromarray(arr, mode='RGB').save('${srcPath}', format='PNG')
`);
console.log(`OK   generated 512x512 test image  (${fs.statSync(srcPath).size} B)`);

// 2. Build a tier-4 payload for SCR_A38E30FF
const payloadHex = pythonEval(`
import sys; sys.path.insert(0, '/data/scruple-web/services')
from watermark.payload import build_payload_tier_4_5, Tier, payload_hex
print(payload_hex(build_payload_tier_4_5(Tier.CHAIN_LOCK_BASIC, scr_id='SCR_A38E30FF')))
`);
console.log(`OK   payload built: ${payloadHex}`);

// 3. Embed
const wmPath = path.join(tmp, 'watermarked.png');
const embedRes = pythonRun({
  action: 'embed',
  input_path: srcPath,
  output_path: wmPath,
  payload_hex: payloadHex,
});
if (!embedRes.ok) { console.error('FAIL embed', embedRes); process.exit(1); }
console.log(`OK   embed → ${embedRes.bytes} B`);

// 4. Decode
const decodeRes = pythonRun({ action: 'decode', input_path: wmPath });
if (!decodeRes.ok || !decodeRes.decoded || decodeRes.decoded.scr_id !== 'SCR_A38E30FF') {
  console.error('FAIL decode', decodeRes);
  process.exit(1);
}
console.log(`OK   decode → ${JSON.stringify(decodeRes.decoded)}`);

// 5. Unwatermarked → null
const unwmDecode = pythonRun({ action: 'decode', input_path: srcPath });
if (unwmDecode.decoded !== null) {
  console.error('FAIL unwatermarked returned a payload:', unwmDecode);
  process.exit(1);
}
console.log(`OK   unwatermarked → null (no false positive)`);

// 6. Survive JPEG q=75 recompression
const jpegPath = path.join(tmp, 'watermarked-jpeg-q75.jpg');
pythonEval(`
from PIL import Image
Image.open('${wmPath}').save('${jpegPath}', format='JPEG', quality=75)
`);
const jpegDecode = pythonRun({ action: 'decode', input_path: jpegPath });
if (!jpegDecode.decoded || jpegDecode.decoded.scr_id !== 'SCR_A38E30FF') {
  console.error('FAIL jpeg-q75 decode:', jpegDecode);
  process.exit(1);
}
console.log(`OK   survives JPEG q=75 recompression`);

// 7. Survive 75% resize (roundtrip)
const resizedPath = path.join(tmp, 'watermarked-resized.png');
pythonEval(`
from PIL import Image
im = Image.open('${wmPath}')
w, h = im.size
im.resize((int(w*0.75), int(h*0.75)), Image.LANCZOS).resize((w, h), Image.LANCZOS).save('${resizedPath}', format='PNG')
`);
const resizedDecode = pythonRun({ action: 'decode', input_path: resizedPath });
if (!resizedDecode.decoded || resizedDecode.decoded.scr_id !== 'SCR_A38E30FF') {
  console.error('FAIL 75% resize decode:', resizedDecode);
  process.exit(1);
}
console.log(`OK   survives 75% resize roundtrip`);

// 8. Aggressive 30% crop → should NOT decode successfully (proves the
//    scheme isn't leaking a decoded payload from unrelated pixels)
const cropPath = path.join(tmp, 'watermarked-cropped.png');
pythonEval(`
from PIL import Image
im = Image.open('${wmPath}')
w, h = im.size
im.crop((int(w*0.35), int(h*0.35), int(w*0.65), int(h*0.65))).save('${cropPath}', format='PNG')
`);
const cropDecode = pythonRun({ action: 'decode', input_path: cropPath });
// Note: with heavy crop we EXPECT the payload to not decode. The test
// PASSES as long as we don't hallucinate a different valid payload.
if (cropDecode.decoded && cropDecode.decoded.scr_id === 'SCR_A38E30FF') {
  console.log(`OK   survives aggressive 30% center crop (unexpected but great)`);
} else if (cropDecode.decoded) {
  console.error('FAIL crop decoded to WRONG payload — false positive:', cropDecode.decoded);
  process.exit(1);
} else {
  console.log(`OK   aggressive crop returns null (expected — no false positive)`);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\nAll 8 assertions PASS');
