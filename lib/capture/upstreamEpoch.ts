// Upstream restart detection — who ComfyUI is, and whether its history ring is
// the same ring it was last time we looked.
//
// WO-C5, and the council owned this one rather than pushing it into the
// schema. Hand round 6 §2, verbatim:
//
//   "Nothing in the component tracks upstream identity — no call to
//   /system_stats, no upstream id, no version pin. The only restart handling
//   is of our own identity (identity.ts: if the seal cannot be restored we
//   re-provision as a NEW component_id at n=0, deliberately, so the old one
//   goes silent as an operator signal). WE NEVER ASK COMFYUI WHO IT IS.
//   ... a silent ComfyUI restart is invisible to us today, and it is a change
//   to our component rather than to your schema."
//
// and the fact that makes it matter, verified in the ComfyUI source for round
// 5 §4(b):
//
//   "execution.py:1186 sets MAXIMUM_HISTORY_SIZE = 10000 and task_done evicts
//   the oldest entry past it (:1227-1228). self.history is an in-memory dict
//   on PromptQueue — IT DOES NOT SURVIVE A COMFYUI RESTART, and it is a
//   bounded ring."
//
// So an absence set drawn from `/history` is drawn from a volatile source, and
// a restart makes it assert that artifacts never existed when in fact the
// enumeration lost them. Architect, round 5, is the requirement this file
// implements:
//
//   "'not enumerated' is right, but the reason field needs to distinguish
//   restart/eviction (bounded, DETECTABLE IF YOU RECORD THE HISTORY EPOCH
//   IDENTITY AND THE LOW WATERMARK AT BOTH QUERY ENDS) from 'history simply
//   not queried' — otherwise the volatile source degrades to unknown for both
//   the recoverable and unrecoverable cases and you lose the only signal that
//   would tell an operator to shorten their query interval."
//
// ---------------------------------------------------------------------------
// ⚑ THE FINDING THAT DECIDES THE WHOLE SHAPE OF THIS FILE
// ---------------------------------------------------------------------------
//
// `/system_stats` CANNOT DETECT A RESTART. Read server.py:646-685: it returns
// `os`, `ram_total`, `ram_free`, `comfyui_version`, the frontend and template
// versions, `python_version`, `pytorch_version`, `embedded_python`, `argv`,
// and a `devices` array of names and VRAM figures. THERE IS NO BOOT ID, NO
// PID, NO START TIME, NO SESSION UUID. Not one field changes because the
// process restarted — and the two that do change (`ram_free`, `vram_free`)
// change continuously whether it restarted or not, so they are noise and not
// signal.
//
// A first pass at this work order digests `/system_stats`, compares the digest
// to the last one, finds it equal across a restart, and ships a restart
// detector that can never fire. It would pass a green test and prove only
// that it cannot fail — which is the failure mode this entire WO series exists
// to refuse.
//
// So the two halves of the WO's sentence are two different measurements, and
// only the first comes from `/system_stats`:
//
//   UPSTREAM IDENTITY   from /system_stats. Which INSTALL is answering —
//                       version, argv, devices. Changes when the operator
//                       upgrades or repoints the gate, NOT when it restarts.
//   HISTORY EPOCH       derived from /history. Which RUN is answering. This
//                       is the restart detector, and it is the reason the
//                       council said "this and Coder's fact (b) are the same
//                       fact seen twice."
//
// ---------------------------------------------------------------------------
// HOW THE EPOCH IS DERIVED, AND WHAT EACH RULE IS SUFFICIENT FOR
// ---------------------------------------------------------------------------
//
// `PromptServer.number` is initialised to 0 at construction (server.py:217)
// and incremented per accepted prompt (:929). `PromptQueue.history` is a plain
// dict (execution.py:1197) that `task_done` evicts from the FRONT
// (:1227-1228). Both are process state. That gives three independent
// contradictions, and a restart only has to trip one:
//
//   1. THE HIGH WATERMARK WENT BACKWARDS. `self.number` cannot decrease
//      inside one process. Definitive.
//   2. THE LOW WATERMARK WENT BACKWARDS. Eviction pops from the front, so the
//      oldest retained number is non-decreasing inside one process.
//      Definitive.
//   3. WITNESSED PROMPT IDS VANISHED WITHOUT ENOUGH NEW WORK TO HAVE EVICTED
//      THEM. This is the one the watermarks miss: an upstream that has never
//      held 10,001 prompts has low watermark 0 in BOTH epochs, and if it
//      processed more prompts after the restart than before it, the high
//      watermark rises too. Both watermarks then read continuous across a
//      real restart. The ids do not.
//
// ⚑ AND THE CASE THAT IS GENUINELY UNDECIDABLE IS REPORTED AS `unknown`, NOT
// AS `continuous`. If no witnessed prompt id survives into the current
// reading, nobody established continuity — the ring may have turned over
// legitimately or it may have been reset. Reporting `continuous` there is
// precisely "letting a restart look like a quiet afternoon", which is the
// sentence the work order is written against. An idle upstream with an empty
// history at both ends therefore reads `unknown` forever, and that is correct:
// a restart between two empty readings leaves no evidence of any kind.
//
// ---------------------------------------------------------------------------
// BOTH ENDS OF THE QUERY, AND WHY IT IS NOT PEDANTRY
// ---------------------------------------------------------------------------
//
// `GET /history` takes `max_items` and `offset` (server.py:888-900) and
// `get_history` walks the dict under the mutex per call (execution.py:1282) —
// so a client reading the ring in pages is issuing SEPARATE, NON-ATOMIC
// requests, and `task_done` can evict between them. An enumeration bracketed
// by one reading cannot tell "these entries were never there" from "these
// entries left while I was reading". Bracketing it with a low-watermark
// reading at BOTH ends can: if the low watermark advanced across the bracket,
// entries left the ring during the enumeration and the absence set is not a
// closure.
//
// That is a different fact from a restart and it has a different fix, so it
// gets its own reason value. This series has refused to fold two operational
// conditions into one value twice already — WO-C1 kept `stale` out of
// `passthrough`, WO-C4 kept `degraded_no_reservation` out of
// `degraded_shared_storage` — on exactly this ground.
//
// ---------------------------------------------------------------------------
// WHAT THIS DOES NOT DEFEND AGAINST, SAID HERE RATHER THAN DISCOVERED LATER
// ---------------------------------------------------------------------------
//
// 🔴 THE WATERMARKS AND THE PROMPT IDS ARE TENANT-INFLUENCEABLE. server.py:920
// takes `number` FROM THE CLIENT (`number = float(json_data['number'])`) and
// :933 takes `prompt_id` from the client too. A tenant who reaches `/prompt`
// can therefore inject a number, negate it with `front`, or choose its own
// prompt ids. So this is a detector for an OPERATIONAL restart — the process
// died and came back, the failure mode the council named — and it is NOT a
// proof of continuity against a hostile tenant. `upstream_source: measured`
// claims that the component asked the upstream and recorded what it said,
// which is the whole of what it claims. That bound is the same class as the
// correlation heuristic `correlation.ts` already labels on every leaf it
// touches, and stating it is the difference.
//
// Concretely, the defensive consequence: a `number` that is not a safe integer
// is EXCLUDED from the watermarks rather than being allowed to poison them or
// to abort the reading. A float in a MAC preimage is a MAC that fails
// unreproducibly (§10 C-1), and an abort would hand a tenant an off switch for
// the signal. The prompt-id overlap rule survives both, because a tenant
// cannot make ids it never sent reappear after a reset.

