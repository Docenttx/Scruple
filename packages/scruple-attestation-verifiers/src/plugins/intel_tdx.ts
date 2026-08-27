// Intel TDX Quote verifier.
//
// TDX Quotes are versioned binary structs (v4/v5). Report data (64B)
// binds the nonce; MR_TD is the TD measurement; TCB collateral chains
// through Intel PCS to Intel root.
//
// V1 scope: STRUCTURAL. Full DCAP quote verification (TCB fetch,
// signature chain) is a follow-up.

import { verifyPassthrough } from '../verifier.js';
import type { AttestationEnvelope } from '../envelope.js';
import type { VerifierPlugin, VerifyResult } from '../verifier.js';
import { registerPlugin } from '../dispatch.js';

// TDX Quote v4/v5 report_data offset varies by version but is
// consistently in the TD_REPORT body block, first 64 bytes of the
// user-data section. For v5 the TDREPORT body starts at offset 48
// (after quote header), with report_data at TDREPORT+520.
// We do a best-effort structural check and support both v4/v5 by
// scanning for the nonce anywhere in a small window.

export const intelTdxVerifier: VerifierPlugin = {
  attestation_type: 'intel-tdx',

  async verify(env, expected_nonce_hex, freshness_max_seconds): Promise<VerifyResult> {
    let bytes: Buffer;
    try {
      bytes = Buffer.from(env.attestation_report, 'base64');
    } catch (e) {
      return { ok: false, provider: 'intel-tdx', error: `report not base64: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (bytes.length < 600) {
      return { ok: false, provider: 'intel-tdx', error: `report too short (${bytes.length} bytes; expected 600+)` };
    }

    // Best-effort nonce match: TDX report_data is 64 bytes; we look for
    // the first 32-byte nonce in the report body. Full offset math
    // requires v-specific parsing which is deferred.
    const expected = Buffer.from(expected_nonce_hex, 'hex');
    if (expected.length !== 32) {
      return { ok: false, provider: 'intel-tdx', error: 'expected_nonce_hex is not 32 bytes' };
    }
    if (bytes.indexOf(expected) === -1) {
      return { ok: false, provider: 'intel-tdx', error: 'expected nonce not present in report bytes' };
    }

    // Freshness — TDX quotes don't embed a timestamp; rely on
    // envelope.attestation_time already checked at dispatch layer plus
    // this re-check.
    const ageMs = Date.now() - Date.parse(env.attestation_time);
    if (ageMs > freshness_max_seconds * 1000) {
      return { ok: false, provider: 'intel-tdx', error: `attestation_time is ${Math.floor(ageMs / 1000)}s old` };
    }

    if (env.certificate_chain.length === 0) {
      return { ok: false, provider: 'intel-tdx', error: 'certificate_chain is empty' };
    }

    // §12.4 passthrough — quote parsed, nonce matched, signature not
    // chained to the Intel provisioning root.
    return verifyPassthrough(
      'intel-tdx',
      'Intel TDX quote parsed and nonce matched, but the quote signature was not verified to the Intel provisioning root.',
      { benign_codes: ['tdx-quote-signature-chain-not-yet-verified'] },
    );
  },
};

registerPlugin(intelTdxVerifier);
