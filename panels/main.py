"""N-panel in the 3D Viewport sidebar."""

from __future__ import annotations

try:
    import bpy
except ImportError:
    bpy = None

from lib import payment as _payment
from lib import preferences as _prefs
from lib import scruple_client as _client_mod
from lib import state as _state


PANEL_LABEL = "Scruple"
CATEGORY = "Scruple"


def _pm_summary_or_none() -> str:
    st = _state.get()
    return st.payment_method_summary or ""


def _load_stripe_config_once():
    """Grab a fresh payment-method summary once per panel draw, best-effort.

    Runs in the UI thread; failures leave the cached value alone.
    """
    client = _client_mod.from_preferences()
    if client is None:
        return
    try:
        cfg = client.get_payment_methods()
    except Exception:
        return
    _state.get().payment_method_summary = _payment.payment_method_summary(cfg)


if bpy is not None:

    class SCRUPLE_PT_main(bpy.types.Panel):
        bl_space_type = "VIEW_3D"
        bl_region_type = "UI"
        bl_category = CATEGORY
        bl_label = PANEL_LABEL

        def draw(self, context):
            layout = self.layout
            st = _state.get()
            signed_in = _prefs.is_authed()

            if not signed_in:
                box = layout.box()
                box.label(text="Not signed in", icon="ERROR")
                box.operator("scruple.sign_in", text="Sign in", icon="URL")
                return

            box = layout.box()
            row = box.row()
            proj_name = st.active_project_name or "(no active project)"
            row.label(text=proj_name, icon="OUTLINER_COLLECTION")
            row = box.row()
            row.label(text=f"Status: {st.active_project_status or 'unlocked'}")
            if st.active_project_id:
                row.operator(
                    "scruple.open_receipt", text="Open receipt", icon="URL"
                ).project_id = st.active_project_id

            layout.separator()

            layout.operator("scruple.witness_now", text="Witness Now", icon="RESTRICT_RENDER_OFF")
            layout.operator("scruple.witness_export", text="Witness an export...", icon="EXPORT")

            pm = _pm_summary_or_none()
            payment_ready = bool(pm)

            box = layout.box()
            box.label(text="Paid actions", icon="FUND")

            if not payment_ready:
                box.label(text="No payment method on file", icon="ERROR")
                box.operator(
                    "scruple.setup_payment",
                    text="Set up payment on scruple.ai",
                    icon="URL",
                )
            else:
                box.label(text=f"Card: {pm}", icon="CHECKMARK")
                box.operator(
                    "scruple.checkpoint",
                    text=self._button_label("Checkpoint", _payment.ACTION_CHECKPOINT),
                )
                box.operator(
                    "scruple.c2pa_sign",
                    # Calls lock_local(), not the C2PA signer — see operators/c2pa.py.
                    text=self._button_label("Local Lock", _payment.ACTION_C2PA),
                )
                op = box.operator(
                    "scruple.chain_lock",
                    text=self._button_label("Chain-lock", _payment.ACTION_CHAIN_PINNED),
                )
                op.tier = "pinned"

            if st.recent_receipts:
                layout.separator()
                box = layout.box()
                box.label(text="Recent receipts", icon="TEXT")
                for r in list(st.recent_receipts):
                    row = box.row()
                    tag = r.get("kind") or "receipt"
                    label = r.get("scr_id") or r.get("leaf_hash") or "-"
                    row.label(text=f"{tag}: {label[:16]}...")
                    pid = r.get("project_id") or 0
                    if pid:
                        row.operator(
                            "scruple.open_receipt", text="", icon="URL",
                        ).project_id = pid

            if st.last_error:
                layout.separator()
                box = layout.box()
                box.label(text="Last error", icon="ERROR")
                box.label(text=st.last_error[:200])

        def _button_label(self, base: str, action: str) -> str:
            price = _payment.price_cents_for(action)
            return f"{base}  {_payment.format_price(price)}"

    class SCRUPLE_PT_refresh_config(bpy.types.Operator):
        bl_idname = "scruple.refresh_config"
        bl_label = "Refresh payment info"
        bl_description = "Re-read the payment method summary from scruple.ai"

        def execute(self, context):
            _load_stripe_config_once()
            return {"FINISHED"}

    _CLASSES = (SCRUPLE_PT_main, SCRUPLE_PT_refresh_config)

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
