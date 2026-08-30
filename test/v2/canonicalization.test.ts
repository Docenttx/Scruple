// WO-21 — `workflow_hash` is reproducible in a second language, or it is not
// evidence.
//
// WHAT THIS FILE IS FOR
//
// WO-20 found that `canonicalize()` delegated number formatting to the host
// language, so a learning rate of `1e-5` canonicalizes to `0.00001` under
// JavaScript and `1e-05` under Python. Two conforming implementations
// therefore compute different `workflow_hash` values for one document, every
// leaf written by one fails verification against the other, and the failure is
// byte-for-byte indistinguishable from a tampered file.
//
// The fix is RFC 8785 (JSON Canonicalization Scheme) in
// `lib/leaf/canonicalJson.ts`, and the four things that have to be true for it
// to count are each a describe() block below:
//
//   1. THE DIVERGENCE IS GONE. The vectors in
//      test/vectors/canonicalization-vectors.json are emitted here and
//      reproduced by packages/scruple-host-sdk/tests/test_canonicalization.py.
//      Inputs are raw JSON *text*, parsed by each language's own parser,
//      because that is the actual field condition — an auditor holds a file.
//
//   2. EXISTING LEAVES STILL VERIFY. `legacy_leaves` carries hashes captured
//      from the PRE-WO-21 implementation (`git show
//      257b942:lib/scruple/canonicalWorkflow.ts`) for real shipped documents,
//      including a witnessed row out of data/scruple.db. Adopting the RFC
//      changed zero bytes for them, which is the entire argument for why this
//      was not a leaf-scheme bump.
//
//   3. THE PATHOLOGICAL CASES ARE REFUSED, NOT ANSWERED. The old code hashed
//      NaN as `null`, `undefined` as the literal text `undefined`, and a Date
//      as `{}`. All three produced a hash that committed to something other
//      than the document.
//
//   4. THE FIX IS NOT VACUOUS. `canonicalizeLegacy()` is the old algorithm,
//      kept for replay, and the tests that matter assert the NEW code disagrees
//      with it exactly where it should and agrees everywhere else.
//
// TEST ISOLATION follows test/v2/component-auth.test.ts: `npm run test:v2`
// runs every file concurrently against one shared SCRUPLE_DB_PATH, so this
// file takes a private database assigned at module top level and imports
// dynamically inside before(). Nothing here touches the database — but
// `lib/leaf/hashes` pulls in the leaf module graph, and a file that is one
// import away from `lib/db/sqlite` today is one refactor away from it
// tomorrow.

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

if (!process.env.SCRUPLE_DB_PATH || !/tmp|test/i.test(process.env.SCRUPLE_DB_PATH)) {
  throw new Error('Refusing to run: set SCRUPLE_DB_PATH to a throwaway path. Use `npm run test:v2`.');
}
const OWN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'scruple-canon-'));
process.env.SCRUPLE_DB_PATH = path.join(OWN_DIR, 'canonicalization.db');
// The standing rule: never the production witness on 127.0.0.1:5799.
process.env.WITNESS_SERVER_URL = 'http://127.0.0.1:1';

const VECTORS = path.join(process.cwd(), 'test', 'vectors', 'canonicalization-vectors.json');

interface Vec {
  name: string;
  why: string;
  json: string;
  canonical?: string;
  sha256?: string;
  js_refuses?: string;
  python_refuses?: string;
}
interface LegacyLeaf {
  name: string;
  provenance: string;
  /** Absent means legacy-1 / jcs-1 (the two are byte-identical here). */
  profile?: string;
  note: string;
  json?: string;
  file?: string;
  legacy_sha256: string;
}
interface VectorFile {
  profile: string;
  cases: Vec[];
  non_json_refusals: { name: string; reason: string; legacy: string }[];
  legacy_leaves: LegacyLeaf[];
}

type Mod = {
  canonicalize: typeof import('../../lib/leaf/canonicalJson').canonicalize;
  hashWorkflow: typeof import('../../lib/leaf/canonicalJson').hashWorkflow;
  canonicalizeLegacy: typeof import('../../lib/leaf/canonicalJson').canonicalizeLegacy;
  hashWorkflowLegacy: typeof import('../../lib/leaf/canonicalJson').hashWorkflowLegacy;
  hashWorkflowInsertionOrder: typeof import('../../lib/leaf/canonicalJson').hashWorkflowInsertionOrder;
  CanonicalizationError: typeof import('../../lib/leaf/canonicalJson').CanonicalizationError;
  CANONICALIZATION_PROFILE: string;
  hashGraphOrTraining: typeof import('../../lib/leaf/hashes').hashGraphOrTraining;
  hashDisagreement: typeof import('../../lib/leaf/hashes').hashDisagreement;
};

