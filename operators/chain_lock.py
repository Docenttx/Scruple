"""Chain-lock operator -- paid public anchor.

v2: `POST /api/v2/mark` with `modalities: ["chain"]` and a `chain_tier`
(gap.json, endpoints row 10: "replaced"). Two tiers, basic and pinned;
the exact cents come back from stripe/config so the confirm dialog is
always truthful.

`mark()` checks the requested modality against GET /api/v2/capabilities
BEFORE sending anything, and refuses rather than downgrading -- so a
server that cannot chain-anchor produces a ModalityUnavailableError
here, not a charge followed by a silent local lock.
"""

from __future__ import annotations

try:
    import bpy
except ImportError:
    bpy = None

from adapter import flow as _wf
from adapter import locks as _locks
from adapter import sdk as _sdk
from adapter import state as _state
from operators.c2pa import NO_LEAF_REASON, mark_report

from scruple_host_sdk import payment as _payment
from scruple_host_sdk.errors import ModalityUnavailableError


if bpy is not None:

    TIER_ITEMS = [
        ("basic", "Basic ($50)", "RVN anchor"),
        ("pinned", "Pinned ($65)", "RVN anchor + IPFS + Arweave"),
    ]

    class SCRUPLE_OT_chain_lock(bpy.types.Operator):
        bl_idname = "scruple.chain_lock"
        bl_label = "Chain-lock"
        bl_description = "Paid public anchor. Choose basic or pinned tier."

        tier: bpy.props.EnumProperty(
            name="Tier",
            items=TIER_ITEMS,
            default="pinned",
        )

        def _action(self) -> str:
            return _payment.ACTION_CHAIN_PINNED if self.tier == "pinned" else _payment.ACTION_CHAIN_BASIC

        def invoke(self, context, event):
            client = _sdk.get_client()
            if client is None:
                self.report({"ERROR"}, "Not signed in.")
                return {"CANCELLED"}
            self._config = _payment.get_payment_config(client)
            action = self._action()
            price = _payment.price_cents_for(action, self._config)
            pm = _payment.payment_method_summary(self._config)
            self._message = _payment.build_confirm_message(action, price, pm)
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
                action=self._action(),
                confirm=lambda _m: True,
            )
            if not result.ok:
                _state.set_error(result.error)
                self.report({"ERROR"}, result.error or "Chain-lock failed.")
                return {"CANCELLED"}

            try:
                outcome = _wf.mark_chain(
                    client,
                    leaf_id=st.last_leaf_id,
                    mime=st.last_leaf_mime or "application/octet-stream",
                    tier=self.tier,
                    payment_intent_id=result.payment_intent_id,
                )
            except ModalityUnavailableError as e:
                # Fail closed: the chain modality was refused before the
                # request went out. The charge above already happened, so
                # say so rather than reporting a bare refusal.
                msg = f"Chain-lock refused: {e}. PaymentIntent {result.payment_intent_id} was created -- reconcile on scruple.ai."
                _state.set_error(msg)
                self.report({"ERROR"}, msg)
                return {"CANCELLED"}

            _state.record_mark(_locks.from_outcome(outcome))
            level, message = mark_report(outcome, f"Chain-lock ({self.tier})")
            if outcome.error or outcome.queued:
                _state.set_error(message)
            self.report(level, message)
            return {"CANCELLED"} if outcome.error else {"FINISHED"}

    _CLASSES = (SCRUPLE_OT_chain_lock,)

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
