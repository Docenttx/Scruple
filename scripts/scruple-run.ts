#!/usr/bin/env tsx
/**
 * scruple-run.ts — CC dev pipeline entry point.
 *
 * Runs a workflow through the real /api/runs endpoint (same path a user
 * hits), pumping source materials from local/inline/iteration/storage.
 * Lets Claude Code execute sophisticated workflow runs end-to-end —
 * capture → provenance → (then lock/mint) — without the canvas.
 *
 * Usage:
 *   SCRUPLE_SESSION=<session-token> npx tsx scripts/scruple-run.ts <run-spec.json>
 *
 * run-spec.json:
 *   {
 *     "projectId": 7,
 *     "outputKind": "image",
 *     "prompt": "img2img test",
 *     "workflowApiJson": { ...ComfyUI API graph... },
 *     "inputs": [
 *       { "kind": "init_image", "filename": "init.png", "localPath": "/tmp/init.png" }
 *     ]
 *   }
 *
 * Env:
 *   SCRUPLE_BASE     default http://127.0.0.1:3001
 *   SCRUPLE_SESSION  __Secure-authjs.session-token value (required)
 */

import fs from 'node:fs';

async function main() {
  const specPath = process.argv[2];
  if (!specPath) {
    console.error('usage: scruple-run.ts <run-spec.json>');
    process.exit(2);
  }
  const base = process.env.SCRUPLE_BASE ?? 'http://127.0.0.1:3001';
  const session = process.env.SCRUPLE_SESSION;
  if (!session) {
    console.error('SCRUPLE_SESSION env (session token) is required');
    process.exit(2);
  }

  const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
  const started = Date.now();
  const res = await fetch(`${base}/api/runs`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: `__Secure-authjs.session-token=${session}`,
    },
    body: JSON.stringify(spec),
  });
  const data = await res.json().catch(() => ({}));
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  if (!res.ok || !data.ok) {
    console.error(`✗ run failed (HTTP ${res.status}, ${elapsed}s):`, JSON.stringify(data, null, 2));
    process.exit(1);
  }

  console.log(`✓ run captured in ${elapsed}s (gpu ${data.gpu}, ${data.durationMs}ms exec)`);
  console.log(`  output_kind : ${data.outputKind}`);
  console.log(`  leaf_hash   : ${data.leafHash}`);
  console.log(`  run_sequence: ${data.runSequence}`);
  console.log(`  inputs      : ${JSON.stringify(data.inputHashes)}`);
}

main().catch((e) => {
  console.error('scruple-run error:', e);
  process.exit(1);
});