let M: Mod;
let V: VectorFile;

before(async () => {
  const c = await import('../../lib/leaf/canonicalJson');
  const h = await import('../../lib/leaf/hashes');
  M = {
    canonicalize: c.canonicalize,
    hashWorkflow: c.hashWorkflow,
    canonicalizeLegacy: c.canonicalizeLegacy,
    hashWorkflowLegacy: c.hashWorkflowLegacy,
    hashWorkflowInsertionOrder: c.hashWorkflowInsertionOrder,
    CanonicalizationError: c.CanonicalizationError,
    CANONICALIZATION_PROFILE: c.CANONICALIZATION_PROFILE,
    hashGraphOrTraining: h.hashGraphOrTraining,
    hashDisagreement: h.hashDisagreement,
  };
  V = JSON.parse(fs.readFileSync(VECTORS, 'utf8'));
});

function reason(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof M.CanonicalizationError) return e.reason;
    throw e;
  }
  throw new Error('expected a CanonicalizationError and none was thrown');
}

// ---------------------------------------------------------------------------

describe('the divergence WO-20 reported', () => {
  // Before asserting the fix, assert the bug. A regression test whose
  // "before" state was never demonstrated is a test that could be passing
  // because the input is uninteresting.
  test('the OLD algorithm formats 1e-5 the way only JavaScript does', () => {
    assert.equal(M.canonicalizeLegacy({ learning_rate: 1e-5 }), '{"learning_rate":0.00001}');
    // Python's json.dumps of the same document is {"learning_rate":1e-05}.
    // That literal is the whole bug; it is asserted from the Python side in
    // packages/scruple-host-sdk/tests/test_canonicalization.py.
  });

  test('and the same for integral floats, which is the CANVAS case', () => {
    // A ComfyUI graph, not a training recipe. Python renders 1.0 and 8.0.
    assert.equal(M.canonicalizeLegacy({ denoise: 1.0, cfg: 8.0 }), '{"cfg":8,"denoise":1}');
  });

  test('a real shipped graph carries one: bundle 29e9a40e1d43 video-1 has cfg 3.0', () => {
    const p = path.join(
      process.cwd(),
      'docs/provenance-bundles/bundle-29e9a40e1d43/iterations/video-1/workflow_api.json',
    );
    const raw = fs.readFileSync(p, 'utf8');
    assert.match(raw, /"cfg":\s*3\.0/, 'the fixture that makes this a canvas bug, not a training one');
    // Python hashed this file to 40fbeb048cac… and JavaScript to d39a015eb81b…
    // before WO-21. The document did not change; only the language did.
    assert.equal(
      M.hashWorkflow(JSON.parse(raw)),
      'd39a015eb81b7af7a29f9e266dcbcbd4604df1cb6baab79e3e0ed756e72c0ee3',
    );
  });
});

