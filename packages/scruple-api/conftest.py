"""Dev-tree path shim.

In a real install `scruple-api` is a resolvable distribution and this file
does nothing; in this repo nothing is installed, so the package root has
to go on `sys.path` for `import scruple_api` to resolve.

It deliberately does NOT put `packages/scruple-host-sdk` on the path. This
suite's job is to prove things about `scruple-api` standing alone, and a
test that can accidentally import the SDK is not proving that. The tests
that exercise the two packages together live in the SDK's suite, which
does add both.
"""

from __future__ import annotations

import pathlib
import sys

_HERE = str(pathlib.Path(__file__).resolve().parent)
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)
