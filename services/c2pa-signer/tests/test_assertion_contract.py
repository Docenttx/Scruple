"""Drift guard between the assertion emitter and the Signer's allowlist.

On 2026-08-04 the GPSA v3 remediation added a fail-closed allowlist to
the Signer. The allowlist did not contain a single one of the labels the
Application tier emits, so `partition_assertions` raised on every call
and nothing could be signed. It went unnoticed for three weeks: the
Signer CVM was powered down for cost reasons, so no end-to-end sign was
possible, and no CI job runs any test suite.

These tests fail loudly if the emitter and the enforcer drift apart
again. They need neither a running CVM nor a signing key.
"""

from __future__ import annotations

import json
import os
import re
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from assertion_partition import (  # noqa: E402
    CREATED_ALLOWLIST,
    GATHERED_ALLOWLIST,
    _base_label,
    partition_assertions,
)

REPO = os.path.abspath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..")
)
CONTRACT = os.path.join(REPO, "config", "c2pa-assertions.json")
SIGN_ASSET_TS = os.path.join(REPO, "lib", "c2pa", "signAsset.ts")


def _contract():
    with open(CONTRACT, "r", encoding="utf-8") as fh:
        return json.load(fh)


def _emitted_labels():
    """Every label literal in signAsset.ts's SCRUPLE_LABELS block.

    Read from the source rather than the contract on purpose: if someone
    hardcodes a label back into buildManifest and bypasses the shared
    contract, the contract still looks consistent and only this catches it.
    """
    with open(SIGN_ASSET_TS, "r", encoding="utf-8") as fh:
        src = fh.read()
    block = re.search(r"const SCRUPLE_LABELS = \{(.*?)\} as const;", src, re.S)
    assert block, "SCRUPLE_LABELS block not found in signAsset.ts"
    labels = re.findall(r":\s*'([^']+)'", block.group(1))
    assert labels, "no label literals found in SCRUPLE_LABELS"
    return labels


class TestEmitterMatchesAllowlist:
    def test_every_emitted_label_is_accepted(self):
        """The bug, stated as a test."""
        for label in _emitted_labels():
            base = _base_label(label)
            assert base in CREATED_ALLOWLIST or base in GATHERED_ALLOWLIST, (
                f"{label!r} is emitted by signAsset.ts but is on neither "
                f"allowlist — the Signer will refuse to sign EVERY asset. "
                f"Add it to created.application_tier in config/c2pa-assertions.json."
            )

    def test_emitted_labels_survive_partition(self):
        """End-to-end through the real partition function, not just set membership."""
        assertions = [{"label": l, "data": {}} for l in _emitted_labels()]
        part, audit = partition_assertions(assertions)
        assert audit["rejected_count"] == 0, audit.get("rejected_reason")
        assert len(part["created"]) == len(assertions), (
            "Application-tier assertions must land in created_assertions per "
            "GPSA §C.1.4 — the Application tier is inside the TOE."
        )

    def test_no_label_hardcoded_outside_the_constants_block(self):
        """buildManifest must reference SCRUPLE_LABELS, never a raw string."""
        with open(SIGN_ASSET_TS, "r", encoding="utf-8") as fh:
            src = fh.read()
        body = re.search(r"function buildManifest\(.*?\n\}", src, re.S)
        assert body, "buildManifest not found"
        stray = re.findall(r"label:\s*'([^']+)'", body.group(0))
        assert not stray, (
            f"buildManifest hardcodes assertion label(s) {stray} instead of "
            f"using SCRUPLE_LABELS — this bypasses the shared contract."
        )


class TestContractIntegrity:
    def test_allowlists_are_built_from_the_contract(self):
        c = _contract()
        expected_created = set(
            c["created"]["c2pa_sdk"]
            + c["created"]["signer"]
            + c["created"]["application_tier"]
        )
        assert set(CREATED_ALLOWLIST) == expected_created
        assert set(GATHERED_ALLOWLIST) == set(c["gathered"]["labels"])

    def test_contract_labels_are_base_labels(self):
        """A versioned label in the contract would never match: the allowlist
        is consulted with the .vN already stripped."""
        c = _contract()
        every = (
            c["created"]["c2pa_sdk"]
            + c["created"]["signer"]
            + c["created"]["application_tier"]
            + c["gathered"]["labels"]
        )
        for label in every:
            assert _base_label(label) == label, (
                f"{label!r} carries a version suffix; store the base label."
            )

    def test_created_and_gathered_are_disjoint(self):
        assert not (set(CREATED_ALLOWLIST) & set(GATHERED_ALLOWLIST))

    def test_missing_contract_fails_closed(self):
        """A permissive fallback would silently re-open the drift."""
        import assertion_partition as ap

        original = ap._CONTRACT_PATH
        try:
            ap._CONTRACT_PATH = os.path.join(REPO, "config", "does-not-exist.json")
            with pytest.raises(Exception):
                ap._load_contract()
        finally:
            ap._CONTRACT_PATH = original


class TestFailClosedStillHolds:
    """The allowlist was right to be fail-closed. Prove the fix didn't
    soften it while making room for our own labels."""

    def test_unknown_label_still_refuses(self):
        with pytest.raises(ValueError, match="refusing to sign"):
            partition_assertions([{"label": "com.attacker.forged", "data": {}}])

    def test_external_provenance_still_gathered_not_created(self):
        part, _ = partition_assertions(
            [{"label": "stds.exif", "data": {}}, {"label": "ai.scruple.provenance.v1", "data": {}}]
        )
        assert [a["label"] for a in part["gathered"]] == ["stds.exif"]
        assert [a["label"] for a in part["created"]] == ["ai.scruple.provenance.v1"]
