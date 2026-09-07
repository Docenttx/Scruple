"""The seam between Blender and `scruple_host_sdk`.

One Client per Blender session, not one per call. The old code built a
fresh `ScrupleClient` on every operator invocation and kept its own
module-global `AddonState` alongside; under the SDK the session state
(baseline_ref, the receipt history, the capabilities cache) lives ON the
Client, so a client rebuilt per call would forget its baseline and
re-`attach()` on every render. The singleton here is keyed by
(base_url, api_key): change either in preferences and the next call
builds a new Client, which is the correct behaviour -- a different key
is a different session.

This module is also the only place that reads `vendor/VENDOR.json`, so
"which SDK build is this addon actually running" has one answer and the
panel and the tests read the same one.
"""

from __future__ import annotations

import json
import os
from typing import Any, Dict, Optional

from . import ADDON_ROOT, VENDOR_DIR  # noqa: F401  (import puts vendor/ on sys.path)
from . import log as _log

import scruple_host_sdk
from scruple_host_sdk import Client

HOST = "blender"

_VERSION_FILE = os.path.join(ADDON_ROOT, "VERSION")
_MANIFEST_FILE = os.path.join(VENDOR_DIR, "VENDOR.json")

# Files whose bytes ARE this build of the integration (D-3 / Standard §4:
# what changed about the *integration*, not about the user's project).
# vendor/ is in here on purpose -- the SDK ships inside the addon, so a
# different SDK build is a different integration and must produce a
# different baseline.
TAMPER_SURFACE_PATHS = (
    os.path.join(ADDON_ROOT, "__init__.py"),
    os.path.join(ADDON_ROOT, "adapter"),
    os.path.join(ADDON_ROOT, "operators"),
    os.path.join(ADDON_ROOT, "panels"),
    VENDOR_DIR,
)


def integration_version() -> str:
    try:
        with open(_VERSION_FILE, "r", encoding="utf-8") as f:
            return f.read().strip() or "0.0.0"
    except OSError:
        return "0.0.0"


def vendored_sdk_info() -> Dict[str, Any]:
    """What vendor/VENDOR.json says about the SDK copy in this build --
    source commit, when it was taken, how many files. Empty dict if the
    manifest is missing, which for an installed addon means somebody
    assembled the zip by hand."""
    try:
        with open(_MANIFEST_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def sdk_module_file() -> str:
    """Absolute path of the `scruple_host_sdk` package actually imported
    in this process. Asserted against VENDOR_DIR in the test suite."""
    return os.path.abspath(scruple_host_sdk.__file__)


def sdk_is_vendored() -> bool:
    return sdk_module_file().startswith(os.path.join(VENDOR_DIR, ""))


# ---- the session Client ------------------------------------------------

_CLIENT: Optional[Client] = None
_CLIENT_KEY: Optional[tuple] = None
_PINNED = False


def new_client(
    *,
    base_url: str,
    api_key: Optional[str],
    opener: Optional[Any] = None,
    cache_dir: Optional[str] = None,
) -> Client:
    """Construct a Client without touching the singleton. Tests use this;
    so does anything that needs a second session deliberately."""
    return Client(
        host=HOST,
        integration_version=integration_version(),
        api_key=api_key,
        base_url=base_url,
        opener=opener,
        cache_dir=cache_dir,
    )


def get_client() -> Optional[Client]:
    """The session Client, or None when the user is not signed in.

    Returning None rather than an unauthenticated Client is deliberate:
    every caller already has a "not signed in" branch to show, and a
    Client with no key would fail later, in a worker thread, as a 401.
    """
    global _CLIENT, _CLIENT_KEY

    if _PINNED and _CLIENT is not None:
        # Somebody installed a Client deliberately -- the test suite
        # pointing the addon at a MockOpener, or a caller that built one
        # with new_client(). Rebuilding it from preferences here would
        # silently throw away that opener (and the baseline and queue
        # that go with it), so a pinned client wins until reset.
        return _CLIENT

    from . import preferences as _prefs  # late: preferences imports bpy

    api_key = _prefs.get_api_key()
    if not api_key:
        return None
    base_url = _prefs.get_base_url()

    key = (base_url, api_key)
    if _CLIENT is None or _CLIENT_KEY != key:
        _CLIENT = new_client(base_url=base_url, api_key=api_key)
        _CLIENT_KEY = key
        _log.info(f"sdk: new session client for {base_url} (queue={_CLIENT.queue.path})")
    return _CLIENT


def peek_client() -> Optional[Client]:
    """The session Client if one has already been built, without building
    one. The panel draws on every mouse move; it must not construct a
    Client (and read the key off disk) to render a label."""
    return _CLIENT


def set_client(client: Optional[Client], *, key: Optional[tuple] = None) -> None:
    """Install a Client as THE session client, pinning it: `get_client()`
    returns it as-is rather than rebuilding from preferences. The test
    suite's way of pointing the addon at a MockOpener, and how a caller
    that built one with `new_client()` adopts it. `reset_client()`
    unpins."""
    global _CLIENT, _CLIENT_KEY, _PINNED
    _CLIENT = client
    _CLIENT_KEY = key if client is not None else None
    _PINNED = client is not None


def reset_client() -> None:
    set_client(None)
