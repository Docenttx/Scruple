"""Chain-lock operator — paid public anchor.

Two tiers: 'basic' ($50) and 'pinned' ($65 + IPFS/Arweave). The Blender
addon exposes 'pinned' as the headline "$100" price the WO documents
because that's what marketing lists; the exact cents come back from
stripe/config so the confirm dialog is always truthful.
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

    TIER_ITEMS = [
        ("basic", "Basic ($50)", "RVN testnet anchor"),
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

        def invoke(self, context, event):
            client = _client_mod.from_preferences()
            if client is None:
                self.report({"ERROR"}, "Not signed in.")
                return {"CANCELLED"}
            try:
                self._config = client.get_payment_methods()
            except Exception:
                self._config = {}
            action = _payment.ACTION_CHAIN_PINNED if self.tier == "pinned" else _payment.ACTION_CHAIN_BASIC
            price = _payment.price_cents_for(action, self._config)
            pm = _payment.payment_method_summary(self._config)
            self._message = _payment.build_confirm_message(action, price, pm)
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
            action = _payment.ACTION_CHAIN_PINNED if self.tier == "pinned" else _payment.ACTION_CHAIN_BASIC
            tier = self.tier
            result = _paid.run_paid_action(
                client,
                action=action,
                project_id=pid,
                submit_lock=lambda c, p, pi: c.lock_chain(p, pi, tier=tier),
                confirm=lambda _m: True,
                config=getattr(self, "_config", None),
            )
            if not result.ok:
                if result.cancelled:
                    return {"CANCELLED"}
                self.report({"ERROR"}, result.error or "Chain-lock failed.")
                return {"CANCELLED"}
            scr = (result.lock_response or {}).get("scrId") or ""
            tx = (result.lock_response or {}).get("proofTxId") or ""
            self.report({"INFO"}, f"Chain-locked. scr={scr[:12]}... tx={tx[:12]}...")
            return {"FINISHED"}

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
