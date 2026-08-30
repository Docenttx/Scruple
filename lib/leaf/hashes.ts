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
// The other two formulas below are still in the language's own number
// formatter, and `model_fingerprints` in particular carries floats (a
// `mtime` per file). They are left alone because fixing them IS a scheme
// bump: unlike workflow_hash their shipped preimage is not canonical JSON
// under any spec, so a corrected version is a different hash for every leaf
// that exists. Recorded in docs/canon/CANONICALIZATION.md §7, not hidden.

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
