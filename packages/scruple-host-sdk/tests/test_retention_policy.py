"""The retention-policy digest, checked ACROSS LANGUAGES.

WO-C3. Architect's second settle condition on the claims-versus-evidence
split:

    "the ``retention_policy_digest`` must bind evidence RETENTION DURATION,
     not just policy identity, so a resolution attempt after the evidence is
     legitimately gone yields a named ``evidence_expired`` state rather than
     being INDISTINGUISHABLE FROM A FORGED HANDLE."

⚑ THE VECTORS ARE READ AND THE DIGESTS ARE RECOMPUTED. `test/vectors/
retention-policy-vectors.json` is generated from `lib/leaf/retentionPolicy.ts`;
every assertion below runs the PYTHON implementation over the same policy and
compares. A test that read the digest out of the file and compared it to
itself would pass forever, which is the failure `test_ratchet.py` exists to
avoid one directory over.
"""

import json
import pathlib

import pytest

from scruple_api.retention import (
    DEFAULT_RETENTION_POLICY,
    DEFAULT_RETENTION_POLICY_DIGEST,
    RetentionPolicyError,
    canonical_retention_policy,
    retention_policy_digest,
    validate_retention_policy,
)

VECTORS = (
    pathlib.Path(__file__).resolve().parents[3] / "test" / "vectors" / "retention-policy-vectors.json"
)


@pytest.fixture(scope="module")
def vectors():
    if not VECTORS.exists():  # pragma: no cover
        pytest.skip(f"{VECTORS} not generated")
    return json.loads(VECTORS.read_text())


def test_python_recomputes_every_typescript_digest(vectors):
    for case in vectors["accepted"]:
        assert retention_policy_digest(case["policy"]) == case["digest"], case["name"]


def test_python_produces_the_same_canonical_bytes(vectors):
    """Not only the hash: the bytes under it, so a disagreement is one
    failure here rather than a hash incident later."""
    for case in vectors["accepted"]:
        assert canonical_retention_policy(case["policy"]) == case["canonical_json"], case["name"]


def test_python_refuses_every_policy_the_typescript_refuses(vectors):
    for case in vectors["refused"]:
        assert case["typescript_reason"], case["name"]
        with pytest.raises(RetentionPolicyError):
            validate_retention_policy(case["policy"])


def test_the_digest_binds_the_DURATION_and_not_the_identity():
    """The claim in the field's name, tested directly.

    Same ``policy_id``, one second more retention, different digest. And the
    control that makes it mean something: the identity really is unchanged, so
    what moved the digest was the duration and not the object.
    """
    longer = {**DEFAULT_RETENTION_POLICY, "retention_duration_s": 30 * 24 * 3600 + 1}
    assert longer["policy_id"] == DEFAULT_RETENTION_POLICY["policy_id"]
    assert retention_policy_digest(longer) != DEFAULT_RETENTION_POLICY_DIGEST

    # And a digest over the IDENTITY ALONE — the shape the council refused —
    # cannot distinguish them at all. Spelled out rather than described,
    # because this is the failure the field exists to prevent.
    import hashlib

    identity_only = lambda p: hashlib.sha256(p["policy_id"].encode()).hexdigest()
    assert identity_only(longer) == identity_only(DEFAULT_RETENTION_POLICY)


def test_a_leaf_may_not_count_its_deadline_on_its_own_clock():
    for name in ("local", "system", "component", "host", "none", ""):
        with pytest.raises(RetentionPolicyError):
            validate_retention_policy({**DEFAULT_RETENTION_POLICY, "clock": name})


def test_a_window_longer_than_the_retention_is_refused():
    with pytest.raises(RetentionPolicyError):
        validate_retention_policy(
            {**DEFAULT_RETENTION_POLICY, "settlement_window_s": 60 * 24 * 3600}
        )
