// WO-2 · statement / predicate / envelope.
//
// Four things are pinned here, and only the first is about cryptography:
//
//   1. PAE is the DSSE spec's PAE, proved against the spec's own worked
//      example — the vector AND the signature from protocol.md. Our
//      signature only verifies if our pre-authentication bytes are
//      byte-identical to the spec's, so that one assertion checks pae.ts
//      and dsse.ts together against an external authority rather than
//      against ourselves.
//   2. A leaf round-trips through the envelope UNCHANGED — same keys, same
//      order, same bytes. The envelope wraps; it does not reshape.
//   3. The predicate version and the statement version move independently,
//      and neither moves the envelope. That is the whole point of the
//      split and it is asserted mechanically, including a structural check
//      that pae.ts and dsse.ts have no path to the compliance vocabulary
//      at all.
//   4. The predicate cannot declare a posture better than its own axes
//      yield. DEFECT-1 in PLACEMENT_AND_SURFACES.md is what happens
//      without that.
//
// SAFETY, the two rules from test/integration/harness.ts. Nothing in this
// file opens a database or a socket — the whole subject is pure functions
// over bytes — but the guards are here anyway, because the v2 suite runs
// its files CONCURRENTLY against one shared database and because
// 127.0.0.1:5799 is the PRODUCTION witness. A test that reaches it writes
// into a real audit log, which has happened once already. The modules are
// imported inside before() so the env assignments below are in force
// before any module-scope env read anywhere in the import graph, which is
// also what makes this file survive someone adding a DB import to
// lib/leaf later.

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PROD_WITNESS = /127\.0\.0\.1:5799|localhost:5799/;
if (PROD_WITNESS.test(process.env.WITNESS_SERVER_URL ?? '')) {
  throw new Error('Refusing to run against the production witness server.');
}

import type * as EnvelopeModule from '../../lib/envelope';
import type { LeafField } from '../../lib/leaf/registry.generated';

let E: typeof EnvelopeModule;
let LEAF_FIELDS: readonly LeafField[];
let SURFACE: typeof import('../../lib/capture/surface');

const ENVELOPE_DIR = path.join(process.cwd(), 'lib', 'envelope');

before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scruple-wo2-'));
  process.env.SCRUPLE_DB_PATH = path.join(dir, 'wo2-test.db');

  E = await import('../../lib/envelope');
  ({ LEAF_FIELDS } = await import('../../lib/leaf'));
  SURFACE = await import('../../lib/capture/surface');
});

/* ══ 1 · PAE, against the DSSE specification's own vector ═════════════════
 *
 * PROVENANCE OF THESE NUMBERS. They are the worked example in
 * https://github.com/secure-systems-lab/dsse/blob/master/protocol.md —
 * the spec's vector, not ours: SERIALIZED_BODY "hello world",
 * PAYLOAD_TYPE "http://example.com/HelloWorld", the resulting PAE string,
 * the P-256 key as decimal X/Y/d, and the base64 signature. The DSSE spec
 * repository was not in /data/oss-study (only go-witness's Go
 * implementation was, and copying from that is what SYNTHESIS.md §5 says
 * not to do), so protocol.md was fetched to obtain them.
 *
 * The signature is the load-bearing one. It was produced by an
 * implementation that is not ours, over the spec's PAE bytes; it verifies
 * here ONLY if pae() emits exactly those bytes. A hand-written expected
 * string could be wrong in the same way pae() is wrong. This cannot.
 * ════════════════════════════════════════════════════════════════════════ */

const SPEC_PAYLOAD_TYPE = 'http://example.com/HelloWorld';
const SPEC_BODY = 'hello world';
const SPEC_PAE = 'DSSEv1 29 http://example.com/HelloWorld 11 hello world';
const SPEC_X = 46950820868899156662930047687818585632848591499744589407958293238635476079160n;
const SPEC_Y = 5640078356564379163099075877009565129882514886557779369047442380624545832820n;
const SPEC_D = 97358161215184420915383655311931858321456579547487070936769975997791359926199n;
const SPEC_ENVELOPE = {
  payload: 'aGVsbG8gd29ybGQ=',
  payloadType: SPEC_PAYLOAD_TYPE,
  signatures: [
    { sig: 'A3JqsQGtVsJ2O2xqrI5IcnXip5GToJ3F+FnZ+O88SjtR6rDAajabZKciJTfUiHqJPcIAriEGAHTVeCUjW2JIZA==' },
  ],
};

