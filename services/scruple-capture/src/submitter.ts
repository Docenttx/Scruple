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

import type { CaptureObservation, ObservationSink } from '../../../lib/capture/surface';
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

  constructor(private readonly opts: SubmitterOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.log = opts.log ?? ((l) => console.log(`[scruple-capture] ${l}`));
    this.ctx = {
      componentId: opts.identity.componentId,
      buildMeasurement: opts.identity.buildMeasurement,
      attestationStatus: opts.identity.attestationStatus,
      baselineRef: opts.baselineRef,
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
    // 1. DERIVE — read the counter this event will carry BEFORE spending it,
    //    because the counter is inside what gets MACed (leaf.ts preimageOf).
    const counter = this.opts.identity.counter;
    const leaf = buildLeaf(o, this.ctx, counter, graph);

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
