"""Golden vectors for canonical serialization + hash stability."""

from __future__ import annotations

import hashlib
import json

from lib import manifest as _manifest


def test_canonicalize_sorts_keys():
    assert _manifest.canonicalize({"b": 1, "a": 2}) == '{"a":2,"b":1}'


def test_canonicalize_nested():
    got = _manifest.canonicalize({"outer": {"z": 1, "a": 2}, "list": [3, {"b": 1, "a": 0}]})
    assert got == '{"list":[3,{"a":0,"b":1}],"outer":{"a":2,"z":1}}'


def test_canonicalize_matches_server_shape():
    """Blender canonical form must round-trip byte-for-byte with the
    server's own canonicalize in /data/scruple-web/app/api/witness/cad/route.ts.
    That server implementation is: sort keys, join with ',', wrap values with
    JSON.stringify."""
    payload = {"host": "blender", "version": "4.2.0", "flag": True, "num": 5, "arr": ["b", "a"]}
    got = _manifest.canonicalize(payload)
    expected = '{"arr":["b","a"],"flag":true,"host":"blender","num":5,"version":"4.2.0"}'
    assert got == expected


def test_machine_manifest_shape():
    m = _manifest.build_machine_manifest("4.2.0")
    assert m["host"] == "blender"
    assert m["blender_version"] == "4.2.0"
    assert m["addon"] == "scruple-blender"
    assert m["addon_version"] == _manifest.ADDON_VERSION


def test_machine_manifest_hash_stable():
    m = _manifest.build_machine_manifest("4.2.0")
    h1 = _manifest.machine_manifest_hash(m)
    h2 = _manifest.machine_manifest_hash(m)
    assert h1 == h2
    assert len(h1) == 64


def test_render_workflow_fields():
    w = _manifest.build_render_workflow(
        filename="scene.0001.png",
        scene_name="Scene",
        render_engine="CYCLES",
        resolution=(1920, 1080),
        samples=128,
        camera="Camera",
        frame=1,
    )
    assert w["kind"] == "blender_render"
    assert w["resolution"] == [1920, 1080]
    assert w["samples"] == 128
    assert w["camera"] == "Camera"


def test_save_workflow_fields():
    w = _manifest.build_save_workflow(
        filepath="/tmp/x.blend", scene_name="Scene",
        object_count=3, material_count=1,
    )
    assert w["kind"] == "blender_save"
    assert w["object_count"] == 3


def test_export_workflow_fields():
    w = _manifest.build_export_workflow(
        filepath="/tmp/x.glb", format="glTF",
        scene_name="Scene", exporter_options={"embed_textures": True},
    )
    assert w["format"] == "gltf"
    assert w["options"] == {"embed_textures": True}
