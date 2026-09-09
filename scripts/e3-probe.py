"""WO-E3 — ask the RUNNING Blender what it loaded. Never the file we shipped.

Printed as one JSON document between markers so a shell can read it without
parsing Blender's chatter. Nothing here reads a pixel and nothing reads a log
line: every field is a return value from bpy/addon_utils inside the process
that has the addon loaded.

    blender --background --python scripts/e3-probe.py -- <module-hint>
"""
import json
import os
import sys

import bpy
import addon_utils

HINT = "scruple_blender"
if "--" in sys.argv:
    rest = sys.argv[sys.argv.index("--") + 1:]
    if rest:
        HINT = rest[0]

out = {
    "blender_version": bpy.app.version_string,
    "blender_version_tuple": list(bpy.app.version),
    # 4.2's extension system exists at all — a 3.x Blender has neither.
    "has_extensions_system": hasattr(bpy.context.preferences, "extensions"),
    "user_resources_config": bpy.utils.user_resource("CONFIG"),
    "enabled_addons": sorted(a.module for a in bpy.context.preferences.addons),
}

# Which module is ours, as the running Blender names it. An extension loaded
# through blender_manifest.toml is `bl_ext.<repo>.<id>`; a legacy addon loaded
# through bl_info is the bare id. The prefix is the whole difference.
mods = [m for m in out["enabled_addons"] if m.endswith(HINT)]
out["matched_module"] = mods[0] if mods else None
out["loaded_via_manifest"] = bool(mods) and mods[0].startswith("bl_ext.")

if mods:
    mod = sys.modules.get(mods[0])
    out["module_file"] = getattr(mod, "__file__", None)
    info = addon_utils.module_bl_info(mod) if mod else None
    if info:
        # ⚑ THE DISCRIMINATOR. On 4.2 Blender synthesises this dict from
        # blender_manifest.toml for an extension and takes `description` from
        # the manifest's `tagline`. The addon's own bl_info["description"] is a
        # DIFFERENT, longer sentence. Whichever string comes back names the
        # file Blender actually read.
        out["reported"] = {
            "name": info.get("name"),
            "version": list(info.get("version") or []),
            "description": info.get("description"),
            "blender": list(info.get("blender") or []),
            "category": info.get("category"),
        }
    # The extension repo it is installed in, and the manifest on disk there.
    if hasattr(bpy.context.preferences, "extensions"):
        for repo in bpy.context.preferences.extensions.repos:
            d = repo.directory
            if d and os.path.isdir(os.path.join(d, HINT)):
                out["repo_module"] = repo.module
                out["repo_directory"] = d
                out["manifest_on_disk"] = os.path.isfile(
                    os.path.join(d, HINT, "blender_manifest.toml"))

# Registered classes, asked of bpy.types rather than read out of our source.
out["panels_registered"] = sorted(
    n for n in dir(bpy.types)
    if n.startswith("SCRUPLE_PT_") and hasattr(bpy.types, n))
out["operators_registered"] = sorted(
    k for k in dir(bpy.ops.scruple) if not k.startswith("_")
) if hasattr(bpy.ops, "scruple") else []

# The legacy path must be empty: an addon that arrived through bl_info would
# be unpacked under scripts/addons/, not under extensions/.
legacy = os.path.join(bpy.utils.user_resource("SCRIPTS"), "addons", HINT)
out["legacy_addons_dir"] = legacy
out["legacy_addons_dir_exists"] = os.path.isdir(legacy)

print("<<<E3_PROBE")
print(json.dumps(out, indent=2, sort_keys=True))
print("E3_PROBE>>>")
