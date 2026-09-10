"""Run INSIDE Blender: THE ADD-ON, ALONE, on a scene built around imports.

WO-F3, closing finding E7-1. A variant of `scripts/e7-addon-alone.py` — that
script is left exactly as WO-E7 wrote it, because the E7 gate still runs it —
with the three things this work order needs and that one has no way to express:

  --images A.png,B.png      one or more images IMPORTED into the scene, packed
                            into the .blend so their bytes are inside the
                            document the add-on witnesses
  --unpacked C.png          an image linked by path rather than packed
  --delete-unpacked         …and its file removed after loading, which is
                            control (b): a datablock whose bytes cannot be read
  --no-imports              a scene with nothing imported at all, which is
                            control (a): an EMPTY declaration that is PRESENT

⚑ IT SAVES AND DOES NOT RENDER. WO-E7 needed Cycles because it was comparing
pixels from two different AI images; this compares DECLARATIONS, and the .blend
is the leaf the packed bytes are actually in. A render under qemu costs minutes
and would measure nothing this does not.

⚑ IT CONFIGURES THROUGH THE PREFERENCES FIELDS, like `scripts/f1-addon-baseline.py`
and unlike `scripts/e7-addon-alone.py`, which had to write the SDK's auth cache
because on the manifest install path there was no preferences object to write to
(finding E7-2, closed by WO-F1). So a leaf coming back at all also re-exercises
that fix.

⚑ NOTHING HERE CALLS A `witness_*` FUNCTION. The capture is the add-on's own
`save_post` handler; a script that called the flow itself would be measuring
this file.

⚑ SCRUPLE_COMFY_HOST_DIR MUST NOT BE SET — with it set the add-on writes a host
declaration for a gate, and this run is the one with no gate. Reported rather
than unset, so the gate can fail a run that was quietly Level 2.

🔴 Refuses to talk to :5799 or :3001.
"""

import json
import os
import sys
import time

import bpy

MARK_OPEN = "<<<F3_ADDON"
MARK_CLOSE = "F3_ADDON>>>"


def argv():
    args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    out, i = {}, 0
    while i < len(args):
        k = args[i].lstrip("-")
        if i + 1 < len(args) and not args[i + 1].startswith("--"):
            out[k], i = args[i + 1], i + 2
        else:
            out[k], i = "yes", i + 1
    return out


a = argv()
BASE = a["base-url"].rstrip("/")
WORK = a["work"]
os.makedirs(WORK, exist_ok=True)
if ":5799" in BASE or ":3001" in BASE:
    raise SystemExit(f"refusing to talk to {BASE} — that is production")

report = {
    "blender_version": ".".join(str(x) for x in bpy.app.version),
    "base_url_arg": BASE,
    "work": WORK,
    "home": os.environ.get("HOME"),
    "host_dir_env": os.environ.get("SCRUPLE_COMFY_HOST_DIR"),
}


def emit():
    sys.stdout.write("\n" + MARK_OPEN + "\n" + json.dumps(report, indent=1, default=str) + "\n" + MARK_CLOSE + "\n")
    sys.stdout.flush()


module = None
for entry in bpy.context.preferences.addons:
    if entry.module.endswith("scruple_blender"):
        module = entry.module
        break
report["module"] = module
report["loaded_via_manifest"] = bool(module and module.startswith("bl_ext."))
if module is None:
    report["error"] = "the Scruple add-on is not enabled in this profile"
    emit()
    raise SystemExit(0)

prefs_obj = getattr(bpy.context.preferences.addons[module], "preferences", None)
report["preferences_bound"] = prefs_obj is not None

# ⚑ THE LIVE MODULES ARE TOP-LEVEL, not attributes of the extension package —
# the add-on's __init__.py puts its own directory on sys.path. Importing the
# dotted name loads a SECOND copy whose worker was never started, and the run
# reports nothing for a Blender that witnessed perfectly well. WO-E7's comment,
# and it cost that work order a run.
from adapter import preferences as _prefs  # noqa: E402
from adapter import sdk as _sdkmod  # noqa: E402
from adapter import scene as _scenemod  # noqa: E402
from adapter import state as _state  # noqa: E402
from scruple_host_sdk import auth as _auth  # noqa: E402

