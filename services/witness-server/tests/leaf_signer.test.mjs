// H-1 — the witness leaf becomes independently verifiable.
//
// Standard §2 claims Scruple witnesses workflow events and the
// integration itself "through the same signing key" as the C2PA signer.
// Until H-1 that was aspirational: the C2PA manifest was ECDSA-signed by
// an HSM key inside an attested CVM, while the leaf beside it carried an
// HMAC over a secret this server holds — forgeable by Scruple, checkable
// by nobody else.
//
// These tests run against services/cvm-surrogate, so they need no CVM.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SURROGATE = path.join(HERE, '..', 'cvm-surrogate', 'surrogate.py');
const KEY_OCID =
  'ocid1.key.oc1.us-surrogate-1.surrogate.aaaaaaaaSURROGATEKEYnotarealkey';

let proc;
let BASE;

async function waitFor(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try { await fetch(url); return true; } catch { await new Promise(r => setTimeout(r, 100)); }
  }
  return false;
}

before(async () => {
  const port = 8000 + Math.floor(process.pid % 900);
  BASE = `http://127.0.0.1:${port}`;
  proc = spawn('python3', [SURROGATE], {
    env: { ...process.env, SURROGATE_PORT: String(port),
           SURROGATE_KEY_PATH: `/tmp/h1-key-${port}.pem` },
    stdio: 'ignore',
  });
  assert.ok(await waitFor(`${BASE}/health`), 'surrogate did not start');
  process.env.SCRUPLE_WITNESS_KMS_ENDPOINT = BASE;
  process.env.SCRUPLE_WITNESS_KMS_KEY_OCID = KEY_OCID;
  process.env.SCRUPLE_WITNESS_KMS_PUBKEY_URL = `${BASE}/testnet/pubkey.pem`;
});

after(() => { if (proc) proc.kill(); });

async function loadSigner() {
  // Fresh import each time so env changes take effect.
  const mod = await import(`../leaf_signer.js?t=${Date.now()}`);
  return mod.default ?? mod;
}

describe('signing mode', () => {
  test('is kms-http when endpoint and key are configured', async () => {
    const s = await loadSigner();
    assert.equal(s.mode(), 'kms-http');
    assert.equal(s.info().independently_verifiable, true);
  });

  test('reports the key as a surrogate key', async () => {
    const s = await loadSigner();
    assert.equal(s.info().surrogate, true,
      'a surrogate-signed leaf must be distinguishable from a real one');
  });
});

describe('the leaf signature', () => {
  test('verifies against the published key — no Scruple secret needed', async () => {
    const s = await loadSigner();
    const leafHash = crypto.randomBytes(32).toString('hex');
    const sig = await s.signLeaf(leafHash);
    assert.ok(sig, 'signing returned null');
    assert.equal(sig.alg, 'ECDSA_SHA_256');

    const pem = await s.publicKeyPem();
    const pub = crypto.createPublicKey(pem);
    const ok = crypto.verify(
      'sha256', Buffer.from(leafHash, 'hex'), pub, Buffer.from(sig.signature, 'base64'),
    );
    assert.ok(ok, 'the signature did not verify against the published key');
  });

  test('does not verify a different leaf', async () => {
    const s = await loadSigner();
    const sig = await s.signLeaf(crypto.randomBytes(32).toString('hex'));
    const pub = crypto.createPublicKey(await s.publicKeyPem());
    const ok = crypto.verify(
      'sha256', crypto.randomBytes(32), pub, Buffer.from(sig.signature, 'base64'),
    );
    assert.equal(ok, false, 'a forged leaf must not verify');
  });

  test('is stored as base64 DER, decodable by any standard library', async () => {
    const s = await loadSigner();
    const sig = await s.signLeaf(crypto.randomBytes(32).toString('hex'));
    const der = Buffer.from(sig.signature, 'base64');
    assert.equal(der[0], 0x30, 'not a DER SEQUENCE — a Scruple-specific encoding would defeat the point');
  });
});

describe('when the signing service is unreachable', () => {
  test('signLeaf returns null rather than throwing', async () => {
    process.env.SCRUPLE_WITNESS_KMS_ENDPOINT = 'http://127.0.0.1:9';
    const s = await loadSigner();
    const sig = await s.signLeaf(crypto.randomBytes(32).toString('hex'));
    assert.equal(sig, null,
      'losing the event entirely is worse than recording one whose ' +
      'independent verifiability is pending — but it must return null, not throw');
    process.env.SCRUPLE_WITNESS_KMS_ENDPOINT = BASE;
  });
});

describe('disabled mode', () => {
  test('is the default, so enabling H-1 is a deliberate act', async () => {
    const saved = process.env.SCRUPLE_WITNESS_KMS_KEY_OCID;
    delete process.env.SCRUPLE_WITNESS_KMS_KEY_OCID;
    const s = await loadSigner();
    assert.equal(s.mode(), 'disabled');
    assert.equal(await s.signLeaf('ab'.repeat(32)), null);
    assert.equal(s.info().independently_verifiable, false);
    process.env.SCRUPLE_WITNESS_KMS_KEY_OCID = saved;
  });
});
