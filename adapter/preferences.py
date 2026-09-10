"""AddonPreferences -- the addon's Settings UI.

gap.json, modules row 9, verdict "split": the SDK's `Preferences` is a
26-line dataclass holding base_url/timeout, and its docstring says
"Rendering a settings panel is the adapter's job". The
`bpy.types.AddonPreferences` subclass and its `draw()` are that job and
stay here. What went is the duplicated auth-cache read: `get_api_key()`
and `get_base_url()` used to open `~/.scruple/blender-auth.json`
themselves through lib/auth.py; they now read the SDK's cache, which is
the same file for host "blender" and the only implementation left.

⚑ WO-F1 closed finding E7-2, which was two defects in this file with one
cause -- the addon assuming things nobody had told it. `bl_idname` was the
legacy module name, so on the manifest install path Blender bound no
preferences object at all and there was no field to set; and with no field
to set, `get_base_url()` filled the blank with the SDK's default, which is
production. `addon_module_name()` answers the first and the missing
fallback in `get_base_url()` answers the second. They belong together: a
setting nobody can reach and a default nobody chose are the same failure
seen from two ends.
"""

from __future__ import annotations

import os
import sys
from typing import Any, Optional

from . import ADDON_ROOT
from . import log as _log
from . import sdk as _sdk

from scruple_host_sdk import auth as _auth

#: The module name Blender uses on the LEGACY `scripts/addons/` path, and
#: the only one this file used to know about. It is a fallback now, not an
#: answer: see `addon_module_name()`.
LEGACY_ADDON_KEY = "scruple_blender"

try:
    import bpy
except ImportError:
    bpy = None


def addon_module_name() -> str:
    """The module name Blender enabled THIS addon under.

    ⚑ WO-F1 / finding E7-2. `bpy.types.AddonPreferences` is matched to an
    addon by `bl_idname == that module name`, and the name is decided by the
    INSTALL PATH, not by us:

        legacy `scripts/addons/`   -> `scruple_blender`
        blender_manifest.toml      -> `bl_ext.user_default.scruple_blender`

    The class hardcoded the first one, so on the path every 4.2+ user gets
    (and the only one WO-E3 made work) Blender never bound the class and
    `addons[module].preferences` was None -- no API key field, no base URL
    field, no verbose toggle.

    Resolved rather than hardcoded, and resolved from the addon's OWN
    `__init__.py` rather than from `__package__`: every module in this
    package is imported top-level (`from adapter import ...`, off the
    `sys.path` entry `__init__.py` adds), so `__package__` here is the
    literal `"adapter"` on both paths and would answer neither question.
    What does differ between the paths is the name the root `__init__.py`
    is registered under in `sys.modules`, and that is exactly the name
    Blender enabled.

    Called at `register()` time, not at import time, so it does not depend
    on which module imported this one first.
    """
    root_init = os.path.join(ADDON_ROOT, "__init__.py")
    # `__main__` is `blender --python __init__.py`; `__init__` is how the
    # pytest suite reaches the entry point (`import __init__ as addon`).
    # Neither is a name Blender ever enables an addon under, and letting
    # one win would key the class to a module that has no preferences.
    ignore = ("__main__", "__init__")
    matches = [
        name
        for name, mod in list(sys.modules.items())
        if name not in ignore
        and getattr(mod, "__file__", None)
        and os.path.abspath(mod.__file__) == root_init
    ]
    if not matches:
        # Imported outside Blender -- the test suite, or a probe. There is
        # no enabled addon to be keyed by; the legacy name is the honest
        # answer and it is what the class has always carried.
        return LEGACY_ADDON_KEY
    if len(matches) > 1 and bpy is not None:
        # Both install paths live in one process. Prefer whichever one
        # Blender actually has enabled; a class can only bind to one.
        enabled = [n for n in matches if bpy.context.preferences.addons.get(n) is not None]
        if enabled:
            return enabled[0]
    return matches[0]


def _addon_prefs() -> Optional[Any]:
    """Return the addon's preferences object, or None outside Blender."""
    if bpy is None:
        return None
    prefs = bpy.context.preferences.addons.get(addon_module_name())
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
    """The API base URL somebody configured, or `""` when nobody has.

    ⚑ WO-F1 / finding E7-2, second half. This used to fall through to the
    SDK's `DEFAULT_BASE_URL`, which is `https://scruple.ai` -- PRODUCTION.
    Combined with the unbound preferences above, that meant an addon whose
    base URL nobody could set silently pointed at the live service: a user
    who never named a server got one anyway, and a developer on a sandbox
    got production the moment the auth cache was missing a `base_url`.

    "Nothing configured" now yields nothing, and every caller refuses. An
    absent setting and a setting that happens to equal the default are
    different facts and they no longer read the same -- the same
    distinction WO-E2 drew between an empty declaration and an absent one.

    Production is still one paste away; it is a value the user states, not
    one this code assumes.
    """
    p = _addon_prefs()
    if p is not None and getattr(p, "base_url", ""):
        return p.base_url.strip().rstrip("/")
    cached = _auth.load_cached(_sdk.HOST)
    return (cached.get("base_url") or "").strip().rstrip("/")


def is_configured() -> bool:
    """Has anyone named a server? Callers that are about to make a network
    call ask this and refuse rather than inventing a host."""
    return bool(get_base_url())


#: What a caller says when it refuses for want of a base URL. One string,
#: so the panel, the operators and the session client cannot drift.
NO_BASE_URL_MESSAGE = (
    "No Scruple API base URL is set. Open Preferences > Add-ons > Scruple "
    "and set it (production is https://scruple.ai)."
)


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
        # Overwritten in register() with `addon_module_name()`. The literal
        # here is only what the class carries before it is registered --
        # keeping it a valid string means the class stands on its own in
        # the test suite, where there is no enabled addon to be keyed by.
        bl_idname = LEGACY_ADDON_KEY

        base_url: bpy.props.StringProperty(
            name="Scruple API base URL",
            description=(
                "Root of the Scruple API -- https://scruple.ai for the live "
                "service, or your own host. Empty means Scruple contacts nothing."
            ),
            default="",
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
            if not get_base_url():
                # WO-F1: an unset base URL is a refusal, not a silent
                # default. Say which value the live service is rather than
                # quietly being it.
                box.label(text="No base URL set -- Scruple contacts nothing.", icon="ERROR")
                box.label(text="Live service: https://scruple.ai")
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
        # ⚑ WO-F1. THE ONE LINE. Blender matches AddonPreferences to an
        # addon by bl_idname, and which module name that has to be is a
        # property of the install path, known only now.
        ScrupleAddonPreferences.bl_idname = addon_module_name()
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
