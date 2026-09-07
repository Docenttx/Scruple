// GET /api/v2/verify/{content_hash} — third-party verification.
//
// Public. Someone holding a file, with no relationship to Scruple and no
// credential, hashes it and asks whether it is on the record.
//
// ASSURANCE (D-0, L2_FLOOR.md). This used to hardcode
// `independently_verifiable: false`, because a leaf's only seal was an
// HMAC over a secret Scruple holds — forgeable by us, checkable by
// nobody else.
//
// H-1 changed that: leaves are now ECDSA-signed via the same KMS the
// C2PA signer uses, and the verifying key is published. So this reports
// the truth per leaf rather than a constant. A leaf signed while the KMS
// was unreachable is still recorded and still says false, which is the
// honest answer for that leaf.
//
// WO-S1(a) — AND THEN IT READ THE WRONG COLUMN.
//
// `independently_verifiable` was `Boolean(row.witness_signature)`, with a
// comment asserting "an ECDSA leaf signature is stored in
// witness_signature". It is not, and it never was. Both write doors put
// `res.signature` there — the HMAC, which leaf_signer.js's own header
// calls a transport seal between this tier and the witness, demoted by
// H-1 precisely because Scruple can forge it and nobody else can check
// it. The ECDSA signature came back on `leaf_signature` and both doors
// dropped it.
//
// So this route replaced one constant with another: `false` for every
// leaf became `true` for every witnessed leaf, and the field went on
// meaning nothing. Migration 052 stores the four H-1 fields on the row,
// and this now reports from those. A leaf this tier never recorded a
// signature for reports `unknown` — NOT `unsigned`, because the witness
// may well hold one for it, and NOT verifiable, because nothing here can
// show it.

import { conn } from '@/lib/db/sqlite';
import { v2Error, v2Ok } from '@/lib/v2/http';
import { discloseLeafSignature } from '@/lib/leaf/signatureDisclosure';

export const dynamic = 'force-dynamic';

interface Row {
  id: number;
  leaf_hash: string;
  witnessed: number;
  leaf_scheme: string | null;
  baseline_hash: string | null;
  timestamp: string;
  witness_signature: string | null;
  leaf_signature: string | null;
  leaf_signer_key_id: string | null;
  leaf_signature_alg: string | null;
  leaf_signer_surrogate: number | null;
  leaf_signature_state: string | null;
  canonicalization_profile: string | null;
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ content_hash: string }> },
) {
  const { content_hash } = await params;
  if (!/^[0-9a-f]{64}$/.test(content_hash)) {
    return v2Error('invalid_body', 'content_hash must be 64 lowercase hex characters (SHA-256).');
  }

  const row = conn()
    .prepare(
      `SELECT id, leaf_hash, witnessed, leaf_scheme, baseline_hash, timestamp,
              witness_signature,
              leaf_signature, leaf_signer_key_id, leaf_signature_alg,
              leaf_signer_surrogate, leaf_signature_state,
              canonicalization_profile
         FROM iterations
        WHERE output_hash = ?
        ORDER BY id DESC LIMIT 1`,
    )
    .get(content_hash) as Row | undefined;

  if (!row) {
    return v2Ok({
      found: false,
      witnessed: false,
      // Said explicitly because the alternative reading — "Scruple says
      // this file is not genuine" — is a much stronger claim than the
      // one being made.
      note: 'This content hash is not on Scruple\'s record. That means Scruple did not witness it; it says nothing about the file itself.',
    });
  }

  // The H-1 signature, off the columns that actually hold it (052). NOT
  // `witness_signature`, which is the HMAC and says nothing about whether
  // anyone outside Scruple can check this leaf.
  const signature = discloseLeafSignature(row, row.leaf_hash);
  const independentlyVerifiable = signature.independently_verifiable;

  return v2Ok({
    found: true,
    witnessed: row.witnessed === 1,
    independently_verifiable: independentlyVerifiable,
    leaf: {
      leaf_id: String(row.id),
      leaf_hash: row.leaf_hash,
      leaf_scheme: row.leaf_scheme ?? 'v1',
      baseline_ref: row.baseline_hash,
      witnessed_at: row.timestamp,
      // WO-S1(a), additive. Disclosed here as well as on the receipt so
      // that a verifier who arrived with only a file — the whole premise
      // of this route — can tell which rule to replay a hash under
      // without a second round trip.
      canonicalization_profile: row.canonicalization_profile,
    },
    // WO-S1(a), additive. The same shape the receipt returns, from the
    // same function, so the two surfaces cannot come to disagree about
    // whether a leaf is checkable.
    signature,
    verification_basis: independentlyVerifiable
      ? {
          kind: 'asymmetric_leaf_signature',
          independently_verifiable: true,
          algorithm: signature.leaf_signature_alg ?? 'ECDSA_SHA_256',
          // H-5 hoisted into the basis, because "verifiable" and
          // "verifiable against a software key held by a stand-in for a
          // Confidential VM" are not the same assurance, and a verifier
          // that reads only this block must still be told which it has.
          signer_surrogate: signature.leaf_signer_surrogate,
          key_protection: signature.key_protection,
          note:
            'This leaf is ECDSA-signed. Fetch the verifying key from the witness at /api/signer/pubkey and check the signature over leaf_hash yourself — no Scruple cooperation and no OCI credentials required. See `signature.verification` for exactly which bytes were signed.',
        }
      : {
          kind: 'scruple_record',
          independently_verifiable: false,
          // The two reasons are different and the note now says which
          // one applies. `unsigned` means the witness answered and had
          // no signature; `unknown` means this tier never recorded an
          // answer, and asserting "carries no asymmetric signature"
          // there would be a claim about the witness's records made by
          // something that never read them.
          state: signature.state,
          note: signature.note,
        },
    receipt_url: `/api/v2/receipt/${row.id}`,
  });
}
