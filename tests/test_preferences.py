"""Preferences module — get_api_key / get_base_url fallback semantics."""

from __future__ import annotations

from lib import preferences as _prefs


def test_get_api_key_prefers_disk_cache_when_no_bpy(isolated_auth_cache, monkeypatch):
    from lib import auth as _auth
    _auth.save_cached("sk_test_fromdisk", base_url="https://scruple.test")
    assert _prefs.get_api_key() == "sk_test_fromdisk"
    assert _prefs.get_base_url() == "https://scruple.test"


def test_get_api_key_empty_when_nothing_cached(isolated_auth_cache):
    assert _prefs.get_api_key() == ""


def test_get_base_url_falls_back_to_default(isolated_auth_cache):
    assert _prefs.get_base_url() == _prefs.DEFAULT_BASE_URL


def test_is_authed_reflects_key_presence(isolated_auth_cache):
    from lib import auth as _auth
    assert not _prefs.is_authed()
    _auth.save_cached("sk_test_authed")
    assert _prefs.is_authed()
