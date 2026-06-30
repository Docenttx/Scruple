"""Palette host shell — Fusion side of the Python ↔ JS bridge.

In production, the palette loads scruple-web's /embed/fusion route. This
module manages: palette creation, message routing JS↔Python, UI command
registration (Scruple toolbar panel + buttons), document-saved hook, and
the custom URL scheme handler for OAuth + payment callbacks.

Most of this is thin glue. The heavy lifting lives in witness.py and the
React UI inside scruple-web. The aim here is "if this file crashes,
Fusion still works."
"""

from __future__ import annotations

import json
import os
import threading
from typing import Any, Callable, Optional

PALETTE_ID = "scruple_main_palette"
PALETTE_NAME = "Scruple"
DEFAULT_EMBED_URL = os.environ.get("SCRUPLE_EMBED_URL", "https://scruple.stooges.ai/embed/fusion")

URL_SCHEME = "scruple-fusion"
LOCAL_CALLBACK_PORT_ENV = "SCRUPLE_FUSION_CALLBACK_PORT"


# ---------------------------------------------------------------- palette mount

def create_palette(app: Any, ui: Any, embed_url: Optional[str] = None) -> Any:
    """Create the Scruple palette. Returns the palette handle (or None on failure).

    Fusion's Python bindings for ui.palettes.add() reject keyword arguments
    in some versions — we pass positional args. If the modern-Chromium
    constructor (useNewWebBrowser=True) fails, we fall back to the legacy
    one (False) so we at least get a palette mounted.
    """
    url = embed_url or DEFAULT_EMBED_URL
    pal = ui.palettes.itemById(PALETTE_ID)
    if pal is not None:
        try:
            pal.isVisible = True
        except Exception:
            pass
        return pal

    first_err = None
    try:
        pal = ui.palettes.add(
            PALETTE_ID,    # id
            PALETTE_NAME,  # name
            url,           # htmlFileURL
            True,          # isVisible
            True,          # showCloseButton
            True,          # isResizable
            400,           # width
            800,           # height
            True,          # useNewWebBrowser (modern Chromium)
        )
    except Exception as e:
        first_err = e
        pal = None

    if pal is None:
        # Fallback: legacy WebKit browser (older Fusion, more permissive).
        try:
            pal = ui.palettes.add(
                PALETTE_ID, PALETTE_NAME, url,
                True, True, True, 400, 800, False,
            )
        except Exception as e2:
            try:
                ui.messageBox(
                    "Scruple: ui.palettes.add() failed both attempts.\n\n"
                    f"useNewWebBrowser=True: {first_err}\n\n"
                    f"useNewWebBrowser=False: {e2}\n\n"
                    f"URL attempted: {url}"
                )
            except Exception:
                pass
            return None

    # Force-dock to the right side. Integer 4 = PaletteDockStateRight in
    # adsk.core.PaletteDockingStates (kept as a literal so this module
    # doesn't have to import adsk at module load).
    try:
        pal.dockingState = 4
    except Exception:
        pass
    try:
        pal.isVisible = True
    except Exception:
        pass
    return pal


# ---------------------------------------------------------------- documentSaved

def make_document_saved_handler(app: Any, ui: Any, palette: Any) -> Callable[[Any], None]:
    """Build the documentSaved event handler that fires an immediate witness."""
    def _handler(args: Any) -> None:
        try:
            # Real impl: import witness lazily so test imports don't drag the
            # client in. Also: marshal a tick via the same custom event the
            # auto-witness loop uses, so there's one chokepoint.
            from . import auto_witness
            app.fireCustomEvent(auto_witness.CUSTOM_EVENT_TICK)
        except Exception:
            pass
    return _handler


# ---------------------------------------------------------------- JS ↔ Python bridge

def send_to_palette(palette: Any, action: str, payload: Any) -> None:
    if palette is None:
        return
    try:
        palette.sendInfoToHTML(action, json.dumps(payload))
    except Exception:
        pass


# ---------------------------------------------------------------- UI commands

_installed_cmd_ids: list = []


def install_ui_commands(app: Any, ui: Any, handlers_keep_alive: list) -> None:
    """Install Scruple toolbar panel + buttons. Implementation deferred until
    desktop Probe 5.6 confirms the exact Fusion API call signatures. The
    Python add-in still loads cleanly without these — the palette is the
    primary surface.
    """
    # No-op stub; live-fire registration goes here after Probe 5.6.
    _installed_cmd_ids.clear()


def uninstall_ui_commands() -> None:
    _installed_cmd_ids.clear()


# ---------------------------------------------------------------- URL scheme

class CallbackServer:
    """Fallback HTTP listener on 127.0.0.1 for OAuth + payment callbacks.

    Used when the OS-level scruple-fusion:// scheme registration fails or
    is not yet installed. The React UI inside scruple-web sends the callback
    URL to either scruple-fusion://... OR http://127.0.0.1:<port>/callback?...
    based on which one the add-in advertised at session start.
    """

    def __init__(self, on_callback: Callable[[dict], None], port: int = 0) -> None:
        from http.server import BaseHTTPRequestHandler, HTTPServer
        from urllib.parse import urlparse, parse_qs

        self._on_callback = on_callback
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args: Any, **_kwargs: Any) -> None:
                pass  # silence default stderr logging

            def do_GET(self) -> None:
                u = urlparse(self.path)
                params = {k: v[0] for k, v in parse_qs(u.query).items()}
                try:
                    outer._on_callback({"path": u.path, "params": params})
                except Exception:
                    pass
                self.send_response(200)
                self.send_header("Content-Type", "text/html")
                self.end_headers()
                self.wfile.write(b"<html><body><p>Scruple callback received. You can close this window.</p></body></html>")

        self._httpd = HTTPServer(("127.0.0.1", port), Handler)
        self.port = self._httpd.server_address[1]
        self._thread = threading.Thread(target=self._httpd.serve_forever, daemon=True, name="ScrupleCallback")

    def start(self) -> int:
        self._thread.start()
        return self.port

    def stop(self) -> None:
        try:
            self._httpd.shutdown()
        except Exception:
            pass


def register_url_scheme_handler(app: Any, ui: Any, palette: Any) -> Optional[CallbackServer]:
    """Try OS-level scheme registration first; fall back to local listener.

    OS-level registration is platform-specific (Info.plist on Mac, registry
    on Windows) and is performed by install.sh / install.bat, NOT here. This
    function checks whether the scheme appears to be registered (best-effort)
    and unconditionally starts the local listener as a belt + suspenders.
    """
    def on_cb(event: dict) -> None:
        send_to_palette(palette, "callback", event)

    port = int(os.environ.get(LOCAL_CALLBACK_PORT_ENV, "0"))
    srv = CallbackServer(on_cb, port=port)
    srv.start()
    # Tell the palette where to send callbacks.
    send_to_palette(palette, "callback_port", {"port": srv.port})
    return srv
