"""Dev-tree path shim.

In a real install `scruple-api` is a resolvable distribution and this file
does nothing. In this repo neither package is installed -- `npm run
test:sdk` just runs pytest from `packages/scruple-host-sdk` -- so the
sibling package root has to go on `sys.path` for `import scruple_api` to
resolve the same way it would after `pip install`.

Test-tree convenience only. Nothing in either package manipulates
`sys.path` at runtime.
"""

from __future__ import annotations

import pathlib
import sys

_HERE = pathlib.Path(__file__).resolve().parent
for _root in (_HERE, _HERE.parent / "scruple-api"):
    _s = str(_root)
    if _s not in sys.path:
        sys.path.insert(0, _s)