import crypto from 'node:crypto';

/**
 * Whether the upstream's history ring is the same ring it was.
 *
 * `unknown` is a first-class answer and is NOT a soft `continuous`: it is what
 * a reading that failed, a reading nobody took, and a turnover that could
 * equally be a reset all resolve to.
 */
export type UpstreamContinuity = 'continuous' | 'restarted' | 'unknown';

/** The invariant every asserted field in this design carries. No third. */
export type UpstreamSource = 'measured' | 'unknown';

/**
 * WHY AN ABSENCE SET DRAWN FROM `/history` IS OR IS NOT A CLOSURE, and the
 * field Architect asked for by name. Five values because there are five
 * operational conditions with five different fixes:
 *
 *   'enumerated'            the ring held across both ends of the bracket and
 *                           covers this leaf's interval. FIX: none.
 *   'evicted_or_restarted'  the epoch broke, or entries left the ring during
 *                           the bracket. FIX: SHORTEN THE QUERY INTERVAL —
 *                           this is the operator signal the council said is
 *                           lost when both cases degrade to `unknown`.
 *   'interval_not_covered'  the reading is real but older than the interval
 *                           this leaf claims. FIX: shorten the poll interval.
 *   'history_unavailable'   the query itself failed. FIX: the upstream is
 *                           down or unreachable; fix that.
 *   'not_queried'           nobody asked. FIX: configure upstream tracking —
 *                           or nothing, on a placement that has no upstream
 *                           process to ask.
 *
 * The last is the one the council insisted must not collapse into the others:
 * "'not enumerated' ... needs to distinguish restart/eviction ... from
 * 'history simply not queried'."
 */
export type UncapturedReason =
  | 'enumerated'
  | 'evicted_or_restarted'
  | 'interval_not_covered'
  | 'history_unavailable'
  | 'not_queried';

const CONTINUITIES: readonly UpstreamContinuity[] = ['continuous', 'restarted', 'unknown'];
const REASONS: readonly UncapturedReason[] = [
  'enumerated',
  'evicted_or_restarted',
  'interval_not_covered',
  'history_unavailable',
  'not_queried',
];

export function isUpstreamContinuity(v: unknown): v is UpstreamContinuity {
  return typeof v === 'string' && (CONTINUITIES as readonly string[]).includes(v);
}

export function isUncapturedReason(v: unknown): v is UncapturedReason {
  return typeof v === 'string' && (REASONS as readonly string[]).includes(v);
}

export function isUpstreamSource(v: unknown): v is UpstreamSource {
  return v === 'measured' || v === 'unknown';
}

/**
 * 15 seconds, and 64 anchors. NEITHER IS A FACT ABOUT ANYTHING — a bracket is
 * four small GETs against a loopback upstream, and these are the numbers at
 * which that cost is invisible and the undetectable gap is small. They are the
 * defaults because a deployment needs one; the leaf discloses the reading's
 * age rather than assuming it, which is what makes the choice safe to get
 * wrong.
 */
export const DEFAULT_UPSTREAM_POLL_INTERVAL_MS = 15_000;
export const DEFAULT_UPSTREAM_ANCHOR_WINDOW = 64;

