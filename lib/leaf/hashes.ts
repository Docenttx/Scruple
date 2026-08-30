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

import { sha256Hex } from '@/lib/scruple/hash';
import { canonicalize, hashWorkflow } from '@/lib/scruple/canonicalWorkflow';

export { canonicalize, hashWorkflow };

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
