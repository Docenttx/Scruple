// WO-S1(a) · WHAT A RECEIPT DISCLOSES ABOUT THE SEAL ON A LEAF.
//
// ---------------------------------------------------------------------------
// THE DEFECT, AS OBSERVED
// ---------------------------------------------------------------------------
//
// The witness has stored `leaf_signature`, `leaf_signer_key_id`,
// `leaf_signature_alg` and `leaf_signer_surrogate` since H-1. The application
// tier stored none of them: both write doors read `res.signature` — THE HMAC —
// into `witness_signature` and dropped the ECDSA fields on the floor.
//
// So `/api/v2/receipt` disclosed no signature at all, and
// `/api/v2/verify` computed `independently_verifiable` from the HMAC, which
// H-1 had already demoted to a transport seal between this tier and the
// witness. Every witnessed leaf claimed independent verifiability. Not one of
// them could be independently verified from anything this tier held.
//
// ---------------------------------------------------------------------------
// WHAT THIS FILE PROVES, AND THE CONTROL BESIDE EACH CLAIM
// ---------------------------------------------------------------------------
//
//   MUST FIRE                              MUST NOT FIRE
//   ─────────────────────────────────────  ──────────────────────────────────
//   a signed leaf discloses its signature   an unsigned leaf discloses none
//   the disclosure VERIFIES against the     it does not verify against a
//     signer's public key                     different key, or a mutated hash
//   surrogate → key_protection 'software'   nothing anywhere says 'hardware'
//   an unrecorded leaf reports 'unknown'    'unknown' is never 'unsigned'
//   verify() tracks the ECDSA signature     it does not track the HMAC —
//                                             this is the exact defect
//
// The signing stub is REAL ECDSA over a REAL P-256 key generated per run, and
// it signs exactly what services/cvm-surrogate signs for `messageType: RAW`:
// the 32 raw bytes of the leaf hash, SHA-256'd by the signer. A stub that
// returned a fixed string would let a receipt "disclose" something no verifier
// could ever check, which is the failure this WO exists to end.
//
// SAFETY. Own throwaway SCRUPLE_DB_PATH (the v2 suite shares one sqlite file
// across concurrent files). WITNESS_SERVER_URL is repointed at a local stub
// before anything imports `lib/scruple/witness` — 127.0.0.1:5799 is the
// PRODUCTION witness and a test that reaches it writes a real audit log.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const PROD_WITNESS = /127\.0\.0\.1:5799|localhost:5799/;
if (PROD_WITNESS.test(process.env.WITNESS_SERVER_URL ?? '')) {
  throw new Error('Refusing to run against the production witness server.');
}

const TENANT = 'tenant-s1a';
const sha256 = (s: string | Buffer) => crypto.createHash('sha256').update(s).digest('hex');
const BASELINE = sha256('s1a tamper surface');

/** How the stub answers, per request. Set by each test before it witnesses. */
type SignerMode = 'signed' | 'unsigned' | 'pre-h1' | 'down';
let signerMode: SignerMode = 'signed';
let surrogateFlag = true;

/** The signing key the stub witness "is". Real, and generated per run. */
const KEYS = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
/** A second key that signed nothing. The control for every verification. */
const OTHER = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

const SURROGATE_OCID =
  'ocid1.key.oc1.us-surrogate-1.surrogate.aaaaaaaaSURROGATEKEYnotarealkey';
const REAL_OCID = 'ocid1.key.oc1.uk-london-1.vault.aaaaaaaaNOTASURROGATE';

/** Exactly what the CVM surrogate does for messageType RAW. */
function signLeafHash(leafHashHex: string, key: crypto.KeyObject): string {
  return crypto.sign('sha256', Buffer.from(leafHashHex, 'hex'), key).toString('base64');
}

function checkLeafSignature(leafHashHex: string, b64: string, key: crypto.KeyObject): boolean {
  return crypto.verify('sha256', Buffer.from(leafHashHex, 'hex'), key, Buffer.from(b64, 'base64'));
}

