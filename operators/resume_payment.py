"""Resume a paid operator after a 3DS challenge finishes in the browser.

The user's flow:
  1. Paid op invoked; Stripe returned requires_action.
  2. Addon reported the pi_... and opened scruple.ai/pay/<pi> for 3DS.
  3. User confirms in the browser. scruple.ai fires
     scruple://payment-complete?pi=... via the registered URL scheme.
  4. Blender receives the deep link; this operator picks it up with the
     pi_id and re-runs the mark that the charge was for.

v1 confirmed through POST /api/stripe/confirm and then re-hit a lock
endpoint. Under v2 the second half is `/api/v2/mark` with the
payment_intent_id attached, so this operator asks for the modality set
directly rather than naming a v1 action.

Wiring the OS scheme registration is install-time work (macOS
Info.plist, Windows registry, Linux xdg-mime); until that lands the user
invokes this operator manually, pasting the pi_... into the prompt.

Worth stating plainly, because the SDK's payment.py says it and this
operator is where a user would meet it: `/api/stripe/*` authenticates
with a browser session cookie, not a bearer key, so a plugin session
gets a 401 there today. This path is wired and unexercisable against the
current server route set.
"""

from __future__ import annotations

try:
    import bpy
except ImportError:
    bpy = None

from adapter import flow as _wf
from adapter import sdk as _sdk
from adapter import state as _state
from operators.c2pa import mark_report


if bpy is not None:

    MODALITY_ITEMS = [
        ("local", "Local Lock", "Finalize with a user receipt (modalities: [])"),
        ("chain-basic", "Chain-lock basic", "RVN anchor"),
        ("chain-pinned", "Chain-lock pinned", "RVN + IPFS + Arweave"),
    ]

    class SCRUPLE_OT_resume_payment(bpy.types.Operator):
        bl_idname = "scruple.resume_payment"
        bl_label = "Resume payment"
        bl_description = "Complete a paid action after finishing 3DS verification in the browser"

        payment_intent_id: bpy.props.StringProperty(name="PaymentIntent ID")
        leaf_id: bpy.props.StringProperty(name="Leaf ID", default="")
        action: bpy.props.EnumProperty(name="Action", items=MODALITY_ITEMS, default="local")

        def invoke(self, context, event):
            return context.window_manager.invoke_props_dialog(self)

        def draw(self, context):
            layout = self.layout
            layout.prop(self, "payment_intent_id")
            layout.prop(self, "leaf_id")
            layout.prop(self, "action")

        def execute(self, context):
            client = _sdk.get_client()
            if client is None:
                self.report({"ERROR"}, "Not signed in.")
                return {"CANCELLED"}
            st = _state.get()
            leaf = (self.leaf_id or "").strip() or (st.last_leaf_id or "")
            if not leaf:
                self.report({"ERROR"}, "No leaf id to mark.")
                return {"CANCELLED"}
            pi = self.payment_intent_id.strip()
            if not pi.startswith("pi_"):
                self.report({"ERROR"}, "Malformed PaymentIntent id.")
                return {"CANCELLED"}

            mime = st.last_leaf_mime or "application/octet-stream"
            try:
                if self.action == "local":
                    outcome = _wf.mark_local(client, leaf_id=leaf, mime=mime, payment_intent_id=pi)
                else:
                    tier = "pinned" if self.action == "chain-pinned" else "basic"
                    outcome = _wf.mark_chain(client, leaf_id=leaf, mime=mime, tier=tier, payment_intent_id=pi)
            except Exception as e:
                self.report({"ERROR"}, f"Resume failed: {e}")
                return {"CANCELLED"}

            level, message = mark_report(outcome, "Resumed")
            self.report(level, message)
            return {"CANCELLED"} if outcome.error else {"FINISHED"}

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