/** P-256 field elements are 32 bytes big-endian; JWK wants them base64url. */
const p256Coord = (n: bigint) => Buffer.from(n.toString(16).padStart(64, '0'), 'hex').toString('base64url');

const specPublicKey = () =>
  crypto.createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x: p256Coord(SPEC_X), y: p256Coord(SPEC_Y) },
    format: 'jwk',
  });

const specPrivateKey = () =>
  crypto.createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', x: p256Coord(SPEC_X), y: p256Coord(SPEC_Y), d: p256Coord(SPEC_D) },
    format: 'jwk',
  });

describe('PAE — the DSSE specification vector', () => {
  test("pae() reproduces protocol.md's worked example, byte for byte", () => {
    const out = E.pae(SPEC_PAYLOAD_TYPE, SPEC_BODY);
    assert.equal(out.toString('utf8'), SPEC_PAE);
    assert.deepEqual(Array.from(out.subarray(0, 6)), [0x44, 0x53, 0x53, 0x45, 0x76, 0x31]); // "DSSEv1"
    assert.equal(out[6], 0x20, 'the separator is one ASCII space and nothing else');
  });

  test("the spec's own signature verifies over our PAE bytes", () => {
    // Produced by an implementation that is not this one. If pae() were
    // wrong in any way — code units instead of bytes, a padded LEN, a
    // missing separator — this fails and nothing else in the file would.
    const ok = crypto.verify(
      'sha256',
      E.pae(SPEC_PAYLOAD_TYPE, SPEC_BODY),
      { key: specPublicKey(), dsaEncoding: 'ieee-p1363' },
      Buffer.from(SPEC_ENVELOPE.signatures[0].sig, 'base64'),
    );
    assert.equal(ok, true);
  });

  test("verifyEnvelope() accepts the spec's envelope verbatim, keyid and all", () => {
    // No `keyid` in the spec's envelope: the spec says an unset keyid is
    // identical to an empty one, so a verifier must not need the hint.
    const v = E.verifyEnvelope(E.parseEnvelope(JSON.stringify(SPEC_ENVELOPE)), [
      E.ecdsaP256Verifier(specPublicKey(), ''),
    ]);
    assert.equal(v.payload.toString('utf8'), SPEC_BODY);
    assert.equal(v.payloadType, SPEC_PAYLOAD_TYPE);
  });

  test('one flipped payload byte and the spec signature no longer verifies', () => {
    const ok = crypto.verify(
      'sha256',
      E.pae(SPEC_PAYLOAD_TYPE, 'hello worle'),
      { key: specPublicKey(), dsaEncoding: 'ieee-p1363' },
      Buffer.from(SPEC_ENVELOPE.signatures[0].sig, 'base64'),
    );
    assert.equal(ok, false);
  });

  test('we can sign against the spec key and verify our own signature', () => {
    // Node's ECDSA is not RFC 6979 deterministic, so the spec's signature
    // BYTES are not reproducible here and are not asserted. Verifiability
    // is what matters and is what is asserted.
    const env = E.signEnvelope(SPEC_PAYLOAD_TYPE, SPEC_BODY, [
      E.ecdsaP256Signer(specPrivateKey(), 'spec-key'),
    ]);
    assert.equal(env.payload, SPEC_ENVELOPE.payload, 'same payload bytes, same base64');
    const v = E.verifyEnvelope(env, [E.ecdsaP256Verifier(specPublicKey(), 'spec-key')]);
    assert.deepEqual(v.acceptedKeyIds, ['spec-key']);
  });
});

/* ══ 2 · PAE, OUR vectors — clearly ours, not the spec's ══════════════════
 *
 * protocol.md carries exactly one worked example. Everything below is a
 * vector we wrote to pin the four ways PAE is normally got wrong, and it
 * is labelled as ours rather than presented as the specification's.
 * ════════════════════════════════════════════════════════════════════════ */

