// scruple-capture, assembled.
//
// Three duties (H-4 §2, and the WO that built this):
//
//   GATE    HTTP and WS reverse proxy. The only route to the tenant; the
//           tenant never learns the upstream URL. Tees POST /prompt for
//           workflow and input commitment, tees artifact egress, inspects WS
//           binary frames.
//   WATCH   the shared output volume, hashed on close. Tamper-evident (§6).
//   SUBMIT  build the leaf, MAC it with the ratchet, queue on failure, drain
//           on recovery.
//
// AND ONE PROPERTY THAT SPANS ALL THREE: no retrievable artifact leaves this
// component without a leaf. Both gate surfaces await the sink before
// forwarding a byte and fail closed if the counter cannot be spent; the
// watcher hashes what is already on disk, where "fail closed" is not
// available and the honest posture is a queued event and a visible gap.
//
// PLACEMENT IS DECLARED, NOT ASSUMED. resolvePlacement() from
// lib/capture/surface.ts reduces (declared, enforcement) to the placement the
// assurance function may see, and assuranceForHost() then says what this
// configuration can and cannot claim. It is logged at startup so an operator
// reads their own posture rather than inferring it, and so a component whose
// enforcement degraded to 'none' says `cannot claim the standard` out loud.

import http from 'node:http';
import path from 'node:path';

import {
  assuranceForHost,
  type HostAssurance,
  type HostCaptureProfile,
} from '../../../lib/capture/surface';
import type { CaptureConfig } from './config';
import { topologyAdvisory } from './config';
import { Correlator } from './correlation';
import { Identity } from './identity';
import { QueueStore } from './queue';
import { Submitter } from './submitter';
import { FsWatchSurface, QuiescenceSource, type CloseWriteSource } from './surfaces/fs-watch';
import { HttpGate } from './surfaces/http-gate';
import { WsGate } from './surfaces/ws-gate';

export interface ComponentDeps {
  identity?: Identity;
  fetchImpl?: typeof fetch;
  closeWriteSource?: CloseWriteSource;
  log?: (line: string) => void;
}

export class CaptureComponent {
  private constructor(
    readonly cfg: CaptureConfig,
    readonly identity: Identity,
    readonly correlator: Correlator,
    readonly queue: QueueStore,
    readonly submitter: Submitter,
    readonly httpGate: HttpGate,
    readonly wsGate: WsGate,
    readonly fsWatch: FsWatchSurface,
    readonly server: http.Server,
    readonly assurance: HostAssurance,
  ) {}

  get port(): number {
    const a = this.server.address();
    return typeof a === 'object' && a ? a.port : this.cfg.listenPort;
  }

  static async start(cfg: CaptureConfig, deps: ComponentDeps = {}): Promise<CaptureComponent> {
    const log = deps.log ?? ((l: string) => console.log(`[scruple-capture] ${l}`));

    const identity = deps.identity ?? (await Identity.open(cfg, deps.fetchImpl));
    const queue = new QueueStore(path.join(cfg.stateDir, 'queue.jsonl'));
    const correlator = new Correlator(cfg.correlationTtlMs);
    const submitter = new Submitter({
      identity,
      queue,
      apiBaseUrl: cfg.apiBaseUrl,
      apiKey: cfg.apiKey,
      baselineRef: cfg.baselineRef,
      fetchImpl: deps.fetchImpl,
      log,
    });

    const httpGate = new HttpGate({
      upstreamUrl: cfg.upstreamUrl,
      correlator,
      outputVolumeDeclaredMime: cfg.outputVolumeDeclaredMime,
      log,
    });
    const wsGate = new WsGate({ upstreamUrl: cfg.upstreamUrl, correlator, log });
    const fsWatch = new FsWatchSurface({
      outputVolume: cfg.outputVolume,
      correlator,
      outputVolumeDeclaredMime: cfg.outputVolumeDeclaredMime,
      source: deps.closeWriteSource ?? new QuiescenceSource(cfg.settleMs),
      log,
    });

    const server = http.createServer((req, res) => {
      void httpGate.handle(req, res).catch((e) => {
        log(`gate error: ${String(e)}`);
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
        res.end('scruple-capture: gate error\n');
      });
    });

    const profile: HostCaptureProfile = {
      host: 'comfyui',
      hooks: ['graph.execute', 'artifact.produced'],
      // BOTH, and this is the whole finding. A config naming one is
      // expressible and wrong — lib/capture/surface.ts calls that DEFECT-2
      // and says completeness is established outside the model, by H-4 §7
      // probes 4 and 5 and by ratchet gap accounting.
      surfaces: ['network-gate', 'filesystem-watch'],
      fidelity: 'as-delivered',
      declaredPlacement: 'sidecar-gate',
      enforcement: 'isolated-namespace',
      // No attestable compute here, so the IK is software-protected, the
      // build↔key binding is an assertion, and the leaf is `passthrough`
      // and says so (§4.3).
      attestation: identity.attestationStatus ?? 'none',
    };
    const assurance = assuranceForHost(profile);

    await httpGate.open({ sink: submitter, placement: assurance.placement, config: {} });
    await wsGate.open({ sink: submitter, placement: assurance.placement, config: { server } });
    await fsWatch.open({ sink: submitter, placement: assurance.placement, config: {} });

    await new Promise<void>((resolve) => server.listen(cfg.listenPort, cfg.listenHost, resolve));

    log(`component_id=${identity.componentId} counter=${identity.counter}`);
    log(`build_measurement=${identity.buildMeasurement} (drift detection only — §10 C-4)`);
    log(`assurance: ${assurance.reason}`);
    for (const c of assurance.conditions) log(`  condition: ${c}`);
    for (const n of topologyAdvisory(cfg)) log(`  advisory: ${n}`);

    // Anything the last run could not deliver goes out now, counters intact.
    const drained = await submitter.drain();
    if (drained.sent || drained.kept) {
      log(`queue: drained ${drained.sent}, ${drained.kept} still queued`);
    }

    return new CaptureComponent(
      cfg,
      identity,
      correlator,
      queue,
      submitter,
      httpGate,
      wsGate,
      fsWatch,
      server,
      assurance,
    );
  }

  async stop(): Promise<void> {
    await this.fsWatch.close();
    await this.wsGate.close();
    await this.httpGate.close();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    this.identity.destroy();
  }
}