/** What lands on a leaf. Every field is a string, a safe integer, or null. */
export interface UpstreamObservation {
  /** Which INSTALL answered, from /system_stats. Not a restart signal. */
  upstream_identity: string | null;
  /** Which RUN answered, derived from /history. This IS the restart signal. */
  upstream_epoch: string | null;
  upstream_continuity: UpstreamContinuity;
  /** The oldest retained prompt number at the OPEN of the bracket. */
  upstream_low_watermark_open: number | null;
  /** ...and at its CLOSE. The two differing means entries left mid-query. */
  upstream_low_watermark_close: number | null;
  upstream_uncaptured_reason: UncapturedReason;
  upstream_source: UpstreamSource;
}

/** The observation a placement with no upstream to ask emits. */
export const UNQUERIED_UPSTREAM: UpstreamObservation = Object.freeze({
  upstream_identity: null,
  upstream_epoch: null,
  upstream_continuity: 'unknown',
  upstream_low_watermark_open: null,
  upstream_low_watermark_close: null,
  upstream_uncaptured_reason: 'not_queried',
  upstream_source: 'unknown',
});

/** The observation carried alongside the sentence explaining it. The reason is
 *  LOGGED AND REPORTED, NEVER SENT: an explanation on the wire is a field to
 *  be forged (leaf.ts `basisReason`, `confinementReason`). */
export interface UpstreamReading {
  observation: UpstreamObservation;
  reason: string;
  /** Wall-clock of the bracket close, so staleness is computable at emission. */
  observedAtMs: number | null;
}

// ---------------------------------------------------------------------------
// THE TWO PRIMITIVE READS
// ---------------------------------------------------------------------------

/**
 * The subset of /system_stats that identifies the INSTALL. Chosen, not
 * digested wholesale: `ram_free`, `vram_free` and `torch_vram_free` move on
 * every call, so a digest over the whole document changes constantly and
 * identifies nothing. `argv` is included because a gate repointed at a second
 * ComfyUI started with different `--output-directory` flags is a different
 * upstream for every purpose this component has.
 */
export function upstreamIdentityOf(stats: unknown): string | null {
  if (!isRecord(stats)) return null;
  const sys = isRecord(stats.system) ? stats.system : {};
  const devices = Array.isArray(stats.devices) ? stats.devices : [];
  const stable = {
    os: strOrNull(sys.os),
    comfyui_version: strOrNull(sys.comfyui_version),
    required_frontend_version: strOrNull(sys.required_frontend_version),
    required_templates_version: strOrNull(sys.required_templates_version),
    python_version: strOrNull(sys.python_version),
    pytorch_version: strOrNull(sys.pytorch_version),
    embedded_python: sys.embedded_python === true,
    argv: Array.isArray(sys.argv) ? sys.argv.map((a) => String(a)) : [],
    devices: devices.map((d) => {
      const r = isRecord(d) ? d : {};
      return {
        name: strOrNull(r.name),
        type: strOrNull(r.type),
        index: Number.isSafeInteger(r.index) ? (r.index as number) : null,
        // TOTALS ONLY. `vram_free` and `torch_vram_free` change between two
        // calls a second apart and would make every reading a new identity.
        vram_total: Number.isSafeInteger(r.vram_total) ? (r.vram_total as number) : null,
      };
    }),
  };
  // Sorted-key canonical JSON, the §10 C-1 encoding, so two implementations of
  // this digest agree.
  return `sha256:${crypto.createHash('sha256').update(canonicalJson(stable), 'utf8').digest('hex')}`;
}

/** One end of the bracket, or one page of the anchor window. */
export interface HistoryReading {
  ok: boolean;
  /** Smallest retained prompt number, or null when none was an integer. */
  low: number | null;
  /** Largest retained prompt number, same caveat. */
  high: number | null;
  /** (number, prompt_id) for every entry this read returned. */
  anchors: Array<{ number: number | null; prompt_id: string }>;
  /**
   * WO-E2. The `outputs` object of every entry this read returned, VERBATIM
   * and uninterpreted, keyed by prompt id.
   *
   * ⚑ CARRIED RAW RATHER THAN PARSED HERE, and the direction of the dependency
   * is the reason. `lib/capture/declaredUncaptured.ts` needs this file's
   * `UpstreamObservation` to decide whether an absence set is a closure; if
   * this file also called that file's `artifactsInOutputs()` the two would be a
   * value cycle. The epoch is about WHICH RUN answered and knows nothing about
   * artifacts; the absence set is about WHAT IT PRODUCED and owns the shape.
   * Keeping the split here costs one `unknown` and keeps the two designs
   * separable.
   */
  outputs: Array<{ prompt_id: string; outputs: unknown }>;
  error: string | null;
}

const EMPTY_READING: HistoryReading = {
  ok: true,
  low: null,
  high: null,
  anchors: [],
  outputs: [],
  error: null,
};

/**
 * Parse a `/history` body. ComfyUI returns `{prompt_id: {prompt: [number,
 * prompt_id, graph, extra, outputs], outputs, status}}` — `task_done` stores
 * the queue tuple verbatim at `history[prompt[1]]["prompt"]`
 * (execution.py:1237-1242), so `prompt[0]` is the number and `prompt[1]` is
 * the id.
 *
 * A `number` that is not a safe integer is dropped from the watermarks and
 * kept as an anchor with `number: null`. See the header: aborting the reading
 * would let a tenant switch the signal off with one float.
 */
