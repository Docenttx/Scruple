#!/usr/bin/env node
// The tenant-facing surface, in the container — WO-19.
//
// ---------------------------------------------------------------------------
// WHY THERE ARE TWO JOB APIS AND THAT IS NOT DUPLICATION
// ---------------------------------------------------------------------------
//
// `app/api/apps/kohya/jobs/route.ts` is Studio's product surface: the browser
// posts a job, it is recorded against a training run, the receipt reports the
// tier. This file is the surface INSIDE the container — what Studio's proxy
// actually forwards to, and what the tenant can reach.
//
// The placement argument depends on the second one, not the first. A tenant
// who can reach the pod's port bypasses Studio's route entirely, so a
// whitelist enforced only in Next.js would be a whitelist enforced only
// against clients that chose to use it. Both validate, and BOTH IMPORT THE
// SAME MODULE — lib/apps/kohya/job-spec.ts. A second parser here, however
// carefully written, would be a second parser to keep in step, and the two
// would come apart exactly once, silently, at the worst moment.
//
// What this server exposes, in full:
//
//   POST /jobs      a validated training job. Data and hyperparameters.
//   GET  /health    liveness, and the derived assurance, so an operator can
//                   see the tier the running configuration actually earns
//                   rather than the one a document claims.
//
// There is no endpoint that takes a command, a path, an argument string or an
// environment variable, because there is no such thing in the schema.
//
// PID 1. This process is the container's init (research/scruple-kohya-image/
// Dockerfile.jobapi CMD → start-jobapi.sh `exec`), and the trainer is its
// child. See job-runner.ts on why that is an obligation and not a detail.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { validateJobSpec } from '../../../lib/apps/kohya/job-spec';
import type { ComponentRoots } from '../../../lib/apps/kohya/argv';
import type { CaptureConfig } from '../src/config';
import { Identity } from '../src/identity';
import { QueueStore } from '../src/queue';
import { Submitter } from '../src/submitter';
import { StudioJobRunner } from './job-runner';

