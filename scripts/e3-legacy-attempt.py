"""WO-E3 control — offer the SAME shipped zip to a Blender that predates the
Extensions system, and record what happens.

3.0.1 has no `bpy.ops.extensions`, so the manifest path does not exist there at
all; the only thing a 3.x user can do with this archive is the classic addon
install, which reads `bl_info`. This script does exactly that and reports the
outcome as a return value.

    blender --background --python scripts/e3-legacy-attempt.py -- <zip>
"""
import json
import os
import sys
import traceback

import bpy
import addon_utils

ZIP = sys.argv[sys.argv.index("--") + 1]
MODULE = "scruple_blender"

out = {
    "blender_version": bpy.app.version_string,
    "blender_version_tuple": list(bpy.app.version),
    # NOT hasattr(bpy.ops, ...): bpy.ops.__getattr__ answers True for any
    # name it has never heard of. dir() is the only honest question.
    "has_extensions_op": "extensions" in dir(bpy.ops),
    "has_extensions_prefs": hasattr(bpy.context.preferences, "extensions"),
    "zip": ZIP,
}

try:
    r = bpy.ops.preferences.addon_install(filepath=ZIP, overwrite=True)
    out["install_result"] = sorted(r)
except Exception:
    out["install_result"] = None
    out["install_error"] = traceback.format_exc(limit=2).strip().splitlines()[-1]

addon_utils.modules_refresh()
found = [m for m in addon_utils.modules() if m.__name__ == MODULE]
out["module_found_after_install"] = bool(found)
if found:
    info = addon_utils.module_bl_info(found[0])
    # A 3.x Blender can only have read bl_info: `blender` is (3, 6, 0) there and
    # (4, 2, 0) in blender_manifest.toml. Whichever comes back names the file.
    out["reported"] = {
        "name": info.get("name"),
        "version": list(info.get("version") or []),
        "description": info.get("description"),
        "blender": list(info.get("blender") or []),
    }
    out["version_floor_above_host"] = tuple(info.get("blender") or ()) > tuple(bpy.app.version)

try:
    addon_utils.enable(MODULE, default_set=True, persistent=True)
    out["enable_raised"] = None
except Exception:
    out["enable_raised"] = traceback.format_exc(limit=3).strip().splitlines()[-1]

out["enabled_addons"] = sorted(a.module for a in bpy.context.preferences.addons)
out["is_enabled"] = MODULE in out["enabled_addons"]
out["panels_registered"] = sorted(
    n for n in dir(bpy.types) if n.startswith("SCRUPLE_PT_"))
out["loaded_via_manifest"] = False  # impossible on a Blender with no manifest reader

print("<<<E3_PROBE")
print(json.dumps(out, indent=2, sort_keys=True))
print("E3_PROBE>>>")