export function parseHistory(body: unknown): HistoryReading {
  if (!isRecord(body)) {
    return {
      ok: false,
      low: null,
      high: null,
      anchors: [],
      outputs: [],
      error: 'history body is not an object',
    };
  }
  const anchors: HistoryReading['anchors'] = [];
  const outputs: HistoryReading['outputs'] = [];
  let low: number | null = null;
  let high: number | null = null;
  for (const [key, value] of Object.entries(body)) {
    const entry = isRecord(value) ? value : {};
    const tuple = Array.isArray(entry.prompt) ? entry.prompt : [];
    const rawNumber = tuple[0];
    const rawId = typeof tuple[1] === 'string' ? tuple[1] : key;
    const n = Number.isSafeInteger(rawNumber) ? (rawNumber as number) : null;
    anchors.push({ number: n, prompt_id: rawId });
    // WO-E2. `history_result["outputs"]` (execution.py:802-803), merged in by
    // task_done (:1237-1242). Present on every completed entry and `{}` on one
    // that produced nothing — both are kept, because "this prompt produced no
    // artifact" and "this prompt is not in the window" are different facts.
    outputs.push({ prompt_id: rawId, outputs: entry.outputs ?? null });
    if (n !== null) {
      low = low === null || n < low ? n : low;
      high = high === null || n > high ? n : high;
    }
  }
  return { ok: true, low, high, anchors, outputs, error: null };
}

// ---------------------------------------------------------------------------
// THE COMPARISON
// ---------------------------------------------------------------------------

/** Everything the tracker carries between polls. */
export interface EpochState {
  identity: string | null;
  epoch: string | null;
  /** The bracket-close anchors of the previous poll, newest-window. */
  anchors: Array<{ number: number | null; prompt_id: string }>;
  low: number | null;
  high: number | null;
}

export interface BracketedRead {
  identity: string | null;
  identityOk: boolean;
  /** The low-watermark reading taken BEFORE the enumeration. */
  open: HistoryReading;
  /** The enumeration itself — the newest `anchorWindow` entries. */
  window: HistoryReading;
  /** The low-watermark reading taken AFTER it. */
  close: HistoryReading;
}

/**
 * Fold a bracketed read against the previous epoch state.
 *
 * PURE. No clock, no network, no storage — the whole decision is here so it
 * can be driven by a table in the tests rather than by a live upstream.
 */
