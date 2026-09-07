"""Canonical serialization + the hashes built on it.

`canonicalize`/`sha256_hex` moved to `scruple_api.manifest` textually
unchanged -- the SDK's own comment calls it "a near-verbatim port of
Blender's manifest.py" -- so the golden vectors move with them unchanged
too. If these ever stop matching, a leaf hashed in Blender and a leaf
hashed on the server have diverged, which is the reason the vectors are
spelled out by hand rather than computed.

Two things are new. `compute_tamper_surface_hash` has no counterpart in
the old addon at all, and it is what /api/v2/witness's baseline_ref is
keyed by -- its absence is why the addon could not reach v2. And
`build_machine_manifest` is host-agnostic now, so Blender's own fields
ride in `extra` instead of being hardcoded.
"""

from __future__ import annotations

import os

from adapter import flow as _flow
from adapter import scene as _scene
from adapter import sdk as _sdk
from scruple_host_sdk import manifest as _manifest


def test_canonicalize_sorts_keys():
    assert _manifest.canonicalize({"b": 1, "a": 2}) == '{"a":2,"b":1}'


def test_canonicalize_nested():
    got = _manifest.canonicalize({"outer": {"z": 1, "a": 2}, "list": [3, {"b": 1, "a": 0}]})
    assert got == '{"list":[3,{"a":0,"b":1}],"outer":{"a":2,"z":1}}'


def test_canonicalize_matches_server_shape():
    """Canonical form must round-trip byte-for-byte with the server's own
    canonicalize. That implementation is: sort keys, join with ',', wrap
    values with JSON.stringify."""
    payload = {"host": "blender", "version": "4.2.0", "flag": True, "num": 5, "arr": ["b", "a"]}
    expected = '{"arr":["b","a"],"flag":true,"host":"blender","num":5,"version":"4.2.0"}'
    assert _manifest.canonicalize(payload) == expected


def test_machine_manifest_is_host_agnostic_with_blender_in_extra():
    m = _manifest.build_machine_manifest(
        host="blender", integration_version="0.1.0", host_version="4.2.0",
        extra={"addon": "scruple-blender"},
    )
    assert m["host"] == "blender"
    assert m["integration_version"] == "0.1.0"
    assert m["sdk"] == "scruple-host-sdk"
    assert m["host_version"] == "4.2.0"
    assert m["addon"] == "scruple-blender"


def test_machine_manifest_hash_stable():
    m = _manifest.build_machine_manifest(host="blender", integration_version="0.1.0")
    h1 = _manifest.machine_manifest_hash(m)
    assert h1 == _manifest.machine_manifest_hash(m)
    assert len(h1) == 64


def test_adapter_machine_manifest_hash_folds_in_the_workflow(sdk_client):
    """The adapter's manifest carries the Blender workflow, so two
    renders with different settings do not hash the same."""
    a = _flow.machine_manifest_hash(sdk_client, {"kind": "blender_render", "samples": 8})
    b = _flow.machine_manifest_hash(sdk_client, {"kind": "blender_render", "samples": 9})
    assert len(a) == 64
    assert a != b


def test_tamper_surface_hash_changes_when_a_file_changes(tmp_path):
    """D-3's whole point: the surface must not change silently."""
    f = tmp_path / "mod.py"
    f.write_text("x = 1\n")
    before = _manifest.compute_tamper_surface_hash(integration_version="0.1.0", code_paths=[str(tmp_path)])
    f.write_text("x = 2\n")
    after = _manifest.compute_tamper_surface_hash(integration_version="0.1.0", code_paths=[str(tmp_path)])
    assert before != after


def test_tamper_surface_hash_is_stable_for_the_same_bytes(tmp_path):
    (tmp_path / "mod.py").write_text("x = 1\n")
    a = _manifest.compute_tamper_surface_hash(integration_version="0.1.0", code_paths=[str(tmp_path)])
    b = _manifest.compute_tamper_surface_hash(integration_version="0.1.0", code_paths=[str(tmp_path)])
    assert a == b


def test_the_addons_tamper_surface_includes_the_vendored_sdk():
    """A different SDK build is a different integration. vendor/ is in
    the measured surface, so swapping the SDK inside the zip changes the
    baseline rather than passing silently under the old one."""
    assert _sdk.VENDOR_DIR in _sdk.TAMPER_SURFACE_PATHS
    with_vendor = _manifest.compute_tamper_surface_hash(
        integration_version="0.1.0", code_paths=list(_sdk.TAMPER_SURFACE_PATHS),
    )
    without_vendor = _manifest.compute_tamper_surface_hash(
        integration_version="0.1.0",
        code_paths=[p for p in _sdk.TAMPER_SURFACE_PATHS if p != _sdk.VENDOR_DIR],
    )
    assert with_vendor != without_vendor


def test_tamper_surface_records_a_missing_path_rather_than_shrinking(tmp_path):
    """A path that is not there is tamper-relevant. The control for the
    two hashes above: dropping a file must not be a no-op."""
    present = _manifest.compute_tamper_surface_hash(
        integration_version="0.1.0", code_paths=[str(tmp_path / "gone.py")],
    )
    empty = _manifest.compute_tamper_surface_hash(integration_version="0.1.0", code_paths=[])
    assert present != empty
