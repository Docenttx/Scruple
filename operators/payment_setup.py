"""Open scruple.ai/settings/payment in the system browser."""

from __future__ import annotations

import webbrowser

try:
    import bpy
except ImportError:
    bpy = None

from adapter import preferences as _prefs


if bpy is not None:

    class SCRUPLE_OT_setup_payment(bpy.types.Operator):
        bl_idname = "scruple.setup_payment"
        bl_label = "Set up payment on scruple.ai"
        bl_description = "Open the scruple.ai payment settings page in your browser"

        def execute(self, context):
            base = _prefs.get_base_url()
            url = base.rstrip("/") + "/settings/payment"
            webbrowser.open(url)
            self.report({"INFO"}, f"Opened {url}")
            return {"FINISHED"}

    _CLASSES = (SCRUPLE_OT_setup_payment,)

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
