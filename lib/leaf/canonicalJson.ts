// RFC 8785 (JSON Canonicalization Scheme) — the one serializer every
// `workflow_hash` preimage goes through, in this language.
//
// WHY THIS FILE EXISTS
//
// `lib/scruple/canonicalWorkflow.ts` said "recursively sort keys, keep array
// order, no whitespace" and then handed every scalar to
// `JSON.stringify(value)`. That is a complete rule for objects and arrays and
// NO rule at all for numbers: it delegates to the host language. WO-20 hit the
// consequence on the training path — a learning rate of `1e-5` is `0.00001`
// under JavaScript and `1e-05` under Python, so the server and a third-party
// verifier compute two different `workflow_hash` values for an identical
// recipe. A hash mismatch is indistinguishable from a tampered document, which
// makes this the most expensive kind of evidence failure to diagnose.
//
// It is NOT training-specific. `docs/provenance-bundles/bundle-29e9a40e1d43/
// iterations/video-1/workflow_api.json` is a shipped ComfyUI graph containing
// `"cfg": 3.0`, and the two languages disagree on it today. Measured, not
// assumed — see docs/canon/CANONICALIZATION.md §2.
//
// WHY RFC 8785 AND NOT A RULE OF OUR OWN
//
// Inventing a number canonicalization is a well-known way to be subtly wrong
// for years, and the estate had already started down that road twice: the
// ratchet's `canonical_preimage` REFUSES floats (§10 C-1), and WO-20's
// `training_recipe()` commits them as quoted decimal strings. Both work; both
// are ours; neither is checkable against anything outside this repo.
//
// RFC 8785 is checkable, and it has one property that decided it:
//
//   JCS §3.2.2.3 mandates ECMA-262 §7.1.12.1 — ECMAScript's own
//   Number::toString — as the number rule, and JCS §3.2.3 sorts property
//   names by UTF-16 CODE UNIT, which is exactly what `Array#sort` does.
//
// `JSON.stringify` of a finite number IS Number::toString, and its string
// escaping is already JCS §3.2.2.2. So THE SHIPPED TYPESCRIPT WAS ALREADY
// RFC 8785 CONFORMANT for every document that is valid JSON, and adopting the
// RFC changes zero bytes of output for every leaf that exists. That is the
// whole argument for why this is not a leaf-scheme bump; the long form is in
// docs/canon/CANONICALIZATION.md §4, and `test/v2/canonicalization.test.ts`
// pins it against fixtures captured from the pre-WO-21 implementation.
//
// WHAT DID CHANGE: REFUSALS, NOT REFORMATTING
//
// The old implementation answered for four kinds of value that are not JSON,
// and answered wrongly and silently:
//
//   NaN / Infinity  ->  JSON.stringify emits `null`. A NaN hyperparameter
//                       committed as "no value" is a false record, and JCS
//                       §3.2.2.3 requires termination with an error.
//   undefined       ->  JSON.stringify returns the VALUE undefined, which the
//                       old string concatenation turned into the literal text
//                       `{"a":undefined,"b":1}` — not parseable JSON, so no
//                       verifier in any language could reproduce it.
//   sparse arrays   ->  `[1,,2]`. Same problem.
//   Date/Map/class  ->  `Object.keys(new Date())` is `[]`, so any such value
//                       canonicalized to `{}` and the hash committed to
//                       nothing.
//
// Refusing these is a behaviour change only for documents whose old hash was
// meaningless. `canonicalizeLegacy()` below is kept so a leaf that somehow
// contains one can still be replayed — see its comment.
//
// WHAT REMAINS UNFIXABLE HERE, STATED SO NOBODY LOOKS FOR IT
//
// JavaScript has one numeric type. `JSON.parse('1.0')` and `JSON.parse('1')`
// produce the same value, so this module cannot tell them apart and does not
// try: under JCS both canonicalize to `1`, and the Python implementation is
// written to agree by treating every JSON number as a double.
//
// `JSON.parse('9007199254740993')` silently yields 9007199254740992. By the
// time a value reaches this function the precision is already gone, so THE
// LOSS IS NOT DETECTABLE ON THIS SIDE. `scruple_api.canonical` refuses such
// integers because Python can still see them; the asymmetry is deliberate and
// documented rather than papered over with a check that cannot work.

import { createHash } from 'node:crypto';

