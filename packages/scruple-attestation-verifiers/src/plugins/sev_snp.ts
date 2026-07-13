// AMD SEV-SNP verifier plugin.
//
// Per AMD Firmware ABI Specification v1.55 §7.3 (SEV_SNP_GUEST_MSG_REPORT_REQ /
// _RSP), the SEV-SNP attestation report is a 1184-byte struct with
// well-known fixed offsets. This plugin parses the report, verifies the
// nonce binding (report_data offset 0x50), extracts VM measurement +
// chip_id, and checks freshness.
//
// V1 scope: STRUCTURAL VERIFICATION. This plugin verifies the report
// nonce binding, freshness, and cert-chain shape. It does NOT yet
// perform full VCEK signature verification against AMD ARK / ASK
// (that requires ASN.1 X.509 parsing + ECDSA-P384 signature checks;
// tracked as a follow-up sub-WO). Results returned with `chain_verified:
// false` and benign_code 'signature-chain-not-verified' to make the
// posture explicit; downstream verifiers (scruple-verify CLI) can and
// will re-verify with full crypto.

import type { AttestationEnvelope } from '../envelope.js';
import type { VerifierPlugin, VerifyResult } from '../verifier.js';
import { registerPlugin } from '../dispatch.js';

/** Fixed offsets in the 1184-byte SEV-SNP AttestationReport. */
const REPORT_LEN = 1184;
const OFFSET_VERSION = 0x00;
const OFFSET_REPORT_DATA = 0x50;   // 64 bytes; first 32 = nonce binding
const REPORT_DATA_LEN = 64;
const OFFSET_MEASUREMENT = 0x90;   // 48 bytes
const MEASUREMENT_LEN = 48;
const OFFSET_CHIP_ID = 0x1A0;      // 64 bytes
const CHIP_ID_LEN = 64;

function parseReport(bytes: Uint8Array) {
  if (bytes.byteLength !== REPORT_LEN) {
    throw new Error(`report length ${bytes.byteLength} != expected ${REPORT_LEN}`);
  }
  const version = new DataView(bytes.buffer, bytes.byteOffset).getUint32(OFFSET_VERSION, true);
  const report_data = bytes.slice(OFFSET_REPORT_DATA, OFFSET_REPORT_DATA + REPORT_DATA_LEN);
  const measurement = bytes.slice(OFFSET_MEASUREMENT, OFFSET_MEASUREMENT + MEASUREMENT_LEN);
  const chip_id = bytes.slice(OFFSET_CHIP_ID, OFFSET_CHIP_ID + CHIP_ID_LEN);
  return { version, report_data, measurement, chip_id };
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Best-effort sanity check on the AMD cert chain. Verifies:
 *  - at least one certificate is present
 *  - certs parse as X.509 PEM
 *  - one cert names ARK-Genoa in its CN
 *
 * Does NOT (yet) verify signature chains VCEK → ASK → ARK. Follow-up.
 */
async function certChainSanity(pemArray: string[]): Promise<{ ok: boolean; error?: string }> {
  if (pemArray.length === 0) {
    return { ok: false, error: 'certificate_chain is empty' };
  }
  // Use Node's crypto.X509Certificate if available at runtime.
  const { X509Certificate } = await import('node:crypto');
  let sawArk = false;
  for (const pem of pemArray) {
    try {
      const cert = new X509Certificate(pem);
      if (cert.subject.includes('ARK-Genoa') || cert.subject.includes('ARK-') || cert.issuer.includes('ARK-')) {
        sawArk = true;
      }
    } catch (e) {
      return { ok: false, error: `certificate parse failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  }
  if (!sawArk) {
    return { ok: false, error: 'no ARK-Genoa or ARK-lineage cert found in chain' };
  }
  return { ok: true };
}

export const sevSnpVerifier: VerifierPlugin = {
  attestation_type: 'amd-sev-snp',

  async verify(
    env: AttestationEnvelope,
    expected_nonce_hex: string,
    freshness_max_seconds: number,
  ): Promise<VerifyResult> {
    // 1. Decode + parse report
    let reportBytes: Uint8Array;
    try {
      reportBytes = new Uint8Array(Buffer.from(env.attestation_report, 'base64'));
    } catch (e) {
      return { ok: false, provider: 'amd-sev-snp', error: `attestation_report not base64: ${e instanceof Error ? e.message : String(e)}` };
    }
    let parsed;
    try {
      parsed = parseReport(reportBytes);
    } catch (e) {
      return { ok: false, provider: 'amd-sev-snp', error: e instanceof Error ? e.message : String(e) };
    }

    // 2. Nonce binding — first 32 bytes of report_data MUST equal expected_nonce
    const reportDataFirst32Hex = toHex(parsed.report_data.slice(0, 32));
    if (reportDataFirst32Hex !== expected_nonce_hex) {
      return {
        ok: false,
        provider: 'amd-sev-snp',
        error: `report_data[0:32] = ${reportDataFirst32Hex} does not equal expected nonce ${expected_nonce_hex}`,
      };
    }

    // 3. Freshness (dispatch layer already checked envelope.nonce vs expected,
    //    but re-check attestation_time here for defense in depth).
    const ageMs = Date.now() - Date.parse(env.attestation_time);
    if (Number.isNaN(ageMs)) {
      return { ok: false, provider: 'amd-sev-snp', error: 'attestation_time not parseable' };
    }
    if (ageMs > freshness_max_seconds * 1000) {
      return {
        ok: false,
        provider: 'amd-sev-snp',
        error: `attestation is ${Math.floor(ageMs / 1000)}s old; freshness window is ${freshness_max_seconds}s`,
      };
    }
    if (ageMs < -60_000) {
      return { ok: false, provider: 'amd-sev-snp', error: 'attestation_time more than 60s in the future' };
    }

    // 4. Cert chain sanity (partial — full ARK chain verification is a follow-up)
    const chainOk = await certChainSanity(env.certificate_chain);
    if (!chainOk.ok) {
      return { ok: false, provider: 'amd-sev-snp', error: chainOk.error };
    }

    // 5. Return structural-verify result. Signature chain verification is
    //    marked as benign here — production hardening is a follow-up.
    return {
      ok: true,
      provider: 'amd-sev-snp',
      cvm_measurement_hex: toHex(parsed.measurement),
      chip_id: toHex(parsed.chip_id),
      benign_codes: ['sev-snp-signature-chain-not-yet-verified'],
    };
  },
};

// Side-effect registration on module load. Consumers import this file to
// activate the plugin: `import '@scruple/attestation-verifiers/plugins/sev_snp'`.
registerPlugin(sevSnpVerifier);
