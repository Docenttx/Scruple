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

_MODULES = None


def _load_modules():
    global _MODULES
    if _MODULES is not None:
        return _MODULES
    from lib import preferences as _prefs
    from lib import handlers as _handlers
    from panels import main as _panel_main
    from operators import (
        auth as _op_auth,
        witness as _op_witness,
        witness_export as _op_witness_export,
        checkpoint as _op_checkpoint,
        c2pa as _op_c2pa,
        chain_lock as _op_chain,
        open_receipt as _op_receipt,
        payment_setup as _op_payment,
        resume_payment as _op_resume,
    )
    _MODULES = {
        "preferences": _prefs,
        "handlers": _handlers,
        "panel_main": _panel_main,
        "op_auth": _op_auth,
        "op_witness": _op_witness,
        "op_witness_export": _op_witness_export,
        "op_checkpoint": _op_checkpoint,
        "op_c2pa": _op_c2pa,
        "op_chain": _op_chain,
        "op_receipt": _op_receipt,
        "op_payment": _op_payment,
        "op_resume": _op_resume,
    }
    return _MODULES


def register():
    m = _load_modules()
    m["preferences"].register()
    m["op_auth"].register()
    m["op_witness"].register()
    m["op_witness_export"].register()
    m["op_checkpoint"].register()
    m["op_c2pa"].register()
    m["op_chain"].register()
    m["op_receipt"].register()
    m["op_payment"].register()
    m["op_resume"].register()
    m["panel_main"].register()
    m["handlers"].register()


def unregister():
    m = _load_modules()
    m["handlers"].unregister()
    m["panel_main"].unregister()
    m["op_resume"].unregister()
    m["op_payment"].unregister()
    m["op_receipt"].unregister()
    m["op_chain"].unregister()
    m["op_c2pa"].unregister()
    m["op_checkpoint"].unregister()
    m["op_witness_export"].unregister()
    m["op_witness"].unregister()
    m["op_auth"].unregister()
    m["preferences"].unregister()


if __name__ == "__main__":
    register()
