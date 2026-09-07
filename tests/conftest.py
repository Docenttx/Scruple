"""pytest wiring -- bpy mock, an isolated auth cache, and a session
Client wired to an in-memory opener.

Two things changed here in WO-B2 and both are consequences of the addon
consuming the SDK rather than its own lib/:

  * `isolated_auth_cache` redirects `scruple_host_sdk.auth.CACHE_DIR`
    instead of the addon's own CACHE_DIR/CACHE_FILE pair. The SDK
    parametrizes the cache by host, so there is one knob, not two.
  * `sdk_client` exists at all. The old code built a throwaway
    `ScrupleClient` per call, so a test could monkeypatch a factory
    function. Session state (baseline_ref, receipts, the queue) now
    lives on the Client, so tests install ONE client as the session
    client and read the state off it afterwards.
"""

from __future__ import annotations

import importlib
import os
import sys

import pytest

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

# Importing the adapter package is what puts vendor/ on sys.path, so it
# must happen before anything imports scruple_host_sdk.
import adapter  # noqa: E402,F401

from tests.mocks import bpy_mock, http_mock, v2  # noqa: E402


@pytest.fixture(autouse=False)
def bpy_installed():
    """Install the bpy mock into sys.modules for tests that need it."""
    bpy_mock.install()
    bpy_mock.reset()
    yield sys.modules["bpy"]
    bpy_mock.reset()
    sys.modules.pop("bpy", None)


@pytest.fixture
def bpy_reset():
    """Reset the pre-installed mock between assertions in a single test."""
    bpy_mock.reset()
    yield bpy_mock
    bpy_mock.reset()


@pytest.fixture
def http_opener():
    return http_mock.new()


@pytest.fixture
def fresh_state():
    """Reset the Blender-side bag AND drop the session Client, so state
    does not leak between tests."""
    from adapter import state as _state
    _state.reset()
    yield _state
    _state.reset()


@pytest.fixture
def isolated_auth_cache(tmp_path, monkeypatch):
    """Redirect the SDK's auth disk cache into tmp_path."""
    from scruple_host_sdk import auth as _auth
    cache_dir = tmp_path / "scruple"
    monkeypatch.setattr(_auth, "CACHE_DIR", str(cache_dir))
    yield cache_dir / "blender-auth.json"


@pytest.fixture
def sdk_client(http_opener, tmp_path, fresh_state):
    """A session Client that talks to the in-memory opener, with its auth
    cache and retry queue inside tmp_path. Installed as THE session
    client, so operators and handlers pick it up through
    `adapter.sdk.get_client()` without a monkeypatch."""
    from adapter import sdk as _sdk

    client = _sdk.new_client(
        base_url="https://scruple.test",
        api_key="sk_test_xyz",
        opener=http_opener,
        cache_dir=str(tmp_path / "sdk-home"),
    )
    _sdk.set_client(client, key=("https://scruple.test", "sk_test_xyz"))
    yield client
    _sdk.reset_client()


@pytest.fixture
def attached_client(sdk_client, http_opener):
    """`sdk_client`, with the v2 routes registered and a baseline already
    established -- the state every witness call requires (D-3)."""
    v2.register_v2(http_opener)
    sdk_client.attach(code_paths=[])
    assert sdk_client.state.baseline_ref, "fixture failed to establish a baseline"
    return sdk_client


def reload_addon_modules(module_names):
    """Force-reimport a list of addon modules -- used when the bpy mock
    was installed after a first import made bpy=None inside a module."""
    for name in module_names:
        if name in sys.modules:
            importlib.reload(sys.modules[name])
