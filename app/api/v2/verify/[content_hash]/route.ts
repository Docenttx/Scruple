// GET /api/v2/verify/{content_hash} — third-party verification.
//
// Public. Someone holding a file, with no relationship to Scruple and no
// credential, hashes it and asks whether it is on the record.
//
// ASSURANCE CAVEAT (D-0, L2_FLOOR.md). A `found: true` here currently
// rests on Scruple's own database and an HMAC seal Scruple holds the key
// to. It is not independently verifiable the way a C2PA manifest is, and
// this response says so rather than implying parity. Harmonizing that is
// H-1 and it is not done.

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
      `SELECT id, leaf_hash, witnessed, leaf_scheme, baseline_hash, timestamp
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

  return v2Ok({
    found: true,
    witnessed: row.witnessed === 1,
    leaf: {
      leaf_id: String(row.id),
      leaf_hash: row.leaf_hash,
      leaf_scheme: row.leaf_scheme ?? 'v1',
      baseline_ref: row.baseline_hash,
      witnessed_at: row.timestamp,
    },
    verification_basis: {
      // Named plainly so nothing downstream mistakes this for the
      // independent verifiability a C2PA manifest carries.
      kind: 'scruple_record',
      independently_verifiable: false,
      note: 'This answer rests on Scruple\'s audit record. A C2PA manifest on the same asset is verifiable without Scruple; this is not, until leaf signing moves into the attested signer.',
    },
    receipt_url: `/api/v2/receipt/${row.id}`,
  });
}
