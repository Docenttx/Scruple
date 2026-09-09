"""WO-E5 — a bridge-shaped addon, and NOTHING ELSE.

⚑ THIS IS A CONTROL. It is not one of the eleven bridges in
`/data/scruple-blender/docs/canon/blender-l2/09-BLENDER-COMFYUI-RUNTIME.md`, it
is not a fork of one, and it generates nothing. What it has in common with all
eleven is the only thing the measurement under test looks at: **a ComfyUI
address kept in the addon's own preferences.**

It exists so that `scripts/e5-blender-probe.py` and `app/ipc-blender.js` can be
shown answering `at-the-gate`, `elsewhere` and `none` on three real Blender
profiles. A reading that can only ever come back one way is not a reading, and
on a box where no bridge is installed `none` is the only answer available.

Pointing a REAL bridge at the gate is WO-E6, and this addon is not a step
toward it.

The address is read from a JSON file beside the profile's config at register
time, because the thing arranging this control has to be able to write an
address the gate only chooses at launch (the gate binds port 0). A real bridge
would have it typed into its preferences by a user, which is the same string in
the same property.
"""

import json
import os

import bpy

bl_info = {
    "name": "E5 stub bridge",
    "blender": (4, 2, 0),
    "category": "Pipeline",
    "description": "WO-E5 control: a bridge-shaped addon that keeps a ComfyUI address",
}

DEFAULT_ADDRESS = "http://127.0.0.1:8188"
CONFIG_NAME = "e5-stub-bridge.json"


def _configured_address():
    """The address this "bridge" is pointed at. Missing file, unreadable file
    and empty value all fall back to ComfyUI's own default — which is what a
    freshly installed bridge really is pointed at, and is NOT the gate."""
    try:
        path = os.path.join(bpy.utils.user_resource("CONFIG"), CONFIG_NAME)
        with open(path, encoding="utf-8") as f:
            value = json.load(f).get("server_address")
        return value if isinstance(value, str) and value.strip() else DEFAULT_ADDRESS
    except Exception:  # noqa: BLE001
        return DEFAULT_ADDRESS


class E5StubBridgePreferences(bpy.types.AddonPreferences):
    bl_idname = __package__ or __name__

    # The property the probe finds. Named the way the real ones are named
    # (`server_address`, `comfy_url`, `server_ip`…), because that naming is the
    # shape the probe recognises.
    # ⚑ The default is READ AT IMPORT, which is enable time, so the address is
    # whatever the file said when this Blender started. Setting it inside
    # `register()` instead would mean a failure there left the property at
    # ComfyUI's default silently — and "the control could not be armed" would
    # be indistinguishable from "the bridge points elsewhere", which is the one
    # confusion this whole control exists to prevent.
    server_address: bpy.props.StringProperty(
        name="ComfyUI server address",
        default=_configured_address(),
    )

    def draw(self, _context):
        self.layout.prop(self, "server_address")


def register():
    bpy.utils.register_class(E5StubBridgePreferences)


def unregister():
    bpy.utils.unregister_class(E5StubBridgePreferences)
