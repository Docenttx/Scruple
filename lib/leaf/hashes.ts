// The leaf's derived hashes, in one place.
//
// WHY THIS MODULE EXISTS
//
// Three of the leaf's five hashes were computed inline in
// `lib/iterations/ingest.ts` and nowhere else. When `/api/v2/witness`
// was written it did not compute them at all — the graph was accepted
// and thrown away (`workflowHash: body.graph ? undefined : undefined`).
// The obvious fix is to compute them again in the route, and the obvious
// fix is wrong: two implementations of a preimage are two preimages.
// A verifier holding the same workflow JSON would get one answer from
// canvas and another from a plugin, and nothing would say so, because a
// hash mismatch looks exactly like a tampered file.
//
// So the formulas live here, both call sites import them, and the
// registry (lib/leaf/registry.yaml) documents each preimage in prose so
// a third party can reproduce it without reading TypeScript.
//
// DO NOT "TIDY" THESE. Two of them are deliberately not canonical JSON:
//
//   - hashRunInputs uses plain JSON.stringify with a FIXED key order.
//   - hashModelFingerprints sorts only the TOP-LEVEL keys and leaves the
//     nested per-file objects in their original key order.
//
// Both are what shipped, both are committed to in leaves that already
// exist, and changing either silently invalidates every historical
// input_hash / model_fingerprints_hash. If a better canonicalization is
// wanted it needs a new leaf scheme, not an edit here.
//
// WO-21, AND WHY THE THIRD FORMULA COULD BE FIXED WITHOUT A SCHEME BUMP
//
// The third — `workflow_hash` — had the same class of defect and one
// crucial difference. Its rule was "recursive key sort, no whitespace" plus
// whatever the host language's JSON number formatter does, and the two
// languages that must agree do not: `1e-5` is `0.00001` in JavaScript and
// `1e-05` in Python. It is now RFC 8785, in `lib/leaf/canonicalJson.ts`.
//
// That was NOT a scheme bump, and the reason is specific rather than
// convenient: RFC 8785 §3.2.2.3 mandates ECMA-262's own Number::toString and
// §3.2.3 sorts keys by UTF-16 code unit, both of which are precisely what
// `JSON.stringify` and `Array#sort` already did. The shipped bytes were
// already the RFC's bytes for every document that is valid JSON, so no
// existing leaf changed value. What changed is that four non-JSON values —
// NaN, Infinity, undefined, and non-plain objects — are now REFUSED instead
// of silently hashed as `null`, `undefined`, or `{}`.
//
// FIXED 2026-09-03, under profile `jcs-2`. The paragraph this replaces said
// the other two formulas were "left alone because fixing them IS a scheme
// bump", and that framing was wrong in two ways.
//
// It is not a SCHEME bump: `leaf_schemes` govern which fields enter a preimage
// and in what order, and this changes how a field's document becomes bytes.
// That is a CANONICALIZATION PROFILE, which the registry already carries
// beside the schemes and which migration 049 records per row. Rows written
// before today keep `jcs-1` and stay replayable through the `*Legacy`
// functions below.
//
// And it framed the defect as number FORMATTING when the larger fault was
// REPRODUCIBILITY. `input_hash`'s preimage embeds the whole ComfyUI graph, so
// V8's integer-like key ordering and Python's non-ASCII escaping made a
// verifier in the other language compute a different digest — indistinguishable
// from tampering. `model_fingerprints_hash` committed the file's `mtime`,
// which is not a property of the bytes, so nobody holding the model could
// recompute it at all.

import { sha256Hex } from '@/lib/scruple/hash';
import {
  canonicalize,
  hashWorkflow,
  CanonicalizationError,
} from '@/lib/leaf/canonicalJson';

export { canonicalize, hashWorkflow, CanonicalizationError };

/** One input artifact as it appears in the input_hash preimage. */
export interface InputRef {
  kind: string;
  hash: string;
}

export interface RunInputs {
  /** Generation provider id, or null on surfaces that have none. */
  provider: string | null;
  /** The human prompt, or null on surfaces that have none. */
  prompt: string | null;
  /** The generation spec, or null on surfaces that have none. */
  spec: unknown;
  inputs: InputRef[];
}

/**
 * input_hash — binds the run's inputs.
 *
 * Preimage: JSON.stringify({provider, prompt, spec, inputs}) with the
 * keys in exactly that order and each input reduced to {kind, hash}.
 *
 * Lifted verbatim from lib/iterations/ingest.ts so the two paths cannot
 * drift. The `/v2` surface passes null for provider/prompt/spec because
 * it is zero-content (P6) and never receives them — which means a /v2
 * leaf and a canvas leaf over the same files hash differently, and they
 * should: the canvas run had a prompt and the /v2 event did not.
 */
export function hashRunInputs(p: RunInputs): string {
  // jcs-2. `canonicalize`, not `JSON.stringify`.
  //
  // `spec` embeds the whole ComfyUI graph, whose nodes are keyed by numbers.
  // V8 orders integer-like keys ascending; Python preserves insertion order.
  // Python escapes non-ASCII by default; V8 emits UTF-8. So the same document
  // hashed either side of the wire produced two digests, and a verifier
  // recomputing this in Python got a mismatch — which reads as tampering.
  //
  // The key ORDER of the wrapper below is now irrelevant, because the
  // canonicalizer sorts. It is left in its original order anyway so a reader
  // comparing against `hashRunInputsLegacy` sees one difference, not two.
  return sha256Hex(
    canonicalize({
      provider: p.provider,
      prompt: p.prompt,
      spec: p.spec,
      inputs: p.inputs.map((a) => ({ kind: a.kind, hash: a.hash })),
    }),
  );
}