/**
 * The canonicalization rule this module implements. Registry-declared.
 *
 * `jcs-2` — RFC 8785 as `jcs-1` defined it, EXTENDED TO TWO MORE PREIMAGES.
 *
 * `jcs-1` canonicalized `workflow_hash` and left `input_hash` and
 * `model_fingerprints_hash` in the language's own `JSON.stringify`. Those two
 * were therefore engine-dependent: V8 orders integer-like keys ascending while
 * Python preserves insertion order, and Python escapes non-ASCII by default
 * while V8 emits UTF-8. `input_hash`'s preimage embeds the whole ComfyUI graph
 * — every node keyed by a number — so a verifier recomputing it in the other
 * language got a different digest, and a different digest is indistinguishable
 * from tampering.
 *
 * A NEW NAME RATHER THAN A REDEFINITION, and this is the whole reason
 * migration 049 exists. Rows already carry `canonicalization_profile`, and
 * leaving this string as `jcs-1` while changing what it produces would make
 * one profile name mean two different rules — which is precisely the defect
 * WO-21 found in `insertion-order-1` and this machinery exists to prevent.
 * Rows written before today keep `jcs-1` and remain replayable.
 *
 * NOT a leaf-scheme bump. `leaf_schemes` govern WHICH FIELDS enter a preimage
 * and in what order; this changes how a field's own document becomes bytes.
 * Two orthogonal axes, and the registry carries both.
 */
export const CANONICALIZATION_PROFILE = 'jcs-2' as const;

/** What `jcs-1` produced for the two preimages `jcs-2` corrects. Replay only. */
export const CANONICALIZATION_PROFILE_PREVIOUS = 'jcs-1' as const;

/** Raised instead of hashing a document that has no canonical form. */
export class CanonicalizationError extends Error {
  /** Machine-readable reason, shared with the Python implementation. */
  readonly reason: string;
  /** Where in the document, as a JSON-pointer-ish path. */
  readonly path: string;

  constructor(reason: string, path: string, detail: string) {
    super(`canonicalize: ${detail} at ${path || '<root>'} [${reason}]`);
    this.name = 'CanonicalizationError';
    this.reason = reason;
    this.path = path;
  }
}

// A lone surrogate is not a Unicode string. ES2019's well-formed
// JSON.stringify escapes it as \udXXX rather than emitting invalid UTF-8,
// which means JavaScript can silently produce a canonical form that Python
// cannot even encode. Refuse on both sides instead.
const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function quote(s: string, path: string): string {
  if (LONE_SURROGATE.test(s)) {
    throw new CanonicalizationError(
      'lone_surrogate',
      path,
      'string contains an unpaired UTF-16 surrogate and is not valid Unicode',
    );
  }
  // JSON.stringify's string escaping IS JCS §3.2.2.2: \b \t \n \f \r for the
  // five named controls, lowercase \u00hh for the rest below U+0020, \" and
  // \\ for the two structural characters, everything else literal.
  return JSON.stringify(s);
}

function canon(v: unknown, path: string): string {
  if (v === null) return 'null';

  const t = typeof v;

  if (t === 'string') return quote(v as string, path);
  if (t === 'boolean') return (v as boolean) ? 'true' : 'false';

  if (t === 'number') {
    const n = v as number;
    if (!Number.isFinite(n)) {
      throw new CanonicalizationError(
        'non_finite_number',
        path,
        `${Number.isNaN(n) ? 'NaN' : 'Infinity'} has no JSON spelling (JCS §3.2.2.3)`,
      );
    }
    // JCS §3.2.2.3 -> ECMA-262 §7.1.12.1 -> this. Number::toString renders
    // -0 as "0", which is what JCS's own test vectors expect.
    return JSON.stringify(n);
  }

  if (t === 'undefined') {
    throw new CanonicalizationError(
      'undefined_value',
      path,
      'undefined is not a JSON value; omit the key or send null',
    );
  }
  if (t === 'bigint') {
    throw new CanonicalizationError(
      'bigint_value',
      path,
      'a BigInt is outside the IEEE-754 double range JCS defines',
    );
  }
  if (t === 'function' || t === 'symbol') {
    throw new CanonicalizationError('unsupported_type', path, `a ${t} is not JSON`);
  }

  if (Array.isArray(v)) {
    const parts: string[] = [];
    for (let i = 0; i < v.length; i++) {
      // A hole in a sparse array reads as undefined and canon() refuses it,
      // which is the point: the old code emitted `[1,,2]`.
      if (!(i in v)) {
        throw new CanonicalizationError(
          'sparse_array',
          `${path}[${i}]`,
          'array has a hole, which has no JSON representation',
        );
      }
      parts.push(canon(v[i], `${path}[${i}]`));
    }
    return `[${parts.join(',')}]`;
  }

  // Anything that is not a plain object canonicalizes to `{}` under
  // Object.keys — a Date, a Map, a class instance, a typed array all commit
  // to nothing. Refuse rather than hash a lie.
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) {
    throw new CanonicalizationError(
      'not_a_plain_object',
      path,
      `${(v as object).constructor?.name ?? 'value'} is not a plain JSON object`,
    );
  }

  const obj = v as Record<string, unknown>;
  // JCS §3.2.3: "Property name strings to be sorted are formatted as arrays
  // of UTF-16 code units ... treated as unsigned integers." JavaScript's
  // default string comparison is exactly that, so `.sort()` is correct here
  // and MUST NOT be "fixed" to a code-point sort — see the note on the two
  // sort rules in docs/canon/CANONICALIZATION.md §6.
  const keys = Object.keys(obj).sort();
  const parts = keys.map((k) => `${quote(k, path)}:${canon(obj[k], `${path}.${k}`)}`);
  return `{${parts.join(',')}}`;
}

