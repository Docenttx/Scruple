#!/usr/bin/env node
// scruple-capture, Kohya profile. The runner, and the refusal.
//
// WO-11b. Read docs/canon/KOHYA_REPLACEMENT.md first; profile.ts is the
// executable half of it and this file is what happens when you try to start.
//
// ---------------------------------------------------------------------------
// THE MOST IMPORTANT THING THIS FILE DOES IS REFUSE TO START
// ---------------------------------------------------------------------------
//
// PLACEMENT_AND_SURFACES.md §5.1 rule 1: at `unattested-client`, P1 fails, P3
// fails, NO LEAF MAY BE ISSUED, and attestation is not consulted. §4.1 says the
// value exists so that the model can refuse rather than bend.
//
// A component that started anyway and emitted "recorded, not witnessed" events
// would be a second implementation of the thing WO-11a just finished removing
// — a capture path that looks live and produces no evidence. So the refusal is
// at startup, before a watcher binds, and the error names the obligation that
// was not met. The vendor's remedy is a topology change, not a flag.
//
// On RunPod Pods as RunPod offers them, this refuses. That is the finding, and
// the code asserting it is the point: see RUNPOD_POD_TOPOLOGY in profile.ts and
// §3 of the doc for why each obligation fails there.

import path from 'node:path';

import type { CaptureConfig } from '../src/config';
import { Identity } from '../src/identity';
import { QueueStore } from '../src/queue';
import { Submitter } from '../src/submitter';
// WO-C4. The per-leaf storage measurement. See the note in `asCaptureConfig`
// for why the startup half does not apply on this path.
import {
  DEFAULT_MIN_RESERVABLE_BYTES,
  measureStorageConfinement,
} from '../../../lib/capture/storageConfinement';
import { CheckpointWatchSurface, DEFAULT_CHECKPOINT_SETTLE_MS } from './checkpoint-watch';
import { profileFor } from '../../../lib/leaf/attestationBasis';
import type { CloseWriteSource } from '../src/surfaces/fs-watch';
import {
  resolveKohyaPlacement,
  type KohyaAssurance,
  type KohyaTopology,
} from './profile';
import {
  DEFAULT_RETENTION_POLICY,
  DEFAULT_RETENTION_POLICY_DIGEST,
} from '../../../lib/leaf/retentionPolicy';
import {
  DEFAULT_UPSTREAM_ANCHOR_WINDOW,
  DEFAULT_UPSTREAM_POLL_INTERVAL_MS,
} from '../../../lib/capture/upstreamEpoch';

export class PlacementRefusal extends Error {
  constructor(
    readonly assurance: KohyaAssurance,
    message: string,
  ) {
    super(message);
    this.name = 'PlacementRefusal';
  }
}

export interface KohyaCaptureConfig {
  /** The checkpoint output volume, mounted into the component. */
  checkpointVolume: string;
  /** Sealed IK, counter, and the durable queue. 0700, owned by a principal
   *  the tenant is not — which is obligation 2 restated as a file mode. */
  stateDir: string;
  apiBaseUrl: string;
  apiKey: string;
  provisioningToken: string | null;
  baselineRef: string | null;
  /** The vendor's declaration for the volume. Never guessed. */
  declaredMime: string | null;
  settleMs: number;
  /** The vendor's declared topology. Defaults are all false. */
  topology: KohyaTopology;
}

export interface KohyaCaptureDeps {
  identity?: Identity;
  fetchImpl?: typeof fetch;
  closeWriteSource?: CloseWriteSource;
  log?: (line: string) => void;
}

export class KohyaCapture {
  private constructor(
    readonly cfg: KohyaCaptureConfig,
    readonly identity: Identity,
    readonly queue: QueueStore,
    readonly submitter: Submitter,
    readonly watch: CheckpointWatchSurface,
    readonly assurance: KohyaAssurance,
  ) {}

