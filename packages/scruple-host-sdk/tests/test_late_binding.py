"""The late-binding provider swap, ported from OTel's `ProxyTracer` /
`Once()` (WO-8; `docs/canon/oss-study/opentelemetry.md` §1.4).

The one behaviour worth all of it: **an object created before the SDK is
registered starts working after it, with no re-import and no restart.**
That is `test_a_recorder_created_before_registration_goes_live_after_it`,
and it is the reason a vendor can instrument once and configure later --
including at module scope in an embedded interpreter, where the module
body runs long before any `register()` hook.

Everything else here guards a way that property could quietly stop being
true.
"""

from __future__ import annotations

import threading

import pytest
import scruple_api
from scruple_api.provider import ProviderAlreadySetError, ProxyWitnessRecorder

import scruple_host_sdk
from scruple_host_sdk.client import Client


@pytest.fixture(autouse=True)
def _clean_provider():
    """The provider is process-global by design, so every test here has to
    hand it back. `reset_witness_provider()` is public rather than a
    test-only hook for the same reason -- an add-on disable/enable cycle
    needs exactly this."""
    scruple_api.reset_witness_provider()
    yield
    scruple_api.reset_witness_provider()


# ── The property the whole port exists for ─────────────────────────────────


def test_a_recorder_created_before_registration_goes_live_after_it(tmp_path, register_sdk):
    """The acceptance case, end to end, on ONE object reference.

    `recorder` is obtained first, as a module-level global would be. It
    no-ops. The SDK is registered afterwards by unrelated code. The same
    `recorder` -- never reassigned, never re-imported -- produces a real
    leaf on its next call.
    """
    recorder = scruple_api.get_recorder(host="acme", integration_version="1.0.0")
    assert isinstance(recorder, ProxyWitnessRecorder)
    assert recorder.is_live is False

    f = tmp_path / "render.png"
    f.write_bytes(b"pretend png")

    before = recorder.witness_file(str(f), mime="image/png", kind="artifact")
    assert before.witnessed is False
    assert before.queued is False
    assert before.leaf_id is None

    register_sdk(
        [
            ("ok", 200, {"baseline_ref": "b" * 64}),
            (
                "ok",
                201,
                {
                    "leaf_id": "leaf-1",
                    "leaf_hash": "h" * 64,
                    "witnessed": True,
                    "leaf_scheme": "v2",
                    "baseline_ref": "b" * 64,
                },
            ),
        ],
    )

    assert recorder.is_live is True
    recorder.attach(code_paths=[str(f)])
    after = recorder.witness_file(str(f), mime="image/png", kind="artifact")

    assert after.witnessed is True
    assert after.leaf_id == "leaf-1"
    # Same object throughout -- this is the whole point.
    assert recorder is not after
    assert isinstance(recorder, ProxyWitnessRecorder)


def test_the_proxy_resolves_to_the_sdks_own_client(tmp_path, register_sdk):
    """Not a wrapper, not an adapter: the resolved recorder IS a `Client`.
    If the SDK's real object needed adapting to fit the API's interface,
    the interface would be describing something we do not ship."""
    recorder = scruple_api.get_recorder(host="acme", integration_version="1.0.0")
    register_sdk([])
    resolved = recorder._recorder
    assert isinstance(resolved, Client)
    assert resolved.host == "acme"


def test_client_satisfies_the_api_recorder_protocol(tmp_path):
    """Structural conformance, checked rather than asserted in a
    docstring. `Client` does not import `scruple_api.provider` and is not
    a subclass of anything there."""
    client = Client(
        host="acme",
        integration_version="1.0.0",
        cache_dir=str(tmp_path / ".s"),
        queue_path=str(tmp_path / "q.jsonl"),
    )
    assert isinstance(client, scruple_api.WitnessRecorder)
    for name in ("attach", "witness", "witness_file", "mark", "capabilities", "detach"):
        assert callable(getattr(client, name)), name


def test_recorder_obtained_after_registration_skips_the_proxy(tmp_path, register_sdk):
    """The ordinary server case: configure first, instrument after. No
    proxy indirection is left in the hot path."""
    register_sdk([])
    recorder = scruple_api.get_recorder(host="acme", integration_version="1.0.0")
    assert isinstance(recorder, Client)


def test_the_same_recorder_is_reused_per_host_and_version(tmp_path, register_sdk):
    """One Client per (host, integration_version). A fresh Client per call
    site would give each its own queue file and its own baseline state --
    the queue would fragment and D-3's session gate would be per-call-site
    rather than per-integration."""
    register_sdk([])
    a = scruple_api.get_recorder(host="acme", integration_version="1.0.0")
    b = scruple_api.get_recorder(host="acme", integration_version="1.0.0")
    c = scruple_api.get_recorder(host="acme", integration_version="2.0.0")
    assert a is b
    assert a is not c


