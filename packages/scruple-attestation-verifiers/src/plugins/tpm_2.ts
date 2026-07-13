// TPM 2.0 Quote verifier.
//
// TPMS_ATTEST + signature (RSA-SSA-PSS or ECDSA over TPMS_ATTEST bytes).
// extraData carries the nonce. AIK cert chains to platform TPM EK CA.
//
// V1 scope: STRUCTURAL. Full TPMS_ATTEST parsing + AIK sig verify +
// EK cert chain checks are a follow-up.

import type { AttestationEnvelope } from '../envelope.js';
import type { VerifierPlugin, VerifyResult } from '../verifier.js';
import { registerPlugin } from '../dispatch.js';

export const tpm2Verifier: VerifierPlugin = {
  attestation_type: 'tpm-2.0-quote',

  async verify(env, expected_nonce_hex, freshness_max_seconds): Promise<VerifyResult> {
    let bytes: Buffer;
    try {
      bytes = Buffer.from(env.attestation_report, 'base64');
    } catch (e) {
      return { ok: false, provider: 'tpm-2.0-quote', error: `report not base64: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (bytes.length < 32) {
      return { ok: false, provider: 'tpm-2.0-quote', error: `report too short (${bytes.length} bytes)` };
    }

    // TPMS_ATTEST layout begins with magic (0xff544347 = "\xffTCG") and
    // type (TPM_ST_ATTEST_QUOTE = 0x8018). Best-effort structural check.
    const magic = bytes.readUInt32BE(0);
    if (magic !== 0xff544347) {
      return { ok: false, provider: 'tpm-2.0-quote', error: `TPMS_ATTEST magic 0x${magic.toString(16)} != 0xff544347` };
    }

    // extraData contains the nonce — look for it in the report bytes.
    const expected = Buffer.from(expected_nonce_hex, 'hex');
    if (expected.length !== 32) {
      return { ok: false, provider: 'tpm-2.0-quote', error: 'expected_nonce_hex is not 32 bytes' };
    }
    if (bytes.indexOf(expected) === -1) {
      return { ok: false, provider: 'tpm-2.0-quote', error: 'expected nonce not present in TPMS_ATTEST extraData' };
    }

    const ageMs = Date.now() - Date.parse(env.attestation_time);
    if (ageMs > freshness_max_seconds * 1000) {
      return { ok: false, provider: 'tpm-2.0-quote', error: `attestation_time is ${Math.floor(ageMs / 1000)}s old` };
    }

    if (env.certificate_chain.length === 0) {
      return { ok: false, provider: 'tpm-2.0-quote', error: 'certificate_chain is empty (AIK cert missing)' };
    }

    return {
      ok: true,
      provider: 'tpm-2.0-quote',
      benign_codes: ['tpm-2.0-aik-signature-not-yet-verified'],
    };
  },
};

registerPlugin(tpm2Verifier);
