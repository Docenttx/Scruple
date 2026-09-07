"""AddonPreferences -- the addon's Settings UI.

gap.json, modules row 9, verdict "split": the SDK's `Preferences` is a
26-line dataclass holding base_url/timeout, and its docstring says
"Rendering a settings panel is the adapter's job". The
`bpy.types.AddonPreferences` subclass and its `draw()` are that job and
stay here. What went is the duplicated auth-cache read: `get_api_key()`
and `get_base_url()` used to open `~/.scruple/blender-auth.json`
themselves through lib/auth.py; they now read the SDK's cache, which is
the same file for host "blender" and the only implementation left.
"""

from __future__ import annotations

from typing import Any, Optional

from . import log as _log
from . import sdk as _sdk

from scruple_host_sdk import auth as _auth
from scruple_host_sdk.preferences import DEFAULT_BASE_URL

ADDON_KEY = "scruple_blender"

try:
    import bpy
except ImportError:
    bpy = None


def _addon_prefs() -> Optional[Any]:
    """Return the addon's preferences object, or None outside Blender."""
    if bpy is None:
        return None
    prefs = bpy.context.preferences.addons.get(ADDON_KEY)
    if prefs is None:
        return None
    return prefs.preferences


def get_api_key() -> str:
    p = _addon_prefs()
    if p is not None and getattr(p, "api_key", ""):
        return p.api_key.strip()
    cached = _auth.load_cached(_sdk.HOST)
    return (cached.get("api_key") or "").strip()


def get_base_url() -> str:
    p = _addon_prefs()
    if p is not None and getattr(p, "base_url", ""):
        return p.base_url.strip().rstrip("/")
    cached = _auth.load_cached(_sdk.HOST)
    return (cached.get("base_url") or DEFAULT_BASE_URL).strip().rstrip("/")


def is_authed() -> bool:
    return bool(get_api_key())


def sync_from_cache() -> None:
    """Push the disk-cached key/base into the live prefs object so the UI
    reflects what the sign-in handshake wrote out-of-band."""
    p = _addon_prefs()
    if p is None:
        return
    cached = _auth.load_cached(_sdk.HOST)
    key = cached.get("api_key") or ""
    if key and not p.api_key:
        p.api_key = key
    base = cached.get("base_url") or ""
    if base and not p.base_url:
        p.base_url = base


if bpy is not None:

    class ScrupleAddonPreferences(bpy.types.AddonPreferences):
        bl_idname = ADDON_KEY

        base_url: bpy.props.StringProperty(
            name="Scruple API base URL",
            description="Root of the Scruple API. Only change for staging/dev.",
            default=DEFAULT_BASE_URL,
        )

        api_key: bpy.props.StringProperty(
            name="API key",
            description="Bearer token used to talk to Scruple. Set by Sign in, or paste manually.",
            default="",
            subtype="PASSWORD",
        )

        verbose_logging: bpy.props.BoolProperty(
            name="Verbose logging",
            description="Print full trace of handler dispatches and HTTP requests to the console.",
            default=False,
            update=lambda self, ctx: _log.set_verbose(self.verbose_logging),
        )

        def draw(self, context):
            layout = self.layout

            box = layout.box()
            row = box.row()
            row.label(text="Account", icon="USER")
            row = box.row()
            if is_authed():
                row.label(text="Signed in", icon="CHECKMARK")
                row.operator("scruple.sign_out", text="Sign out")
            else:
                row.label(text="Not signed in", icon="ERROR")
                row.operator("scruple.sign_in", text="Sign in")
            row = box.row()
            row.prop(self, "api_key")

            box = layout.box()
            box.label(text="Payment", icon="FUND")
            row = box.row()
            row.operator(
                "scruple.setup_payment",
                text="Set up payment on scruple.ai",
                icon="URL",
            )
            box.label(
                text="Blender never sees your card. Payment lives on scruple.ai.",
                icon="INFO",
            )

            box = layout.box()
            box.label(text="Advanced", icon="PREFERENCES")
            box.prop(self, "base_url")
            box.prop(self, "verbose_logging")

            # Which SDK build this addon is actually running. A vendored
            # copy with no traceable source is the thing VENDOR.json
            # exists to prevent, so it is shown, not buried.
            info = _sdk.vendored_sdk_info()
            box = layout.box()
            box.label(text="Scruple SDK", icon="SCRIPT")
            if info:
                commit = (info.get("source_commit") or "")[:12] or "unknown"
                box.label(text=f"scruple-host-sdk @ {commit}")
                box.label(text=f"vendored {info.get('vendored_at', 'unknown')}")
            else:
                box.label(text="vendor/VENDOR.json missing", icon="ERROR")

    _CLASSES = (ScrupleAddonPreferences,)

    def register():
        for cls in _CLASSES:
            bpy.utils.register_class(cls)
        sync_from_cache()
        _log.set_verbose(bool(getattr(_addon_prefs(), "verbose_logging", False)))

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
