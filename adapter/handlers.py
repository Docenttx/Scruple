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
import time
from typing import Any, Callable, Dict, Optional

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


#: How long `stop()` may hold Blender's shutdown while the in-memory queue
#: drains at SHUTDOWN_TIMEOUT_SECONDS per capture.
#:
#: ⚑ THE PRODUCT QUESTION WO-F2 NAMES, ANSWERED HERE. "How long may Blender's
#: shutdown block on a network call" is not a detail the fix can duck: draining
#: means running captures that make network calls, and `unregister()` runs while
#: the user is quitting. The answer taken is a BOUNDED WAIT IN TWO PHASES, and
#: the second phase is what makes the bound safe to keep short --
#: SHUTDOWN_HURRY_SECONDS below.
SHUTDOWN_DRAIN_SECONDS = 6.0

#: ...and how long after that, with the network budget cut again to
#: HURRY_TIMEOUT_SECONDS.
#:
#: Nothing is SKIPPED when the first budget runs out. What shrinks is the
#: NETWORK budget, not the set of jobs: each remaining capture still runs, still
#: hashes its file, still reaches `http.submit()`, and fails there on the
#: transport -- which is the one code path the SDK guarantees enqueues (§5
#: property 3). So a capture the drain has no time left to DELIVER lands on the
#: on-disk spool instead of on the floor, and the next Blender session sends it.
SHUTDOWN_HURRY_SECONDS = 4.0

#: What a server gets to take ONE capture once the session is shutting down.
#:
#: ⚑ CUT WHEN THE DRAIN STARTS, NOT WHEN IT OVERRUNS. Measured while WO-F2 was
#: being written, against a socket that accepts and never answers: leaving the
#: session's normal 30s budget in place for the first phase spends the WHOLE
#: shutdown on one wedged request, and cutting the budget afterwards does not
#: help -- `http.submit()` hands `session.timeout` to `urlopen` and a socket
#: already blocked in read() cannot be called back. The bound has to be in front
#: of the first shutdown request, not behind it.
#:
#: 2s is chosen against what the call actually is: a small JSON POST that a
#: healthy server answers in tens of milliseconds. It costs a slow-but-alive
#: server nothing and it costs a dead one 2s per capture instead of 30.
SHUTDOWN_TIMEOUT_SECONDS = 2.0

#: And during the hurry phase. Small enough that a queue that is still deep when
#: the drain budget expires empties onto the spool in a fraction of a second per
#: capture; not zero, because a server that is merely slow should still be
#: allowed to take the capture rather than be assumed down.
HURRY_TIMEOUT_SECONDS = 0.1


class _StopSentinel:
    """What `stop()` puts on the queue to mark the end of the work.

    A distinct type rather than the `lambda: None` this used to be: the worker
    has to be able to tell "the queue is finished" from "a job that happens to
    do nothing", and a callable cannot say which it is.
    """


_STOP = _StopSentinel()