describe('PAE — our own vectors for the failure modes', () => {
  test('LEN counts UTF-8 BYTES, not JS string length', () => {
    // 'é' is one JS char and two UTF-8 bytes; the emoji is two UTF-16 code
    // units and four bytes. A String.length implementation passes every
    // ASCII test forever and breaks on the first non-ASCII payload.
    const type = 'x/é';
    const body = '🙂';
    assert.equal(type.length, 3);
    assert.equal(Buffer.byteLength(type, 'utf8'), 4);
    assert.equal(body.length, 2);
    assert.equal(Buffer.byteLength(body, 'utf8'), 4);
    assert.equal(E.pae(type, body).toString('utf8'), 'DSSEv1 4 x/é 4 🙂');
  });

  test('PAE is injective where naive concatenation is not', () => {
    // Without length prefixes, ("a", "b c") and ("a b", "c") produce the
    // same bytes, so a signature over one is a signature over the other.
    // This is the entire reason PAE exists.
    assert.notEqual(E.pae('a', 'b c').toString('utf8'), E.pae('a b', 'c').toString('utf8'));
    assert.equal(E.pae('a', 'b c').toString('utf8'), 'DSSEv1 1 a 3 b c');
    assert.equal(E.pae('a b', 'c').toString('utf8'), 'DSSEv1 3 a b 1 c');
  });

  test('LEN(0) is "0" — shortest decimal form, never padded, never empty', () => {
    assert.equal(E.pae('t', '').toString('utf8'), 'DSSEv1 1 t 0 ');
    assert.equal(E.pae('t', 'x'.repeat(100)).toString('utf8').startsWith('DSSEv1 1 t 100 '), true);
  });

  test('the body is appended raw, with no trailing byte after it', () => {
    const body = Buffer.from([0x00, 0xff, 0x20, 0x0a]);
    const out = E.pae('t', body);
    assert.deepEqual(Array.from(out.subarray(out.length - 4)), [0x00, 0xff, 0x20, 0x0a]);
    // "DSSEv1 1 t 4 " is 13 bytes, then exactly the 4 body bytes.
    assert.equal(out.length, 13 + 4);
  });

  test('a payload that looks like a PAE prefix cannot be confused for one', () => {
    const a = E.pae('t', 'DSSEv1 1 t 0 ');
    const b = E.pae('t', '');
    assert.notEqual(a.toString('utf8'), b.toString('utf8'));
  });
});

/* ══ 3 · the envelope ════════════════════════════════════════════════════ */

function testKeypair(keyid: string) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return {
    signer: () => E.ecdsaP256Signer(privateKey, keyid),
    verifier: () => E.ecdsaP256Verifier(publicKey, keyid),
  };
}

describe('the envelope authenticates and nothing more', () => {
  test('tampering with the payload is caught', () => {
    const k = testKeypair('k1');
    const env = E.signEnvelope('application/x.test', 'hello', [k.signer()]);
    env.payload = Buffer.from('hellp', 'utf8').toString('base64');
    assert.throws(() => E.verifyEnvelope(env, [k.verifier()]), /threshold/);
  });

  test('tampering with the payloadType is caught — this is what PAE buys', () => {
    // A signature scheme over the payload alone would not notice this.
    const k = testKeypair('k1');
    const env = E.signEnvelope('application/x.test', 'hello', [k.signer()]);
    env.payloadType = 'application/x.other';
    assert.throws(() => E.verifyEnvelope(env, [k.verifier()]), /threshold/);
  });

  test('multiple signatures over the same PAE, and a threshold over them', () => {
    const a = testKeypair('a');
    const b = testKeypair('b');
    const env = E.signEnvelope('application/x.test', 'hello', [a.signer(), b.signer()]);
    assert.equal(env.signatures.length, 2);
    const v = E.verifyEnvelope(env, [a.verifier(), b.verifier()], { threshold: 2 });
    assert.deepEqual(v.acceptedKeyIds.sort(), ['a', 'b']);
    assert.throws(
      () => E.verifyEnvelope(env, [a.verifier()], { threshold: 2 }),
      /threshold/,
    );
  });

  test('a wrong key does not verify', () => {
    const a = testKeypair('a');
    const b = testKeypair('b');
    const env = E.signEnvelope('application/x.test', 'hello', [a.signer()]);
    assert.throws(() => E.verifyEnvelope(env, [b.verifier()]), /threshold/);
  });

  test('parse ignores unrecognised fields rather than rejecting them', () => {
    const k = testKeypair('k1');
    const env = E.signEnvelope('application/x.test', 'hello', [k.signer()]);
    const withExtras = JSON.stringify({ ...env, futureField: 'from a later spec version' });
    const parsed = E.parseEnvelope(withExtras);
    assert.equal('futureField' in parsed, false, 'dropped, so it can never be mistaken for understood');
    E.verifyEnvelope(parsed, [k.verifier()]);
  });

  test('a malformed envelope is refused with a reason', () => {
    assert.throws(() => E.parseEnvelope('not json'), /not JSON/);
    assert.throws(() => E.parseEnvelope('{"payloadType":"t","signatures":[]}'), /payload must be/);
    assert.throws(() => E.parseEnvelope('{"payload":"","signatures":[]}'), /payloadType/);
    assert.throws(() => E.parseEnvelope('{"payload":"","payloadType":"t"}'), /signatures/);
  });

  test('signing with no signer is refused — an unsigned envelope authenticates nothing', () => {
    assert.throws(() => E.signEnvelope('application/x.test', 'hello', []), /authenticates nothing/);
  });
});

