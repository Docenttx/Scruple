"""bpy.app.handlers registration + dispatch.

gap.json, modules row 11, verdict "keep -- adapter code": there is no SDK
counterpart for this, because `bpy.app.handlers` registration is
genuinely Blender's. What changed is the four lines inside `_dispatch`'s
`except`. They used to be the ENTIRE failure path -- log a warning, set
`last_error`, drop the capture on the floor -- because nothing in the
addon ever called the queue it shipped with.

Under the SDK they are a backstop and not much else. `http.submit()`
enqueues before the exception ever reaches here, inline in its own
control flow, so a witness that could not be delivered is already spooled
to disk by the time this handler hears about it. `unregister()` drains
that spool through `Client.detach()`.

Handlers must be idempotent about registration: reloading the addon
would double-register otherwise. Each handler wraps the actual capture in
try/except so a witness failure never bubbles into Blender's own
render/save/export pipelines.
"""

from __future__ import annotations

import os
import queue
import threading
from typing import Any, Callable, Optional

from . import flow as _wf
from . import log as _log
from . import sdk as _sdk
from . import state as _state

try:
    import bpy
except ImportError:
    bpy = None


HANDLER_TAG = "_scruple_blender_owned"


class WitnessWorker:
    """Single background thread that drains a work queue.

    A queue keeps witness calls in order per session and stops Blender's
    UI from freezing on the network round-trip. This is the in-memory,
    this-session queue; the on-disk retry queue that survives a crash is
    the SDK's, and it is filled by http.submit(), not by this class.
    """

    def __init__(self) -> None:
        self._q: "queue.Queue[Callable[[], None]]" = queue.Queue()
        self._thread: Optional[threading.Thread] = None
        self._stop_flag = threading.Event()

    def start(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop_flag.clear()
        self._thread = threading.Thread(
            target=self._run, name="ScrupleWitnessWorker", daemon=True,
        )
        self._thread.start()

    def stop(self, timeout: float = 2.0) -> None:
        self._stop_flag.set()
        self._q.put(lambda: None)
        if self._thread is not None:
            self._thread.join(timeout=timeout)
        self._thread = None

    def submit(self, job: Callable[[], None]) -> None:
        self._q.put(job)

    def _run(self) -> None:
        while not self._stop_flag.is_set():
            job = self._q.get()
            if self._stop_flag.is_set():
                break
            try:
                job()
            except Exception as e:
                _log.error(f"witness worker job raised: {e}")


WORKER = WitnessWorker()


def _get_client():
    return _sdk.get_client()


def _dispatch(fn: Callable[[Any], Any], *, label: str) -> None:
    client = _get_client()
    if client is None:
        _log.info(f"{label}: not signed in; skipping")
        return

    def _job():
        try:
            fn(client)
        except Exception as e:
            # Backstop only. A transport failure inside the SDK does not
            # arrive here -- it was enqueued and returned as an outcome
            # with queued=True. What reaches this line is a bug in the
            # adapter, and it belongs on the error surface as one.
            _log.warn(f"{label} failed: {e}")
            _state.set_error(f"{label}: {e}")

    WORKER.submit(_job)


def _on_render_complete(scene) -> None:
    _log.info("handler: render_complete")
    _dispatch(
        lambda c: _wf.witness_render(c, scene, trigger="render_complete"),
        label="render_complete",
    )


def _on_render_write(scene) -> None:
    frame = None
    try:
        frame = int(scene.frame_current)
    except Exception:
        pass
    _log.info(f"handler: render_write frame={frame}")
    _dispatch(
        lambda c: _wf.witness_render(c, scene, trigger="render_write", frame=frame),
        label="render_write",
    )


def _on_save_post(_dummy) -> None:
    if bpy is None:
        return
    path = bpy.data.filepath
    if not path or not os.path.exists(path):
        _log.info("save_post: filepath missing after save; skipping")
        return
    scene = bpy.context.scene
    _log.info(f"handler: save_post {path}")
    _dispatch(
        lambda c: _wf.witness_save(c, scene, path, trigger="save_post"),
        label="save_post",
    )


HANDLER_MAP = (
    ("render_complete", _on_render_complete),
    ("render_write", _on_render_write),
    ("save_post", _on_save_post),
)


def _tag_owned(fn: Callable) -> Callable:
    setattr(fn, HANDLER_TAG, True)
    return fn


def _install(handlers_module: Any) -> None:
    for name, fn in HANDLER_MAP:
        try:
            hook_list = getattr(handlers_module, name)
        except AttributeError:
            _log.warn(f"bpy.app.handlers has no '{name}'; skipping")
            continue
        hook_list[:] = [h for h in hook_list if not getattr(h, HANDLER_TAG, False)]
        tagged = _tag_owned(fn)
        hook_list.append(tagged)


def _uninstall(handlers_module: Any) -> None:
    for name, _ in HANDLER_MAP:
        try:
            hook_list = getattr(handlers_module, name)
        except AttributeError:
            continue
        hook_list[:] = [h for h in hook_list if not getattr(h, HANDLER_TAG, False)]


def drain_queue() -> dict:
    """Replay whatever the SDK spooled while the server was unreachable.

    Called on unregister (addon disabled / Blender quitting), which is
    the moment `Client.detach()`'s docstring names. WO-B4 wires it to a
    timer as well -- until then, a capture taken offline lands on the
    next Blender session that reaches the server, not on the next render.
    """
    client = _sdk.peek_client()
    if client is None:
        return {"succeeded": 0, "failed": 0, "remaining": 0}
    result = client.detach()
    if result.get("succeeded") or result.get("remaining"):
        _log.info(f"queue drain: {result}")
    return result


def register() -> None:
    if bpy is None:
        return
    WORKER.start()
    _install(bpy.app.handlers)
    _log.info("handlers registered")


def unregister() -> None:
    if bpy is None:
        return
    try:
        _uninstall(bpy.app.handlers)
        drain_queue()
    finally:
        WORKER.stop()
    _log.info("handlers unregistered")


def install_for_test(mock_handlers: Any) -> None:
    """Test hook: install into a mock bpy.app.handlers without touching bpy."""
    _install(mock_handlers)


def uninstall_for_test(mock_handlers: Any) -> None:
    _uninstall(mock_handlers)
