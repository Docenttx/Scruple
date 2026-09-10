# Does the addon bind its preferences on the path it actually ships on, and
# does an unconfigured install point at production?
#
# This is finding E7-2 / WO-F1, checked on a REAL manifest install in a real
# Blender rather than in a unit test with a mocked bpy. The unit tests use
# tests/mocks/bpy_mock.py; the whole defect was that the real module name
# differs from the hardcoded one, which a mock cannot reproduce.
#
# Run:  blender --background --python scripts/win/addon-binding-probe.py
# with BLENDER_USER_RESOURCES pointing at the profile the addon is installed in.

import json
import sys

import addon_utils
import bpy

out = {}

# 1. What does Blender call this addon? The legacy name is "scruple_blender";
#    on the extensions path it is "bl_ext.<repo>.<id>".
modules = [m.__name__ for m in addon_utils.modules() if "scruple" in m.__name__]
out["modules_seen"] = modules

target = None
for name in modules:
    if name.endswith("scruple_blender"):
        target = name
        break
out["module_name"] = target

if target is None:
    out["error"] = "the addon is not visible to addon_utils at all"
    print("<<<PROBE" + json.dumps(out) + "PROBE>>>")
    sys.exit(0)

# 2. Enable it, the way a user clicking the checkbox does.
try:
    bpy.ops.preferences.addon_enable(module=target)
    out["enabled"] = True
except Exception as exc:  # noqa: BLE001
    out["enabled"] = False
    out["enable_error"] = f"{type(exc).__name__}: {exc}"

# 3. THE BINDING. This is what E7-2 was about: `bl_idname` had to equal the
#    module name Blender actually used, or `addons.get(...)` returns None and
#    every preference silently reads as absent.
prefs_entry = bpy.context.preferences.addons.get(target)
out["preferences_object_bound"] = prefs_entry is not None
if prefs_entry is not None:
    p = getattr(prefs_entry, "preferences", None)
    out["preferences_attr_present"] = p is not None
    if p is not None:
        out["base_url_field_exists"] = hasattr(p, "base_url")
        out["base_url_value"] = repr(getattr(p, "base_url", None))
        out["api_key_field_exists"] = hasattr(p, "api_key")

# 4. What the addon's own resolver says with nothing configured. The whole
#    hazard was that this returned https://scruple.ai.
try:
    mod = sys.modules.get(target)
    prefs_mod = getattr(mod, "preferences", None)
    if prefs_mod is None:
        import importlib
        prefs_mod = importlib.import_module(target + ".adapter.preferences")
    out["get_base_url"] = repr(prefs_mod.get_base_url())
    out["is_configured"] = bool(prefs_mod.is_configured())
    out["bl_idname_resolved_to"] = getattr(
        getattr(prefs_mod, "ScrupleAddonPreferences", None), "bl_idname", None
    )
except Exception as exc:  # noqa: BLE001
    out["resolver_error"] = f"{type(exc).__name__}: {exc}"

print("<<<PROBE" + json.dumps(out) + "PROBE>>>")
