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
  type ObservationSink,
} from '../../../lib/capture/surface';
import { profileFor } from '../../../lib/leaf/attestationBasis';
// WO-C4. Measured at startup AND re-measured on every emission. The module's
// header carries the argument for both halves.
import {
  measureStorageConfinement,
  startupDecision,
  type StorageMeasurement,
} from '../../../lib/capture/storageConfinement';
// WO-C5. The council owned upstream restart detection rather than pushing it
// into the schema: "we never ask ComfyUI who it is."
import { UpstreamTracker } from '../../../lib/capture/upstreamEpoch';
// WO-E2. The absence set: `/history`'s outputs, minus what this component
// captured, carrying the scope it enumerated over.
import {
  CapturedLedger,
  artifactsInOutputs,
  buildAbsenceSet,
  type ArtifactRef,
  type ArtifactVolumeType,
} from '../../../lib/capture/declaredUncaptured';
import type { CaptureConfig } from './config';
import { resolveWatchedVolumes, topologyAdvisory } from './config';
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
  /** WO-C5. The seam for stubbing the UPSTREAM's HTTP, kept separate from
   *  `fetchImpl` so an API fixture cannot answer for ComfyUI. */
  upstreamFetchImpl?: typeof fetch;
  closeWriteSource?: CloseWriteSource;
  /**
   * WO-D4. THE HOST ADAPTER SEAM. A wrapper placed between the surfaces and
   * the Submitter, so a host can add to an observation what the gate
   * structurally cannot see.
   *
   * The gate observes a wire. A workflow that says `lora_name:
   * "client-secret.safetensors"` gives it a STRING; turning that into the
   * weights that were actually on the disk needs a model directory, and a
   * component deployed in front of somebody else's ComfyUI does not have one.
   * A desktop host does. Scruple Desktop Studio's `ModelStoreSink` uses this
   * to supply `model_fingerprints`, which is the difference between "a file
   * with that name was referenced" and "these bytes were there".
   *
   * IT IS AN `ObservationSink`, WHICH IS THE POINT. surface.ts already calls
   * that "the interface a vendor implements for a host we have not met", so a
   * host adapter is not a new contract — it is the existing one, composed. A
   * wrapper sits ABOVE §5's ordering and below nothing: the Submitter it
   * receives still owns derive → MAC → ratchet → persist → enqueue, and a
   * wrapper cannot spend a counter, cannot MAC and cannot reach the network.
   *
   * IT MAY NOT SWALLOW. Both gate surfaces await `sink.emit` before
   * forwarding a byte and fail closed if it throws, so a wrapper that dropped
   * an observation would silently un-witness an artifact. That obligation is
   * on the wrapper; nothing here can enforce it, which is why the seam takes
   * a function rather than a list of fields to merge.
   *
   * Absent by default. A deployment that passes nothing gets exactly the
   * component it got before this parameter existed — which is what makes
   * "the same generation with no adapter" a usable control.
   */
  sinkWrap?: (sink: ObservationSink) => ObservationSink;
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
    /**
     * WO-C5. THE POLLER, held so `stop()` can clear its timer and so an
     * acceptance test can drive `poll()` by hand instead of racing an
     * interval. Its readings are the component's, not the leaf's — the leaf
     * carries what `observationFor()` said at ITS observation time.
     */
    readonly upstream: UpstreamTracker,
    /**
     * WO-E2. THE CAPTURED-SET LEDGER — what this component actually witnessed,
     * keyed the way `/history` keys its outputs. Held on the component so an
     * acceptance test can read `size` and `intact` directly rather than
     * inferring them from a leaf, and because the bound is a fact about the
     * session rather than about any one emission.
     */
    readonly captured: CapturedLedger,
    /**
     * WO-C4. THE STARTUP READING, KEPT SO IT CAN BE COMPARED AGAINST — never
     * so it can be reused. Every leaf re-measures; this one exists only for
     * the operator's log and for the test that proves a startup-only check
     * does not catch a bind mount performed after boot.
     */
    readonly storageAtStartup: StorageMeasurement,
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

    // WO-C1. The trust profile is derived from the EFFECTIVE placement — the
    // one `resolvePlacement()` produced after checking that the enforcement
    // mechanism is actually there — and never from `declaredPlacement`. A
    // profile a host assigns itself is DEFECT-1 one level up.
    //
    // This block moved ABOVE the Submitter in WO-C1, because the Submitter
    // now needs it. Nothing in it changed.
    const trustProfile = profileFor(assurance.resolution.effective);

    // WO-C4. The configured roots, as PATHS. Resolved once because a path
    // string is configuration; the DEVICE BEHIND IT is the fact, and that is
    // read fresh by `measureStorageConfinement()` every time it is called.
    const volumePaths = resolveWatchedVolumes(cfg, 'CaptureComponent.start').map((v) => v.path);

    // WO-C5. Constructed BEFORE the Submitter, because the Submitter takes its
    // reader; started BELOW the storage gate, because a component that is
    // about to refuse to bind should not first go and interrogate an upstream
    // it will never proxy for.
    const upstream = new UpstreamTracker({
      upstreamUrl: cfg.upstreamUrl,
      pollIntervalMs: cfg.upstreamPollIntervalMs,
      maxReadingAgeMs: cfg.upstreamMaxReadingAgeMs,
      anchorWindow: cfg.upstreamAnchorWindow,
      // ⚑ `deps.fetchImpl` IS DELIBERATELY NOT PASSED HERE. That injection
      // point exists so a test can stand in for the scruple-web API the
      // Submitter posts to; the upstream is a different endpoint with a
      // different owner, and handing the API's stub to the tracker would let a
      // fixture answer `/system_stats` on ComfyUI's behalf. `deps.upstreamFetchImpl`
      // is the seam for stubbing THIS one, and it is separate on purpose.
      ...(deps.upstreamFetchImpl ? { fetchImpl: deps.upstreamFetchImpl } : {}),
      log,
    });

    // WO-E2. Built here rather than inside the Submitter because it is a
    // SESSION-scoped fact: the same ledger has to see every surface's captures,
    // and a per-leaf object would be an empty ledger on every diff.
    const captured = new CapturedLedger();

    // WO-E2. The typed roots, as the absence set records them. Same resolution
    // the watcher and the confinement measurement use — one answer to what is
    // configured, not three.
    const declaredRoots: Array<{ type: ArtifactVolumeType; path: string }> =
      resolveWatchedVolumes(cfg, 'CaptureComponent.start').map((v) => ({
        type: v.type,
        path: v.path,
      }));

    const submitter = new Submitter({
      identity,
      queue,
      apiBaseUrl: cfg.apiBaseUrl,
      apiKey: cfg.apiKey,
      baselineRef: cfg.baselineRef,
      profile: trustProfile,
      enforcement: assurance.resolution.enforcement,
      // WO-C2. The authority identity that rides in the MAC preimage beside
      // the endpoint. null when the deployment enrolled none — see
      // CaptureConfig.witnessAuthority for why that is not defaulted.
      witnessAuthority: cfg.witnessAuthority,
      // WO-C3. The retention policy every leaf from this component names, and
      // the window its settlement deadline is computed over. Both from config
      // — see CaptureConfig for why neither is defaulted at this layer.
      retentionPolicyDigest: cfg.retentionPolicyDigest,
      settlementWindowSeconds: cfg.settlementWindowSeconds,
      // WO-C4. A FUNCTION, not a value, and that is the whole of Architect's
      // condition: "a startup-only check is a config-inherited fact by the
      // time the leaf is emitted — volumes can be remounted or bind-mounted
      // after boot, which is exactly the inheritance pattern we killed on
      // `pinned_build`." Passing `storage` here instead of `() => measure(...)`
      // would ship the defect this work order closes.
      confinementFor: () =>
        measureStorageConfinement({
          stateDir: cfg.stateDir,
          volumes: volumePaths,
          minReservableBytes: cfg.stateMinReservableBytes,
        }),
      // WO-C5. A FUNCTION for the same structural reason `confinementFor` is,
      // and with the same consequence if someone replaces it with a value: a
      // component that captured one observation and passed it would report the
      // upstream it saw at startup for the rest of the session, which is the
      // config-inherited class the council killed on `pinned_build` and is
      // precisely the defect that makes a restart look like a quiet afternoon.
      upstreamFor: (observedAtMs: number) => upstream.observationFor(observedAtMs).observation,
      // WO-E2. THE ABSENCE SET, BUILT FROM THE UPSTREAM OBSERVATION THE LEAF
      // ALREADY CARRIES — `buildLeaf` passes it in rather than this closure
      // reading the tracker a second time. A `complete` scope beside an
      // `upstream_uncaptured_reason` that is not `enumerated` is a closure
      // claimed over a window the same leaf says it could not enumerate, and
      // `captureClaims.ts` rule 8 returns 422 for exactly that pair. Two
      // readings taken either side of a poll boundary could produce it; one
      // reading passed to both cannot.
      uncapturedFor: (upstreamObservation) => {
        const window = upstream.enumerationWindow();
        const enumerated =
          window === null
            ? null
            : window.outputs.flatMap((e) =>
                artifactsInOutputs(e.outputs).map((a) => ({ ...a, prompt_id: e.prompt_id })),
              );
        const built = buildAbsenceSet({
          enumerated,
          anchorWindow: upstream.anchorWindow,
          entriesEnumerated: window?.outputs.length ?? 0,
          roots: declaredRoots,
          isCaptured: (r: ArtifactRef) => captured.has(r),
          ledgerIntact: captured.intact,
          upstream: upstreamObservation,
        });
        return { observation: built.observation, document: built.document, reason: built.reason };
      },
      // WO-E2. The write side, called before the leaf is built. See
      // SubmitterOptions.recordCaptured for why the order is the point.
      recordCaptured: (ref: ArtifactRef) => captured.record(ref),
      // No quote source: this component has no attestable compute. That is
      // `passthrough` once the Merkle blocker lifts, and `stale` until then.
      // `sealToMeasurement()` in identity.ts is the seam where a real one
      // goes; it throws rather than returning something that pretends.
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
    // §10 C-8: one watcher per declared root, each carrying its type. An
    // injected source is passed through as-is so FsWatchSurface's own guard
    // refuses it for a multi-root configuration rather than watching one third
    // of the surface quietly.
    const fsWatch = new FsWatchSurface({
      watchedVolumes: resolveWatchedVolumes(cfg, 'CaptureComponent.start'),
      correlator,
      outputVolumeDeclaredMime: cfg.outputVolumeDeclaredMime,
      ...(deps.closeWriteSource
        ? { source: deps.closeWriteSource }
        : { sourceFactory: () => new QuiescenceSource(cfg.settleMs) }),
      log,
    });

    const server = http.createServer((req, res) => {
      void httpGate.handle(req, res).catch((e) => {
        log(`gate error: ${String(e)}`);
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
        res.end('scruple-capture: gate error\n');
      });
    });

    // WO-D4. The one sink every surface emits into, after the host's adapter
    // has had it. `submitter` stays the field on the component — `drain()`,
    // the queue and the counter are all still its — and what the surfaces
    // hold is the composition.
    const sink: ObservationSink = deps.sinkWrap ? deps.sinkWrap(submitter) : submitter;
    if (deps.sinkWrap) log('host adapter: an ObservationSink wrapper is in the path');

    await httpGate.open({ sink, placement: assurance.placement, config: {} });
    await wsGate.open({ sink, placement: assurance.placement, config: { server } });
    await fsWatch.open({ sink, placement: assurance.placement, config: {} });

    // ---- WO-C4: THE STORAGE GATE, BEFORE THE SOCKET IS BOUND ----------
    //
    // IT Expert's severity ruling, and the position in this function is the
    // ruling: "the startup check should measure stat(stateDir).st_dev !==
    // stat(outputVolume).st_dev and verify that stateDir has an enforced quota
    // or minimum reservable capacity via statvfs BEFORE BINDING THE PROXY
    // SOCKET." Above every `listen`, below every surface that could accept a
    // byte — a component that refused after binding has already told a tenant
    // it is open.
    //
    // The surfaces above are opened but not listening: `httpGate.open` and
    // `fsWatch.open` prepare state, and `wsGate.open` attaches to `server`,
    // which has no socket until the line below. Throwing here therefore leaves
    // nothing reachable, which `stop()` on the failure path would otherwise
    // have to undo.
    const storageAtStartup = measureStorageConfinement({
      stateDir: cfg.stateDir,
      volumes: volumePaths,
      minReservableBytes: cfg.stateMinReservableBytes,
    });
    const decision = startupDecision(storageAtStartup, {
      allowDegraded: cfg.allowDegradedStorage,
    });
    if (!decision.ok) {
      await fsWatch.close();
      await wsGate.close();
      await httpGate.close();
      throw new StorageConfinementError(decision.message);
    }
    // Logged whether it passed or degraded, and BEFORE the port is announced,
    // so an operator reading the boot log sees the posture above the address.
    log(decision.message);

    await new Promise<void>((resolve) => server.listen(cfg.listenPort, cfg.listenHost, resolve));

    // WO-C5. The first bracket is AWAITED, and that is not politeness. A
    // component that started its poller and returned would emit its earliest
    // leaves with `not_queried` — "nobody asked" — when in fact it was about
    // to ask, and `not_queried` is the one value the council insisted must
    // stay distinguishable from a real enumeration failure. Awaiting one
    // bracket means the first leaf carries a measurement or a named reason it
    // could not be taken.
    await upstream.poll().catch(() => undefined);
    upstream.start();

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
      upstream,
      captured,
      storageAtStartup,
    );
  }

  async stop(): Promise<void> {
    this.upstream.stop();
    await this.fsWatch.close();
    await this.wsGate.close();
    await this.httpGate.close();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    this.identity.destroy();
  }
}

/**
 * WO-C4. Thrown instead of binding. A distinct class rather than a bare Error
 * so a supervisor can tell "this deployment is misconfigured and will stay
 * misconfigured until somebody moves a mount" apart from a transient start
 * failure worth retrying. Restarting does not fix a shared filesystem.
 */
export class StorageConfinementError extends Error {}
