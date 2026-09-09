// `declared_uncaptured` — the absence set, and the scope it enumerated over.
//
// WO-E2. The settled scope rule is `docs/canon/DECLARED_UNCAPTURED.md`, written
// and committed BEFORE this file, because the design was the unsettled half.
// WO-C5 built everything this depends on and stopped here on purpose
// (`council-impl/WO-C5.md` §10): the epoch, both watermarks, and the
// five-valued `upstream_uncaptured_reason` exist so that an absence set drawn
// from a bounded, in-memory, restart-volatile ring can say whether it is a
// closure. This is the set.
//
// The question, round 5 §3, put to Coder as a question rather than a ruling:
//
//   "must `declared_uncaptured` carry the scope it enumerated over — which root
//   types were configured, and whether any were `unspecified` — or does it
//   assert a closure it does not have? That is your own measured-or-unknown
//   invariant applied one level up: THE COMPLETENESS OF THE ABSENCE SET IS
//   ITSELF A FACT, and it needs a source like every other fact."
//
// The answer, line 369, which this file implements and does not reopen:
//
//   "`declared_uncaptured` must be scoped, never treated as a global absence
//   claim. Its record needs the configured volume types and roots (`output`,
//   `temp`, `input`), the query interval or history watermark, whether any
//   `unspecified` volume exists, and a completeness result. A COMPLETE ABSENCE
//   ENUMERATION IS PERMITTED ONLY WHEN ALL RELEVANT TYPED ROOTS ARE COVERED AND
//   NO RELEVANT ROOT IS `unspecified`; otherwise the set is explicitly partial
//   and cannot support a closure claim."
//
// and on the volatility of the source, same paragraph:
//
//   "`source: measured` applies to the returned enumeration itself, with
//   `enumeration_method: "live_history"` and its observed scope; COMPLETENESS
//   IS `source: unknown` UNLESS AN INDEPENDENT OBSERVER ESTABLISHES THE
//   RELEVANT HISTORY WINDOW AND CONTINUITY."
//
// ---------------------------------------------------------------------------
// WHY THE ENUMERATION SOURCE IS `/history` AND NOT THE FILESYSTEM
// ---------------------------------------------------------------------------
//
// Round 5 §4(a), verified in the ComfyUI source for that round: `PreviewImage`
// sets `self.type = "temp"` (nodes.py:1684-1690), `SaveImage.save_images`
// emits `"type": self.type` per file (:1678), execution.py:802-803 puts the
// result in `history_result["outputs"]` and `task_done` merges it in
// (:1237-1242). A `temp/` artifact IS listed in `/history`, tagged
// `type: "temp"`, even though it is never written to `output/`. So the
// enumeration reaches the volume the pre-C-8 configuration could not see —
// which is what made Architect's proposed source viable at all.
//
// ---------------------------------------------------------------------------
// ⚑ AND WHAT `complete` DOES NOT MEAN
// ---------------------------------------------------------------------------
//
// Closure over what `/history` REPORTED, across roots that cover every typed
// volume. NOT closure over what the machine wrote. A custom node writing
// straight to disk produces no `/history` entry at all — round 6 §5 classified
// that as "correctly uncaptured" and a host quota problem — and the only
// observer of that class is the filesystem watcher, which is precisely why
// condition 1 below requires every typed root to be watched. Everything
// outside every watched root is a declared root boundary and is outside every
// completeness claim in this design.

import crypto from 'node:crypto';

import { canonicalize } from '../leaf/canonicalJson';
import type { UncapturedReason, UpstreamObservation } from './upstreamEpoch';

// ---------------------------------------------------------------------------
// THE VOCABULARY
// ---------------------------------------------------------------------------

/** The four volume types §10 C-8 names, plus the honest label for a reference
 *  whose type nobody declared. Identical to `WatchedVolumeType` in the
 *  component's config, and deliberately re-declared here rather than imported:
 *  `lib/` is the server's side of the wire and must not depend on
 *  `services/scruple-capture/`. The two are held together by
 *  `test/v2/declared-uncaptured.test.ts`, which asserts they agree. */
export type ArtifactVolumeType = 'output' | 'temp' | 'input' | 'unspecified';

export const C8_TYPES: readonly ArtifactVolumeType[] = ['output', 'temp', 'input'];

const VOLUME_TYPES: readonly string[] = ['output', 'temp', 'input', 'unspecified'];

