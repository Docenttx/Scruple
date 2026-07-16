"""Witness flow tests — capture -> POST -> record receipt."""

from __future__ import annotations

import hashlib

from lib import scruple_client as _client_mod
from lib import state as _state
from lib import witness_flow as _wf
from tests.mocks import bpy_mock, http_mock


def _client(opener):
    return _client_mod.ScrupleClient(base_url="https://scruple.test", api_key="sk_t", opener=opener)


def _register_project_and_witness(opener):
    opener.register("POST", "/api/projects", {"ok": True, "id": 1000, "name": "X", "status": "unlocked"})
    opener.register("POST", "/api/witness/cad", lambda body: {
        "ok": True,
        "iteration": {"id": 1, "project_id": body["projectId"]},
        "leafHash": "leaf-" + body["filename"],
        "runSequence": 1,
        "machineManifestHash": "deadbeef" * 8,
    })


def test_ensure_project_creates_once(tmp_path, fresh_state):
    opener = http_mock.new()
    _register_project_and_witness(opener)
    client = _client(opener)
    scene = bpy_mock.Scene(name="Untitled")
    pid = _wf.ensure_project(client, scene)
    assert pid == 1000
    pid2 = _wf.ensure_project(client, scene)
    assert pid2 == 1000
    project_calls = [r for r in opener.recorded if r.path == "/api/projects"]
    assert len(project_calls) == 1


def test_witness_render_records_receipt(tmp_path, fresh_state):
    opener = http_mock.new()
    _register_project_and_witness(opener)
    client = _client(opener)
    scene = bpy_mock.Scene()
    scene.render.filepath = str(tmp_path / "img.png")
    (tmp_path / "img.png").write_bytes(b"pixels")

    resp = _wf.witness_render(client, scene, trigger="render_complete")
    assert resp["ok"] is True
    assert resp["leafHash"].startswith("leaf-")
    st = _state.get()
    assert len(st.recent_receipts) == 1
    assert st.recent_receipts[0]["kind"] == "render"


def test_witness_save_records_receipt(tmp_path, fresh_state):
    opener = http_mock.new()
    _register_project_and_witness(opener)
    client = _client(opener)
    scene = bpy_mock.Scene()
    p = tmp_path / "scene.blend"
    p.write_bytes(b"BLENDER-fake")
    resp = _wf.witness_save(client, scene, str(p), trigger="save_post")
    assert resp is not None
    st = _state.get()
    assert st.recent_receipts[0]["kind"] == "save"


def test_witness_export_records_receipt(tmp_path, fresh_state):
    opener = http_mock.new()
    _register_project_and_witness(opener)
    client = _client(opener)
    scene = bpy_mock.Scene()
    p = tmp_path / "out.glb"
    p.write_bytes(b"GLTF")
    resp = _wf.witness_export(client, scene, str(p), format="glTF", trigger="export_post")
    assert resp is not None
    st = _state.get()
    assert st.recent_receipts[0]["kind"] == "export"


def test_missing_output_returns_none_no_receipt(tmp_path, fresh_state):
    opener = http_mock.new()
    _register_project_and_witness(opener)
    client = _client(opener)
    scene = bpy_mock.Scene()
    scene.render.filepath = str(tmp_path / "does-not-exist.png")
    resp = _wf.witness_render(client, scene)
    assert resp is None
    st = _state.get()
    assert len(st.recent_receipts) == 0