export function compareEpoch(
  prev: EpochState | null,
  read: BracketedRead,
): { next: EpochState; observation: UpstreamObservation; reason: string } {
  const openLow = read.open.ok ? read.open.low : null;
  const closeLow = read.close.ok ? read.close.low : null;

  // A failure at ANY of the three reads makes this bracket unusable. It is
  // not a restart and it is not continuity: nobody looked.
  if (!read.open.ok || !read.window.ok || !read.close.ok || !read.identityOk) {
    const errs = [
      read.identityOk ? null : 'system_stats',
      read.open.ok ? null : `history(open): ${read.open.error}`,
      read.window.ok ? null : `history(window): ${read.window.error}`,
      read.close.ok ? null : `history(close): ${read.close.error}`,
    ].filter(Boolean);
    return {
      // The previous epoch is CARRIED, not cleared. A failed poll is not
      // evidence that the upstream restarted, and dropping the anchors would
      // manufacture a discontinuity at the next successful poll.
      next: prev ?? { identity: null, epoch: null, anchors: [], low: null, high: null },
      observation: {
        upstream_identity: read.identity ?? prev?.identity ?? null,
        upstream_epoch: prev?.epoch ?? null,
        upstream_continuity: 'unknown',
        upstream_low_watermark_open: openLow,
        upstream_low_watermark_close: closeLow,
        upstream_uncaptured_reason: 'history_unavailable',
        upstream_source: 'unknown',
      },
      reason: `the upstream could not be read: ${errs.join('; ')}`,
    };
  }

  const anchors = read.window.anchors;
  const low = closeLow ?? read.window.low;
  const high = read.window.high;

  // FIRST POLL. Nothing to compare against, so the epoch is minted and
  // continuity is `unknown` — a first reading establishes a baseline, not a
  // continuity. The absence set IS enumerable, so the reason is `enumerated`
  // as long as nothing left the ring across the bracket.
  //
  // ⚑ THE CONDITION IS `!prev` AND NOT `prev.epoch === null`, and the
  // difference is a defect the gate run caught. `mintEpoch` returns null for
  // an EMPTY ring, and an empty ring is exactly what a restart leaves behind —
  // so a state carrying `epoch: null` is usually the state immediately AFTER a
  // detected restart. Treating it as a first poll would throw away the prior
  // anchors and re-baseline, and the restart would vanish from the record one
  // bracket after it was found. A null epoch is re-pinned below, in the
  // branches that keep comparing.
  if (!prev) {
    const evicted = openLow !== null && closeLow !== null && closeLow > openLow;
    const epoch = mintEpoch(read.identity, anchors, low, high);
    return {
      next: { identity: read.identity, epoch, anchors, low, high },
      observation: {
        upstream_identity: read.identity,
        upstream_epoch: epoch,
        upstream_continuity: 'unknown',
        upstream_low_watermark_open: openLow,
        upstream_low_watermark_close: closeLow,
        upstream_uncaptured_reason: evicted ? 'evicted_or_restarted' : 'enumerated',
        upstream_source: 'measured',
      },
      reason:
        `first reading of this upstream: epoch ${epoch ?? '(none)'} pinned from ` +
        `${anchors.length} retained prompt(s), watermarks [${fmt(low)}..${fmt(high)}]. ` +
        'Continuity is `unknown` because one reading establishes a baseline, not a ' +
        'continuity.' +
        (evicted
          ? ` Entries left the ring during the bracket (low ${openLow} → ${closeLow}); the ` +
            'enumeration is not a closure.'
          : ''),
    };
  }

  const contradictions: string[] = [];

  // RULE 0 — a different INSTALL is answering. Not strictly a restart, but
  // continuity across it is certainly broken, and it is the one case where
  // /system_stats carries the signal on its own.
  if (read.identity !== null && prev.identity !== null && read.identity !== prev.identity) {
    contradictions.push(
      `the upstream identity changed (${short(prev.identity)} → ${short(read.identity)}): a ` +
        'different ComfyUI install is answering this address',
    );
  }

  // RULE 1 — the high watermark went backwards. `PromptServer.number` is
  // initialised to 0 at construction and only ever incremented.
  if (high !== null && prev.high !== null && high < prev.high) {
    contradictions.push(
      `the high watermark went backwards (${prev.high} → ${high}); \`PromptServer.number\` ` +
        'is set to 0 at construction (server.py:217) and only incremented (:929)',
    );
  }

  // RULE 2 — the low watermark went backwards. `task_done` evicts from the
  // FRONT, so the oldest retained number cannot decrease inside one process.
  if (low !== null && prev.low !== null && low < prev.low) {
    contradictions.push(
      `the low watermark went backwards (${prev.low} → ${low}); eviction pops the front of ` +
        'the dict (execution.py:1227-1228), so the oldest retained number is non-decreasing',
    );
  }

  // RULE 3 — witnessed prompt ids. THE ONE THE WATERMARKS MISS.
  const present = new Set(anchors.map((a) => a.prompt_id));
  const survivors = prev.anchors.filter((a) => present.has(a.prompt_id));
  // ...and an id we witnessed that is present at a DIFFERENT number is a
  // contradiction of its own: ids are keys and numbers are assigned once.
  const byId = new Map(anchors.map((a) => [a.prompt_id, a.number] as const));
  const renumbered = prev.anchors.filter((a) => {
    const now = byId.get(a.prompt_id);
    return now !== undefined && a.number !== null && now !== null && now !== a.number;
  });
  if (renumbered.length > 0) {
    contradictions.push(
      `${renumbered.length} witnessed prompt id(s) reappeared at a different number ` +
        `(e.g. ${short(renumbered[0]!.prompt_id)}: ${renumbered[0]!.number} → ` +
        `${byId.get(renumbered[0]!.prompt_id)})`,
    );
  }

  const advance = high !== null && prev.high !== null ? high - prev.high : null;
  const turnoverPlausible = advance !== null && advance >= prev.anchors.length;

  if (contradictions.length === 0 && survivors.length === 0 && prev.anchors.length > 0) {
    if (!turnoverPlausible) {
      contradictions.push(
        `all ${prev.anchors.length} witnessed prompt id(s) are gone, but the high watermark ` +
          `advanced by only ${advance === null ? '(unknown)' : advance} — too little work to ` +
          'have evicted them. The ring was reset',
      );
    }
  }

  if (contradictions.length > 0) {
    // A NEW EPOCH. The identity changes permanently, so two leaves either side
    // of the restart disagree about which run produced them even after the
    // transient flag has cleared.
    const epoch = mintEpoch(read.identity, anchors, low, high);
    return {
      next: { identity: read.identity, epoch, anchors, low, high },
      observation: {
        upstream_identity: read.identity,
        upstream_epoch: epoch,
        upstream_continuity: 'restarted',
        upstream_low_watermark_open: openLow,
        upstream_low_watermark_close: closeLow,
        upstream_uncaptured_reason: 'evicted_or_restarted',
        upstream_source: 'measured',
      },
      reason:
        `UPSTREAM RESTART DETECTED — ${contradictions.join('; ')}. The in-memory history ring ` +
        'did not survive, so any absence set drawn from it is not a closure: an artifact ' +
        'missing from the enumeration may be missing because the enumeration was lost, not ' +
        `because it never existed. New epoch ${epoch ?? '(none)'} (was ${prev.epoch}).`,
    };
  }

  // NO CONTRADICTION. Two outcomes, and the difference between them is whether
  // anything actually established the continuity.
  const evictedInBracket = openLow !== null && closeLow !== null && closeLow > openLow;
  const evictedBetweenPolls = low !== null && prev.low !== null && low > prev.low;
  const evicted = evictedInBracket || evictedBetweenPolls;

  // RE-PINNING. `prev.epoch` is null when the previous bracket found an empty
  // ring — which is what the bracket immediately after a restart finds. As
  // soon as prompts resume there is something to pin an epoch to again, and it
  // is a NEW epoch by construction: the anchor is a fresh `uuid.uuid4()` from
  // the new process (server.py:933). Carrying null forever would leave every
  // subsequent leaf unable to say which run produced it.
  const epochNow = prev.epoch ?? mintEpoch(read.identity, anchors, low, high);

  if (survivors.length === 0) {
    // Either the ring turned over faster than the poll interval, or it was
    // reset and refilled with enough work to look like turnover. NOBODY
    // ESTABLISHED WHICH, so it is `unknown` and it is not `continuous`.
    return {
      next: { identity: read.identity, epoch: epochNow, anchors, low, high },
      observation: {
        upstream_identity: read.identity,
        upstream_epoch: epochNow,
        upstream_continuity: 'unknown',
        upstream_low_watermark_open: openLow,
        upstream_low_watermark_close: closeLow,
        upstream_uncaptured_reason:
          prev.anchors.length > 0 || evicted ? 'evicted_or_restarted' : 'enumerated',
        upstream_source: 'measured',
      },
      reason:
        prev.anchors.length === 0
          ? 'no prompt has been retained at either end of this interval, so there is nothing ' +
            'a restart could have contradicted. Continuity is `unknown` — an idle upstream ' +
            'and a restarted idle upstream are the same reading.'
          : `no witnessed prompt id survived, but the high watermark advanced by ${advance} ` +
            `against a ${prev.anchors.length}-entry window, so legitimate turnover explains ` +
            'it as well as a reset does. Continuity is `unknown`, and the operator signal is ' +
            'to shorten the poll interval.',
    };
  }

  return {
    next: { identity: read.identity, epoch: epochNow, anchors, low, high },
    observation: {
      upstream_identity: read.identity,
      upstream_epoch: epochNow,
      upstream_continuity: 'continuous',
      upstream_low_watermark_open: openLow,
      upstream_low_watermark_close: closeLow,
      upstream_uncaptured_reason: evicted ? 'evicted_or_restarted' : 'enumerated',
      upstream_source: 'measured',
    },
    reason:
      `${survivors.length} witnessed prompt id(s) survived into this reading, so the history ` +
      `ring is the same ring (epoch ${epochNow}); watermarks [${fmt(low)}..${fmt(high)}]` +
      (evicted
        ? '. Entries LEFT the ring (' +
          (evictedInBracket
            ? `low ${openLow} → ${closeLow} DURING the bracket`
            : `low ${prev.low} → ${low} between polls`) +
          '), so the enumeration is not a closure — shorten the query interval.'
        : '.'),
  };
}

