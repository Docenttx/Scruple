"""Tests for baseline hash computation."""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

import pytest

from scruple.baseline import compute_baseline_hash, load_manifest


def _make_fixture(tmp: Path) -> Path:
    """Create a minimal integration tamper-surface for hashing."""
    (tmp / "src").mkdir()
    (tmp / "src" / "witness.py").write_text("def hash_file(p): pass\n")
    (tmp / "src" / "witness_client.py").write_text("class WitnessClient: pass\n")
    (tmp / "requirements.txt").write_text("scruple==0.1.0\n")
    manifest_text = f"""
integration_id: test-integration
version: 1.0.0
declared_at: '2026-07-13T00:00:00Z'
code:
  - src/*.py
dependencies:
  - requirements.txt
attestation:
  provider: none
"""
    manifest_path = tmp / "scruple-baseline.yaml"
    manifest_path.write_text(manifest_text)
    return manifest_path


def test_compute_baseline_hash_stable_across_two_runs(tmp_path: Path) -> None:
    manifest_path = _make_fixture(tmp_path)
    m = load_manifest(manifest_path)
    hash_a, blob_a = compute_baseline_hash(m, signer_pubkey_spki_sha256_hex="a" * 64)
    hash_b, blob_b = compute_baseline_hash(m, signer_pubkey_spki_sha256_hex="a" * 64)
    assert hash_a == hash_b
    assert blob_a == blob_b


def test_compute_baseline_hash_changes_when_file_changes(tmp_path: Path) -> None:
    manifest_path = _make_fixture(tmp_path)
    m = load_manifest(manifest_path)
    hash_before, _ = compute_baseline_hash(m, signer_pubkey_spki_sha256_hex="a" * 64)
    # Modify a covered file
    (tmp_path / "src" / "witness.py").write_text("def hash_file(p): return 'x'\n")
    hash_after, _ = compute_baseline_hash(m, signer_pubkey_spki_sha256_hex="a" * 64)
    assert hash_before != hash_after


def test_compute_baseline_hash_unchanged_when_uncovered_file_changes(tmp_path: Path) -> None:
    manifest_path = _make_fixture(tmp_path)
    m = load_manifest(manifest_path)
    hash_before, _ = compute_baseline_hash(m, signer_pubkey_spki_sha256_hex="a" * 64)
    # Create a file NOT in the baseline glob
    (tmp_path / "README.md").write_text("hi\n")
    hash_after, _ = compute_baseline_hash(m, signer_pubkey_spki_sha256_hex="a" * 64)
    assert hash_before == hash_after


def test_compute_baseline_hash_changes_with_different_pubkey(tmp_path: Path) -> None:
    manifest_path = _make_fixture(tmp_path)
    m = load_manifest(manifest_path)
    h1, _ = compute_baseline_hash(m, signer_pubkey_spki_sha256_hex="a" * 64)
    h2, _ = compute_baseline_hash(m, signer_pubkey_spki_sha256_hex="b" * 64)
    assert h1 != h2


def test_compute_baseline_hash_includes_env_config(tmp_path: Path) -> None:
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "witness.py").write_text("pass\n")
    manifest_text = """
integration_id: env-test
version: 1.0.0
declared_at: '2026-07-13T00:00:00Z'
code:
  - src/*.py
config:
  env:
    - name: WITNESS_URL
      value: https://witness.scruple.ai
    - name: SCRUPLE_API_KEY_HANDLE
      handle: vault://scruple/api-key
attestation:
  provider: none
"""
    manifest_path = tmp_path / "scruple-baseline.yaml"
    manifest_path.write_text(manifest_text)
    m = load_manifest(manifest_path)
    h1, blob = compute_baseline_hash(m, signer_pubkey_spki_sha256_hex="a" * 64)
    # value_or_handle should reflect both cases
    names = [e["name"] for e in blob["config_env"]]
    assert names == sorted(names)
    handles = {e["name"]: e["value_or_handle"] for e in blob["config_env"]}
    assert handles["WITNESS_URL"] == "https://witness.scruple.ai"
    assert handles["SCRUPLE_API_KEY_HANDLE"] == "vault://scruple/api-key"


def test_load_manifest_rejects_missing_required_fields(tmp_path: Path) -> None:
    bad = tmp_path / "bad.yaml"
    bad.write_text("code: []\n")
    with pytest.raises(ValueError, match="integration_id"):
        load_manifest(bad)