  /**
   * Resolve the placement, refuse if it did not survive, and only then acquire
   * an identity.
   *
   * THE ORDER IS DELIBERATE. Provisioning is what hands this process an IK, and
   * at `unattested-client` the tenant can read it (H-4 §7 probe 3). Refusing
   * before `Identity.open()` means a refused deployment never burns a
   * provisioning token and never puts key material somewhere the model has
   * just said it does not belong.
   */
  static async start(
    cfg: KohyaCaptureConfig,
    deps: KohyaCaptureDeps = {},
  ): Promise<KohyaCapture> {
    const log = deps.log ?? ((l: string) => console.log(`[scruple-capture/kohya] ${l}`));
    const assurance = resolveKohyaPlacement(cfg.topology);

    log(`placement: ${assurance.resolution.reason}`);
    log(`assurance: ${assurance.reason}`);
    for (const c of assurance.conditions) log(`  condition: ${c}`);
    for (const c of assurance.coverage) log(`  coverage: ${c}`);
    for (const d of assurance.duties) {
      log(`  duty ${d.duty}: ${d.disposition} — ${d.covers}`);
    }

    if (!assurance.mayIssueLeaf) {
      throw new PlacementRefusal(
        assurance,
        'Refusing to start. This deployment resolves to placement ' +
          `'${assurance.resolution.effective}' (${assurance.resolution.reason}), where P1 and ` +
          'P3 fail and NO LEAF MAY BE ISSUED (PLACEMENT_AND_SURFACES.md §4.1, §5.1 rule 1). ' +
          'Starting anyway would produce a capture path that looks live and emits no ' +
          'evidence, which is the failure WO-11a removed from the in-pod hook. ' +
          'The remedy is H-4 §2 obligations 1 and 2 — the workload reachable only through ' +
          'this component, and this component in a namespace the tenant cannot exec, debug ' +
          'or read the sealed key from. Neither is available on a RunPod Pod; see ' +
          'docs/canon/KOHYA_REPLACEMENT.md §3.',
      );
    }

    const identity = deps.identity ?? (await Identity.open(asCaptureConfig(cfg), deps.fetchImpl));
    const queue = new QueueStore(path.join(cfg.stateDir, 'queue.jsonl'));
    const submitter = new Submitter({
      identity,
      queue,
      apiBaseUrl: cfg.apiBaseUrl,
      apiKey: cfg.apiKey,
      baselineRef: cfg.baselineRef,
      // WO-C3. The seeded default policy: the digest binds the evidence
      // retention duration, the window says when an unresolved gap becomes a
      // finding. `KohyaCaptureConfig` deliberately does not carry its own —
      // this path has one deployment shape and a second setting for one fact
      // is two answers.
      retentionPolicyDigest: DEFAULT_RETENTION_POLICY_DIGEST,
      settlementWindowSeconds: DEFAULT_RETENTION_POLICY.settlement_window_s,
      // WO-C4. Re-read per emission, off raw stat(2). The checkpoint volume
      // is the watched surface here, and a Kohya pod that mounts it on the
      // same filesystem as the ratchet state has the same starvation chain a
      // ComfyUI sidecar does — the leaf is where that becomes visible.
      confinementFor: () =>
        measureStorageConfinement({
          stateDir: cfg.stateDir,
          volumes: [cfg.checkpointVolume],
        }),
      // WO-C1. From the RESOLVED placement, not the declared one. On RunPod's
      // Pods `resolveKohyaPlacement()` answers `enforcement: 'none'` and the
      // effective placement is `unattested-client`, so the trust profile here
      // is 'desktop' — the tenant has root in the container, which is the
      // same adversary the desktop argument is about, wearing a datacentre.
      // `verified` is unreachable, and the type says so before the validator
      // gets a chance to.
      profile: profileFor(assurance.resolution.effective),
      enforcement: assurance.resolution.enforcement,
      fetchImpl: deps.fetchImpl,
      log,
    });

    const watch = new CheckpointWatchSurface({
      volume: cfg.checkpointVolume,
      declaredMime: cfg.declaredMime,
      source: deps.closeWriteSource,
      log,
    });
    await watch.open({ sink: submitter, placement: assurance.placement, config: {} });

    log(`component_id=${identity.componentId} counter=${identity.counter}`);
    const drained = await submitter.drain();
    if (drained.sent || drained.kept) {
      log(`queue: drained ${drained.sent}, ${drained.kept} still queued`);
    }

    return new KohyaCapture(cfg, identity, queue, submitter, watch, assurance);
  }

  async stop(): Promise<void> {
    await this.watch.close();
    this.identity.destroy();
  }
}

/** The fields src/identity.ts reads. The ComfyUI-only fields carry values that
 *  are never used on this path rather than being faked into something
 *  plausible — a gate URL a Kohya deployment does not have would read as a
 *  topology claim, and this file's whole subject is not making those. */
