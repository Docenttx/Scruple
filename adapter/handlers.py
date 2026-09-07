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
from . import reconcile as _reconcile
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


#: How often the drain timer fires, in seconds.
#:
#: Not a backoff -- `queue.BACKOFF_SCHEDULE` already holds one, per entry,
#: and it starts at 5s and ends at 1800s. This is only how often the queue
#: is LOOKED AT, so it has to be no coarser than the finest backoff step or
#: the schedule's early retries would be silently stretched to this
#: interval. 60s is a compromise the other way as well: `Client.detach()`
#: makes one network call per DUE entry, on Blender's timer thread, and a
#: tighter tick would put that in front of a user during a render for no
#: gain -- an entry that is not due is skipped either way.
DRAIN_INTERVAL_SECONDS = 60.0

_TIMER_TAG = "_scruple_drain_timer"


def drain_queue() -> dict:
    """Replay whatever the SDK spooled while the server was unreachable.

    WO-B4 wires this to three places instead of one. Before it, the only
    caller was `unregister()`, so a capture taken while the server was
    down landed on the next Blender session that got as far as being
    disabled -- not on the next render, and not at all if Blender was
    killed. Now:

      * `register()`   -- a previous session's spool goes out as soon as
                          this one has a client, without a render;
      * a timer        -- every DRAIN_INTERVAL_SECONDS while the addon is
                          enabled, on the worker thread;
      * `unregister()` -- unchanged, still the last chance.

    The drain itself is still `Client.detach()` and nothing else: an
    adapter may not write its own retry (CANON_SKELETON §5).
    """
    client = _sdk.peek_client()
    if client is None:
        return {"attempted": 0, "succeeded": 0, "failed": 0, "remaining": 0}
    result = _reconcile.drain(client)
    if result.attempted:
        _log.info(
            f"queue drain: {result.succeeded} delivered, {result.remaining} remaining"
        )
    return {
        "attempted": result.attempted,
        "succeeded": result.succeeded,
        "failed": result.failed,
        "remaining": result.remaining,
    }


def settle(*, drain_first: bool = True):
    """Reconcile this session's ledger against the server.

    Returns a `reconcile.Reconciliation`, or None when there is no signed-in
    client -- None meaning "no settlement happened", never "nothing was
    missing".
    """
    client = _sdk.peek_client()
    if client is None:
        return None
    return _reconcile.reconcile(client, drain_first=drain_first)


def _drain_tick() -> float:
    """The timer body. Returns the seconds until the next call, which is
    what `bpy.app.timers` uses to reschedule.

    The work is handed to the worker thread rather than done here: a
    Blender timer runs on the main thread and a blocked socket there is a
    frozen UI. The tick itself must never raise -- an exception from a
    timer callback unregisters the timer, so a single network hiccup would
    silently stop all future draining, which is precisely the invisible
    failure this WO is about.
    """
    try:
        client = _sdk.peek_client()
        if client is not None and client.queue_depth:
            WORKER.submit(lambda: drain_queue())
    except Exception as e:  # never let a timer die
        _log.warn(f"drain tick: {e}")
    return DRAIN_INTERVAL_SECONDS


def _install_timer() -> bool:
    if bpy is None or not hasattr(bpy.app, "timers"):
        return False
    timers = bpy.app.timers
    try:
        if timers.is_registered(_drain_tick):
            return True
        timers.register(_drain_tick, first_interval=DRAIN_INTERVAL_SECONDS, persistent=True)
        return True
    except Exception as e:
        _log.warn(f"could not register the drain timer: {e}")
        return False


def _remove_timer() -> None:
    if bpy is None or not hasattr(bpy.app, "timers"):
        return
    try:
        if bpy.app.timers.is_registered(_drain_tick):
            bpy.app.timers.unregister(_drain_tick)
    except Exception as e:
        _log.warn(f"could not unregister the drain timer: {e}")


def register() -> None:
    if bpy is None:
        return
    WORKER.start()
    _install(bpy.app.handlers)
    _install_timer()
    # A spool left by a previous session goes out now, not on the next
    # render. Off the main thread: register() runs while Blender is
    # starting up and a network round-trip here would be a hang at launch.
    WORKER.submit(lambda: drain_queue())
    _log.info("handlers registered")


def unregister() -> None:
    if bpy is None:
        return
    try:
        _remove_timer()
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
