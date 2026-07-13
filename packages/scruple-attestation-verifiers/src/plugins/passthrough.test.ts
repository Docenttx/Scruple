// End-to-end passthrough test — dispatch classifies unknown attestation
// types with verifier_reference as passthrough (stored, not verified).
// The receipt-side visual distinction is a separate concern; here we
// only assert dispatch behavior.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { _resetRegistryForTests, dispatch } from '../dispatch.js';
import { envelopeSchemaValidator } from '../envelope.js';

const NONCE = 'a'.repeat(64);

function makeEnv(overrides: Record<string, unknown> = {}) {
  return envelopeSchemaValidator({
    attestation_type: 'placeholder',
    attestation_report: 'aGVsbG8=',
    certificate_chain: ['-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----\n'],
    nonce: NONCE,
    attestation_time: new Date().toISOString(),
    ...overrides,
  });
}

beforeEach(() => _resetRegistryForTests());

test('passthrough — unknown type with verifier_reference → ok + passthrough:true', async () => {
  const env = makeEnv({
    attestation_type: 'custom-vendor-x',
    verifier_reference: 'https://verify.example.com/x',
  });
  const r = await dispatch(env, NONCE, 900);
  assert.equal(r.ok, true);
  assert.equal(r.passthrough, true);
  assert.equal(r.verifier_reference, 'https://verify.example.com/x');
  assert.equal(r.provider, 'custom-vendor-x');
});

test('passthrough — unknown type WITHOUT verifier_reference → validation error at envelope stage', () => {
  // The envelope validator itself refuses to construct such an envelope.
  assert.throws(
    () =>
      envelopeSchemaValidator({
        attestation_type: 'custom-vendor-x',
        attestation_report: 'aGVsbG8=',
        certificate_chain: [],
        nonce: NONCE,
        attestation_time: new Date().toISOString(),
      }),
    /passthrough/,
  );
});

test('passthrough — nonce mismatch still fails even without verifier plugin', async () => {
  const env = makeEnv({
    attestation_type: 'custom-vendor-x',
    verifier_reference: 'https://verify.example.com/x',
  });
  const r = await dispatch(env, 'b'.repeat(64), 900);
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /nonce mismatch/);
});

test('passthrough — http (not https) verifier_reference rejected at validator', () => {
  assert.throws(
    () =>
      envelopeSchemaValidator({
        attestation_type: 'custom-vendor-x',
        attestation_report: 'aGVsbG8=',
        certificate_chain: [],
        nonce: NONCE,
        attestation_time: new Date().toISOString(),
        verifier_reference: 'http://insecure.example.com/',
      }),
    /https/,
  );
});