/**
 * The epoch id. A digest over the install identity and the OLDEST anchor the
 * epoch was pinned from, so it is stable for the life of one run and differs
 * across a reset even when both runs start from number 0 — the anchor's
 * prompt_id is a fresh uuid in the second run.
 *
 * Null when there is nothing to pin it to. An epoch id invented for an empty
 * history would be a new identity on every poll of an idle upstream, which
 * would read as a restart every time.
 */
export function mintEpoch(
  identity: string | null,
  anchors: ReadonlyArray<{ number: number | null; prompt_id: string }>,
  low: number | null,
  high: number | null,
): string | null {
  if (anchors.length === 0) return null;
  const oldest = [...anchors].sort(byNumberThenId)[0]!;
  const material = canonicalJson({
    identity,
    anchor_number: oldest.number,
    anchor_prompt_id: oldest.prompt_id,
    pinned_low: low,
    pinned_high: high,
  });
  return `epoch:${crypto.createHash('sha256').update(material, 'utf8').digest('hex').slice(0, 32)}`;
}

function byNumberThenId(
  a: { number: number | null; prompt_id: string },
  b: { number: number | null; prompt_id: string },
): number {
  if (a.number === null && b.number === null) return a.prompt_id < b.prompt_id ? -1 : 1;
  if (a.number === null) return 1;
  if (b.number === null) return -1;
  if (a.number !== b.number) return a.number - b.number;
  return a.prompt_id < b.prompt_id ? -1 : 1;
}

// ---------------------------------------------------------------------------
// THE POLLER
// ---------------------------------------------------------------------------

export interface TrackerOptions {
  upstreamUrl: string;
  /** How often the bracket is taken. */
  pollIntervalMs: number;
  /**
   * How old a bracket close may be and still describe a leaf's interval.
   * Beyond it the observation degrades to `interval_not_covered` — the
   * enumeration is real, it just does not cover what the leaf claims.
   */
  maxReadingAgeMs: number;
  /** How many of the NEWEST entries are witnessed as anchors. The newest are
   *  the last to be evicted, so they are the strongest overlap set available
   *  for one request. */
  anchorWindow: number;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
  log?: (line: string) => void;
  now?: () => number;
}

/**
 * ⚑ WHY THIS POLLS INSTEAD OF MEASURING INSIDE `emit()`.
 *
 * WO-C4 established that a fact read once at startup is config-inherited by
 * the time a leaf is emitted, and that the fix is to re-read it AT emission.
 * That is right for `stat(2)`, which costs microseconds and cannot hang. It is
 * WRONG here, for two reasons that are not convenience:
 *
 *   1. `emit()` is the BLOCKING half of the gate — no byte is forwarded until
 *      it resolves. An HTTP round trip to the upstream inside it makes every
 *      artifact's latency depend on the upstream's responsiveness, and WO-C4's
 *      own finding is what fail-closed costs when the blocking half can stall.
 *   2. The thing being measured IS the upstream. A component that blocks its
 *      capture path on the health of the process it is watching stops
 *      capturing exactly when that process misbehaves.
 *
 * So the reading is taken out of band, and THE STALENESS IS DISCLOSED ON THE
 * LEAF rather than hidden: `observationFor(observedAtMs)` degrades continuity
 * to `unknown` and the reason to `interval_not_covered` when the last bracket
 * close is older than `maxReadingAgeMs`. A reading with a disclosed age is a
 * measurement; a reading whose age is silently assumed is the inheritance
 * pattern. The structural consequence is that `continuous` can never be
 * claimed for an interval longer than the poll window, which is exactly the
 * bound the underlying fact supports.
 */
