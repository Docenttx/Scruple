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
  const cookie = `__Secure-authjs.session-token=${session}`;
  // Async mode (spec.async:true OR --async): spawn + poll. Required for long
  // workflows (training) that exceed the synchronous request window.
  const wantAsync = spec.async === true || process.argv.includes('--async');
  const started = Date.now();

  if (wantAsync) {
    const sres = await fetch(`${base}/api/runs?async=1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify(spec),
    });
    const sdata = await sres.json().catch(() => ({}));
    if (!sres.ok || !sdata.ok) {
      console.error(`✗ spawn failed (HTTP ${sres.status}):`, JSON.stringify(sdata, null, 2));
      process.exit(1);
    }
    console.log(`↑ spawned job ${sdata.jobId} (modal call ${sdata.callId}); polling…`);
    const maxMs = Number(process.env.SCRUPLE_RUN_TIMEOUT_MS ?? 30 * 60 * 1000);
    while (Date.now() - started < maxMs) {
      await new Promise((r) => setTimeout(r, 15000));
      const pr = await fetch(`${base}/api/runs/status?jobId=${sdata.jobId}`, { headers: { Cookie: cookie } });
      const pd = await pr.json().catch(() => ({}));
      const elapsed = ((Date.now() - started) / 1000).toFixed(0);
      if (pd.status === 'running') { console.log(`  …running (${elapsed}s)`); continue; }
      if (pd.status === 'failed') { console.error(`✗ run failed (${elapsed}s):`, pd.error); process.exit(1); }
      if (pd.status === 'done') {
        console.log(`✓ run captured in ${elapsed}s`);
        console.log(`  output_kind : ${pd.outputKind}`);
        console.log(`  leaf_hash   : ${pd.leafHash}`);
        console.log(`  run_sequence: ${pd.runSequence}`);
        console.log(`  inputs      : ${JSON.stringify(pd.inputHashes)}`);
        return;
      }
      console.error('✗ unexpected status:', JSON.stringify(pd)); process.exit(1);
    }
    console.error('✗ polling timed out'); process.exit(1);
  }

  const res = await fetch(`${base}/api/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
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
