"""Settle now: drain the spool, then ask the server what is missing.

WO-B4. Two operators, deliberately two and not one:

  `scruple.drain_queue`  -- replay what is spooled. Cheap, no reads, and
                            the thing a user wants after the network comes
                            back.
  `scruple.reconcile`    -- drain, then check EVERY capture in this
                            profile's ledger against
                            GET /api/v2/verify/{content_hash}, and report
                            what is not there.

Separating them keeps the expensive, honest one from being something a
user runs by accident, and keeps the cheap one from being mistaken for a
settlement. A drain that succeeds says the queue is empty. It does not say
anything landed -- the queue removes an entry on a 2xx, and a 2xx from
/api/v2/witness means CAPTURED, never witnessed (route.ts:562). Only the
reconciliation asks.

WHAT THE REPORT MUST NEVER SAY. "All clear" when the server could not be
reached. `Reconciliation.all_clear` is False for anything unchecked, and
this operator reports at WARNING rather than INFO whenever it is False --
including the case where nothing is missing and nothing could be checked.
"""

from __future__ import annotations

try:
    import bpy
except ImportError:
    bpy = None

from adapter import handlers as _handlers
from adapter import reconcile as _reconcile
from adapter import sdk as _sdk


def report_lines(rec) -> list:
    """The settlement in words, shared with the panel so one place decides
    how a gap is phrased."""
    if rec is None:
        return ["Not signed in — nothing was settled."]
    lines = [rec.summary]
    if rec.drain.attempted:
        lines.append(
            f"Queue: {rec.drain.attempted} spooled, {rec.drain.succeeded} delivered, "
            f"{rec.drain.remaining} still waiting."
        )
    for line in rec.gaps:
        lines.append(
            f"MISSING #{line.seq} {line.filename or line.content_hash or '?'} "
            f"({line.kind}) — {line.sentence}"
        )
    for line in rec.inconclusive:
        lines.append(
            f"UNRESOLVED #{line.seq} {line.filename or '?'} — {line.sentence}"
        )
    if rec.missing_ledger_seq:
        lines.append(
            f"Ledger rows {rec.missing_ledger_seq} are absent: captures were recorded "
            f"and their lines are gone. Nothing here can say what they were."
        )
    if rec.damaged_ledger_lines:
        lines.append(f"{rec.damaged_ledger_lines} ledger line(s) could not be read.")
    if not rec.component.get("available"):
        lines.append(
            "Server-side component accounting: "
            f"{rec.component.get('reason', 'unavailable')} — {rec.component.get('detail', '')}"
        )
    return lines


if bpy is not None:

    class SCRUPLE_OT_drain_queue(bpy.types.Operator):
        bl_idname = "scruple.drain_queue"
        bl_label = "Retry queued captures"
        bl_description = (
            "Replay every capture spooled on disk while the server was unreachable. "
            "Does not check whether they landed — use Reconcile for that"
        )

        def execute(self, context):
            client = _sdk.get_client()
            if client is None:
                self.report({"ERROR"}, "Not signed in. Open Add-on Preferences to sign in.")
                return {"CANCELLED"}
            result = _handlers.drain_queue()
            if not result["attempted"]:
                self.report({"INFO"}, "Nothing is spooled.")
                return {"FINISHED"}
            self.report(
                {"INFO"} if not result["remaining"] else {"WARNING"},
                f"{result['succeeded']} of {result['attempted']} delivered; "
                f"{result['remaining']} still waiting. Delivered is not witnessed — "
                f"run Reconcile to find out what is on the record.",
            )
            return {"FINISHED"}

    class SCRUPLE_OT_reconcile(bpy.types.Operator):
        bl_idname = "scruple.reconcile"
        bl_label = "Reconcile with Scruple"
        bl_description = (
            "Drain the queue, then ask Scruple whether every capture this session "
            "recorded is actually on the record. Reports what is missing"
        )

        def execute(self, context):
            client = _sdk.get_client()
            if client is None:
                self.report({"ERROR"}, "Not signed in. Open Add-on Preferences to sign in.")
                return {"CANCELLED"}
            rec = _handlers.settle()
            level = {"INFO"} if (rec is not None and rec.all_clear) else {"WARNING"}
            for line in report_lines(rec):
                self.report(level, line)
            return {"FINISHED"}

    _CLASSES = (SCRUPLE_OT_drain_queue, SCRUPLE_OT_reconcile)

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
