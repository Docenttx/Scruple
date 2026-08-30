// Composition: leaf + vendor-baseline predicate -> signed envelope, and back.
//
// This is the only file in lib/envelope that knows about both halves. The
// layers below it stay ignorant of each other on purpose:
//
//   pae.ts        knows bytes
//   dsse.ts       knows bytes and signatures
//   statement.ts  knows subjects and a predicateType STRING
//   predicate.ts  knows P1-P8 and nothing about signing
//   attest.ts     (here) knows both, and is therefore the only file that
//                 has to change when either side versions
//
// That last line is the acceptance criterion made structural. Bumping the
// predicate touches predicate.ts and this file's default; bumping the
// statement touches statement.ts and this file's default; neither reaches
// pae.ts or dsse.ts, and test/v2/envelope.test.ts proves it rather than
// asserting it in a comment.

import {
  signEnvelope,
  verifyEnvelope,
  type DsseEnvelope,
  type EnvelopeSigner,
  type EnvelopeVerifier,
} from './dsse';
import {
  SCRUPLE_STATEMENT_PAYLOAD_TYPE,
  SCRUPLE_STATEMENT_VERSION,
  buildStatement,
  leafSubject,
  parseStatement,
  serializeStatement,
  type ScrupleStatement,
  type WitnessLeaf,
} from './statement';
import {
  VENDOR_BASELINE_PREDICATE_VERSION,
  vendorBaselinePredicateType,
  validateVendorBaselinePredicate,
  type VendorBaselinePredicate,
} from './predicate';

export interface AttestLeafOptions {
  /** Defaults to the current predicate version. Bump independently. */
  predicateVersion?: number;
  /** Defaults to the current statement version. Bump independently. */
  statementVersion?: number;
  /** Refuse to sign an unsound predicate. Default true. */
  validate?: boolean;
}

/**
 * Wrap one leaf and one baseline posture in a signed envelope.
 *
 * The leaf goes in verbatim; see statement.ts. The predicate is validated
 * before signing by default, because a signature over an unsound posture is
 * a durable assertion of it.
 */
export function attestLeaf(
  leaf: WitnessLeaf,
  predicate: VendorBaselinePredicate,
  signers: EnvelopeSigner[],
  opts: AttestLeafOptions = {},
): DsseEnvelope {
  if (opts.validate !== false) {
    const errs = validateVendorBaselinePredicate(predicate);
    if (errs.length) {
      throw new Error(`refusing to sign an invalid vendor-baseline predicate:\n  ${errs.join('\n  ')}`);
    }
  }
  const statement = buildStatement(
    [leafSubject(leaf)],
    vendorBaselinePredicateType(opts.predicateVersion ?? VENDOR_BASELINE_PREDICATE_VERSION),
    predicate,
    opts.statementVersion ?? SCRUPLE_STATEMENT_VERSION,
  );
  return signEnvelope(SCRUPLE_STATEMENT_PAYLOAD_TYPE, serializeStatement(statement), signers);
}

export interface OpenedAttestation {
  statement: ScrupleStatement<VendorBaselinePredicate>;
  /** The leaf, exactly as it went in. */
  leaf: WitnessLeaf;
  predicate: VendorBaselinePredicate;
  predicateType: string;
  acceptedKeyIds: string[];
}

/**
 * Verify, then read. In that order, and the payload that is read is the one
 * `verifyEnvelope()` returned — the envelope is never re-parsed after
 * verification, which is DSSE envelope.md's one hard rule.
 */
export function openLeafAttestation(
  envelope: DsseEnvelope,
  verifiers: EnvelopeVerifier[],
  opts: { threshold?: number } = {},
): OpenedAttestation {
  const verified = verifyEnvelope(envelope, verifiers, opts);
  if (verified.payloadType !== SCRUPLE_STATEMENT_PAYLOAD_TYPE) {
    throw new Error(`unexpected payloadType '${verified.payloadType}'`);
  }
  const statement = parseStatement<VendorBaselinePredicate>(verified.payload);
  return {
    statement,
    leaf: statement.subject[0].leaf,
    predicate: statement.predicate,
    predicateType: statement.predicateType,
    acceptedKeyIds: verified.acceptedKeyIds,
  };
}
