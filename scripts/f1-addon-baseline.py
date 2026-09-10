"""Run INSIDE Blender: re-record the standalone add-on's baseline, deliberately.

    blender --background --python scripts/f1-addon-baseline.py -- \
        --api-key KEY --base-url URL --work DIR

WO-F1 moves the add-on's tamper surface hash, and `baselines.baseline_hash` is
what `/api/v2/witness` keys a leaf's `baseline_hash` column by. WO-E7 recorded
`22e97c93c1d8…` for the add-on's leaf; that number is now wrong, and the work
order says to re-record it rather than let it rot. This is the re-recording.

⚑ IT CONFIGURES THE ADD-ON THROUGH THE PREFERENCES FIELDS, which is the whole
point. `scripts/e7-addon-alone.py` had to write the SDK's on-disk auth cache
instead, because on the manifest install path there was no preferences object
to write to — WO-E7 says so in finding E7-2, and that workaround is why the
product looked like it worked. This script sets `base_url` and `api_key` on the
bound preferences object and nothing else, so a leaf coming back at all is a
side effect of the fix.

It does NOT render. WO-E7 needed Cycles because it was comparing pixels from two
different AI images; this needs one leaf from the add-on's own ambient handler,
and `save_post` fires on a `.blend` save. The capture is the add-on's, not this
file's: nothing here calls a `witness_*` function.

🔴 The base URL is whatever the caller passes and the caller is the gate, which
passes the sandbox. Refuses to run against :5799 or :3001.
⚑ HOME must be redirected by the caller: `scruple_host_sdk.auth` writes its key
cache to `~/.scruple/` with no environment override.
"""
import json
import os
import sys
import time

import bpy

MARK_OPEN = "<<<F1_BASELINE"
MARK_CLOSE = "F1_BASELINE>>>"


def argv():
    args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    out = {}
    i = 0
    while i < len(args):
        out[args[i].lstrip("-")] = args[i + 1]
        i += 2
    return out


a = argv()
BASE = a["base-url"].rstrip("/")
WORK = a.get("work", "/tmp/f1-baseline")
os.makedirs(WORK, exist_ok=True)

if ":5799" in BASE or ":3001" in BASE:
    raise SystemExit(f"refusing to talk to {BASE} — that is production")

report = {"base_url": BASE, "work": WORK, "home": os.path.expanduser("~")}

# ── 1. the module Blender enabled, and the preferences object it bound ──────
module = None
for entry in bpy.context.preferences.addons:
    if entry.module.endswith("scruple_blender"):
        module = entry.module
        break
report["module"] = module
prefs_obj = bpy.context.preferences.addons[module].preferences if module else None
report["preferences_bound"] = prefs_obj is not None

if prefs_obj is None:
    # This is the before-tree's behaviour and there is nothing to re-record
    # from it. Say so and stop, rather than falling back to the auth cache —
    # falling back is exactly what hid the defect for a whole work order.
    report["error"] = "no preferences object on this install path; nothing to configure"
    sys.stdout.write("\n" + MARK_OPEN + "\n" + json.dumps(report, indent=1) + "\n" + MARK_CLOSE + "\n")
    raise SystemExit(0)

# ── 2. ⚑ CONFIGURED THROUGH THE UI, AND ONLY THROUGH THE UI ────────────────
prefs_obj.base_url = BASE
prefs_obj.api_key = a["api-key"]

from adapter import preferences as _prefs  # noqa: E402
from adapter import sdk as _sdk  # noqa: E402
from adapter import state as _state  # noqa: E402
from scruple_host_sdk import auth as _auth  # noqa: E402

report["auth_cache_present"] = bool((_auth.load_cached(_sdk.HOST) or {}).get("api_key"))
report["get_base_url"] = _prefs.get_base_url()
report["bl_idname"] = _prefs.ScrupleAddonPreferences.bl_idname

_sdk.reset_client()
client = _sdk.get_client()
report["client_built"] = client is not None
report["client_base_url"] = getattr(client, "base_url", None)

# ── 3. one save. The add-on's own save_post handler does the capturing. ─────
scene = bpy.context.scene
scene.name = "f1-baseline"
blend = os.path.join(WORK, "f1-baseline.blend")
bpy.ops.wm.save_as_mainfile(filepath=blend)
report["saved"] = os.path.exists(blend)

# ── 4. wait for the worker to go quiet. NOT stop() — that is finding E7-3,
#      which drops whatever is still queued, and WO-F2's problem, not this
#      one's. Bounded wait on the assurance list instead. ───────────────────
deadline = time.time() + 120
last_n, quiet_since = -1, None
while time.time() < deadline:
    n = len(_state.assurances())
    if n != last_n:
        last_n, quiet_since = n, time.time()
    elif n > 0 and quiet_since and time.time() - quiet_since > 6:
        break
    time.sleep(1)

report["captures"] = [
    {
        "state": getattr(r, "state", None),
        "leaf_id": getattr(r, "leaf_id", None),
        "content_hash": getattr(r, "content_hash", None),
        "error": getattr(r, "error", None),
    }
    for r in _state.assurances()
]
report["baseline_ref"] = getattr(client.state, "baseline_ref", None) if client else None
report["tamper_surface_hash"] = getattr(client.state, "tamper_surface_hash", None) if client else None
report["last_error"] = _state.get().last_error

sys.stdout.write("\n" + MARK_OPEN + "\n" + json.dumps(report, indent=1) + "\n" + MARK_CLOSE + "\n")
