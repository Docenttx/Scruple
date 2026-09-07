"""Handler wiring -- install/uninstall + dispatch to the worker.

gap.json, modules row 11: this module KEEPS, because bpy.app.handlers
registration is genuinely Blender's. So most of these tests are
unchanged. The two that are new cover what changed inside `_dispatch`'s
`except`: it used to be the entire failure path, and a capture that
could not be delivered died there. It is now a backstop, and the test
that proves it is `test_a_dispatch_that_cannot_reach_the_server_leaves_the_capture_on_disk`.
"""

from __future__ import annotations

import time

from adapter import handlers as _handlers
from adapter import sdk as _sdk
from adapter import state as _state
from tests.mocks import bpy_mock, v2


def _wait_for(predicate, tries=40, delay=0.05):
    for _ in range(tries):
        if predicate():
            return True
        time.sleep(delay)
    return predicate()


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
        _wait_for(lambda: hits)
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
        _wait_for(lambda: hits)
    finally:
        worker.stop()
    assert hits == ["second"]


def test_dispatch_noop_when_not_signed_in(monkeypatch, fresh_state):
    monkeypatch.setattr(_sdk, "get_client", lambda: None)
    called = []
    _handlers._dispatch(lambda c: called.append(c), label="test")
    assert called == []


def test_render_complete_dispatches_witness(attached_client, http_opener, tmp_path):
    _handlers.WORKER.start()
    try:
        scene = bpy_mock.Scene()
        scene.render.filepath = str(tmp_path / "img.png")
        (tmp_path / "img.png").write_bytes(b"pixels")
        _handlers._on_render_complete(scene)
        _wait_for(lambda: attached_client.state.recent_receipts)
    finally:
        _handlers.WORKER.stop()

    [receipt] = list(attached_client.state.recent_receipts)
    assert receipt["filename"] == "img.png"
    assert receipt["witnessed"] is True


def test_a_dispatch_that_cannot_reach_the_server_leaves_the_capture_on_disk(
    attached_client, http_opener, tmp_path,
):
    """The old failure path logged a warning and dropped the capture.
    The observable now is a row in the on-disk queue."""
    http_opener.register("POST", "/api/v2/witness", {"error": "down"}, status=503)
    _handlers.WORKER.start()
    try:
        scene = bpy_mock.Scene()
        scene.render.filepath = str(tmp_path / "img.png")
        (tmp_path / "img.png").write_bytes(b"pixels")
        _handlers._on_render_complete(scene)
        _wait_for(lambda: attached_client.queue_depth == 1)
    finally:
        _handlers.WORKER.stop()

    assert attached_client.queue_depth == 1
    [entry] = attached_client.queue.load_all()
    assert entry["path"] == "/api/v2/witness"


def test_drain_queue_replays_what_the_outage_spooled(attached_client, http_opener, tmp_path):
    http_opener.register("POST", "/api/v2/witness", {"error": "down"}, status=503)
    attached_client.witness(kind="artifact", content_hash="a" * 64, mime="image/png")
    assert attached_client.queue_depth == 1

    v2.register_v2(http_opener)
    result = _handlers.drain_queue()
    assert result["succeeded"] == 1
    assert attached_client.queue_depth == 0


def test_drain_queue_is_safe_with_no_session(fresh_state):
    assert _handlers.drain_queue() == {"succeeded": 0, "failed": 0, "remaining": 0}
