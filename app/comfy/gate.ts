#!/usr/bin/env node
// THE CAPTURE GATE, AS A DESKTOP SIDECAR.
//
// docs/DESIGN.md puts it here in as many words: Electron main "runs: the
// capture gate (sidecar)". The same three reasons app/vault/run.ts is a
// separate process apply unchanged — the SDK is the server repo's TypeScript
// under its own tsx and tsconfig, the IK is a sealed key that has no business
// in a process running a BrowserWindow, and a gate that cannot provision must
// fail loudly and separately rather than take the window down.
//
// WHAT IT IS NOT: a reimplementation. `CaptureComponent.start` is the SDK's,
// and it brings the HTTP gate, the WS gate, the output-volume watcher, the
// Submitter with §5's ordering, the queue, the ratchet and the upstream
// bracket. This file supplies CONFIGURATION and ONE ADAPTER.
//
// THE ADAPTER IS THE WHOLE OF WO-D4'S SECOND HALF. `ModelStoreSink` wraps the
// Submitter and adds `model_fingerprints` computed from the files under the
// local model root. It is passed through `deps.sinkWrap`, which is absent by
// default — so `SCRUPLE_COMFY_FINGERPRINTS=off` runs the identical gate with
// no adapter and produces a leaf with `model_fingerprints` NULL. That is the
// control, and it is one environment variable rather than a second code path.
//
// 🔴 The rails are enforced here rather than remembered: this process refuses
// to submit to :5799 or :3001 and refuses an upstream on either.

import fs from 'node:fs';
import path from 'node:path';

import {
  CaptureComponent,
  DEFAULT_RETENTION_POLICY,
  DEFAULT_RETENTION_POLICY_DIGEST,
  DEFAULT_UPSTREAM_ANCHOR_WINDOW,
  DEFAULT_UPSTREAM_POLL_INTERVAL_MS,
  type CaptureConfig,
} from './sdk';
import { ModelStoreSink } from './modelSink';
import { readNamespaceIsolation } from './namespace';

export interface GateRequest {
  upstreamUrl: string;
  listenHost: string;
  listenPort: number;
  /** ComfyUI's base directory. The watched volumes and the model root are
   *  derived from it, so one configured path cannot disagree with another. */
  comfyBaseDir: string;
  modelRoot: string;
  stateDir: string;
  appUrl: string;
  apiKey: string;
  baselineRef: string;
  provisioningToken: string | null;
  /** Written when the gate is listening. The launcher waits on it — a file
   *  that exists is an observable; a line on stdout is a log. */
  readyPath: string;
  /** Written on shutdown, with everything the driver reads. */
  resultPath: string;
  modelCeilingBytes?: number;
  /** Off means: no adapter in the path. The control. */
  fingerprints: boolean;
}

const log = (l: string) => console.log(`[comfy-gate] ${l}`);

