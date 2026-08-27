'use strict';
//
// H-1 — asymmetric leaf signing.
//
// THE PROBLEM THIS SOLVES
//
// Every witness leaf has been sealed with an HMAC over a secret this
// server holds. That seal has two properties which are fine for a
// transport check and disqualifying for evidence: Scruple can forge any
// leaf, and nobody but Scruple can verify one. Meanwhile the C2PA
// manifest sitting beside it is ECDSA-signed by a key in an HSM inside
// an attested Confidential VM. The evidence layer sat below the
// compliance artifact it contains. See docs/canon/L2_FLOOR.md.
//
// This module signs the leaf hash with ECDSA P-256 via the same OCI Vault
// KMS Sign API the C2PA signer already uses, so a third party holding the
// public key can verify a leaf without Scruple's cooperation and without
// OCI credentials.
//
// THE HMAC DOES NOT GO AWAY. It is demoted to what it always was — a
// transport seal between the application tier and this service (H-2).
// Nothing in a receipt derives its trustworthiness from it any more.
//
// MODES
//
//   kms-http   SCRUPLE_WITNESS_KMS_ENDPOINT + SCRUPLE_WITNESS_KMS_KEY_OCID
//              POSTs {endpoint}/20180608/sign. Wire-identical to OCI KMS
//              Crypto, so this talks to services/cvm-surrogate today and
//              to the real Vault the moment request signing lands.
//
//   disabled   default. No ECDSA signature; leaves carry the HMAC alone,
//              exactly as before. Chosen deliberately so enabling H-1 is
//              an explicit act and not something that happens because a
//              variable was set somewhere.
//
// PRODUCTION GAP, STATED PLAINLY
//
// Real OCI KMS requires request signing (draft-cavage HTTP signatures)
// with instance-principal credentials. This module does NOT implement
// that. Two options, neither chosen here:
//   (a) add the oci-sdk npm package and use KmsCryptoClient, mirroring
//       services/c2pa-signer/vault_sign.py;
//   (b) shell out to vault_sign.py, which already does instance-principal
//       auth correctly — proven code, at a subprocess per leaf.
// Until one lands, kms-http works against the surrogate and against any
// endpoint that does not demand OCI request signing.

const http = require('http');
const https = require('https');
const { URL } = require('url');

// Read at CALL time, not module load. Two reasons, and the second is the
// real one: it makes the module testable without process restarts, and it
// means an operator can change the signing configuration without bouncing
// the witness — which matters when the alternative is a gap in the audit
// chain while the service restarts.
const ENDPOINT = () => process.env.SCRUPLE_WITNESS_KMS_ENDPOINT || '';
const KEY_OCID = () => process.env.SCRUPLE_WITNESS_KMS_KEY_OCID || '';
const PUBKEY_URL = () => process.env.SCRUPLE_WITNESS_KMS_PUBKEY_URL || '';
const TIMEOUT_MS = () => Number(process.env.SCRUPLE_WITNESS_KMS_TIMEOUT_MS || 4000);

const ALG = 'ECDSA_SHA_256';

function mode() {
  return ENDPOINT() && KEY_OCID() ? 'kms-http' : 'disabled';
}

function request(urlStr, { method = 'GET', body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(
      u,
      { method, headers, timeout: TIMEOUT_MS() },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, body: Buffer.concat(chunks), headers: res.headers }));
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error(`KMS timeout after ${TIMEOUT_MS()}ms`)));
    if (body) req.write(body);
    req.end();
  });
}

/**
 * Sign a leaf hash. Returns null when signing is disabled — the caller
 * stores the HMAC alone and the leaf is honestly marked as not
 * independently verifiable.
 *
 * NEVER THROWS PAST THE CALLER'S CONTROL. A KMS outage must not stop the
 * witness recording the event: losing the leaf entirely is worse than
 * recording one whose independent verifiability is pending. The failure
 * is returned, not hidden — the leaf's signature fields stay null and
 * anything reading them can tell.
 */
async function signLeaf(leafHashHex) {
  if (mode() === 'disabled') return null;

  const message = Buffer.from(leafHashHex, 'hex').toString('base64');
  const payload = JSON.stringify({
    keyId: KEY_OCID(),
    message,
    messageType: 'RAW',
    signingAlgorithm: ALG,
  });

  try {
    const res = await request(`${ENDPOINT().replace(/\/$/, '')}/20180608/sign`, {
      method: 'POST',
      body: payload,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    });
    if (res.status !== 200) {
      console.error(`[leaf_signer] KMS returned ${res.status}: ${res.body.toString().slice(0, 200)}`);
      return null;
    }
    const parsed = JSON.parse(res.body.toString());
    if (!parsed.signature) {
      console.error('[leaf_signer] KMS response had no signature field');
      return null;
    }
    return {
      // base64 of the DER-encoded ECDSA signature, exactly as OCI returns
      // it. Stored unchanged so a verifier can decode it with any
      // standard library rather than a Scruple-specific convention.
      signature: parsed.signature,
      key_id: parsed.keyId || KEY_OCID(),
      key_version_id: parsed.keyVersionId || null,
      alg: parsed.signingAlgorithm || ALG,
      // Surrogate-signed leaves must be distinguishable from real ones at
      // rest, not only at signing time.
      surrogate: /\.surrogate\.|us-surrogate-1/.test(parsed.keyId || KEY_OCID()),
    };
  } catch (e) {
    console.error(`[leaf_signer] KMS sign failed: ${e.message}`);
    return null;
  }
}

/** The verifying key, so a third party can check a leaf without us. */
async function publicKeyPem() {
  if (mode() === 'disabled' || !PUBKEY_URL()) return null;
  try {
    const res = await request(PUBKEY_URL());
    if (res.status !== 200) return null;
    return res.body.toString();
  } catch (e) {
    console.error(`[leaf_signer] public key fetch failed: ${e.message}`);
    return null;
  }
}

function info() {
  return {
    mode: mode(),
    key_id: KEY_OCID() || null,
    algorithm: mode() === 'disabled' ? null : ALG,
    surrogate: /\.surrogate\.|us-surrogate-1/.test(KEY_OCID()),
    // The honest headline. A leaf with no ECDSA signature is verifiable
    // only by Scruple, and anything presenting it must say so.
    independently_verifiable: mode() !== 'disabled',
  };
}

module.exports = { signLeaf, publicKeyPem, info, mode };
