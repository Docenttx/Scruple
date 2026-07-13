// NVIDIA H100 Confidential Compute attestation verifier.
//
// NVIDIA Attestation SDK / cuVerifier produces a signed JWT with claims:
//   nonce (caller-supplied, hex)
//   hwmodel (e.g., "H100-80GB")
//   gpu_id
//   vbios_version
//   driver_version
//   iat (issued at)
//   measurements (GPU state)
//
// The JWT is signed by NVIDIA's Device Identity Certificate; that cert
// chains to NVIDIA's root CA.
//
// V1 scope (matching SEV-SNP): STRUCTURAL VERIFICATION. Full JWT
// signature verification against NVIDIA root is a follow-up (requires
// pinning the NVIDIA root CA + a JWS library). This plugin verifies:
//   - JWT parses
//   - nonce claim matches expected
//   - iat within freshness window
//   - hwmodel appears H100-family
//   - cert chain contains at least one PEM
// and returns benign_code 'nvidia-h100-signature-chain-not-yet-verified'.

import type { AttestationEnvelope } from '../envelope.js';
import type { VerifierPlugin, VerifyResult } from '../verifier.js';
import { registerPlugin } from '../dispatch.js';

function base64UrlDecode(s: string): Buffer {
  // JWT uses URL-safe base64 without padding
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

export const nvidiaH100Verifier: VerifierPlugin = {
  attestation_type: 'nvidia-h100-cc',

  async verify(env, expected_nonce_hex, freshness_max_seconds): Promise<VerifyResult> {
    // 1. Parse JWT
    const parts = env.attestation_report.split('.');
    if (parts.length !== 3) {
      return { ok: false, provider: 'nvidia-h100-cc', error: 'attestation_report is not a well-formed JWT (expected 3 parts)' };
    }
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(base64UrlDecode(parts[1]).toString('utf8'));
    } catch (e) {
      return { ok: false, provider: 'nvidia-h100-cc', error: `JWT payload decode failed: ${e instanceof Error ? e.message : String(e)}` };
    }

    // 2. Nonce binding
    if (typeof payload.nonce !== 'string' || payload.nonce !== expected_nonce_hex) {
      return {
        ok: false,
        provider: 'nvidia-h100-cc',
        error: `nonce claim ${String(payload.nonce)} does not equal expected ${expected_nonce_hex}`,
      };
    }

    // 3. Freshness (iat is unix seconds)
    const iat = typeof payload.iat === 'number' ? payload.iat : NaN;
    if (Number.isNaN(iat)) {
      return { ok: false, provider: 'nvidia-h100-cc', error: 'JWT iat missing or invalid' };
    }
    const ageSec = Date.now() / 1000 - iat;
    if (ageSec > freshness_max_seconds) {
      return {
        ok: false,
        provider: 'nvidia-h100-cc',
        error: `JWT iat is ${Math.floor(ageSec)}s old; freshness window is ${freshness_max_seconds}s`,
      };
    }
    if (ageSec < -60) {
      return { ok: false, provider: 'nvidia-h100-cc', error: 'JWT iat is more than 60s in the future' };
    }

    // 4. Hardware model check
    const hwmodel = typeof payload.hwmodel === 'string' ? payload.hwmodel : '';
    if (!/^H100/i.test(hwmodel)) {
      return { ok: false, provider: 'nvidia-h100-cc', error: `hwmodel '${hwmodel}' is not H100-family` };
    }

    // 5. Cert chain sanity — at least one PEM
    if (env.certificate_chain.length === 0) {
      return { ok: false, provider: 'nvidia-h100-cc', error: 'certificate_chain is empty' };
    }

    return {
      ok: true,
      provider: 'nvidia-h100-cc',
      gpu_id: typeof payload.gpu_id === 'string' ? payload.gpu_id : undefined,
      driver_version: typeof payload.driver_version === 'string' ? payload.driver_version : undefined,
      vbios_version: typeof payload.vbios_version === 'string' ? payload.vbios_version : undefined,
      benign_codes: ['nvidia-h100-signature-chain-not-yet-verified'],
    };
  },
};

registerPlugin(nvidiaH100Verifier);