async function main(): Promise<void> {
  const reqPath = process.argv[2];
  if (!reqPath) {
    console.error('usage: gate.ts <request.json>');
    process.exit(2);
  }
  const req = JSON.parse(fs.readFileSync(reqPath, 'utf8')) as GateRequest;

  for (const [what, url] of [['api', req.appUrl], ['upstream', req.upstreamUrl]] as const) {
    if (url.includes(':5799') || url.includes(':3001')) {
      console.error(`[comfy-gate] refusing: ${what} ${url} is production`);
      process.exit(2);
    }
  }

  fs.mkdirSync(req.stateDir, { recursive: true, mode: 0o700 });

  const cfg: CaptureConfig = {
    upstreamUrl: req.upstreamUrl,
    listenHost: req.listenHost,
    listenPort: req.listenPort,
    // C-8's three roots, each carrying its type, derived from the base
    // directory ComfyUI was launched with. Nested roots are refused by
    // resolveWatchedVolumes, and these three are siblings.
    watchedVolumes: [
      { type: 'output', path: path.join(req.comfyBaseDir, 'output') },
      { type: 'temp', path: path.join(req.comfyBaseDir, 'temp') },
      { type: 'input', path: path.join(req.comfyBaseDir, 'input') },
    ],
    stateDir: req.stateDir,
    // TRUE, AND IT IS A CONFESSION RATHER THAN A CONVENIENCE. On a desktop the
    // state directory and the output volume are the same device essentially
    // always, and `measureStorageConfinement` says so on every emission. The
    // alternative is a component that refuses to start on the machine it was
    // designed for; the honest arrangement is to start, and to have every leaf
    // carry the degraded reading.
    allowDegradedStorage: true,
    stateMinReservableBytes: 64 * 1024 * 1024,
    apiBaseUrl: req.appUrl,
    apiKey: req.apiKey,
    provisioningToken: req.provisioningToken,
    baselineRef: req.baselineRef,
    // Nobody enrolled an authority for this desktop. null, never a plausible
    // string — the same rule app/vault/run.ts follows.
    witnessAuthority: null,
    retentionPolicyDigest: DEFAULT_RETENTION_POLICY_DIGEST,
    settlementWindowSeconds: DEFAULT_RETENTION_POLICY.settlement_window_s,
    // ComfyUI sets a content type on /view from the file it serves, so the
    // gate gets a declaration per response and needs no blanket one. null
    // rather than 'image/png': a blanket declaration would type the bytes the
    // WATCHER finds too, and those arrive with nobody having declared
    // anything.
    outputVolumeDeclaredMime: null,
    upstreamPollIntervalMs: DEFAULT_UPSTREAM_POLL_INTERVAL_MS,
    upstreamMaxReadingAgeMs: DEFAULT_UPSTREAM_POLL_INTERVAL_MS * 2,
    upstreamAnchorWindow: DEFAULT_UPSTREAM_ANCHOR_WINDOW,
    settleMs: 400,
    correlationTtlMs: 10 * 60 * 1000,
    heartbeatWindowSeconds: 300,
  };

  const modelSinks: ModelStoreSink[] = [];
  const component = await CaptureComponent.start(cfg, {
    log,
    ...(req.fingerprints
      ? {
          sinkWrap: (inner) => {
            const s = new ModelStoreSink({
              inner,
              modelRoot: req.modelRoot,
              ...(req.modelCeilingBytes ? { ceilingBytes: req.modelCeilingBytes } : {}),
              log,
            });
            modelSinks.push(s);
            return s;
          },
        }
      : {}),
  });

  const ready = {
    pid: process.pid,
    listenHost: cfg.listenHost,
    listenPort: component.port,
    gateUrl: `http://${cfg.listenHost}:${component.port}`,
    upstreamUrl: cfg.upstreamUrl,
    modelRoot: req.modelRoot,
    watchedVolumes: cfg.watchedVolumes,
    componentId: component.identity.componentId,
    buildMeasurement: component.identity.buildMeasurement,
    adapter: req.fingerprints ? 'model-store' : null,
    // MEASURED, beside the placement the component DECLARES. See
    // app/comfy/namespace.ts: on a desktop the two disagree, and the record
    // says so rather than letting the string stand unexamined.
    isolation: readNamespaceIsolation(),
    assurance: {
      placement: component.assurance.resolution.effective,
      enforcement: component.assurance.resolution.enforcement,
      canClaim: component.assurance.canClaim,
      reason: component.assurance.reason,
    },
    startedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(req.readyPath), { recursive: true });
  fs.writeFileSync(req.readyPath, JSON.stringify(ready, null, 2));
  log(`listening on ${ready.gateUrl} → ${cfg.upstreamUrl} · adapter ${ready.adapter ?? 'none'}`);

  const finish = async (sig: string): Promise<void> => {
    log(`${sig}; draining before exit`);
    const drained = await component.submitter.drain().catch(() => ({ sent: 0, kept: -1 }));
    await component.stop().catch(() => undefined);
    const sink = modelSinks[0] ?? null;
    fs.writeFileSync(
      req.resultPath,
      JSON.stringify(
        {
          ...ready,
          finishedAt: new Date().toISOString(),
          drained,
          queueDepth: component.queue.loadAll().length,
          counter: component.identity.counter,
          // What the adapter did, per observation, including the ones it
          // declined to enrich and why. A run where nothing was enriched must
          // not look like a run with no adapter.
          enrichments: sink ? sink.enrichments : [],
          modelStoreReport: sink ? sink.lastReport : null,
          unenumeratedEgress: component.httpGate.unenumeratedEgress,
        },
        null,
        2,
      ),
    );
    log(`wrote ${req.resultPath}`);
    process.exit(0);
  };

  process.on('SIGTERM', () => void finish('SIGTERM'));
  process.on('SIGINT', () => void finish('SIGINT'));
}

main().catch((e) => {
  console.error(`[comfy-gate] FATAL: ${String((e as Error).stack ?? e)}`);
  process.exit(1);
});
