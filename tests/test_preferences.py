"""adapter/preferences.py -- the value-reading half, over the SDK's cache.

gap.json, modules row 9: the AddonPreferences subclass and its draw()
stay (they are Blender's), and `get_api_key`/`get_base_url`/
`sync_from_cache` lose their own copy of the cache read. These tests are
the old ones with the same assertions; what changed underneath is which
module opens the file.
"""

from __future__ import annotations

from adapter import preferences as _prefs
from adapter import sdk as _sdk
from scruple_host_sdk import auth as _auth
from scruple_host_sdk.preferences import DEFAULT_BASE_URL


def test_get_api_key_prefers_disk_cache_when_no_bpy(isolated_auth_cache):
    _auth.save_cached(_sdk.HOST, "sk_test_fromdisk", base_url="https://scruple.test")
    assert _prefs.get_api_key() == "sk_test_fromdisk"
    assert _prefs.get_base_url() == "https://scruple.test"


def test_get_api_key_empty_when_nothing_cached(isolated_auth_cache):
    assert _prefs.get_api_key() == ""


def test_get_base_url_falls_back_to_default(isolated_auth_cache):
    assert _prefs.get_base_url() == DEFAULT_BASE_URL


def test_is_authed_reflects_key_presence(isolated_auth_cache):
    assert not _prefs.is_authed()
    _auth.save_cached(_sdk.HOST, "sk_test_authed")
    assert _prefs.is_authed()


def test_no_client_is_built_without_a_key(isolated_auth_cache, fresh_state):
    """get_client() returns None rather than an unauthenticated Client --
    a Client with no key would fail later, in a worker thread, as a 401."""
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