describe('RFC 8785 vectors, emitted here and reproduced in Python', () => {
  test('the checked-in vector file is what this code produces', () => {
    // Same guard test/v2/component-auth.test.ts uses: without it, a change to
    // the canonicalizer leaves the vectors stale and the Python suite passes
    // against a file that no longer describes anything.
    const before = fs.readFileSync(VECTORS, 'utf8');
    execFileSync(process.execPath, ['--import', 'tsx', 'scripts/gen-canonicalization-vectors.mjs'], {
      cwd: process.cwd(),
      stdio: 'pipe',
    });
    assert.equal(
      fs.readFileSync(VECTORS, 'utf8'),
      before,
      'test/vectors/canonicalization-vectors.json is stale — regenerate it and commit the result',
    );
  });

  test('every case canonicalizes to its recorded bytes and hash', () => {
    for (const c of V.cases) {
      if (c.js_refuses) continue;
      const doc = JSON.parse(c.json);
      assert.equal(M.canonicalize(doc), c.canonical, `${c.name}: canonical form`);
      assert.equal(M.hashWorkflow(doc), c.sha256, `${c.name}: sha256`);
    }
  });

  test('the number rule is ECMAScript Number::toString, not JSON.stringify by luck', () => {
    // JCS §3.2.2.3 -> ECMA-262 §7.1.12.1. Spelled out here rather than only in
    // the vectors so the expected strings are readable next to the rule.
    const doc = { a: 1e-5, b: 5e-6, c: 1.0, d: 1e16, e: 1e21, f: 1e-7, g: -0 };
    assert.equal(
      M.canonicalize(doc),
      '{"a":0.00001,"b":0.000005,"c":1,"d":10000000000000000,"e":1e+21,"f":1e-7,"g":0}',
    );
  });

  test('keys sort by UTF-16 code unit (JCS §3.2.3), not code point', () => {
    // The H-4 §10 C-1 trap in its second preimage. U+1F600 is a surrogate
    // pair whose first unit is 0xD83D, so it sorts BEFORE U+E000 and U+FFFD.
    // A code-point sort — which is what the ratchet MAC preimage correctly
    // uses — would put it last. The two rules are allowed to differ; see
    // docs/canon/CANONICALIZATION.md §6.
    const doc = { '\u{1F600}': 1, '': 2, '�': 3 };
    assert.equal(M.canonicalize(doc), '{"\u{1F600}":1,"":2,"�":3}');
    assert.ok(
      M.canonicalize(doc).indexOf('\u{1F600}') < M.canonicalize(doc).indexOf(''),
      'astral key must come first under a UTF-16 code-unit sort',
    );
  });

  test('arrays keep their order — ComfyUI wiring tuples are positional', () => {
    assert.equal(M.canonicalize({ inputs: { model: ['4', 0] } }), '{"inputs":{"model":["4",0]}}');
    assert.equal(M.canonicalize([3, 1, 2]), '[3,1,2]');
  });
});

describe('existing leaves still verify — no scheme bump was needed', () => {
  test('every pre-WO-21 hash is reproduced byte for byte', () => {
    assert.ok(V.legacy_leaves.length >= 12, 'the fixture set must not shrink silently');
    for (const l of V.legacy_leaves) {
      if (l.profile === 'insertion-order-1') continue; // its own test, below
      const raw = l.json ?? fs.readFileSync(path.join(process.cwd(), l.file!), 'utf8');
      assert.equal(
        M.hashWorkflow(JSON.parse(raw)),
        l.legacy_sha256,
        `${l.name}: adopting RFC 8785 changed a hash that a shipped leaf commits to. ` +
          `That is a leaf-scheme bump, not an edit.`,
      );
    }
  });

  test('the FOUR rows that predate canonicalization replay under insertion-order-1', () => {
    // WO-21 went looking for leaves this bug had damaged and found an older
    // break: ids 166..169 in data/scruple.db, written 2026-07-05, whose
    // workflow_hash was plain JSON.stringify in object key order. ec188d6
    // (2026-07-13) made it canonical WITHOUT a version marker, so those rows
    // carry leaf_scheme 'v2.2' exactly like the rows written after it and an
    // auditor replaying them under the documented preimage sees a mismatch
    // that reads as tampering. Four of the seven rows in the corpus.
    const pre = V.legacy_leaves.filter((l) => l.profile === 'insertion-order-1');
    assert.equal(pre.length, 4, 'the whole affected population, not a sample');
    for (const l of pre) {
      const doc = JSON.parse(l.json!);
      assert.equal(M.hashWorkflowInsertionOrder(doc), l.legacy_sha256, `${l.name}: replay`);
      // and the current rule does NOT reproduce them — which is the finding.
      assert.notEqual(M.hashWorkflow(doc), l.legacy_sha256, `${l.name}: must not silently agree`);
    }
  });

  test('at least one fixture is an actually-witnessed row, not a synthetic doc', () => {
    const real = V.legacy_leaves.filter((l) => l.provenance === 'db_leaf');
    assert.ok(real.length >= 6, 'a backward-compatibility claim needs real leaves behind it');
  });

  test('the new and old algorithms agree on every valid-JSON fixture', () => {
    // The direct statement of the compatibility argument: for any document
    // that is JSON, jcs-1 and legacy-1 are the same function.
    for (const c of V.cases) {
      if (c.js_refuses) continue;
      const doc = JSON.parse(c.json);
      assert.equal(M.canonicalize(doc), M.canonicalizeLegacy(doc), c.name);
    }
  });

  test('insertion-order-1 is a THIRD rule and is not confusable with the other two', () => {
    // Two profiles differing only on non-JSON values is a compatibility
    // argument; three profiles where one genuinely disagrees is why the
    // registry needed a canonicalization_profiles section at all.
    const doc = JSON.parse('{"z":1,"a":2}');
    assert.equal(M.canonicalize(doc), '{"a":2,"z":1}');
    assert.equal(M.canonicalizeLegacy(doc), '{"a":2,"z":1}');
    assert.equal(JSON.stringify(doc), '{"z":1,"a":2}');
  });

  test('hashGraphOrTraining routes both documents through the same rule', () => {
    const graph = { '3': { class_type: 'KSampler', inputs: { cfg: 8.0 } } };
    const recipe = { learning_rate: 1e-5, steps: 1000 };
    assert.equal(M.hashGraphOrTraining(graph, undefined), M.hashWorkflow(graph));
    assert.equal(M.hashGraphOrTraining(undefined, recipe), M.hashWorkflow(recipe));
    assert.equal(M.hashGraphOrTraining(undefined, undefined), null);
    // graph wins when both arrive — the shipped precedence, pinned.
    assert.equal(M.hashGraphOrTraining(graph, recipe), M.hashWorkflow(graph));
  });
});

