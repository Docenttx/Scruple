from __future__ import annotations

from scruple_host_sdk import manifest as _manifest


def test_canonicalize_is_order_independent():
    a = {"b": 1, "a": 2}
    b = {"a": 2, "b": 1}
    assert _manifest.canonicalize(a) == _manifest.canonicalize(b)


def test_tamper_surface_hash_changes_when_code_changes(tmp_path):
    f = tmp_path / "adapter.py"
    f.write_text("VERSION = 1\n")

    h1 = _manifest.compute_tamper_surface_hash(integration_version="0.1.0", code_paths=[str(f)])

    f.write_text("VERSION = 2\n")
    h2 = _manifest.compute_tamper_surface_hash(integration_version="0.1.0", code_paths=[str(f)])

    assert h1 != h2
    assert len(h1) == 64  # hex sha256


def test_tamper_surface_hash_stable_when_nothing_changes(tmp_path):
    f = tmp_path / "adapter.py"
    f.write_text("VERSION = 1\n")

    h1 = _manifest.compute_tamper_surface_hash(integration_version="0.1.0", code_paths=[str(f)])
    h2 = _manifest.compute_tamper_surface_hash(integration_version="0.1.0", code_paths=[str(f)])

    assert h1 == h2


def test_missing_code_path_is_recorded_not_skipped(tmp_path):
    """Absence of a declared code path is itself tamper-relevant."""
    present = tmp_path / "a.py"
    present.write_text("x = 1\n")
    missing = str(tmp_path / "does_not_exist.py")

    with_missing = _manifest.compute_tamper_surface_hash(integration_version="0.1.0", code_paths=[str(present), missing])
    without_missing = _manifest.compute_tamper_surface_hash(integration_version="0.1.0", code_paths=[str(present)])

    assert with_missing != without_missing


def test_config_changes_the_hash():
    h1 = _manifest.compute_tamper_surface_hash(integration_version="0.1.0", config={"feature_x": True})
    h2 = _manifest.compute_tamper_surface_hash(integration_version="0.1.0", config={"feature_x": False})
    assert h1 != h2
