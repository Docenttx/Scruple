// Duty 3 — submit. The ObservationSink every surface emits into.
//
// §5, and the ordering is the whole of it:
//
//     derive, MAC, ratchet, persist, then enqueue.
//
// The counter is consumed when the MAC is computed, NOT when the submission
// succeeds. Everything downstream of the MAC — the network call, its failure,
// its retry — happens to an event that already has its number.
//
// TWO THINGS BLOCK AND ONE DOES NOT, and the split is the design:
//
//   BLOCKING — the MAC. emit() does not resolve until the counter is spent
//   and the entry is on disk. The gate awaits emit() before it forwards a
//   single byte, so there is no window in which a tenant holds an artifact
//   that no leaf covers. If the ratchet cannot MAC, the gate fails closed.
//
//   NOT BLOCKING — the witness. Capture must not depend on witness-server
//   health; that is the design choice /api/v2/witness makes too. A failed
//   submission is a queued submission, and the queue is a file.
//
// This is the call packages/scruple-host-sdk/queue.py's docstring says was
// missing in all six forks: enqueue() on the failure path, unconditionally.

import crypto from 'node:crypto';

import type {
  CaptureObservation,
  ObservationSink,
  PlacementEnforcement,
} from '../../../lib/capture/surface';
import type { CaptureProfile, QuoteBinding } from '../../../lib/leaf/attestationBasis';
import type { StorageMeasurement } from '../../../lib/capture/storageConfinement';
import type { UpstreamObservation } from '../../../lib/capture/upstreamEpoch';
import type {
  ArtifactRef,
  DeclaredUncapturedDocument,
  UncapturedObservation,
} from '../../../lib/capture/declaredUncaptured';
import { buildLeaf, type LeafContext, type Submission } from './leaf';
import { QueueStore, isDue, type QueueEntry } from './queue';
import type { Identity } from './identity';

export const SUBMIT_PATH = '/api/v2/witness';

export interface SubmitterOptions {
  identity: Identity;
  queue: QueueStore;
  apiBaseUrl: string;
  apiKey: string;
  baselineRef: string | null;
  /**
   * WO-C1. The trust profile and the enforcement that earned it. Passed in
   * rather than derived here because `resolvePlacement()` already did the
   * work in component.ts, and a second derivation is a second answer.
   */
  profile: CaptureProfile;
  enforcement: PlacementEnforcement;
  /** Per-emission quote binding. See LeafContext.quoteFor. */
  quoteFor?: (o: CaptureObservation) => QuoteBinding | null;
  /**
   * WO-C2. The authority identity whose signature counts at `apiBaseUrl` —
   * the witness's signing key id. null when none is enrolled, which the
   * route reads as "this leaf may not name a checkpoint". Never defaulted to
   * a plausible-looking string: an authority nobody enrolled is exactly the
   * cooperating liar the field exists to exclude.
   *
   * THE ENDPOINT IS NOT AN OPTION HERE. It is `apiBaseUrl` — the service this
   * component actually submits to — because a separately configured endpoint
   * is a second answer to "where does this resolve" and the two drift.
   */
  witnessAuthority?: string | null;
  /**
   * WO-C3. The enrolled retention policy this component emits under, and the
   * settlement window that policy binds. REQUIRED, both of them, and not
   * defaulted here: a component that fell back to a plausible window would
   * emit a deadline the server refuses, and a component that fell back to a
   * plausible digest would name a policy this deployment may never have
   * enrolled. Both are deployment decisions — `config.ts` is where the
   * default lives, out loud.
   */
  retentionPolicyDigest: string;
  settlementWindowSeconds: number;
  /**
   * WO-C4. RE-MEASURED PER EMISSION, which is why this is a function and not
   * a `StorageMeasurement`. A component that captured the reading once at
   * startup would carry a config-inherited fact into every leaf — the
   * `pinned_build` pattern the council killed — and would miss a bind mount
   * performed after boot entirely.
   *
   * Optional, because a placement with no watched volume has no sharing
   * question to answer; a Submitter with none emits `unknown`/`unknown`,
   * which is honest and is not read as a pass anywhere.
   */
  confinementFor?: () => StorageMeasurement;
  /**
   * WO-C5. The upstream's identity and history epoch as of the newest
   * completed bracket, evaluated against the emission's clock.
   *
   * A function like `confinementFor`, but NOT for the same reason, and the
   * difference is load-bearing enough to say here as well as in
   * `UpstreamTracker`: the network read happens out of band on a poller,
   * because `emit()` is the blocking half of the gate and the thing being
   * measured IS the upstream. What this call does at emission is the
   * STALENESS CHECK — a bracket that no longer covers the leaf's interval
   * degrades to `unknown` / `interval_not_covered` instead of being carried
   * forward as though it still described the present.
   *
   * Optional, because a placement with no upstream process has nothing to
   * ask; a Submitter with none emits `not_queried`, which is a different
   * operational condition from `evicted_or_restarted` and must stay so.
   */
  upstreamFor?: (observedAtMs: number) => UpstreamObservation;
  /**
   * WO-E2. The absence set and its scope, built from the SAME upstream
   * observation this leaf carries — see `LeafContext.uncapturedFor` for why
   * that is structural and not tidiness.
   *
   * Optional, because a placement with no upstream enumerates nothing; a
   * Submitter with none emits `not_enumerated`, which is a different fact
   * from an empty set and is why one has a null count and the other has 0.
   */
  uncapturedFor?: (
    upstream: UpstreamObservation,
    observedAtMs: number,
  ) => {
    observation: UncapturedObservation;
    document: DeclaredUncapturedDocument | null;
    reason: string;
  };
  /**
   * WO-E2. THE CAPTURED-SET LEDGER'S WRITE SIDE, and the order in `capture()`
   * is the whole of why it is a separate call rather than something the leaf
   * builder does.
   *
   * It is called BEFORE `buildLeaf`, so an artifact is in the captured set by
   * the time its own leaf's absence set is computed. Called after, every leaf
   * would name the artifact it is the leaf FOR as uncaptured — the enumeration
   * comes from the upstream's `/history`, which lists the prompt whose output
   * these bytes are, and the diff would find it missing from a ledger it had
   * not been added to yet.
   */
  recordCaptured?: (ref: ArtifactRef) => void;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
}

