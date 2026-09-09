// THE MODEL STORE ADAPTER — an ObservationSink that supplies what the gate
// structurally cannot see.
//
// docs/DESIGN.md's Level-2 shape, in one sentence: "the gate is host-agnostic;
// the meaning is host-supplied." The gate observes a wire. It sees a workflow
// go in and bytes come out, and the workflow contains a STRING — a filename.
// It has no model directory, no filesystem, and no way to turn that string
// into the weights that were on the disk. The desktop has all three.
//
// So this is a decorator, not a patch: it takes the observation on its way to
// the Submitter, and when the observation carries the graph, it adds
// `model_fingerprints` and `model_fingerprints_hash` to the evidence. Both
// fields already exist on `ObservationEvidence` in the SDK
// (services/scruple-capture/src/leaf.ts) and already ride into the leaf and
// into `iterations.model_fingerprints`, which is "the only column that records
// WHICH weights a run loaded". Nothing here invents a field.
//
// WHAT THIS MAY NOT DO, and does not
// ---------------------------------------------------------------------------
// The Submitter owns §5's ordering — derive, MAC, ratchet, persist, enqueue —
// and this sits ABOVE it, before any of that begins. It therefore does no MAC,
// spends no counter, makes no HTTP request, and takes no view on whether the
// resulting leaf is verified or passthrough. It adds two fields to an evidence
// object and calls `inner.emit`. A sink that swallowed an observation would
// break the gate's fail-closed property — the gate delivers bytes only after
// `sink.emit` resolves — so every path below ends in a delegation.
//
// AND IT MAY NOT OVERWRITE. If a surface already put fingerprints on the
// observation, they stay. Two parties disagreeing about which weights were
// loaded is a finding; silently preferring ours would erase it.
//
// ⚑ THE TIMING GAP, STATED RATHER THAN ENGINEERED AWAY
// ---------------------------------------------------------------------------
// The store is read when the ARTIFACT is observed, which is after ComfyUI
// loaded the weights, not during. A swap performed between the load and this
// read would be recorded as the post-swap bytes. Closing that needs a hook
// inside the loader — a Level-2 host adapter reporting what it opened, which
// is WO-D6's registration and not this file's. What is done here instead is to
// record the interval honestly: `readStartedAt`/`readFinishedAt` are kept in
// this sink's own log for the run report, and they are deliberately NOT in the
// manifest, because a timestamp in the manifest would make
// model_fingerprints_hash unrecomputable by anyone holding the weights.

import { hashModelFingerprints, type CaptureObservation, type ObservationSink } from './sdk';
import { fingerprintWorkflow, type ModelStoreReport } from './modelStore';

export interface ModelSinkOptions {
  inner: ObservationSink;
  modelRoot: string;
  ceilingBytes?: number;
  log?: (line: string) => void;
}

export interface EnrichmentRecord {
  observedAt: string;
  correlationId: string | null;
  contentHash: string | null;
  /** 'enriched' · 'no-graph' · 'already-present' · 'no-models-referenced' */
  outcome: string;
  modelFingerprintsHash: string | null;
  keys: string[];
  readStartedAt: string | null;
  readFinishedAt: string | null;
}

export class ModelStoreSink implements ObservationSink {
  readonly enrichments: EnrichmentRecord[] = [];
  /** The last full report, for the sidecar's own result file. The leaf gets
   *  the manifest; the operator gets the references and the timings too. */
  lastReport: ModelStoreReport | null = null;
  private readonly log: (line: string) => void;

  constructor(private readonly opts: ModelSinkOptions) {
    this.log = opts.log ?? ((l) => console.log(`[model-store] ${l}`));
  }

  async emit(o: CaptureObservation): Promise<void> {
    const ev = (o.evidence ?? {}) as Record<string, unknown>;
    const record: EnrichmentRecord = {
      observedAt: o.observedAt,
      correlationId: o.correlationId ?? null,
      contentHash: (o.bytes as { contentHash?: string } | undefined)?.contentHash ?? null,
      outcome: 'no-graph',
      modelFingerprintsHash: null,
      keys: [],
      readStartedAt: null,
      readFinishedAt: null,
    };

    if (ev.model_fingerprints || ev.model_fingerprints_hash) {
      record.outcome = 'already-present';
      this.enrichments.push(record);
      return this.opts.inner.emit(o);
    }

    if (ev.graph === undefined || ev.graph === null) {
      // No workflow on this observation, so there is nothing that NAMES a
      // model, so there is nothing to fingerprint. Not an error and not a
      // silence: it is in `enrichments` as `no-graph`.
      this.enrichments.push(record);
      return this.opts.inner.emit(o);
    }

    let report: ModelStoreReport;
    try {
      report = await fingerprintWorkflow({
        graph: ev.graph,
        modelRoot: this.opts.modelRoot,
        ...(this.opts.ceilingBytes ? { ceilingBytes: this.opts.ceilingBytes } : {}),
      });
    } catch (e) {
      // A fingerprinting failure must NOT stop the leaf. The bytes still left
      // the gate and still need covering; a leaf with no fingerprints is a
      // weaker leaf, and no leaf at all is an unwitnessed artifact.
      record.outcome = `failed: ${String((e as Error).message ?? e)}`;
      this.log(`FAILED to fingerprint: ${record.outcome}`);
      this.enrichments.push(record);
      return this.opts.inner.emit(o);
    }

    this.lastReport = report;
    record.readStartedAt = report.readStartedAt;
    record.readFinishedAt = report.readFinishedAt;
    record.keys = Object.keys(report.fingerprints);

    const hashed = hashModelFingerprints(report.fingerprints);
    if (!hashed) {
      // hashModelFingerprints returns null for an empty manifest, "so callers
      // store NULL rather than the hash of {}, which would assert we
      // enumerated the weights and there were none". A workflow that names no
      // model gets no fingerprint fields, and that absence is the honest one.
      record.outcome = 'no-models-referenced';
      this.enrichments.push(record);
      return this.opts.inner.emit(o);
    }

    record.outcome = 'enriched';
    record.modelFingerprintsHash = hashed.hash;
    this.enrichments.push(record);
    this.log(
      `enriched ${record.contentHash?.slice(0, 12)}: ${record.keys.length} model(s) ` +
        `→ model_fingerprints_hash=${hashed.hash.slice(0, 12)} ` +
        `[${record.keys.join(', ')}]`,
    );

    return this.opts.inner.emit({
      ...o,
      evidence: {
        ...ev,
        model_fingerprints: report.fingerprints,
        model_fingerprints_hash: hashed.hash,
      },
    });
  }
}
