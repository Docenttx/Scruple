"""adapter/flow.py -- Blender's vocabulary onto the SDK's calls.

This replaces the tests for lib/witness_flow.py. Three of the old tests
have no subject any more:

  * `test_ensure_project_creates_once` -- there is no /api/v2/projects,
    so the addon no longer mints a project per .blend. Replaced by
    test_no_project_is_created_under_v2, which asserts the absence.
  * the two that read `resp["leafHash"]` -- the response is a
    WitnessOutcome now, and `witnessed` is a field on it rather than
    something inferred from the call not raising.

What is asserted instead is the three states WO-B3 is about, one test
each, plus the MIME that used to be missing entirely.
"""

from __future__ import annotations

import hashlib

import pytest

from adapter import flow as _wf
from adapter import state as _state
from tests.mocks import bpy_mock, v2


def _render_scene(tmp_path, name="img.png", data=b"pixels"):
    scene = bpy_mock.Scene()
    scene.render.filepath = str(tmp_path / name)
    (tmp_path / name).write_bytes(data)
    return scene


# ---- the happy path -----------------------------------------------------

def test_witness_render_witnesses_and_records_a_receipt(attached_client, http_opener, tmp_path):
    scene = _render_scene(tmp_path)
    outcome = _wf.witness_render(attached_client, scene, trigger="render_complete")
    assert outcome.witnessed is True
    assert outcome.leaf_id

    [receipt] = list(attached_client.state.recent_receipts)
    assert receipt["filename"] == "img.png"
    assert receipt["content_hash"] == hashlib.sha256(b"pixels").hexdigest()
    assert receipt["witnessed"] is True


def test_the_witnessed_content_hash_is_the_hash_of_the_bytes_on_disk(attached_client, http_opener, tmp_path):
    """The one property everything else rests on: what was posted is the
    sha256 of the file, recomputable from disk by anyone."""
    scene = _render_scene(tmp_path, data=b"a real render would go here")
    _wf.witness_render(attached_client, scene)
    posted = [r for r in http_opener.recorded if r.path == "/api/v2/witness"][0].body
    on_disk = hashlib.sha256((tmp_path / "img.png").read_bytes()).hexdigest()
    assert posted["content_hash"] == on_disk


def test_render_declares_image_png_not_octet_stream(attached_client, http_opener, tmp_path):
    """The defect gap.json names: every Blender artifact used to go up as
    application/octet-stream."""
    scene = _render_scene(tmp_path)
    scene.render.image_settings.file_format = "PNG"
    _wf.witness_render(attached_client, scene)
    posted = [r for r in http_opener.recorded if r.path == "/api/v2/witness"][0].body
    assert posted["mime"] == "image/png"


def test_save_declares_the_blend_type(attached_client, http_opener, tmp_path):
    p = tmp_path / "scene.blend"
    p.write_bytes(b"BLENDER-fake")
    outcome = _wf.witness_save(attached_client, bpy_mock.Scene(), str(p))
    assert outcome.witnessed
    posted = [r for r in http_opener.recorded if r.path == "/api/v2/witness"][0].body
    assert posted["mime"] == "application/x-blender"
    assert posted["kind"] == "save"


def test_export_declares_the_gltf_variant(attached_client, http_opener, tmp_path):
    p = tmp_path / "out.glb"
    p.write_bytes(b"GLTF")
    outcome = _wf.witness_export(attached_client, bpy_mock.Scene(), str(p), format="gltf")
    assert outcome.witnessed
    posted = [r for r in http_opener.recorded if r.path == "/api/v2/witness"][0].body
    assert posted["mime"] == "model/gltf-binary"


def test_the_workflow_snapshot_rides_along(attached_client, http_opener, tmp_path):
    scene = _render_scene(tmp_path)
    scene.render.engine = "CYCLES"
    _wf.witness_render(attached_client, scene, trigger="render_write", frame=7)
    posted = [r for r in http_opener.recorded if r.path == "/api/v2/witness"][0].body
    assert posted["machine_manifest_hash"]
    assert len(posted["machine_manifest_hash"]) == 64


# ---- what does NOT happen ----------------------------------------------

def test_no_project_is_created_under_v2(attached_client, http_opener, tmp_path):
    """v1 POSTed /api/projects on the first capture of every .blend.
    There is no v2 equivalent, so nothing should touch that route."""
    _wf.witness_render(attached_client, _render_scene(tmp_path))
    assert [r for r in http_opener.recorded if "/projects" in r.path] == []


def test_missing_output_returns_none_and_witnesses_nothing(attached_client, http_opener, tmp_path):
    scene = bpy_mock.Scene()
    scene.render.filepath = str(tmp_path / "does-not-exist.png")
    assert _wf.witness_render(attached_client, scene) is None
    assert list(attached_client.state.recent_receipts) == []
    assert [r for r in http_opener.recorded if r.path == "/api/v2/witness"] == []