export interface SubmittedEvent {
  counter: number;
  mac: string;
  contentHash: string;
  queueId: string;
  mimeDeclared: boolean;
}

export class Submitter implements ObservationSink {
  private readonly fetchImpl: typeof fetch;
  private readonly log: (line: string) => void;
  private readonly ctx: LeafContext;
  /** Every event this process MACed, in counter order. Diagnostics and the
   *  acceptance tests; the durable record is the queue and the server. */
  readonly emitted: SubmittedEvent[] = [];
  private lastLoggedBasis: string | null = null;
  /** WO-C4. Same treatment as the basis: logged on CHANGE, because a
   *  transition into a degraded storage posture mid-session is the one line
   *  an operator must not lose in a line-per-artifact log. */
  private lastLoggedConfinement: string | null = null;
  /** WO-C5. Same treatment again, and for the sharpest version of the reason:
   *  the whole point of the field is that a restart must not pass unnoticed,
   *  so the TRANSITION is what gets a line. */
  private lastLoggedUpstream: string | null = null;
  /** WO-E2. And again for the absence set's scope — a session that loses its
   *  closure claim mid-run is the transition an operator is owed. */
  private lastLoggedUncaptured: string | null = null;

  constructor(private readonly opts: SubmitterOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.log = opts.log ?? ((l) => console.log(`[scruple-capture] ${l}`));
    this.ctx = {
      componentId: opts.identity.componentId,
      buildMeasurement: opts.identity.buildMeasurement,
      baselineRef: opts.baselineRef,
      profile: opts.profile,
      enforcement: opts.enforcement,
      // WO-C2. Where this leaf's evidence resolves, and whose signature
      // counts there — both inside the MAC preimage from here on.
      witnessEndpoint: opts.apiBaseUrl,
      witnessAuthority: opts.witnessAuthority ?? null,
      // WO-C3. Carried into every leaf: the digest binds how long the evidence
      // this leaf points at will be there, and the window says when its
      // silence becomes a finding.
      retentionPolicyDigest: opts.retentionPolicyDigest,
      settlementWindowSeconds: opts.settlementWindowSeconds,
      ...(opts.quoteFor ? { quoteFor: opts.quoteFor } : {}),
      // WO-C4. The device identity behind `stateDir` and the watched volumes,
      // read fresh for each leaf.
      ...(opts.confinementFor ? { confinementFor: opts.confinementFor } : {}),
      // WO-C5. Who the upstream is and whether its history ring survived,
      // evaluated against each leaf's observation time.
      ...(opts.upstreamFor ? { upstreamFor: opts.upstreamFor } : {}),
      // WO-E2. What the upstream said it produced that this component did not
      // capture, and the scope that enumeration ranged over.
      ...(opts.uncapturedFor ? { uncapturedFor: opts.uncapturedFor } : {}),
    };
  }

