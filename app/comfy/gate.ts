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
// AND WO-D6 ADDS A SECOND ADAPTER THROUGH THE SAME SEAM, WHICH IS THE FINDING.
// `sinkWrap` takes one function and returns one sink; nothing in it says how
// many decorators may be inside. So the host hook needed no new seam at all:
// `hostAdapterSink` composes with `ModelStoreSink`, the host adapter adds what
// the HOST knows and the model store adapter adds what THIS MACHINE knows, and
// the two are independently switchable. A deployment with neither is Level 1
// and its leaves DECLARE `host_semantics: "blind"` — the SDK's leaf builder
// defaults to it, so blindness cannot be forgotten by the code that is absent.
//
// 🔴 The rails are enforced here rather than remembered: this process refuses
// to submit to :5799 or :3001 and refuses an upstream on either.

import fs from 'node:fs';
import path from 'node:path';

import {
  CaptureComponent,
  hostAdapterSink,
  DEFAULT_RETENTION_POLICY,
  DEFAULT_RETENTION_POLICY_DIGEST,
  DEFAULT_UPSTREAM_ANCHOR_WINDOW,
  DEFAULT_UPSTREAM_POLL_INTERVAL_MS,
  type CaptureConfig,
} from './sdk';
import { ModelStoreSink } from './modelSink';
import { openHostDeclaration } from './hostAdapter';
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
  /**
   * 🔴 ASK FOR A DRAIN WITHOUT A SIGNAL, because on Windows there are none.
   *
   * The launcher used to request a graceful shutdown with `SIGTERM`, and the
   * handler below drains the queue and writes `resultPath`. Node on Windows
   * maps `.kill('SIGTERM')` to `TerminateProcess`: the handler never runs, the
   * result file is never written, and the enrichment records the SIGTERM exists
   * to preserve are destroyed by the call that exists to preserve them.
   * Measured — see W1-E3 in docs/FINDINGS-WIN.md, where a real `blender-host`
   * run enriched ten fields, then lost the record and spent the launcher's full
   * 30s timeout waiting for a file that could never appear.
   *
   * So the request is a FILE, like every other observable in this protocol:
   * `request.json` in, `ready.json` out, `result.json` out, and now this one to
   * ask for the end. It works identically on both platforms, which means the
   * shutdown path the Linux gates exercise is the same one Windows takes rather
   * than a second implementation nobody runs.
   *
   * Optional: a launcher that does not set it keeps signal-only behaviour.
   */
  stopPath?: string;
  modelCeilingBytes?: number;
  /** Off means: no adapter in the path. The control. */
  fingerprints: boolean;
  /**
   * WO-D6. Where a HOST declares itself and announces its generations. null
   * is Level 1 — the whole integration is "point ComfyUI at the gate", which
   * is the point of there being a Level 1 at all.
   */
  hostDir?: string | null;
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

  // WO-D6. THE HOST HOOK, RESOLVED BEFORE THE COMPONENT STARTS. Reading the
  // declaration here rather than lazily means a refusal is visible in the
  // ready file — an operator learns that an add-on's manifest was rejected
  // when the gate comes up, not after a day of leaves that quietly say
  // `blind`.
  const host = openHostDeclaration(req.hostDir ?? null);
  log(`host hook: level ${host.outcome.level} — ${host.outcome.reason}`);
  if (host.outcome.refused) log(`host declaration REFUSED: ${host.outcome.refused.code}`);

  const modelSinks: ModelStoreSink[] = [];
  const hostSinks: Array<{ enrichments: unknown[] }> = [];

  // TWO ADAPTERS, COMPOSED, AND THAT IS THE SEAM WORKING AS DESIGNED.
  // `ComponentDeps.sinkWrap` takes one function and returns one sink; nothing
  // in it says how many decorators may be inside. The host adapter runs first
  // and adds what the HOST knows, the model store adapter runs next and adds
  // what THIS MACHINE knows, and the Submitter — which owns §5's ordering —
  // is underneath both and unaware of either.
  //
  // Each is independently switchable, which is what makes the controls
  // separable: SCRUPLE_COMFY_FINGERPRINTS=off removes one, a missing host
  // declaration removes the other, and neither removal is a second code path.
  const wrap =
    req.fingerprints || host.adapter
      ? {
          sinkWrap: (submitter: import('./sdk').ObservationSink) => {
            let sink: import('./sdk').ObservationSink = submitter;
            if (req.fingerprints) {
              const s = new ModelStoreSink({
                inner: sink,
                modelRoot: req.modelRoot,
                ...(req.modelCeilingBytes ? { ceilingBytes: req.modelCeilingBytes } : {}),
                log,
              });
              modelSinks.push(s);
              sink = s;
            }
            if (host.adapter) {
              const h = hostAdapterSink({ adapter: host.adapter, inner: sink, log });
              hostSinks.push(h as unknown as { enrichments: unknown[] });
              sink = h;
            }
            return sink;
          },
        }
      : {};

  const component = await CaptureComponent.start(cfg, { log, ...wrap });

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
    // WO-D6. WHICH LEVEL THIS DEPLOYMENT RUNS AT, and why — including a
    // refused declaration, which is Level 1 for a reason worth reading.
    hostHook: host.outcome,
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

  // ⚑ A GUARD, because there are now two ways in. The launcher may write the
  // stop file AND send SIGTERM — on POSIX both are available and it does both,
  // so that the platform which has signals keeps using them. Without this, two
  // drains would run concurrently and both would write `resultPath`.
  let finishing = false;
  let stopWatch: NodeJS.Timeout | null = null;

  const finish = async (sig: string): Promise<void> => {
    if (finishing) return;
    finishing = true;
    if (stopWatch) clearInterval(stopWatch);
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
          // WO-D6. What the HOST adapter did, per observation, including the
          // ones it declined and why. A run where the adapter was registered
          // and announced nothing must not look like a run with no adapter,
          // and this is where the operator sees which it was.
          hostEnrichments: hostSinks[0] ? hostSinks[0].enrichments : [],
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

  // Polled rather than `fs.watch`ed: the file appears once, latency of up to
  // one interval is irrelevant against a drain, and `fs.watch` semantics differ
  // per platform — which is the class of thing this change exists to stop
  // relying on. The interval is NOT unref'd; the listening server holds the
  // process open anyway, and an unref here would be a second thing to reason
  // about.
  if (req.stopPath) {
    const stopPath = req.stopPath;
    fs.rmSync(stopPath, { force: true });
    stopWatch = setInterval(() => {
      if (fs.existsSync(stopPath)) void finish(`stop file ${path.basename(stopPath)}`);
    }, 100);
  }
}

main().catch((e) => {
  console.error(`[comfy-gate] FATAL: ${String((e as Error).stack ?? e)}`);
  process.exit(1);
});
