// Dispatch layer tests.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { envelopeSchemaValidator } from './envelope.js';
import {
  dispatch,
  registerPlugin,
  _resetRegistryForTests,
  getRegisteredTypes,
} from './dispatch.js';
import type { VerifierPlugin } from './verifier.js';
import { verifyRootVerified, verifyFailure } from './verifier.js';

const VALID_NONCE = 'a'.repeat(64);

function makeValidEnv(overrides: Record<string, unknown> = {}) {
  return envelopeSchemaValidator({
    attestation_type: 'amd-sev-snp',
    attestation_report: 'aGVsbG8=',
    certificate_chain: ['-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----\n'],
    nonce: VALID_NONCE,
    attestation_time: '2026-07-13T00:00:00Z',
    ...overrides,
  });
}

beforeEach(() => {
  _resetRegistryForTests();
});

test('dispatch rejects unregistered built-in type', async () => {
  const env = makeValidEnv();
  const r = await dispatch(env, VALID_NONCE, 900);
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /not registered/);
});

test('dispatch rejects nonce mismatch', async () => {
  const env = makeValidEnv();
  const r = await dispatch(env, 'b'.repeat(64), 900);
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /nonce mismatch/);
});

test('dispatch routes to registered plugin', async () => {
  const fake: VerifierPlugin = {
    attestation_type: 'amd-sev-snp',
    async verify(env, expected, fresh) {
      return verifyRootVerified('amd-sev-snp', { root_subject: 'CN=ARK-Genoa', chain_length: 3 }, { chip_id: 'aabbcc' });
    },
  };
  registerPlugin(fake);
  const env = makeValidEnv();
  const r = await dispatch(env, VALID_NONCE, 900);
  assert.equal(r.ok, true);
  assert.equal(r.provider, 'amd-sev-snp');
  assert.equal(r.chip_id, 'aabbcc');
});

test('dispatch handles plugin verify() ok: false without throwing', async () => {
  const fake: VerifierPlugin = {
    attestation_type: 'amd-sev-snp',
    async verify() {
      return verifyFailure('amd-sev-snp', 'signature invalid');
    },
  };
  registerPlugin(fake);
  const r = await dispatch(makeValidEnv(), VALID_NONCE, 900);
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /signature invalid/);
});

test('dispatch classifies unknown type with verifier_reference as passthrough', async () => {
  const env = makeValidEnv({
    attestation_type: 'custom-vendor-x',
    verifier_reference: 'https://verify.example.com/x',
  });
  const r = await dispatch(env, VALID_NONCE, 900);
  assert.equal(r.ok, true);
  assert.equal(r.passthrough, true);
  assert.equal(r.verifier_reference, 'https://verify.example.com/x');
});

test('registerPlugin throws on duplicate registration', () => {
  const fake: VerifierPlugin = {
    attestation_type: 'amd-sev-snp',
    async verify() {
      return verifyRootVerified('amd-sev-snp', { root_subject: 'CN=ARK-Genoa', chain_length: 3 });
    },
  };
  registerPlugin(fake);
  assert.throws(() => registerPlugin(fake), /already registered/);
});

test('getRegisteredTypes returns sorted list', () => {
  const p1: VerifierPlugin = {
    attestation_type: 'nvidia-h100-cc',
    async verify() {
      return verifyRootVerified('nvidia-h100-cc', { root_subject: 'CN=NVIDIA Device Identity CA', chain_length: 3 });
    },
  };
  const p2: VerifierPlugin = {
    attestation_type: 'amd-sev-snp',
    async verify() {
      return verifyRootVerified('amd-sev-snp', { root_subject: 'CN=ARK-Genoa', chain_length: 3 });
    },
  };
  registerPlugin(p1);
  registerPlugin(p2);
  const types = getRegisteredTypes();
  assert.deepEqual(types, ['amd-sev-snp', 'nvidia-h100-cc']);
});
