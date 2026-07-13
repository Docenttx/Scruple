// Attestation envelope — normalized shape carried by every leaf that
// asserts a hardware attestation for the customer's compute environment.
//
// Per Scruple Standard v1.2 §15 and Integration Requirements v1.2 §4.
//
// The envelope is the same shape at baseline install time and at
// per-leaf witness time; only the `nonce` binding changes (SPKI hash
// vs. leaf preimage hash).

/** Built-in attestation types the shared library ships a verifier plugin for. */
export const BUILT_IN_ATTESTATION_TYPES = [
  'amd-sev-snp',
  'intel-tdx',
  'aws-nitro-enclave',
  'gcp-confidential-space',
  'azure-attestation-service',
  'nvidia-h100-cc',
  'tpm-2.0-quote',
] as const;

export type BuiltInAttestationType = (typeof BUILT_IN_ATTESTATION_TYPES)[number];

/** Special "no attestation" marker. */
export const NONE_ATTESTATION_TYPE = 'none' as const;

export interface AttestationEnvelope {
  /**
   * Well-known type string. If not in BUILT_IN_ATTESTATION_TYPES and not
   * 'none', treated as passthrough — `verifier_reference` is required.
   */
  attestation_type: string;
  /** Base64-encoded raw report bytes OR a JWT string, per verifier convention. */
  attestation_report: string;
  /** PEM-encoded certificates chained leaf-to-root. */
  certificate_chain: string[];
  /**
   * Hex-encoded 32-byte nonce that MUST equal SHA-256 of the associated
   * leaf's preimage (excluding this envelope itself). At baseline install,
   * this instead binds the SPKI hash of the baseline signing key.
   */
  nonce: string;
  /** RFC 3339 UTC. */
  attestation_time: string;
  /**
   * Required if `attestation_type` is not built-in. URL of an independent
   * verifier the customer trusts; receipt reads this as passthrough.
   */
  verifier_reference?: string;
}

export class EnvelopeValidationError extends Error {
  constructor(message: string) {
    super(`envelope validation: ${message}`);
    this.name = 'EnvelopeValidationError';
  }
}

/**
 * Validate the shape of an unknown value and return it typed as
 * AttestationEnvelope. Throws EnvelopeValidationError on any failure.
 */
export function envelopeSchemaValidator(e: unknown): AttestationEnvelope {
  if (e === null || typeof e !== 'object') {
    throw new EnvelopeValidationError('envelope MUST be an object');
  }
  const env = e as Record<string, unknown>;

  const requireString = (k: string, minLen = 1): string => {
    const v = env[k];
    if (typeof v !== 'string' || v.length < minLen) {
      throw new EnvelopeValidationError(`field '${k}' MUST be a non-empty string`);
    }
    return v;
  };

  const attestation_type = requireString('attestation_type');
  const attestation_report = requireString('attestation_report');
  const nonce = requireString('nonce');
  if (!/^[0-9a-f]{64}$/.test(nonce)) {
    throw new EnvelopeValidationError('nonce MUST be 64 hex chars (32-byte SHA-256)');
  }
  const attestation_time = requireString('attestation_time');
  // Best-effort RFC 3339 check; verifier plugins do stricter freshness math
  if (Number.isNaN(Date.parse(attestation_time))) {
    throw new EnvelopeValidationError('attestation_time MUST be an RFC 3339 date-time');
  }

  const certChainRaw = env.certificate_chain;
  if (!Array.isArray(certChainRaw)) {
    throw new EnvelopeValidationError("'certificate_chain' MUST be an array");
  }
  const certificate_chain = certChainRaw.map((c, i) => {
    if (typeof c !== 'string') {
      throw new EnvelopeValidationError(`certificate_chain[${i}] MUST be a string`);
    }
    return c;
  });

  const isBuiltIn = (BUILT_IN_ATTESTATION_TYPES as readonly string[]).includes(attestation_type);
  const isNone = attestation_type === NONE_ATTESTATION_TYPE;
  let verifier_reference: string | undefined;
  if (env.verifier_reference !== undefined) {
    if (typeof env.verifier_reference !== 'string') {
      throw new EnvelopeValidationError('verifier_reference MUST be a string when present');
    }
    if (!/^https:\/\//i.test(env.verifier_reference)) {
      throw new EnvelopeValidationError('verifier_reference MUST be an https URL');
    }
    verifier_reference = env.verifier_reference;
  }
  if (!isBuiltIn && !isNone && !verifier_reference) {
    throw new EnvelopeValidationError(
      `attestation_type '${attestation_type}' is not built-in; passthrough envelopes MUST supply 'verifier_reference'`,
    );
  }

  return {
    attestation_type,
    attestation_report,
    certificate_chain,
    nonce,
    attestation_time,
    ...(verifier_reference ? { verifier_reference } : {}),
  };
}

/**
 * Byte-stable canonical serialization of an envelope. Sorted keys, compact
 * JSON, deterministic array ordering. Used for envelope-hash computation
 * and inclusion in leaf preimages that reference the envelope.
 */
export function canonicalizeEnvelope(e: AttestationEnvelope): string {
  const ordered: Record<string, unknown> = {
    attestation_report: e.attestation_report,
    attestation_time: e.attestation_time,
    attestation_type: e.attestation_type,
    certificate_chain: e.certificate_chain,
    nonce: e.nonce,
  };
  if (e.verifier_reference !== undefined) {
    ordered.verifier_reference = e.verifier_reference;
  }
  // Sort keys alphabetically for stable output regardless of insertion order.
  const keys = Object.keys(ordered).sort();
  const parts = keys.map((k) => JSON.stringify(k) + ':' + JSON.stringify(ordered[k]));
  return '{' + parts.join(',') + '}';
}

export function isBuiltInType(t: string): t is BuiltInAttestationType {
  return (BUILT_IN_ATTESTATION_TYPES as readonly string[]).includes(t);
}

export function isPassthroughType(t: string): boolean {
  return t !== NONE_ATTESTATION_TYPE && !isBuiltInType(t);
}