describe('documents with no canonical form are refused, not answered', () => {
  test('NaN and Infinity — the old code hashed them as null', () => {
    assert.equal(M.canonicalizeLegacy({ lr: NaN }), '{"lr":null}');
    assert.equal(M.canonicalizeLegacy({ lr: Infinity }), '{"lr":null}');
    assert.equal(reason(() => M.canonicalize({ lr: NaN })), 'non_finite_number');
    assert.equal(reason(() => M.canonicalize({ lr: -Infinity })), 'non_finite_number');
  });

  test('undefined — the old code emitted the literal text `undefined`', () => {
    // Not a hash of a bad document. A hash of a string that is not JSON, which
    // no verifier in any language could have reproduced.
    assert.equal(M.canonicalizeLegacy({ a: undefined, b: 1 }), '{"a":undefined,"b":1}');
    assert.equal(reason(() => M.canonicalize({ a: undefined, b: 1 })), 'undefined_value');
  });

  test('a sparse array — the old code emitted `[1,,2]`', () => {
    const sparse = [1, , 2];
    assert.equal(M.canonicalizeLegacy({ a: sparse }), '{"a":[1,,2]}');
    assert.equal(reason(() => M.canonicalize({ a: sparse })), 'sparse_array');
  });

  test('a Date, a Map, a class instance — the old code committed to `{}`', () => {
    assert.equal(M.canonicalizeLegacy({ t: new Date(0) }), '{"t":{}}');
    assert.equal(reason(() => M.canonicalize({ t: new Date(0) })), 'not_a_plain_object');
    assert.equal(reason(() => M.canonicalize({ m: new Map([['a', 1]]) })), 'not_a_plain_object');
    assert.equal(reason(() => M.canonicalize({ b: new Uint8Array([1, 2]) })), 'not_a_plain_object');
  });

  test('a BigInt and a lone surrogate', () => {
    assert.equal(reason(() => M.canonicalize({ n: 1n })), 'bigint_value');
    assert.equal(reason(() => M.canonicalize({ s: '\uD800' })), 'lone_surrogate');
    assert.equal(reason(() => M.canonicalize({ '\uDC00': 1 })), 'lone_surrogate');
  });

  test('a null prototype object is still a plain object', () => {
    const o = Object.create(null) as Record<string, unknown>;
    o.b = 2;
    o.a = 1;
    assert.equal(M.canonicalize(o), '{"a":1,"b":2}');
  });

  test('every non-JSON refusal in the vector file is reproduced', () => {
    const builders: Record<string, () => unknown> = {
      NaN: () => ({ lr: NaN }),
      Infinity: () => ({ lr: Infinity }),
      'undefined value': () => ({ a: undefined, b: 1 }),
      'sparse array hole': () => ({ a: [1, , 2] }),
      'Date instance': () => ({ t: new Date(0) }),
    };
    for (const r of V.non_json_refusals) {
      const build = builders[r.name];
      assert.ok(build, `no builder for non_json_refusal "${r.name}"`);
      assert.equal(reason(() => M.canonicalize(build())), r.reason, r.name);
      assert.equal(M.canonicalizeLegacy(build()), r.legacy, `${r.name}: recorded legacy output`);
    }
  });
});