export class UpstreamTracker {
  private state: EpochState | null = null;
  private last: UpstreamReading = {
    observation: UNQUERIED_UPSTREAM,
    reason: 'no bracket has been taken yet',
    observedAtMs: null,
  };
  private timer: NodeJS.Timeout | null = null;
  /**
   * ⚑ A DISCONTINUITY IS AN EVENT IN AN INTERVAL, NOT A PROPERTY OF A POLL,
   * and this field is the difference between the two.
   *
   * A leaf's claimed interval runs from the previous emission to this one. The
   * poll cadence is unrelated to it: a restart detected at 12:00:03 belongs on
   * the next leaf even if two clean brackets are taken at 12:00:04 and
   * 12:00:05 before an artifact happens to be produced. A tracker that
   * reported only its NEWEST reading would raise the alarm for one poll window
   * and then go quiet — the restart would be in the log and on no leaf at all,
   * which is the shape of the defect this work order exists to close, one
   * level up.
   *
   * So a detected discontinuity is HELD until an emission takes it, and the
   * emission clears it. Once taken, later leaves report what the newest
   * bracket actually found — otherwise every leaf after a restart would read
   * as a further restart.
   *
   * ⚑ IT IS NOT "EXACTLY ONE LEAF". Inside the poll window in which the
   * restart was measured, `this.last` also carries `restarted`, so a second
   * leaf emitted before the next bracket reports it too. That is one event
   * seen by two leaves whose intervals both contain it, not two events: both
   * carry the same epoch transition, and grouping by epoch is what
   * distinguishes them. The hold is not a de-duplicator; it exists so the
   * event is not LOST when clean brackets follow before the next artifact.
   *
   * ⚑ WHAT THIS DOES NOT SURVIVE, said rather than discovered: the flag is
   * cleared when `observationFor()` returns it, which is inside `buildLeaf`
   * and therefore BEFORE the MAC. If the ratchet then fails to spend a
   * counter, the leaf is never emitted and the pending event goes with it.
   * That window is the same one in which the gate is already failing closed
   * and forwarding nothing, and the epoch id — which changes permanently —
   * still carries the discontinuity to every later leaf. It is a weaker
   * record, not an absent one.
   */
  private pendingDiscontinuity: { reason: string; epochBefore: string | null } | null = null;
  /**
   * WO-E2. THE NEWEST ENUMERATION WINDOW, kept so the absence set can be built
   * from the same bracket the epoch was decided by.
   *
   * It is a separate field rather than part of `last` because the two have
   * different lifetimes: `observationFor()` may hand a leaf a HELD
   * discontinuity from an earlier bracket, while the enumeration is always the
   * newest window that was actually read. A leaf therefore gets a real
   * enumeration and the reason the enumeration is not a closure, which is the
   * pair the absence set needs — rather than an enumeration invented to match
   * the observation.
   */
  private lastWindow: HistoryReading | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly log: (line: string) => void;
  private readonly now: () => number;
  private lastLoggedEpoch: string | null = null;
  /** Every bracket taken, newest last. Diagnostics and the gate script. */
  readonly readings: UpstreamReading[] = [];

  constructor(private readonly opts: TrackerOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.log = opts.log ?? ((l) => console.log(`[upstream-epoch] ${l}`));
    this.now = opts.now ?? (() => Date.now());
  }

  /** Take one bracket. Exposed so a test drives it without a timer. */
  async poll(): Promise<UpstreamReading> {
    const read = await this.bracket();
    // WO-E2. Only a SUCCESSFUL window read replaces the enumeration. A failed
    // one leaves the previous window standing and the reason on the leaf says
    // `history_unavailable`, which `buildAbsenceSet` turns into
    // `not_enumerated` — the reading is not silently reused as though it still
    // described the present.
    this.lastWindow = read.window.ok ? read.window : null;
    const { next, observation, reason } = compareEpoch(this.state, read);
    this.state = next;
    const reading: UpstreamReading = { observation, reason, observedAtMs: this.now() };
    this.last = reading;
    this.readings.push(reading);

    // Held for the next emission. See `pendingDiscontinuity`.
    if (observation.upstream_continuity === 'restarted') {
      this.pendingDiscontinuity = { reason, epochBefore: this.state?.epoch ?? null };
    }

    // Logged on CHANGE of epoch or continuity, not per poll: a line every 15
    // seconds is noise an operator learns to skip, and the transition is the
    // one thing they must not miss. Same treatment the Submitter gives the
    // attestation basis and the storage confinement.
    const key = `${observation.upstream_epoch}/${observation.upstream_continuity}`;
    if (key !== this.lastLoggedEpoch) {
      this.lastLoggedEpoch = key;
      this.log(`upstream ${observation.upstream_continuity} → ${reason}`);
    }
    return reading;
  }

