"""ScrupleFusion add-in entry point.

Architecture: Option 2 — the palette loads scruple-web's React UI directly
via Fusion's embedded Qt WebEngine. This file is the host shell: palette
mount, documentSaved hook, auto-witness timer, and the JS↔Python bridge
that dispatches palette actions (witness_now, lock_chain, open_browser,
set_api_key) onto the appropriate Python flows.

Threading: HTMLEventHandler.notify and DocumentEventHandler.notify both
fire on Fusion's UI thread, which is also where adsk.* APIs are safe to
call. The auto-witness daemon thread does NOT touch adsk; it just fires
a custom event that we handle on the UI thread.
"""

import json
import os
import sys
import traceback
import urllib.request
import webbrowser

# Make lib/ importable without polluting sys.path globally.
_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
if _THIS_DIR not in sys.path:
    sys.path.insert(0, _THIS_DIR)

try:
    import adsk.core  # noqa: F401
    import adsk.fusion  # noqa: F401
    _IN_FUSION = True
except ImportError:
    _IN_FUSION = False

from lib import scruple_client, witness, auto_witness, palette_host  # noqa: E402

_handlers = []
_auto_witness_thread = None
_palette = None
_url_scheme_server = None

# Toolbar panel — created in run(), cleaned in stop().
TOOLBAR_PANEL_ID = "scruple_panel"
TOOLBAR_PANEL_NAME = "Scruple"
TARGET_WORKSPACE = "FusionSolidEnvironment"
CMD_SHOW_PALETTE = "scruple_show_palette"
CMD_WITNESS_NOW = "scruple_witness_now"
CMD_LOCK_ANCHOR = "scruple_lock_anchor"

SCRUPLE_WEB_ORIGIN = os.environ.get("SCRUPLE_WEB_ORIGIN", "https://scruple.stooges.ai")


class _SharedState:
    """Mutable state shared between handlers. Holds the API key (set by the
    palette via 'set_api_key') + active project_id (set on 'project_changed'
    or inferred from a witness_now message). Both can be None initially.
    """
    def __init__(self):
        self.api_key: str | None = None
        self.active_project_id: int | None = None


_state = _SharedState()


def _diag_ping(event: str, **fields):
    """DIAGNOSTIC ONLY. Fire-and-forget POST to /api/diag/fusion so the
    server log records which Python handlers fired, regardless of api_key
    state. Removed once end-to-end is proven.
    """
    try:
        import threading
        import urllib.request

        payload = {"event": event, "has_api_key": bool(_state.api_key)}
        payload.update(fields)

        def _do():
            try:
                req = urllib.request.Request(
                    f"{SCRUPLE_WEB_ORIGIN}/api/diag/fusion",
                    data=json.dumps(payload).encode("utf-8"),
                    headers={
                        "Content-Type": "application/json",
                        "User-Agent": "scruple-fusion-addin/0.1.0",
                    },
                    method="POST",
                )
                urllib.request.urlopen(req, timeout=3).read()
            except Exception:
                pass

        threading.Thread(target=_do, daemon=True).start()
    except Exception:
        pass


