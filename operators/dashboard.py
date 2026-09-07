"""The dashboard's own operators: refresh, switch, drill down, dismiss.

WO-B5. Every one of these exists because `draw()` may not do the thing
it does. Blender calls a panel's draw on every redraw, so a project
fetch, a payment-config fetch or a `set-active` POST in draw() is a
network round-trip per frame on the main thread. The panel reads caches;
these operators fill them, on a button press or from the worker thread.

`scruple.refresh_config` moved here from panels/main.py, where it was
declared as a `bpy.types.Operator` under a class name beginning
`SCRUPLE_PT_`. Blender does not care -- the prefix is a convention -- but
a reader does, and an operator living in the panel module is how it came
to be named that way in the first place.
"""

from __future__ import annotations

try:
    import bpy
except ImportError:
    bpy = None

from adapter import log as _log
from adapter import projects as _projects
from adapter import sdk as _sdk
from adapter import state as _state

from scruple_host_sdk import http as _http


def refresh_payment_config() -> bool:
    """Read /api/stripe/config into the state bag. Returns whether a
    config came back at all -- NOT whether a card is on file.

    Through `http.submit` rather than `payment.get_payment_config()`,
    which returns `{}` for a 401 and for an empty body alike. The status
    matters here: `/api/stripe/*` authenticates with a NextAuth session
    cookie, not a bearer key (scruple_host_sdk/payment.py's header), so a
    plugin session gets a 401 and the panel must be able to say that
    rather than "not read yet". Measured against the scratch app on
    2026-09-07: `GET /api/stripe/config` with a valid v2 bearer key ->
    HTTP 401.
    """
    client = _sdk.get_client()
    if client is None:
        _state.set_payment_config(None, error="Not signed in.")
        return False
    result = _http.submit(client, "GET", "/api/stripe/config")
    if not result.ok:
        _state.set_payment_config(None, error=result.error or "no reason given")
        _log.warn(f"payment config: {result.error}")
        return False
    cfg = result.body if isinstance(result.body, dict) else None
    _state.set_payment_config(cfg, error=None if cfg else "the server sent no payment settings")
    return bool(cfg)


def refresh_projects(*, with_detail: bool = True):
    """Refill the project index, and the active project's history.

    Safe to call from the worker thread: it touches only module-level
    caches and the state bag, and draws nothing.
    """
    client = _sdk.get_client()
    index = _projects.refresh(client)
    if with_detail and _state.get().active_project_id is not None:
        _projects.refresh_detail(client)
    return index


if bpy is not None:

    class SCRUPLE_OT_refresh_config(bpy.types.Operator):
        bl_idname = "scruple.refresh_config"
        bl_label = "Refresh payment info"
        bl_description = "Re-read the payment method and prices from scruple.ai"

        def execute(self, context):
            if refresh_payment_config():
                self.report({"INFO"}, "Payment settings refreshed.")
            else:
                self.report({"WARNING"}, "Could not read payment settings.")
            return {"FINISHED"}

    class SCRUPLE_OT_refresh_projects(bpy.types.Operator):
        bl_idname = "scruple.refresh_projects"
        bl_label = "Refresh projects"
        bl_description = "Re-read the project list and the active project's history from scruple.ai"

        def execute(self, context):
            index = refresh_projects()
            if index.connection != _projects.ONLINE:
                self.report(
                    {"WARNING"},
                    f"{_projects.connection_label(index.connection)}: {index.error or 'no reason given'}",
                )
                return {"CANCELLED"}
            self.report(
                {"INFO"},
                f"{len(index.live)} project(s); active {index.server_active_id or 'none'} on the server.",
            )
            return {"FINISHED"}

    class SCRUPLE_OT_select_project(bpy.types.Operator):
        bl_idname = "scruple.select_project"
        bl_label = "Switch project"
        bl_description = "Route the next capture into this project"

        project_id: bpy.props.IntProperty(default=0)

        def execute(self, context):
            client = _sdk.get_client()
            pid = int(self.project_id or 0) or None
            if not _projects.select(client, pid):
                self.report({"ERROR"}, _state.get().last_error or "Could not switch project.")
                return {"CANCELLED"}
            _projects.refresh_detail(client)
            name = _state.get().active_project_name or "(none)"
            self.report({"INFO"}, f"Capturing into '{name}'.")
            return {"FINISHED"}

    class SCRUPLE_OT_archive_project(bpy.types.Operator):
        bl_idname = "scruple.archive_project"
        bl_label = "Archive project"
        bl_description = "Archive this project, or restore it to the live list"

        project_id: bpy.props.IntProperty(default=0)
        restore: bpy.props.BoolProperty(default=False)

        def execute(self, context):
            client = _sdk.get_client()
            pid = int(self.project_id or 0)
            if pid <= 0:
                self.report({"ERROR"}, "No project.")
                return {"CANCELLED"}
            if not _projects.set_archived(client, pid, not self.restore):
                self.report({"ERROR"}, _state.get().last_error or "The server refused.")
                return {"CANCELLED"}
            refresh_projects()
            self.report({"INFO"}, "Restored." if self.restore else "Archived.")
            return {"FINISHED"}

    class SCRUPLE_OT_select_capture(bpy.types.Operator):
        bl_idname = "scruple.select_capture"
        bl_label = "Show this capture"
        bl_description = "Open the receipt drill-down for this capture"

        capture_key: bpy.props.StringProperty(default="")

        def execute(self, context):
            key = (self.capture_key or "").strip() or None
            _state.select_capture(key)
            return {"FINISHED"}

    class SCRUPLE_OT_clear_error(bpy.types.Operator):
        bl_idname = "scruple.clear_error"
        bl_label = "Dismiss"
        bl_description = "Clear the last error from the panel"

        def execute(self, context):
            _state.set_error(None)
            return {"FINISHED"}

    _CLASSES = (
        SCRUPLE_OT_refresh_config,
        SCRUPLE_OT_refresh_projects,
        SCRUPLE_OT_select_project,
        SCRUPLE_OT_archive_project,
        SCRUPLE_OT_select_capture,
        SCRUPLE_OT_clear_error,
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
