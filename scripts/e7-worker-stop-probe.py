#!/usr/bin/env python3
"""⚑ FINDING E7-3, measured on the add-on's own class rather than argued —
and, since WO-F2, the assertion that it stays closed.

    python3 scripts/e7-worker-stop-probe.py

`adapter/handlers.WitnessWorker` is the in-memory queue every ambient capture
goes through. `stop()` used to set a flag, put a sentinel on the queue and join
— and `_run()` re-checked the flag AFTER pulling a job and BEFORE running it:

    while not self._stop_flag.is_set():
        job = self._q.get()
        if self._stop_flag.is_set():
            break            # <- whatever it just pulled is dropped
        job()

So a capture that was still queued when `stop()` was called never ran, and
because it never reached the SDK it was not in the on-disk retry queue either.
`unregister()` calls `stop()` — it drains the SDK's spool first, then stops
this worker — so the losing case was a capture taken shortly before Blender
quits or the add-on is disabled.

⚑ CLOSED BY WO-F2 (add-on `8c9062a`), AND THIS SCRIPT NOW ASSERTS THE CLOSURE.
The exit code was `0` when a capture was dropped, because that was the finding
being recorded. It is `0` when BOTH jobs run, because that is now the
behaviour the estate depends on — a script that keeps asserting a fixed defect
makes the suite require it. The full gate is `npm run f2`; this stays as the
smallest possible reproduction of the original measurement.

This probe runs the real class, outside Blender (`adapter/handlers` imports bpy
defensively and is importable with bpy absent), and reports which of two
submitted jobs ran. Nothing here is a mock: the class under test IS the class
that runs in a user's Blender.
"""
import json
import os
import sys
import threading
import time

ADDON = os.environ.get("E7_ADDON_ROOT", "/data/scruple-blender")
sys.path.insert(0, ADDON)
sys.path.insert(0, os.path.join(ADDON, "vendor"))

from adapter import handlers as H   # noqa: E402

ran = []
started = threading.Event()


def slow():
    started.set()
    time.sleep(1.5)
    ran.append("first")


def second():
    ran.append("second")


w = H.WitnessWorker()   # the shipped class, not a copy of it
w.start()
w.submit(slow)
w.submit(second)
started.wait(5)          # the first job is definitely in flight
w.stop(timeout=10)       # ...and the second is definitely still queued

print(json.dumps({
    "class": f"{H.WitnessWorker.__module__}.{H.WitnessWorker.__name__}",
    "source": os.path.abspath(H.__file__),
    "submitted": ["first", "second"],
    "ran": ran,
    "dropped": [j for j in ("first", "second") if j not in ran],
}, indent=1))
# ⚑ WO-F2 flipped this. Was: `0 if len(ran) < 2 else 1`.
sys.exit(0 if len(ran) == 2 else 1)
