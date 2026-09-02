// The job form, DERIVED FROM THE WHITELIST — WO-30.
//
// ---------------------------------------------------------------------------
// WHY THE FORM IS GENERATED AND NOT WRITTEN
// ---------------------------------------------------------------------------
//
// `docs/canon/demo-readiness/training.md` §6 item 2: "The job API has no
// caller — the single smallest missing piece of product on the only path that
// reaches `server-library`." This module is half of closing that, and the half
// that decides whether closing it is safe.
//
// A hand-written form is a SECOND enumeration of the tenant's expressive power.
// `job-spec.ts`'s header says the whitelist IS the deliverable, and
// `PLACEMENT_AND_SURFACES.md` §7.3 says one "advanced: paste your own args" box
// is a second configuration with a different tier hiding inside the first. A
// form typed out by hand is exactly how that box gets added: someone adds a
// field to the UI, the validator refuses it, and the obvious next commit is to
// add it to the validator. Generating the form from `PARAMETER_WHITELIST` means
// the UI cannot offer a control the validator does not already accept, and a
// control that is not derivable from a closed domain cannot be rendered at all
// — there is no `kind: 'string'` to render, because there is no such kind.
//
// ---------------------------------------------------------------------------
// AND WHY IT IS A SEPARATE MODULE FROM job-spec.ts
// ---------------------------------------------------------------------------
//
// `job-spec.ts` imports `node:crypto` for `jobSpecHash`, so it cannot be pulled
// into a browser bundle. The descriptors below are plain JSON — a `RegExp`
// becomes its `source` string, nothing else changes — so a server component can
// compute them once and hand them to a client component as props. The whitelist
// stays on the server; only its SHAPE crosses.

import {
  PARAMETER_WHITELIST,
  type ParameterKind,
  type ParameterSpec,
  type ValueSource,
} from './job-spec';

/** One control, in a form a React client component can serialise. */
export interface JobFieldDescriptor {
  name: string;
  kind: ParameterKind;
  valueSource: ValueSource;
  choices?: (string | number)[];
  min?: number;
  max?: number;
  /** `RegExp.source`, not the RegExp — props must be JSON. */
  pattern?: string;
  maxLength?: number;
  required: boolean;
  /** The whitelist's own justification, shown as the field's help text.
   *  A tenant reading "this flag is an import path, so you pick a key and we
   *  supply the value" learns why the product is shaped this way. */
  why: string;
}

function describe(p: ParameterSpec): JobFieldDescriptor {
  return {
    name: p.name,
    kind: p.kind,
    valueSource: p.valueSource,
    ...(p.choices ? { choices: [...p.choices] } : {}),
    ...(p.min !== undefined ? { min: p.min } : {}),
    ...(p.max !== undefined ? { max: p.max } : {}),
    ...(p.pattern ? { pattern: p.pattern.source } : {}),
    ...(p.maxLength !== undefined ? { maxLength: p.maxLength } : {}),
    required: Boolean(p.required),
    why: p.why,
  };
}

/**
 * Every field the job API accepts, required ones first.
 *
 * The ORDER is the only editorial decision in this file, and it is not a
 * filter: every whitelisted parameter appears, because a parameter the form
 * omits is one a tenant can only reach by hand-writing a request, which is the
 * behaviour a product surface exists to remove.
 */
export function describeJobForm(
  whitelist: readonly ParameterSpec[] = PARAMETER_WHITELIST,
): JobFieldDescriptor[] {
  const fields = whitelist.map(describe);
  return [
    ...fields.filter((f) => f.required),
    ...fields.filter((f) => !f.required),
  ];
}

/**
 * A starting job that validates.
 *
 * Every value is taken from the parameter's OWN domain — the first enum
 * choice, the minimum of a bounded number — rather than from a table of
 * remembered good values, so a default cannot drift out of range when a bound
 * moves. The four required fields have no domain to draw from (`dataset_id` is
 * a catalog id the tenant must supply), so they are left empty and the form
 * refuses to submit until they are filled.
 */
export function defaultJobValues(
  whitelist: readonly ParameterSpec[] = PARAMETER_WHITELIST,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const p of whitelist) {
    if (p.required) continue;
    if (p.kind === 'boolean') continue; // absent means "not set", which is not false-by-default
    if (p.kind === 'enum' && p.choices?.length) out[p.name] = p.choices[0];
  }
  return out;
}