  /**
   * The one entry point. Throws only when the counter could not be spent —
   * which the gate treats as fail-closed, because an artifact delivered
   * after a failed MAC is an artifact with no leaf.
   */
  async emit(o: CaptureObservation): Promise<void> {
    // The graph rides on the observation's `evidence` because
    // ObservationSink.emit takes exactly one argument and that interface is
    // the canon's, not this component's, to change.
    const g = (o.evidence as { graph?: unknown } | undefined)?.graph;
    await this.capture(o, isRecord(g) ? g : undefined);
  }

  async capture(o: CaptureObservation, graph?: Record<string, unknown>): Promise<SubmittedEvent> {
    // 0. LEDGER — WO-E2, and it is BEFORE the derive on purpose. The absence
    //    set is `/history`'s outputs minus what this component captured, and
    //    `/history` already lists the prompt these bytes came out of. Recording
    //    after `buildLeaf` would make every artifact's own leaf name it as
    //    uncaptured. A surface that cannot name the artifact the way ComfyUI
    //    names it — a WS preview frame, which becomes no file and appears in
    //    no `/history` output — sends no ref, and that is not a gap: it is an
    //    observation the absence set does not range over.
    const ref = (o.evidence as { artifact_ref?: ArtifactRef | null } | undefined)?.artifact_ref;
    if (ref && this.opts.recordCaptured) this.opts.recordCaptured(ref);

    // 1. DERIVE — read the counter this event will carry BEFORE spending it,
    //    because the counter is inside what gets MACed (leaf.ts preimageOf).
    const counter = this.opts.identity.counter;
    const leaf = buildLeaf(o, this.ctx, counter, graph);

    // WO-C1. The basis is resolved per emission, so log it when it CHANGES
    // rather than on every leaf: a line per artifact is noise an operator
    // learns to skip, and a transition from `stale` to `passthrough` — which
    // is what WO-C6 landing looks like from in here — is the one thing they
    // must not miss. The reason is logged, never sent: an explanation on the
    // wire is a field to be forged.
    const basis = leaf.submission.capture.attestation_status;
    if (basis !== this.lastLoggedBasis) {
      this.lastLoggedBasis = basis;
      this.log(`attestation basis → ${basis} (${leaf.basisReason})`);
    }

    // WO-C4. "It must be VISIBLE — never a silent degradation of a required
    // capture session." The tag on the leaf is the durable half of that; this
    // is the operator's half, and it fires on the transition rather than on
    // every artifact so that the transition is what stands out.
    const confinement = leaf.submission.capture.confinement;
    if (confinement !== this.lastLoggedConfinement) {
      this.lastLoggedConfinement = confinement;
      this.log(`storage confinement → ${confinement} (${leaf.confinementReason})`);
    }

    // WO-C5. The one line an operator must not lose. A silent upstream restart
    // is invisible by construction — the process comes back at the same
    // address with a byte-identical /system_stats — so the transition into
    // `restarted`, and the epoch id it mints, are logged where a per-artifact
    // line would be skipped. The epoch is part of the key because a second
    // restart inside an already-`restarted` window is a second event.
    const up = leaf.submission.capture;
    const upKey = `${up.upstream_continuity}/${up.upstream_uncaptured_reason}/${up.upstream_epoch}`;
    if (upKey !== this.lastLoggedUpstream) {
      this.lastLoggedUpstream = upKey;
      this.log(
        `upstream ${up.upstream_continuity} · absence ${up.upstream_uncaptured_reason} ` +
          `· epoch ${up.upstream_epoch ?? '(none)'}`,
      );
    }

    // WO-E2. Same treatment, one field over, and for the sharpest version of
    // the reason: a leaf that goes from `complete` to `partial` mid-session
    // has just stopped being able to support a coverage claim, and the reason
    // says which of the four closure conditions broke. A count that rises is
    // the operator's other signal — artifacts the upstream reported and this
    // component did not capture.
    const uncKey = `${up.uncaptured_scope}/${up.uncaptured_scope_source}`;
    if (uncKey !== this.lastLoggedUncaptured) {
      this.lastLoggedUncaptured = uncKey;
      this.log(
        `absence set ${up.uncaptured_scope} · ${up.declared_uncaptured_count ?? '(no set)'} ` +
          `uncaptured — ${leaf.uncapturedReason}`,
      );
    }

    // 2/3/4. MAC, RATCHET, PERSIST. One call, in that order, and it fsyncs
    //    the new state before returning (identity.ts macAndAdvance).
    const { counter: spent, mac } = this.opts.identity.macAndAdvance(leaf.preimage);
    if (spent !== counter) {
      throw new Error(`ratchet counter moved under us: expected ${counter}, spent ${spent}`);
    }
    const submission: Submission = { ...leaf.submission, mac };

    // 5. ENQUEUE — unconditionally, before any network call is attempted.
    //    Enqueue-then-send rather than send-then-enqueue-on-failure: a crash
    //    between a successful send and the enqueue would be invisible, while
    //    a crash the other way costs one duplicate, which the server drops
    //    idempotently on (component_id, counter) (§4.2 rule 3).
    const entry = this.opts.queue.enqueue({
      kind: 'witness',
      method: 'POST',
      path: SUBMIT_PATH,
      body: submission as unknown as Record<string, unknown>,
      counter: spent,
    });

    const rec: SubmittedEvent = {
      counter: spent,
      mac,
      contentHash: submission.content_hash,
      queueId: entry.id,
      mimeDeclared: leaf.mimeDeclared,
    };
    this.emitted.push(rec);

    if (!leaf.mimeDeclared) {
      this.log(
        `counter=${spent} content_hash=${rec.contentHash} MIME UNDECLARED — nothing was ` +
          'entitled to declare a type for these bytes (no producing node, no vendor ' +
          'declaration). The event is MACed and queued; /api/v2/witness will refuse it ' +
          'until the route accepts an undeclared MIME. Not defaulted: §5 property 1.',
      );
    }

    // 6. Drain, best effort. Never awaited by the caller for its result.
    await this.drain().catch(() => undefined);
    return rec;
  }

