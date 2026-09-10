"""adapter/preferences.py -- the value-reading half, over the SDK's cache.

gap.json, modules row 9: the AddonPreferences subclass and its draw()
stay (they are Blender's), and `get_api_key`/`get_base_url`/
`sync_from_cache` lose their own copy of the cache read. These tests are
the old ones with the same assertions; what changed underneath is which
module opens the file.
"""

from __future__ import annotations

import ast
import importlib
import os
import sys
import types

import pytest

from adapter import ADDON_ROOT
from adapter import preferences as _prefs
from adapter import sdk as _sdk
from scruple_host_sdk import auth as _auth
from scruple_host_sdk.preferences import DEFAULT_BASE_URL

from tests.mocks import bpy_mock

MANIFEST_MODULE = "bl_ext.user_default.scruple_blender"
LEGACY_MODULE = "scruple_blender"


def test_get_api_key_prefers_disk_cache_when_no_bpy(isolated_auth_cache):
    _auth.save_cached(_sdk.HOST, "sk_test_fromdisk", base_url="https://scruple.test")
    assert _prefs.get_api_key() == "sk_test_fromdisk"
    assert _prefs.get_base_url() == "https://scruple.test"


def test_get_api_key_empty_when_nothing_cached(isolated_auth_cache):
    assert _prefs.get_api_key() == ""


def test_get_base_url_is_empty_when_nothing_is_configured(isolated_auth_cache):
    """WO-F1 / finding E7-2. This used to return the SDK's DEFAULT_BASE_URL,
    which is production. An addon nobody could configure therefore pointed at
    the live service by default, and neither the user nor the log ever said
    so. Unconfigured is now unconfigured."""
    assert _prefs.get_base_url() == ""
    assert not _prefs.is_configured()


def test_an_unconfigured_base_url_is_never_production(isolated_auth_cache):
    """The control the gate runs inside Blender, as a unit test: whatever
    an unconfigured call yields, `scruple.ai` is not it."""
    assert DEFAULT_BASE_URL == "https://scruple.ai", "the SDK default moved; re-read this test"
    assert "scruple.ai" not in _prefs.get_base_url()


def test_a_configured_base_url_still_wins(isolated_auth_cache):
    _auth.save_cached(_sdk.HOST, "sk_test_k", base_url="http://127.0.0.1:3902")
    assert _prefs.get_base_url() == "http://127.0.0.1:3902"
    assert _prefs.is_configured()


def test_production_is_reachable_when_somebody_states_it(isolated_auth_cache):
    """Refusing a default is not refusing the value. A user who names the
    live service gets the live service."""
    _auth.save_cached(_sdk.HOST, "sk_test_k", base_url=DEFAULT_BASE_URL)
    assert _prefs.get_base_url() == DEFAULT_BASE_URL


def test_is_authed_reflects_key_presence(isolated_auth_cache):
    assert not _prefs.is_authed()
    _auth.save_cached(_sdk.HOST, "sk_test_authed")
    assert _prefs.is_authed()


def test_no_client_is_built_without_a_key(isolated_auth_cache, fresh_state):
    """get_client() returns None rather than an unauthenticated Client --
    a Client with no key would fail later, in a worker thread, as a 401."""
    assert _sdk.get_client() is None


def test_no_client_is_built_without_a_base_url(isolated_auth_cache, fresh_state):
    """WO-F1. A key with no base URL used to build a Client pointed at
    production, because `Client.__init__` does `base_url or DEFAULT_BASE_URL`
    and the adapter handed it the default anyway. The SDK is unchanged; the
    adapter refuses before it gets there."""
    _auth.save_cached(_sdk.HOST, "sk_test_keyed_but_homeless")
    assert _prefs.get_api_key() == "sk_test_keyed_but_homeless"
    assert _prefs.get_base_url() == ""
    assert _sdk.get_client() is None


def test_a_key_produces_a_session_client_that_is_reused(isolated_auth_cache, fresh_state):
    _auth.save_cached(_sdk.HOST, "sk_test_session", base_url="https://scruple.test")
    first = _sdk.get_client()
    assert first is not None
    assert first.api_key == "sk_test_session"
    assert _sdk.get_client() is first, "one Client per session, not one per call"


def test_changing_the_key_builds_a_new_session_client(isolated_auth_cache, fresh_state):
    """A different key is a different session -- its baseline, receipts
    and queue must not be inherited."""
    _auth.save_cached(_sdk.HOST, "sk_test_one", base_url="https://scruple.test")
    first = _sdk.get_client()
    _auth.save_cached(_sdk.HOST, "sk_test_two", base_url="https://scruple.test")
    second = _sdk.get_client()
    assert second is not first
    assert second.api_key == "sk_test_two"


# ---- WO-F1: which module Blender bound the Settings UI to ---------------
#
# ⚑ Finding E7-2. `bl_idname` was the literal legacy module name, so on the
# manifest install path -- the one every 4.2+ user gets -- Blender matched
# the class to nothing and `addons[module].preferences` was None. The suite
# had 330 tests and none of them caught it, because they all exercised
# `ScrupleAddonPreferences` as a class rather than as a class Blender bound
# to a module. These do the latter.


