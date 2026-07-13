"""Tests for envelope validation + canonicalization."""

from __future__ import annotations

import pytest

from scruple.envelope import (
    AttestationEnvelope,
    EnvelopeValidationError,
    canonicalize_envelope,
    envelope_validator,
)


VALID_NONCE = "a" * 64
VALID_TIME = "2026-07-13T00:00:00Z"


def _valid_raw(**overrides):
    d = {
        "attestation_type": "amd-sev-snp",
        "attestation_report": "aGVsbG8=",
        "certificate_chain": ["-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----\n"],
        "nonce": VALID_NONCE,
        "attestation_time": VALID_TIME,
    }
    d.update(overrides)
    return d


def test_accepts_built_in_type():
    env = envelope_validator(_valid_raw())
    assert env.attestation_type == "amd-sev-snp"
    assert env.nonce == VALID_NONCE


def test_accepts_passthrough_with_verifier_reference():
    env = envelope_validator(
        _valid_raw(attestation_type="custom-x", verifier_reference="https://v.example.com/")
    )
    assert env.attestation_type == "custom-x"
    assert env.verifier_reference == "https://v.example.com/"


def test_rejects_passthrough_without_verifier_reference():
    with pytest.raises(EnvelopeValidationError):
        envelope_validator(_valid_raw(attestation_type="custom-x"))


def test_rejects_non_mapping_input():
    with pytest.raises(EnvelopeValidationError):
        envelope_validator("not a dict")
    with pytest.raises(EnvelopeValidationError):
        envelope_validator(None)


def test_rejects_bad_nonce():
    with pytest.raises(EnvelopeValidationError):
        envelope_validator(_valid_raw(nonce="short"))
    with pytest.raises(EnvelopeValidationError):
        envelope_validator(_valid_raw(nonce="Z" * 64))


def test_rejects_http_verifier_reference():
    with pytest.raises(EnvelopeValidationError):
        envelope_validator(
            _valid_raw(attestation_type="custom-x", verifier_reference="http://insecure.example.com/")
        )


def test_canonicalize_envelope_stable():
    env = envelope_validator(_valid_raw())
    assert canonicalize_envelope(env) == canonicalize_envelope(env)


def test_canonicalize_sorted_keys():
    env = envelope_validator(_valid_raw())
    canon = canonicalize_envelope(env)
    positions = [
        canon.find('"attestation_report"'),
        canon.find('"attestation_time"'),
        canon.find('"attestation_type"'),
        canon.find('"certificate_chain"'),
        canon.find('"nonce"'),
    ]
    assert all(positions[i] < positions[i + 1] for i in range(len(positions) - 1))


def test_canonicalize_omits_verifier_reference_when_absent():
    env_no_ref = envelope_validator(_valid_raw())
    env_with_ref = envelope_validator(
        _valid_raw(attestation_type="custom-x", verifier_reference="https://v.example.com/")
    )
    assert "verifier_reference" not in canonicalize_envelope(env_no_ref)
    assert "verifier_reference" in canonicalize_envelope(env_with_ref)
