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
//   vault-py   SCRUPLE_WITNESS_SIGNER=vault-py
//              Shells out to services/c2pa-signer/sign_leaf.py, a thin
//              wrapper over vault_sign.py. THIS IS THE PRODUCTION PATH.
//
//   disabled   default. No ECDSA signature; leaves carry the HMAC alone,
//              exactly as before. Chosen deliberately so enabling H-1 is
//              an explicit act and not something that happens because a
//              variable was set somewhere.
//
// WHY vault-py SHELLS OUT INSTEAD OF REIMPLEMENTING
//
// Real OCI KMS requires draft-cavage request signing with
// instance-principal credentials. vault_sign.py already does that, and
// not theoretically — it signed the 33 conformance samples on the
// production Signer CVM for the GPSA v3 resubmission. A second
// implementation in Node would be a second thing to get right, a second
// thing to keep right, and almost certainly a second key.
//
// That last point decides it. Standard §2 says Scruple witnesses events
// and the integration "through the SAME signing key". Signing leaves
// through the same SCRUPLE_C2PA_VAULT_KEY_OCID the C2PA signer uses makes
// that sentence literally true. A separate Node client would leave it
// aspirational.
//
// The cost is a subprocess per leaf. Accepted for now: correctness and a
// true §2 claim are worth more than the latency, and if it becomes a
// bottleneck the fix is a persistent local signing sidecar, not a
// reimplementation.

const crypto = require('crypto');
const http = require('http');
const https = require('https');
const path = require('path');
const { execFile } = require('child_process');
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

const SIGN_LEAF_PY = () =>
  process.env.SCRUPLE_WITNESS_SIGN_LEAF_PY ||
  path.join(__dirname, '..', 'c2pa-signer', 'sign_leaf.py');

const PYTHON_BIN = () => process.env.SCRUPLE_PYTHON_BIN || 'python3';

function mode() {
  if (process.env.SCRUPLE_WITNESS_SIGNER === 'vault-py') return 'vault-py';
  return ENDPOINT() && KEY_OCID() ? 'kms-http' : 'disabled';
}

/**
 * Production path: sign through the same code and the same key the C2PA
 * signer uses. Never throws — a non-zero exit means no signature, and the
 * leaf is recorded as not independently verifiable, which is the truth.
 */
