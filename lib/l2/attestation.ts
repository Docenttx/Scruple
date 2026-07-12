// L2 attestation reader for the receipt page.
//
// A project qualifies for the "L2 Attestation" receipt section when a JSON
// file exists at data/l2-attestations/<scrId>.json (or <preScrId>.json).
// The file is written by scripts/build-l2-attestation.mjs after the puff-style
// sign-and-bundle pipeline runs.
//
// Kept as a file (not a DB column) so the SEV-SNP substrate evidence and
// bundle Merkle root live *outside* the SQLite DB — anyone with git + the
// bundle folder can independently rebuild the receipt payload without
// running the app.

import fs from 'node:fs';
import path from 'node:path';

export type L2AttestationLeafSummary = {
  iteration: number;
  output_sha256: string;
  signed_output_sha256: string;
  workflow_sha256: string;
  c2pa_reader_state: 'Valid' | 'Invalid' | 'Untrusted' | string;
};

export type L2Attestation = {
  scr_id: string;
  bundle_root: string;             // sha256 of BUNDLE.merkle-root.txt content
  bundle_relpath: string;          // repo-relative path to the bundle folder
  merkle_root_sha256: string;      // the Merkle root over iteration leaves
  c2pa: {
    signer_cert_subject: string;
    signer_cert_issuer: string;
    root_ca_subject: string;
    signer_pubkey_sha256: string;  // SPKI DER
    cert_chain_sha256: string;
    profile_notes: string;
  };
  witness: {
    signer_pubkey_sha256: string;  // SPKI DER
    signer_pubkey_alg: 'Ed25519';
    signature_b64: string;
    sign_input_prefix: string;     // e.g., 'puffjuly12/checkpoint/v1|'
  };
  sev_snp_substrate: {
    evidence_relpath: string;      // repo-relative path to docs/l2-evidence/<stamp>/
    vm_measurement_hex: string;
    chip_id_hex: string;
    reported_tcb_hex: string;
    vcek_der_sha256: string;
    signer_pubkey_bound_sha256: string; // this is the pubkey the SEV-SNP report binds
  };
  leaves: L2AttestationLeafSummary[];
  generated_at: string;
};

const DATA_DIR = path.join(process.cwd(), 'data', 'l2-attestations');

export function readL2Attestation(scrId: string, preScrId?: string | null): L2Attestation | null {
  const candidates = [scrId];
  if (preScrId) candidates.push(preScrId);
  for (const id of candidates) {
    const p = path.join(DATA_DIR, `${id}.json`);
    if (fs.existsSync(p)) {
      try {
        return JSON.parse(fs.readFileSync(p, 'utf-8')) as L2Attestation;
      } catch {
        return null;
      }
    }
  }
  return null;
}
