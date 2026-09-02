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
        reportProvenance(pd);
        await runLockIfRequested(spec, base, cookie, session);
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
  reportProvenance(data);

  await runLockIfRequested(spec, base, cookie, session);
}

/**
 * The three provenance facts the run already computes and this CLI used to
 * throw away.
 *
 * signOnIngest returns a STRUCTURED refusal rather than throwing — status
 * `unsupported_media` with the server's own reason — and /api/runs/status
 * hands it back intact. It just never reached a human, so a WebM run and a
 * signed MP4 run looked identical at the terminal: both "captured", one
 * silently carrying no credential. "Never silent" has to mean printed.
 *
 * `containerManifest` distinguishes a machine_manifest_hash the CONTAINER
 * measured from one the DB descriptor merely claimed, and `unboundInputs`
 * is the WO-27 decline — the difference between "no inputs" and "inputs we
 * could not account for".
 */
function reportProvenance(d: {
  containerManifest?: boolean;
  inputHash?: string | null;
  unboundInputs?: string[];
  c2pa?: { status: string; reason: string; outputPath?: string; digitalSourceType?: string; error?: string };
}): void {
  console.log(`  input_hash  : ${d.inputHash ?? 'NULL (declined)'}`);
  if (d.unboundInputs?.length) {
    console.log(`  UNBOUND     : ${d.unboundInputs.join(', ')} — input_hash declined, not asserted`);
  }
  console.log(`  container_manifest: ${d.containerManifest ? 'measured in-container' : 'NO — fell back to the DB descriptor claim'}`);
  if (d.c2pa) {
    const mark = d.c2pa.status === 'signed' ? '✓' : d.c2pa.status === 'failed' ? '✗' : '·';
    console.log(`  c2pa ${mark} ${d.c2pa.status}${d.c2pa.digitalSourceType ? ` (${d.c2pa.digitalSourceType})` : ''}`);
    console.log(`       ${d.c2pa.reason}`);
    if (d.c2pa.outputPath) console.log(`       → ${d.c2pa.outputPath}`);
    if (d.c2pa.error) console.log(`       error: ${d.c2pa.error}`);
  }
}

/**
 * --lock <action> : after capture, drives a sandbox Stripe PaymentIntent
 * → confirm → /api/lock/<action>. Action maps:
 *
 *    --lock checkpoint     →  Stripe 'checkpoint'   → /api/lock/checkpoint
 *    --lock local          →  Stripe 'finalize'     → /api/lock/local
 *    --lock chain-basic    →  Stripe 'chain-lock-basic'  → /api/lock/chain (tier=basic)
 *    --lock chain-pinned   →  Stripe 'chain-lock-pinned' → /api/lock/chain (tier=pinned)
 *
 * One CLI invocation drives capture → pay → lock with full witness
 * countersignature. Same paths a browser user takes in the UI.
 */
async function runLockIfRequested(
  spec: { projectId: number },
  base: string,
  cookie: string,
  session: string,
): Promise<void> {
  const idx = process.argv.indexOf('--lock');
  if (idx < 0) return;
  const action = process.argv[idx + 1];
  if (!action) { console.error('--lock requires an action: checkpoint|local|chain-basic|chain-pinned'); process.exit(2); }

  const stripeAction = (
    action === 'checkpoint' ? 'checkpoint' :
    action === 'local'      ? 'finalize' :
    action === 'chain-basic'  ? 'chain-lock-basic' :
    action === 'chain-pinned' ? 'chain-lock-pinned' :
    null
  );
  if (!stripeAction) { console.error(`unknown --lock action "${action}"`); process.exit(2); }

  // 1) Drive a sandbox Stripe PaymentIntent to succeeded (same as a
  //    browser Elements modal would).
  console.log(`  → creating test-mode PaymentIntent for ${stripeAction}…`);
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync('node', [
    new URL('./stripe-test-pay.mjs', import.meta.url).pathname,
    '--action', stripeAction,
    '--project', String(spec.projectId),
  ], { env: { ...process.env, SCRUPLE_SESSION: session, SCRUPLE_BASE: base }, encoding: 'utf8' });
  if (r.status !== 0) {
    console.error(`✗ stripe-test-pay failed:\n${r.stderr || r.stdout}`);
    process.exit(1);
  }
  const piMatch = (r.stdout || '').match(/PAYMENT_INTENT=(\S+)/);
  if (!piMatch) { console.error('✗ stripe-test-pay produced no PAYMENT_INTENT line'); process.exit(1); }
  const paymentIntentId = piMatch[1];
  console.log(`    payment_intent: ${paymentIntentId}`);

  // 2) Hit the matching lock route with the succeeded PaymentIntent.
  const lockPath =
    action === 'checkpoint'   ? '/api/lock/checkpoint' :
    action === 'local'        ? '/api/lock/local' :
    /* chain-basic|chain-pinned */ '/api/lock/chain';
  const body: Record<string, unknown> = { projectId: spec.projectId, paymentIntentId };
  if (action === 'chain-basic')  body.tier = 'basic';
  if (action === 'chain-pinned') body.tier = 'pinned';

  console.log(`  → POST ${lockPath} (tier=${body.tier ?? 'n/a'})…`);
  const lr = await fetch(`${base}${lockPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(body),
  });
  const ld = await lr.json().catch(() => ({}));
  if (!lr.ok || !ld.ok) {
    console.error(`✗ lock failed (HTTP ${lr.status}):`, JSON.stringify(ld, null, 2));
    process.exit(1);
  }
  console.log(`✓ ${action} locked`);
  console.log(`  scr           : ${ld.scrId ?? ld.preScrId}`);
  console.log(`  merkle_root   : ${(ld.merkleRoot ?? '').slice(0, 24)}…`);
  console.log(`  server_sig    : ${(ld.serverSignature ?? '').slice(0, 24)}…`);
  if (ld.proofTxId) console.log(`  rvn_tx        : ${ld.proofTxId.slice(0, 24)}…`);
  if (ld.ipfsCid)   console.log(`  ipfs_cid      : ${ld.ipfsCid.slice(0, 24)}…`);
  if (ld.arweaveTxId) console.log(`  arweave_tx    : ${ld.arweaveTxId.slice(0, 24)}…`);
}

main().catch((e) => {
  console.error('scruple-run error:', e);
  process.exit(1);
});
