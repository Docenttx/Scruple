// Tests for the SEV-SNP verifier plugin against the real captured
// attestation report from docs/l2-evidence/2026-07-12T174954Z/.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { _resetRegistryForTests } from '../dispatch.js';
import { sevSnpVerifier } from './sev_snp.js';

const FIXTURE_DIR = path.resolve(
  process.cwd(),
  '..', '..', 'docs', 'l2-evidence', '2026-07-12T174954Z',
);
const REPORT_PATH = path.join(FIXTURE_DIR, 'sev-snp-report.bin');
const CHAIN_PATH = path.join(FIXTURE_DIR, 'amd-cert-chain.pem');

// Expected values from report-summary.txt
const EXPECTED_NONCE = 'd5b782d80eb3e4f38ac8a54c1ff6ef496fb30fb841f0ebf417996eb73c7398ab';
const EXPECTED_MEASUREMENT = '7237c44bfc842925afa7860596631e8b7e28bcb679fc15c443e1a091c6ec3d1999b90c43b0580a414dde18cb3efbd45a';
// chip_id first 64 hex chars (32 bytes)
const EXPECTED_CHIP_ID_PREFIX = 'bd296e674119acb7367311bf0be06eaf0f6d15b5f0fc78d4f38653f46ca48baa';

let reportBytes: Buffer;
let chainPems: string[];
try {
  reportBytes = fs.readFileSync(REPORT_PATH);
  const chain = fs.readFileSync(CHAIN_PATH, 'utf8');
  // Split concatenated PEM into individual cert PEMs
  chainPems = [...chain.matchAll(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g)].map(
    (m) => m[0] + '\n',
  );
} catch {
  reportBytes = Buffer.alloc(0);
  chainPems = [];
}

function makeEnvelope(overrides: Partial<{ nonce: string; time: string; report_b64: string; chain: string[] }> = {}) {
  return {
    attestation_type: 'amd-sev-snp',
    attestation_report: overrides.report_b64 ?? reportBytes.toString('base64'),
    certificate_chain: overrides.chain ?? chainPems,
    nonce: overrides.nonce ?? EXPECTED_NONCE,
    attestation_time: overrides.time ?? new Date().toISOString(),
  };
}

const skipIfNoFixture = reportBytes.length === 0 ? { skip: 'fixture missing' } : {};

beforeEach(() => _resetRegistryForTests());

test('valid captured SEV-SNP report verifies OK', skipIfNoFixture, async () => {
  const env = makeEnvelope();
  const r = await sevSnpVerifier.verify(env, EXPECTED_NONCE, 900);
  assert.equal(r.ok, true, `expected ok but got ${JSON.stringify(r)}`);
  assert.equal(r.provider, 'amd-sev-snp');
  assert.equal(r.cvm_measurement_hex, EXPECTED_MEASUREMENT);
  assert.ok(r.chip_id?.startsWith(EXPECTED_CHIP_ID_PREFIX));
  assert.ok(r.benign_codes?.includes('sev-snp-signature-chain-not-yet-verified'));
});

test('report_data mismatch → ok: false', skipIfNoFixture, async () => {
  const env = makeEnvelope();
  const wrongNonce = 'b'.repeat(64);
  const r = await sevSnpVerifier.verify(env, wrongNonce, 900);
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /report_data\[0:32\]/);
});

test('mutated report bytes → parse failure', skipIfNoFixture, async () => {
  const bad = Buffer.from(reportBytes);
  bad[0x50] ^= 0xFF; // flip a bit in report_data
  const env = makeEnvelope({ report_b64: bad.toString('base64') });
  const r = await sevSnpVerifier.verify(env, EXPECTED_NONCE, 900);
  assert.equal(r.ok, false, 'flipped report_data first byte breaks nonce binding');
});

test('wrong report length → parse failure', skipIfNoFixture, async () => {
  const truncated = reportBytes.subarray(0, 1000);
  const env = makeEnvelope({ report_b64: truncated.toString('base64') });
  const r = await sevSnpVerifier.verify(env, EXPECTED_NONCE, 900);
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /length/);
});

test('stale attestation_time → ok: false', skipIfNoFixture, async () => {
  const env = makeEnvelope({ time: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString() });
  const r = await sevSnpVerifier.verify(env, EXPECTED_NONCE, 900);
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /old/);
});

test('empty cert chain → ok: false', skipIfNoFixture, async () => {
  const env = makeEnvelope({ chain: [] });
  const r = await sevSnpVerifier.verify(env, EXPECTED_NONCE, 900);
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /certificate_chain is empty/);
});

test('malformed cert PEM → ok: false', skipIfNoFixture, async () => {
  const env = makeEnvelope({ chain: ['-----BEGIN CERTIFICATE-----\nNOT-A-CERT\n-----END CERTIFICATE-----\n'] });
  const r = await sevSnpVerifier.verify(env, EXPECTED_NONCE, 900);
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /parse|ARK/);
});