/* ══ 4 · the split is structural, not a naming convention ════════════════ */

describe('the signing machinery cannot see the compliance vocabulary', () => {
  /** Strip // and /* *​/ comments so prose about P1-P8 is not mistaken for code. */
  const stripComments = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

  test('pae.ts and dsse.ts import nothing from the predicate or the axes', () => {
    for (const f of ['pae.ts', 'dsse.ts']) {
      const src = fs.readFileSync(path.join(ENVELOPE_DIR, f), 'utf8');
      const imports = Array.from(src.matchAll(/from\s+'([^']+)'/g)).map((m) => m[1]);
      for (const spec of imports) {
        assert.ok(
          !/predicate|statement|attest|capture\/surface|lib\/leaf/.test(spec),
          `${f} imports '${spec}' — the envelope layer must not depend on what it carries`,
        );
      }
    }
  });

  test('no compliance vocabulary appears in the code of pae.ts or dsse.ts', () => {
    const forbidden = [
      'vendor-baseline',
      'server-library',
      'sidecar-gate',
      'attested-client',
      'unattested-client',
      'no-tenant-code',
      'isolated-namespace',
      'in-process-callback',
      'as-delivered',
      'assuranceFor',
      'resolvePlacement',
    ];
    for (const f of ['pae.ts', 'dsse.ts']) {
      const code = stripComments(fs.readFileSync(path.join(ENVELOPE_DIR, f), 'utf8'));
      for (const token of forbidden) {
        assert.ok(!code.includes(token), `${f} names '${token}' in code; the split has been reintroduced`);
      }
    }
  });

  test('predicate.ts names no signing machinery', () => {
    const code = stripComments(fs.readFileSync(path.join(ENVELOPE_DIR, 'predicate.ts'), 'utf8'));
    for (const token of ['DSSEv1', 'payloadType', 'signEnvelope', 'pae(']) {
      assert.ok(!code.includes(token), `predicate.ts names '${token}'`);
    }
  });

  test('the predicate reuses the axes verbatim rather than restating them', () => {
    // If this ever fails it means a parallel vocabulary has been defined,
    // which is the exact bug WO-2 exists to prevent.
    const schema = E.vendorBaselinePredicateSchema() as Record<string, any>;
    const props = schema.properties;
    assert.deepEqual(props.placement.properties.declared.enum, [...SURFACE.PLACEMENTS]);
    assert.deepEqual(props.placement.properties.enforcement.enum, [...SURFACE.PLACEMENT_ENFORCEMENTS]);
    assert.deepEqual(props.attestation.properties.outcome.enum, [...SURFACE.ATTESTATION_OUTCOMES]);
    assert.deepEqual(props.surfaces.items.properties.surface.enum, [...SURFACE.CAPTURE_SURFACES]);
    assert.deepEqual(props.surfaces.items.properties.fidelity.enum, [...SURFACE.OBSERVATION_FIDELITIES]);
    assert.deepEqual(props.surfaces.items.properties.hooks.items.enum, [...SURFACE.CAPTURE_HOOKS]);
  });
});

/* ══ 5 · the leaf round-trips unchanged ══════════════════════════════════ */

/**
 * A leaf carrying every live field the registry defines, built FROM the
 * registry so this file states no field list of its own. If WO-1 adds a
 * field tomorrow, this leaf grows one and the round-trip still has to hold.
 */