class WitnessWorker:
    """Single background thread that drains a work queue.

    A queue keeps witness calls in order per session and stops Blender's
    UI from freezing on the network round-trip. This is the in-memory,
    this-session queue; the on-disk retry queue that survives a crash is
    the SDK's, and it is filled by http.submit(), not by this class.

    ⚑ WO-F2 / FINDING E7-3. `_run()` used to re-check the stop flag AFTER
    pulling a job and BEFORE running it:

        while not self._stop_flag.is_set():
            job = self._q.get()
            if self._stop_flag.is_set():
                break            # <- whatever it just pulled is dropped
            job()

    so every capture still queued when `stop()` was called was discarded -- and
    because it never reached the SDK it was not on the on-disk spool either.
    `unregister()` calls `stop()`, so the losing case was a capture taken
    shortly before Blender quits or the add-on is disabled: exactly the case
    store-and-forward exists for. Measured, on this class, outside Blender:
    `{"submitted": ["first","second"], "ran": ["first"], "dropped": ["second"]}`.

    THE RULE NOW: the stop flag is honoured when the SENTINEL comes up, and the
    sentinel is behind every job that was queued before `stop()` was called. So
    a queued capture RUNS, and having run it is either delivered or spooled by
    the SDK. What is bounded is how long that is allowed to take -- see
    SHUTDOWN_DRAIN_SECONDS -- and when the bound is reached the network budget
    is cut rather than the queue.

    ⚑ WHAT THE BOUND CANNOT COVER, said plainly: THE ONE REQUEST ALREADY ON THE
    WIRE WHEN stop() IS CALLED. `http.submit()` passes `session.timeout` to
    `urlopen` and there is no cancel, so a socket already blocked in `read()`
    keeps the budget it was given -- the session's 30s -- whatever this class
    does afterwards. Every request that STARTS after stop() is capped
    (SHUTDOWN_TIMEOUT_SECONDS, then HURRY_TIMEOUT_SECONDS); that one is not.

    stop() still returns inside its own budgets -- it does not wait 30s -- but
    the drain behind that request may not get to run at all, and what it could
    not reach comes back in `abandoned`. That is the residual, and it is why
    this class reports rather than just returning: the guarantee is "delivered,
    spooled, or NAMED", and only the first two of those are silent-safe.
    Measured, not argued: `scripts/f2-gate.sh` stage 4B in the desktop repo.
    Finding F2-1 in docs/WO-F2.md.
    """

    def __init__(self, *, set_network_budget: Optional[Callable[[Optional[float]], None]] = None) -> None:
        self._q: "queue.Queue[Any]" = queue.Queue()
        self._thread: Optional[threading.Thread] = None
        self._lock = threading.Lock()
        #: False from the moment stop() is called. A job submitted after that
        #: must NOT go on a queue nobody will read -- see submit().
        self._accepting = False
        self._seq = 0
        #: seq -> label, for everything submitted and not yet run. This is how
        #: stop() can NAME what it could not drain instead of reporting a
        #: number, and it is the only accounting this class keeps.
        self._outstanding: Dict[int, str] = {}
        self._ran = 0
        #: What the last stop() reported. `unregister()` runs deep inside
        #: Blender's disable path and its return value goes nowhere, so the
        #: report is left here as well -- it is how the panel, and WO-F2's
        #: Blender stage, can ask what the shutdown actually managed.
        self.last_stop_report: Optional[Dict[str, Any]] = None
        #: Called with a number of seconds to cut this session's network budget
        #: to, and with None to put it back. The worker does not know what a
        #: session is; `_set_session_network_budget()` below does.
        self._set_network_budget = set_network_budget

    # ---- lifecycle -----------------------------------------------------

    def start(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._budget(None)
        # ⚑ Purge any sentinel a previous stop() left behind. Caught by
        # `test_a_capture_queued_at_stop_reaches_the_on_disk_spool` while WO-F2
        # was being written: a stop() whose thread had already exited leaves an
        # unread _STOP on the queue, the NEXT thread pulls it as its first item
        # and returns, and every capture in that session is then refused with
        # "the worker is not running". A typed sentinel makes that visible
        # where the old `lambda: None` would have been eaten as a no-op job --
        # which is the same shape of defect as E7-3, one lifecycle up.
        self._drop_stale_sentinels()
        with self._lock:
            self._accepting = True
        self._thread = threading.Thread(
            target=self._run, name="ScrupleWitnessWorker", daemon=True,
        )
        self._thread.start()

    def stop(self, timeout: Optional[float] = None, *,
             hurry_timeout: Optional[float] = None) -> Dict[str, Any]:
        """Drain what is queued, then stop. Returns what actually happened.

        The return value is a report, not a status: `queued_at_stop`, `ran`,
        `hurried` and `abandoned` (the LABELS of anything the two budgets did
        not reach). Callers surface it; `unregister()` puts a non-empty
        `abandoned` on the error surface, because a capture that was not taken
        has to be visible as one.
        """
        drain_budget = SHUTDOWN_DRAIN_SECONDS if timeout is None else timeout
        hurry_budget = SHUTDOWN_HURRY_SECONDS if hurry_timeout is None else hurry_timeout

        started = time.monotonic()
        with self._lock:
            self._accepting = False
            queued_at_stop = len(self._outstanding)
            ran_before = self._ran
        # ⚑ IN FRONT OF THE FIRST SHUTDOWN REQUEST. See SHUTDOWN_TIMEOUT_SECONDS.
        self._budget(SHUTDOWN_TIMEOUT_SECONDS)
        thread = self._thread
        if thread is not None and thread.is_alive():
            self._q.put(_STOP)

        hurried = False
        if thread is not None:
            thread.join(timeout=drain_budget)
            if thread.is_alive():
                # The first budget expired with work still queued. Cut the
                # NETWORK budget again, not the queue: every remaining job still
                # runs, fails fast on the transport, and is spooled by the SDK.
                hurried = True
                self._budget(HURRY_TIMEOUT_SECONDS)
                thread.join(timeout=hurry_budget)
        self._thread = None

        with self._lock:
            abandoned = [self._outstanding[k] for k in sorted(self._outstanding)]
            self._outstanding.clear()
            ran = self._ran - ran_before

        report = {
            "queued_at_stop": queued_at_stop,
            "ran": ran,
            "hurried": hurried,
            "abandoned": abandoned,
            "seconds": round(time.monotonic() - started, 3),
        }
        self.last_stop_report = report
        if abandoned:
            _log.error(
                f"witness worker: {len(abandoned)} capture(s) NOT taken at shutdown "
                f"after {report['seconds']}s: {', '.join(abandoned)}"
            )
        elif queued_at_stop:
            _log.info(
                f"witness worker: drained {ran} queued capture(s) in {report['seconds']}s"
                + (" (on a cut network budget)" if hurried else "")
            )
        return report

    # ---- work ----------------------------------------------------------

    def submit(self, job: Callable[[], None], *, label: str = "capture") -> bool:
        """Queue a job. False means it was NOT queued, and the caller has been
        told rather than left to assume.

        Refusing after `stop()` is half of the same finding: putting a job on a
        queue whose reader has exited is a drop with extra steps, and it is
        indistinguishable from a success at the call site.
        """
        with self._lock:
            running = self._accepting and self._thread is not None and self._thread.is_alive()
            if not running:
                _log.error(f"{label}: the witness worker is not running; NOT captured")
                return False
            self._seq += 1
            seq = self._seq
            self._outstanding[seq] = label
        self._q.put((seq, job))
        return True

    def _budget(self, seconds: Optional[float]) -> None:
        if self._set_network_budget is None:
            return
        try:
            self._set_network_budget(seconds)
        except Exception as e:  # pragma: no cover - defensive
            _log.warn(f"witness worker: network budget -> {seconds}: {e}")

    def _drop_stale_sentinels(self) -> None:
        keep = []
        while True:
            try:
                item = self._q.get_nowait()
            except queue.Empty:
                break
            if item is not _STOP:
                keep.append(item)
        for item in keep:
            self._q.put(item)

    def _run(self) -> None:
        while True:
            item = self._q.get()
            if item is _STOP:
                return
            seq, job = item
            try:
                job()
            except Exception as e:
                _log.error(f"witness worker job raised: {e}")
            finally:
                with self._lock:
                    self._outstanding.pop(seq, None)
                    self._ran += 1

    # ---- what the panel and the probes read ----------------------------

    @property
    def queued(self) -> int:
        """How many submitted jobs have not run yet. In-memory accounting, and
        named as such: the gate for WO-F2 counts captures from DISK, never from
        here."""
        with self._lock:
            return len(self._outstanding)

    @property
    def running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()


#: The session's normal network budget, remembered while it is cut.
_NORMAL_TIMEOUT: Optional[float] = None


def _set_session_network_budget(seconds: Optional[float]) -> None:
    """Cut this session's network budget to `seconds`, or put it back with None.

    The point is NOT to give up on delivery -- `stop()` cuts the budget to
    SHUTDOWN_TIMEOUT_SECONDS, which a healthy server answers inside many times
    over. The point is that a capture the shutdown has no time left to DELIVER
    still reaches `http.submit()` and is SPOOLED by it.

    An adapter may not write its own retry (CANON_SKELETON §5), and this does
    not: it changes one number on the session and lets the SDK's own failure
    path do the enqueuing. `start()` calls it with None, so a session that
    stops and starts the worker again -- reloading the addon, the test suite --
    does not inherit a shutdown's budget as its normal one.
    """
    global _NORMAL_TIMEOUT
    client = _sdk.peek_client()
    if seconds is None:
        if _NORMAL_TIMEOUT is None:
            return
        if client is not None:
            client.timeout = _NORMAL_TIMEOUT
        _NORMAL_TIMEOUT = None
        return
    if client is None:
        return
    if _NORMAL_TIMEOUT is None:
        _NORMAL_TIMEOUT = getattr(client, "timeout", None)
    client.timeout = seconds


WORKER = WitnessWorker(set_network_budget=_set_session_network_budget)


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

    if not WORKER.submit(_job, label=label):
        # WO-F2. `submit()` returning False means the worker is stopped, so
        # this capture was NOT taken. Before the fix it went on a queue nobody
        # was reading and the call site could not tell.
        _state.set_error(f"{label}: not captured -- the witness worker is stopped")


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
            WORKER.submit(lambda: drain_queue(), label="queue drain")
    except Exception as e:  # never let a timer die
        _log.warn(f"drain tick: {e}")
    return DRAIN_INTERVAL_SECONDS


def _refresh_dashboard() -> None:
    """Fill the panel's caches. Never raises: it runs on the worker
    thread at startup, and a failure here must cost the panel a project
    list, not the addon its handlers."""
    try:
        from operators import dashboard as _dashboard_ops

        _dashboard_ops.refresh_projects()
        _dashboard_ops.refresh_payment_config()
    except Exception as e:
        _log.warn(f"dashboard refresh: {e}")


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
    WORKER.submit(lambda: drain_queue(), label="startup drain")
    # WO-B5. The dashboard's caches, filled once at startup so the panel
    # has a project list and a payment state before the user presses
    # anything. Off the main thread for the same reason the drain is:
    # register() runs while Blender is starting up.
    WORKER.submit(_refresh_dashboard, label="dashboard refresh")
    _log.info("handlers registered")


def unregister() -> None:
    if bpy is None:
        return
    try:
        _remove_timer()
        _uninstall(bpy.app.handlers)
        # The spool FIRST, still: this sends what a previous session (or an
        # outage earlier in this one) left on disk. WO-F2 deliberately did not
        # move it after the worker drain -- a capture the drain spools is
        # already durable, and retrying it here would put a second round of
        # network calls in front of a user who is quitting.
        drain_queue()
    finally:
        # WO-F2 / finding E7-3. This drains the in-memory queue instead of
        # discarding it. Everything it runs is delivered or spooled by the SDK;
        # anything the shutdown bound could not reach is NAMED here rather than
        # dropped in silence.
        report = WORKER.stop()
    if report["abandoned"]:
        _state.set_error(
            f"{len(report['abandoned'])} capture(s) were not taken at shutdown: "
            + ", ".join(report["abandoned"])
        )
    _log.info(
        "handlers unregistered "
        f"(queued at stop {report['queued_at_stop']}, drained {report['ran']}, "
        f"abandoned {len(report['abandoned'])}, {report['seconds']}s)"
    )


def install_for_test(mock_handlers: Any) -> None:
    """Test hook: install into a mock bpy.app.handlers without touching bpy."""
    _install(mock_handlers)


def uninstall_for_test(mock_handlers: Any) -> None:
    _uninstall(mock_handlers)
