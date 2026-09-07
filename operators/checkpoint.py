"""Checkpoint operator -- paid soft-lock. CURRENTLY UNAVAILABLE, LOUDLY.

`POST /api/lock/checkpoint` has no /api/v2 equivalent (gap.json,
endpoints row 8: "no_equivalent"). /api/v2/mark's modality vocabulary is
a closed set -- c2pa, watermark, chain, local -- and "checkpoint", a v1
soft-lock over a whole project, is not in it and does not decompose into
it.

There were three ways to handle that and only one of them is honest:

  a. keep calling the v1 route from inside the addon. That means the
     adapter constructs its own HTTP request, which is the first item on
     CANON_SKELETON.md §5's list of things an adapter may not do, and it
     would be the last hand-rolled client in the tree.
  b. quietly map it onto `local`, so the button still "works". A paid
     button that charges for one thing and performs another is the exact
     dishonesty the L2 floor exists to prevent.
  c. refuse, in one sentence, and charge nothing.

This is (c). The operator stays registered and its bl_idname is
unchanged, so a saved keymap still resolves; pressing it explains itself
and returns CANCELLED without touching the network. It comes back when
the server has a v2 route for it -- that is a server-side decision, and
it is written down as one in docs/canon/blender-l2/.
"""

from __future__ import annotations

try:
    import bpy
except ImportError:
    bpy = None

from adapter import state as _state

UNAVAILABLE_REASON = (
    "Checkpoint has no /api/v2 equivalent: v1's /api/lock/checkpoint was a "
    "project-level soft lock, and v2's modality vocabulary (c2pa, watermark, "
    "chain, local) has no member for it. Nothing was charged."
)


if bpy is not None:

    class SCRUPLE_OT_checkpoint(bpy.types.Operator):
        bl_idname = "scruple.checkpoint"
        bl_label = "Checkpoint (unavailable on v2)"
        bl_description = UNAVAILABLE_REASON

        def execute(self, context):
            _state.set_error(UNAVAILABLE_REASON)
            self.report({"WARNING"}, UNAVAILABLE_REASON)
            return {"CANCELLED"}

    _CLASSES = (SCRUPLE_OT_checkpoint,)

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