@pytest.fixture
def as_module(monkeypatch):
    """Put a stand-in for the addon's own root `__init__` into sys.modules
    under a given name, the way Blender's importer does on each install
    path. The stand-in carries the real `__file__`, which is the only thing
    `addon_module_name()` matches on."""
    installed = []

    def _install(name):
        mod = types.ModuleType(name)
        mod.__file__ = os.path.join(ADDON_ROOT, "__init__.py")
        monkeypatch.setitem(sys.modules, name, mod)
        installed.append(name)
        return mod

    yield _install


@pytest.fixture
def with_bpy():
    bpy_mock.install()
    bpy_mock.reset()
    importlib.reload(sys.modules["adapter.preferences"])
    yield sys.modules["bpy"]
    bpy_mock.reset()
    sys.modules.pop("bpy", None)
    importlib.reload(sys.modules["adapter.preferences"])


def test_addon_module_name_is_the_legacy_one_outside_blender():
    """No enabled addon, so nothing to be keyed by. The legacy name is what
    the class has always carried and it stays the fallback."""
    assert _prefs.addon_module_name() == _prefs.LEGACY_ADDON_KEY == LEGACY_MODULE


def test_addon_module_name_follows_the_manifest_install_path(as_module):
    as_module(MANIFEST_MODULE)
    assert _prefs.addon_module_name() == MANIFEST_MODULE


def test_addon_module_name_follows_the_legacy_install_path(as_module):
    as_module(LEGACY_MODULE)
    assert _prefs.addon_module_name() == LEGACY_MODULE


def test_the_pytest_entry_point_import_is_not_mistaken_for_an_install(as_module):
    """`import __init__ as addon` in tests/test_operators.py puts the real
    root module in sys.modules under the name `__init__`. That is not a
    module Blender ever enables and it must not win."""
    as_module("__init__")
    assert _prefs.addon_module_name() == LEGACY_MODULE


def test_bl_idname_is_bound_at_register_time_to_the_manifest_module(
    with_bpy, as_module, isolated_auth_cache
):
    """⚑ THE FIX. Registered from a manifest install, the class carries the
    manifest module name -- which is what Blender matches on."""
    import adapter.preferences as prefs  # reloaded against the bpy mock

    as_module(MANIFEST_MODULE)
    prefs.register()
    try:
        assert prefs.ScrupleAddonPreferences.bl_idname == MANIFEST_MODULE
    finally:
        prefs.unregister()


def test_bl_idname_is_bound_at_register_time_to_the_legacy_module(
    with_bpy, as_module, isolated_auth_cache
):
    """Control (b) for the gate: the fix must not trade one path for the
    other. Registered from a legacy install, the class carries the legacy
    name and binds exactly as it always did."""
    import adapter.preferences as prefs

    as_module(LEGACY_MODULE)
    prefs.register()
    try:
        assert prefs.ScrupleAddonPreferences.bl_idname == LEGACY_MODULE
    finally:
        prefs.unregister()


def test_the_prefs_object_is_found_under_the_manifest_module(
    with_bpy, as_module, isolated_auth_cache
):
    """The consequence that matters: `_addon_prefs()` looks the addon up by
    the same name Blender filed it under, so the API key and base URL fields
    are reachable on the shipping path."""
    import adapter.preferences as prefs

    as_module(MANIFEST_MODULE)

    class _Prefs:
        api_key = ""
        base_url = "http://127.0.0.1:3902"
        verbose_logging = False

    bound = _Prefs()
    with_bpy.context.preferences.addons.register(MANIFEST_MODULE, bound)
    assert prefs._addon_prefs() is bound
    assert prefs.get_base_url() == "http://127.0.0.1:3902"


def test_the_base_url_property_does_not_default_to_production(with_bpy):
    """The field the user finally has. Its default is empty, not the live
    service -- otherwise binding the UI would have re-introduced the very
    fallback this work order removed."""
    import adapter.preferences as prefs

    # Blender properties are annotations, not assignments -- and this
    # module has `from __future__ import annotations`, so the annotation
    # arrives as the SOURCE TEXT of the call rather than as the _PropStub
    # the mock would have built. (Blender itself evaluates it: the legacy
    # install path binds these fields, which is how WO-E7 could measure
    # that the manifest path did not.) Read it either way.
    ann = prefs.ScrupleAddonPreferences.__annotations__["base_url"]
    if isinstance(ann, str):
        call = ast.parse(ann, mode="eval").body
        kwargs = {kw.arg: ast.literal_eval(kw.value) for kw in call.keywords}
    else:
        kwargs = ann.kwargs

    assert kwargs["default"] == ""
    assert "scruple.ai" in kwargs["description"], (
        "the user has to be told what the live service is, since it is no longer assumed"
    )
