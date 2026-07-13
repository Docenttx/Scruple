// Structural tests for the non-SEV-SNP verifier plugins. These use
// mock fixtures (fake JWTs, fake bytes) to verify the plugins' logic
// pathways — nonce binding, freshness, format sanity. Real crypto
// verification against captured fixtures is a follow-up.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { _resetRegistryForTests } from '../dispatch.js';
import { nvidiaH100Verifier } from './nvidia_h100.js';
import { awsNitroVerifier } from './aws_nitro.js';
import { azureMaaVerifier } from './azure_maa.js';
import { intelTdxVerifier } from './intel_tdx.js';
import { tpm2Verifier } from './tpm_2.js';

const NONCE = 'a'.repeat(64);

beforeEach(() => _resetRegistryForTests());

// ── Helpers ────────────────────────────────────────────────────────────
function jwtOf(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
    .toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = Buffer.from('fake-signature').toString('base64url');
  return `${header}.${body}.${sig}`;
}

function baseEnv(overrides: Record<string, unknown> = {}) {
  return {
    attestation_type: 'placeholder',
    attestation_report: 'placeholder',
    certificate_chain: ['-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----\n'],
    nonce: NONCE,
    attestation_time: new Date().toISOString(),
    ...overrides,
  };
}

// ── NVIDIA H100 ────────────────────────────────────────────────────────
test('nvidia-h100 accepts valid JWT with matching nonce + iat', async () => {
  const env = baseEnv({
    attestation_type: 'nvidia-h100-cc',
    attestation_report: jwtOf({
      nonce: NONCE,
      iat: Math.floor(Date.now() / 1000),
      hwmodel: 'H100-80GB',
      gpu_id: 'GPU-abc123',
      driver_version: '535.104.05',
      vbios_version: '96.00.30.00.01',
    }),
  });
  const r = await nvidiaH100Verifier.verify(env as never, NONCE, 900);
  assert.equal(r.ok, true, `expected ok but got ${JSON.stringify(r)}`);
  assert.equal(r.gpu_id, 'GPU-abc123');
  assert.equal(r.driver_version, '535.104.05');
});

test('nvidia-h100 rejects mismatched nonce', async () => {
  const env = baseEnv({
    attestation_type: 'nvidia-h100-cc',
    attestation_report: jwtOf({ nonce: 'b'.repeat(64), iat: Math.floor(Date.now() / 1000), hwmodel: 'H100' }),
  });
  const r = await nvidiaH100Verifier.verify(env as never, NONCE, 900);
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /nonce/);
});

test('nvidia-h100 rejects non-H100 hwmodel', async () => {
  const env = baseEnv({
    attestation_type: 'nvidia-h100-cc',
    attestation_report: jwtOf({ nonce: NONCE, iat: Math.floor(Date.now() / 1000), hwmodel: 'A100-40GB' }),
  });
  const r = await nvidiaH100Verifier.verify(env as never, NONCE, 900);
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /hwmodel/);
});

test('nvidia-h100 rejects stale iat', async () => {
  const env = baseEnv({
    attestation_type: 'nvidia-h100-cc',
    attestation_report: jwtOf({ nonce: NONCE, iat: Math.floor(Date.now() / 1000) - 3600, hwmodel: 'H100' }),
  });
  const r = await nvidiaH100Verifier.verify(env as never, NONCE, 900);
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /iat/);
});

test('nvidia-h100 rejects malformed JWT', async () => {
  const env = baseEnv({
    attestation_type: 'nvidia-h100-cc',
    attestation_report: 'not-a-jwt',
  });
  const r = await nvidiaH100Verifier.verify(env as never, NONCE, 900);
  assert.equal(r.ok, false);
});

// ── Azure MAA ──────────────────────────────────────────────────────────
test('azure-maa accepts valid JWT', async () => {
  const env = baseEnv({
    attestation_type: 'azure-attestation-service',
    attestation_report: jwtOf({
      nonce: NONCE,
      iat: Math.floor(Date.now() / 1000),
      'x-ms-attestation-type': 'sevsnpvm',
    }),
  });
  const r = await azureMaaVerifier.verify(env as never, NONCE, 900);
  assert.equal(r.ok, true);
});

test('azure-maa rejects wrong nonce', async () => {
  const env = baseEnv({
    attestation_type: 'azure-attestation-service',
    attestation_report: jwtOf({ nonce: 'b'.repeat(64), iat: Math.floor(Date.now() / 1000) }),
  });
  const r = await azureMaaVerifier.verify(env as never, NONCE, 900);
  assert.equal(r.ok, false);
});

// ── Intel TDX ──────────────────────────────────────────────────────────
test('intel-tdx accepts report containing the nonce', async () => {
  const nonceBytes = Buffer.from(NONCE, 'hex');
  const junk = Buffer.alloc(600 - nonceBytes.length, 0x00);
  const report = Buffer.concat([junk, nonceBytes, Buffer.alloc(32, 0)]);
  const env = baseEnv({
    attestation_type: 'intel-tdx',
    attestation_report: report.toString('base64'),
  });
  const r = await intelTdxVerifier.verify(env as never, NONCE, 900);
  assert.equal(r.ok, true);
});

test('intel-tdx rejects report without the nonce', async () => {
  const report = Buffer.alloc(700, 0xff);  // all-0xff won't contain our nonce
  const env = baseEnv({
    attestation_type: 'intel-tdx',
    attestation_report: report.toString('base64'),
  });
  const r = await intelTdxVerifier.verify(env as never, NONCE, 900);
  assert.equal(r.ok, false);
});

// ── TPM 2.0 ────────────────────────────────────────────────────────────
test('tpm-2.0 accepts TPMS_ATTEST with magic + nonce', async () => {
  const magic = Buffer.alloc(4);
  magic.writeUInt32BE(0xff544347, 0);
  const nonceBytes = Buffer.from(NONCE, 'hex');
  const rest = Buffer.alloc(100, 0);
  const report = Buffer.concat([magic, rest, nonceBytes, Buffer.alloc(50, 0)]);
  const env = baseEnv({
    attestation_type: 'tpm-2.0-quote',
    attestation_report: report.toString('base64'),
  });
  const r = await tpm2Verifier.verify(env as never, NONCE, 900);
  assert.equal(r.ok, true);
});

test('tpm-2.0 rejects wrong magic', async () => {
  const bad = Buffer.alloc(200, 0xff);
  const env = baseEnv({
    attestation_type: 'tpm-2.0-quote',
    attestation_report: bad.toString('base64'),
  });
  const r = await tpm2Verifier.verify(env as never, NONCE, 900);
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /magic/);
});

// ── AWS Nitro (structural — synthesizing a minimal COSE_Sign1 is complex;
//     just verify the plugin rejects a plainly malformed input) ─────────
test('aws-nitro rejects malformed CBOR', async () => {
  const env = baseEnv({
    attestation_type: 'aws-nitro-enclave',
    attestation_report: 'aGVsbG8=',  // "hello"
  });
  const r = await awsNitroVerifier.verify(env as never, NONCE, 900);
  assert.equal(r.ok, false);
});