/**
 * One artifact, named the way ComfyUI names it — the triple `/view` takes and
 * `history[*].outputs[*]` emits. Nothing here is a path on this machine: a
 * subfolder is relative to the typed root, which is what makes the reference
 * comparable across the two halves that produce it.
 */
export interface ArtifactRef {
  type: ArtifactVolumeType;
  subfolder: string;
  filename: string;
}

/**
 * How the set was obtained. `none` is not "an empty enumeration": it is the
 * absence of one, and §6 of the design doc is why the two may never read the
 * same.
 */
export type UncapturedEnumerationMethod = 'live_history' | 'none';

/**
 * THE COMPLETENESS RESULT line 369 asks for by name.
 *
 *   'complete'        every condition a closure claim needs holds. The set is
 *                     every artifact `/history` reported that was not captured.
 *   'partial'         the enumeration is REAL and is NOT a closure. Absence
 *                     from the set means nothing. Every reason is named.
 *   'not_enumerated'  no enumeration exists. There is no set, no count and no
 *                     digest of one.
 */
export type UncapturedScope = 'complete' | 'partial' | 'not_enumerated';

/** The invariant every asserted field in this design carries. No third. */
export type UncapturedScopeSource = 'measured' | 'unknown';

const METHODS: readonly string[] = ['live_history', 'none'];
const SCOPES: readonly string[] = ['complete', 'partial', 'not_enumerated'];

export function isArtifactVolumeType(v: unknown): v is ArtifactVolumeType {
  return typeof v === 'string' && VOLUME_TYPES.includes(v);
}
export function isUncapturedEnumerationMethod(v: unknown): v is UncapturedEnumerationMethod {
  return typeof v === 'string' && METHODS.includes(v);
}
export function isUncapturedScope(v: unknown): v is UncapturedScope {
  return typeof v === 'string' && SCOPES.includes(v);
}
export function isUncapturedScopeSource(v: unknown): v is UncapturedScopeSource {
  return v === 'measured' || v === 'unknown';
}

// ---------------------------------------------------------------------------
// ⚑ THE BLOCKER, NAMED — NOT A CONSTANT SOMEBODY WILL DELETE
// ---------------------------------------------------------------------------
//
// Coder's answer on fact (b) is explicit and is not softened: completeness is
// `source: unknown` UNLESS AN INDEPENDENT OBSERVER establishes the relevant
// history window and continuity. Today the only party that reads `/history` is
// the same component that emits the leaf. It is not independent of the claim,
// and a completeness fact sourced from the party it describes is the
// self-grading `hostRegistry.ts` refuses one file over
// (`host_may_not_grade_itself`).
//
// So the source is DERIVED FROM THIS FLAG rather than hardcoded, in the shape
// `attestationBasis.ts` already uses for CHECKPOINT_VECTORS_SETTLED: the
// function computes both branches, the tests drive it with the flag both ways,
// and rule 8 refuses `measured` on the wire while the flag stands. A value
// that could never fire would be a field that proves only that it cannot,
// which is the failure mode this whole series is written against.
//
// What would flip it: a party other than the emitting component establishing
// the history window and continuity for the interval — a witness-side history
// attestation, or a second gate reading the same upstream. Neither exists.
export const UNCAPTURED_INDEPENDENT_OBSERVER = false;

export const UNCAPTURED_OBSERVER_BLOCKER_REASON =
  'no independent observer establishes the upstream history window and continuity: the only ' +
  "party that reads /history is the same component that emits the leaf, so the absence set's " +
  'own completeness would be asserted by the party it describes. Coder, round 5 fact (b): ' +
  '"completeness is source: unknown unless an independent observer establishes the relevant ' +
  'history window and continuity."';

// ---------------------------------------------------------------------------
// WHAT LANDS ON A LEAF
// ---------------------------------------------------------------------------

/** The five signed scalars. Every one a string, a safe integer, or null. */
export interface UncapturedObservation {
  uncaptured_enumeration_method: UncapturedEnumerationMethod;
  uncaptured_scope: UncapturedScope;
  uncaptured_scope_source: UncapturedScopeSource;
  /** ⚑ 0 IS A COUNT AND null IS NOT. Signed, even though it is derivable from
   *  the document, so that "looked and found nothing" is distinguishable from
   *  "did not look" WITHOUT trusting an unsigned attachment. Design doc §6. */
  declared_uncaptured_count: number | null;
  /** sha256 of the canonical document. The document rides at the top level and
   *  only this rides in the MAC — the `host_evidence` / `host_evidence_hash`
   *  arrangement, and the route recomputes one from the other. */
  declared_uncaptured_hash: string | null;
}

