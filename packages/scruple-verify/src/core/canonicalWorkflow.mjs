// COPY of lib/scruple/canonicalWorkflow.ts — canonical workflow_api_json
// serialization used for the workflow_hash first-class leaf field (v2.4+).
// Kept in the verifier package so third parties can re-derive workflow_hash
// from raw workflow JSON without depending on the main app repo.

import { createHash } from 'node:crypto';

export function canonicalize(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalize).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
}

export function hashWorkflow(workflowApiJson) {
  return createHash('sha256').update(canonicalize(workflowApiJson), 'utf8').digest('hex');
}