function fullLeafFromRegistry(spelling: 'id' | 'submit'): Record<string, unknown> {
  const hex = (seed: string) => crypto.createHash('sha256').update(seed).digest('hex');
  const leaf: Record<string, unknown> = {};
  for (const f of LEAF_FIELDS) {
    if (f.deprecated) continue;
    const name = spelling === 'submit' ? (f.aliases.submit ?? f.aliases.storage ?? f.id) : f.id;
    if (f.type === 'int') leaf[name] = 7;
    else if (f.type === 'boolean') leaf[name] = false;
    else if (f.id === 'output_hash') leaf[name] = hex('output bytes');
    else leaf[name] = hex(f.id).slice(0, 40);
  }
  return leaf;
}

function samplePredicate() {
  return E.buildVendorBaselinePredicate({
    component: {
      component_id: '7c2f6e64-0a1b-4c3d-8e9f-0123456789ab',
      tenant_id: 'tenant-wo2',
      build_measurement: 'sha256:' + '0'.repeat(64),
    },
    declared_placement: 'server-library',
    enforcement: 'no-tenant-code',
    attestation: { provider: 'amd-sev-snp', quote_ref: 'https://vendor.example/quote/1', outcome: 'verified' },
    surfaces: [
      {
        name: 'vendor-inference-handler',
        surface: 'in-process-callback',
        fidelity: 'as-delivered',
        hooks: ['graph.execute', 'artifact.produced'],
      },
    ],
    declared_properties: { p2: 'holds', p4: 'holds', p5: 'holds', p6: 'holds', p7: 'holds', p8: 'holds' },
  });
}

describe('a leaf round-trips through the envelope unchanged', () => {
  for (const spelling of ['id', 'submit'] as const) {
    test(`every live registry field survives, ${spelling} spelling`, () => {
      const leaf = fullLeafFromRegistry(spelling);
      const k = testKeypair('roundtrip');
      const wire = E.serializeEnvelope(E.attestLeaf(leaf, samplePredicate(), [k.signer()]));
      const out = E.openLeafAttestation(E.parseEnvelope(wire), [k.verifier()]).leaf;

      assert.deepStrictEqual(out, leaf, 'values identical');
      assert.deepEqual(Object.keys(out), Object.keys(leaf), 'nothing added, nothing dropped, order kept');
      assert.equal(JSON.stringify(out), JSON.stringify(leaf), 'byte-identical, not merely equivalent');
    });
  }

  test('the subject digest is the leaf output_hash, not a hash invented here', () => {
    // Whichever of the two live spellings the leaf used. content_hash and
    // output_hash are the same field (registry rename), and the subject
    // binding resolves it rather than knowing there are two names.
    const k = testKeypair('digest');
    for (const spelling of ['id', 'submit'] as const) {
      const leaf = fullLeafFromRegistry(spelling);
      const opened = E.openLeafAttestation(
        E.attestLeaf(leaf, samplePredicate(), [k.signer()]),
        [k.verifier()],
      );
      const expected = crypto.createHash('sha256').update('output bytes').digest('hex');
      assert.equal(opened.statement.subject[0].digest.sha256, expected);
      assert.deepEqual(Object.keys(opened.statement.subject[0].digest), ['sha256']);
    }
  });

  test('a leaf with no output_hash is refused rather than given a synthetic digest', () => {
    assert.throws(
      () => E.leafSubject({ witness_id: 'wit_abc', leaf_hash: 'x' }),
      /output_hash/,
    );
  });

  test('tampering with the leaf inside a signed envelope is caught', () => {
    const leaf = fullLeafFromRegistry('id');
    const k = testKeypair('tamper');
    const env = E.attestLeaf(leaf, samplePredicate(), [k.signer()]);
    const statement = JSON.parse(E.decodeUnverifiedPayload(env).toString('utf8'));
    statement.subject[0].leaf.run_sequence = 8;
    env.payload = Buffer.from(JSON.stringify(statement), 'utf8').toString('base64');
    assert.throws(() => E.openLeafAttestation(env, [k.verifier()]), /threshold/);
  });
});

/* ══ 6 · independent versioning, proven ══════════════════════════════════ */