let dir: string;
let stub: http.Server;
let stubPort = 0;
let apiKey: string;
let witnessCalls = 0;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let M: any;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scruple-s1a-'));
  process.env.SCRUPLE_DB_PATH = path.join(dir, 's1a-test.db');
  // Deliberately UNSET: a receipt must render a null public_key_url rather
  // than a 127.0.0.1 address that is true for the server and useless to the
  // reader holding the receipt. One test asserts the published case too.
  delete process.env.SCRUPLE_WITNESS_PUBLIC_URL;

  stub = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      witnessCalls += 1;
      if (signerMode === 'down') {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end('{"error":"witness down"}');
        return;
      }
      const leafHash = sha256(`s1a-leaf-${witnessCalls}-${raw.length}`);
      const base: Record<string, unknown> = {
        witness_id: `wit_s1a_${witnessCalls}`,
        server_timestamp: new Date().toISOString(),
        // The HMAC. Present in EVERY answer, including the unsigned ones —
        // that is what made the old `Boolean(witness_signature)` read true
        // for leaves nobody outside Scruple could check.
        signature: 'hmac-transport-seal',
        leaf_hash: leafHash,
        prev_record_hash: '',
        leaf_scheme: 'v2',
      };
      if (signerMode === 'signed') {
        const keyId = surrogateFlag ? SURROGATE_OCID : REAL_OCID;
        Object.assign(base, {
          leaf_signature: signLeafHash(leafHash, KEYS.privateKey),
          leaf_signer_key_id: keyId,
          leaf_signature_alg: 'ECDSA_SHA_256',
          // The WIRE spelling. The COLUMN is `leaf_signer_surrogate`, and a
          // reader that takes the column name off the wire gets undefined
          // forever with no type error — server.js:811-828 says so at length.
          signer_surrogate: surrogateFlag,
          independently_verifiable: true,
        });
      } else if (signerMode === 'unsigned') {
        Object.assign(base, {
          leaf_signature: null,
          leaf_signer_key_id: null,
          leaf_signature_alg: null,
          signer_surrogate: false,
          independently_verifiable: false,
        });
      }
      // 'pre-h1' sends none of the five keys at all.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(base));
    });
  });
  await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
  stubPort = (stub.address() as { port: number }).port;
  process.env.WITNESS_SERVER_URL = `http://127.0.0.1:${stubPort}`;

  const [migrate, sqlite] = await Promise.all([
    import('../../lib/db/migrate'),
    import('../../lib/db/sqlite'),
  ]);
  const witnessRoute = await import('../../app/api/v2/witness/route');
  const receiptRoute = await import('../../app/api/v2/receipt/[leaf_id]/route');
  const verifyRoute = await import('../../app/api/v2/verify/[content_hash]/route');
  const disclosure = await import('../../lib/leaf/signatureDisclosure');

  M = {
    conn: sqlite.conn,
    WITNESS_POST: witnessRoute.POST as unknown as (req: Request) => Promise<Response>,
    RECEIPT_GET: receiptRoute.GET,
    VERIFY_GET: verifyRoute.GET,
    disclose: disclosure.discloseLeafSignature,
  };

  migrate.runMigrations(false);
  const conn = sqlite.conn;
  conn().prepare(`INSERT INTO users (id, email) VALUES (?, ?)`).run(TENANT, 's1a@example.com');
  apiKey = `sk_test_${crypto.randomBytes(32).toString('base64url')}`;
  conn()
    .prepare(
      `INSERT INTO api_keys (id, user_id, key_hash, key_prefix, scopes_json, label)
       VALUES (?, ?, ?, ?, ?, 's1a')`,
    )
    .run(crypto.randomUUID(), TENANT, sha256(apiKey), apiKey.slice(0, 12), JSON.stringify(['witness:write']));
  const now = new Date().toISOString();
  conn()
    .prepare(
      `INSERT INTO baselines
         (tenant_id, baseline_hash, manifest_json, attestation_provider,
          signer_pubkey_spki_sha256_hex, submitted_at, activated_at)
       VALUES (?, ?, '{}', 'none', ?, ?, ?)`,
    )
    .run(TENANT, BASELINE, sha256('s1a-pubkey'), now, now);
});

