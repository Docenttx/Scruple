"""Capture, split the way gap.json says it splits.

The old lib/capture.py did two jobs. The hashing/base64/size-limit half
is now `scruple_api.capture` (via `scruple_host_sdk.capture`); the
bpy-reading half -- path resolution, frame substitution, render
settings, scene inventory -- is `adapter/scene.py`. Both halves are
tested here, in that order, so the seam is visible.

The behaviour that is NEW rather than moved is MIME. The old capture
declared none, so every leaf went up as application/octet-stream. These
tests assert a PNG render is declared image/png and that an unmapped
format is REFUSED rather than defaulted.
"""

from __future__ import annotations

import base64
import hashlib

import pytest

from adapter import scene as _scene
from scruple_host_sdk import capture as _capture
from scruple_api.errors import MimeRequiredError
from tests.mocks import bpy_mock


def _write_bytes(tmp_path, name, contents: bytes):
    p = tmp_path / name
    p.write_bytes(contents)
    return str(p)


# ---- the SDK half -------------------------------------------------------

def test_sha256_file_matches_stdlib(tmp_path):
    p = _write_bytes(tmp_path, "x.bin", b"hello")
    assert _capture.sha256_file(p) == hashlib.sha256(b"hello").hexdigest()


def test_sha256_streams_over_multiple_chunks(tmp_path):
    payload = b"a" * (_capture.CHUNK_SIZE * 2 + 100)
    p = _write_bytes(tmp_path, "big.bin", payload)
    assert _capture.sha256_file(p, chunk=1024) == hashlib.sha256(payload).hexdigest()


def test_inline_base64_round_trips(tmp_path):
    p = _write_bytes(tmp_path, "x.bin", b"\x00\x01\x02")
    assert base64.b64decode(_capture.inline_base64(p)) == b"\x00\x01\x02"


def test_capture_requires_a_declared_mime(tmp_path):
    """Property 1. The old addon's default is now a refusal."""
    p = _write_bytes(tmp_path, "img.png", b"pixels")
    with pytest.raises(MimeRequiredError):
        _capture.capture(p, mime="", kind="render")


def test_capture_payload_shape(tmp_path):
    p = _write_bytes(tmp_path, "img.png", b"pixels")
    payload = _capture.capture(p, mime="image/png", kind="render", workflow={"engine": "CYCLES"})
    assert payload["content_hash"] == hashlib.sha256(b"pixels").hexdigest()
    assert payload["mime"] == "image/png"
    assert payload["kind"] == "render"
    assert payload["workflow"] == {"engine": "CYCLES"}


def test_capture_refuses_over_the_inline_limit(tmp_path, monkeypatch):
    """Over the limit is a raise, not a None. The old capture_render
    returned None and logged a warning, which the caller could not tell
    from "no file on disk"."""
    import sys
    p = _write_bytes(tmp_path, "big.png", b"x" * 100)
    # capture() reads the constant off its own defining module, and
    # `scruple_api.capture` the attribute is the function, not the
    # submodule -- so reach the module through sys.modules.
    monkeypatch.setattr(sys.modules["scruple_api.capture"], "INLINE_PAYLOAD_LIMIT_BYTES", 10)
    with pytest.raises(ValueError):
        _capture.capture(p, mime="image/png", kind="render")


# ---- the adapter half ---------------------------------------------------

def test_frame_substitution_pads_with_zeros():
    assert _scene._substitute_frame_hashes("/tmp/render####.png", 3) == "/tmp/render0003.png"


def test_frame_substitution_noop_without_hashes():
    assert _scene._substitute_frame_hashes("/tmp/render.png", 3) == "/tmp/render.png"


def test_resolved_render_output_none_without_filepath():
    s = bpy_mock.Scene()
    s.render.filepath = ""
    assert _scene.resolved_render_output(s) is None
    assert _scene.candidate_render_outputs(s) == []


# The path rules below are transcribed from what Blender 3.0.1 was
# OBSERVED to do headless, not from what the old code assumed. The
# inherited resolution substituted #### and returned that without an
# extension, so against real Blender it found nothing and every render
# went unwitnessed. tools/../b2 probe output is quoted in
# adapter/scene.py's header.

def test_still_render_gets_the_extension_appended(tmp_path):
    """filepath="/x/still" + PNG -> /x/still.png. The bug that made the
    old resolution find nothing."""
    s = bpy_mock.Scene()
    s.render.filepath = str(tmp_path / "still")
    (tmp_path / "still.png").write_bytes(b"x")
    assert _scene.resolved_render_output(s).endswith("still.png")


