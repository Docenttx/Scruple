"""Run INSIDE Blender: queue captures, then disable the add-on, and see what
survives.

    blender --background --python scripts/f2-blender-quit.py -- \
        --api-key KEY --base-url URL --work DIR --n 4

⚑ THIS IS THE CASE FINDING E7-3 BIT WO-E7 WITH. `unregister()` is what Blender
calls when the add-on is disabled or the session ends, and it calls
`WitnessWorker.stop()`. WO-E7's first exploratory run stopped the worker as soon
as the render returned and reported TWO captures where the same Blender, waiting
for quiescence, reported THREE. WO-E7 then worked around it -- it waits for
quiescence instead of stopping -- and named the defect. This script does NOT
work around it: it stops, immediately, on purpose.

The captures are the add-on's own. Nothing here calls a `witness_*` function;
`bpy.ops.wm.save_as_mainfile` fires `save_post`, the add-on's handler dispatches
it to its worker, and the worker is the thing under test.

⚑ ONE THING IS STAGED, AND IT IS STATED. A no-op job is submitted to the worker
first and held for the duration of the saves, so that "still queued when stop()
was called" is a fact rather than a race won by whichever of a .blend write and
an HTTP round-trip happened to be quicker. A render in flight does the same
thing to the queue, less predictably. `queued_at_stop` in the report is what
makes the stage meaningful; a stage that measured 0 there would be measuring
nothing.

🔴 Refuses to run against :5799 or :3001. The caller redirects HOME, so the
SDK's key cache and its on-disk spool are this run's and not the box's.
"""
import json
import os
import sys
import threading
import time

import bpy

MARK_OPEN = "<<<F2_BLENDER"
MARK_CLOSE = "F2_BLENDER>>>"


def argv():
    args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    out, i = {}, 0
    while i < len(args):
        out[args[i].lstrip("-")] = args[i + 1]
        i += 2
    return out


a = argv()
BASE = a["base-url"].rstrip("/")
WORK = a.get("work", "/tmp/f2-blender")
N = int(a.get("n", "4"))
os.makedirs(WORK, exist_ok=True)
if ":5799" in BASE or ":3001" in BASE:
    raise SystemExit(f"refusing to talk to {BASE} -- that is production")

report = {"base_url": BASE, "work": WORK, "n": N, "home": os.path.expanduser("~")}

module = None
for entry in bpy.context.preferences.addons:
    if entry.module.endswith("scruple_blender"):
        module = entry.module
        break
report["module"] = module
prefs_obj = bpy.context.preferences.addons[module].preferences if module else None
report["preferences_bound"] = prefs_obj is not None
if prefs_obj is None:
    report["error"] = "no preferences object; WO-F1 is what makes this path configurable"
    sys.stdout.write("\n" + MARK_OPEN + "\n" + json.dumps(report, indent=1) + "\n" + MARK_CLOSE + "\n")
    raise SystemExit(0)

prefs_obj.base_url = BASE
prefs_obj.api_key = a["api-key"]

from adapter import handlers as _handlers  # noqa: E402
from adapter import sdk as _sdk  # noqa: E402
from adapter import state as _state  # noqa: E402

_sdk.reset_client()
client = _sdk.get_client()
report["client_built"] = client is not None
report["client_base_url"] = getattr(client, "base_url", None)
report["worker_source"] = os.path.abspath(_handlers.__file__)
report["stop_has_drain"] = hasattr(_handlers, "SHUTDOWN_DRAIN_SECONDS")
report["queue_file"] = getattr(getattr(client, "queue", None), "path", None)


def spool_rows():
    path = report["queue_file"]
    rows = []
    if not path or not os.path.exists(path):
        return rows
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                e = json.loads(line)
            except ValueError:
                continue
            rows.append({"path": e.get("path"),
                         "content_hash": (e.get("body") or {}).get("content_hash")})
    return rows


report["spool_before"] = len(spool_rows())

# ---- hold the worker, so the saves land in a queue that is not moving ------
release = threading.Event()
holding = threading.Event()
try:
    _handlers.WORKER.submit(lambda: (holding.set(), release.wait(30)), label="hold")
except TypeError:                      # the before-tree's submit() has no label
    _handlers.WORKER.submit(lambda: (holding.set(), release.wait(30)))
holding.wait(10)
report["worker_held"] = holding.is_set()

# ---- N saves. The add-on's own save_post handler does the capturing. -------
scene = bpy.context.scene
scene.name = "f2-quit"
blends = []
for i in range(N):
    p = os.path.join(WORK, f"f2-quit-{i:02d}.blend")
    # A different object count per file, so the .blend bytes -- and therefore
    # the content hashes -- genuinely differ.
    bpy.ops.mesh.primitive_cube_add(location=(i * 2.0, 0, 0))
    bpy.ops.wm.save_as_mainfile(filepath=p)
    blends.append(p)
report["blends"] = blends
report["saved"] = [os.path.exists(p) for p in blends]
report["queued_before_stop"] = getattr(_handlers.WORKER, "queued", None)

# ---- ⚑ and now disable the add-on, immediately. ---------------------------
release.set()
t0 = time.monotonic()
_handlers.unregister()
report["unregister_seconds"] = round(time.monotonic() - t0, 3)
report["stop"] = getattr(_handlers.WORKER, "last_stop_report", None)

report["spool"] = [r for r in spool_rows() if r["path"] == "/api/v2/witness"]
report["captures"] = [
    {"state": getattr(r, "state", None), "leaf_id": getattr(r, "leaf_id", None),
     "content_hash": getattr(r, "content_hash", None),
     "filename": getattr(r, "filename", None), "error": getattr(r, "error", None)}
    for r in _state.assurances()
]
report["state_counts"] = _state.state_counts()
report["last_error"] = _state.get().last_error

sys.stdout.write("\n" + MARK_OPEN + "\n" + json.dumps(report, indent=1) + "\n" + MARK_CLOSE + "\n")