  /** WO-E2. `max_items` the enumeration asks for. The absence set records it
   *  beside how many entries came back, because equal means the WINDOW may
   *  have truncated the ring rather than the ring being exhausted. */
  get anchorWindow(): number {
    return this.opts.anchorWindow;
  }

  /** WO-E2. The newest successfully-read `/history` window, or null when the
   *  last read of it failed. Raw: the caller owns the artifact shape. */
  enumerationWindow(): HistoryReading | null {
    return this.lastWindow;
  }

  start(): void {
    if (this.timer) return;
    void this.poll().catch(() => undefined);
    this.timer = setInterval(() => void this.poll().catch(() => undefined), this.opts.pollIntervalMs);
    // Never hold the process open for a diagnostic poller.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * The leaf's view, evaluated against THIS emission's clock. See the class
   * header for why the network read is not here and the staleness check is.
   */
  observationFor(observedAtMs: number): { observation: UpstreamObservation; reason: string } {
    const r = this.last;

    // A HELD DISCONTINUITY OUTRANKS EVERYTHING BELOW, including staleness. A
    // measured restart is a measured restart whatever the age of the newest
    // bracket; reporting `interval_not_covered` over the top of it would
    // suppress the one fact the leaf exists to carry. Taken and cleared here:
    // this emission is the one whose interval contains it.
    const pending = this.pendingDiscontinuity;
    if (pending) {
      this.pendingDiscontinuity = null;
      return {
        observation: {
          ...r.observation,
          upstream_continuity: 'restarted',
          upstream_uncaptured_reason: 'evicted_or_restarted',
          upstream_source: 'measured',
        },
        reason:
          `${pending.reason} Reported on this leaf because a leaf's interval runs from the ` +
          'previous emission to this one, and the discontinuity falls inside it — not because ' +
          'it was the newest bracket.',
      };
    }

    if (r.observedAtMs === null) {
      return {
        observation: UNQUERIED_UPSTREAM,
        reason:
          'upstream tracking is configured but no bracket has completed yet; nothing has been ' +
          'asked of the upstream that could describe this leaf.',
      };
    }
    const age = observedAtMs - r.observedAtMs;
    if (age > this.opts.maxReadingAgeMs) {
      return {
        // The IDENTITY and EPOCH are still what was measured — they are facts
        // about a past reading and stay true of it. CONTINUITY and the REASON
        // are claims about THIS interval, and this reading does not cover it.
        observation: {
          ...r.observation,
          upstream_continuity: 'unknown',
          upstream_uncaptured_reason: 'interval_not_covered',
        },
        reason:
          `the newest upstream bracket closed ${age}ms before this emission, beyond the ` +
          `${this.opts.maxReadingAgeMs}ms bound. The reading is real; it does not cover this ` +
          'leaf\'s interval, and a restart inside the gap would be invisible to it.',
      };
    }
    return { observation: r.observation, reason: r.reason };
  }

  // -- the three reads, bracketed -----------------------------------------

  private async bracket(): Promise<BracketedRead> {
    // 1. WHICH INSTALL. Never a restart signal on its own — see the header.
    const stats = await this.get('/system_stats');
    const identityOk = stats.ok;
    const identity = stats.ok ? upstreamIdentityOf(stats.body) : null;

    // 2. OPEN — the oldest retained entry. `offset=0, max_items=1` walks the
    //    dict from the front (execution.py:1282-1300), so this IS the low
    //    watermark. (`max_items` with no `offset` returns the NEWEST, because
    //    offset defaults to -1 and becomes `len - max_items`.)
    const open = await this.readHistory('?max_items=1&offset=0');

    // 3. THE ENUMERATION — the newest `anchorWindow` entries.
    const window = await this.readHistory(`?max_items=${this.opts.anchorWindow}`);

    // 4. CLOSE — the oldest again. If it moved, entries left the ring WHILE
    //    the enumeration was running and the enumeration is not a closure.
    const close = await this.readHistory('?max_items=1&offset=0');

    return { identity, identityOk, open, window, close };
  }

  private async readHistory(query: string): Promise<HistoryReading> {
    const res = await this.get(`/history${query}`);
    if (!res.ok) {
      return { ok: false, low: null, high: null, anchors: [], outputs: [], error: res.error };
    }
    const parsed = parseHistory(res.body);
    // An empty ring is a successful reading of an empty ring.
    return parsed.anchors.length === 0 && parsed.ok ? { ...EMPTY_READING } : parsed;
  }

  private async get(p: string): Promise<{ ok: boolean; body: unknown; error: string | null }> {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), this.opts.requestTimeoutMs ?? 4000);
    try {
      const res = await this.fetchImpl(`${this.opts.upstreamUrl}${p}`, {
        method: 'GET',
        signal: ctl.signal,
      });
      if (!res.ok) return { ok: false, body: null, error: `HTTP ${res.status}` };
      return { ok: true, body: await res.json(), error: null };
    } catch (e) {
      return { ok: false, body: null, error: String((e as Error)?.message ?? e) };
    } finally {
      clearTimeout(t);
    }
  }
}

// -- small helpers ---------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function fmt(n: number | null): string {
  return n === null ? '-' : String(n);
}

function short(s: string | null): string {
  return s === null ? '(none)' : s.length > 18 ? `${s.slice(0, 18)}…` : s;
}

/** §10 C-1's encoding: UTF-8 JSON, keys sorted by code point, compact. */
function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    const keys = Object.keys(v as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}