/**
 * @deprecated Replay of `canonicalization_profile = 'jcs-1'` rows only.
 * Never for new evidence. Kept so a leaf written before 2026-09-03 can be
 * reproduced and read, rather than being declared unhashable — the same
 * reason `canonicalizeLegacy` exists.
 */
export function hashRunInputsLegacy(p: RunInputs): string {
  return sha256Hex(
    JSON.stringify({
      provider: p.provider,
      prompt: p.prompt,
      spec: p.spec,
      inputs: p.inputs.map((a) => ({ kind: a.kind, hash: a.hash })),
    }),
  );
}

/** A single model file's fingerprint, as the runner reports it. */
export type ModelFingerprint = Record<string, unknown>;

export interface ModelFingerprintsResult {
  /** The canonical JSON, persisted alongside the hash for audit. */
  json: string;
  hash: string;
}

/**
 * model_fingerprints_hash — binds the actual weights the run loaded.
 *
 * Preimage: JSON.stringify of the manifest with TOP-LEVEL keys sorted
 * ascending. Nested objects are NOT recursively sorted; see the header.
 *
 * Returns null for an absent or empty manifest so callers store NULL
 * rather than the hash of `{}`, which would assert "we enumerated the
 * weights and there were none".
 */
export function hashModelFingerprints(
  fingerprints: Record<string, ModelFingerprint> | null | undefined,
): ModelFingerprintsResult | null {
  if (!fingerprints || Object.keys(fingerprints).length === 0) return null;

  // jcs-2, and TWO corrections in one place.
  //
  // 1. `mtime` IS NOT A PROPERTY OF THE BYTES. It was inside this preimage —
  //    the runner reports the file's filesystem modification time and the
  //    whole record was hashed verbatim. Identical model weights on a
  //    different volume replica, or after a remount, therefore produced a
  //    DIFFERENT model_fingerprints_hash. One of the five headline hashes was
  //    not recomputable by anyone holding the model, which is the opposite of
  //    what it is for. `content_hash`, `header_hash` and `bytes` identify the
  //    file; the timestamp only says when this host happened to see it.
  //
  // 2. Only the TOP level was sorted and nesting was left in insertion order,
  //    so the per-file objects were engine-dependent in exactly the way
  //    `input_hash` was.
  //
  // The returned `json` is now the SAME BYTES that were hashed, so a caller
  // that persists it gives a verifier something that reproduces the digest.
  // It previously persisted one serialization and hashed another.
  const stripped: Record<string, unknown> = {};
  for (const k of Object.keys(fingerprints)) {
    const fp = fingerprints[k];
    const { mtime: _dropped, ...rest } = (fp ?? {}) as Record<string, unknown>;
    void _dropped;
    stripped[k] = rest;
  }
  const json = canonicalize(stripped);
  return { json, hash: sha256Hex(json) };
}

/**
 * @deprecated Replay of `canonicalization_profile = 'jcs-1'` rows only.
 * Top-level sort, nesting untouched, `mtime` included — what shipped before
 * 2026-09-03.
 */
export function hashModelFingerprintsLegacy(
  fingerprints: Record<string, ModelFingerprint> | null | undefined,
): ModelFingerprintsResult | null {
  if (!fingerprints || Object.keys(fingerprints).length === 0) return null;
  const sortedKeys = Object.keys(fingerprints).sort();
  const canonical: Record<string, unknown> = {};
  for (const k of sortedKeys) canonical[k] = fingerprints[k];
  const json = JSON.stringify(canonical);
  return { json, hash: sha256Hex(json) };
}

/**
 * workflow_hash — binds the graph that produced the output.
 *
 * Preimage: recursive key-sorted, whitespace-free JSON (see
 * lib/scruple/canonicalWorkflow.ts). Arrays keep their order because
 * ComfyUI wiring tuples are positional.
 *
 * On `kind=model_write` there is no graph; the training recipe plays the
 * same role and is hashed the same way. `kind` disambiguates which
 * document a verifier must re-canonicalize — the registry records this.
 */
export function hashGraphOrTraining(
  graph: unknown | undefined,
  training: unknown | undefined,
): string | null {
  const doc = graph ?? training;
  if (doc === undefined || doc === null) return null;
  return hashWorkflow(doc);
}

/**
 * The disagreement check `/api/v2/witness` performs for
 * `model_fingerprints` vs `model_fingerprints_hash`, generalised so the
 * same argument can be applied to `workflow_hash` without a second
 * implementation of it appearing in the route.
 *
 * WHY THIS EXISTS RATHER THAN A SECOND `if` IN THE ROUTE
 *
 * WO-20 §6.1 found the asymmetry: a component MACs `capture.workflow_hash`,
 * the route independently recomputes the same hash from `body.training` (or
 * `body.graph`), and NOTHING compares them. The route already refuses when
 * the fingerprint manifest and its supplied hash disagree, with the right
 * reason attached — "a caller that sent both is asserting they agree, and if
 * they do not, one of the two is wrong." The identical argument applies to
 * the workflow, with more force: the component's value is inside the MAC, so
 * a silent mismatch means the MAC authenticates a hash the leaf does not
 * carry, and the leaf carries a hash nothing authenticated.
 *
 * Both values may legitimately be ABSENT. A `/v2` submission is zero-content
 * and may send the hash alone, or the document alone, or neither; only when
 * both are present is agreement being asserted. `null` in either position is
 * therefore not a disagreement.
 */
export function hashDisagreement(
  computed: string | null | undefined,
  supplied: string | null | undefined,
): { computed: string; supplied: string } | null {
  if (!computed || !supplied) return null;
  if (computed === supplied) return null;
  return { computed, supplied };
}
