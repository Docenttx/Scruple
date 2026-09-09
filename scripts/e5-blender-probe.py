"""WO-E5 — ask the RUNNING Blender the three things the region names.

    blender --background --python scripts/e5-blender-probe.py

Printed as one JSON document between markers, so the caller reads a return
value rather than parsing Blender's chatter. Nothing here reads a pixel and
nothing here reads a log line: every field is a value returned by `bpy` inside
the process that loaded the addon, or `None` with a reason.

⚑ IT MEASURES, IT DOES NOT ARRANGE. This probe enables nothing, installs
nothing and writes nothing. It is run against whatever profile
`BLENDER_USER_RESOURCES` points at, and if the addon is not enabled there it
says so — the app must never be able to make its own dashboard green by
turning the thing on while looking at it.

⚑ AND IT DOES NOT DECIDE. Whether a bridge is pointed AT THE GATE is a
comparison against an address only the app knows (the gate binds port 0 and
reports back), so this reports the addresses it FOUND and the caller does the
comparison. A probe that answered "yes" would be answering a question it has
no way to ask.
"""
import json
import os
import re
import sys

import bpy

MARK_OPEN = "<<<E5_PROBE"
MARK_CLOSE = "E5_PROBE>>>"

OURS = "scruple_blender"

# A bridge is a THIRD-PARTY addon (docs/canon/blender-l2/09-BLENDER-COMFYUI-RUNTIME.md
# found eleven, and we fork none of them), so it is recognised BY SHAPE rather
# than by a name list: an addon that keeps a ComfyUI address in its own
# preferences has a string property named for one. A name list would answer
# "no bridge" for the twelfth.
ADDRESS_PROP = re.compile(r"(url|addr|address|endpoint|server|host|ip)$", re.I)
PORT_PROP = re.compile(r"port$", re.I)
# The value has to look like an address as well as be named like one, so a
# `server_name` holding "my workstation" is not reported as somewhere a
# generation could have gone.
ADDRESS_VALUE = re.compile(r"^(https?://)?[A-Za-z0-9._\-]+(:\d+)?(/.*)?$")


def addon_module():
    for a in bpy.context.preferences.addons:
        if a.module.endswith(OURS):
            return a.module
    return None


def bridge_candidates():
    """Every enabled addon that keeps something address-shaped in its own
    preferences, with the property it keeps it in. Reported, not judged."""
    out = []
    for a in bpy.context.preferences.addons:
        mod = a.module
        if mod.endswith(OURS):
            continue
        try:
            prefs = a.preferences
        except Exception as err:                     # noqa: BLE001
            out.append({"module": mod, "error": f"{type(err).__name__}: {err}"})
            continue
        if prefs is None:
            continue
        addresses, ports = [], []
        try:
            props = prefs.bl_rna.properties
        except Exception as err:                     # noqa: BLE001
            out.append({"module": mod, "error": f"{type(err).__name__}: {err}"})
            continue
        for prop in props:
            ident = prop.identifier
            if ident in ("rna_type",):
                continue
            try:
                value = getattr(prefs, ident)
            except Exception:                        # noqa: BLE001
                continue
            if prop.type == "STRING" and isinstance(value, str) and value.strip():
                if ADDRESS_PROP.search(ident) and ADDRESS_VALUE.match(value.strip()):
                    addresses.append({"prop": ident, "value": value.strip()})
            elif prop.type == "INT" and PORT_PROP.search(ident) and value:
                ports.append({"prop": ident, "value": int(value)})
        if addresses:
            out.append({"module": mod, "addresses": addresses, "ports": ports})
    return out


def main():
    out = {
        "blender_version": bpy.app.version_string,
        "blender_version_tuple": list(bpy.app.version),
        "user_resources_config": bpy.utils.user_resource("CONFIG"),
        "blender_user_resources_env": os.environ.get("BLENDER_USER_RESOURCES"),
        "enabled_addons": sorted(a.module for a in bpy.context.preferences.addons),
    }
    mod = addon_module()
    out["addon_module"] = mod
    out["addon_enabled"] = mod is not None
    # WO-E3's discriminator, kept: on 4.2+ only the manifest path produces a
    # `bl_ext.<repo>.<id>` module name, so this names the file Blender read.
    out["addon_via_manifest"] = bool(mod) and mod.startswith("bl_ext.")
    out["addon_panels"] = sorted(
        n for n in dir(bpy.types) if n.startswith("SCRUPLE_PT_"))
    out["addon_operators"] = sorted(
        k for k in dir(bpy.ops.scruple) if not k.startswith("_")
    ) if hasattr(bpy.ops, "scruple") else []
    out["bridges"] = bridge_candidates()
    print(MARK_OPEN)
    print(json.dumps(out, indent=2, sort_keys=True))
    print(MARK_CLOSE)


try:
    main()
except Exception as err:                             # noqa: BLE001
    # A probe that dies silently is INCONCLUSIVE and would be read as "no
    # addon". It reports its own failure instead, and the caller records
    # `unread` with this reason rather than a value.
    print(MARK_OPEN)
    print(json.dumps({"error": f"{type(err).__name__}: {err}"}))
    print(MARK_CLOSE)
    sys.exit(0)
