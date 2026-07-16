"""Auth handshake for Scruple.

Two paths are supported and both write into the same on-disk cache so the
rest of the addon reads a single source of truth.

  1. URL scheme (`scruple://blender-auth?key=sk_...`) — the browser
     handoff after the user clicks "Sign in" on scruple.ai. Requires OS
     registration of the scheme; on macOS and Windows the installer
     handles it, on Linux most desktops accept an xdg-mime association.

  2. Local HTTP callback (`http://127.0.0.1:<port>/callback?key=sk_...`).
     Always works, no OS-level registration. This is the primary path on
     Linux and the fallback path everywhere else. A one-shot
     `http.server` is started, the browser is opened at the scruple.ai
     sign-in URL with `redirect=` pointing at us, and the server exits
     the moment a key arrives (or after the timeout).

Both paths persist the key at `~/.scruple/blender-auth.json` with mode
0600. On startup the addon reads that file and skips the sign-in dance
if a key is present.
"""

from __future__ import annotations

import json
import os
import socket
import stat
import threading
import time
import urllib.parse
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any, Callable, Dict, Optional

from . import logging as _log

CACHE_DIR = os.path.join(os.path.expanduser("~"), ".scruple")
CACHE_FILE = os.path.join(CACHE_DIR, "blender-auth.json")

DEFAULT_CALLBACK_PORTS = (53171, 53172, 53173, 53174, 53175)
DEFAULT_TIMEOUT_SECONDS = 180


def _ensure_cache_dir() -> None:
    os.makedirs(CACHE_DIR, exist_ok=True)
    try:
        os.chmod(CACHE_DIR, stat.S_IRWXU)
    except OSError:
        pass


def load_cached() -> Dict[str, Any]:
    """Return {'api_key': ..., 'base_url': ..., 'saved_at': ...} or {}."""
    try:
        with open(CACHE_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict) and isinstance(data.get("api_key"), str):
            return data
    except (OSError, ValueError):
        pass
    return {}


def save_cached(api_key: str, base_url: Optional[str] = None) -> None:
    """Persist the auth blob with 0600 permissions."""
    _ensure_cache_dir()
    payload = {
        "api_key": api_key.strip(),
        "base_url": (base_url or "").strip() or None,
        "saved_at": int(time.time()),
    }
    tmp = CACHE_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f)
    os.replace(tmp, CACHE_FILE)
    try:
        os.chmod(CACHE_FILE, stat.S_IRUSR | stat.S_IWUSR)
    except OSError:
        pass


def clear_cached() -> None:
    try:
        os.remove(CACHE_FILE)
    except FileNotFoundError:
        pass


def _pick_port(candidates=DEFAULT_CALLBACK_PORTS) -> Optional[int]:
    for p in candidates:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            s.bind(("127.0.0.1", p))
        except OSError:
            continue
        finally:
            s.close()
        return p
    return None


class _CallbackHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(parsed.query)
        key = (qs.get("key") or [""])[0].strip()
        if key.startswith("sk_"):
            self.server.received_key = key
            self._reply(200, "Scruple: signed in. You can return to Blender.")
        else:
            self._reply(400, "Missing or malformed key parameter.")

    def _reply(self, code: int, message: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        body = (
            "<!doctype html><meta charset='utf-8'>"
            "<title>Scruple</title>"
            "<style>body{font-family:sans-serif;max-width:32em;margin:6em auto;padding:0 1em;color:#222}"
            "h1{font-weight:600}code{background:#f4f4f4;padding:0 0.4em;border-radius:3px}</style>"
            f"<h1>Scruple</h1><p>{message}</p>"
        )
        self.wfile.write(body.encode("utf-8"))

    def log_message(self, fmt, *args):
        if _log.is_verbose():
            _log.info(f"auth-callback {self.address_string()} {fmt % args}")


class LocalCallbackServer:
    """One-shot HTTP server that resolves when a key arrives or timeout fires."""

    def __init__(self, port: int) -> None:
        self.port = port
        self._httpd: Optional[HTTPServer] = None
        self._thread: Optional[threading.Thread] = None
        self.received_key: Optional[str] = None

    def start(self) -> None:
        self._httpd = HTTPServer(("127.0.0.1", self.port), _CallbackHandler)
        self._httpd.received_key = None
        self._thread = threading.Thread(
            target=self._httpd.serve_forever,
            name="ScrupleAuthCallback",
            daemon=True,
        )
        self._thread.start()

    def wait(self, timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS) -> Optional[str]:
        deadline = time.time() + timeout_seconds
        while time.time() < deadline:
            if self._httpd is not None and getattr(self._httpd, "received_key", None):
                self.received_key = self._httpd.received_key
                return self.received_key
            time.sleep(0.25)
        return None

    def stop(self) -> None:
        if self._httpd is not None:
            try:
                self._httpd.shutdown()
                self._httpd.server_close()
            except Exception:
                pass
        self._httpd = None
        if self._thread is not None:
            self._thread.join(timeout=2.0)
        self._thread = None


def build_signin_url(
    base_url: str,
    callback_port: int,
    *,
    return_to: str = "blender",
) -> str:
    """URL the user's browser opens to complete the handshake."""
    params = {
        "return_to": return_to,
        "redirect": f"http://127.0.0.1:{callback_port}/callback",
    }
    return base_url.rstrip("/") + "/settings/keys/desktop?" + urllib.parse.urlencode(params)


def run_browser_handshake(
    base_url: str,
    *,
    open_browser: Callable[[str], bool] = webbrowser.open,
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
    port_candidates=DEFAULT_CALLBACK_PORTS,
) -> Optional[str]:
    """End-to-end: pick port, open URL, wait for callback, persist, return key.

    Returns None if no key arrived before the timeout. Caller shows an
    error and offers the manual-entry fallback.
    """
    port = _pick_port(port_candidates)
    if port is None:
        _log.error("no free localhost port for auth callback")
        return None
    server = LocalCallbackServer(port)
    try:
        server.start()
        url = build_signin_url(base_url, port)
        _log.info(f"auth-handshake opening {url}")
        try:
            open_browser(url)
        except Exception as e:
            _log.warn(f"webbrowser.open failed: {e}; user must paste key manually")
        key = server.wait(timeout_seconds)
    finally:
        server.stop()
    if key:
        save_cached(key, base_url=base_url)
    return key


def apply_manual_key(api_key: str, base_url: Optional[str] = None) -> bool:
    """User pasted a key into preferences. Validate the sk_ prefix, cache it."""
    api_key = (api_key or "").strip()
    if not api_key.startswith("sk_"):
        return False
    save_cached(api_key, base_url=base_url)
    return True
