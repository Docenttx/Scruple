"""AttestationEnvelope — normalized shape for platform attestation.

Mirror of packages/scruple-attestation-verifiers/src/envelope.ts. The
Python SDK constructs envelopes; the TypeScript server verifies them.
The two implementations MUST agree on canonicalization + validation.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional

from scruple.canonical import canonicalize

BUILT_IN_ATTESTATION_TYPES = frozenset(
    {
        "amd-sev-snp",
        "intel-tdx",
        "aws-nitro-enclave",
        "gcp-confidential-space",
        "azure-attestation-service",
        "nvidia-h100-cc",
        "tpm-2.0-quote",
    }
)

NONE_ATTESTATION_TYPE = "none"


class EnvelopeValidationError(ValueError):
    """Envelope shape validation failure."""


@dataclass
class AttestationEnvelope:
    attestation_type: str
    attestation_report: str  # base64 or JWT
    certificate_chain: list[str]  # PEMs
    nonce: str  # 64 hex chars
    attestation_time: str  # RFC 3339
    verifier_reference: Optional[str] = None

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {
            "attestation_type": self.attestation_type,
            "attestation_report": self.attestation_report,
            "certificate_chain": list(self.certificate_chain),
            "nonce": self.nonce,
            "attestation_time": self.attestation_time,
        }
        if self.verifier_reference is not None:
            d["verifier_reference"] = self.verifier_reference
        return d


def _is_hex64(s: Any) -> bool:
    if not isinstance(s, str) or len(s) != 64:
        return False
    try:
        int(s, 16)
        return True
    except ValueError:
        return False


def envelope_validator(raw: Any) -> AttestationEnvelope:
    """Validate an incoming dict-like value and return a typed envelope.

    Raises EnvelopeValidationError on any shape issue.
    """
    if not isinstance(raw, dict):
        raise EnvelopeValidationError("envelope MUST be a mapping")
    required_str = ["attestation_type", "attestation_report", "nonce", "attestation_time"]
    for k in required_str:
        v = raw.get(k)
        if not isinstance(v, str) or v == "":
            raise EnvelopeValidationError(f"field '{k}' MUST be a non-empty string")
    if not _is_hex64(raw["nonce"]):
        raise EnvelopeValidationError("nonce MUST be 64 hex chars (32-byte SHA-256)")
    # Best-effort RFC 3339 check — verifier plugins do stricter math
    import datetime
    try:
        # Accept both trailing Z and explicit UTC offset
        s = raw["attestation_time"].replace("Z", "+00:00")
        datetime.datetime.fromisoformat(s)
    except Exception as exc:
        raise EnvelopeValidationError(f"attestation_time not RFC 3339: {exc}") from None

    chain = raw.get("certificate_chain")
    if not isinstance(chain, list):
        raise EnvelopeValidationError("'certificate_chain' MUST be a list")
    for i, c in enumerate(chain):
        if not isinstance(c, str):
            raise EnvelopeValidationError(f"certificate_chain[{i}] MUST be a string")

    verifier_reference = raw.get("verifier_reference")
    if verifier_reference is not None:
        if not isinstance(verifier_reference, str):
            raise EnvelopeValidationError("verifier_reference MUST be a string when present")
        if not verifier_reference.lower().startswith("https://"):
            raise EnvelopeValidationError("verifier_reference MUST be an https URL")

    t = raw["attestation_type"]
    is_built_in = t in BUILT_IN_ATTESTATION_TYPES
    is_none = t == NONE_ATTESTATION_TYPE
    if not is_built_in and not is_none and verifier_reference is None:
        raise EnvelopeValidationError(
            f"attestation_type '{t}' is not built-in; passthrough envelopes MUST supply verifier_reference"
        )

    return AttestationEnvelope(
        attestation_type=t,
        attestation_report=raw["attestation_report"],
        certificate_chain=list(chain),
        nonce=raw["nonce"],
        attestation_time=raw["attestation_time"],
        verifier_reference=verifier_reference,
    )


def canonicalize_envelope(env: AttestationEnvelope) -> str:
    """Byte-stable canonical serialization matching the TS implementation."""
    return canonicalize(env.to_dict())
