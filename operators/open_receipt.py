"""Open a project's receipt page on scruple.ai."""

from __future__ import annotations

import webbrowser

try:
    import bpy
except ImportError:
    bpy = None

from lib import preferences as _prefs
from lib import state as _state


if bpy is not None:

    class SCRUPLE_OT_open_receipt(bpy.types.Operator):
        bl_idname = "scruple.open_receipt"
        bl_label = "Open receipt"
        bl_description = "Open this project's receipt page on scruple.ai"

        project_id: bpy.props.IntProperty(default=0)

        def execute(self, context):
            pid = int(self.project_id or 0)
            if pid <= 0:
                pid = _state.get().active_project_id or 0
            if pid <= 0:
                self.report({"ERROR"}, "No active project.")
                return {"CANCELLED"}
            base = _prefs.get_base_url()
            url = f"{base.rstrip('/')}/projects/{pid}"
            webbrowser.open(url)
            self.report({"INFO"}, f"Opened {url}")
            return {"FINISHED"}

    _CLASSES = (SCRUPLE_OT_open_receipt,)

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
