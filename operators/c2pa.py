"""Local Lock operator — permanent local finalize with a user receipt.

This operator was labelled "C2PA sign" and reported "C2PA signed." on
success. It has never signed anything: submit_lock calls
client.lock_local(), which is Standard §9.4 (finalize + user receipt),
not §9.1 (C2PA content credentials). The paid action itself is real and
works; only the name was wrong.

Renaming rather than disabling, because a local lock is a genuine
modality a user may want. Real C2PA signing arrives with the canon
client SDK, at which point this file gains a sibling that actually calls
the signer.

The bl_idname stays `scruple.c2pa_sign` for now — changing it breaks
saved keymaps and the smoke test, and that rename rides along with the
SDK migration. The identifier is internal; nothing a user reads says
C2PA any more.
"""

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
        bl_label = "Local Lock"
        bl_description = "Paid. Permanent local finalize with a user receipt (Standard \u00a79.4). Does not attach a C2PA content credential."

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
                self.report({"ERROR"}, result.error or "Local lock failed.")
                return {"CANCELLED"}
            scr = (result.lock_response or {}).get("scrId") or ""
            self.report({"INFO"}, f"Locked locally. scr={scr[:12]}...")
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