/** The observation a placement with nothing to enumerate emits. */
export const NOT_ENUMERATED: UncapturedObservation = Object.freeze({
  uncaptured_enumeration_method: 'none',
  uncaptured_scope: 'not_enumerated',
  uncaptured_scope_source: 'unknown',
  declared_uncaptured_count: null,
  declared_uncaptured_hash: null,
});

/** The scope the enumeration ranged over — line 369's four requirements, each
 *  as a field rather than as prose. */
export interface UncapturedScopeRecord {
  /** The configured volume types, sorted. Line 369: "the configured volume
   *  types and roots (output, temp, input)". */
  volume_types: ArtifactVolumeType[];
  /** …and the roots themselves, typed. */
  roots: Array<{ type: ArtifactVolumeType; path: string }>;
  /** Line 369: "whether any `unspecified` volume exists". A count, not a
   *  boolean, because "one of four" and "four of four" are different
   *  configurations with the same boolean. */
  unspecified_roots: number;
  /** Which of C-8's three are NOT declared. Empty is the covering case. */
  missing_types: ArtifactVolumeType[];
  /** Line 369: "the query interval or history watermark". WO-C5's bracket,
   *  verbatim, so the window this set was drawn from is checkable. */
  history_window: {
    epoch: string | null;
    low_watermark_open: number | null;
    low_watermark_close: number | null;
    upstream_uncaptured_reason: UncapturedReason;
    /** `max_items` the enumeration asked for. */
    anchor_window: number;
    /** …and how many entries came back. Equal to `anchor_window` means the
     *  window may have truncated the ring. */
    entries_enumerated: number;
    saturated: boolean;
  };
}

/** Every condition a closure claim needs, and whether it held. */
export interface UncapturedCompleteness {
  result: UncapturedScope;
  source: UncapturedScopeSource;
  /** ⚑ Recorded as a fact rather than implied by `source`, so the day the flag
   *  moves the record says which regime produced it. */
  independent_observer: boolean;
  conditions: {
    roots_cover_c8: boolean;
    history_enumerated: boolean;
    window_unsaturated: boolean;
    ledger_intact: boolean;
  };
  /** One named sentence per failed condition. Coder: "with `source: unknown`
   *  and AN EXPLICIT REASON". Empty exactly when `result` is `complete`. */
  reasons: string[];
}

/** The document. Top-level on the submission, hashed into the MAC. */
export interface DeclaredUncapturedDocument {
  enumeration_method: UncapturedEnumerationMethod;
  scope: UncapturedScopeRecord;
  completeness: UncapturedCompleteness;
  /**
   * ⚑ `transaction: "none"` ON EVERY MEMBER, and it is round 6 §1's ruling
   * rather than decoration: "for an artifact class the gate cannot number ...
   * the leaf must explicitly record `declared_uncaptured` with its scope,
   * `transaction: none`, and `completeness: {source: unknown}`". Nothing in
   * this set spent a ratchet counter, so a verifier must not read the
   * counter's delivery-completeness interval as artifact completeness. The two
   * vantages do not close each other.
   */
  artifacts: Array<ArtifactRef & { prompt_id: string | null; transaction: 'none' }>;
}

// ---------------------------------------------------------------------------
// READING `/history` OUTPUTS
// ---------------------------------------------------------------------------

/**
 * Every artifact reference in one `history[*].outputs` object.
 *
 * ⚑ ANY ARRAY UNDER ANY KEY IS WALKED, AND THAT IS NOT LAZINESS. `images` is
 * the key `SaveImage` uses; `gifs` is VideoHelperSuite's, `audio` is
 * `SaveAudio`'s, and a vendor node picks its own. An allowlist of keys is an
 * enumeration used as a boundary with none of an enumeration's honesty — a key
 * that does not match is not "unknown", it is silently NOT AN ARTIFACT, and
 * the absence set then omits exactly the artifacts nobody thought of. That is
 * WO-27's finding in `correlation.ts`, one file over, and it cost the component
 * a node the product ships.
 *
 * The shape IS the test: an element is a reference if it has a string
 * `filename`. A `type` that is absent or unrecognised reads `unspecified` —
 * never guessed, for `mime.ts`'s reason.
 */
