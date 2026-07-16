"""pytest wiring — installs the bpy mock before addon imports.

The addon deliberately imports bpy lazily (guarded by try/except in
each module) so many tests can run without any bpy at all. The mock
is here for the tests that need to exercise the operator / panel /
handler surface.
"""

from __future__ import annotations

import importlib
import os
import sys

import pytest

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

from tests.mocks import bpy_mock, http_mock  # noqa: E402


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
    """Reset the addon's global state so tests don't leak into each other."""
    from lib import state as _state
    _state.reset()
    yield _state
    _state.reset()


@pytest.fixture
def isolated_auth_cache(tmp_path, monkeypatch):
    """Redirect the auth disk cache into tmp_path."""
    from lib import auth as _auth
    cache_dir = tmp_path / "scruple"
    cache_file = cache_dir / "blender-auth.json"
    monkeypatch.setattr(_auth, "CACHE_DIR", str(cache_dir))
    monkeypatch.setattr(_auth, "CACHE_FILE", str(cache_file))
    yield cache_file


def reload_addon_modules(module_names):
    """Force-reimport a list of addon modules — used when the bpy mock
    was installed after a first import made bpy=None inside a module."""
    for name in module_names:
        if name in sys.modules:
            importlib.reload(sys.modules[name])
