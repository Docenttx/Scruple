// Types for lib/leaf/generate.mjs.
//
// The emitter is plain .mjs on purpose — it must stay outside the app's
// build graph, and a Python sibling emitter has to be able to exist
// without either of them knowing about the other. That leaves the
// drift-guard test importing an untyped module, so the shape is declared
// here rather than silenced with `any` at each call site.

/** The parsed registry.yaml. Deliberately loose: the YAML is the
 *  contract, and duplicating its full shape in TypeScript would create
 *  the second source of truth the registry exists to prevent. */
export interface LeafRegistryDocument {
  schema_version: number;
  surfaces: Record<string, { brief: string; emitted_by: string[] }>;
  leaf_schemes: Record<string, { brief?: string; record_order: string[] }>;
  groups: Array<{
    id: string;
    type: string;
    brief: string;
    attributes: Array<Record<string, unknown>>;
  }>;
}

/** Parse and validate. Throws on any malformed entry — a bad registry
 *  must fail here, not emit a plausible-looking TypeScript file. */
export function loadRegistry(file?: string): LeafRegistryDocument;

/** The exact contents lib/leaf/registry.generated.ts should have. */
export function render(file?: string): string;
