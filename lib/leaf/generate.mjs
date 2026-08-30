#!/usr/bin/env node
// Emitter: lib/leaf/registry.yaml → lib/leaf/registry.generated.ts
//
// Run with `npm run gen:leaf-registry`. The drift guard
// (test/v2/leaf-registry.test.ts) regenerates in a temp file and fails
// if the committed output differs, so the generated file cannot rot.
//
// Deliberately plain .mjs: tsconfig sets allowJs:false and includes only
// **/*.ts, so this file is outside the typechecker and cannot become a
// build dependency of the app.
//
// THE PYTHON EMITTER (WO-3's neighbour) HOOKS IN HERE — meaning: not
// here at all. It reads the same registry.yaml with yaml.safe_load and
// walks the same `groups[].attributes[]` shape, writing dataclasses into
// packages/scruple-host-sdk/. It must not import anything from this file
// and this file must not learn anything about Python. One definition,
// two emitters, no shared code between the emitters — that is the whole
// point of the definition being YAML rather than either language.

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, 'registry.yaml');
const OUT = path.join(HERE, 'registry.generated.ts');

const VALID_SURFACES = ['submit', 'record', 'response', 'storage'];
const VALID_LEVELS = ['required', 'conditionally_required', 'recommended', 'opt_in'];
const VALID_STABILITY = ['stable', 'development'];

/** Read + validate the registry. Well-formedness is enforced here, the
 *  way semconv enforces its own shape with Rego before anything
 *  consumes it — a malformed registry must fail loudly at generation,
 *  not produce a plausible-looking TypeScript file. */
export function loadRegistry(file = SRC) {
  const doc = yaml.load(fs.readFileSync(file, 'utf8'));
  if (!doc || typeof doc !== 'object') throw new Error('registry.yaml is not a mapping');
  if (doc.schema_version !== 1) throw new Error(`unsupported schema_version ${doc.schema_version}`);

  const seen = new Map();
  for (const group of doc.groups) {
    for (const a of group.attributes) {
      if (seen.has(a.id)) throw new Error(`duplicate attribute id: ${a.id}`);
      seen.set(a.id, a);
      if (!VALID_LEVELS.includes(a.requirement_level))
        throw new Error(`${a.id}: bad requirement_level ${a.requirement_level}`);
      if (!VALID_STABILITY.includes(a.stability))
        throw new Error(`${a.id}: bad stability ${a.stability}`);
      if (!Array.isArray(a.surfaces)) throw new Error(`${a.id}: surfaces must be a list`);
      for (const s of a.surfaces)
        if (!VALID_SURFACES.includes(s)) throw new Error(`${a.id}: unknown surface ${s}`);
      for (const s of Object.keys(a.aliases ?? {}))
        if (!a.surfaces.includes(s))
          throw new Error(`${a.id}: alias for surface ${s} it does not declare`);
      if (a.requirement_level === 'conditionally_required' && !a.condition)
        throw new Error(`${a.id}: conditionally_required needs a condition`);
      if (a.deprecated) {
        if (a.deprecated.reason === 'renamed' && !a.deprecated.renamed_to)
          throw new Error(`${a.id}: renamed without renamed_to`);
        if (a.surfaces.length)
          throw new Error(`${a.id}: a deprecated name must not claim a live surface`);
      }
    }
  }
  // Every rename target must exist, or the pointer is worse than nothing.
  for (const [, a] of seen) {
    const to = a.deprecated?.renamed_to;
    if (to && !seen.has(to)) throw new Error(`${a.id}: renamed_to ${to} is not defined`);
  }
  // Every field named in a scheme's record_order must declare `record`.
  for (const [scheme, def] of Object.entries(doc.leaf_schemes)) {
    for (const f of def.record_order) {
      const a = seen.get(f);
      if (!a) throw new Error(`leaf_scheme ${scheme}: unknown field ${f}`);
      if (!a.surfaces.includes('record'))
        throw new Error(`leaf_scheme ${scheme}: ${f} is in record_order but not on the record surface`);
    }
  }
  return doc;
}

