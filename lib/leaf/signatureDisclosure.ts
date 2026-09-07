// What a receipt says about the seal on a leaf — one shape, three surfaces.
//
// WO-S1(a). Until migration 052 this tier stored the HMAC and nothing else,
// so `/api/v2/receipt` disclosed no signature at all and `/api/v2/verify`
// computed `independently_verifiable` from the HMAC — the transport seal
// H-1 explicitly demoted (leaf_signer.js header: "demoted to what it always
// was — a transport seal between the application tier and this service").
// Every witnessed leaf therefore claimed independent verifiability and not
// one of them could be independently verified from anything this tier held.
//
// ONE FUNCTION, because the alternative is the failure mode this estate has
// already had twice: `componentPreimage` exists because two copies of a
// field list drift, and `resolveField` exists because `signer_surrogate` and
// `leaf_signer_surrogate` drifted forty lines apart in one file. A receipt
// and a verification answer that disagree about whether a leaf is checkable
// would be the same defect on the surface a third party actually reads.
//
// THREE STATES, NEVER TWO. `unknown` is not a polite `unsigned`:
//
//   signed     the witness answered with an ECDSA signature. It is here, and
//              a third party can check it without us.
//   unsigned   the witness answered and had none — signing disabled, or the
//              KMS unreachable for that leaf. leaf_signer.js returns null
//              rather than failing the event; that is a fact about the leaf.
//   unknown    nobody asked, or nobody answered. Every row written before
//              migration 052, every leaf recorded while the witness was
//              unreachable, and every §9.6 continuity record that was
//              deliberately never witnessed.
//
// The WO's rule, applied literally: "an absent field and a null field must
// not mean the same thing". So every key below is ALWAYS present, including
// when its value is null, and the state says why it is null.

/** The columns migration 052 added, as read off an `iterations` row. */
export interface LeafSignatureRow {
  leaf_signature: string | null;
  leaf_signer_key_id: string | null;
  leaf_signature_alg: string | null;
  leaf_signer_surrogate: number | null;
  leaf_signature_state: string | null;
}

export type LeafSignatureState = 'signed' | 'unsigned' | 'unknown';

/**
 * What backed the signing key, stated at exactly the strength the record
 * supports and no further.
 *
 * `undeclared` is the interesting one. A non-surrogate key id means the leaf
 * was NOT signed by services/cvm-surrogate — and that is the whole of what it
 * means. The witness does not transmit the key's OCI protection mode, so this
 * tier cannot say the key lived in an HSM, and the sandbox rule is explicit:
 * never record a leaf as hardware-backed because it signed. `undeclared` is
 * therefore not a downgrade of `hardware`, it is the absence of a claim.
 */
export type KeyProtection = 'software' | 'undeclared' | 'unknown';

export interface LeafSignatureDisclosure {
  state: LeafSignatureState;
  /** Base64 of the DER-encoded ECDSA signature, exactly as the KMS returned it. */
  leaf_signature: string | null;
  leaf_signer_key_id: string | null;
  leaf_signature_alg: string | null;
  /** H-5, per leaf: was this the CVM surrogate? null when nobody asked. */
  leaf_signer_surrogate: boolean | null;
  key_protection: KeyProtection;
  /** True iff a third party holding the verifying key can check this leaf. */
  independently_verifiable: boolean;
  /** Null unless `signed` — there is nothing to instruct anyone to do. */
  verification: LeafVerificationInstructions | null;
  note: string;
}

export interface LeafVerificationInstructions {
  signed_over: 'leaf_hash';
  /** The exact bytes, because "the leaf hash" has two plausible readings. */
  message: string;
  message_type: 'RAW';
  signature_encoding: 'base64(DER(ECDSA))';
  /**
   * Where the verifying key is published, when this deployment has published
   * an address for its witness. Null — with the path still named — rather
   * than a `127.0.0.1` URL that is true for the server and useless to the
   * reader holding the receipt.
   */
  public_key_url: string | null;
  public_key_path: '/api/signer/pubkey';
}

