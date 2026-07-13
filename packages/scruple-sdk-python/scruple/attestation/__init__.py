"""Per-vendor attestation fetchers.

Each vendor exposes a `fetch(nonce_hex: str) -> AttestationEnvelope` function
that wraps the platform's native attestation API and returns a valid envelope.

Current vendors:
  scruple.attestation.amd_sev_snp — WO-05
  scruple.attestation.nvidia_h100_cc — WO-07 (pending)
  scruple.attestation.aws_nitro — WO-08 (pending)
  scruple.attestation.azure_maa — WO-09 (pending)
  scruple.attestation.intel_tdx — WO-10 (pending)
  scruple.attestation.tpm_2 — WO-11 (pending)
"""


class AttestationUnavailable(RuntimeError):
    """Platform does not provide the requested attestation type."""


class AttestationFetchError(RuntimeError):
    """Underlying platform call failed."""