describe('the predicate, the statement and the envelope version independently', () => {
  test('bumping the predicate version moves nothing else', () => {
    const leaf = fullLeafFromRegistry('id');
    const k = testKeypair('ver');
    const predicate = samplePredicate();

    const v1 = E.attestLeaf(leaf, predicate, [k.signer()], { predicateVersion: 1 });
    const v2 = E.attestLeaf(leaf, { ...predicate, predicate_version: 2 }, [k.signer()], {
      predicateVersion: 2,
    });

    const a = E.openLeafAttestation(v1, [k.verifier()]);
    const b = E.openLeafAttestation(v2, [k.verifier()]);

    // The predicate moved.
    assert.equal(a.predicateType, 'https://scruple.ai/attestation/vendor-baseline/v1');
    assert.equal(b.predicateType, 'https://scruple.ai/attestation/vendor-baseline/v2');
    assert.notEqual(a.predicateType, b.predicateType);

    // The envelope did not: same payloadType, so a generic signature
    // verifier's PAE input is described the same way in both.
    assert.equal(v1.payloadType, v2.payloadType);
    assert.equal(v1.payloadType, E.SCRUPLE_STATEMENT_PAYLOAD_TYPE);

    // The statement did not.
    assert.equal(a.statement._type, b.statement._type);
    assert.equal(a.statement._type, 'https://scruple.ai/attestation/Statement/v1');

    // The leaf did not — byte for byte.
    assert.equal(JSON.stringify(a.leaf), JSON.stringify(b.leaf));
    assert.equal(JSON.stringify(a.leaf), JSON.stringify(leaf));

    // And both still verify with the same key and the same PAE code.
    assert.deepEqual(a.acceptedKeyIds, ['ver']);
    assert.deepEqual(b.acceptedKeyIds, ['ver']);
  });

  test('bumping the statement version moves neither the predicate nor the leaf', () => {
    const leaf = fullLeafFromRegistry('id');
    const k = testKeypair('ver');
    const predicate = samplePredicate();

    const s1 = E.attestLeaf(leaf, predicate, [k.signer()], { statementVersion: 1 });
    const s2 = E.attestLeaf(leaf, predicate, [k.signer()], { statementVersion: 2 });

    const a = E.openLeafAttestation(s1, [k.verifier()]);
    const b = E.openLeafAttestation(s2, [k.verifier()]);

    assert.notEqual(a.statement._type, b.statement._type);
    assert.equal(b.statement._type, 'https://scruple.ai/attestation/Statement/v2');

    assert.equal(a.predicateType, b.predicateType);
    assert.equal(JSON.stringify(a.predicate), JSON.stringify(b.predicate), 'predicate bytes untouched');
    assert.equal(JSON.stringify(a.leaf), JSON.stringify(b.leaf));

    // payloadType is stable across statement versions BY DESIGN: the
    // version lives in `_type`, inside the payload, so a consumer that only
    // checks signatures never has to learn about a statement bump.
    assert.equal(s1.payloadType, s2.payloadType);
  });

  test('PAE is unchanged by either bump — it is a function of bytes only', () => {
    const body = '{"anything":"at all"}';
    assert.equal(
      E.pae(E.SCRUPLE_STATEMENT_PAYLOAD_TYPE, body).toString('base64'),
      E.pae(E.SCRUPLE_STATEMENT_PAYLOAD_TYPE, body).toString('base64'),
    );
    // The spec vector still holds after everything above — the signing
    // layer has not been touched by any version move.
    assert.equal(E.pae(SPEC_PAYLOAD_TYPE, SPEC_BODY).toString('utf8'), SPEC_PAE);
  });

  test('the version in the URI and the version in the body agree', () => {
    assert.equal(
      E.vendorBaselinePredicateType(E.VENDOR_BASELINE_PREDICATE_VERSION),
      `https://scruple.ai/attestation/vendor-baseline/v${E.VENDOR_BASELINE_PREDICATE_VERSION}`,
    );
    assert.equal(samplePredicate().predicate_version, E.VENDOR_BASELINE_PREDICATE_VERSION);
    assert.equal(
      (E.vendorBaselinePredicateSchema() as Record<string, unknown>).$id,
      E.vendorBaselinePredicateType(),
    );
  });
});

/* ══ 7 · the predicate cannot grade itself ═══════════════════════════════ */

