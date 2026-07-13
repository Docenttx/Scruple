"""Scruple SDK.

Implements the customer-side machinery for the Scruple witnessing API:
  - Baseline manifest parsing (scruple-baseline.yaml)
  - Baseline hash computation (deterministic, cross-language)
  - Attestation envelope construction + validation
  - WitnessClient — top-level object that talks to /api/v1/tenants/*

Load the vendor-specific attestation fetchers from
  scruple.attestation.<vendor>

See docs/architecture/SCRUPLE_INTEGRATION_REQUIREMENTS_v1.md.
"""

from scruple.baseline import (
    BaselineManifest,
    compute_baseline_hash,
    load_manifest,
)
from scruple.envelope import (
    AttestationEnvelope,
    EnvelopeValidationError,
    envelope_validator,
    canonicalize_envelope,
)
from scruple.client import (
    WitnessClient,
    BaselineDriftError,
    BaselineOutOfSyncError,
    WitnessCallError,
)

__version__ = "0.1.0"
__all__ = [
    "BaselineManifest",
    "compute_baseline_hash",
    "load_manifest",
    "AttestationEnvelope",
    "EnvelopeValidationError",
    "envelope_validator",
    "canonicalize_envelope",
    "WitnessClient",
    "BaselineDriftError",
    "BaselineOutOfSyncError",
    "WitnessCallError",
]
