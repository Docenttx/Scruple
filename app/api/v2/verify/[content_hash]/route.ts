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

import { conn } from '@/lib/db/sqlite';
import { v2Error, v2Ok } from '@/lib/v2/http';

export const dynamic = 'force-dynamic';

interface Row {
  id: number;
  leaf_hash: string;
  witnessed: number;
  leaf_scheme: string | null;
  baseline_hash: string | null;
  timestamp: string;
  witness_signature: string | null;
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
              witness_signature
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

  // An ECDSA leaf signature is stored in witness_signature. Its presence
  // is what makes this leaf checkable by someone who does not trust us.
  const independentlyVerifiable = Boolean(row.witness_signature);

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
    },
    verification_basis: independentlyVerifiable
      ? {
          kind: 'asymmetric_leaf_signature',
          independently_verifiable: true,
          algorithm: 'ECDSA_SHA_256',
          note:
            'This leaf is ECDSA-signed. Fetch the verifying key from the witness at /api/signer/pubkey and check the signature over leaf_hash yourself — no Scruple cooperation and no OCI credentials required.',
        }
      : {
          kind: 'scruple_record',
          independently_verifiable: false,
          note:
            'This leaf carries no asymmetric signature — it was witnessed before H-1, or while the signing service was unreachable. It rests on Scruple\'s audit record alone and cannot be checked by a third party.',
        },
    receipt_url: `/api/v2/receipt/${row.id}`,
  });
}