describe('the vendor-baseline predicate carries a posture it cannot forge', () => {
  test('a sound server-library configuration validates', () => {
    const p = samplePredicate();
    assert.deepEqual(E.validateVendorBaselinePredicate(p), []);
    assert.equal(p.properties.p1, 'holds');
    assert.equal(p.properties.p3, 'holds');
    assert.equal(p.leaf_status, 'verified');
    assert.equal(p.can_claim, true);
  });

  test('unattested-client is VALID and refused — the standard says no rather than not saying', () => {
    // PLACEMENT_AND_SURFACES.md §4.1. A shape the model cannot express is a
    // shape it cannot refuse, so this must not be a schema error.
    const p = E.buildVendorBaselinePredicate({
      component: { component_id: 'c-browser', tenant_id: 't', build_measurement: null },
      declared_placement: 'unattested-client',
      enforcement: 'none',
      // Deliberately holding a genuine root-verified quote, per §7.6.
      attestation: { provider: 'amd-sev-snp', quote_ref: 'https://x/q', outcome: 'verified' },
      surfaces: [
        { name: 'page-js', surface: 'in-process-callback', fidelity: 'as-delivered', hooks: ['document.save'] },
      ],
      declared_properties: { p2: 'fails', p4: 'fails', p5: 'holds', p6: 'holds', p7: 'holds', p8: 'holds' },
    });
    assert.deepEqual(E.validateVendorBaselinePredicate(p), []);
    assert.equal(p.properties.p1, 'fails');
    assert.equal(p.properties.p3, 'fails');
    assert.equal(p.leaf_status, null, 'no leaf may be issued');
    assert.equal(p.can_claim, false);
  });

  test('a declared placement with no enforcement degrades, and cannot be argued back up', () => {
    const p = E.buildVendorBaselinePredicate({
      component: { component_id: 'c-kohya', tenant_id: 't', build_measurement: null },
      declared_placement: 'sidecar-gate',
      enforcement: 'none',
      attestation: { provider: 'none', quote_ref: null, outcome: 'none' },
      surfaces: [
        { name: 'kohya-save-hook', surface: 'in-process-callback', fidelity: 'as-written', hooks: ['model.write'] },
      ],
      declared_properties: { p2: 'fails', p4: 'fails', p5: 'holds', p6: 'holds', p7: 'holds', p8: 'holds' },
    });
    assert.equal(p.placement.effective, 'unattested-client');
    assert.equal(p.placement.honoured, false);
    assert.equal(p.can_claim, false);

    // Now forge it back.
    const forged = { ...p, placement: { ...p.placement, effective: 'sidecar-gate' as const, honoured: true } };
    const errs = E.validateVendorBaselinePredicate(forged);
    assert.ok(errs.some((e) => /DEFECT-1/.test(e)), errs.join('; '));
  });

  test('a forged p1 or can_claim is caught by recomputation', () => {
    const p = samplePredicate();
    const badP1 = { ...p, properties: { ...p.properties, p1: 'conditional' as const } };
    assert.ok(E.validateVendorBaselinePredicate(badP1).some((e) => /properties\.p1/.test(e)));

    const unattested = E.buildVendorBaselinePredicate({
      component: { component_id: 'c', tenant_id: 't', build_measurement: null },
      declared_placement: 'unattested-client',
      enforcement: 'none',
      attestation: { provider: 'none', quote_ref: null, outcome: 'none' },
      surfaces: [{ name: 's', surface: 'in-process-callback', fidelity: 'as-delivered', hooks: ['document.save'] }],
      declared_properties: { p2: 'fails', p4: 'fails', p5: 'holds', p6: 'holds', p7: 'holds', p8: 'holds' },
    });
    const claimed = { ...unattested, can_claim: true };
    assert.ok(E.validateVendorBaselinePredicate(claimed).some((e) => /can_claim/.test(e)));
  });

  test('P7 and P8 are checked against each other, not just individually', () => {
    const base = samplePredicate();

    // Hardware declared, but no leaf carries an envelope. P8 violation.
    const noEnvelopes = { ...base, attestation: { ...base.attestation, outcome: 'none' as const } };
    assert.ok(E.validateVendorBaselinePredicate(noEnvelopes).some((e) => /P8 requires EVERY leaf/.test(e)));

    // No hardware declared, but an envelope arrives anyway.
    const ghost = {
      ...base,
      attestation: { provider: 'none', quote_ref: null, outcome: 'passthrough' as const },
    };
    assert.ok(E.validateVendorBaselinePredicate(ghost).some((e) => /does not exist/.test(e)));
  });

  test("a provider with no built-in verifier needs P8's verifier_reference", () => {
    const p = E.buildVendorBaselinePredicate({
      component: { component_id: 'c', tenant_id: 't', build_measurement: null },
      declared_placement: 'server-library',
      enforcement: 'no-tenant-code',
      attestation: { provider: 'some-emerging-tee', quote_ref: 'https://x/q', outcome: 'passthrough' },
      surfaces: [{ name: 's', surface: 'in-process-callback', fidelity: 'as-delivered', hooks: ['artifact.produced'] }],
      declared_properties: { p2: 'holds', p4: 'holds', p5: 'holds', p6: 'holds', p7: 'holds', p8: 'holds' },
    });
    assert.ok(E.validateVendorBaselinePredicate(p).some((e) => /verifier_reference/.test(e)));

    p.attestation.verifier_reference = 'https://verifier.example/emerging-tee';
    assert.deepEqual(E.validateVendorBaselinePredicate(p), []);
  });

  test("'induced' fidelity without a retained artifact is refused — DEFECT-3's consequence", () => {
    const p = E.buildVendorBaselinePredicate({
      component: { component_id: 'c-fusion', tenant_id: 't', build_measurement: null },
      declared_placement: 'attested-client',
      enforcement: 'host-enforced-signature',
      attestation: { provider: 'none', quote_ref: null, outcome: 'none' },
      surfaces: [
        { name: 'fusion-export', surface: 'host-api-callback', fidelity: 'induced', hooks: ['document.save'] },
      ],
      declared_properties: { p2: 'conditional', p4: 'holds', p5: 'holds', p6: 'holds', p7: 'holds', p8: 'holds' },
    });
    assert.ok(E.validateVendorBaselinePredicate(p).some((e) => /induced_artifact_ref/.test(e)));

    p.surfaces[0].induced_artifact_ref = 'scruple://artifact/f3d/abc';
    assert.deepEqual(E.validateVendorBaselinePredicate(p), []);
  });

  test('a baseline that names no surface observes nothing', () => {
    const p = { ...samplePredicate(), surfaces: [] };
    assert.ok(E.validateVendorBaselinePredicate(p).some((e) => /at least one observation position/.test(e)));
  });

  test('attestLeaf refuses to sign an unsound predicate', () => {
    const leaf = fullLeafFromRegistry('id');
    const k = testKeypair('refuse');
    const bad = { ...samplePredicate(), can_claim: false };
    assert.throws(() => E.attestLeaf(leaf, bad, [k.signer()]), /refusing to sign/);
    // ...and can be told not to, for a producer that wants the bytes anyway.
    E.attestLeaf(leaf, bad, [k.signer()], { validate: false });
  });

  test('every canon host profile produces a predicate that agrees with the axes', () => {
    // The six-host table in PLACEMENT_AND_SURFACES.md §7.7, run through the
    // predicate rather than through assuranceForHost(), to prove the
    // predicate is a carrier of that model and not a second opinion.
    for (const [key, profile] of Object.entries(SURFACE.CANON_HOST_PROFILES)) {
      const expected = SURFACE.assuranceForHost(profile);
      const p = E.buildVendorBaselinePredicate({
        component: { component_id: `c-${key}`, tenant_id: 't', build_measurement: null },
        declared_placement: profile.declaredPlacement,
        enforcement: profile.enforcement,
        attestation: {
          provider: profile.attestation === 'none' ? 'none' : 'amd-sev-snp',
          quote_ref: profile.attestation === 'none' ? null : 'https://x/q',
          outcome: profile.attestation,
        },
        surfaces: profile.surfaces.map((s) => ({
          name: `${profile.host}:${s}`,
          surface: s,
          fidelity: profile.fidelity,
          hooks: [...profile.hooks],
          ...(profile.fidelity === 'induced' ? { induced_artifact_ref: 'scruple://artifact/x' } : {}),
        })),
        declared_properties: { p2: 'conditional', p4: 'conditional', p5: 'holds', p6: 'holds', p7: 'holds', p8: 'holds' },
      });
      assert.deepEqual(E.validateVendorBaselinePredicate(p), [], key);
      assert.equal(p.properties.p1, expected.p1, `${key} p1`);
      assert.equal(p.properties.p3, expected.p3, `${key} p3`);
      assert.equal(p.leaf_status, expected.leaf, `${key} leaf`);
      assert.equal(p.can_claim, expected.canClaim, `${key} canClaim`);
    }
  });
});
