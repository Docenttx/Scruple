// Drift guard: the leaf-field registry vs. the code that emits leaves.
//
// WHY IT PARSES SOURCE INSTEAD OF READING THE REGISTRY TWICE
//
// Modelled on services/c2pa-signer/tests/test_assertion_contract.py,
// which reads the label literals out of signAsset.ts rather than out of
// the contract file. That choice is the entire value of the test: if
// someone hardcodes a field back into an emitter and bypasses the shared
// definition, the definition still looks perfectly consistent with
// itself, and only a test that reads the EMITTER notices.
//
// The precedent it exists for: `services/witness-server/server.js:661`
// returns `signer_surrogate` while `:234-236,626` write the column
// `leaf_signer_surrogate`. Nothing failed. Nothing could have — the two
// names live in one file, forty lines apart, and TypeScript on the
// client side has an index signature that swallows either. The registry
// now declares both and resolves one to the other; this file is what
// stops them moving apart again.
//
// Five emitting sites are parsed:
//   1. the witness server's request destructuring   → submit surface
//   2. canonicalRecord / canonicalRecordV22         → record surface
//   3. the witness server's 200 response            → response surface
//   4. INSERT INTO witnesses                        → storage surface
//   5. /api/v2/witness's witness.witnessIteration() → submit surface
//
// plus a check that the generated TypeScript still matches the YAML.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  LEAF_FIELDS,
  LEAF_SCHEMES,
  fieldsOn,
  nameOn,
  resolveField,
  type LeafSurface,
} from '../../lib/leaf';

const REPO = path.resolve(__dirname, '..', '..');
const SERVER_JS = path.join(REPO, 'services', 'witness-server', 'server.js');
const V2_ROUTE = path.join(REPO, 'app', 'api', 'v2', 'witness', 'route.ts');
const REGISTRY_YAML = path.join(REPO, 'lib', 'leaf', 'registry.yaml');
const GENERATED_TS = path.join(REPO, 'lib', 'leaf', 'registry.generated.ts');

const read = (f: string) => fs.readFileSync(f, 'utf8');

/** Comments carry field names too, and they are not emissions. */
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** Identifier keys of an object-literal / destructuring body. */
function keysOf(body: string): string[] {
  return stripComments(body)
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => /^([A-Za-z_$][A-Za-z0-9_$]*)/.exec(part)?.[1])
    .filter((k): k is string => Boolean(k));
}

function section(src: string, startRe: RegExp, endRe: RegExp, what: string): string {
  const start = startRe.exec(src);
  assert.ok(start, `${what}: opening not found — the emitter moved, fix this parser`);
  const rest = src.slice(start.index + start[0].length);
  const end = endRe.exec(rest);
  assert.ok(end, `${what}: closing not found — the emitter moved, fix this parser`);
  return rest.slice(0, end.index);
}

// ── 1. submit surface — what the witness server accepts ────────────────
function submitFieldsFromServer(): string[] {
  const src = read(SERVER_JS);
  const body = section(
    src,
    /async function handleWitness\(req, res\) \{\s*const data = await readBody\(req\);\s*const \{/,
    /\}\s*=\s*data;/,
    'handleWitness destructuring',
  );
  return keysOf(body);
}

// ── 2. record surface — the preimage, in order ─────────────────────────
function recordOrderFromServer(fn: 'canonicalRecord' | 'canonicalRecordV22'): string[] {
  const src = read(SERVER_JS);
  const body = section(
    src,
    new RegExp(`function ${fn}\\(rec\\) \\{[\\s\\S]*?const ordered = \\{`),
    /\n {2}\};/,
    fn,
  );
  return [...stripComments(body).matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/gm)].map((m) => m[1]);
}

// ── 3. response surface — the 200 body ─────────────────────────────────
function responseFieldsFromServer(): string[] {
  const src = read(SERVER_JS);
  const handler = section(
    src,
    /async function handleWitness\(req, res\) \{/,
    /\n\}\n/,
    'handleWitness body',
  );
  const body = section(handler, /send\(res, 200, \{/, /\n {2}\}\);/, 'witness 200 response');
  return keysOf(body);
}

// ── 4. storage surface — the columns actually written ──────────────────
function storageColumnsFromServer(): string[] {
  const src = read(SERVER_JS);
  const body = section(
    src,
    /INSERT OR IGNORE INTO witnesses\s*\(/,
    /\)\s*\n\s*VALUES/,
    'INSERT INTO witnesses',
  );
  return keysOf(body);
}

// ── 5. the /v2 route's contribution to the submit surface ──────────────
const snake = (s: string) => s.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());

