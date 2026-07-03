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

    class _DocSavedHandler(adsk.core.DocumentEventHandler):
        """documentSaved → fires the same custom event the auto-witness loop
        uses, so there's one chokepoint for the actual witness call."""
        def __init__(self, app):
            super().__init__()
            self._app = app

        def notify(self, args):
            try:
                self._app.fireCustomEvent(auto_witness.CUSTOM_EVENT_TICK)
            except Exception:
                pass

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

    def _prompt_and_bind_project(app, ui):
        """If no Scruple project is bound to the active design, prompt the
        user for a project name, create the project on the server, write
        the project_id + pre_scr_id back to design.attributes, and force
        Parametric mode. Idempotent — no-op if already bound.

        Called on first successful set_api_key (so we have credentials).
        """
        try:
            client = _client_for(_state)
            if client is None:
                return None
            design = adsk.fusion.Design.cast(app.activeProduct)
            if design is None:
                return None
            existing = design.attributes.itemByName("Scruple", "project_id")
            if existing and existing.value:
                # Already bound — just ensure parametric + reset command counter.
                _ensure_parametric(design, ui)
                return int(existing.value)

            default_name = ""
            try:
                default_name = app.activeDocument.name or ""
            except Exception:
                pass
            default_name = default_name or "My Fusion project"

            (name_input, cancelled) = ui.inputBox(
                "Enter a project name for Scruple to track this design under. "
                "Every save and every feature you add will be witnessed and "
                "chained under this name.",
                "Scruple Studio for Fusion — Start tracking",
                default_name,
            )
            if cancelled:
                return None
            name = (name_input or "").strip() or default_name

            _ensure_parametric(design, ui)

            proj = client.create_project(name=name, kind="cad")
            pid = int(proj.get("id"))
            pre_scr_id = proj.get("pre_scr_id") or proj.get("preScrId") or ""

            design.attributes.add("Scruple", "project_id", str(pid))
            design.attributes.add("Scruple", "project_name", name)
            if pre_scr_id:
                design.attributes.add("Scruple", "pre_scr_id", pre_scr_id)

            _state.active_project_id = pid

            summary = (
                f"Scruple is now tracking this design.\n\n"
                f"Project: {name}\n"
                f"Project ID: {pid}\n"
            )
            if pre_scr_id:
                summary += f"SCR-ID (pre-lock): {pre_scr_id}\n"
            summary += (
                "\nEvery command that adds to the timeline will be witnessed.\n"
                "Save (Ctrl+S) any time to force an immediate witness."
            )
            ui.messageBox(summary, "Scruple — Tracking started")
            return pid
        except Exception:
            try:
                ui.messageBox(
                    "Scruple project setup failed:\n\n" + traceback.format_exc()
                )
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
                data = {}
                if args.data:
                    try:
                        data = json.loads(args.data)
                    except Exception:
                        pass

                if action == "set_api_key":
                    key = (data.get("key") or "").strip()
                    if key.startswith("sk_"):
                        was_none = _state.api_key is None
                        _state.api_key = key
                        # First time we get an API key → check if the
                        # active design needs a Scruple project name.
                        if was_none:
                            _prompt_and_bind_project(self._app, self._ui)

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

        # 2. documentSaved → fires the witness tick custom event.
        on_saved = _DocSavedHandler(app)
        app.documentSaved.add(on_saved)
        _handlers.append(on_saved)

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
            try:
                msg_handler = _PaletteMsgHandler(app, ui, palette_ref)
                _palette.incomingFromHTML.add(msg_handler)
                _handlers.append(msg_handler)
            except Exception:
                try:
                    ui.messageBox(
                        "Scruple: palette message bridge failed to register.\n"
                        "UI displays but action buttons won't reach Python.\n\n"
                        + traceback.format_exc()
                    )
                except Exception:
                    pass

        # 5. UI commands (toolbar panel + buttons) — stub until probe 5.6.
        palette_host.install_ui_commands(app, ui, _handlers)

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
    except Exception:
        pass