export function artifactsInOutputs(outputs: unknown): ArtifactRef[] {
  if (!isRecord(outputs)) return [];
  const out: ArtifactRef[] = [];
  for (const perNode of Object.values(outputs)) {
    if (!isRecord(perNode)) continue;
    for (const value of Object.values(perNode)) {
      if (!Array.isArray(value)) continue;
      for (const el of value) {
        if (!isRecord(el)) continue;
        if (typeof el.filename !== 'string' || el.filename.length === 0) continue;
        out.push({
          type: isArtifactVolumeType(el.type) ? el.type : 'unspecified',
          subfolder: typeof el.subfolder === 'string' ? el.subfolder : '',
          filename: el.filename,
        });
      }
    }
  }
  return out;
}

/**
 * The comparison key. Normalised so the two halves that produce a reference —
 * a `/view` query string and a path relative to a typed root — land on the
 * same string for the same file.
 */
export function artifactKey(r: ArtifactRef): string {
  const sub = r.subfolder.replace(/^\/+|\/+$/g, '');
  return `${r.type}:${sub}${sub ? '/' : ''}${r.filename}`;
}

/** Sorted by key, so two implementations of the document agree byte for byte. */
function byKey(a: ArtifactRef, b: ArtifactRef): number {
  const x = artifactKey(a);
  const y = artifactKey(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

// ---------------------------------------------------------------------------
// THE LEDGER — WHAT THE COMPONENT DID CAPTURE
// ---------------------------------------------------------------------------

/**
 * Bounded, and the bound is DISCLOSED rather than assumed.
 *
 * A ledger that silently forgot a capture would report a captured artifact as
 * uncaptured — a false accusation in a signed record, which is worse than the
 * hole this field exists to close. So eviction is recorded, and an evicted
 * ledger costs the leaf its closure claim (condition 4) rather than costing it
 * its accuracy. Same discipline the history ring gets one file over: the bound
 * is the bound on the claim, not a performance knob.
 */
export class CapturedLedger {
  private readonly seen = new Set<string>();
  private readonly order: string[] = [];
  private evicted = 0;

  constructor(readonly capacity: number = 4096) {}

  record(ref: ArtifactRef): void {
    const k = artifactKey(ref);
    if (this.seen.has(k)) return;
    this.seen.add(k);
    this.order.push(k);
    while (this.order.length > this.capacity) {
      const oldest = this.order.shift();
      if (oldest !== undefined) {
        this.seen.delete(oldest);
        this.evicted += 1;
      }
    }
  }

  has(ref: ArtifactRef): boolean {
    return this.seen.has(artifactKey(ref));
  }

  get size(): number {
    return this.seen.size;
  }

  /** True while the ledger has forgotten nothing. Condition 4. */
  get intact(): boolean {
    return this.evicted === 0;
  }

  get evictedCount(): number {
    return this.evicted;
  }
}

// ---------------------------------------------------------------------------
// THE FOLD
// ---------------------------------------------------------------------------

export interface UncapturedInput {
  /** The enumeration: every artifact `/history` reported in the newest window,
   *  with the prompt that produced it. null when no usable window read exists
   *  — a failed query, or no bracket yet. */
  enumerated: Array<ArtifactRef & { prompt_id: string | null }> | null;
  /** `max_items` asked for, and how many entries came back. */
  anchorWindow: number;
  entriesEnumerated: number;
  /** The declared roots, as configured. */
  roots: ReadonlyArray<{ type: ArtifactVolumeType; path: string }>;
  /** The ledger's verdict on each reference, and whether it forgot anything. */
  isCaptured: (r: ArtifactRef) => boolean;
  ledgerIntact: boolean;
  /** WO-C5's observation FOR THIS LEAF. The same one that lands in the capture
   *  block, passed in rather than re-derived: `uncaptured_scope: "complete"`
   *  beside an `upstream_uncaptured_reason` that is not `enumerated` is a
   *  contradiction rule 8 refuses, and it can only be prevented structurally
   *  by the two coming from one reading. */
  upstream: UpstreamObservation;
  /** Test-only override of UNCAPTURED_INDEPENDENT_OBSERVER. See its note: the
   *  point of the flag is that both branches are exercised. */
  independentObserver?: boolean;
}

export interface UncapturedResult {
  observation: UncapturedObservation;
  /** null exactly when the observation is `not_enumerated`. */
  document: DeclaredUncapturedDocument | null;
  /** The canonical bytes the hash covers, so the caller stores what was hashed
   *  rather than a re-serialisation of it. */
  json: string | null;
  /** Logged, never sent. An explanation on the wire is a field to be forged. */
  reason: string;
}

/**
 * Build the absence set and its scope.
 *
 * PURE. No clock, no network, no storage — the whole decision is here so the
 * tests can drive it from a table rather than from a live upstream, which is
 * how WO-C5's `compareEpoch` is arranged and for the same reason.
 */
export function buildAbsenceSet(input: UncapturedInput): UncapturedResult {
  const reason = input.upstream.upstream_uncaptured_reason;

  // NO ENUMERATION EXISTS. §5 of the design doc: this is the branch Coder's
  // "must be omitted or marked ... 'not enumerated'" describes exactly — the
  // query failed or nobody asked, so there is nothing to omit or to report.
  if (input.enumerated === null || reason === 'history_unavailable' || reason === 'not_queried') {
    return {
      observation: NOT_ENUMERATED,
      document: null,
      json: null,
      reason:
        reason === 'not_queried'
          ? 'no upstream to enumerate: this placement has no separate process holding a ' +
            'history ring, so there is no absence set and `not_enumerated` says so rather ' +
            'than an empty one implying there was nothing to find.'
          : 'the `/history` enumeration could not be read, so no absence set exists. An empty ' +
            'set here would read as "nothing was uncaptured", which is the one thing the ' +
            'council refused: never "none".',
    };
  }

  // ---- THE DIFF ------------------------------------------------------
  const uncaptured = input.enumerated
    .filter((a) => !input.isCaptured(a))
    .sort(byKey)
    .map((a) => ({
      type: a.type,
      subfolder: a.subfolder,
      filename: a.filename,
      prompt_id: a.prompt_id,
      // Round 6 §1. Nothing in this set was numbered by the ratchet.
      transaction: 'none' as const,
    }));

  // ---- THE FOUR CONDITIONS -------------------------------------------
  const declaredTypes = new Set(input.roots.map((r) => r.type));
  const missingTypes = C8_TYPES.filter((t) => !declaredTypes.has(t));
  const unspecifiedRoots = input.roots.filter((r) => r.type === 'unspecified').length;
  const rootsCoverC8 = missingTypes.length === 0 && unspecifiedRoots === 0;

  const historyEnumerated = reason === 'enumerated' && input.upstream.upstream_source === 'measured';

  const saturated = input.entriesEnumerated >= input.anchorWindow;
  const windowUnsaturated = !saturated;

  const ledgerIntact = input.ledgerIntact;

  const reasons: string[] = [];
  if (!rootsCoverC8) {
    reasons.push(
      `the configured roots do not cover §10 C-8's three typed volumes` +
        (missingTypes.length > 0 ? ` (missing: ${missingTypes.join(', ')})` : '') +
        (unspecifiedRoots > 0 ? ` (${unspecifiedRoots} root(s) declared 'unspecified')` : '') +
        '. A `/history` enumeration cannot report a node that writes straight to disk, and the ' +
        'filesystem watcher is the only observer of that class — so a root that is unwatched, ' +
        'or watched without a type, is a hole this set cannot see into. Closure is refused.',
    );
  }
  if (!historyEnumerated) {
    reasons.push(
      `\`upstream_uncaptured_reason\` is "${reason}" with \`upstream_source\` ` +
        `"${input.upstream.upstream_source}", so the reading behind this enumeration is not a ` +
        'closure over this leaf\'s interval. The artifacts listed were really not captured; ' +
        'absence from the list asserts nothing.',
    );
  }
  if (!windowUnsaturated) {
    reasons.push(
      `the enumeration asked \`/history?max_items=${input.anchorWindow}\` and got back ` +
        `${input.entriesEnumerated} entries, so the WINDOW may have truncated the ring rather ` +
        'than the ring being exhausted. An enumeration that may have been cut short by its own ' +
        'page size cannot support a closure claim.',
    );
  }
  if (!ledgerIntact) {
    reasons.push(
      'the captured-set ledger has evicted entries, so an artifact this component did capture ' +
        'could be reported here as uncaptured. The bound is disclosed rather than assumed, and ' +
        'it costs the leaf its closure claim rather than its accuracy.',
    );
  }

  const independent = input.independentObserver ?? UNCAPTURED_INDEPENDENT_OBSERVER;
  const result: UncapturedScope = reasons.length === 0 ? 'complete' : 'partial';
  // ⚑ `measured` needs BOTH: an independent observer, and a measurement to be
  // independent OF. Neither alone is the fact.
  const source: UncapturedScopeSource =
    independent && input.upstream.upstream_source === 'measured' ? 'measured' : 'unknown';

  const document: DeclaredUncapturedDocument = {
    enumeration_method: 'live_history',
    scope: {
      volume_types: [...declaredTypes].sort() as ArtifactVolumeType[],
      roots: [...input.roots]
        .map((r) => ({ type: r.type, path: r.path }))
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
      unspecified_roots: unspecifiedRoots,
      missing_types: [...missingTypes],
      history_window: {
        epoch: input.upstream.upstream_epoch,
        low_watermark_open: input.upstream.upstream_low_watermark_open,
        low_watermark_close: input.upstream.upstream_low_watermark_close,
        upstream_uncaptured_reason: reason,
        anchor_window: input.anchorWindow,
        entries_enumerated: input.entriesEnumerated,
        saturated,
      },
    },
    completeness: {
      result,
      source,
      independent_observer: independent,
      conditions: {
        roots_cover_c8: rootsCoverC8,
        history_enumerated: historyEnumerated,
        window_unsaturated: windowUnsaturated,
        ledger_intact: ledgerIntact,
      },
      reasons,
    },
    artifacts: uncaptured,
  };

  const { hash, json } = hashDeclaredUncaptured(document);

  return {
    observation: {
      uncaptured_enumeration_method: 'live_history',
      uncaptured_scope: result,
      uncaptured_scope_source: source,
      // ⚑ 0, NOT null. The set is present and empty, which is a different fact
      // from the set being absent, and both of them are signed.
      declared_uncaptured_count: uncaptured.length,
      declared_uncaptured_hash: hash,
    },
    document,
    json,
    reason:
      result === 'complete'
        ? `enumerated ${input.entriesEnumerated} history entr(ies) over ` +
          `${input.roots.length} typed root(s); ${uncaptured.length} artifact(s) reported by the ` +
          'upstream were not captured. Every closure condition holds, so this set is complete ' +
          `over what /history reported — and its source is \`${source}\`` +
          (source === 'unknown' ? `, because ${UNCAPTURED_OBSERVER_BLOCKER_REASON}` : '') +
          '.'
        : `enumerated ${input.entriesEnumerated} history entr(ies); ${uncaptured.length} ` +
          'artifact(s) reported by the upstream were not captured, and the set is PARTIAL: ' +
          reasons.join(' '),
  };
}

/**
 * The document's digest.
 *
 * RFC 8785 over the whole document, and BARE HEX — the same two choices
 * `hashHostEvidence` makes, deliberately, because this is the same
 * arrangement: a document at the top level whose digest is the signed half.
 * `hashModelFingerprints` is top-level-sorted-only and cannot be changed
 * without invalidating leaves that already exist; a field being written today
 * gets the canonicalization those would have if they were being written today,
 * which is also what lets a Python emitter and a TypeScript one agree on the
 * bytes.
 *
 * No float ever reaches it: every number in the document is a count or a
 * watermark, and both are safe integers. A float here would be a digest that
 * reproduces only sometimes (§10 C-1) — the same trap `preimageOf` avoids by
 * excluding the graph.
 *
 * Returns the BYTES as well as the hash, because the caller must store what
 * was hashed rather than a re-serialisation of it: a verifier holding the
 * stored column has to be able to reproduce the digest, and
 * `JSON.stringify(JSON.parse(x))` is not `x`.
 */
export function hashDeclaredUncaptured(doc: DeclaredUncapturedDocument): {
  hash: string;
  json: string;
} {
  const json = canonicalize(doc as unknown as Record<string, unknown>);
  return {
    hash: crypto.createHash('sha256').update(json, 'utf8').digest('hex'),
    json,
  };
}

// -- small helpers ---------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

