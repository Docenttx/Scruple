"""Manual re-witness of the current output.

Free action — no payment gate. Useful when the ambient handler was
disabled or the user wants an explicit leaf pinned to a beat.
"""

from __future__ import annotations

try:
    import bpy
except ImportError:
    bpy = None

from lib import scruple_client as _client_mod
from lib import witness_flow as _wf
from lib import state as _state


if bpy is not None:

    class SCRUPLE_OT_witness_now(bpy.types.Operator):
        bl_idname = "scruple.witness_now"
        bl_label = "Witness now"
        bl_description = "Re-hash the current render output and post it as a Scruple leaf"

        def execute(self, context):
            client = _client_mod.from_preferences()
            if client is None:
                self.report({"ERROR"}, "Not signed in. Open Add-on Preferences to sign in.")
                return {"CANCELLED"}
            try:
                resp = _wf.witness_render(client, context.scene, trigger="manual")
            except Exception as e:
                _state.get().last_error = str(e)
                self.report({"ERROR"}, f"Witness failed: {e}")
                return {"CANCELLED"}
            if resp is None:
                self.report({"WARNING"}, "No render output on disk yet; render first.")
                return {"CANCELLED"}
            leaf = resp.get("leafHash") or resp.get("leaf_hash") or ""
            self.report({"INFO"}, f"Witnessed. leaf={leaf[:12]}...")
            return {"FINISHED"}

    _CLASSES = (SCRUPLE_OT_witness_now,)

    def register():
        for cls in _CLASSES:
            bpy.utils.register_class(cls)

    def unregister():
        for cls in reversed(_CLASSES):
            try:
                bpy.utils.unregister_class(cls)
            except Exception:
                pass

else:

    def register():
        pass

    def unregister():
        pass
