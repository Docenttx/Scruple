// Microsoft Azure Attestation Service (MAA) verifier.
//
// MAA issues JWTs from a per-region endpoint. Payload claims:
//   nonce                         (caller-supplied)
//   iat                           (issued at, unix seconds)
//   x-ms-attestation-type         ('sevsnpvm', 'tdxvm', 'sgx', etc.)
//   x-ms-compliance-status        (e.g., 'azure-compliant-cvm')
//   x-ms-runtime                  (measurements)
// Signed by MAA's JWKS (fetched from <endpoint>/certs, cached 24h).
//
// V1 scope: STRUCTURAL. Full JWS signature verify against MAA JWKS is
// a follow-up (requires JWKS caching + jose library).

import type { AttestationEnvelope } from '../envelope.js';
import type { VerifierPlugin, VerifyResult } from '../verifier.js';
import { registerPlugin } from '../dispatch.js';

function base64UrlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

export const azureMaaVerifier: VerifierPlugin = {
  attestation_type: 'azure-attestation-service',

  async verify(env, expected_nonce_hex, freshness_max_seconds): Promise<VerifyResult> {
    const parts = env.attestation_report.split('.');
    if (parts.length !== 3) {
      return { ok: false, provider: 'azure-attestation-service', error: 'not a well-formed JWT' };
    }
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(base64UrlDecode(parts[1]).toString('utf8'));
    } catch (e) {
      return { ok: false, provider: 'azure-attestation-service', error: `JWT payload decode: ${e instanceof Error ? e.message : String(e)}` };
    }

    const nonce = typeof payload.nonce === 'string' ? payload.nonce : '';
    if (nonce !== expected_nonce_hex) {
      return { ok: false, provider: 'azure-attestation-service', error: `nonce ${nonce || '(missing)'} does not equal expected ${expected_nonce_hex}` };
    }

    const iat = typeof payload.iat === 'number' ? payload.iat : NaN;
    if (Number.isNaN(iat)) {
      return { ok: false, provider: 'azure-attestation-service', error: 'JWT iat missing or invalid' };
    }
    const ageSec = Date.now() / 1000 - iat;
    if (ageSec > freshness_max_seconds) {
      return { ok: false, provider: 'azure-attestation-service', error: `iat is ${Math.floor(ageSec)}s old` };
    }

    return {
      ok: true,
      provider: 'azure-attestation-service',
      benign_codes: ['maa-jws-signature-not-yet-verified'],
    };
  },
};

registerPlugin(azureMaaVerifier);
