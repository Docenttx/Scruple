"""WO-G5. Two operators for the claim this plugin exists to make.

    scruple.baseline_addons   record the add-on set as the baseline · §4
    scruple.check_claim       what does this scene support right now

⚑ NEITHER OF THEM SIGNS ANYTHING, and that is deliberate. What a user needs
before they lock is to know whether their scene can carry a no-AI claim AT ALL —
and, when it cannot, which hole in the record is why. A button that silently
signed with a weaker source type would take that decision away from the person
whose work it is.
"""

from __future__ import annotations

try:
    import bpy
except ImportError:
    bpy = None

from adapter import claim as _claim
from adapter import host_addons as _addons
from adapter import state as _state


def describe(result) -> tuple:
    """(level, message) for a derived claim. The refusal names the hole."""
    c = result["claim"]
    if c.get("ok"):
        return ({"INFO"}, f"This scene supports {c['digital_source_type']}.")
    detail = (c.get("detail") or "").split(".")[0]
    return ({"WARNING"}, f"No non-AI claim: {c.get('code')} — {detail}.")


if bpy is not None:

    class SCRUPLE_OT_baseline_addons(bpy.types.Operator):
        bl_idname = "scruple.baseline_addons"
        bl_label = "Baseline Add-ons"
        bl_description = (
            "Record every enabled add-on and its digest as the baseline. "
            "Standard §4: changing the set afterwards is a witnessed event"
        )

        def execute(self, context):
            doc = _addons.enumerate_addons()
            if not doc:
                self.report({"ERROR"}, "Could not enumerate add-ons.")
                return {"CANCELLED"}
            path = _claim.write_baseline(doc)
            self.report(
                {"INFO"},
                f"Baseline: {doc['count']} add-ons ({doc['third_party_count']} third-party), "
                f"digest {_addons.document_hash(doc)[7:19]}…",
            )
            return {"FINISHED"} if path else {"CANCELLED"}

    class SCRUPLE_OT_check_claim(bpy.types.Operator):
        bl_idname = "scruple.check_claim"
        bl_label = "Check Claim"
        bl_description = (
            "What digitalSourceType this scene's record supports — and, if none, "
            "which gap in the record is the reason"
        )

        def execute(self, context):
            result = _claim.current()
            level, message = describe(result)
            # On the dashboard as well as the info bar: Blender's info bar is
            # overwritten by the next report, and this is exactly the thing a
            # user comes back to a minute later. WO-B5's rule.
            if not result["claim"].get("ok"):
                _state.set_error(message)
            self.report(level, message)
            return {"FINISHED"}

    _CLASSES = (SCRUPLE_OT_baseline_addons, SCRUPLE_OT_check_claim)

    def register():
        for c in _CLASSES:
            bpy.utils.register_class(c)

    def unregister():
        for c in reversed(_CLASSES):
            bpy.utils.unregister_class(c)

else:

    def register():
        pass

    def unregister():
        pass