/**
 * RFC 8785 canonical JSON text for any JSON-representable value.
 *
 * Throws `CanonicalizationError` rather than answering for a value that has
 * no canonical form. See the module header for the four such cases and why
 * each was previously answered wrongly.
 */
export function canonicalize(value: unknown): string {
  return canon(value, '');
}

/** The canonical form as the bytes that are actually hashed. */
export function canonicalizeBytes(value: unknown): Buffer {
  return Buffer.from(canonicalize(value), 'utf8');
}

/**
 * SHA-256 hex of the canonical serialization. 64 lowercase hex, no prefix.
 *
 * This is `workflow_hash` — over the ComfyUI workflow_api_json for
 * `kind=graph_execute`, and over the training recipe for `kind=model_write`.
 * `lib/leaf/registry.yaml` states the preimage in prose; this is the only
 * implementation of it in TypeScript.
 */
export function hashWorkflow(doc: unknown): string {
  return createHash('sha256').update(canonicalizeBytes(doc)).digest('hex');
}

// ---------------------------------------------------------------------------
// Profile `legacy-1` — replay only.
//
// Byte-identical to `canonicalize()` for every document that is valid JSON,
// which is the reason no leaf scheme was bumped. It differs ONLY on the four
// non-JSON values above, where it reproduces what the pre-WO-21 code did:
// NaN/Infinity became `null`, `undefined` became the literal text
// `undefined`, a hole became nothing, and a non-plain object became `{}`.
//
// Nothing writes leaves through this. It exists so that if such a leaf turns
// out to exist, an auditor can reproduce its hash and see WHAT was committed,
// rather than being told the document is unhashable and left unable to tell a
// bad canonicalization from a tampered file. Keeping it is cheaper than the
// alternative, which is a hash nobody can ever account for.
// ---------------------------------------------------------------------------

/** @deprecated Replay of pre-WO-21 leaves only. Never for new evidence. */
export function canonicalizeLegacy(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) as unknown as string;
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalizeLegacy).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  return (
    '{' +
    Object.keys(obj)
      .sort()
      .map((k) => JSON.stringify(k) + ':' + canonicalizeLegacy(obj[k]))
      .join(',') +
    '}'
  );
}

/** @deprecated Replay of pre-WO-21 leaves only. */
export function hashWorkflowLegacy(doc: unknown): string {
  return createHash('sha256').update(canonicalizeLegacy(doc), 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Profile `insertion-order-1` — replay only, and a finding.
//
// WO-21 went looking for leaves the canonicalization bug had already damaged
// and found a DIFFERENT, older break instead. `data/scruple.db` holds seven
// rows with a `workflow_hash`. Four of them — ids 166..169, written
// 2026-07-05 — cannot be reproduced by ANY canonical rule, in either
// language, from the graph stored beside them. Their `input_hash` reproduces
// exactly from the same stored spec, which proves the document is intact and
// the FORMULA is what changed.
//
// It changed at ec188d6, 2026-07-13, "WO-A2 canonical workflow_hash — sorted
// keys, whitespace-free". Before it, `workflow_hash` was plain
// `JSON.stringify` in the object's own key order. That commit is the right
// change and it was made without a version marker: the four older rows still
// carry `leaf_scheme: 'v2.2'`, exactly like the rows written after it, so
// nothing in the record tells an auditor which rule to replay. Replaying them
// under the documented preimage yields a mismatch that reads as tampering.
//
// This is the same failure WO-21 exists to prevent, having already happened
// once. It is why `canonicalization_profiles` is now a first-class section of
// lib/leaf/registry.yaml rather than a sentence in a comment: the estate has
// demonstrated it will change a preimage rule again.
//
// The four rows are replayable — both languages reproduce them, because these
// particular graphs are keyed "3", "4", "5"… and numeric-like keys happen to
// order the same way under V8's own object ordering and Python's insertion
// order. That is a coincidence of this corpus and NOT a property of the
// profile. A pre-2026-07-13 graph with non-numeric top-level keys would be
// reproducible only in the serializer that wrote it.
// ---------------------------------------------------------------------------

/** @deprecated Replay of pre-2026-07-13 (ec188d6) leaves only. */
export function canonicalizeInsertionOrder(value: unknown): string {
  return JSON.stringify(value) as unknown as string;
}

/** @deprecated Replay of pre-2026-07-13 (ec188d6) leaves only. */
export function hashWorkflowInsertionOrder(doc: unknown): string {
  return createHash('sha256').update(canonicalizeInsertionOrder(doc), 'utf8').digest('hex');
}