if _IN_FUSION:
    def _send_to_palette(palette, action, payload):
        """JS-side window.fusionJavaScriptHandler(action, data_string) gets
        called with our payload. Used to push status updates / results from
        Python back to the React UI."""
        try:
            palette.sendInfoToHTML(action, json.dumps(payload))
        except Exception:
            pass

    def _client_for(state) -> scruple_client.ScrupleClient | None:
        if not state.api_key:
            return None
        return scruple_client.ScrupleClient(
            base_url=SCRUPLE_WEB_ORIGIN, api_key=state.api_key
        )

    def _walk_data_folder(folder, out, max_files=5000):
        """Recursively collect every .f3d DataFile under `folder` into `out`.
        `out` is a list mutated in place. Bounded by max_files.
        """
        if len(out) >= max_files:
            return
        try:
            files = folder.dataFiles
            for i in range(files.count):
                if len(out) >= max_files:
                    return
                try:
                    df = files.item(i)
                    ext = (getattr(df, "fileExtension", "") or "").lower()
                    if ext == "f3d":
                        out.append({
                            "fusion_data_id": df.id,
                            "name": df.name,
                        })
                except Exception:
                    continue
        except Exception:
            pass
        try:
            subs = folder.dataFolders
            for i in range(subs.count):
                if len(out) >= max_files:
                    return
                try:
                    _walk_data_folder(subs.item(i), out, max_files=max_files)
                except Exception:
                    continue
        except Exception:
            pass

    def _scan_fusion_account(app):
        """Walk every DataProject the user has access to and collect every
        .f3d file (recursively through folders). Returns a list of
        {fusion_data_id, name, fusion_project_id} dicts, capped.
        """
        collected = []
        try:
            projects = app.data.dataProjects
            for i in range(projects.count):
                try:
                    proj = projects.item(i)
                    proj_id = getattr(proj, "id", None)
                    root = proj.rootFolder
                    before = len(collected)
                    _walk_data_folder(root, collected)
                    # Stamp fusion_project_id on the entries we just added.
                    for k in range(before, len(collected)):
                        collected[k]["fusion_project_id"] = proj_id
                except Exception:
                    continue
        except Exception:
            pass
        return collected

    def _scan_and_sync(app, palette):
        """One-shot: scan Fusion account, POST to /api/projects/fusion-sync.
        Fires diag pings around each phase so the server log shows what
        happened even if the sync silently succeeds with 0 files."""
        client = _client_for(_state)
        if client is None:
            _diag_ping("scan_skipped_no_key")
            return
        try:
            files = _scan_fusion_account(app)
            _diag_ping("scan_complete", file_count=len(files))
            if not files:
                _send_to_palette(palette, "fusion_sync_done", {"synced": 0})
                return
            import urllib.request
            body = json.dumps({"files": files}).encode("utf-8")
            req = urllib.request.Request(
                f"{SCRUPLE_WEB_ORIGIN}/api/projects/fusion-sync",
                data=body,
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {_state.api_key}",
                    "User-Agent": "scruple-fusion-addin/0.1.0",
                },
                method="POST",
            )
            resp = urllib.request.urlopen(req, timeout=30)
            payload = json.loads(resp.read().decode("utf-8"))
            _diag_ping(
                "sync_complete",
                created=payload.get("created", 0),
                updated=payload.get("updated", 0),
                skipped=payload.get("skipped", 0),
            )
            _send_to_palette(palette, "fusion_sync_done", payload)
        except Exception as e:
            _diag_ping("sync_error", error=str(e))
            _send_to_palette(palette, "fusion_sync_error", {"message": str(e)})

    def _do_witness(app, ui, palette):
        """Run an export + witness on the active design. Called on UI thread."""
        try:
            client = _client_for(_state)
            if client is None:
                _send_to_palette(palette, "witness_error", {
                    "message": "No API key — sign in first",
                })
                return
            project_id = _state.active_project_id
            if not project_id:
                _send_to_palette(palette, "witness_error", {
                    "message": "No project selected — pick one in the palette",
                })
                return

            design = adsk.fusion.Design.cast(app.activeProduct)
            if design is None:
                _send_to_palette(palette, "witness_error", {
                    "message": "No active design in Fusion",
                })
                return

            _send_to_palette(palette, "witness_started", {"project_id": project_id})
            resp = witness.export_and_witness(
                design, client, project_id, trigger="palette"
            )
            _send_to_palette(palette, "witness_done", {
                "project_id": project_id,
                "run_sequence": resp.get("runSequence"),
                "leaf_hash": resp.get("leafHash"),
            })
        except Exception as e:
            _send_to_palette(palette, "witness_error", {
                "message": f"Witness failed: {e}",
                "trace": traceback.format_exc(),
            })

    class _DocActivatedHandler(adsk.core.DocumentEventHandler):
        """documentActivated fires when a document becomes the active one
        in Fusion (opened from Fusion Team, switched to a different tab,
        etc). If the design is already saved AND has no Scruple binding
        yet, we auto-bind and take an initial witness of the current state.

        This is how existing designs get picked up — no user action needed,
        no batch scan required. Every existing design the user opens gets
        tracked as they encounter it. Honest receipt: the first leaf is
        a snapshot of "state at first observation," not a build history.
        """
        def __init__(self, app, ui):
            super().__init__()
            self._app = app
            self._ui = ui

        def notify(self, args):
            try:
                # Give the palette a beat to load + hand us the API key
                # in case Fusion just started up. If we don't have a
                # client yet, skip — user will get the design bound
                # on the next save or activation.
                if _client_for(_state) is None:
                    return
                design = adsk.fusion.Design.cast(self._app.activeProduct)
                if design is None:
                    return
                # Only auto-bind saved designs; brand-new unsaved ones wait
                # for their first save (Fusion's normal name-your-file dialog).
                try:
                    doc = args.document if hasattr(args, 'document') else self._app.activeDocument
                    if not getattr(doc, 'isSaved', True):
                        return
                except Exception:
                    pass
                # Already bound? nothing to do.
                existing = design.attributes.itemByName("Scruple", "project_id")
                if existing and existing.value:
                    try:
                        _state.active_project_id = int(existing.value)
                    except Exception:
                        pass
                    return
                # Unbound saved design — bind + take an initial witness.
                _auto_bind_project_on_save(self._app, self._ui)
                try:
                    self._app.fireCustomEvent(auto_witness.CUSTOM_EVENT_TICK)
                except Exception:
                    pass
            except Exception:
                pass

    class _DocSavedHandler(adsk.core.DocumentEventHandler):
        """documentSaved → auto-bind Scruple project if not bound yet, then
        fire the witness tick.

        This is the ONLY project-creation trigger. Zero prompts inside
        Fusion — user just saves their design normally and Scruple picks
        up the file name as the project name automatically.
        """
        def __init__(self, app, ui):
            super().__init__()
            self._app = app
            self._ui = ui

        def notify(self, args):
            _diag_ping("documentSaved")
            try:
                _auto_bind_project_on_save(self._app, self._ui)
                self._app.fireCustomEvent(auto_witness.CUSTOM_EVENT_TICK)
            except Exception as e:
                _diag_ping("documentSaved_error", error=str(e))

    class _WitnessTickHandler(adsk.core.CustomEventHandler):
        """Consumes the auto-witness custom event on the UI thread. The
        daemon thread fires this event when the design is dirty; we run
        the actual export here where adsk APIs are safe."""
        def __init__(self, app, ui, palette_ref):
            super().__init__()
            self._app = app
            self._ui = ui
            self._palette_ref = palette_ref

        def notify(self, args):
            try:
                _do_witness(self._app, self._ui, self._palette_ref[0])
            except Exception:
                pass

    class _CommandTerminatedHandler(adsk.core.ApplicationCommandEventHandler):
        """Fires after every Fusion command completes. If the timeline
        grew since the last observation, a feature was added and we
        witness the design state. This is the core per-edit witnessing.

        Filters out commands that don't touch the timeline (Zoom, Orbit,
        selection, etc.) by comparing timeline.count. Only witnesses when
        the count increased.

        Parametric mode is required — Direct mode has no timeline.
        """
        def __init__(self, app):
            super().__init__()
            self._app = app
            self._last_count = 0

        def notify(self, args):
            try:
                design = adsk.fusion.Design.cast(self._app.activeProduct)
                if design is None:
                    return
                if design.designType != adsk.fusion.DesignTypes.ParametricDesignType:
                    return
                try:
                    count = design.timeline.count
                except Exception:
                    return
                if count > self._last_count:
                    self._last_count = count
                    try:
                        self._app.fireCustomEvent(auto_witness.CUSTOM_EVENT_TICK)
                    except Exception:
                        pass
                elif count < self._last_count:
                    # Timeline shrank (delete / suppress). Record it as a
                    # negative event by witnessing the current state anyway.
                    # The chain reveals the deletion honestly.
                    self._last_count = count
                    try:
                        self._app.fireCustomEvent(auto_witness.CUSTOM_EVENT_TICK)
                    except Exception:
                        pass
            except Exception:
                pass

    def _do_checkpoint(app, ui, palette):
        """Mid-tier lock — checkpoint the chain. Uses same dev test-pay
        path as _do_lock. Real Stripe Checkout handoff lands after Probe 5.5.
        """
        try:
            client = _client_for(_state)
            if client is None:
                _send_to_palette(palette, "checkpoint_error", {"message": "No API key"})
                return
            project_id = _state.active_project_id
            if not project_id:
                _send_to_palette(palette, "checkpoint_error", {"message": "No project selected"})
                return
            _send_to_palette(palette, "checkpoint_started", {"project_id": project_id})

            # Mint PI + confirm via dev test-pay → then hit /api/lock/checkpoint
            try:
                pi_resp = _post_json(
                    SCRUPLE_WEB_ORIGIN + "/api/stripe/payment-intent",
                    {"action": "checkpoint", "projectId": project_id},
                    api_key=_state.api_key,
                )
                pi_id = pi_resp.get("paymentIntentId") or pi_resp.get("id")
                if not pi_id:
                    raise RuntimeError("no paymentIntentId")
                resp = _post_json(
                    SCRUPLE_WEB_ORIGIN + "/api/lock/checkpoint",
                    {"projectId": project_id, "paymentIntentId": pi_id},
                    api_key=_state.api_key,
                )
            except Exception as e:
                _send_to_palette(palette, "checkpoint_error", {
                    "message": f"Checkpoint failed: {e}",
                })
                return

            _send_to_palette(palette, "checkpoint_done", {
                "project_id": project_id,
                "pre_scr_id": resp.get("preScrId"),
                "merkle_root": resp.get("merkleRoot"),
            })
        except Exception:
            _send_to_palette(palette, "checkpoint_error", {
                "message": "Checkpoint crashed",
                "trace": traceback.format_exc(),
            })

    def _get_design_state(app):
        """Read the active Fusion document's name + Scruple project binding
        (from design.attributes if present)."""
        state = {"name": None, "project_id": None, "last_saved_at": None}
        try:
            doc = app.activeDocument
            state["name"] = getattr(doc, "name", None) or None
            design = adsk.fusion.Design.cast(app.activeProduct)
            if design is not None:
                attr = design.attributes.itemByName("Scruple", "project_id")
                if attr and attr.value:
                    try:
                        state["project_id"] = int(attr.value)
                    except Exception:
                        pass
        except Exception:
            pass
        return state

    def _bind_project(app, project_id: int):
        """Write project_id to the active design's Scruple attribute group."""
        try:
            design = adsk.fusion.Design.cast(app.activeProduct)
            if design is not None:
                design.attributes.add("Scruple", "project_id", str(project_id))
        except Exception:
            pass

    # -------------------------------------------------------------------
    # Toolbar buttons — a "Scruple" panel in the Design workspace toolbar
    #
    # Fusion command buttons are wired as follows:
    #   1. ui.commandDefinitions.addButtonDefinition(id, name, tooltip, resFolder)
    #   2. commandDef.commandCreated.add(handler)  — handler subclasses
    #      CommandCreatedEventHandler; its notify() fires on button click.
    #   3. panel.controls.addCommand(commandDef)
    #
    # For actions that don't need a dialog, we do the work directly in
    # the commandCreated handler — no need to plumb an execute handler.
    # -------------------------------------------------------------------

    class _ShowPaletteHandler(adsk.core.CommandCreatedEventHandler):
        """Toolbar button → open the Scruple palette (re-mount if missing)."""
        def __init__(self, app, ui):
            super().__init__()
            self._app = app
            self._ui = ui

        def notify(self, args):
            try:
                pal = self._ui.palettes.itemById(palette_host.PALETTE_ID)
                if pal is not None:
                    pal.isVisible = True
                else:
                    global _palette
                    _palette = palette_host.create_palette(self._app, self._ui)
            except Exception:
                try:
                    self._ui.messageBox(
                        "Show Scruple failed:\n" + traceback.format_exc()
                    )
                except Exception:
                    pass

    class _WitnessNowToolbarHandler(adsk.core.CommandCreatedEventHandler):
        """Toolbar button → fire an immediate witness of the current design.
        Same code path as the palette's Witness button and documentSaved."""
        def __init__(self, app):
            super().__init__()
            self._app = app

        def notify(self, args):
            try:
                self._app.fireCustomEvent(auto_witness.CUSTOM_EVENT_TICK)
            except Exception:
                pass

    class _LockAnchorToolbarHandler(adsk.core.CommandCreatedEventHandler):
        """Toolbar button → show the palette and start the chain-lock flow."""
        def __init__(self, app, ui, palette_ref):
            super().__init__()
            self._app = app
            self._ui = ui
            self._palette_ref = palette_ref

        def notify(self, args):
            try:
                pal = self._ui.palettes.itemById(palette_host.PALETTE_ID)
                if pal is not None:
                    pal.isVisible = True
                _do_lock(self._app, self._ui, self._palette_ref[0], "pinned")
            except Exception:
                try:
                    self._ui.messageBox(
                        "Lock via toolbar failed:\n" + traceback.format_exc()
                    )
                except Exception:
                    pass

    def _install_toolbar(app, ui, palette_ref):
        """Register the Scruple panel + 3 buttons in the Design workspace.
        Idempotent — tears down any leftover panel / command defs from a
        previous Stop+Run cycle before creating fresh ones.
        """
        try:
            workspace = ui.workspaces.itemById(TARGET_WORKSPACE)
            if workspace is None:
                return

            # Tear down leftovers from a previous run.
            existing_panel = workspace.toolbarPanels.itemById(TOOLBAR_PANEL_ID)
            if existing_panel is not None:
                try:
                    existing_panel.deleteMe()
                except Exception:
                    pass
            for cid in (CMD_SHOW_PALETTE, CMD_WITNESS_NOW, CMD_LOCK_ANCHOR):
                cd = ui.commandDefinitions.itemById(cid)
                if cd is not None:
                    try:
                        cd.deleteMe()
                    except Exception:
                        pass

            panel = workspace.toolbarPanels.add(TOOLBAR_PANEL_ID, TOOLBAR_PANEL_NAME)

            # Single Scruple button — opens the palette. All witness /
            # checkpoint / lock actions live INSIDE the palette, not on
            # the toolbar. This matches the "toolbar is a launcher, palette
            # is the product" mental model.
            show_def = ui.commandDefinitions.addButtonDefinition(
                CMD_SHOW_PALETTE,
                "Scruple",
                "Open Scruple Studio for Autodesk Fusion",
                "",  # TODO: 16/32 PNG icons in Scruple teal on dark
            )
            show_handler = _ShowPaletteHandler(app, ui)
            show_def.commandCreated.add(show_handler)
            _handlers.append(show_handler)
            panel.controls.addCommand(show_def)

        except Exception:
            try:
                ui.messageBox(
                    "Scruple toolbar install failed:\n" + traceback.format_exc()
                )
            except Exception:
                pass

    def _uninstall_toolbar(ui):
        """Remove the Scruple panel + command defs on add-in stop."""
        try:
            workspace = ui.workspaces.itemById(TARGET_WORKSPACE)
            if workspace is not None:
                panel = workspace.toolbarPanels.itemById(TOOLBAR_PANEL_ID)
                if panel is not None:
                    try:
                        panel.deleteMe()
                    except Exception:
                        pass
            for cid in (CMD_SHOW_PALETTE, CMD_WITNESS_NOW, CMD_LOCK_ANCHOR):
                cd = ui.commandDefinitions.itemById(cid)
                if cd is not None:
                    try:
                        cd.deleteMe()
                    except Exception:
                        pass
        except Exception:
            pass

    def _ensure_parametric(design, ui) -> bool:
        """If the design is in Direct modeling mode, prompt to switch to
        Parametric so the timeline is populated. Returns True if parametric
        by the time we return, False if user declined.
        """
        try:
            if design.designType == adsk.fusion.DesignTypes.ParametricDesignType:
                return True
            btn = adsk.core.MessageBoxButtonTypes.YesNoButtonType
            result = ui.messageBox(
                "Scruple needs Design History (Parametric mode) to witness "
                "every edit as a distinct event.\n\n"
                "Switch this design to Parametric mode now?",
                "Scruple — Enable Design History",
                btn,
            )
            if result == adsk.core.DialogResults.DialogYes:
                design.designType = adsk.fusion.DesignTypes.ParametricDesignType
                return True
            return False
        except Exception:
            return False

    def _auto_bind_project_on_save(app, ui):
        """Called from _DocSavedHandler on every save. If the active design
        has no Scruple project bound yet, this is the first save — so we
        take the Fusion file name (now known, because save just happened)
        and create a Scruple project under that name.

        Zero user prompts. The user's normal save flow IS the project
        creation trigger. The Fusion filename = the Scruple project name.

        Returns the project_id (whether pre-existing or newly created),
        or None if we couldn't bind yet (no API key, no design, unnamed).
        """
        try:
            client = _client_for(_state)
            if client is None:
                return None  # user hasn't signed in yet
            design = adsk.fusion.Design.cast(app.activeProduct)
            if design is None:
                return None

            existing = design.attributes.itemByName("Scruple", "project_id")
            if existing and existing.value:
                try:
                    _state.active_project_id = int(existing.value)
                    return _state.active_project_id
                except Exception:
                    return None

            # First save of an unbound design → create the project.
            name = ""
            try:
                name = (app.activeDocument.name or "").strip()
            except Exception:
                pass
            if not name:
                return None  # still untitled somehow — skip

            # Silently ensure parametric mode. If user explicitly picked
            # Direct mode we respect their choice, but the timeline hook
            # won't fire for them — they'll only get save-time witnesses.
            try:
                if design.designType == adsk.fusion.DesignTypes.ParametricDesignType:
                    pass
            except Exception:
                pass

            proj = client.create_project(name=name, kind="cad")
            pid = int(proj.get("id"))
            pre_scr_id = proj.get("pre_scr_id") or proj.get("preScrId") or ""

            design.attributes.add("Scruple", "project_id", str(pid))
            design.attributes.add("Scruple", "project_name", name)
            if pre_scr_id:
                design.attributes.add("Scruple", "pre_scr_id", pre_scr_id)

            _state.active_project_id = pid

            # Small non-modal notification so the user knows tracking is on.
            # Fusion doesn't have a native toast API; messageBox is intrusive
            # for every save, so we only show it on FIRST bind.
            try:
                ui.messageBox(
                    f"Scruple is now tracking this design.\n\n"
                    f"Project: {name}\n"
                    + (f"SCR-ID (pre-lock): {pre_scr_id}\n\n" if pre_scr_id else "\n")
                    + "The project should appear in Scruple Studio's project "
                    "list within a few seconds. Every save and every timeline "
                    "change from now on will be witnessed automatically.",
                    "Scruple — Tracking started"
                )
            except Exception:
                pass
            return pid
        except Exception:
            try:
                ui.messageBox("Scruple auto-bind failed:\n\n" + traceback.format_exc())
            except Exception:
                pass
            return None

    class _PaletteMsgHandler(adsk.core.HTMLEventHandler):
        """JS → Python message dispatcher.

        Actions:
            set_api_key       — palette tells us the user's bearer token
            get_design_state  — send design_state event with name + binding
            project_changed   — palette tells us which project is selected
            bind_project      — write project_id to design.attributes
            witness_now       — manual witness trigger
            checkpoint        — mid-tier lock via dev test-pay
            lock_chain        — full chain lock + 3-anchor commit
            open_browser      — open URL in system browser
        """
        def __init__(self, app, ui, palette_ref):
            super().__init__()
            self._app = app
            self._ui = ui
            self._palette_ref = palette_ref

        def notify(self, args):
            try:
                action = args.action
                _diag_ping("palette_msg_received", action=action)
                data = {}
                if args.data:
                    try:
                        data = json.loads(args.data)
                    except Exception:
                        pass

                if action == "set_api_key":
                    key = (data.get("key") or "").strip()
                    _diag_ping(
                        "set_api_key_received",
                        key_len=len(key),
                        starts_with_sk=key.startswith("sk_"),
                    )
                    if key.startswith("sk_"):
                        _state.api_key = key
                        # Auto-scan the user's Fusion account and mirror
                        # every .f3d into Scruple. Idempotent on server —
                        # safe to fire on every reconnect. The palette
                        # picks up new projects on its next poll.
                        try:
                            _scan_and_sync(self._app, self._palette_ref[0])
                        except Exception as e:
                            _diag_ping("scan_dispatch_error", error=str(e))

                elif action == "scan_now":
                    # Manual "refresh from Fusion account" trigger from palette.
                    try:
                        _scan_and_sync(self._app, self._palette_ref[0])
                    except Exception as e:
                        _diag_ping("scan_dispatch_error", error=str(e))

                elif action == "get_design_state":
                    state = _get_design_state(self._app)
                    _send_to_palette(self._palette_ref[0], "design_state", state)

                elif action == "bind_project":
                    pid = data.get("project_id")
                    if pid:
                        try:
                            pid_int = int(pid)
                            _bind_project(self._app, pid_int)
                            _state.active_project_id = pid_int
                        except Exception:
                            pass

                elif action == "project_changed":
                    pid = data.get("project_id")
                    try:
                        _state.active_project_id = int(pid) if pid else None
                    except Exception:
                        _state.active_project_id = None

                elif action == "witness_now":
                    pid = data.get("project_id")
                    if pid:
                        try:
                            _state.active_project_id = int(pid)
                        except Exception:
                            pass
                    _do_witness(self._app, self._ui, self._palette_ref[0])

                elif action == "checkpoint":
                    pid = data.get("project_id")
                    if pid:
                        try:
                            _state.active_project_id = int(pid)
                        except Exception:
                            pass
                    _do_checkpoint(self._app, self._ui, self._palette_ref[0])

                elif action == "lock_chain":
                    pid = data.get("project_id")
                    tier = data.get("tier") or "pinned"
                    if pid:
                        try:
                            _state.active_project_id = int(pid)
                        except Exception:
                            pass
                    _do_lock(self._app, self._ui, self._palette_ref[0], tier)

                elif action == "open_browser":
                    url = (data.get("url") or "").strip()
                    if url.startswith("/"):
                        url = SCRUPLE_WEB_ORIGIN.rstrip("/") + url
                    if not url:
                        url = SCRUPLE_WEB_ORIGIN
                    webbrowser.open(url)

            except Exception:
                try:
                    self._ui.messageBox(
                        "Scruple palette message handler failed:\n\n"
                        + traceback.format_exc()
                    )
                except Exception:
                    pass

    def _do_lock(app, ui, palette, tier):
        """Lock the active project. For now: drives the dev test-pay path
        (same as scripts/stripe-test-pay.mjs) so the user can see the full
        end-to-end RVN+IPFS+Arweave anchor flow without a real Stripe
        Checkout step. Production Checkout handoff lands in a follow-up
        once Probe 5.5 (custom URL scheme) is confirmed.
        """
        try:
            client = _client_for(_state)
            if client is None:
                _send_to_palette(palette, "lock_error", {
                    "message": "No API key — sign in first",
                })
                return
            project_id = _state.active_project_id
            if not project_id:
                _send_to_palette(palette, "lock_error", {
                    "message": "No project selected",
                })
                return

            _send_to_palette(palette, "lock_started", {"project_id": project_id})

            # Dev path: hit the test-pay helper endpoint on scruple-web
            # (which uses the witness server's admin confirm-pi to fake a
            # successful Stripe sandbox PaymentIntent). This is gated to
            # NODE_ENV=development server-side.
            action_name = f"chain-lock-{tier}"
            try:
                pi_resp = _post_json(
                    SCRUPLE_WEB_ORIGIN
                    + f"/api/stripe/payment-intent",
                    {"action": action_name, "projectId": project_id},
                    api_key=_state.api_key,
                )
                pi_id = pi_resp.get("paymentIntentId") or pi_resp.get("id")
                if not pi_id:
                    raise RuntimeError(
                        "no paymentIntentId from /api/stripe/payment-intent"
                    )
                # Confirm + execute the lock
                lock_resp = client.lock_chain(
                    project_id, pi_id, tier=tier
                )
            except Exception as e:
                _send_to_palette(palette, "lock_error", {
                    "message": f"Lock failed: {e}",
                    "trace": traceback.format_exc(),
                })
                return

            # Write attribute back to the active document so the chain
            # survives close + reopen.
            try:
                design = adsk.fusion.Design.cast(app.activeProduct)
                if design is not None:
                    witness.write_lock_attributes(design, lock_resp)
            except Exception:
                pass

            _send_to_palette(palette, "lock_done", {
                "project_id": project_id,
                "scr_id": lock_resp.get("scrId"),
                "merkle_root": lock_resp.get("merkleRoot"),
                "proof_tx_id": lock_resp.get("proofTxId"),
                "ipfs_cid": lock_resp.get("ipfsCid"),
                "arweave_tx_id": lock_resp.get("arweaveTxId"),
            })
        except Exception:
            try:
                _send_to_palette(palette, "lock_error", {
                    "message": "Lock crashed",
                    "trace": traceback.format_exc(),
                })
            except Exception:
                pass

    def _post_json(url, body, api_key=None):
        """Simple stdlib POST. Avoids dragging in the lib's client since
        we want a slightly different shape (api_key optional, plain dict
        return)."""
        data = json.dumps(body).encode("utf-8")
        headers = {
            "Accept": "application/json",
            "Content-Type": "application/json",
            "User-Agent": "scruple-fusion-addin/0.1.0",
        }
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        req = urllib.request.Request(url, data=data, headers=headers, method="POST")
        with urllib.request.urlopen(req, timeout=60) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            try:
                return json.loads(raw)
            except Exception:
                return {"raw": raw}


