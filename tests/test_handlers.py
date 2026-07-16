"""Handler wiring tests — install/uninstall + dispatch to worker."""

from __future__ import annotations

import time

import pytest

from lib import handlers as _handlers
from lib import scruple_client as _client_mod
from lib import state as _state
from tests.mocks import bpy_mock, http_mock


def _register_witness(opener):
    opener.register("POST", "/api/projects", {"ok": True, "id": 42, "name": "X", "status": "unlocked"})
    opener.register("POST", "/api/witness/cad", lambda body: {
        "ok": True,
        "iteration": {"id": 1, "project_id": body["projectId"]},
        "leafHash": "leaf-h",
        "runSequence": 1,
        "machineManifestHash": "d" * 64,
    })


def test_install_appends_tagged_handlers():
    mock_handlers = bpy_mock.AppHandlers()
    _handlers.install_for_test(mock_handlers)
    assert len(mock_handlers.render_complete) == 1
    assert len(mock_handlers.render_write) == 1
    assert len(mock_handlers.save_post) == 1
    for hook_list in (mock_handlers.render_complete, mock_handlers.render_write, mock_handlers.save_post):
        assert getattr(hook_list[0], _handlers.HANDLER_TAG, False)


def test_install_idempotent():
    mock_handlers = bpy_mock.AppHandlers()
    _handlers.install_for_test(mock_handlers)
    _handlers.install_for_test(mock_handlers)
    assert len(mock_handlers.render_complete) == 1
    assert len(mock_handlers.save_post) == 1


def test_install_preserves_other_owners_handlers():
    mock_handlers = bpy_mock.AppHandlers()
    def _third_party(_scene):
        pass
    mock_handlers.render_complete.append(_third_party)
    _handlers.install_for_test(mock_handlers)
    assert _third_party in mock_handlers.render_complete
    assert len(mock_handlers.render_complete) == 2


def test_uninstall_only_removes_owned_handlers():
    mock_handlers = bpy_mock.AppHandlers()
    def _third_party(_scene):
        pass
    mock_handlers.render_complete.append(_third_party)
    _handlers.install_for_test(mock_handlers)
    _handlers.uninstall_for_test(mock_handlers)
    assert mock_handlers.render_complete == [_third_party]


def test_worker_runs_submitted_jobs():
    worker = _handlers.WitnessWorker()
    worker.start()
    hits = []
    try:
        worker.submit(lambda: hits.append(1))
        for _ in range(20):
            if hits:
                break
            time.sleep(0.05)
    finally:
        worker.stop()
    assert hits == [1]


def test_worker_swallows_exceptions():
    worker = _handlers.WitnessWorker()
    worker.start()
    hits = []
    try:
        worker.submit(lambda: (_ for _ in ()).throw(RuntimeError("boom")))
        worker.submit(lambda: hits.append("second"))
        for _ in range(20):
            if hits:
                break
            time.sleep(0.05)
    finally:
        worker.stop()
    assert hits == ["second"]


def test_dispatch_noop_when_not_signed_in(monkeypatch, fresh_state):
    monkeypatch.setattr(_client_mod, "from_preferences", lambda: None)
    called = []
    _handlers._dispatch(lambda c: called.append(c), label="test")
    assert called == []


def test_render_complete_dispatches_witness(monkeypatch, tmp_path, fresh_state):
    opener = http_mock.new()
    _register_witness(opener)
    client = _client_mod.ScrupleClient(base_url="https://scruple.test", api_key="sk_t", opener=opener)
    monkeypatch.setattr(_client_mod, "from_preferences", lambda: client)

    _handlers.WORKER.start()
    try:
        scene = bpy_mock.Scene()
        scene.render.filepath = str(tmp_path / "img.png")
        (tmp_path / "img.png").write_bytes(b"pixels")
        _handlers._on_render_complete(scene)
        for _ in range(20):
            if _state.get().recent_receipts:
                break
            time.sleep(0.05)
    finally:
        _handlers.WORKER.stop()

    st = _state.get()
    assert len(st.recent_receipts) == 1
    assert st.recent_receipts[0]["kind"] == "render"
