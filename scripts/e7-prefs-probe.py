"""Run INSIDE Blender: does the Scruple add-on's own Settings UI bind?

    blender --background --python scripts/e7-prefs-probe.py -- [--enable MODULE]

⚑ FINDING E7-2. `bpy.types.AddonPreferences` is matched to an add-on by
`bl_idname == the module name Blender enabled it under`. The add-on hardcodes
`bl_idname = "scruple_blender"`, which is the module name on the LEGACY
scripts/addons path. Through `blender_manifest.toml` — the path every 4.2+ user
gets, and the one WO-E3 made work — the module is
`bl_ext.user_default.scruple_blender`, the two strings do not match, and
`addons[module].preferences` is None.

This probe reports, and asserts nothing: the gate compares the two install
paths. What it prints is read out of the running Blender.
"""
import json
import sys

import bpy

MARK_OPEN = "<<<E7_PREFS"
MARK_CLOSE = "E7_PREFS>>>"


def argv():
    args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    out = {}
    i = 0
    while i < len(args):
        out[args[i].lstrip("-")] = args[i + 1]
        i += 2
    return out


a = argv()
if a.get("enable"):
    import addon_utils
    addon_utils.enable(a["enable"], default_set=True, persistent=True)

report = {"blender_version": ".".join(str(x) for x in bpy.app.version), "enabled": []}
for entry in bpy.context.preferences.addons:
    if not entry.module.endswith("scruple_blender"):
        continue
    p = getattr(entry, "preferences", None)
    report["enabled"].append({
        "module": entry.module,
        "install_path": "manifest" if entry.module.startswith("bl_ext.") else "legacy",
        "preferences_bound": p is not None,
        "preferences_type": type(p).__name__ if p is not None else None,
        "api_key_settable": hasattr(p, "api_key"),
        "base_url_settable": hasattr(p, "base_url"),
    })

try:
    from adapter import preferences as prefs
    report["bl_idname"] = prefs.ScrupleAddonPreferences.bl_idname
    report["adapter_sees_prefs_object"] = prefs._addon_prefs() is not None
    # ⚑ WHAT A USER WITH NO WAY TO SET IT GETS. With no prefs object and no
    # cached sign-in, `get_base_url()` falls through to the SDK's default.
    report["base_url_with_no_prefs_and_no_cache"] = prefs.get_base_url()
except Exception as e:
    report["adapter_error"] = repr(e)

sys.stdout.write("\n" + MARK_OPEN + "\n" + json.dumps(report, indent=1) + "\n" + MARK_CLOSE + "\n")
