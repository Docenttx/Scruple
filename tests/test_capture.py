"""Capture pipeline tests — hashing, path resolution, frame substitution."""

from __future__ import annotations

import base64
import hashlib
import os

import pytest

from lib import capture as _capture
from tests.mocks import bpy_mock


def _write_bytes(tmp_path, name, contents: bytes):
    p = tmp_path / name
    p.write_bytes(contents)
    return str(p)


def test_sha256_file_matches_stdlib(tmp_path):
    p = _write_bytes(tmp_path, "x.bin", b"hello")
    assert _capture.sha256_file(p) == hashlib.sha256(b"hello").hexdigest()


def test_sha256_streams_over_multiple_chunks(tmp_path):
    payload = b"a" * (_capture.CHUNK_SIZE * 2 + 100)
    p = _write_bytes(tmp_path, "big.bin", payload)
    assert _capture.sha256_file(p, chunk=1024) == hashlib.sha256(payload).hexdigest()


def test_inline_base64_round_trips(tmp_path):
    p = _write_bytes(tmp_path, "x.bin", b"\x00\x01\x02")
    encoded = _capture.inline_base64(p)
    assert base64.b64decode(encoded) == b"\x00\x01\x02"


def test_frame_substitution_pads_with_zeros():
    got = _capture._substitute_frame_hashes("/tmp/render####.png", 3)
    assert got == "/tmp/render0003.png"


def test_frame_substitution_noop_without_hashes():
    got = _capture._substitute_frame_hashes("/tmp/render.png", 3)
    assert got == "/tmp/render.png"


def test_resolved_render_output_expands_and_substitutes(tmp_path):
    scene = bpy_mock.Scene()
    scene.render.filepath = str(tmp_path / "img####.png")
    scene.frame_current = 5
    resolved = _capture.resolved_render_output(scene)
    assert resolved.endswith("img0005.png")


def test_capture_render_returns_none_when_no_file(tmp_path):
    scene = bpy_mock.Scene()
    scene.render.filepath = str(tmp_path / "missing.png")
    assert _capture.capture_render(scene) is None


def test_capture_render_hashes_and_carries_workflow(tmp_path):
    scene = bpy_mock.Scene()
    scene.render.filepath = str(tmp_path / "img.png")
    scene.render.resolution_x = 800
    scene.render.resolution_y = 600
    scene.render.engine = "CYCLES"
    _write_bytes(tmp_path, "img.png", b"pixels")
    payload = _capture.capture_render(scene, frame=1)
    assert payload is not None
    assert payload["sha256"] == hashlib.sha256(b"pixels").hexdigest()
    assert payload["kind"] == "render"
    assert payload["machine_manifest"]["host"] == "blender"
    assert payload["workflow"]["engine"] == "CYCLES"
    assert payload["workflow"]["resolution"] == [800, 600]


def test_capture_save(tmp_path):
    blend = _write_bytes(tmp_path, "scene.blend", b"BLENDER-fake")
    scene = bpy_mock.Scene()
    scene.objects = bpy_mock.SceneObjectCollection(_items=[
        bpy_mock.SceneObjectRef("Cube"),
        bpy_mock.SceneObjectRef("Camera"),
    ])
    payload = _capture.capture_save(blend, scene)
    assert payload is not None
    assert payload["kind"] == "save"
    assert payload["sha256"] == hashlib.sha256(b"BLENDER-fake").hexdigest()
    assert payload["workflow"]["object_count"] == 2


def test_capture_export(tmp_path):
    p = _write_bytes(tmp_path, "out.glb", b"GLTF-bytes")
    scene = bpy_mock.Scene()
    payload = _capture.capture_export(p, scene, format="glTF", exporter_options={"embed_textures": True})
    assert payload is not None
    assert payload["format"] == "glTF"
    assert payload["workflow"]["format"] == "gltf"
    assert payload["workflow"]["options"]["embed_textures"] is True


def test_capture_render_over_inline_limit_returns_none(tmp_path, monkeypatch):
    p = _write_bytes(tmp_path, "big.png", b"x" * 100)
    scene = bpy_mock.Scene()
    scene.render.filepath = p
    monkeypatch.setattr(_capture, "INLINE_PAYLOAD_LIMIT_BYTES", 10)
    payload = _capture.capture_render(scene, frame=1)
    assert payload is None