function emit(doc) {
  const attrs = doc.groups.flatMap((g) =>
    g.attributes.map((a) => ({ ...a, group: g.id })),
  );
  const lines = [];
  lines.push('// GENERATED FILE — DO NOT EDIT.');
  lines.push('// Source: lib/leaf/registry.yaml · Emitter: lib/leaf/generate.mjs');
  lines.push('// Regenerate with `npm run gen:leaf-registry`.');
  lines.push('// test/v2/leaf-registry.test.ts fails if this file and the YAML disagree.');
  lines.push('');
  lines.push("export type LeafSurface = " + VALID_SURFACES.map((s) => `'${s}'`).join(' | ') + ';');
  lines.push("export type LeafRequirementLevel = " + VALID_LEVELS.map((s) => `'${s}'`).join(' | ') + ';');
  lines.push("export type LeafStability = " + VALID_STABILITY.map((s) => `'${s}'`).join(' | ') + ';');
  lines.push('');
  lines.push('export interface LeafFieldDeprecation {');
  lines.push('  reason: string;');
  lines.push('  renamed_to?: string;');
  lines.push('  note?: string;');
  lines.push('}');
  lines.push('');
  lines.push('export interface LeafField {');
  lines.push('  id: string;');
  lines.push('  group: string;');
  lines.push('  type: string;');
  lines.push('  stability: LeafStability;');
  lines.push('  requirement_level: LeafRequirementLevel;');
  lines.push('  condition?: string;');
  lines.push('  /** Leaf scheme version in which the field first appeared. */');
  lines.push('  introduced_in: string;');
  lines.push('  surfaces: LeafSurface[];');
  lines.push('  /** Surface-specific spelling, where it differs from `id`. */');
  lines.push('  aliases: Partial<Record<LeafSurface, string>>;');
  lines.push('  deprecated?: LeafFieldDeprecation;');
  lines.push('  brief: string;');
  lines.push('  preimage?: string;');
  lines.push('}');
  lines.push('');
  lines.push('/** Field ids, as a union — so a typo in a lookup is a compile error. */');
  lines.push(
    'export type LeafFieldId =\n' +
      attrs.map((a) => `  | '${a.id}'`).join('\n') +
      ';',
  );
  lines.push('');
  lines.push('export const LEAF_FIELDS: readonly LeafField[] = [');
  for (const a of attrs) {
    lines.push('  {');
    lines.push(`    id: ${JSON.stringify(a.id)},`);
    lines.push(`    group: ${JSON.stringify(a.group)},`);
    lines.push(`    type: ${JSON.stringify(a.type)},`);
    lines.push(`    stability: ${JSON.stringify(a.stability)},`);
    lines.push(`    requirement_level: ${JSON.stringify(a.requirement_level)},`);
    if (a.condition) lines.push(`    condition: ${JSON.stringify(a.condition.trim())},`);
    lines.push(`    introduced_in: ${JSON.stringify(String(a.introduced_in))},`);
    lines.push(`    surfaces: ${JSON.stringify(a.surfaces)},`);
    lines.push(`    aliases: ${JSON.stringify(a.aliases ?? {})},`);
    if (a.deprecated) {
      const d = { reason: a.deprecated.reason };
      if (a.deprecated.renamed_to) d.renamed_to = a.deprecated.renamed_to;
      if (a.deprecated.note) d.note = a.deprecated.note.trim();
      lines.push(`    deprecated: ${JSON.stringify(d)},`);
    }
    lines.push(`    brief: ${JSON.stringify(a.brief.trim())},`);
    if (a.preimage) lines.push(`    preimage: ${JSON.stringify(a.preimage.trim())},`);
    lines.push('  },');
  }
  lines.push('] as const;');
  lines.push('');
  lines.push('/** Preimage field order per leaf scheme. Order IS the protocol. */');
  lines.push('export const LEAF_SCHEMES: Readonly<Record<string, readonly string[]>> = {');
  for (const [scheme, def] of Object.entries(doc.leaf_schemes)) {
    lines.push(`  ${JSON.stringify(scheme)}: ${JSON.stringify(def.record_order)},`);
  }
  lines.push('};');
  lines.push('');
  lines.push('/** Source files the drift guard reads for each surface. */');
  lines.push('export const LEAF_SURFACE_EMITTERS: Readonly<Record<string, readonly string[]>> = {');
  for (const [s, def] of Object.entries(doc.surfaces)) {
    lines.push(`  ${JSON.stringify(s)}: ${JSON.stringify(def.emitted_by)},`);
  }
  lines.push('};');
  lines.push('');
  return lines.join('\n');
}

export function render(file = SRC) {
  return emit(loadRegistry(file));
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const out = render();
  fs.writeFileSync(OUT, out, 'utf8');
  console.log(`[leaf-registry] wrote ${path.relative(process.cwd(), OUT)} (${out.length} bytes)`);
}