function submitFieldsFromV2Route(): string[] {
  const src = read(V2_ROUTE);
  const body = section(
    src,
    /await witness\.witnessIteration\(\{/,
    /\n {6}\}\);/,
    'witness.witnessIteration call',
  );
  return keysOf(body).map(snake);
}

function requiredOn(surface: LeafSurface): string[] {
  return fieldsOn(surface)
    .filter((f) => f.requirement_level === 'required')
    .map((f) => nameOn(f, surface));
}

/** Assert every emitted name is declared, naming the offender loudly. */
function assertAllDeclared(emitted: string[], surface: LeafSurface, where: string) {
  for (const name of emitted) {
    const field = resolveField(name, surface);
    assert.ok(
      field,
      `${where} emits '${name}', which lib/leaf/registry.yaml does not define. ` +
        `Add it to the registry (with its type, requirement_level and the leaf ` +
        `scheme it appeared in) and run \`npm run gen:leaf-registry\`. If it is a ` +
        `new spelling of an existing field, add it to the deprecated group with ` +
        `deprecated.renamed_to instead of defining it twice.`,
    );
    assert.ok(
      field.surfaces.includes(surface),
      `${where} emits '${name}' on the '${surface}' surface, but the registry ` +
        `lists '${field.id}' only on [${field.surfaces.join(', ')}].`,
    );
  }
}

function assertNoneMissing(emitted: string[], surface: LeafSurface, where: string) {
  for (const name of requiredOn(surface)) {
    assert.ok(
      emitted.includes(name),
      `'${name}' is required on the '${surface}' surface but ${where} does not ` +
        `emit it. Either emit it or change its requirement_level — a required ` +
        `field nobody sends is a claim the registry is making on our behalf.`,
    );
  }
}

describe('the registry defines every field the emitters emit', () => {
  test('submit — the witness server accepts nothing undeclared', () => {
    const emitted = submitFieldsFromServer();
    assert.ok(emitted.length >= 8, `parser found only ${emitted.length} fields`);
    assertAllDeclared(emitted, 'submit', 'services/witness-server/server.js handleWitness');
    assertNoneMissing(emitted, 'submit', 'handleWitness');
  });

  test('response — the witness server returns nothing undeclared', () => {
    const emitted = responseFieldsFromServer();
    assert.ok(emitted.length >= 6, `parser found only ${emitted.length} fields`);
    assertAllDeclared(emitted, 'response', 'services/witness-server/server.js send(res, 200)');
    assertNoneMissing(emitted, 'response', 'the witness 200 response');
  });

  test('storage — every written column is declared, under its storage name', () => {
    const columns = storageColumnsFromServer();
    assert.ok(columns.length >= 15, `parser found only ${columns.length} columns`);
    assertAllDeclared(columns, 'storage', 'INSERT OR IGNORE INTO witnesses');
    assertNoneMissing(columns, 'storage', 'INSERT OR IGNORE INTO witnesses');
  });

  test('/api/v2/witness emits nothing undeclared, and drops nothing required', () => {
    const emitted = submitFieldsFromV2Route();
    assertAllDeclared(emitted, 'submit', 'app/api/v2/witness/route.ts');
    // Both directions. The first draft of this file checked only the
    // first, and deleting `contentHash: body.content_hash` from the
    // route left the suite green — which is the same class of miss as
    // the bug the WO was written for.
    assertNoneMissing(emitted, 'submit', 'app/api/v2/witness/route.ts');
  });
});

describe('the preimage order is the protocol, so it is asserted exactly', () => {
  test('canonicalRecord matches leaf scheme v2', () => {
    assert.deepEqual(recordOrderFromServer('canonicalRecord'), [...LEAF_SCHEMES['v2']]);
  });

  test('canonicalRecordV22 matches leaf scheme v2.2', () => {
    assert.deepEqual(recordOrderFromServer('canonicalRecordV22'), [...LEAF_SCHEMES['v2.2']]);
  });

  test('v2.2 differs from v2 by exactly the manifest hash, in one place', () => {
    const v2 = [...LEAF_SCHEMES['v2']];
    const v22 = [...LEAF_SCHEMES['v2.2']];
    assert.deepEqual(v22.filter((f) => f !== 'machine_manifest_hash'), v2);
  });
});