describe('what JavaScript cannot see, stated rather than pretended', () => {
  test('an integer past the double range is already lost at JSON.parse', () => {
    // Python parses 9007199254740993 exactly and REFUSES, because it can tell
    // the two languages are not holding the same document. JavaScript's parser
    // rounded it before canonicalize() was called, so there is nothing left to
    // detect and it answers for ...992. Asserted so the asymmetry is a pinned
    // property rather than an undiscovered surprise.
    const doc = JSON.parse('{"n":9007199254740993}');
    assert.equal(doc.n, 9007199254740992);
    assert.equal(M.canonicalize(doc), '{"n":9007199254740992}');

    const asymmetric = V.cases.filter((c) => c.python_refuses);
    assert.ok(asymmetric.length >= 2, 'the vectors must carry this asymmetry explicitly');
    for (const c of asymmetric) {
      assert.equal(c.python_refuses, 'integer_out_of_double_range');
      assert.ok(c.sha256, 'JavaScript answers where Python refuses — that is the finding');
    }
  });

  test('2^53 itself is representable and must NOT be refused', () => {
    // The conservative bound (Number.isSafeInteger) would reject this, and
    // rejecting a document JavaScript handles perfectly would introduce a
    // cross-language failure rather than remove one.
    assert.equal(M.canonicalize({ a: 9007199254740992 }), '{"a":9007199254740992}');
  });

  test('1 and 1.0 are the same document here, by construction', () => {
    assert.equal(M.canonicalize(JSON.parse('{"a":1}')), M.canonicalize(JSON.parse('{"a":1.0}')));
  });
});

describe('the workflow_hash comparison the route does not do (WO-20 §6.1)', () => {
  // The route refuses when `model_fingerprints` and `model_fingerprints_hash`
  // disagree and does no such check for `workflow_hash`, even though the
  // component's value is inside the ratchet MAC. `hashDisagreement()` is the
  // predicate, tested here so that adding the call in
  // app/api/v2/witness/route.ts is one line and not a second implementation of
  // the argument. See docs/canon/CANONICALIZATION.md §8.
  test('agreement, and absence, are not disagreements', () => {
    assert.equal(M.hashDisagreement('a'.repeat(64), 'a'.repeat(64)), null);
    assert.equal(M.hashDisagreement(null, 'a'.repeat(64)), null);
    assert.equal(M.hashDisagreement('a'.repeat(64), undefined), null);
    assert.equal(M.hashDisagreement(null, null), null);
  });

  test('two present-and-different values are reported with both sides', () => {
    const d = M.hashDisagreement('a'.repeat(64), 'b'.repeat(64));
    assert.deepEqual(d, { computed: 'a'.repeat(64), supplied: 'b'.repeat(64) });
  });

  test('the case it exists for: same recipe, two canonicalizations', () => {
    // A component running the pre-WO-21 Python rule would have MACed
    // 1e-05-formatted bytes while the server hashed 0.00001-formatted bytes.
    const recipe = { learning_rate: 1e-5 };
    const server = M.hashWorkflow(recipe);
    const divergent = M.hashWorkflow({ learning_rate: '1e-05' }); // stringified, WO-20's workaround
    assert.notEqual(server, divergent);
    assert.ok(M.hashDisagreement(server, divergent), 'must be reported, not silently preferred');
  });
});

describe('the profile is named so a future change can be a bump', () => {
  test('this module declares jcs-1 and the vectors agree', () => {
    assert.equal(M.CANONICALIZATION_PROFILE, 'jcs-1');
    assert.equal(V.profile, 'jcs-1');
  });

  test('legacy-1 is retained for replay and is not the default anywhere', () => {
    // If a leaf containing NaN turns out to exist, it can still be reproduced
    // and read. Nothing writes through it.
    assert.equal(M.hashWorkflowLegacy({ lr: NaN }), M.hashWorkflowLegacy({ lr: null }));
  });
});
