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
 *     [--iteration 123] \
 *     [--title "Optional title"] \
 *     [--api-key sk_test_xxx] \
 *     [--base https://scruple.stooges.ai]
 *
 * Environment fallbacks:
 *   SCRUPLE_API_KEY, SCRUPLE_BASE_URL
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
const apiKey = arg('api-key', process.env.SCRUPLE_API_KEY);
const baseUrl = arg('base', process.env.SCRUPLE_BASE_URL ?? 'http://localhost:3001');
const outArg = arg('out');

if (!project || !asset || !apiKey) {
  console.error('usage: c2pa-sign --project ID --asset PATH --api-key KEY [--tier bare|witnessed|local|chain] [--product studio|fusion] [--iteration ID] [--title T] [--base URL] [--out PATH]');
  process.exit(2);
}

const body = {
  project_id: Number(project),
  asset_path: asset,
  product,
  tier,
};
if (iteration) body.iteration_id = Number(iteration);
if (title) body.title = title;

const url = `${baseUrl.replace(/\/$/, '')}/api/scruple/c2pa/sign`;
console.error(`→ POST ${url}`);
console.error(`  project=${project} tier=${tier} product=${product} asset=${asset}`);

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
