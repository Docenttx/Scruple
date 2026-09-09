"""The retention policy digest, in Python.

WO-C3. The council's second settle condition on the claims-versus-evidence
split, and this is the Python half of it:

    "the ``retention_policy_digest`` must bind evidence RETENTION DURATION,
     not just policy identity, so a resolution attempt after the evidence is
     legitimately gone yields a named ``evidence_expired`` state rather than
     being INDISTINGUISHABLE FROM A FORGED HANDLE."

⚑ THIS IS A SECOND IMPLEMENTATION ON PURPOSE, not a constant copied over.
``lib/leaf/retentionPolicy.ts`` is the first. A digest is only a binding if two
parties can independently arrive at the same one from the same policy, and a
Python module that hardcoded the TypeScript module's answer would agree with it
by construction and would go on agreeing after the TypeScript changed.
``test/vectors/retention-policy-vectors.json`` is generated from the TypeScript
and ``tests/test_retention_policy.py`` recomputes every vector here.

The policy object is small and every field is inside the digest. There is no
un-digested half, because a half nobody hashes is a half anybody edits.
"""

from __future__ import annotations

import hashlib
from typing import Any, Dict, Mapping

from .canonical import canonicalize

RETENTION_POLICY_VERSION = 1

#: Names a leaf may never give as its clock -- the emitter saying "mine" in a
#: word that sounds like an institution. Mirrors ``REFUSED_CLOCK_NAMES`` in
#: ``lib/leaf/namedClock.ts``.
REFUSED_CLOCK_NAMES = frozenset(
    {
        "",
        "local",
        "localhost",
        "system",
        "host",
        "component",
        "client",
        "wall",
        "none",
        "default",
    }
)

_FIELDS = ("version", "policy_id", "clock", "retention_duration_s", "settlement_window_s")
_MAX_DURATION_S = 366 * 24 * 3600


class RetentionPolicyError(ValueError):
    """A policy with no canonical form, or no meaning."""


def validate_retention_policy(p: Mapping[str, Any]) -> None:
    if not isinstance(p, Mapping):
        raise RetentionPolicyError("not an object")
    if p.get("version") != RETENTION_POLICY_VERSION:
        raise RetentionPolicyError(f"version must be {RETENTION_POLICY_VERSION}")
    for k in ("policy_id", "clock"):
        v = p.get(k)
        if not isinstance(v, str) or not v.strip():
            raise RetentionPolicyError(f"{k} must be a non-empty string")
    if str(p["clock"]).strip().lower() in REFUSED_CLOCK_NAMES:
        raise RetentionPolicyError(
            f"clock {p['clock']!r} is the emitter's own clock under an institutional-sounding "
            "name; a deadline counted on it is the config-inherited field class this design "
            "refuses"
        )
    for k in ("retention_duration_s", "settlement_window_s"):
        v = p.get(k)
        if not isinstance(v, int) or isinstance(v, bool) or v <= 0:
            raise RetentionPolicyError(f"{k} must be a positive integer number of seconds")
        if v > _MAX_DURATION_S:
            raise RetentionPolicyError(f"{k} exceeds one year")
    if p["settlement_window_s"] > p["retention_duration_s"]:
        raise RetentionPolicyError(
            "settlement_window_s exceeds retention_duration_s: the gap would become terminal "
            "after the evidence needed to settle it is gone, which is a deadline nobody can "
            "ever check"
        )
    extra = [k for k in p if k not in _FIELDS]
    if extra:
        raise RetentionPolicyError(f"unknown keys: {', '.join(sorted(extra))}")


def canonical_retention_policy(p: Mapping[str, Any]) -> str:
    validate_retention_policy(p)
    return canonicalize({k: p[k] for k in _FIELDS})


def retention_policy_digest(p: Mapping[str, Any]) -> str:
    """``sha256:<hex>`` over the canonical policy -- DURATIONS INCLUDED."""
    return (
        "sha256:"
        + hashlib.sha256(canonical_retention_policy(p).encode("utf-8")).hexdigest()
    )


#: The policy migration 055 seeds. A deployment with its own retention terms
#: enrols them and configures the digest; this is what a deployment that
#: enrolled nothing emits under, so that its digest RESOLVES rather than being
#: refused at ingest for naming a policy nobody recorded.
DEFAULT_RETENTION_POLICY: Dict[str, Any] = {
    "version": RETENTION_POLICY_VERSION,
    "policy_id": "scruple-default-v1",
    "clock": "scruple-witness-v2",
    "retention_duration_s": 30 * 24 * 3600,
    "settlement_window_s": 24 * 3600,
}

DEFAULT_RETENTION_POLICY_DIGEST = retention_policy_digest(DEFAULT_RETENTION_POLICY)