def run(context):
    """Add-in startup hook called by Fusion."""
    _diag_ping("run_start", in_fusion=_IN_FUSION)
    if not _IN_FUSION:
        return
    ui = None
    try:
        global _palette, _auto_witness_thread, _url_scheme_server
        app = adsk.core.Application.get()
        ui = app.userInterface

        # palette_ref is a 1-element list so handlers can capture a stable
        # reference to the palette even though we may swap it later.
        palette_ref = [None]

        # 1. Mount the palette.
        _palette = palette_host.create_palette(app, ui)
        palette_ref[0] = _palette
        _diag_ping("palette_mounted", palette_present=(_palette is not None))

        # 2a. documentSaved → auto-bind Scruple project on first save (using
        #     the Fusion filename as the project name), then fire witness.
        on_saved = _DocSavedHandler(app, ui)
        app.documentSaved.add(on_saved)
        _handlers.append(on_saved)

        # 2b. documentActivated → auto-bind any previously-saved design
        #     that has no Scruple binding yet. Picks up the user's
        #     existing designs organically as they open them.
        on_activated = _DocActivatedHandler(app, ui)
        app.documentActivated.add(on_activated)
        _handlers.append(on_activated)

        # 3. Register the custom event + UI-thread handler that actually
        # runs the witness flow when the daemon thread fires the tick.
        try:
            tick_event = app.registerCustomEvent(auto_witness.CUSTOM_EVENT_TICK)
        except Exception:
            tick_event = None  # Already registered (Stop+Run) — that's OK
        if tick_event is not None:
            try:
                tick_handler = _WitnessTickHandler(app, ui, palette_ref)
                tick_event.add(tick_handler)
                _handlers.append(tick_handler)
            except Exception:
                pass

        # 4. Wire palette → Python messages.
        if _palette is not None:
            _diag_ping("registering_msg_handler")
            try:
                msg_handler = _PaletteMsgHandler(app, ui, palette_ref)
                _palette.incomingFromHTML.add(msg_handler)
                _handlers.append(msg_handler)
                _diag_ping("msg_handler_registered")
            except Exception as e:
                _diag_ping("msg_handler_registration_failed", error=str(e))
                try:
                    ui.messageBox(
                        "Scruple: palette message bridge failed to register.\n"
                        "UI displays but action buttons won't reach Python.\n\n"
                        + traceback.format_exc()
                    )
                except Exception:
                    pass
        else:
            _diag_ping("no_palette_for_msg_handler")

        # 5. UI commands + toolbar panel with Scruple / Witness / Lock buttons
        # in the Design workspace toolbar.
        palette_host.install_ui_commands(app, ui, _handlers)
        _install_toolbar(app, ui, palette_ref)

        # 6. Start the ambient auto-witness loop (5-min default).
        _auto_witness_thread = auto_witness.start(app, ui, _palette)

        # 6b. Hook commandTerminated → witness on every timeline growth.
        # This is the "witness every edit" behavior — every extrude,
        # fillet, sketch, etc. that adds a node to the timeline fires
        # an immediate witness. Non-timeline commands (zoom, orbit,
        # selection) don't trigger because timeline.count doesn't change.
        try:
            cmd_handler = _CommandTerminatedHandler(app)
            app.commandTerminated.add(cmd_handler)
            _handlers.append(cmd_handler)
        except Exception:
            pass

        # 7. Register custom URL scheme handler (for payment callbacks).
        _url_scheme_server = palette_host.register_url_scheme_handler(app, ui, _palette)

    except Exception:
        if ui is not None:
            try:
                ui.messageBox(
                    'Scruple add-in failed to start:\n\n' + traceback.format_exc()
                )
            except Exception:
                pass


def stop(context):
    """Add-in shutdown hook."""
    if not _IN_FUSION:
        return
    try:
        global _palette, _auto_witness_thread, _url_scheme_server
        if _auto_witness_thread is not None:
            auto_witness.stop(_auto_witness_thread)
            _auto_witness_thread = None
        if _url_scheme_server is not None:
            try:
                _url_scheme_server.stop()
            except Exception:
                pass
            _url_scheme_server = None
        if _palette is not None:
            try:
                _palette.deleteMe()
            except Exception:
                pass
            _palette = None
        _handlers.clear()
        palette_host.uninstall_ui_commands()
        try:
            app = adsk.core.Application.get()
            _uninstall_toolbar(app.userInterface)
        except Exception:
            pass
    except Exception:
        pass
