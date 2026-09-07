"""Local Lock operator -- permanent local finalize with a user receipt.

This operator was labelled "C2PA sign" and reported "C2PA signed." on
success. It has never signed anything: it called /api/lock/local, which
is Standard §9.4 (finalize + user receipt), not §9.1 (C2PA content
credentials). Renaming rather than disabling, because a local lock is a
genuine modality a user may want.

Under v2 it is `POST /api/v2/mark` with `modalities: []` (gap.json,
endpoints row 9: "replaced"). An empty modality list is not "do
nothing" -- a local lock is always performed server-side (D-5, §9.4) --
it is "and no additional modality", which is precisely what
/api/lock/local meant.

WHAT IT MARKS CHANGED. v1 locked a *project*; v2 marks a *leaf*. So the
gate is no longer "is there an active project" but "is there a leaf to
mark", which is the leaf the last witness produced.

The bl_idname stays `scruple.c2pa_sign` so saved keymaps still resolve.
Nothing a user reads says C2PA.
"""

from __future__ import annotations

try:
    import bpy
except ImportError:
    bpy = None

from adapter import flow as _wf
from adapter import sdk as _sdk
from adapter import state as _state

from scruple_host_sdk import payment as _payment


NO_LEAF_REASON = (
    "Nothing to lock yet: /api/v2/mark marks a leaf, so witness a render or a "
    "save first and the lock applies to that leaf."
)


def mark_report(outcome, action_label: str) -> tuple:
    """(level, message) for a MarkOutcome. §9.5: `outstanding` is honest,
    so what did NOT happen is reported alongside what did."""
    applied = ", ".join(outcome.modalities_applied) or "local lock only"
    outstanding = _wf.outstanding_summary(outcome)
    if outcome.queued:
        return ({"WARNING"}, f"{action_label}: server unreachable; queued for retry.")
    if outcome.error:
        return ({"ERROR"}, f"{action_label} failed: {outcome.error}")
    if outstanding:
        return ({"WARNING"}, f"{action_label}: applied {applied}. Outstanding -- {outstanding}")
    return ({"INFO"}, f"{action_label}: applied {applied}.")


if bpy is not None:

    class SCRUPLE_OT_c2pa_sign(bpy.types.Operator):
        bl_idname = "scruple.c2pa_sign"
        bl_label = "Local Lock"
        bl_description = "Paid. Permanent local finalize with a user receipt (Standard §9.4). Does not attach a C2PA content credential."

        def invoke(self, context, event):
            client = _sdk.get_client()
            if client is None:
                self.report({"ERROR"}, "Not signed in.")
                return {"CANCELLED"}
            self._config = _payment.get_payment_config(client)
            price = _payment.price_cents_for(_payment.ACTION_C2PA, self._config)
            pm = _payment.payment_method_summary(self._config)
            self._message = _payment.build_confirm_message(_payment.ACTION_C2PA, price, pm)
            return context.window_manager.invoke_props_dialog(self)

        def draw(self, context):
            self.layout.label(text=self._message)

        def execute(self, context):
            client = _sdk.get_client()
            if client is None:
                self.report({"ERROR"}, "Not signed in.")
                return {"CANCELLED"}
            st = _state.get()
            if not st.last_leaf_id:
                _state.set_error(NO_LEAF_REASON)
                self.report({"ERROR"}, NO_LEAF_REASON)
                return {"CANCELLED"}

            result = client.charge(
                project_id=st.active_project_id or 0,
                action=_payment.ACTION_C2PA,
                confirm=lambda _m: True,
            )
            if not result.ok:
                _state.set_error(result.error)
                self.report({"ERROR"}, result.error or "Local lock failed.")
                return {"CANCELLED"}

            outcome = _wf.mark_local(
                client,
                leaf_id=st.last_leaf_id,
                mime=st.last_leaf_mime or "application/octet-stream",
                payment_intent_id=result.payment_intent_id,
            )
            level, message = mark_report(outcome, "Local lock")
            if outcome.error or outcome.queued:
                _state.set_error(message)
            self.report(level, message)
            return {"CANCELLED"} if outcome.error else {"FINISHED"}

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
