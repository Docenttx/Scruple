"""The Blender half of Scruple for Blender.

Everything in this package is here for one of two reasons: it touches
`bpy`, or the SDK's own documentation says it is the adapter's job
(`scruple_host_sdk/preferences.py`: "Rendering a settings panel is the
adapter's job"; `scruple_api/capture.py`: reading `scene.render` "is
host-specific introspection and belongs in the adapter").

Everything else -- the HTTP gateway, the retry queue, canonical JSON,
the tamper-surface hash, auth storage, payment, capabilities, the
witness and mark calls -- comes from `scruple_host_sdk`, vendored under
`vendor/`. It replaced `lib/`, which was a hand-rolled second
implementation of nine of those ten things. See
docs/canon/blender-l2/01-GAP.md for what each old module became.

Importing anything from this package puts `vendor/` on `sys.path` first,
so `import scruple_host_sdk` resolves to the copy that ships in the zip
and not to some other copy that happens to be installed on the machine.
That is deliberate and it is asserted in tests/test_sdk_adoption.py: an
addon whose SDK version depends on what else is installed in the host's
interpreter has no reproducible tamper surface.
"""

from __future__ import annotations

import os
import sys

ADDON_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VENDOR_DIR = os.path.join(ADDON_ROOT, "vendor")

if VENDOR_DIR not in sys.path:
    sys.path.insert(0, VENDOR_DIR)