  /**
   * Send what is due. Preserves each entry's counter — the MAC only verifies
   * against the key at that counter, so re-numbering on drain would invalidate
   * every entry the queue holds.
   *
   * NOT HEAD-OF-LINE BLOCKING, and that is a decision, not an oversight.
   * §10 C-3 settles the §4.2/§5 contradiction in favour of a bounded
   * acceptance window on the server, on the ground that one permanently
   * undeliverable event would otherwise silence a component indefinitely —
   * and silence is the specific thing this design exists to make visible.
   * A drain that stopped at the first failure would reintroduce exactly that.
   */
  async drain(nowMs = Date.now()): Promise<{ sent: number; kept: number }> {
    const entries = this.opts.queue.loadAll();
    if (entries.length === 0) return { sent: 0, kept: 0 };

    const keep: QueueEntry[] = [];
    let sent = 0;

    for (const e of entries) {
      if (!isDue(e, nowMs)) {
        keep.push(e);
        continue;
      }
      const outcome = await this.send(e);
      if (outcome === 'done') {
        sent++;
        continue;
      }
      keep.push({ ...e, attempts: e.attempts + 1, last_attempt_at: nowMs / 1000 });
    }

    this.opts.queue.replaceAll(keep);
    return { sent, kept: keep.length };
  }

  private async send(e: QueueEntry): Promise<'done' | 'retry'> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.opts.apiBaseUrl}${e.path}`, {
        method: e.method,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.opts.apiKey}`,
          // So a re-delivery is recognisable as one before the body is read.
          'x-scruple-component-counter': String(e.counter),
        },
        body: JSON.stringify(e.body ?? {}),
      });
    } catch (err) {
      this.log(`counter=${e.counter} submit failed (${String(err)}); queued, attempt ${e.attempts + 1}`);
      return 'retry';
    }

    if (res.ok) return 'done';

    // A duplicate is the designed retry arriving twice (§4.2 rule 3) and the
    // server drops it idempotently on (component_id, counter). Treating it as
    // a failure would keep it queued forever and make the component look sick.
    let payload = '';
    try {
      payload = await res.text();
    } catch {
      /* body already consumed or absent */
    }
    if (res.status === 409 && /duplicate/i.test(payload)) return 'done';

    this.log(
      `counter=${e.counter} submit rejected ${res.status}: ${payload.slice(0, 300)}; ` +
        'kept in queue — a captured event is never dropped to tidy the queue (§10 C-3).',
    );
    return 'retry';
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Stable id for a set of bytes, used only in logs. Never a substitute for
 *  the content hash. */
export function shortId(): string {
  return crypto.randomBytes(4).toString('hex');
}
