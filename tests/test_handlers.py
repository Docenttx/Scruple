"""Handler wiring -- install/uninstall + dispatch to the worker.

gap.json, modules row 11: this module KEEPS, because bpy.app.handlers
registration is genuinely Blender's. So most of these tests are
unchanged. The two that are new cover what changed inside `_dispatch`'s
`except`: it used to be the entire failure path, and a capture that
could not be delivered died there. It is now a backstop, and the test
that proves it is `test_a_dispatch_that_cannot_reach_the_server_leaves_the_capture_on_disk`.
"""

from __future__ import annotations

import threading
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
    assert _handlers.drain_queue() == {"attempted": 0, "succeeded": 0, "failed": 0, "remaining": 0}


# ── WO-F2 / finding E7-3 — stop() must not drop queued captures ────────────
#
# The class-level half of the gate. The gate itself (desktop repo,
# scripts/f2-gate.sh) counts captures from DISK against a real server; these
# pin the behaviour that makes that possible, in the suite that runs on every
# change.


def test_stop_drains_what_is_still_queued():
    """⚑ E7-3, inverted. The old `_run()` re-checked the stop flag after
    pulling a job, so `second` was pulled and discarded."""
    worker = _handlers.WitnessWorker()
    worker.start()
    ran = []
    started = threading.Event()

    def slow():
        started.set()
        time.sleep(0.4)
        ran.append("first")

    worker.submit(slow, label="first")
    worker.submit(lambda: ran.append("second"), label="second")
    assert started.wait(5)          # the first is in flight...
    report = worker.stop(timeout=10)  # ...and the second is still queued

    assert ran == ["first", "second"]
    assert report["abandoned"] == []
    assert report["queued_at_stop"] == 2
    assert report["ran"] == 2


def test_stop_drains_in_order():
    worker = _handlers.WitnessWorker()
    worker.start()
    ran = []
    gate = threading.Event()
    worker.submit(lambda: gate.wait(5), label="gate")
    for i in range(8):
        worker.submit(lambda i=i: ran.append(i), label=f"job-{i}")
    gate.set()
    worker.stop(timeout=10)
    assert ran == list(range(8))


def test_stop_with_nothing_queued_reports_nothing():
    """Control (b) at the unit level: an empty queue must not manufacture
    work, or a report of work."""
    worker = _handlers.WitnessWorker()
    worker.start()
    report = worker.stop(timeout=5)
    assert report == {
        "queued_at_stop": 0, "ran": 0, "hurried": False,
        "abandoned": [], "seconds": report["seconds"],
    }


def test_a_job_that_outlasts_both_budgets_is_named_not_dropped_silently():
    """The bound is real, and so is the report. A job that will not finish
    inside either budget leaves `abandoned` non-empty -- which is what
    `unregister()` puts on the error surface."""
    worker = _handlers.WitnessWorker()
    worker.start()
    release = threading.Event()
    worker.submit(lambda: release.wait(30), label="wedged")
    worker.submit(lambda: None, label="behind-the-wedge")
    time.sleep(0.2)
    report = worker.stop(timeout=0.2, hurry_timeout=0.2)
    release.set()

    assert report["hurried"] is True
    assert "behind-the-wedge" in report["abandoned"]
    assert report["queued_at_stop"] == 2


def test_stop_cuts_the_network_budget_rather_than_the_queue(sdk_client):
    """Cutting the budget is what makes a short bound safe: the remaining
    captures still RUN, they just stop waiting on a server that is not
    answering, and the SDK spools them from its own failure path.

    ⚑ The cut happens when the drain STARTS. It has to: `http.submit()` hands
    `session.timeout` to `urlopen`, so a request already blocked in read()
    keeps whatever budget it was given, and a cut applied afterwards arrives
    too late to help the one request that is costing the most."""
    worker = _handlers.WitnessWorker(set_network_budget=_handlers._set_session_network_budget)
    normal = sdk_client.timeout
    worker.start()
    seen = []
    release = threading.Event()
    worker.submit(lambda: (seen.append(sdk_client.timeout), release.wait(30)), label="wedged")
    time.sleep(0.2)
    assert seen == [normal]              # ...not yet, this one is not a shutdown

    worker.stop(timeout=0.2, hurry_timeout=0.2)
    release.set()
    assert sdk_client.timeout == _handlers.HURRY_TIMEOUT_SECONDS

    worker.start()                       # start() puts it back
    try:
        assert sdk_client.timeout == normal
    finally:
        worker.stop(timeout=2)
        _handlers._set_session_network_budget(None)


def test_the_shutdown_budget_is_in_front_of_the_first_shutdown_request(sdk_client):
    """The budget a capture drained at shutdown actually runs under."""
    worker = _handlers.WitnessWorker(set_network_budget=_handlers._set_session_network_budget)
    normal = sdk_client.timeout
    worker.start()
    seen = []
    gate = threading.Event()
    worker.submit(lambda: gate.wait(5), label="hold")
    worker.submit(lambda: seen.append(sdk_client.timeout), label="drained-at-shutdown")
    gate.set()
    worker.stop(timeout=10)

    assert seen == [_handlers.SHUTDOWN_TIMEOUT_SECONDS]
    assert _handlers.SHUTDOWN_TIMEOUT_SECONDS < normal
    _handlers._set_session_network_budget(None)


def test_submit_after_stop_is_refused_rather_than_queued_into_the_void():
    """The other half of the same drop. Putting a job on a queue whose reader
    has exited is a drop the call site cannot see."""
    worker = _handlers.WitnessWorker()
    worker.start()
    worker.stop(timeout=5)
    assert worker.submit(lambda: None, label="too late") is False
    assert worker.queued == 0


def test_dispatch_says_so_when_the_worker_is_not_running(attached_client, fresh_state, tmp_path):
    _handlers.WORKER.stop(timeout=5)
    scene = bpy_mock.Scene()
    scene.render.filepath = str(tmp_path / "img.png")
    (tmp_path / "img.png").write_bytes(b"pixels")
    _handlers._on_render_complete(scene)
    assert "not captured" in (_state.get().last_error or "")


def test_a_capture_queued_at_stop_reaches_the_on_disk_spool(
    attached_client, http_opener, tmp_path,
):
    """⚑ THE GATE, in miniature and against a mock: N captures queued, stop()
    called, and the count read from the SDK's on-disk queue file rather than
    from the worker. Before WO-F2 this file stayed empty -- the captures never
    reached the SDK at all."""
    http_opener.register("POST", "/api/v2/witness", {"error": "down"}, status=503)
    _handlers.WORKER.start()
    gate = threading.Event()
    _handlers.WORKER.submit(lambda: gate.wait(5), label="gate")
    for i in range(3):
        p = tmp_path / f"img{i}.png"
        p.write_bytes(b"pixels" + str(i).encode())
        scene = bpy_mock.Scene()
        scene.render.filepath = str(p)
        _handlers._on_render_complete(scene)
    gate.set()
    report = _handlers.WORKER.stop(timeout=20)

    assert report["abandoned"] == []
    on_disk = [e for e in attached_client.queue.load_all() if e["path"] == "/api/v2/witness"]
    assert len(on_disk) == 3