function asCaptureConfig(cfg: KohyaCaptureConfig): CaptureConfig {
  return {
    upstreamUrl: '',
    listenHost: '',
    listenPort: 0,
    outputVolume: cfg.checkpointVolume,
    stateDir: cfg.stateDir,
    apiBaseUrl: cfg.apiBaseUrl,
    apiKey: cfg.apiKey,
    provisioningToken: cfg.provisioningToken,
    baselineRef: cfg.baselineRef,
    outputVolumeDeclaredMime: cfg.declaredMime,
    // WO-C2. The authority identity that rides in the MAC preimage beside
    // the witness endpoint. null because none is enrolled here — never a
    // plausible-looking default, which is the cooperating liar the field
    // exists to exclude.
    witnessAuthority: null,
    // WO-C3. The seeded default policy (migration 055) and the window it
    // binds. Named out loud rather than inherited, because a window that does
    // not match the policy the digest names is refused at ingest.
    retentionPolicyDigest: DEFAULT_RETENTION_POLICY_DIGEST,
    settlementWindowSeconds: DEFAULT_RETENTION_POLICY.settlement_window_s,
    // WO-C4. Present because `CaptureConfig` requires them; NOT load-bearing
    // on this path. The startup gate the council specified is bound to the
    // moment a proxy socket is bound, and this deployment binds none — it is
    // a checkpoint watcher, not a gate. What DOES apply here is the per-leaf
    // half: `KohyaCapture.start()` gives its Submitter a `confinementFor` so
    // every Kohya leaf carries the measured device identity, and a shared
    // filesystem shows up on the evidence rather than in a refusal nobody
    // could have acted on.
    allowDegradedStorage: true,
    stateMinReservableBytes: DEFAULT_MIN_RESERVABLE_BYTES,
    settleMs: cfg.settleMs,
    correlationTtlMs: 0,
    heartbeatWindowSeconds: 900,
    // WO-C5. The upstream bracket cadence. Explicit here rather than
    // defaulted in the type, because `CaptureConfig` has no defaults by
    // design (config.ts header: "no defaults for anything load-bearing").
    upstreamPollIntervalMs: DEFAULT_UPSTREAM_POLL_INTERVAL_MS,
    upstreamMaxReadingAgeMs: DEFAULT_UPSTREAM_POLL_INTERVAL_MS * 2,
    upstreamAnchorWindow: DEFAULT_UPSTREAM_ANCHOR_WINDOW,
  };
}

/** Env → config. Every topology obligation defaults to FALSE and must be
 *  declared explicitly by the vendor, because the cost of a wrong `false` is a
 *  refusal and the cost of a wrong `true` is a leaf that claims a boundary
 *  nobody enforced. */
export function loadKohyaConfig(env: NodeJS.ProcessEnv = process.env): KohyaCaptureConfig {
  const need = (n: string): string => {
    const v = env[n];
    if (!v) throw new Error(`${n} is not set. scruple-capture/kohya refuses to start without it.`);
    return v;
  };
  const yes = (n: string): boolean => env[n] === '1' || env[n]?.toLowerCase() === 'true';

  return {
    checkpointVolume: path.resolve(need('SCRUPLE_KOHYA_CHECKPOINT_VOLUME')),
    stateDir: path.resolve(env.SCRUPLE_CAPTURE_STATE_DIR ?? '.scruple-capture'),
    apiBaseUrl: need('SCRUPLE_API_URL').replace(/\/+$/, ''),
    apiKey: need('SCRUPLE_API_KEY'),
    provisioningToken: env.SCRUPLE_CAPTURE_PROVISIONING_TOKEN || null,
    baselineRef: env.SCRUPLE_CAPTURE_BASELINE_REF || null,
    declaredMime: env.SCRUPLE_KOHYA_VOLUME_MIME || null,
    settleMs: Number(env.SCRUPLE_KOHYA_SETTLE_MS ?? DEFAULT_CHECKPOINT_SETTLE_MS),
    topology: {
      workloadReachableOnlyThroughComponent: yes('SCRUPLE_KOHYA_TOPOLOGY_INGRESS_GATED'),
      componentIsolatedFromTenant: yes('SCRUPLE_KOHYA_TOPOLOGY_COMPONENT_ISOLATED'),
      allArtifactVolumesMountedAndWatched: yes('SCRUPLE_KOHYA_TOPOLOGY_ALL_VOLUMES_WATCHED'),
      workloadEgressDeniedExceptThroughComponent: yes('SCRUPLE_KOHYA_TOPOLOGY_EGRESS_DENIED'),
    },
  };
}

async function main(): Promise<void> {
  const capture = await KohyaCapture.start(loadKohyaConfig());
  const drainTimer = setInterval(() => {
    void capture.submitter.drain().catch(() => undefined);
  }, 30_000);
  drainTimer.unref();

  const shutdown = async (sig: string) => {
    console.log(`[scruple-capture/kohya] ${sig}; draining before exit`);
    clearInterval(drainTimer);
    await capture.submitter.drain().catch(() => undefined);
    await capture.stop();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`[scruple-capture/kohya] FATAL: ${String(e)}`);
    process.exit(1);
  });
}
