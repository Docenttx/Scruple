"""`scruple-api` has no network capability. Proved statically here, and
again at runtime in test_api_only_runtime.py.

Same idiom as the SDK's
`tests/test_queue_construction.py::test_only_http_module_touches_the_network`,
which parses every module in that package and fails if a network call has
escaped `http.py`. This is the stronger form of that test: there is no
`http.py` here to allow, so the allowed set is empty and the assertion is
about the whole package.

WHY A SCAN AND NOT A CONVENTION. The SDK's version of this test exists
because a network call moving out of `submit()` must be a build failure
rather than something code review might notice. The same argument applies
one level up, harder: the entire claim `scruple-api` makes -- that a
vendor can wire it into any code path, including ones nobody has
security-reviewed, without auditing those call sites for exfiltration risk
-- is worth exactly as much as the mechanical check behind it. WO-8's
framing: packaging should enforce what a test currently enforces by
inspection. Packaging alone still cannot (a `pyproject.toml` cannot forbid
`import socket`), so packaging plus this.

Verified red/green by injecting a violation, per the WO. See the docstring
on `test_the_scan_actually_catches_a_violation` for the fixture that keeps
that honest between runs.
"""

from __future__ import annotations

import ast
import pathlib

import pytest

PKG_ROOT = pathlib.Path(__file__).resolve().parent.parent / "scruple_api"

#: Anything that can reach a network, plus the escape hatches that could
#: reach one indirectly. `subprocess`/`ctypes`/`multiprocessing` are not
#: network modules; they are ways to obtain one without importing one, and
#: a package whose whole property is "this cannot phone home" has no use
#: for any of them.
FORBIDDEN_TOP_LEVEL = {
    # direct network
    "socket",
    "socketserver",
    "ssl",
    "http",
    "urllib",
    "urllib3",
    "requests",
    "httpx",
    "aiohttp",
    "ftplib",
    "smtplib",
    "poplib",
    "imaplib",
    "telnetlib",
    "nntplib",
    "xmlrpc",
    "webbrowser",
    "asyncio",
    "selectors",
    # indirect: a subprocess or a loaded C library can do anything
    "subprocess",
    "ctypes",
    "multiprocessing",
    # dynamic import defeats a static scan
    "importlib",
    # and the SDK itself: the dependency arrow points one way only
    "scruple_host_sdk",
    "scruple_sdk",
}

#: Called-attribute names that mean a connection regardless of how the
#: module they came from was spelled.
FORBIDDEN_CALL_ATTRS = {
    "urlopen",
    "urlretrieve",
    "create_connection",
    "socket",
    "socketpair",
    "getaddrinfo",
    "system",
    "popen",
    "fork",
    "execv",
    "execvp",
    "spawn",
    "import_module",
}


def _modules():
    return sorted(PKG_ROOT.rglob("*.py"))


def scan(paths) -> list:
    """The scan itself, factored out so the red/green test below can run
    it against a deliberately poisoned tree without duplicating it."""
    offenders = []
    for path in paths:
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        docstrings = {
            node.body[0].value
            for node in ast.walk(tree)
            if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef))
            and node.body
            and isinstance(node.body[0], ast.Expr)
            and isinstance(node.body[0].value, ast.Constant)
            and isinstance(node.body[0].value.value, str)
        }
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    top = alias.name.split(".")[0]
                    if top in FORBIDDEN_TOP_LEVEL:
                        offenders.append(f"{path.name}:{node.lineno}: import {alias.name}")
            elif isinstance(node, ast.ImportFrom):
                top = (node.module or "").split(".")[0]
                if top in FORBIDDEN_TOP_LEVEL:
                    offenders.append(f"{path.name}:{node.lineno}: from {node.module} import ...")
            elif isinstance(node, ast.Call):
                func = node.func
                if isinstance(func, ast.Attribute) and func.attr in FORBIDDEN_CALL_ATTRS:
                    offenders.append(f"{path.name}:{node.lineno}: calls .{func.attr}(...)")
                elif isinstance(func, ast.Name) and func.id in FORBIDDEN_CALL_ATTRS | {"__import__"}:
                    offenders.append(f"{path.name}:{node.lineno}: calls {func.id}(...)")
            elif isinstance(node, ast.Constant) and isinstance(node.value, str):
                # No server address may exist in this package -- not even
                # as a default anything could later be pointed at.
                # Docstrings are exempt; they explain, they do not connect.
                if "://" in node.value and node not in docstrings:
                    offenders.append(f"{path.name}:{node.lineno}: URL literal {node.value[:60]!r}")
    return offenders


def test_scruple_api_has_no_network_capability():
    offenders = scan(_modules())
    assert not offenders, (
        "scruple-api must have NO network capability. Anything found here "
        "belongs in scruple-host-sdk instead -- and if it genuinely belongs "
        "in the API, the API's claim has changed and the split needs "
        "revisiting, not this list:\n  " + "\n  ".join(offenders)
    )


def test_scruple_api_does_not_import_the_sdk():
    """Called out separately from the scan above because it is a different
    kind of failure. A network import in here is a leak; an SDK import in
    here is a dependency cycle that would make `scruple-api` unvendorable
    on its own, which is the entire product of the split."""
    offenders = [o for o in scan(_modules()) if "scruple_host_sdk" in o or "scruple_sdk" in o]
    assert not offenders, "scruple-api imports the SDK:\n  " + "\n  ".join(offenders)


def test_the_scan_actually_catches_a_violation(tmp_path):
    """A scan nobody has seen fail is not evidence. This runs the real
    `scan()` over a module that does each forbidden thing, and asserts it
    reports every one -- so the red half of the manual red/green check
    recorded in WO-8 stays true as the forbidden list changes.

    Mirrors what `test_queue_construction.py` was verified with by hand;
    the difference is that this one keeps verifying itself.
    """
    poisoned = tmp_path / "poisoned.py"
    poisoned.write_text(
        "import socket\n"
        "import urllib.request\n"
        "from http.client import HTTPConnection\n"
        "import scruple_host_sdk\n"
        "BASE = 'https://scruple.ai'\n"
        "def go():\n"
        "    urllib.request.urlopen(BASE)\n"
        "    __import__('requests')\n",
        encoding="utf-8",
    )
    offenders = scan([poisoned])
    joined = "\n".join(offenders)
    assert "import socket" in joined
    assert "import urllib.request" in joined
    assert "from http.client import ..." in joined
    assert "import scruple_host_sdk" in joined
    assert "URL literal" in joined
    assert "calls .urlopen(...)" in joined
    assert "calls __import__(...)" in joined
    assert len(offenders) >= 7, offenders


@pytest.mark.parametrize("mod", [p.name for p in sorted(PKG_ROOT.rglob("*.py"))])
def test_every_module_is_individually_clean(mod):
    """Per-module parametrisation so a failure names the file in the test
    id rather than only in an assertion message."""
    assert not scan([PKG_ROOT / mod])