def test_an_extension_already_present_is_not_doubled(tmp_path):
    s = bpy_mock.Scene()
    s.render.filepath = str(tmp_path / "w.png")
    (tmp_path / "w.png").write_bytes(b"x")
    assert _scene.resolved_render_output(s).endswith("w.png")
    assert not _scene.resolved_render_output(s).endswith("w.png.png")


def test_a_still_render_keeps_literal_hashes(tmp_path):
    """Blender does NOT substitute #### for a write_still render -- it
    writes the hashes literally. The old code substituted always."""
    s = bpy_mock.Scene()
    s.render.filepath = str(tmp_path / "h####")
    s.frame_current = 3
    (tmp_path / "h####.png").write_bytes(b"x")
    assert _scene.resolved_render_output(s).endswith("h####.png")


def test_an_animation_frame_substitutes_the_hashes(tmp_path):
    s = bpy_mock.Scene()
    s.render.filepath = str(tmp_path / "a####")
    s.frame_current = 5
    (tmp_path / "a0005.png").write_bytes(b"x")
    assert _scene.resolved_render_output(s).endswith("a0005.png")


def test_hash_width_is_respected(tmp_path):
    s = bpy_mock.Scene()
    s.render.filepath = str(tmp_path / "a_##")
    s.frame_current = 12
    (tmp_path / "a_12.png").write_bytes(b"x")
    assert _scene.resolved_render_output(s).endswith("a_12.png")


def test_an_animation_without_tokens_gets_the_frame_appended(tmp_path):
    s = bpy_mock.Scene()
    s.render.filepath = str(tmp_path / "anim")
    s.frame_current = 3
    (tmp_path / "anim0003.png").write_bytes(b"x")
    assert _scene.resolved_render_output(s).endswith("anim0003.png")


def test_use_file_extension_off_means_no_extension(tmp_path):
    s = bpy_mock.Scene()
    s.render.use_file_extension = False
    s.render.filepath = str(tmp_path / "noext")
    (tmp_path / "noext").write_bytes(b"x")
    assert _scene.resolved_render_output(s).endswith("noext")


def test_blenders_own_extension_wins_over_the_table(tmp_path):
    """JPEG is ".jpg" in Blender, not ".jpeg". A hand-written table gets
    that wrong, so `render.file_extension` is asked first."""
    s = bpy_mock.Scene()
    s.render.image_settings.file_format = "JPEG"
    s.render.file_extension = ".jpg"
    assert _scene.render_file_extension(s) == ".jpg"


def test_resolution_falls_back_to_the_still_form_when_nothing_is_on_disk(tmp_path):
    """The caller logs "no file at X"; X must be the path that was
    actually looked for."""
    s = bpy_mock.Scene()
    s.render.filepath = str(tmp_path / "gone")
    assert _scene.resolved_render_output(s).endswith("gone.png")
    # Two distinct candidates without tokens (the substitution is a
    # no-op there), three with them.
    assert len(_scene.candidate_render_outputs(s)) == 2
    s.render.filepath = str(tmp_path / "gone####")
    assert len(_scene.candidate_render_outputs(s)) == 3


def test_read_render_settings_reads_engine_resolution_samples():
    s = bpy_mock.Scene()
    s.render.engine = "CYCLES"
    s.render.resolution_x, s.render.resolution_y = 800, 600
    s.cycles.samples = 64
    got = _scene.read_render_settings(s)
    assert got["engine"] == "CYCLES"
    assert got["resolution"] == (800, 600)
    assert got["samples"] == 64
    assert got["camera"] == "Camera"


def test_scene_inventory_counts_objects():
    s = bpy_mock.Scene()
    s.objects = bpy_mock.SceneObjectCollection(_items=[
        bpy_mock.SceneObjectRef("Cube"), bpy_mock.SceneObjectRef("Camera"),
    ])
    assert _scene.scene_inventory(s)["object_count"] == 2


# ---- MIME, declared and refused ----------------------------------------

def test_mime_for_render_reads_blenders_own_format_enum():
    s = bpy_mock.Scene()
    s.render.image_settings.file_format = "PNG"
    assert _scene.mime_for_render(s) == "image/png"
    s.render.image_settings.file_format = "OPEN_EXR"
    assert _scene.mime_for_render(s) == "image/x-exr"


