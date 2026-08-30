#!/usr/bin/env node
/**
 * Headless C2PA signer CLI — hits POST /api/scruple/c2pa/sign with an
 * API key, saves the returned signed asset locally.
 *
 * Usage:
 *   node scripts/c2pa-sign.mjs \
 *     --project 42 \
 *     --asset /tmp/foo.png \
 *     --product studio \
 *     --tier witnessed \
 *     --digital-source-type TRAINED_ALGORITHMIC_MEDIA \
 *     [--iteration 123] \
 *     [--title "Optional title"] \
 *     [--api-key sk_test_xxx] \
 *     [--base https://scruple.stooges.ai]
 *
 * Environment fallbacks:
 *   SCRUPLE_API_KEY, SCRUPLE_BASE_URL
 *
 * --digital-source-type is REQUIRED and has no default. It decides
 * whether the signed manifest asserts "generative AI made this" or "a
 * human made this with non-generative tools", and only whoever produced
 * the asset knows which. TRAINED_ALGORITHMIC_MEDIA for GenAI output;
 * DIGITAL_CREATION for a human working in CAD, 3D or animation. It is
 * not inferred from --product: Studio spans both. See the note on
 * C2paDigitalSourceType in lib/c2pa/signAsset.ts.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  return process.argv[i + 1];
}

const project = arg('project');
const asset = arg('asset');
const product = arg('product', 'studio');
const tier = arg('tier', 'witnessed');
const iteration = arg('iteration');
const title = arg('title');
// No default. A CLI that guessed here would sign a claim about how the
// asset was made on behalf of a user who never made one.
const digitalSourceType = arg('digital-source-type');
const apiKey = arg('api-key', process.env.SCRUPLE_API_KEY);
const baseUrl = arg('base', process.env.SCRUPLE_BASE_URL ?? 'http://localhost:3001');
const outArg = arg('out');

if (!project || !asset || !apiKey || !digitalSourceType) {
  console.error('usage: c2pa-sign --project ID --asset PATH --api-key KEY --digital-source-type TRAINED_ALGORITHMIC_MEDIA|DIGITAL_CREATION|... [--tier bare|witnessed|local|chain] [--product studio|fusion] [--iteration ID] [--title T] [--base URL] [--out PATH]');
  if (!digitalSourceType) {
    console.error('');
    console.error('--digital-source-type is required and is never guessed.');
    console.error('  TRAINED_ALGORITHMIC_MEDIA  generative-AI output (ComfyUI / Modal / canvas)');
    console.error('  DIGITAL_CREATION           a human using non-generative tools (CAD, 3D, animation)');
    console.error('The server refuses the request without it; so does this CLI, sooner.');
  }
  process.exit(2);
}

const body = {
  project_id: Number(project),
  asset_path: asset,
  product,
  tier,
  digital_source_type: digitalSourceType,
};
if (iteration) body.iteration_id = Number(iteration);
if (title) body.title = title;

const url = `${baseUrl.replace(/\/$/, '')}/api/scruple/c2pa/sign`;
console.error(`→ POST ${url}`);
console.error(`  project=${project} tier=${tier} product=${product} asset=${asset}`);
console.error(`  digital_source_type=${digitalSourceType}`);

const res = await fetch(url, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
  },
  body: JSON.stringify(body),
});
const json = await res.json().catch(() => ({ error: 'non-JSON response', status: res.status }));

if (!res.ok || !json.ok) {
  console.error('FAILED', res.status, JSON.stringify(json, null, 2));
  process.exit(1);
}

console.error(`✓ signed (${json.bytes} bytes) at ${json.signed_path}`);
console.error(`  tier: ${json.tier}`);
console.error(`  scr_id: ${json.scr_id ?? '(none — bare tier)'}`);

// Copy locally if --out was passed
if (outArg) {
  const data = readFileSync(json.signed_path);
  writeFileSync(outArg, data);
  console.error(`→ copied to ${outArg}`);
}

console.log(JSON.stringify(json, null, 2));