if prefs_obj is not None:
    prefs_obj.base_url = BASE
    prefs_obj.api_key = a["api-key"]
else:
    # The before-tree's path (pre-WO-F1). Fall back so this script can also be
    # pointed at an OLD add-on tree for the red-before stage — and SAY that it
    # did, because a silent fallback is what hid E7-2 for a whole work order.
    report["fell_back_to_auth_cache"] = True
    _auth.save_cached("blender", a["api-key"], BASE)

_sdkmod.reset_client()
report["base_url"] = _prefs.get_base_url()
report["signed_in"] = _prefs.is_authed()

# ---- the scene ----------------------------------------------------------
sc = bpy.context.scene
sc.name = a.get("scene", "f3-scene")
for ob in list(bpy.data.objects):
    bpy.data.objects.remove(ob, do_unlink=True)

report["imports"] = []
if a.get("no-imports") != "yes":
    for n, path in enumerate(x for x in a.get("images", "").split(",") if x):
        img = bpy.data.images.load(path)
        img.name = f"imported-{n}"
        img.pack()
        report["imports"].append(
            {
                "datablock": img.name,
                "source_path": path,
                "packed": bool(img.packed_file),
                "packed_size": getattr(img.packed_file, "size", None),
                "source_enum": img.source,
            }
        )
    for path in (x for x in a.get("unpacked", "").split(",") if x):
        img = bpy.data.images.load(path)
        img.name = "linked-by-path"
        # NOT packed: the bytes stay on disk, which is the other of the two
        # places the enumerator has to read them from.
        if a.get("delete-unpacked") == "yes":
            os.remove(path)
        report["imports"].append(
            {
                "datablock": img.name,
                "source_path": path,
                "packed": bool(img.packed_file),
                "deleted_after_load": a.get("delete-unpacked") == "yes",
                "exists_now": os.path.exists(path),
                "source_enum": img.source,
            }
        )

# Every image datablock in the file at the moment of the save, WITH the source
# enum — so the gate can say what Blender held rather than what this script
# thinks it created. `Render Result` and `Viewer Node` are here on every real
# startup and must not appear in the declaration.
report["image_datablocks"] = sorted(
    [i.name, i.source, bool(i.packed_file)] for i in bpy.data.images
)

blend = os.path.join(WORK, "f3-addon-alone.blend")
bpy.ops.wm.save_as_mainfile(filepath=blend)
report["blend_path"] = blend
report["blend_exists"] = os.path.exists(blend)

# ---- DIAGNOSTIC ONLY: what the enumerator itself says -------------------
# ⚑ NOT THE MEASUREMENT. This calls the add-on's own function, so it can only
# ever agree with itself; the gate reads the DECLARATION OFF THE LEAF in the
# app's database and re-hashes the bytes with sha256sum from the shell. This is
# here so a mismatch between the two is diagnosable rather than merely red.
try:
    doc = _scenemod.imported_datablocks()
    report["enumerator_diagnostic"] = doc
except Exception as e:  # noqa: BLE001
    report["enumerator_diagnostic_error"] = f"{type(e).__name__}: {e}"

# ---- wait for the worker to go quiet -----------------------------------
# NOT stop(). That was finding E7-3 and is WO-F2's subject; a bounded wait on
# the assurance list is what a user's Blender does while they carry on working.
quiet = float(a.get("quiet-seconds", 6))
deadline = time.time() + float(a.get("settle-seconds", 180))
seen, last_change = len(_state.assurances()), time.time()
while time.time() < deadline and (time.time() - last_change < quiet or seen == 0):
    time.sleep(0.5)
    now = len(_state.assurances())
    if now != seen:
        seen, last_change = now, time.time()
report["captures"] = seen

client = _sdkmod.peek_client()
report["baseline_ref"] = client.state.baseline_ref if client else None
report["queue_depth"] = client.queue_depth if client else None
report["receipts"] = [dict(r) for r in (client.state.recent_receipts if client else [])]
report["assurances"] = [r.to_dict() for r in _state.assurances()]
report["last_error"] = _state.get().last_error
emit()