function signViaVaultPy(leafHashHex) {
  return new Promise((resolve) => {
    execFile(
      PYTHON_BIN(), [SIGN_LEAF_PY(), leafHashHex],
      { timeout: TIMEOUT_MS(), maxBuffer: 1 << 20 },
      (err, stdout, stderr) => {
        if (err) {
          // A configuration fault and a signing outage need different
          // reactions, and a bare non-zero exit cannot tell them apart.
          // sign_leaf.py exits 3 with code:'local_key_missing' when the
          // box has no signing key — a state in which EVERY leaf will be
          // recorded unsigned, forever, and no retry helps. That ran from
          // 2026-07-13 to 2026-09-02 behind a one-line log nobody read.
          // CANON_SKELETON D-10 (§7): a failed Phase-3 operation surfaces.
          let detail = null;
          try { detail = JSON.parse(String(stderr)); } catch { /* not JSON */ }
          if (detail && detail.retryable === false) {
            console.error(
              `[leaf_signer] ####################################################\n` +
              `[leaf_signer] MISCONFIGURED (${detail.code}): ${detail.error}\n` +
              `[leaf_signer] EVERY witness leaf is being recorded UNSIGNED and\n` +
              `[leaf_signer] cannot be independently verified. Retrying will\n` +
              `[leaf_signer] not help. Fix the configuration.\n` +
              `[leaf_signer] ####################################################`,
            );
          } else {
            console.error(`[leaf_signer] sign_leaf.py failed: ${String(stderr).slice(0, 300)}`);
          }
          return resolve(null);
        }
        try {
          const d = JSON.parse(stdout);
          if (!d.signature) throw new Error('no signature field');
          resolve({
            signature: d.signature,
            key_id: d.key_id,
            key_version_id: null,
            alg: d.alg,
            // A local-mode key is a development key. Marking it here means
            // a dev-signed leaf is distinguishable at rest, exactly as a
            // surrogate-signed one is.
            surrogate: d.mode !== 'vault',
          });
        } catch (e) {
          console.error(`[leaf_signer] sign_leaf.py output unparseable: ${e.message}`);
          resolve(null);
        }
      },
    );
  });
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
  if (mode() === 'vault-py') return signViaVaultPy(leafHashHex);

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
  if (mode() === 'vault-py') {
    // DERIVE THE TRUTH WHERE WE CAN, rather than trusting configuration.
    //
    // In local mode sign_leaf.py can emit the actual verifying key for the
    // actual signing key. A configured PUBKEY_URL is deliberately IGNORED
    // here: an inherited or stale URL would publish a key that does not
    // match the signature, and every verification would fail with no
    // indication why. A test caught exactly that.
    //
    // In real vault mode the private key never leaves OCI, so the public
    // half must come from the KMS management API and the URL is the only
    // source available.
    const isVault = Boolean(process.env.SCRUPLE_C2PA_VAULT_KEY_OCID);
    if (!isVault) {
      if (PUBKEY_URL()) {
        console.warn(
          '[leaf_signer] SCRUPLE_WITNESS_KMS_PUBKEY_URL is set but ignored in ' +
          'local vault-py mode — the key is derived from the signing key itself.',
        );
      }
      return new Promise((resolve) => {
        execFile(PYTHON_BIN(), [SIGN_LEAF_PY(), '--pubkey'],
          { timeout: TIMEOUT_MS() },
          (err, stdout) => resolve(err ? null : stdout));
      });
    }
  }
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
    surrogate: mode() === 'vault-py'
      ? !process.env.SCRUPLE_C2PA_VAULT_KEY_OCID
      : /\.surrogate\.|us-surrogate-1/.test(KEY_OCID()),
    // The honest headline. A leaf with no ECDSA signature is verifiable
    // only by Scruple, and anything presenting it must say so.
    independently_verifiable: mode() !== 'disabled',
  };
}

/**
 * Does the key we publish actually verify what we sign?
 *
 * Publishing a public key that does not match the signing key is a silent
 * catastrophe: every leaf looks signed, every verification fails, and
 * nothing in the system notices. It is the same shape as the assertion
 * allowlist bug — a mismatch between two places that must agree, with no
 * check that they do.
 *
 * So: sign a probe, fetch the published key, verify. Cheap, and it turns
 * a class of silent misconfiguration into a startup-visible fact.
 */
async function selfCheck() {
  if (mode() === 'disabled') {
    return { ok: true, mode: 'disabled', note: 'Leaf signing is off; nothing to check.' };
  }
  const probe = crypto.randomBytes(32).toString('hex');
  const sig = await signLeaf(probe);
  if (!sig) return { ok: false, mode: mode(), error: 'signing failed' };
  const pem = await publicKeyPem();
  if (!pem) {
    return {
      ok: false, mode: mode(),
      error: 'no public key is published, so no third party can verify a leaf',
    };
  }
  try {
    const verified = crypto.verify(
      'sha256', Buffer.from(probe, 'hex'),
      crypto.createPublicKey(pem), Buffer.from(sig.signature, 'base64'),
    );
    return verified
      ? { ok: true, mode: mode(), key_id: sig.key_id }
      : {
          ok: false, mode: mode(), key_id: sig.key_id,
          error: 'THE PUBLISHED KEY DOES NOT VERIFY OUR OWN SIGNATURE — every ' +
                 'leaf signed in this configuration is unverifiable by anyone.',
        };
  } catch (e) {
    return { ok: false, mode: mode(), error: `verification threw: ${e.message}` };
  }
}

module.exports = { signLeaf, publicKeyPem, info, mode, selfCheck };
