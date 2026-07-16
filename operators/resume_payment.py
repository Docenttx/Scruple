"""Resume a paid operator after a 3DS challenge finishes in the browser.

The user's flow:
  1. Paid op invoked; Stripe returned requires_action.
  2. Addon reported the pi_... and opened scruple.ai/pay/<pi> for 3DS.
  3. User confirms in the browser. scruple.ai fires
     scruple://payment-complete?pi=... via the registered URL scheme.
  4. Blender receives the deep link; the resume operator picks it up
     with the pi_id, project_id, and action, then hits the lock
     endpoint.

Wiring the OS scheme registration is install-time work (macOS Info.plist,
Windows registry, Linux xdg-mime); until that lands the user can invoke
this operator manually, pasting the pi_... into the prompt.
"""

from __future__ import annotations

try:
    import bpy
except ImportError:
    bpy = None

from lib import payment as _payment
from lib import scruple_client as _client_mod
from lib import state as _state


if bpy is not None:

    ACTION_ITEMS = [
        (_payment.ACTION_CHECKPOINT, "Checkpoint", "Soft-lock"),
        (_payment.ACTION_C2PA, "C2PA sign", "Permanent local finalize"),
        (_payment.ACTION_CHAIN_BASIC, "Chain-lock basic", "RVN anchor only"),
        (_payment.ACTION_CHAIN_PINNED, "Chain-lock pinned", "RVN + IPFS + Arweave"),
    ]

    class SCRUPLE_OT_resume_payment(bpy.types.Operator):
        bl_idname = "scruple.resume_payment"
        bl_label = "Resume payment"
        bl_description = "Complete a paid action after finishing 3DS verification in the browser"

        payment_intent_id: bpy.props.StringProperty(name="PaymentIntent ID")
        project_id: bpy.props.IntProperty(name="Project ID", default=0)
        action: bpy.props.EnumProperty(name="Action", items=ACTION_ITEMS, default=_payment.ACTION_CHECKPOINT)

        def invoke(self, context, event):
            return context.window_manager.invoke_props_dialog(self)

        def draw(self, context):
            layout = self.layout
            layout.prop(self, "payment_intent_id")
            layout.prop(self, "project_id")
            layout.prop(self, "action")

        def execute(self, context):
            client = _client_mod.from_preferences()
            if client is None:
                self.report({"ERROR"}, "Not signed in.")
                return {"CANCELLED"}
            pid = int(self.project_id) or (_state.get().active_project_id or 0)
            if pid <= 0:
                self.report({"ERROR"}, "No project id.")
                return {"CANCELLED"}
            pi = self.payment_intent_id.strip()
            if not pi.startswith("pi_"):
                self.report({"ERROR"}, "Malformed PaymentIntent id.")
                return {"CANCELLED"}
            try:
                resp = client.confirm_payment(pid, pi, action=self.action)
            except _client_mod.ScrupleClientError as e:
                self.report({"ERROR"}, f"Confirm failed: {e}")
                return {"CANCELLED"}
            self.report({"INFO"}, f"Resumed. status={resp.get('status') or 'ok'}")
            return {"FINISHED"}

    _CLASSES = (SCRUPLE_OT_resume_payment,)

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
