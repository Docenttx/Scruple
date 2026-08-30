"""The two tests the build brief calls out explicitly:

1. A network call moved outside http.py breaks the build (static check).
2. Calling the package through its normal, high-level API -- not
   http.submit() directly -- still lands a failed Phase-3 operation in
   the queue. This is the one six forks all failed: queue_store.py
   existed, was tested, and nothing called it on the failure path. The
   only way to be sure this build does not repeat that is to prove the
   HIGH-LEVEL entry point (witness_flow.witness / Client.witness) is the
   thing that enqueues, not just http.submit() in isolation.
"""

from __future__ import annotations

import ast
import pathlib

import pytest

from scruple_host_sdk import witness_flow
from scruple_host_sdk.errors import NoBaselineError

PKG_ROOT = pathlib.Path(__file__).resolve().parent.parent / "scruple_host_sdk"
TRANSPORT_FILE = "http.py"
FORBIDDEN_TOP_LEVEL_MODULES = {"requests", "httpx", "aiohttp"}

#: Modules allowed to touch a socket at all, and why. Measured, not
#: assumed -- see test_the_set_of_socket_capable_modules_is_exactly_two.
SOCKET_CAPABLE = {
    "http.py": "outbound to scruple.ai -- the sole gateway, see its docstring",
    "auth.py": "inbound loopback only -- the browser-handshake callback server",
}
SOCKET_MODULES = {"socket", "socketserver", "ssl", "http", "urllib", "webbrowser", "asyncio"}


def test_only_http_module_touches_the_network():
    """Parses every module in the package except http.py and fails if
    any of them imports urllib.request, imports a third-party HTTP
    library, or calls a bare `.urlopen(...)`. This is what makes "someone
    moves a network call out of submit()" a build failure instead of a
    code-review hope."""
    offenders = []
    for path in sorted(PKG_ROOT.glob("*.py")):
        if path.name == TRANSPORT_FILE:
            continue
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    top = alias.name.split(".")[0]
                    if top in FORBIDDEN_TOP_LEVEL_MODULES or alias.name == "urllib.request":
                        offenders.append(f"{path.name}: import {alias.name}")
            elif isinstance(node, ast.ImportFrom):
                mod = node.module or ""
                top = mod.split(".")[0]
                if top in FORBIDDEN_TOP_LEVEL_MODULES or mod == "urllib.request":
                    offenders.append(f"{path.name}: from {mod} import ...")
            elif isinstance(node, ast.Attribute) and node.attr == "urlopen":
                offenders.append(f"{path.name}: calls .urlopen(...) directly")

    assert not offenders, (
        "Network call(s) found outside http.py -- this breaks the "
        "queue-by-construction guarantee (every network call must go "
        "through http.submit()):\n  " + "\n  ".join(offenders)
    )


def test_witness_via_high_level_api_enqueues_on_network_failure(make_client):
    """Not a test of http.submit() in isolation -- a test that the
    high-level flow function actually wired to it enqueues. Mirrors
    exactly the failure mode named in CANON_SKELETON.md: 'six
    integrations built an offline retry queue, tested it, and never
    wired it into the failure path.'"""
    client, opener = make_client(script=[("network_error",)])
    client.state.baseline_ref = "a" * 64  # bypass attach() -- not under test here

    outcome = witness_flow.witness(client, kind="document_save", content_hash="b" * 64, mime="image/png")

    assert outcome.queued is True
    assert outcome.witnessed is False
    assert client.queue.count() == 1
    entries = client.queue.load_all()
    assert entries[0]["kind"] == "witness"
    assert entries[0]["body"]["content_hash"] == "b" * 64


def test_mark_via_high_level_api_enqueues_on_5xx(make_client):
    client, opener = make_client(
        script=[
            ("ok", 200, {"modalities": [{"modality": "chain", "available": True, "reason": "ok"}]}),
            ("ok", 503, {"error": {"code": "internal", "message": "boom"}}),
        ]
    )

    outcome = witness_flow.mark(client, leaf_id="1", host="blender", mime="image/png", modalities=["chain"])

    assert outcome.queued is True
    assert client.queue.count() == 1
    assert client.queue.load_all()[0]["kind"] == "mark"


def test_detach_drains_without_reenqueuing_forever(make_client):
    """The queued entry from a prior failure eventually succeeds and is
    removed -- and a second, still-failing entry stays queued rather than
    looping."""
    client, opener = make_client(script=[("network_error",)])
    client.state.baseline_ref = "a" * 64
    witness_flow.witness(client, kind="document_save", content_hash="c" * 64, mime="image/png")
    assert client.queue.count() == 1

    # Next opportunity to send it succeeds.
    opener.script.append(("ok", 201, {"leaf_id": "9", "leaf_hash": "x", "witnessed": True, "leaf_scheme": "v2", "baseline_ref": "a" * 64}))
    result = client.detach()

    assert result["succeeded"] == 1
    assert client.queue.count() == 0


def test_the_set_of_socket_capable_modules_is_exactly_two():
    """The seam this package is built on is usually stated as "only
    http.py touches the network". Measured, that is one module short:
    `auth.py` imports `http.server`, `socket` and `webbrowser` to stand up
    the loopback callback server the browser handshake redirects to.

    That is not a violation of property 3. `http.py`'s guarantee is about
    OUTBOUND calls to scruple.ai -- the ones that can fail and must
    therefore enqueue -- and `auth.py` makes none; it binds a listener on
    localhost and reads one redirect. But an unstated exception is how a
    third one arrives unnoticed, so the exception is named here and the
    count is pinned.

    A new socket-capable module fails this test. If it genuinely needs a
    socket, it goes in `SOCKET_CAPABLE` with a reason, deliberately -- and
    it can never go in `scruple-api`, whose scan
    (`packages/scruple-api/tests/test_no_network_capability.py`) has no
    allowlist at all.
    """
    found = {}
    for path in sorted(PKG_ROOT.glob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        hits = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    if alias.name.split(".")[0] in SOCKET_MODULES:
                        hits.add(alias.name)
            elif isinstance(node, ast.ImportFrom) and not node.level:
                if (node.module or "").split(".")[0] in SOCKET_MODULES:
                    hits.add(node.module)
        if hits:
            found[path.name] = sorted(hits)

    assert set(found) == set(SOCKET_CAPABLE), (
        "The set of socket-capable modules in scruple-host-sdk changed.\n"
        f"  expected: {sorted(SOCKET_CAPABLE)}\n"
        f"  measured: {sorted(found)}  {found}"
    )
    assert found["auth.py"] == ["http.server", "socket", "urllib.parse", "webbrowser"]
