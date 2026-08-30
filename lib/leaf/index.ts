// The leaf-field registry, as code.
//
// The data comes from lib/leaf/registry.yaml via lib/leaf/generate.mjs.
// This file adds only lookups — nothing here may encode a fact about a
// field that the YAML does not already state, or the registry stops
// being the source of truth and becomes a second one.

import {
  LEAF_FIELDS,
  LEAF_SCHEMES,
  LEAF_SURFACE_EMITTERS,
  type LeafField,
  type LeafRequirementLevel,
  type LeafStability,
  type LeafSurface,
  type LeafFieldId,
} from './registry.generated';

export {
  LEAF_FIELDS,
  LEAF_SCHEMES,
  LEAF_SURFACE_EMITTERS,
  type LeafField,
  type LeafRequirementLevel,
  type LeafStability,
  type LeafSurface,
  type LeafFieldId,
};

export * from './hashes';

const BY_ID = new Map<string, LeafField>(LEAF_FIELDS.map((f) => [f.id, f]));

/** Live (non-deprecated) fields carried on a surface. */
export function fieldsOn(surface: LeafSurface): LeafField[] {
  return LEAF_FIELDS.filter((f) => !f.deprecated && f.surfaces.includes(surface));
}

/** The name a field goes by on one surface — its alias, or its id. */
export function nameOn(field: LeafField, surface: LeafSurface): string {
  return field.aliases[surface] ?? field.id;
}

/**
 * Resolve any name — live id, surface alias, or a deprecated spelling —
 * to the live field it denotes.
 *
 * This is the function that exists because `signer_surrogate` and
 * `leaf_signer_surrogate` are the same value, and because `content_hash`
 * and `output_hash` are too. Anyone holding one of the four names can
 * get to the field without knowing which of the four they hold.
 */
export function resolveField(
  name: string,
  surface?: LeafSurface,
): LeafField | undefined {
  const direct = BY_ID.get(name);
  if (direct && !direct.deprecated) return direct;
  if (direct?.deprecated?.renamed_to) return BY_ID.get(direct.deprecated.renamed_to);
  if (surface) {
    const byAlias = LEAF_FIELDS.find(
      (f) => !f.deprecated && f.aliases[surface] === name,
    );
    if (byAlias) return byAlias;
  }
  const anyAlias = LEAF_FIELDS.find(
    (f) => !f.deprecated && Object.values(f.aliases).includes(name),
  );
  return anyAlias;
}

/** The preimage field order for a leaf scheme. Empty for v1, which has none. */
export function recordOrder(scheme: string): readonly string[] {
  const order = LEAF_SCHEMES[scheme];
  if (!order) throw new Error(`unknown leaf_scheme: ${scheme}`);
  return order;
}

/** Which scheme a submitted event produces — presence of the manifest hash decides. */
export function schemeFor(machineManifestHash: string | null | undefined): 'v2' | 'v2.2' {
  return machineManifestHash ? 'v2.2' : 'v2';
}