def test_mime_for_render_resolves_ffmpeg_container():
    s = bpy_mock.Scene()
    s.render.image_settings.file_format = "FFMPEG"
    s.render.ffmpeg.format = "MATROSKA"
    assert _scene.mime_for_render(s) == "video/x-matroska"


def test_mime_for_render_refuses_an_unmapped_format():
    """The control for the whole MIME story: an unknown format must be a
    refusal, never application/octet-stream."""
    s = bpy_mock.Scene()
    s.render.image_settings.file_format = "SOME_FUTURE_FORMAT"
    with pytest.raises(MimeRequiredError):
        _scene.mime_for_render(s)


def test_mime_for_render_refuses_an_empty_format():
    s = bpy_mock.Scene()
    s.render.image_settings.file_format = ""
    with pytest.raises(MimeRequiredError):
        _scene.mime_for_render(s)


def test_mime_for_export_distinguishes_glb_from_gltf():
    assert _scene.mime_for_export("gltf", "/x/out.glb") == "model/gltf-binary"
    assert _scene.mime_for_export("gltf", "/x/out.gltf") == "model/gltf+json"


def test_mime_for_export_refuses_other_without_a_declaration():
    with pytest.raises(MimeRequiredError):
        _scene.mime_for_export("other", "/x/thing.xyz")


def test_mime_for_export_accepts_an_explicit_declaration():
    assert _scene.mime_for_export("other", "/x/thing.xyz", declared="model/x-thing") == "model/x-thing"


def test_blend_mime_is_declared():
    assert _scene.BLEND_MIME == "application/x-blender"


# ---- the workflow snapshot ---------------------------------------------

def test_render_workflow_fields():
    w = _scene.build_render_workflow(
        filename="scene.0001.png", scene_name="Scene", render_engine="CYCLES",
        resolution=(1920, 1080), samples=128, camera="Camera", frame=1,
        trigger="render_complete",
    )
    assert w["kind"] == "blender_render"
    assert w["resolution"] == [1920, 1080]
    assert w["samples"] == 128
    assert w["camera"] == "Camera"
    assert w["trigger"] == "render_complete"


def test_save_workflow_fields():
    w = _scene.build_save_workflow(
        filepath="/tmp/x.blend", scene_name="Scene", object_count=3, material_count=1,
    )
    assert w["kind"] == "blender_save"
    assert w["object_count"] == 3


def test_export_workflow_fields():
    w = _scene.build_export_workflow(
        filepath="/tmp/x.glb", format="glTF", scene_name="Scene",
        exporter_options={"embed_textures": True},
    )
    assert w["format"] == "gltf"
    assert w["options"] == {"embed_textures": True}


def test_host_environment_carries_blenders_own_fields():
    """lib/manifest.py hardcoded these into the machine manifest; the
    SDK's is host-agnostic, so they ride in `extra` instead."""
    env = _scene.host_environment()
    assert env["addon"] == "scruple-blender"
    assert "blender_version" in env


# ---- WO-E4: the sample count belongs to the engine that is set -----------

def test_samples_come_from_the_engine_that_is_actually_set():
    """⚑ Finding E4-4, pinned. `scene.cycles` exists even when the engine is
    EEVEE — the Cycles addon registers its property group on every scene —
    so "take the first group with a .samples" reported Cycles' 4096 for a
    4.2 EEVEE render. Measured on Blender 4.2.23."""
    s = bpy_mock.Scene()
    s.render.engine = "BLENDER_EEVEE_NEXT"
    s.cycles.samples = 4096
    s.eevee.taa_render_samples = 64
    assert _scene.render_samples(s) == 64
    assert _scene.read_render_settings(s)["samples"] == 64


def test_cycles_still_reports_its_own_samples():
    s = bpy_mock.Scene()
    s.render.engine = "CYCLES"
    s.cycles.samples = 4096
    s.eevee.taa_render_samples = 64
    assert _scene.render_samples(s) == 4096


def test_an_engine_with_no_sample_count_reports_none_not_another_engines():
    """Workbench has no sample count. A missing row is a missing row."""
    s = bpy_mock.Scene()
    s.render.engine = "BLENDER_WORKBENCH"
    s.cycles.samples = 4096
    assert _scene.render_samples(s) is None
    assert _scene.read_render_settings(s)["samples"] is None
