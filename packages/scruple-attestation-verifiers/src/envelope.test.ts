// Envelope schema + canonicalization tests. Uses node:test (built-in).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  envelopeSchemaValidator,
  EnvelopeValidationError,
  canonicalizeEnvelope,
  isBuiltInType,
  isPassthroughType,
  BUILT_IN_ATTESTATION_TYPES,
} from './envelope.js';

const VALID_NONCE = 'a'.repeat(64);
const VALID_TIME = '2026-07-13T00:00:00Z';

function makeValid(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    attestation_type: 'amd-sev-snp',
    attestation_report: 'aGVsbG8=',
    certificate_chain: ['-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n'],
    nonce: VALID_NONCE,
    attestation_time: VALID_TIME,
    ...overrides,
  };
}

test('envelopeSchemaValidator accepts a well-formed built-in envelope', () => {
  const env = envelopeSchemaValidator(makeValid());
  assert.equal(env.attestation_type, 'amd-sev-snp');
  assert.equal(env.nonce, VALID_NONCE);
});

test('envelopeSchemaValidator accepts passthrough with verifier_reference', () => {
  const env = envelopeSchemaValidator(
    makeValid({
      attestation_type: 'custom-vendor-attestation',
      verifier_reference: 'https://verifier.example.com/verify',
    }),
  );
  assert.equal(env.attestation_type, 'custom-vendor-attestation');
  assert.equal(env.verifier_reference, 'https://verifier.example.com/verify');
});

test('envelopeSchemaValidator rejects passthrough without verifier_reference', () => {
  assert.throws(
    () => envelopeSchemaValidator(makeValid({ attestation_type: 'custom-x' })),
    EnvelopeValidationError,
  );
});

test('envelopeSchemaValidator rejects non-object input', () => {
  assert.throws(() => envelopeSchemaValidator(null), EnvelopeValidationError);
  assert.throws(() => envelopeSchemaValidator('a string'), EnvelopeValidationError);
  assert.throws(() => envelopeSchemaValidator(42), EnvelopeValidationError);
});

test('envelopeSchemaValidator rejects malformed nonce (not 64 hex)', () => {
  assert.throws(
    () => envelopeSchemaValidator(makeValid({ nonce: 'abc' })),
    EnvelopeValidationError,
  );
  assert.throws(
    () => envelopeSchemaValidator(makeValid({ nonce: 'Z'.repeat(64) })),
    EnvelopeValidationError,
  );
});

test('envelopeSchemaValidator rejects unparseable attestation_time', () => {
  assert.throws(
    () => envelopeSchemaValidator(makeValid({ attestation_time: 'not a date' })),
    EnvelopeValidationError,
  );
});

test('envelopeSchemaValidator rejects non-array certificate_chain', () => {
  assert.throws(
    () => envelopeSchemaValidator(makeValid({ certificate_chain: 'oops' })),
    EnvelopeValidationError,
  );
});

test('envelopeSchemaValidator rejects http verifier_reference (https only)', () => {
  assert.throws(
    () =>
      envelopeSchemaValidator(
        makeValid({
          attestation_type: 'custom-x',
          verifier_reference: 'http://verifier.example.com/verify',
        }),
      ),
    EnvelopeValidationError,
  );
});

test('canonicalizeEnvelope is byte-stable across two calls with same input', () => {
  const env = envelopeSchemaValidator(makeValid());
  const a = canonicalizeEnvelope(env);
  const b = canonicalizeEnvelope(env);
  assert.equal(a, b);
});

test('canonicalizeEnvelope produces sorted-key output', () => {
  const env = envelopeSchemaValidator(makeValid());
  const canon = canonicalizeEnvelope(env);
  // Keys should appear in alphabetical order in the serialized JSON.
  const keyPositions = ['attestation_report', 'attestation_time', 'attestation_type', 'certificate_chain', 'nonce'].map(
    (k) => canon.indexOf('"' + k + '":'),
  );
  for (let i = 1; i < keyPositions.length; i++) {
    assert.ok(keyPositions[i] > keyPositions[i - 1], `keys out of order at ${i}`);
  }
});

test('canonicalizeEnvelope includes verifier_reference only when present', () => {
  const withRef = envelopeSchemaValidator(
    makeValid({ attestation_type: 'x', verifier_reference: 'https://v.example.com/' }),
  );
  const withoutRef = envelopeSchemaValidator(makeValid());
  assert.ok(canonicalizeEnvelope(withRef).includes('verifier_reference'));
  assert.ok(!canonicalizeEnvelope(withoutRef).includes('verifier_reference'));
});

test('isBuiltInType returns true for known types', () => {
  for (const t of BUILT_IN_ATTESTATION_TYPES) {
    assert.equal(isBuiltInType(t), true);
  }
});

test('isBuiltInType returns false for unknown types', () => {
  assert.equal(isBuiltInType('custom-x'), false);
  assert.equal(isBuiltInType('none'), false);
});

test('isPassthroughType classifies correctly', () => {
  assert.equal(isPassthroughType('custom-x'), true);
  assert.equal(isPassthroughType('amd-sev-snp'), false);
  assert.equal(isPassthroughType('none'), false);
});
