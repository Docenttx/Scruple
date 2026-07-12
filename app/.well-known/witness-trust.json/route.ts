// GET /.well-known/witness-trust.json
//
// Published manifest that verifiers use to look up the current checkpoint
// signing key + topology metadata. Content-Type: application/json.
//
// Consumers: the reference verifier CLI (WO-09), third-party auditors,
// contractual customers under the Rider.

import { NextResponse } from 'next/server';
import {
  getCheckpointPublicKeyPem,
  WITNESS_KEY_ID,
  WITNESS_KEY_ALG,
} from '@/lib/witness/checkpointSign';

export const dynamic = 'force-dynamic';

export async function GET() {
  const activated_at =
    process.env.SCRUPLE_WITNESS_CHECKPOINT_ACTIVATED_AT ??
    '2026-07-12T00:00:00.000Z';
  const manifest = {
    version: 1,
    witness_root: 'scruple-witness-v1',
    checkpoint_keys: [
      {
        key_id: WITNESS_KEY_ID,
        alg: WITNESS_KEY_ALG,
        public_key_pem: getCheckpointPublicKeyPem(),
        activated_at,
        deprecated_at: null,
      },
    ],
    topologies: [
      {
        id: 'scruple-hosted-oci',
        // Signer public key lands here once WO-02 cert issues.
        signer_public_key_pem: null,
        attestation_providers: ['rats-oci-scc', 'rats-scruple-ledger'],
        activated_at,
      },
    ],
  };
  return NextResponse.json(manifest);
}