const SURROGATE_NOTE =
  'Signed by the CVM surrogate: a real ECDSA signature over a SOFTWARE key. ' +
  'No hardware protected it, and this leaf must not be presented as ' +
  'hardware-backed (H-5).';

const UNDECLARED_NOTE =
  'Signed by a key that is not the CVM surrogate. The witness does not ' +
  'transmit the key’s protection mode, so this record makes no claim ' +
  'about hardware backing either way.';

const UNSIGNED_NOTE =
  'The witness recorded this leaf with no asymmetric signature — leaf ' +
  'signing was disabled, or the signing service was unreachable when it was ' +
  'written. It rests on Scruple’s audit record alone and cannot be ' +
  'checked by a third party.';

const UNKNOWN_NOTE =
  'This tier holds no record of whether the leaf was signed. The question ' +
  'was never asked or never answered: the row predates migration 052, the ' +
  'witness was unreachable, or the event was recorded under §9.6 ' +
  'continuity and deliberately never witnessed. This is NOT a statement ' +
  'that the leaf is unsigned — the witness may hold a signature for it.';

/** The witness address a reader could actually use, if one is published. */
function publicWitnessBase(): string | null {
  const raw = process.env.SCRUPLE_WITNESS_PUBLIC_URL;
  if (!raw || !raw.trim()) return null;
  return raw.trim().replace(/\/$/, '');
}

export function discloseLeafSignature(
  row: LeafSignatureRow,
  leafHash: string | null,
): LeafSignatureDisclosure {
  // The stored state is authoritative. Deriving the state from
  // `leaf_signature !== null` would collapse `unsigned` into `unknown` for
  // every row, which is the exact conflation migration 052 exists to prevent.
  const stored = row.leaf_signature_state;
  const state: LeafSignatureState =
    stored === 'signed' || stored === 'unsigned' ? stored : 'unknown';

  // Belt and braces. A row that says `signed` with no signature is a broken
  // write, and reporting it as verifiable would be the receipt reading better
  // than the evidence behind it — §12.4's whole point.
  const sig = state === 'signed' ? row.leaf_signature : null;
  const verifiable = Boolean(sig);

  const surrogate: boolean | null =
    row.leaf_signer_surrogate === null || row.leaf_signer_surrogate === undefined
      ? null
      : row.leaf_signer_surrogate === 1;

  const key_protection: KeyProtection =
    surrogate === null ? 'unknown' : surrogate ? 'software' : 'undeclared';

  let note: string;
  if (!verifiable) note = state === 'unsigned' ? UNSIGNED_NOTE : UNKNOWN_NOTE;
  else note = surrogate ? SURROGATE_NOTE : UNDECLARED_NOTE;

  const base = publicWitnessBase();

  return {
    state,
    leaf_signature: sig,
    leaf_signer_key_id: verifiable ? row.leaf_signer_key_id ?? null : null,
    leaf_signature_alg: verifiable ? row.leaf_signature_alg ?? null : null,
    leaf_signer_surrogate: verifiable ? surrogate : null,
    key_protection: verifiable ? key_protection : 'unknown',
    independently_verifiable: verifiable,
    verification: verifiable
      ? {
          signed_over: 'leaf_hash',
          // Said in full because getting it wrong is silent: the KMS signed
          // the 32 RAW bytes, not the 64-character hex spelling of them, and
          // a verifier that hashes the ASCII gets a clean failure that reads
          // exactly like tampering.
          message: leafHash
            ? `the 32 raw bytes of leaf_hash ${leafHash} (hex-decoded), SHA-256'd by the signer`
            : 'the 32 raw bytes of leaf_hash (hex-decoded), SHA-256’d by the signer',
          message_type: 'RAW',
          signature_encoding: 'base64(DER(ECDSA))',
          public_key_url: base ? `${base}/api/signer/pubkey` : null,
          public_key_path: '/api/signer/pubkey',
        }
      : null,
    note,
  };
}
