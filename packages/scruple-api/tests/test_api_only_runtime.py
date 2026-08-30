"""The runtime half of "importing scruple-api alone cannot open a socket".

The AST scan next door proves no networking code is *present*. That is a
statement about the source. This is a statement about the process: a real
interpreter, a `sys.path` that contains `scruple-api` and nothing else of
ours, a `socket` module booby-trapped so that any attempt to construct a
socket or resolve a name raises loudly, and then a full instrumentation
flow driven end to end. Two independent proofs because they fail
differently -- the scan catches source that could connect, this catches a
process that did.

Everything runs in a subprocess. It has to: `scruple_host_sdk` is
importable in this test session (its conftest is a sibling, and the SDK
suite needs both packages on the path), and "with no SDK installed" is not
a claim you can make from inside a process where it is installed.
"""

from __future__ import annotations

import json
import pathlib
import subprocess
import sys
import textwrap

API_ROOT = str(pathlib.Path(__file__).resolve().parent.parent)


def run_api_only(body: str, tmp_path) -> dict:
    """Run `body` in a fresh interpreter that can see scruple-api and
    nothing else of ours, with the network nailed shut.

    The interpreter runs `-I` (isolated: no PYTHONPATH, no user site, no
    inherited environment), and the prelude then adds exactly one path
    entry -- this package -- and asserts nothing else of ours is reachable.
    So the SDK cannot arrive through a site-packages install, a `.pth`
    file, or an inherited PYTHONPATH.
    """
    prelude = textwrap.dedent(
        f"""
        import json, socket, sys

        # sys.path is set here rather than through PYTHONPATH because -I
        # (isolated) deliberately ignores PYTHONPATH. One entry of ours is
        # added and the assertion below proves nothing else of ours came
        # along via site-packages or a .pth file.
        sys.path.insert(0, {API_ROOT!r})
        assert not [p for p in sys.path if "scruple-host-sdk" in p or "scruple_host_sdk" in p], sys.path

        # apport's excepthook imports urllib on error, which reaches the
        # tripwire below and buries the real traceback. Off.
        sys.excepthook = sys.__excepthook__

        # Booby-trap the network before anything of ours is imported. Any
        # socket construction, connection or name resolution from this
        # point on is a test failure with a stack trace, not a silent
        # timeout against a real host.
        class _Tripwire(Exception):
            pass

        def _trip(*a, **k):
            raise _Tripwire("scruple-api touched the network")

        socket.socket = _trip
        socket.create_connection = _trip
        socket.getaddrinfo = _trip
        socket.gethostbyname = _trip

        _OUT = {{}}
        """
    )
    epilogue = "\nprint('__RESULT__' + json.dumps(_OUT))\n"
    script = tmp_path / "api_only.py"
    script.write_text(prelude + textwrap.dedent(body) + epilogue, encoding="utf-8")

    proc = subprocess.run(
        [sys.executable, "-E", "-I", str(script)],
        capture_output=True,
        text=True,
        env={"PATH": "/usr/bin:/bin"},
        timeout=60,
    )
    assert proc.returncode == 0, f"subprocess failed:\nSTDOUT:\n{proc.stdout}\nSTDERR:\n{proc.stderr}"
    marker = [ln for ln in proc.stdout.splitlines() if ln.startswith("__RESULT__")]
    assert marker, f"no result marker:\nSTDOUT:\n{proc.stdout}\nSTDERR:\n{proc.stderr}"
    return json.loads(marker[-1][len("__RESULT__") :])


def test_the_sdk_really_is_absent_in_that_subprocess(tmp_path):
    """Guard on the guard. If `scruple_host_sdk` were importable here,
    every other test in this file would be proving nothing."""
    out = run_api_only(
        """
        try:
            import scruple_host_sdk
            _OUT["sdk_importable"] = True
        except ImportError:
            _OUT["sdk_importable"] = False
        import scruple_api
        _OUT["api_importable"] = True
        _OUT["configured"] = scruple_api.is_configured()
        """,
        tmp_path,
    )
    assert out == {"sdk_importable": False, "api_importable": True, "configured": False}


def test_the_tripwire_itself_fires(tmp_path):
    """Guard on the other guard: prove the booby-trap catches a real
    connection attempt, so a green result below means "did not connect"
    rather than "trap was inert"."""
    out = run_api_only(
        """
        import socket
        try:
            socket.socket()
            _OUT["tripped"] = False
        except Exception as e:
            _OUT["tripped"] = type(e).__name__
        """,
        tmp_path,
    )
    assert out["tripped"] == "_Tripwire"


