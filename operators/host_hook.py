"""Two operators over `adapter/host_hook.py`: declare, and announce.

WO-E4. The module beside this one is where the decisions are; this file is
Blender's way of reaching them -- a registered class with a `bl_idname`, so
the declaration and the announcement can be driven from a keymap, from a
bridge's Python, or from `blender --background --python-expr`, without any
caller importing addon internals.

WHY OPERATORS AND NOT JUST FUNCTIONS

Because `bpy.ops.scruple.host_announce(prompt_id=...)` is the call a
ComfyUI bridge can make from its own add-on code without knowing where
this addon is installed or what its package is called -- which is the
whole point of WO-E6, where a bridge nobody here wrote has to reach this.
An importable function would work only for code that already knows the
module path, and after Blender 4.2 that path is
`bl_ext.user_default.scruple_blender.adapter.host_hook`, which is not a
name a third party should have to hard-code.

NEITHER OPERATOR TOUCHES THE NETWORK, and neither can fail a render.
`declare` returns CANCELLED when there is no host directory -- a
standalone Blender -- and `announce` returns CANCELLED when the scene it
was asked about cannot produce a document its own schema accepts. Both
report why. A CANCELLED announce means the leaf will read `declined`,
which is a true statement about an integration that is not working.
"""

from __future__ import annotations

try:
    import bpy
except ImportError:  # pragma: no cover - exercised only inside Blender
    bpy = None

from adapter import host_hook as _hook
from adapter import log as _log


if bpy is not None:

    class SCRUPLE_OT_host_declare(bpy.types.Operator):
        bl_idname = "scruple.host_declare"
        bl_label = "Declare this Blender to the capture gate"
        bl_description = (
            "Write scruple-host.json where Desktop Studio's capture gate reads "
            "it, after validating the declaration against the SDK's own "
            "register_host(). Does nothing when no gate is configured."
        )

        def execute(self, context):
            result = _hook.declare()
            if not result.get("ok"):
                self.report({"INFO"}, str(result.get("reason", "not declared")))
                return {"CANCELLED"}
            self.report(
                {"INFO"},
                f"declared {result['host']} / {result['adapter']} → {result['wrote']}",
            )
            return {"FINISHED"}

    class SCRUPLE_OT_host_announce(bpy.types.Operator):
        bl_idname = "scruple.host_announce"
        bl_label = "Announce this generation to the capture gate"
        bl_description = (
            "Write the scene facts for one ComfyUI generation, keyed by the "
            "prompt id the bridge will submit under. The gate cannot see a "
            "scene name, a frame or a camera on a wire; this is how they "
            "reach the leaf."
        )

        prompt_id: bpy.props.StringProperty(
            name="Prompt ID",
            description=(
                "ComfyUI's prompt_id for this generation. The bridge mints it "
                "and POSTs /prompt with it; the gate correlates on it"
            ),
            default="",
        )

        def execute(self, context):
            if not self.prompt_id.strip():
                self.report({"WARNING"}, "announce needs the prompt_id it will be submitted under")
                return {"CANCELLED"}
            result = _hook.announce(self.prompt_id.strip(), context.scene)
            if not result.get("ok"):
                why = result.get("problems") or [result.get("reason", "not announced")]
                _log.warn(f"scruple.host_announce declined: {'; '.join(map(str, why))}")
                self.report({"WARNING"}, "; ".join(map(str, why)))
                return {"CANCELLED"}
            self.report(
                {"INFO"},
                f"announced {result['promptId']}: {len(result['evidence'])} fields",
            )
            return {"FINISHED"}

    _CLASSES = (SCRUPLE_OT_host_declare, SCRUPLE_OT_host_announce)

    def register():
        for cls in _CLASSES:
            bpy.utils.register_class(cls)

    def unregister():
        for cls in reversed(_CLASSES):
            bpy.utils.unregister_class(cls)

else:  # pragma: no cover - import-time shim for the headless test suite

    def register():
        return None

    def unregister():
        return None
