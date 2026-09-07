"""N-panel in the 3D Viewport sidebar.

WO-B2 repoints this at the SDK and changes nothing else structurally --
it is still a sign-in gate, a header, the paid buttons and a receipt
list. WO-B5 is the one that rebuilds it as the project manager /
tracker / lock dashboard that Studio and the Fusion palette are.

Two things did have to change, because the data underneath them did:

  * the receipt list now reads `SessionState.recent_receipts`, which the
    SDK writes in `Client.witness_file()`. Its rows carry
    `content_hash`, `leaf_id`, `witnessed` and `queued` -- so the list
    can say whether each capture was witnessed, rather than showing a
    leaf hash and implying it.
  * a queue depth is shown when anything is spooled. The addon has had
    an offline queue since day one and has never had a way to tell the
    user something was in it.
"""

from __future__ import annotations

try:
    import bpy
except ImportError:
    bpy = None

from adapter import assurance as _assurance
from adapter import preferences as _prefs
from adapter import sdk as _sdk
from adapter import state as _state

from scruple_host_sdk import payment as _payment


PANEL_LABEL = "Scruple"
CATEGORY = "Scruple"


def _load_stripe_config_once():
    """Grab a fresh payment-method summary, best-effort. Runs in the UI
    thread on an explicit button press -- never in draw(), which Blender
    calls on every redraw."""
    client = _sdk.get_client()
    if client is None:
        return
    cfg = _payment.get_payment_config(client)
    _state.get().payment_method_summary = _payment.payment_method_summary(cfg)


def assurance_line(rec) -> str:
    """One tracker row: what state the capture is in and what its
    evidence actually amounts to.

    WO-B3. The old row could say "witnessed" and nothing else, so a leaf
    nobody can verify and a leaf signed in an HSM rendered identically.
    The tier here is `LeafAssurance.assurance_tier`, which is
    `undisclosed` on every leaf today because the server sends no
    signature field -- and `undisclosed` is the honest word for that.
    """
    label = (rec.leaf_id or rec.content_hash or rec.filename or "-")[:16]
    if rec.state == _assurance.WITNESSED:
        return f"{label}  [witnessed · {rec.assurance_tier}]"
    return f"{label}  [{rec.state.replace('_', ' ')}]"


def receipt_line(r: dict) -> str:
    """One receipt row, with its state said out loud. `witnessed` is a
    field on the row because it is a field in the server's response
    (D-8); it is not inferred from the leaf id being present."""
    label = (r.get("leaf_id") or r.get("content_hash") or "-")[:16]
    if r.get("queued"):
        state = "queued"
    elif r.get("witnessed"):
        state = "witnessed"
    else:
        state = "not witnessed"
    return f"{label}  [{state}]"


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

            # WO-B4. The store-and-forward surface: what is spooled, and
            # what the last settlement found. Both are drawn only when
            # there is something to say -- an addon with an empty queue
            # and no settlement draws neither box, which is what makes the
            # boxes mean something when they do appear.
            depth = _state.queue_depth()
            if depth:
                box = layout.box()
                box.label(text=f"{depth} capture(s) queued offline", icon="SORTTIME")
                box.label(text="Spooled on disk. Retried automatically; nothing is on the record yet.")
                box.operator("scruple.drain_queue", text="Retry now", icon="FILE_REFRESH")

            rec = _state.last_reconciliation()
            if rec is not None and not rec.all_clear:
                # Only when something is WRONG. A green "all clear" badge
                # sitting on a panel is how a settlement stops being read;
                # the honest default for a settled session is silence, and
                # the operator's report is where "clear" gets said.
                box = layout.box()
                box.label(text="Reconciliation", icon="ERROR")
                box.label(text=rec.summary[:200])
                for line in rec.gaps[:5]:
                    box.row().label(
                        text=f"MISSING #{line.seq} {(line.filename or line.content_hash or '?')[:24]}",
                        icon="CANCEL",
                    )
                for line in rec.inconclusive[:5]:
                    box.row().label(
                        text=f"UNRESOLVED #{line.seq} {(line.filename or '?')[:24]}",
                        icon="QUESTION",
                    )

            layout.separator()

            layout.operator("scruple.witness_now", text="Witness Now", icon="RESTRICT_RENDER_OFF")
            layout.operator("scruple.witness_export", text="Witness an export...", icon="EXPORT")
            layout.operator("scruple.reconcile", text="Reconcile with Scruple", icon="FILE_REFRESH")

            pm = st.payment_method_summary or ""
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
                    "scruple.c2pa_sign",
                    # /api/v2/mark with modalities: [] — see operators/c2pa.py.
                    text=self._button_label("Local Lock", _payment.ACTION_C2PA),
                )
                op = box.operator(
                    "scruple.chain_lock",
                    text=self._button_label("Chain-lock", _payment.ACTION_CHAIN_PINNED),
                )
                op.tier = "pinned"

            # WO-B3: the tracker is the assurance list, not the SDK's
            # receipt list. It is a superset -- a capture refused before
            # the SDK was called produces no receipt, and a tracker that
            # showed only receipts would show nothing at all for it.
            records = _state.assurances()
            if records:
                layout.separator()
                box = layout.box()
                counts = _state.state_counts()
                summary = "  ".join(f"{n} {k.replace('_', ' ')}" for k, n in sorted(counts.items()))
                box.label(text=f"Captures this session — {summary}", icon="TEXT")
                for rec in records[:8]:
                    box.row().label(text=assurance_line(rec))
                last = records[0]
                if last.leaf_id:
                    box.operator("scruple.verify_last", text="Fetch receipt & verify", icon="CHECKMARK")
                    if last.signature.source == _assurance.NOT_DISCLOSED:
                        # Said once, at the bottom, rather than on every
                        # row: the reason every tier above reads
                        # `undisclosed` is the API, not the leaf.
                        box.label(text="No leaf signature is disclosed by this server.", icon="INFO")

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