def test_full_instrumentation_flow_noops_without_reaching_the_network(tmp_path):
    """The acceptance case: a vendor's call sites, written against the API,
    with no SDK anywhere. Every call returns; none raises; none connects."""
    out = run_api_only(
        """
        import os, tempfile
        import scruple_api

        d = tempfile.mkdtemp()
        p = os.path.join(d, "render.png")
        open(p, "wb").write(b"pretend png")

        recorder = scruple_api.get_recorder(host="acme", integration_version="1.0.0")
        _OUT["recorder_type"] = type(recorder).__name__

        att = recorder.attach(code_paths=[__file__])
        _OUT["baseline_ref"] = att.baseline_ref
        _OUT["established"] = att.established

        outcome = recorder.witness_file(p, mime="image/png", kind="artifact")
        _OUT["witnessed"] = outcome.witnessed
        _OUT["queued"] = outcome.queued
        _OUT["leaf_id"] = outcome.leaf_id
        _OUT["error_is_set"] = bool(outcome.error)

        m = recorder.mark(leaf_id="whatever", mime="image/png", modalities=["c2pa", "chain"])
        _OUT["applied"] = list(m.modalities_applied)
        _OUT["requested"] = list(m.modalities_requested)
        _OUT["outstanding"] = [o.modality for o in m.outstanding]
        _OUT["mark_witnessed"] = m.witnessed

        _OUT["capabilities"] = [c.modality for c in recorder.capabilities(mime="image/png")]
        _OUT["detach"] = recorder.detach()
        """,
        tmp_path,
    )
    assert out["recorder_type"] == "ProxyWitnessRecorder"
    # Property 3, API side: nothing witnessed, and honest that nothing was
    # spooled either -- no phantom queue an API-only process could never drain.
    assert out["witnessed"] is False
    assert out["queued"] is False
    assert out["leaf_id"] is None
    assert out["error_is_set"] is True
    assert out["detach"] == {"succeeded": 0, "failed": 0, "remaining": 0}
    # D-3: no baseline claimed.
    assert out["baseline_ref"] is None and out["established"] is False
    # Property 2, API side: known modalities requested, none applied, all outstanding.
    assert out["applied"] == []
    assert out["requested"] == ["c2pa", "chain"]
    assert out["outstanding"] == ["c2pa", "chain"]
    assert out["mark_witnessed"] is False
    # Fails closed downstream: an empty capability list is "could not determine".
    assert out["capabilities"] == []


def test_property_1_mime_is_enforced_with_no_sdk(tmp_path):
    """Property 1 holds for an API-only consumer. This is the case that
    would silently regress if `require_mime` had stayed in the SDK: the
    vendor's dev finds out at wiring time, not months later."""
    out = run_api_only(
        """
        import os, tempfile
        import scruple_api

        d = tempfile.mkdtemp()
        p = os.path.join(d, "render.png")
        open(p, "wb").write(b"x")
        rec = scruple_api.get_recorder(host="acme", integration_version="1.0.0")

        _OUT["raised"] = []
        for bad in (None, "", "   "):
            try:
                rec.witness_file(p, mime=bad, kind="artifact")
                _OUT["raised"].append(None)
            except scruple_api.MimeRequiredError:
                _OUT["raised"].append("MimeRequiredError")

        try:
            rec.witness(kind="artifact", content_hash="a" * 64, mime="")
            _OUT["witness_raised"] = None
        except scruple_api.MimeRequiredError:
            _OUT["witness_raised"] = "MimeRequiredError"

        _OUT["no_mimetypes_imported"] = "mimetypes" not in __import__("sys").modules
        """,
        tmp_path,
    )
    assert out["raised"] == ["MimeRequiredError"] * 3
    assert out["witness_raised"] == "MimeRequiredError"
    assert out["no_mimetypes_imported"] is True


def test_property_2_unknown_modality_fails_closed_with_no_sdk(tmp_path):
    """Property 2's vocabulary half holds for an API-only consumer, and
    refuses on exactly the rule the SDK uses -- same function, same
    message."""
    out = run_api_only(
        """
        import scruple_api
        rec = scruple_api.get_recorder(host="acme", integration_version="1.0.0")
        try:
            rec.mark(leaf_id="1", mime="image/png", modalities=["holotape"])
            _OUT["raised"] = None
        except scruple_api.ModalityUnavailableError as e:
            _OUT["raised"] = "ModalityUnavailableError"
            _OUT["reason"] = str(e)
        _OUT["vocabulary"] = sorted(scruple_api.KNOWN_MODALITIES)
        """,
        tmp_path,
    )
    assert out["raised"] == "ModalityUnavailableError"
    assert "Unknown modality" in out["reason"]
    assert out["vocabulary"] == ["c2pa", "chain", "local", "watermark"]


def test_hashing_and_manifests_work_with_no_sdk(tmp_path):
    """The API is not only a no-op: `capture()` and the tamper-surface
    hash are real work that needs no network, so a vendor can compute and
    inspect the hash they will be held to before installing anything."""
    out = run_api_only(
        """
        import hashlib, os, tempfile
        import scruple_api

        d = tempfile.mkdtemp()
        p = os.path.join(d, "a.bin")
        open(p, "wb").write(b"hello")
        payload = scruple_api.capture(p, mime="application/octet-stream", kind="artifact")
        _OUT["hash_matches"] = payload["content_hash"] == hashlib.sha256(b"hello").hexdigest()
        _OUT["mime"] = payload["mime"]
        _OUT["tsh_stable"] = (
            scruple_api.compute_tamper_surface_hash(integration_version="1.0.0", code_paths=[p])
            == scruple_api.compute_tamper_surface_hash(integration_version="1.0.0", code_paths=[p])
        )
        """,
        tmp_path,
    )
    assert out["hash_matches"] is True
    assert out["mime"] == "application/octet-stream"
    assert out["tsh_stable"] is True


def test_capture_surface_contract_is_importable_with_no_sdk(tmp_path):
    """`surface.py`'s placement justification, made checkable: a vendor
    writing a capture surface for a host we have not met needs the types
    and must not need the network."""
    out = run_api_only(
        """
        from scruple_api import surface
        _OUT["hooks"] = len(list(surface.CaptureHook))
        _OUT["surfaces"] = sorted(s.value for s in surface.SurfaceKind)
        _OUT["registry_empty"] = surface.registered_surfaces() == []
        """,
        tmp_path,
    )
    assert out["hooks"] == 9
    assert out["surfaces"] == [
        "filesystem-watch",
        "host-api-callback",
        "in-process-callback",
        "network-gate",
    ]
    assert out["registry_empty"] is True