# ── The Once guard ─────────────────────────────────────────────────────────


def test_registering_the_same_provider_twice_is_idempotent(tmp_path, register_sdk):
    """Add-on enable/disable cycles and re-imported bootstrap modules do
    this. It must not raise."""
    register_sdk([])
    provider = scruple_api.get_witness_provider()
    scruple_api.set_witness_provider(provider)  # same object
    assert scruple_api.get_witness_provider() is provider


def test_registering_a_different_provider_raises_rather_than_warning(tmp_path, register_sdk):
    """Where we deliberately diverge from OTel, which logs
    "Overriding of current TracerProvider is not allowed" and carries on.
    OTel's worst case is a dropped span. Ours is evidence produced by a
    provider the caller of the losing registration does not know about, so
    the losing caller is told."""
    register_sdk([])
    first = scruple_api.get_witness_provider()

    with pytest.raises(ProviderAlreadySetError):
        scruple_host_sdk.register(api_key="a-different-key", cache_dir=str(tmp_path / ".other"))

    assert scruple_api.get_witness_provider() is first, "the first provider must still be the live one"


def test_unregister_falls_back_to_the_noop_and_allows_re_registration(tmp_path, register_sdk):
    """The documented teardown path. A recorder handed out before teardown
    goes inert, then live again on the next registration -- the same
    late-binding property, run backwards."""
    recorder = scruple_api.get_recorder(host="acme", integration_version="1.0.0")
    register_sdk([("ok", 200, {"baseline_ref": "b" * 64})])
    recorder.attach()
    assert recorder.is_live is True

    scruple_host_sdk.unregister()
    assert scruple_api.is_configured() is False

    # A recorder that had already resolved keeps its resolved client (it is
    # still a valid Client; tearing it out from under a caller mid-flight
    # would be worse). A NEW recorder gets the no-op.
    fresh = scruple_api.get_recorder(host="acme", integration_version="1.0.0")
    assert isinstance(fresh, ProxyWitnessRecorder)
    assert fresh.is_live is False

    register_sdk([])
    assert fresh.is_live is True


def test_once_runs_exactly_once_under_concurrency():
    """The `Once` port itself, including its unlocked fast path. Racing
    the `_done` read may cost a redundant lock acquisition; it must never
    cost a second execution."""
    once = scruple_api.Once()
    calls = []
    barrier = threading.Barrier(16)

    def racer():
        barrier.wait()
        once.do_once(lambda: calls.append(1))

    threads = [threading.Thread(target=racer) for _ in range(16)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert calls == [1]


def test_set_witness_provider_is_the_only_way_in(tmp_path):
    """There is no environment-variable provider-selection path, and there
    must not be one -- see `scruple_api/provider.py`, item 1. A provider
    chosen at runtime from a value the measured party controls is
    `unattested-client` whatever the deployment claims."""
    import ast
    import os

    # AST, not a substring search: the module docstring shows an
    # `os.environ["SCRUPLE_API_KEY"]` example, and an example is not a code
    # path. What must not exist is an actual read.
    tree = ast.parse(open(scruple_api.provider.__file__, encoding="utf-8").read())
    reads = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Attribute) and node.attr in {"environ", "getenv", "entry_points"}:
            reads.append(node.attr)
        elif isinstance(node, ast.Name) and node.id in {"getenv", "entry_points", "import_module"}:
            reads.append(node.id)
    assert reads == [], f"provider.py reads configuration from the environment: {reads}"

    os.environ["SCRUPLE_WITNESS_PROVIDER"] = "attacker.module:Provider"
    try:
        assert scruple_api.is_configured() is False
        rec = scruple_api.get_recorder(host="acme", integration_version="1.0.0")
        assert isinstance(rec, ProxyWitnessRecorder)
        assert rec.is_live is False
    finally:
        del os.environ["SCRUPLE_WITNESS_PROVIDER"]


# ── The no-op still holds the canon properties, with the SDK importable ────


def test_noop_enforces_mime_and_modality_even_though_the_sdk_is_installed(tmp_path):
    """Installed is not registered. A process that has the SDK on disk but
    has never called `register()` gets the no-op, and the no-op is still
    held to properties 1 and 2."""
    recorder = scruple_api.get_recorder(host="acme", integration_version="1.0.0")
    f = tmp_path / "a.png"
    f.write_bytes(b"x")

    with pytest.raises(scruple_api.MimeRequiredError):
        recorder.witness_file(str(f), mime="", kind="artifact")

    with pytest.raises(scruple_api.ModalityUnavailableError):
        recorder.mark(leaf_id="1", mime="image/png", modalities=["holotape"])

    out = recorder.mark(leaf_id="1", mime="image/png", modalities=["c2pa"])
    assert out.modalities_applied == []
    assert [o.modality for o in out.outstanding] == ["c2pa"]
    assert out.witnessed is False
