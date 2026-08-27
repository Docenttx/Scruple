"""API key acquisition and storage.

Two paths, generalized from Blender's auth.py (the healthiest of the six
forks and the one this module is almost a direct port of, parametrized
by `host` instead of hardcoding "blender"):

  1. URL scheme (`scruple://<host>-auth?key=sk_...`) -- the browser
     handoff after the user clicks "Sign in" on scruple.ai. Requires OS
     registration of the scheme; installers handle it on macOS/Windows,
     xdg-mime on Linux. The adapter owns registering the scheme; this
     module only builds the sign-in URL and reads the result.

  2. Local HTTP callback (`http://127.0.0.1:<port>/callback?key=sk_...`).
     Always works, no OS registration. A one-shot `http.server` is
     started, the browser opens at scruple.ai with `redirect=` pointing
     back at it, and the server exits the moment a key arrives or the
     timeout fires.

Both paths persist the key at `~/.scruple/<host>-auth.json`.

Note on scope: this is the browser-posts-a-raw-key handshake every
existing shell already uses. It is independent of POST /v2/session/handoff
(a *handoff code* exchange for desktop apps) -- that route does not
exist on the server today (see openapi-v2.yaml's x-status and this
package's README gap note) and nothing here depends on it.

---

WHAT THE 0600 PERMISSIONS ON THE CACHE FILE PROTECT AGAINST, AND WHAT
THEY DO NOT.

The key is written with mode 0600 (owner read/write only) and is never
included in a log line or in an exception's message anywhere in this
package. That stops a key leaking through the channels that most often
leak one by accident: another local account on a shared machine reading
a world-readable file, a support bundle that includes a copy of a config
directory, or an error report pasted verbatim into a bug tracker.

It does NOT protect against a process already running as the same OS
user -- an attacker (or malicious host plugin) who can already execute
code as you can read this file, the same as any other file you own.
There is no OS keychain integration here, deliberately: this package has
no vendored dependencies to build one from, and the embedded interpreters
it targets (Blender, Meshroom, ToonBoom) differ in how much keychain
access they grant, if any. The key is not encrypted at rest. This is the
CAD shells' plaintext `%APPDATA%` file made 0600 and centralized in one
audited module -- a floor, not a vault. The custody bar this still falls
short of is described in docs/canon/L2_FLOOR.md, H-4.
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

CACHE_DIR = os.path.join(os.path.expanduser("~"), ".scruple")

DEFAULT_CALLBACK_PORTS = tuple(range(53171, 53240))
DEFAULT_TIMEOUT_SECONDS = 180


def _safe_host(host: str) -> str:
    cleaned = "".join(c for c in host if c.isalnum() or c in "-_")
    return cleaned or "host"


def _cache_file(host: str, cache_dir: Optional[str] = None) -> str:
    return os.path.join(cache_dir or CACHE_DIR, f"{_safe_host(host)}-auth.json")


class _ReusableHTTPServer(HTTPServer):
    allow_reuse_address = True


def _ensure_cache_dir(cache_dir: Optional[str] = None) -> None:
    d = cache_dir or CACHE_DIR
    os.makedirs(d, exist_ok=True)
    try:
        os.chmod(d, stat.S_IRWXU)
    except OSError:
        pass


def load_cached(host: str, *, cache_dir: Optional[str] = None) -> Dict[str, Any]:
    """Return {'api_key': ..., 'base_url': ..., 'saved_at': ...} or {}."""
    try:
        with open(_cache_file(host, cache_dir), "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict) and isinstance(data.get("api_key"), str):
            return data
    except (OSError, ValueError):
        pass
    return {}


def save_cached(
    host: str,
    api_key: str,
    base_url: Optional[str] = None,
    *,
    cache_dir: Optional[str] = None,
) -> None:
    """Persist the auth blob at 0600. Never logs or echoes `api_key`."""
    _ensure_cache_dir(cache_dir)
    payload = {
        "api_key": api_key.strip(),
        "base_url": (base_url or "").strip() or None,
        "saved_at": int(time.time()),
    }
    path = _cache_file(host, cache_dir)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f)
    os.replace(tmp, path)
    try:
        os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)
    except OSError:
        pass


def clear_cached(host: str, *, cache_dir: Optional[str] = None) -> None:
    try:
        os.remove(_cache_file(host, cache_dir))
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
            self._reply(200, "Scruple: signed in. You can return to the application.")
        else:
            self._reply(400, "Missing or malformed key parameter.")

    def _reply(self, code: int, message: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        body = (
            "<!doctype html><meta charset='utf-8'><title>Scruple</title>"
            "<style>body{font-family:sans-serif;max-width:32em;margin:6em auto;padding:0 1em;color:#222}"
            "h1{font-weight:600}</style>"
            f"<h1>Scruple</h1><p>{message}</p>"
        )
        self.wfile.write(body.encode("utf-8"))

    def log_message(self, fmt, *args):  # silence BaseHTTPRequestHandler's default stderr spam
        pass


class LocalCallbackServer:
    """One-shot HTTP server that resolves when a key arrives or timeout fires."""

    def __init__(self, port: int) -> None:
        self.port = port
        self._httpd: Optional[HTTPServer] = None
        self._thread: Optional[threading.Thread] = None
        self.received_key: Optional[str] = None

    def start(self) -> None:
        self._httpd = _ReusableHTTPServer(("127.0.0.1", self.port), _CallbackHandler)
        self._httpd.received_key = None
        self._thread = threading.Thread(target=self._httpd.serve_forever, name="ScrupleAuthCallback", daemon=True)
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


def build_signin_url(base_url: str, callback_port: int, *, host: str) -> str:
    params = {"return_to": host, "redirect": f"http://127.0.0.1:{callback_port}/callback"}
    return base_url.rstrip("/") + "/settings/keys/desktop?" + urllib.parse.urlencode(params)


def run_browser_handshake(
    base_url: str,
    host: str,
    *,
    open_browser: Callable[[str], bool] = webbrowser.open,
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
    port_candidates=DEFAULT_CALLBACK_PORTS,
    cache_dir: Optional[str] = None,
) -> Optional[str]:
    """End-to-end: pick port, open URL, wait for callback, persist, return
    key. Returns None if no key arrived before the timeout -- the caller
    shows an error and offers apply_manual_key() as a fallback."""
    port = _pick_port(port_candidates)
    if port is None:
        return None
    server = LocalCallbackServer(port)
    try:
        server.start()
        url = build_signin_url(base_url, port, host=host)
        try:
            open_browser(url)
        except Exception:
            pass  # user pastes the key manually instead
        key = server.wait(timeout_seconds)
    finally:
        server.stop()
    if key:
        save_cached(host, key, base_url=base_url, cache_dir=cache_dir)
    return key


def apply_manual_key(host: str, api_key: str, base_url: Optional[str] = None, *, cache_dir: Optional[str] = None) -> bool:
    """User pasted a key into the adapter's settings UI. Validates the
    sk_ prefix and caches it. Returns False (without persisting anything)
    on a malformed key."""
    api_key = (api_key or "").strip()
    if not api_key.startswith("sk_"):
        return False
    save_cached(host, api_key, base_url=base_url, cache_dir=cache_dir)
    return True
