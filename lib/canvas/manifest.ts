// Machine manifest — canonicalization + hashing.
//
// A "machine manifest" is the pinned set of custom-node packs that
// will be baked into a Modal ComfyUI image. The manifest_hash is
// sha256 of the canonicalized JSON; it becomes part of the v2.2 leaf
// preimage so the artist's choice of toolchain is bound into every
// iteration's provenance.
//
// Canonicalization rule: stable object-key ordering. Arrays preserve
// declaration order (pack order is meaningful — it affects ComfyUI's
// node-registration order in edge cases).
//
// See docs/architecture/canvas-v2.md decisions 3 & 5.

import { createHash } from 'node:crypto';

export interface ManifestPack {
  /** Stable short name; lowercase kebab-case. */
  pack: string;
  /** GitHub repo "owner/name". */
  repo: string;
  /** Git ref to clone — tag name or branch name. */
  ref: string;
  /** Resolved commit sha (40 hex). null until the build worker resolves it. */
  commit_sha: string | null;
}

export interface MachineManifest {
  /** ComfyUI version tag, e.g. "v0.18.5". */
  comfyui_version: string;
  /** Pinned custom-node packs in registration order. */
  custom_nodes: ManifestPack[];
}

/**
 * Canonicalize a JSON-serializable value with stable, recursive key
 * ordering. Arrays preserve order. Numbers stringified per JSON.stringify
 * (no NaN / Infinity allowed).
 */
function canonicalize(value: unknown): string {
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
 * Canonical JSON form of a manifest. Idempotent: feeding the output
 * back through canonicalize() returns the same bytes.
 */
export function canonicalizeManifest(m: MachineManifest): string {
  return canonicalize(m);
}

/**
 * sha256 hex of the canonical manifest. This is the value committed to
 * the v2.2 leaf preimage and stored as `machines.manifest_hash`.
 */
export function hashManifest(m: MachineManifest): string {
  return createHash('sha256').update(canonicalizeManifest(m), 'utf8').digest('hex');
}
