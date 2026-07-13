"""Tests for SDK baseline drift detection flow.

Exercises the WitnessClient's on_baseline_drift behavior against a
mock HTTP server. Confirms:
  - 'raise' → BaselineDriftError raised on drift
  - 'warn' → drift returns True but no exception
  - 'auto_rebaseline' → server sees a POST /rebaseline call

Actual server integration (real Next.js dev server) is exercised by
scripts/smoke-baseline-e2e-sev-snp.sh; this file uses mocks so it can
run in CI without server infra.
"""

from __future__ import annotations

import json
from pathlib import Path
from unittest import mock

import pytest

from scruple.baseline import compute_baseline_hash, load_manifest
from scruple.client import BaselineDriftError, WitnessClient


def _fixture(tmp_path: Path) -> Path:
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "w.py").write_text("pass\n")
    (tmp_path / "scruple-baseline.yaml").write_text(
        """
integration_id: drift-test
version: 1.0.0
declared_at: '2026-07-13T00:00:00Z'
code:
  - src/*.py
attestation:
  provider: none
"""
    )
    return tmp_path / "scruple-baseline.yaml"


class MockSession:
    def __init__(self, current_baseline_hash: str | None):
        self.current = current_baseline_hash
        self.rebaseline_called = False
        self.submit_called = False

    def get(self, url, headers=None, timeout=None):
        r = mock.Mock()
        if url.endswith("/baseline/current"):
            if self.current is None:
                r.status_code = 404
                r.json = mock.Mock(return_value={"error": "no baseline"})
            else:
                r.status_code = 200
                r.json = mock.Mock(
                    return_value={
                        "baseline_hash": self.current,
                        "activated_at": "2026-07-13T00:00:00Z",
                        "attestation_provider": "none",
                        "signer_pubkey_spki_sha256_hex": "b" * 64,
                    }
                )
        r.raise_for_status = mock.Mock()
        return r

    def post(self, url, headers=None, json=None, timeout=None):
        r = mock.Mock()
        if url.endswith("/baseline"):
            self.submit_called = True
            self.current = json["manifest_hash_hex"]
            r.status_code = 200
            r.json = mock.Mock(return_value={"baseline_id": 1, "baseline_hash": self.current, "activated_at": "2026-07-13T00:00:00Z", "witness_leaf_id": None})
        elif url.endswith("/rebaseline"):
            self.rebaseline_called = True
            self.current = json["manifest_hash_hex"]
            r.status_code = 200
            r.json = mock.Mock(return_value={"baseline_id": 2, "baseline_hash": self.current, "activated_at": "2026-07-13T00:01:00Z", "witness_leaf_id": None})
        r.raise_for_status = mock.Mock()
        return r


def _make_client(tmp_path: Path, on_drift: str, session: MockSession) -> WitnessClient:
    manifest = _fixture(tmp_path)
    client = WitnessClient(
        api_base="https://witness.test.local",
        tenant="TEN_test",
        api_key="sk_test_x",
        baseline_manifest_path=manifest,
        signer_pubkey_spki_sha256_hex="c" * 64,
        on_baseline_drift=on_drift,
    )
    return client


def test_drift_raise(tmp_path: Path):
    session = MockSession(current_baseline_hash="deadbeef" * 8)  # wrong hash
    client = _make_client(tmp_path, "raise", session)
    with mock.patch("scruple.client.requests.get", side_effect=session.get), \
         mock.patch("scruple.client.requests.post", side_effect=session.post):
        with pytest.raises(BaselineDriftError):
            client.check_baseline_drift()


def test_drift_warn_no_raise(tmp_path: Path):
    session = MockSession(current_baseline_hash="deadbeef" * 8)
    client = _make_client(tmp_path, "warn", session)
    with mock.patch("scruple.client.requests.get", side_effect=session.get), \
         mock.patch("scruple.client.requests.post", side_effect=session.post):
        drifted = client.check_baseline_drift()
        assert drifted is True


def test_drift_auto_rebaseline(tmp_path: Path):
    session = MockSession(current_baseline_hash="deadbeef" * 8)
    client = _make_client(tmp_path, "auto_rebaseline", session)
    with mock.patch("scruple.client.requests.get", side_effect=session.get), \
         mock.patch("scruple.client.requests.post", side_effect=session.post):
        drifted = client.check_baseline_drift()
        assert drifted is False   # auto-resolved
        assert session.rebaseline_called is True


def test_no_drift_when_local_matches_server(tmp_path: Path):
    manifest = _fixture(tmp_path)
    m = load_manifest(manifest)
    local_hash, _ = compute_baseline_hash(m, signer_pubkey_spki_sha256_hex="c" * 64)
    session = MockSession(current_baseline_hash=local_hash)
    client = _make_client(tmp_path, "raise", session)
    with mock.patch("scruple.client.requests.get", side_effect=session.get), \
         mock.patch("scruple.client.requests.post", side_effect=session.post):
        drifted = client.check_baseline_drift()
        assert drifted is False
