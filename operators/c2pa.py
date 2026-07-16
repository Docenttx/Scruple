"""C2PA sign operator — permanent local finalize with a C2PA sidecar."""

from __future__ import annotations

try:
    import bpy
except ImportError:
    bpy = None

from lib import paid_action as _paid
from lib import payment as _payment
from lib import scruple_client as _client_mod
from lib import state as _state


if bpy is not None:

    class SCRUPLE_OT_c2pa_sign(bpy.types.Operator):
        bl_idname = "scruple.c2pa_sign"
        bl_label = "C2PA sign"
        bl_description = "Paid. Permanent local finalize with a C2PA-signed export."

        def invoke(self, context, event):
            client = _client_mod.from_preferences()
            if client is None:
                self.report({"ERROR"}, "Not signed in.")
                return {"CANCELLED"}
            try:
                self._config = client.get_payment_methods()
            except Exception:
                self._config = {}
            price = _payment.price_cents_for(_payment.ACTION_C2PA, self._config)
            pm = _payment.payment_method_summary(self._config)
            self._message = _payment.build_confirm_message(
                _payment.ACTION_C2PA, price, pm,
            )
            return context.window_manager.invoke_props_dialog(self)

        def draw(self, context):
            self.layout.label(text=self._message)

        def execute(self, context):
            client = _client_mod.from_preferences()
            if client is None:
                self.report({"ERROR"}, "Not signed in.")
                return {"CANCELLED"}
            pid = _state.get().active_project_id or 0
            if pid <= 0:
                self.report({"ERROR"}, "No active project. Render or save first.")
                return {"CANCELLED"}
            result = _paid.run_paid_action(
                client,
                action=_payment.ACTION_C2PA,
                project_id=pid,
                submit_lock=lambda c, p, pi: c.lock_local(p, pi),
                confirm=lambda _m: True,
                config=getattr(self, "_config", None),
            )
            if not result.ok:
                if result.cancelled:
                    return {"CANCELLED"}
                self.report({"ERROR"}, result.error or "C2PA sign failed.")
                return {"CANCELLED"}
            scr = (result.lock_response or {}).get("scrId") or ""
            self.report({"INFO"}, f"C2PA signed. scr={scr[:12]}...")
            return {"FINISHED"}

    _CLASSES = (SCRUPLE_OT_c2pa_sign,)

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
