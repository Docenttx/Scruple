"""Sign-in / sign-out operators.

Sign-in triggers the browser handshake. On success the API key is
persisted to disk and pushed into the live preferences so the panel
updates without a Blender restart.
"""

from __future__ import annotations

import threading
from typing import Optional

try:
    import bpy
except ImportError:
    bpy = None

from lib import auth as _auth
from lib import logging as _log
from lib import preferences as _prefs


def _run_signin(base_url: str, on_done):
    def _thread():
        key = _auth.run_browser_handshake(base_url)
        on_done(key)
    threading.Thread(target=_thread, name="ScrupleSignIn", daemon=True).start()


if bpy is not None:

    class SCRUPLE_OT_sign_in(bpy.types.Operator):
        bl_idname = "scruple.sign_in"
        bl_label = "Sign in to Scruple"
        bl_description = "Open the browser to sign in; the key returns via a local callback"

        def execute(self, context):
            base_url = _prefs.get_base_url()
            self.report({"INFO"}, "Opening browser to sign in to Scruple...")

            def _on_done(key: Optional[str]) -> None:
                if not key:
                    return
                p = _prefs._addon_prefs()
                if p is not None:
                    p.api_key = key
                _log.info("sign-in: key received and cached")

            _run_signin(base_url, _on_done)
            return {"FINISHED"}

    class SCRUPLE_OT_sign_out(bpy.types.Operator):
        bl_idname = "scruple.sign_out"
        bl_label = "Sign out of Scruple"
        bl_description = "Remove the cached API key from disk and clear the preferences slot"

        def execute(self, context):
            _auth.clear_cached()
            p = _prefs._addon_prefs()
            if p is not None:
                p.api_key = ""
            self.report({"INFO"}, "Signed out.")
            return {"FINISHED"}

    _CLASSES = (SCRUPLE_OT_sign_in, SCRUPLE_OT_sign_out)

    def register():
        for cls in _CLASSES:
            bpy.utils.register_class(cls)

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
