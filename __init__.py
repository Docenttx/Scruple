"""Scruple for Blender — addon entry point.

Ships both the modern Extensions manifest (`blender_manifest.toml`, 4.2+)
and the classic `bl_info` block below so 3.x, 4.0, and 4.1 users can
install the same zip as a legacy addon. On 4.2+ the manifest wins and
this dict is ignored.
"""

bl_info = {
    "name": "Scruple",
    "author": "Docent LLC (dba Docent Technologies)",
    "version": (0, 1, 0),
    "blender": (3, 6, 0),
    "location": "View3D > N-Panel > Scruple",
    "description": "Provenance, C2PA, and chain-lock for Blender renders, saves, and exports.",
    "warning": "",
    "doc_url": "https://scruple.ai",
    "tracker_url": "https://scruple.ai/support",
    "support": "COMMUNITY",
    "category": "Pipeline",
}

import os
import sys

_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
if _THIS_DIR not in sys.path:
    sys.path.insert(0, _THIS_DIR)

# `vendor/` carries scruple_host_sdk and scruple_api -- Blender installs a
# zip, not a wheel, so there is no pip step in which they could be
# resolved. `adapter/__init__.py` puts that directory on sys.path ahead
# of everything else, so `import scruple_host_sdk` anywhere in this addon
# resolves to the copy in this zip and not to whatever else the host
# interpreter happens to have. vendor/VENDOR.json records the commit it
# came from.

_MODULES = None


def _load_modules():
    global _MODULES
    if _MODULES is not None:
        return _MODULES
    from adapter import preferences as _prefs
    from adapter import handlers as _handlers
    from adapter import host_hook as _host_hook
    from panels import main as _panel_main
    from operators import (
        auth as _op_auth,
        witness as _op_witness,
        witness_export as _op_witness_export,
        verify as _op_verify,
        reconcile as _op_reconcile,
        checkpoint as _op_checkpoint,
        c2pa as _op_c2pa,
        chain_lock as _op_chain,
        open_receipt as _op_receipt,
        payment_setup as _op_payment,
        resume_payment as _op_resume,
        dashboard as _op_dashboard,
        host_hook as _op_host_hook,
        # WO-G5. The no-AI claim: take a baseline of the add-on set (§4), and ask
        # what source type this scene's record supports.
        claim as _op_claim,
    )
    _MODULES = {
        "preferences": _prefs,
        "handlers": _handlers,
        "host_hook": _host_hook,
        "panel_main": _panel_main,
        "op_auth": _op_auth,
        "op_witness": _op_witness,
        "op_witness_export": _op_witness_export,
        "op_verify": _op_verify,
        "op_reconcile": _op_reconcile,
        "op_checkpoint": _op_checkpoint,
        "op_c2pa": _op_c2pa,
        "op_chain": _op_chain,
        "op_receipt": _op_receipt,
        "op_payment": _op_payment,
        "op_resume": _op_resume,
        "op_dashboard": _op_dashboard,
        "op_host_hook": _op_host_hook,
        "op_claim": _op_claim,
    }
    return _MODULES


def register():
    m = _load_modules()
    m["preferences"].register()
    m["op_auth"].register()
    m["op_witness"].register()
    m["op_witness_export"].register()
    m["op_verify"].register()
    m["op_reconcile"].register()
    m["op_checkpoint"].register()
    m["op_c2pa"].register()
    m["op_chain"].register()
    m["op_receipt"].register()
    m["op_payment"].register()
    m["op_resume"].register()
    # Before the panel: its regions draw these operators, and a panel
    # that references an unregistered operator id is a broken button.
    m["op_dashboard"].register()
    m["op_host_hook"].register()
    m["op_claim"].register()
    m["panel_main"].register()
    m["handlers"].register()
    # WO-E4. THE ADDON DECLARES ITSELF AS A LEVEL-2 HOST ADAPTER, here,
    # at enable time, because HOST-HOOK.md says registration is static and
    # build-time and this is the latest moment that is still true of.
    #
    # ⚑ It writes NOTHING unless SCRUPLE_COMFY_HOST_DIR is set, which only
    # Desktop Studio sets. A standalone Blender enables this addon and no
    # file appears anywhere: the two products stay mirrored, and this is
    # the one `if` that keeps them so.
    #
    # It cannot fail the enable. `declare()` returns a result and raises
    # nothing -- a host integration that cannot be set up must not take the
    # host down, which is the same rule the gate follows when it refuses a
    # declaration and carries on at Level 1.
    m["host_hook"].declare()


def unregister():
    m = _load_modules()
    m["handlers"].unregister()
    m["panel_main"].unregister()
    m["op_claim"].unregister()
    m["op_host_hook"].unregister()
    m["op_dashboard"].unregister()
    m["op_resume"].unregister()
    m["op_payment"].unregister()
    m["op_receipt"].unregister()
    m["op_chain"].unregister()
    m["op_c2pa"].unregister()
    m["op_checkpoint"].unregister()
    m["op_reconcile"].unregister()
    m["op_verify"].unregister()
    m["op_witness_export"].unregister()
    m["op_witness"].unregister()
    m["op_auth"].unregister()
    m["preferences"].unregister()


if __name__ == "__main__":
    register()