def test_an_unmappable_mime_refuses_instead_of_defaulting(attached_client, http_opener, tmp_path):
    scene = _render_scene(tmp_path)
    scene.render.image_settings.file_format = "SOME_FUTURE_FORMAT"
    outcome = _wf.witness_render(attached_client, scene)
    assert outcome is not None
    assert outcome.witnessed is False
    assert "SOME_FUTURE_FORMAT" in (outcome.error or "")
    assert [r for r in http_opener.recorded if r.path == "/api/v2/witness"] == []


def test_over_the_inline_limit_is_refused_as_an_outcome_not_a_none(attached_client, http_opener, tmp_path, monkeypatch):
    """A silent None is how a capture disappears. An oversize file gets a
    witnessed=False outcome with a reason, and the panel's error surface
    shows it."""
    import sys
    monkeypatch.setattr(sys.modules["scruple_api.capture"], "INLINE_PAYLOAD_LIMIT_BYTES", 3)
    monkeypatch.setattr("scruple_host_sdk.capture.INLINE_PAYLOAD_LIMIT_BYTES", 3)
    outcome = _wf.witness_render(attached_client, _render_scene(tmp_path, data=b"much too large"))
    assert outcome.witnessed is False
    assert "inline limit" in (outcome.error or "")
    assert _state.get().last_error


# ---- the three states ---------------------------------------------------

def test_offline_capture_is_queued_not_lost(sdk_client, http_opener, tmp_path):
    v2.register_v2(http_opener)
    sdk_client.attach(code_paths=[])
    http_opener.register("POST", "/api/v2/witness", {"error": "down"}, status=503)

    outcome = _wf.witness_render(sdk_client, _render_scene(tmp_path))
    assert outcome.queued is True
    assert outcome.witnessed is False
    assert sdk_client.queue_depth == 1


def test_delivered_but_unwitnessed_is_reported_as_such(sdk_client, http_opener, tmp_path):
    v2.register_v2(http_opener, witnessed=False)
    sdk_client.attach(code_paths=[])
    outcome = _wf.witness_render(sdk_client, _render_scene(tmp_path))
    assert outcome.witnessed is False
    assert outcome.queued is False
    assert sdk_client.queue_depth == 0, "a delivered request must not be queued"


def test_witness_without_attach_does_not_reach_the_network(sdk_client, http_opener, tmp_path):
    """ensure_attached() is what makes the SDK's D-3 refusal a message
    rather than a traceback during a render. The baseline route is not
    registered here, so attach fails and nothing is witnessed."""
    http_opener.register("POST", "/api/v2/witness", {"leaf_id": "x", "witnessed": True})
    outcome = _wf.witness_render(sdk_client, _render_scene(tmp_path))
    assert outcome.witnessed is False
    assert [r for r in http_opener.recorded if r.path == "/api/v2/witness"] == []
    assert "baseline" in (_state.get().last_error or "").lower()


def test_attach_happens_once_per_session(attached_client, http_opener, tmp_path):
    before = len([r for r in http_opener.recorded if "/baseline" in r.path])
    _wf.witness_render(attached_client, _render_scene(tmp_path, "a.png"))
    _wf.witness_render(attached_client, _render_scene(tmp_path, "b.png"))
    after = len([r for r in http_opener.recorded if "/baseline" in r.path])
    assert after == before


# ---- marks --------------------------------------------------------------

def test_local_lock_sends_an_empty_modality_list(attached_client, http_opener):
    outcome = _wf.mark_local(attached_client, leaf_id="leaf_1", mime="image/png")
    assert outcome.leaf_id == "leaf_1"
    body = [r for r in http_opener.recorded if r.path == "/api/v2/mark"][0].body
    assert body["modalities"] == []
    assert body["host"] == "blender"


def test_chain_lock_sends_the_chain_modality_and_tier(attached_client, http_opener):
    _wf.mark_chain(attached_client, leaf_id="leaf_1", mime="image/png", tier="pinned")
    body = [r for r in http_opener.recorded if r.path == "/api/v2/mark"][0].body
    assert body["modalities"] == ["chain"]
    assert body["chain_tier"] == "pinned"


def test_an_unavailable_modality_is_refused_before_the_mark_is_sent(sdk_client, http_opener):
    """Fail closed, never downgrade. The control is that /api/v2/mark was
    never called."""
    from scruple_host_sdk.errors import ModalityUnavailableError
    v2.register_v2(http_opener, modalities_available=["local"])
    sdk_client.attach(code_paths=[])
    with pytest.raises(ModalityUnavailableError):
        _wf.mark_chain(sdk_client, leaf_id="leaf_1", mime="image/png")
    assert [r for r in http_opener.recorded if r.path == "/api/v2/mark"] == []


def test_outstanding_is_reported_not_swallowed(sdk_client, http_opener):
    v2.register_v2(http_opener, modalities_applied=[])
    sdk_client.attach(code_paths=[])
    outcome = _wf.mark_chain(sdk_client, leaf_id="leaf_1", mime="image/png")
    assert outcome.modalities_applied == []
    assert [o.modality for o in outcome.outstanding] == ["chain"]
    assert "chain" in _wf.outstanding_summary(outcome)