describe('WO-1 · the three dropped hashes, guarded at the emitter', () => {
  // The bug, stated as a test. `workflowHash: body.graph ? undefined :
  // undefined` type-checked, passed review, and shipped a route that
  // accepted a graph and discarded it. Nothing but reading this exact
  // call site catches its return.
  const MUST_EMIT = ['input_hash', 'workflow_hash', 'model_fingerprints_hash'];

  test('the /v2 route sends all three to the witness', () => {
    const emitted = submitFieldsFromV2Route();
    for (const f of MUST_EMIT) {
      assert.ok(
        emitted.includes(f),
        `app/api/v2/witness/route.ts no longer sends ${f}. The legacy canvas ` +
          `path carries it, so dropping it here makes the replacement worse ` +
          `evidence than the thing it replaces.`,
      );
    }
  });

  test('the discard stub has not come back', () => {
    // Comments stripped first — the route's own header quotes the bug,
    // and a guard that trips on its own explanation is a guard nobody
    // will keep.
    const src = stripComments(read(V2_ROUTE));
    assert.doesNotMatch(
      src,
      /\?\s*undefined\s*:\s*undefined/,
      'a `cond ? undefined : undefined` stub is back in the witness route — ' +
        'that is the shape the original bug took: a field accepted, then thrown away.',
    );
  });

  test('the route uses the shared preimage functions, not its own', () => {
    const src = read(V2_ROUTE);
    assert.match(
      src,
      /from '@\/lib\/leaf\/hashes'/,
      'the route must import the preimage functions rather than recompute them — ' +
        'two implementations of a preimage are two preimages.',
    );
  });

  test('run_sequence is not hardcoded on the witness call', () => {
    const body = section(
      read(V2_ROUTE),
      /await witness\.witnessIteration\(\{/,
      /\n {6}\}\);/,
      'witness.witnessIteration call',
    );
    assert.doesNotMatch(
      body,
      /runSequence:\s*\d/,
      'runSequence is a literal again. The witness chains prev_record_hash by ' +
        'run_sequence, so a constant means the second leaf cannot be ordered ' +
        'against the first — and the first call always succeeds, so only the ' +
        'second reveals it.',
    );
  });
});

describe('the recorded rename, in both directions', () => {
  test('the storage spelling resolves to the wire field', () => {
    const f = resolveField('leaf_signer_surrogate');
    assert.equal(f?.id, 'signer_surrogate');
  });

  test('the wire spelling resolves to itself', () => {
    assert.equal(resolveField('signer_surrogate')?.id, 'signer_surrogate');
  });

  test('the field declares the storage alias the column actually uses', () => {
    const f = resolveField('signer_surrogate');
    assert.equal(f?.aliases.storage, 'leaf_signer_surrogate');
    assert.ok(storageColumnsFromServer().includes('leaf_signer_surrogate'));
    assert.ok(responseFieldsFromServer().includes('signer_surrogate'));
  });

  test('content_hash and output_hash are recorded as one field, not two', () => {
    // The second, quieter rename: the wire says content_hash, and the
    // preimage and the column say output_hash. Found while writing the
    // registry, not while debugging — which is the point of writing one.
    assert.equal(resolveField('content_hash')?.id, 'output_hash');
    assert.ok(submitFieldsFromServer().includes('content_hash'));
    assert.ok(recordOrderFromServer('canonicalRecord').includes('output_hash'));
  });

  test('every deprecated name points at a field that exists', () => {
    const ids = new Set(LEAF_FIELDS.map((f) => f.id));
    for (const f of LEAF_FIELDS) {
      if (!f.deprecated?.renamed_to) continue;
      assert.ok(ids.has(f.deprecated.renamed_to), `${f.id} → ${f.deprecated.renamed_to}`);
      assert.equal(f.surfaces.length, 0, `${f.id} is deprecated but claims a live surface`);
    }
  });
});

describe('the generated types cannot rot', () => {
  test('registry.generated.ts is what the YAML currently produces', async () => {
    const { render } = await import('../../lib/leaf/generate.mjs');
    assert.equal(
      render(REGISTRY_YAML),
      read(GENERATED_TS),
      'lib/leaf/registry.generated.ts is stale. Run `npm run gen:leaf-registry`.',
    );
  });

  test('the registry refuses to load if it is malformed', async () => {
    const { loadRegistry } = await import('../../lib/leaf/generate.mjs');
    const tmp = path.join(
      fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'leafreg-')),
      'bad.yaml',
    );
    fs.writeFileSync(
      tmp,
      read(REGISTRY_YAML).replace('requirement_level: required', 'requirement_level: whenever'),
    );
    assert.throws(() => loadRegistry(tmp), /bad requirement_level/);
  });

  test('every field names the leaf scheme it appeared in', () => {
    for (const f of LEAF_FIELDS) {
      assert.match(f.introduced_in, /^v[0-9.]+$/, `${f.id} has no introduced_in`);
    }
  });
});