const PORT = Number(process.env.SCRUPLE_KOHYA_JOB_API_PORT ?? 8899);

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set. The job API refuses to start without it.`);
  return v;
}

function rootsFromEnv(): ComponentRoots {
  return {
    modelsRoot: path.resolve(need('SCRUPLE_KOHYA_MODELS_ROOT')),
    datasetsRoot: path.resolve(need('SCRUPLE_KOHYA_DATASETS_ROOT')),
    outputRoot: path.resolve(need('SCRUPLE_KOHYA_OUTPUT_ROOT')),
    loggingRoot: path.resolve(need('SCRUPLE_KOHYA_LOGGING_ROOT')),
  };
}

function captureConfig(roots: ComponentRoots): CaptureConfig {
  return {
    // The ComfyUI-only fields carry values that are never used on this path
    // rather than being faked into something plausible — a gate URL this
    // deployment does not have would read as a topology claim.
    upstreamUrl: '',
    listenHost: '',
    listenPort: 0,
    outputVolume: roots.outputRoot,
    stateDir: path.resolve(process.env.SCRUPLE_CAPTURE_STATE_DIR ?? '/var/lib/scruple-capture'),
    apiBaseUrl: need('SCRUPLE_API_URL').replace(/\/+$/, ''),
    apiKey: need('SCRUPLE_API_KEY'),
    provisioningToken: process.env.SCRUPLE_CAPTURE_PROVISIONING_TOKEN || null,
    baselineRef: process.env.SCRUPLE_CAPTURE_BASELINE_REF || null,
    outputVolumeDeclaredMime: process.env.SCRUPLE_KOHYA_VOLUME_MIME || null,
    settleMs: 15_000,
    correlationTtlMs: 0,
    heartbeatWindowSeconds: 900,
  };
}

function readBody(req: http.IncomingMessage, limitBytes = 256 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let n = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      n += c.length;
      // A job is a few hundred bytes of scalars. A megabyte of it is not a
      // job, and refusing early is cheaper than parsing to find out.
      if (n > limitBytes) reject(new Error('body too large'));
      else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function main(): Promise<void> {
  const roots = rootsFromEnv();
  const cfg = captureConfig(roots);

  // Identity BEFORE the listener, and the order is index.ts's for the same
  // reason: a component that cannot obtain an identity must not accept a job
  // it would then be unable to witness.
  const identity = await Identity.open(cfg);
  const queue = new QueueStore(path.join(cfg.stateDir, 'queue.jsonl'));
  const submitter = new Submitter({
    identity,
    queue,
    apiBaseUrl: cfg.apiBaseUrl,
    apiKey: cfg.apiKey,
    baselineRef: cfg.baselineRef,
  });

  const runner = await StudioJobRunner.start(
    { roots, declaredMime: cfg.outputVolumeDeclaredMime },
    submitter,
  );

  const server = http.createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      const s = JSON.stringify(body);
      res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) });
      res.end(s);
    };

    void (async () => {
      // WO-35 — boot diagnostics, surfaced on the one endpoint that exists.
      //
      // The boot script runs before this process does, so when IT fails there
      // is nothing listening and nothing to ask. That happened: a fail-closed
      // interpreter check exited non-zero, the container came up with no API,
      // and the only signal available anywhere was a 404. Fail-closed was
      // right; failing INVISIBLY was not.
      //
      // The contract is one file: the boot script may write
      // `$SCRUPLE_CAPTURE_STATE_DIR/boot.json`, and whatever is in it is
      // echoed here verbatim under `boot`. The component does not interpret
      // it and does not vouch for it — it is the environment describing
      // itself, reported rather than trusted.
      if (req.method === 'GET' && req.url === '/health') {
        return send(200, {
          // Unparseable or absent is reported as such rather than omitted:
          // "no boot report" and "a boot report we could not read" are
          // different facts about the container.
          boot: (() => {
            try {
              const f = path.join(
                process.env.SCRUPLE_CAPTURE_STATE_DIR ?? '/var/lib/scruple-capture',
                'boot.json',
              );
              if (!fs.existsSync(f)) return null;
              return JSON.parse(fs.readFileSync(f, 'utf8')) as unknown;
            } catch (e) {
              return { unreadable: e instanceof Error ? e.message : String(e) };
            }
          })(),
          ok: true,
          component_id: identity.componentId,
          counter: identity.counter,
          // The tier this RUNNING configuration earns, derived on the spot.
          placement: runner.assurance.placement,
          leaf: runner.assurance.leaf,
          findings: runner.assurance.findings,
          needs_probe: runner.assurance.needsProbe,
        });
      }

      // WO-35 — operator-facing job state.
      //
      // Until this existed a caller got a 202 and then silence: the trainer's
      // output went to the container log via stdio:'inherit', RunPod's REST v1
      // has no log endpoint, and this component deliberately has no shell. A
      // failed job was indistinguishable from a slow one, which is how the
      // first real training run on real hardware ended.
      //
      // "No file browser, no log tail, no exec, no static root" still holds —
      // this is not any of those. It is a fixed set of fields about jobs THIS
      // process started, plus a bounded tail of the trainer's own output.
      // `progress-stream` is already one of the exposed surfaces the placement
      // declares; this fills in a declared surface rather than adding one.
      if (req.method === 'GET' && req.url === '/jobs') {
        return send(200, { jobs: runner.listJobs() });
      }
      if (req.method === 'GET' && req.url?.startsWith('/jobs/')) {
        const id = req.url.slice('/jobs/'.length);
        const rec = runner.jobStatus(id);
        if (!rec) return send(404, { error: 'no such job in this process' });
        // Deliberately NOT reporting `witnessed` here. Whether a checkpoint
        // became a leaf is the watcher's answer; "the trainer exited 0" is
        // not "a leaf exists", and merging them is the substitution this
        // estate keeps finding in other people's code.
        return send(200, rec);
      }

      if (req.method !== 'POST' || req.url !== '/jobs') {
        // No file browser, no log tail, no exec, no static root. The absence
        // is the product.
        return send(404, {
          error: 'the only endpoints are POST /jobs, GET /jobs, GET /jobs/<id> and GET /health',
        });
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(await readBody(req));
      } catch (e) {
        return send(400, { error: String(e instanceof Error ? e.message : e) });
      }

      const result = validateJobSpec(parsed);
      if (!result.ok) {
        return send(400, {
          error: 'job refused',
          refusals: result.refusals,
          reason:
            'This endpoint accepts data and hyperparameters, never a command, and denies by ' +
            'default. It validates with the same module Studio does, so a client that ' +
            'reaches the container directly gets the same answer.',
        });
      }

      const jobId = `kj_${crypto.randomBytes(8).toString('hex')}`;
      try {
        const started = await runner.startJob(jobId, result.spec);
        return send(202, {
          ok: true,
          job_id: jobId,
          spec_hash: started.specHash,
          placement: runner.assurance.placement,
          // Accepting a job is not observing an artifact.
          witnessed: false,
          reason:
            'The trainer has started. A checkpoint becomes witnessed when the component ' +
            'observes it close on the output volume and a leaf is issued for it.',
        });
      } catch (e) {
        // Includes the pre-spawn assertion in job-runner.ts. If that fires,
        // the whitelist and the classification table have disagreed and the
        // tier is wrong — which must surface as a refusal, not a process.
        return send(500, { error: e instanceof Error ? e.message : String(e) });
      }
    })().catch(() => send(500, { error: 'internal error' }));
  });

  // 0.0.0.0 because the only route in is RunPod's proxy, which terminates at
  // this port and nowhere else — the pod's `ports` array names one port and
  // it is this one, never a trainer's.
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[scruple-capture/kohya-jobs] job API on :${PORT} — no GUI, no shell`);
  });

  const drainTimer = setInterval(() => void submitter.drain().catch(() => undefined), 30_000);
  drainTimer.unref();

  const shutdown = async (sig: string) => {
    console.log(`[scruple-capture/kohya-jobs] ${sig}; draining before exit`);
    clearInterval(drainTimer);
    server.close();
    await submitter.drain().catch(() => undefined);
    await runner.stop();
    identity.destroy();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`[scruple-capture/kohya-jobs] FATAL: ${String(e)}`);
    process.exit(1);
  });
}