after(async () => {
  await new Promise<void>((r) => stub.close(() => r()));
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

/* ────────────────────────────────────────────────────────────────────── */

interface Leaf { leaf_id: string; content_hash: string; body: Record<string, unknown> }

/** Witness one event through the REAL route. `graph` present ⇒ a profile. */
async function witnessOne(opts: { graph?: boolean; nonce?: string } = {}): Promise<Leaf> {
  const contentHash = sha256(`s1a-content-${opts.nonce ?? crypto.randomUUID()}`);
  const body: Record<string, unknown> = {
    baseline_ref: BASELINE,
    kind: 'artifact',
    content_hash: contentHash,
    mime: 'image/png',
  };
  if (opts.graph) body.graph = { '1': { class_type: 'KSampler', inputs: { cfg: 8.0 } } };
  const res = await M.WITNESS_POST(
    new Request('https://scruple.test/api/v2/witness', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    }),
  );
  const parsed = (await res.json()) as Record<string, unknown>;
  assert.equal(res.status, 201, `witness must accept: ${JSON.stringify(parsed)}`);
  return { leaf_id: String(parsed.leaf_id), content_hash: contentHash, body: parsed };
}

async function receipt(leafId: string): Promise<Record<string, unknown>> {
  const res = await M.RECEIPT_GET(new Request(`https://scruple.test/api/v2/receipt/${leafId}`), {
    params: Promise.resolve({ leaf_id: leafId }),
  });
  return (await res.json()) as Record<string, unknown>;
}

async function verify(contentHash: string): Promise<Record<string, unknown>> {
  const res = await M.VERIFY_GET(new Request(`https://scruple.test/api/v2/verify/${contentHash}`), {
    params: Promise.resolve({ content_hash: contentHash }),
  });
  return (await res.json()) as Record<string, unknown>;
}

/* ══════════════════════════════════════════════════════════════════════
 * 1. THE SIGNED LEAF — disclosed, and CHECKED against the signer's key
 * ══════════════════════════════════════════════════════════════════════ */

describe('a signed leaf discloses a signature a third party can actually check', () => {
  test('every H-1 field reaches the receipt, and the signature verifies', async () => {
    signerMode = 'signed';
    surrogateFlag = true;
    const leaf = await witnessOne({ graph: true });
    const r = await receipt(leaf.leaf_id);
    const sig = r.signature as Record<string, unknown>;

    assert.equal(sig.state, 'signed');
    assert.equal(typeof sig.leaf_signature, 'string');
    assert.equal(sig.leaf_signer_key_id, SURROGATE_OCID);
    assert.equal(sig.leaf_signature_alg, 'ECDSA_SHA_256');
    assert.equal(sig.leaf_signer_surrogate, true);
    assert.equal(r.independently_verifiable, true);

    // THE POINT OF THE WHOLE WO. Not "a field is present" — the disclosed
    // bytes check out against the key the signer published, with nothing
    // from Scruple but the receipt.
    assert.ok(
      checkLeafSignature(String(r.leaf_hash), String(sig.leaf_signature), KEYS.publicKey),
      'the disclosed signature must verify over the disclosed leaf_hash',
    );
  });

  test('CONTROL — it does not verify against another key, nor over another hash', async () => {
    signerMode = 'signed';
    surrogateFlag = true;
    const leaf = await witnessOne();
    const r = await receipt(leaf.leaf_id);
    const sig = String((r.signature as Record<string, unknown>).leaf_signature);
    const leafHash = String(r.leaf_hash);

    assert.equal(
      checkLeafSignature(leafHash, sig, OTHER.publicKey),
      false,
      'a signature that verifies under any key is not a signature',
    );
    // One bit of the leaf hash, flipped. The check must fail — otherwise the
    // "verification" above is proving nothing about THIS leaf.
    const mutated = (leafHash.slice(0, 63) + (leafHash[63] === 'a' ? 'b' : 'a'));
    assert.equal(checkLeafSignature(mutated, sig, KEYS.publicKey), false);
  });

  test('the receipt says which bytes were signed, because that is silently gettable-wrong', async () => {
    signerMode = 'signed';
    const leaf = await witnessOne();
    const r = await receipt(leaf.leaf_id);
    const v = (r.signature as Record<string, unknown>).verification as Record<string, unknown>;
    assert.equal(v.signed_over, 'leaf_hash');
    assert.equal(v.message_type, 'RAW');
    assert.equal(v.signature_encoding, 'base64(DER(ECDSA))');
    assert.match(String(v.message), /raw bytes/);

    // And the instruction is TRUE: hashing the ASCII spelling instead of the
    // 32 raw bytes fails, which is the mistake the wording exists to prevent.
    const sig = String((r.signature as Record<string, unknown>).leaf_signature);
    const asAscii = crypto.verify(
      'sha256',
      Buffer.from(String(r.leaf_hash), 'utf8'),
      KEYS.publicKey,
      Buffer.from(sig, 'base64'),
    );
    assert.equal(asAscii, false, 'the hex spelling is not what was signed — as the receipt says');
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * 2. H-5 — surrogate vs not, and never a hardware claim
 * ══════════════════════════════════════════════════════════════════════ */

describe('a surrogate-signed leaf is distinguishable from one that is not', () => {
  test('surrogate → software, and it says so', async () => {
    signerMode = 'signed';
    surrogateFlag = true;
    const leaf = await witnessOne();
    const r = await receipt(leaf.leaf_id);
    const sig = r.signature as Record<string, unknown>;
    assert.equal(sig.leaf_signer_surrogate, true);
    assert.equal(sig.key_protection, 'software');
    assert.match(String(sig.note), /software/i);
  });

  test('not the surrogate → `undeclared`, which is NOT a hardware claim', async () => {
    signerMode = 'signed';
    surrogateFlag = false;
    const leaf = await witnessOne();
    const r = await receipt(leaf.leaf_id);
    const sig = r.signature as Record<string, unknown>;
    assert.equal(sig.leaf_signer_surrogate, false);
    assert.equal(sig.key_protection, 'undeclared');

    // CONTROL. The witness does not transmit the key's protection mode, so
    // nothing in this estate may infer hardware backing from a non-surrogate
    // key id. If the word ever appears here, the inference has crept back in.
    assert.doesNotMatch(
      JSON.stringify(r),
      /hardware[-_ ]?(backed|protected)|"hardware"/i,
      'a non-surrogate key id is the absence of a claim, not a hardware claim',
    );
    surrogateFlag = true;
  });

  test('CONTROL — the two leaves differ in the field H-5 exists to expose', async () => {
    signerMode = 'signed';
    surrogateFlag = true;
    const a = await receipt((await witnessOne()).leaf_id);
    surrogateFlag = false;
    const b = await receipt((await witnessOne()).leaf_id);
    surrogateFlag = true;
    assert.notEqual(
      (a.signature as Record<string, unknown>).key_protection,
      (b.signature as Record<string, unknown>).key_protection,
      'if these two read the same, the per-leaf two-tier honesty is not there',
    );
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * 3. THE CONTROLS — unsigned, and unknown, and never each other
 * ══════════════════════════════════════════════════════════════════════ */

describe('a leaf with no signature reports that honestly and is not verifiable', () => {
  test('the witness answered and had none → `unsigned`', async () => {
    signerMode = 'unsigned';
    const leaf = await witnessOne();
    const r = await receipt(leaf.leaf_id);
    const sig = r.signature as Record<string, unknown>;

    assert.equal(sig.state, 'unsigned');
    assert.equal(sig.leaf_signature, null);
    assert.equal(r.independently_verifiable, false);
    assert.equal(sig.independently_verifiable, false);
    // No instructions, because there is nothing to instruct anyone to do.
    assert.equal(sig.verification, null);
    // Witnessed — the HMAC came back and the leaf is on the record. That is
    // exactly the case the old code called independently verifiable.
    assert.equal(r.witnessed, true);
  });

  test('this tier never got an answer → `unknown`, and NOT `unsigned`', async () => {
    signerMode = 'down';
    const leaf = await witnessOne();
    const r = await receipt(leaf.leaf_id);
    const sig = r.signature as Record<string, unknown>;

    assert.equal(r.witnessed, false, 'the witness was down; nothing was witnessed');
    assert.equal(sig.state, 'unknown');
    assert.equal(r.independently_verifiable, false);
    assert.match(String(sig.note), /NOT a statement/);
    signerMode = 'signed';
  });

  test('a pre-H-1 witness omits the fields → `unknown`, not `unsigned`', async () => {
    signerMode = 'pre-h1';
    const leaf = await witnessOne();
    const r = await receipt(leaf.leaf_id);
    assert.equal(r.witnessed, true, 'a pre-H-1 witness still witnesses');
    assert.equal((r.signature as Record<string, unknown>).state, 'unknown');
    signerMode = 'signed';
  });

  test('CONTROL — `unsigned` and `unknown` are not the same response', async () => {
    signerMode = 'unsigned';
    const a = (await receipt((await witnessOne()).leaf_id)).signature as Record<string, unknown>;
    signerMode = 'down';
    const b = (await receipt((await witnessOne()).leaf_id)).signature as Record<string, unknown>;
    signerMode = 'signed';

    assert.notEqual(a.state, b.state);
    assert.notEqual(a.note, b.note);
    // Both are null-signature, both unverifiable — and if the two collapsed
    // into one string the receipt would be asserting something about the
    // witness's records that this tier never read.
    assert.equal(a.leaf_signature, null);
    assert.equal(b.leaf_signature, null);
  });

  test('every key is present in every state — an absent field is a fact nobody reads', async () => {
    const keys = [
      'state', 'leaf_signature', 'leaf_signer_key_id', 'leaf_signature_alg',
      'leaf_signer_surrogate', 'key_protection', 'independently_verifiable',
      'verification', 'note',
    ];
    for (const mode of ['signed', 'unsigned', 'down', 'pre-h1'] as SignerMode[]) {
      signerMode = mode;
      const r = await receipt((await witnessOne()).leaf_id);
      const sig = r.signature as Record<string, unknown>;
      for (const k of keys) {
        assert.ok(k in sig, `receipt.signature.${k} missing in mode ${mode}`);
      }
      assert.ok('canonicalization_profile' in r, `canonicalization_profile missing in mode ${mode}`);
      assert.ok('component' in r, `component missing in mode ${mode}`);
    }
    signerMode = 'signed';
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * 4. THE CANONICALIZATION PROFILE — the divergence that was undetectable
 * ══════════════════════════════════════════════════════════════════════ */

describe('the receipt discloses which canonicalization rule made the row', () => {
  test('a leaf with a graph carries the profile the row was written under', async () => {
    signerMode = 'signed';
    const leaf = await witnessOne({ graph: true });
    const r = await receipt(leaf.leaf_id);
    const row = M.conn()
      .prepare(`SELECT canonicalization_profile FROM iterations WHERE id = ?`)
      .get(Number(leaf.leaf_id)) as { canonicalization_profile: string | null };

    assert.equal(r.canonicalization_profile, row.canonicalization_profile);
    assert.equal(r.canonicalization_profile, 'jcs-2');
    // The Blender client computed `jcs-1` against a row that says `jcs-2`.
    // With the field disclosed a client can SEE the disagreement; without it
    // the two just quietly produce different digests for the same document.
    assert.notEqual(r.canonicalization_profile, 'jcs-1');
  });

  test('CONTROL — no document canonicalized ⇒ null, and the key is still there', async () => {
    signerMode = 'signed';
    const leaf = await witnessOne({ graph: false });
    const r = await receipt(leaf.leaf_id);
    assert.ok('canonicalization_profile' in r);
    assert.equal(r.canonicalization_profile, null, 'the question was never asked — not a default');
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * 5. /api/v2/verify STOPS READING THE HMAC
 * ══════════════════════════════════════════════════════════════════════ */

describe('independent verifiability tracks the ECDSA signature, not the transport seal', () => {
  test('THE DEFECT, REPRODUCED AS A CONTROL: an HMAC alone is not verifiability', async () => {
    signerMode = 'unsigned';
    const leaf = await witnessOne();
    const row = M.conn()
      .prepare(`SELECT witness_signature, leaf_signature FROM iterations WHERE id = ?`)
      .get(Number(leaf.leaf_id)) as { witness_signature: string | null; leaf_signature: string | null };

    // The precondition. The HMAC IS stored — this is the row shape that used
    // to answer `independently_verifiable: true`.
    assert.equal(row.witness_signature, 'hmac-transport-seal');
    assert.equal(row.leaf_signature, null);

    const v = await verify(leaf.content_hash);
    assert.equal(v.found, true);
    assert.equal(v.witnessed, true);
    assert.equal(v.independently_verifiable, false, 'the HMAC must not buy this');
    assert.equal((v.verification_basis as Record<string, unknown>).kind, 'scruple_record');
    assert.equal((v.verification_basis as Record<string, unknown>).state, 'unsigned');
    signerMode = 'signed';
  });

  test('a genuinely signed leaf reports verifiable, with the surrogate flag beside it', async () => {
    signerMode = 'signed';
    surrogateFlag = true;
    const leaf = await witnessOne();
    const v = await verify(leaf.content_hash);
    assert.equal(v.independently_verifiable, true);
    const basis = v.verification_basis as Record<string, unknown>;
    assert.equal(basis.kind, 'asymmetric_leaf_signature');
    assert.equal(basis.signer_surrogate, true);
    assert.equal(basis.key_protection, 'software');

    // The same signature, from the same function, as the receipt — so the two
    // public surfaces cannot come to disagree about whether a leaf is checkable.
    const r = await receipt(leaf.leaf_id);
    assert.deepEqual(v.signature, r.signature);
    assert.ok(
      checkLeafSignature(
        String((v.leaf as Record<string, unknown>).leaf_hash),
        String((v.signature as Record<string, unknown>).leaf_signature),
        KEYS.publicKey,
      ),
    );
  });

  test('an unwitnessed leaf is `unknown` here too, and still not verifiable', async () => {
    signerMode = 'down';
    const leaf = await witnessOne();
    const v = await verify(leaf.content_hash);
    assert.equal(v.independently_verifiable, false);
    assert.equal((v.verification_basis as Record<string, unknown>).state, 'unknown');
    signerMode = 'signed';
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * 6. THE DISCLOSURE FUNCTION ITSELF — the states it must not invent
 * ══════════════════════════════════════════════════════════════════════ */

describe('discloseLeafSignature refuses to read better than its row', () => {
  test('a row that claims `signed` with no signature is not reported verifiable', () => {
    const d = M.disclose(
      {
        leaf_signature: null,
        leaf_signer_key_id: 'ocid1.key.oc1.x',
        leaf_signature_alg: 'ECDSA_SHA_256',
        leaf_signer_surrogate: 0,
        leaf_signature_state: 'signed',
      },
      sha256('broken row'),
    );
    assert.equal(d.independently_verifiable, false);
    assert.equal(d.verification, null);
  });

  test('a stray state value degrades to `unknown`, never to `signed`', () => {
    for (const bogus of ['SIGNED', 'yes', '', 'verified', null]) {
      const d = M.disclose(
        {
          leaf_signature: 'MEUCIQ...',
          leaf_signer_key_id: null,
          leaf_signature_alg: null,
          leaf_signer_surrogate: 1,
          leaf_signature_state: bogus,
        },
        sha256('bogus state'),
      );
      assert.equal(d.state, 'unknown', `state ${JSON.stringify(bogus)} must not be trusted`);
      assert.equal(d.independently_verifiable, false);
    }
  });

  test('the verifying key is named when the deployment publishes one, null when it does not', () => {
    const row = {
      leaf_signature: 'MEUCIQ...',
      leaf_signer_key_id: SURROGATE_OCID,
      leaf_signature_alg: 'ECDSA_SHA_256',
      leaf_signer_surrogate: 1,
      leaf_signature_state: 'signed',
    };
    assert.equal(M.disclose(row, sha256('x')).verification.public_key_url, null);
    process.env.SCRUPLE_WITNESS_PUBLIC_URL = 'https://witness.scruple.ai/';
    try {
      assert.equal(
        M.disclose(row, sha256('x')).verification.public_key_url,
        'https://witness.scruple.ai/api/signer/pubkey',
      );
    } finally {
      delete process.env.SCRUPLE_WITNESS_PUBLIC_URL;
    }
    // The path is named either way — a reader who knows their own witness's
    // address is not left guessing which endpoint to hit.
    assert.equal(M.disclose(row, sha256('x')).verification.public_key_path, '/api/signer/pubkey');
  });
});
