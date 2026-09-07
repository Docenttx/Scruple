"""The N-panel: project manager, capture tracker, and lock dashboard.

WO-B5. What was here before was a sign-in gate, a project header that
nothing ever populated, four paid buttons and a receipt list -- one
`draw()` that read four adapter modules inline and decided, while
drawing, what each region meant. It is now three files:

    panels/model.py      one read of everything, as a snapshot
    panels/dashboard.py  one function per region, no policy
    panels/main.py       this file: the bpy classes, and nothing else

WHY SUB-PANELS. Blender's own answer to "a sidebar and a workspace" is a
parent panel with collapsible children, and it buys three things a
single tall panel does not: a user can collapse the regions they are not
using, each child gets its own `poll()` so a region that does not apply
is genuinely not in the UI (not merely empty), and the header stays
visible while the tracker scrolls. The Fusion palette's information
architecture maps onto them one for one:

    palette sidebar, project list      -> SCRUPLE_PT_projects
    palette sidebar, witnessed edits   -> SCRUPLE_PT_edits
    palette workspace, iteration list  -> SCRUPLE_PT_tracker
    palette workspace, lock buttons    -> SCRUPLE_PT_locks
    palette workspace, receipt detail  -> SCRUPLE_PT_receipt
    palette top bar + error banner     -> SCRUPLE_PT_main

`SCRUPLE_PT_main` keeps the queue, reconciliation and error regions
because they are session-wide and must be visible without expanding
anything: an addon whose spool is backing up should not be able to hide
that inside a collapsed sub-panel.

`assurance_line` and `receipt_line` are re-exported from
`panels.dashboard` -- WO-B3's tests pin them by name on this module, and
the wording is now shared with the drill-down.
"""

from __future__ import annotations

try:
    import bpy
except ImportError:
    bpy = None

from panels import dashboard as _dash
from panels import model as _model

# Re-exported: the tests from WO-B3 address these on this module, and
# moving the wording to dashboard.py must not move the API.
assurance_line = _dash.assurance_line
receipt_line = _dash.receipt_line

PANEL_LABEL = "Scruple"
CATEGORY = "Scruple"


if bpy is not None:

    class _ScruplePanel:
        bl_space_type = "VIEW_3D"
        bl_region_type = "UI"
        bl_category = CATEGORY

    class SCRUPLE_PT_main(_ScruplePanel, bpy.types.Panel):
        bl_label = PANEL_LABEL
        bl_idname = "SCRUPLE_PT_main"

        def draw(self, context):
            layout = self.layout
            m = _model.build()

            if _dash.draw_signin(layout, m):
                # The gate. Nothing else is drawn signed out -- there is
                # no session, so every other region would be describing
                # state that does not exist.
                return

            _dash.draw_header(layout, m)
            _dash.draw_connection(layout, m)
            _dash.draw_queue(layout, m)
            _dash.draw_reconciliation(layout, m)
            _dash.draw_error(layout, m)
            layout.separator()
            layout.operator("scruple.witness_now", text="Witness Now", icon="RESTRICT_RENDER_OFF")
            layout.operator("scruple.witness_export", text="Witness an export...", icon="EXPORT")
            layout.operator("scruple.reconcile", text="Reconcile with Scruple", icon="FILE_REFRESH")

    class _ScrupleSubPanel(_ScruplePanel):
        bl_parent_id = "SCRUPLE_PT_main"
        bl_options = {"DEFAULT_CLOSED"}

    class SCRUPLE_PT_projects(_ScrupleSubPanel, bpy.types.Panel):
        bl_label = "Projects"
        bl_idname = "SCRUPLE_PT_projects"

        @classmethod
        def poll(cls, context):
            return _model.build().show_projects

        def draw(self, context):
            _dash.draw_projects(self.layout, _model.build())

    class SCRUPLE_PT_edits(_ScrupleSubPanel, bpy.types.Panel):
        bl_label = "Witnessed edits"
        bl_idname = "SCRUPLE_PT_edits"

        @classmethod
        def poll(cls, context):
            m = _model.build()
            return m.show_projects and m.active_project_id is not None

        def draw(self, context):
            _dash.draw_edits(self.layout, _model.build())

    class SCRUPLE_PT_tracker(_ScrupleSubPanel, bpy.types.Panel):
        bl_label = "Captures this session"
        bl_idname = "SCRUPLE_PT_tracker"
        bl_options = set()  # open by default: this is the live surface

        @classmethod
        def poll(cls, context):
            return _model.build().show_tracker

        def draw(self, context):
            _dash.draw_tracker(self.layout, _model.build())

    class SCRUPLE_PT_receipt(_ScrupleSubPanel, bpy.types.Panel):
        bl_label = "Receipt"
        bl_idname = "SCRUPLE_PT_receipt"

        @classmethod
        def poll(cls, context):
            return _model.build().show_receipt

        def draw(self, context):
            _dash.draw_receipt(self.layout, _model.build())

    class SCRUPLE_PT_locks(_ScrupleSubPanel, bpy.types.Panel):
        bl_label = "Lock & mint"
        bl_idname = "SCRUPLE_PT_locks"

        @classmethod
        def poll(cls, context):
            return _model.build().show_locks

        def draw(self, context):
            layout = self.layout
            m = _model.build()
            _dash.draw_payment(layout, m)
            _dash.draw_locks(layout, m)

    #: Every panel class, parent first -- Blender resolves `bl_parent_id`
    #: at registration and a child registered before its parent is
    #: silently dropped from the UI.
    _CLASSES = (
        SCRUPLE_PT_main,
        SCRUPLE_PT_projects,
        SCRUPLE_PT_edits,
        SCRUPLE_PT_tracker,
        SCRUPLE_PT_receipt,
        SCRUPLE_PT_locks,
    )

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
