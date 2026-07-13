// Canonical serialization for ComfyUI workflow_api_json.
//
// The witness-side leaf preimage (v2.4+) folds `workflow_hash` in as a
// first-class field. That hash MUST be reproducible by any auditor with
// the same workflow JSON — which means we can't use default
// `JSON.stringify()` (key insertion order determines byte output and
// varies per client / per serializer).
//
// Rule: recursively sort object keys alphabetically; preserve array
// order (ComfyUI's node-registration order and wiring `[node_id, slot]`
// tuples are position-meaningful); no whitespace.
//
// This is the SAME algorithm used by lib/canvas/manifest.ts to
// canonicalize the machine manifest — kept as a separate module so
// callers don't need to import the manifest module just to hash a
// workflow.

import { createHash } from 'node:crypto';

/**
 * Canonicalize any JSON-serializable value with stable, recursive key
 * ordering. Arrays preserve order.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalize).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return (
    '{' +
    keys
      .map((k) => JSON.stringify(k) + ':' + canonicalize(obj[k]))
      .join(',') +
    '}'
  );
}

/**
 * SHA-256 hex of the canonical serialization of a ComfyUI workflow_api_json.
 * Returns 64 lowercase hex chars, no `sha256:` prefix.
 */
export function hashWorkflow(workflowApiJson: unknown): string {
  return createHash('sha256').update(canonicalize(workflowApiJson), 'utf8').digest('hex');
}
