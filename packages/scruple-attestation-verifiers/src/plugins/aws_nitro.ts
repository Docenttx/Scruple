// AWS Nitro Enclave attestation verifier.
//
// Attestation documents are CBOR-encoded, COSE_Sign1-wrapped. Payload
// includes PCRs, module_id, timestamp, nonce (user-supplied).
//
// V1 scope: STRUCTURAL. Full COSE signature verify against AWS Nitro
// root PKI is a follow-up (needs cose-js or similar). This plugin
// decodes the top-level CBOR, extracts nonce + timestamp + module_id
// from the payload map, and returns structural verify.

import { verifyPassthrough } from '../verifier.js';
import type { AttestationEnvelope } from '../envelope.js';
import type { VerifierPlugin, VerifyResult } from '../verifier.js';
import { registerPlugin } from '../dispatch.js';

/**
 * Minimal CBOR decoder for the subset we need: array/map/bstr/tstr/int.
 * Enough to peek at the COSE_Sign1 array [protected, unprotected, payload, signature]
 * and then decode the payload map. Full CBOR is not needed here.
 */
function decodeCbor(buf: Buffer, offset = 0): { value: unknown; next: number } {
  const b = buf[offset];
  const major = b >> 5;
  const low = b & 0x1f;
  let val: number;
  let cursor = offset + 1;
  if (low < 24) {
    val = low;
  } else if (low === 24) {
    val = buf.readUInt8(cursor); cursor += 1;
  } else if (low === 25) {
    val = buf.readUInt16BE(cursor); cursor += 2;
  } else if (low === 26) {
    val = buf.readUInt32BE(cursor); cursor += 4;
  } else if (low === 27) {
    // 64-bit — treat as Number for our purposes (timestamps fit)
    val = Number(buf.readBigUInt64BE(cursor)); cursor += 8;
  } else {
    throw new Error(`unsupported CBOR length ${low} at offset ${offset}`);
  }

  switch (major) {
    case 0: return { value: val, next: cursor };  // uint
    case 1: return { value: -1 - val, next: cursor };  // negint
    case 2: {  // bstr
      const slice = buf.subarray(cursor, cursor + val);
      return { value: slice, next: cursor + val };
    }
    case 3: {  // tstr
      const slice = buf.subarray(cursor, cursor + val).toString('utf8');
      return { value: slice, next: cursor + val };
    }
    case 4: {  // array
      const arr: unknown[] = [];
      let c = cursor;
      for (let i = 0; i < val; i++) {
        const r = decodeCbor(buf, c);
        arr.push(r.value);
        c = r.next;
      }
      return { value: arr, next: c };
    }
    case 5: {  // map
      const map: Record<string, unknown> = {};
      let c = cursor;
      for (let i = 0; i < val; i++) {
        const k = decodeCbor(buf, c);
        const v = decodeCbor(buf, k.next);
        map[String(k.value)] = v.value;
        c = v.next;
      }
      return { value: map, next: c };
    }
    case 6: {
      // Tagged — skip tag and decode inner
      const inner = decodeCbor(buf, cursor);
      return { value: inner.value, next: inner.next };
    }
    default:
      throw new Error(`unsupported CBOR major type ${major}`);
  }
}

export const awsNitroVerifier: VerifierPlugin = {
  attestation_type: 'aws-nitro-enclave',

  async verify(env, expected_nonce_hex, freshness_max_seconds): Promise<VerifyResult> {
    // 1. Base64-decode the attestation_report
    let outer: Buffer;
    try {
      outer = Buffer.from(env.attestation_report, 'base64');
    } catch (e) {
      return { ok: false, provider: 'aws-nitro-enclave', error: `report not base64: ${e instanceof Error ? e.message : String(e)}` };
    }

    // 2. Decode the outer COSE_Sign1 array — [protected_hdr, unprotected_hdr, payload_bstr, signature_bstr]
    let coseArr: unknown;
    try {
      coseArr = decodeCbor(outer).value;
    } catch (e) {
      return { ok: false, provider: 'aws-nitro-enclave', error: `CBOR decode failed: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (!Array.isArray(coseArr) || coseArr.length < 4) {
      return { ok: false, provider: 'aws-nitro-enclave', error: 'not a COSE_Sign1 4-element array' };
    }
    const payloadBstr = coseArr[2];
    if (!(payloadBstr instanceof Buffer) && !(payloadBstr instanceof Uint8Array)) {
      return { ok: false, provider: 'aws-nitro-enclave', error: 'COSE payload is not bytes' };
    }

    // 3. Decode the payload map
    let payload: Record<string, unknown>;
    try {
      payload = decodeCbor(Buffer.from(payloadBstr)).value as Record<string, unknown>;
    } catch (e) {
      return { ok: false, provider: 'aws-nitro-enclave', error: `payload decode failed: ${e instanceof Error ? e.message : String(e)}` };
    }

    // 4. Nonce (in Nitro this is called 'nonce' — user-supplied bytes)
    const nonceRaw = payload.nonce;
    const nonceHex = nonceRaw instanceof Uint8Array
      ? Buffer.from(nonceRaw).toString('hex')
      : typeof nonceRaw === 'string' ? nonceRaw : '';
    if (nonceHex !== expected_nonce_hex) {
      return {
        ok: false,
        provider: 'aws-nitro-enclave',
        error: `nonce ${nonceHex || '(missing)'} does not equal expected ${expected_nonce_hex}`,
      };
    }

    // 5. Freshness — timestamp in ms
    const ts = typeof payload.timestamp === 'number' ? payload.timestamp : NaN;
    if (Number.isNaN(ts)) {
      return { ok: false, provider: 'aws-nitro-enclave', error: 'timestamp missing or invalid' };
    }
    const ageMs = Date.now() - ts;
    if (ageMs > freshness_max_seconds * 1000) {
      return { ok: false, provider: 'aws-nitro-enclave', error: `timestamp is ${Math.floor(ageMs / 1000)}s old` };
    }

    // 6. Cert chain sanity
    if (env.certificate_chain.length === 0) {
      return { ok: false, provider: 'aws-nitro-enclave', error: 'certificate_chain is empty' };
    }

    const module_id = typeof payload.module_id === 'string' ? payload.module_id : undefined;
    const pcrsMap = payload.pcrs;
    let pcr_0: string | undefined;
    if (pcrsMap && typeof pcrsMap === 'object') {
      const p0 = (pcrsMap as Record<string, unknown>)['0'];
      if (p0 instanceof Uint8Array) pcr_0 = Buffer.from(p0).toString('hex');
    }

    // §12.4 passthrough — document parsed and PCRs read, COSE signature
    // not chained to the AWS Nitro root.
    return verifyPassthrough(
      'aws-nitro-enclave',
      'AWS Nitro attestation document parsed and nonce matched, but the COSE signature was not verified to the AWS Nitro root.',
      { module_id, pcr_0, benign_codes: ['aws-nitro-cose-signature-not-yet-verified'] },
    );
  },
};

registerPlugin(awsNitroVerifier);
