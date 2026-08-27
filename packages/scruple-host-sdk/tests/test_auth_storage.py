"""Key storage: 0600 permissions, never logged, never in an exception
message. The CAD shells write keys to %APPDATA% in plaintext; this is
the floor above that (see auth.py's module docstring for what it does
and does not protect against)."""

from __future__ import annotations

import stat

from scruple_host_sdk import auth as _auth


def test_saved_key_file_is_0600(tmp_path):
    cache_dir = str(tmp_path / ".scruple")
    _auth.save_cached("blender", "sk_live_verysecret", cache_dir=cache_dir)

    path = _auth._cache_file("blender", cache_dir)
    mode = stat.S_IMODE(__import__("os").stat(path).st_mode)
    assert mode == stat.S_IRUSR | stat.S_IWUSR  # 0600, not group/other readable


def test_load_cached_round_trips(tmp_path):
    cache_dir = str(tmp_path / ".scruple")
    _auth.save_cached("meshroom", "sk_live_abc", base_url="https://scruple.ai", cache_dir=cache_dir)

    loaded = _auth.load_cached("meshroom", cache_dir=cache_dir)

    assert loaded["api_key"] == "sk_live_abc"
    assert loaded["base_url"] == "https://scruple.ai"


def test_different_hosts_get_separate_cache_files(tmp_path):
    cache_dir = str(tmp_path / ".scruple")
    _auth.save_cached("blender", "sk_blender_key", cache_dir=cache_dir)
    _auth.save_cached("meshroom", "sk_meshroom_key", cache_dir=cache_dir)

    assert _auth.load_cached("blender", cache_dir=cache_dir)["api_key"] == "sk_blender_key"
    assert _auth.load_cached("meshroom", cache_dir=cache_dir)["api_key"] == "sk_meshroom_key"


def test_clear_cached_removes_the_key(tmp_path):
    cache_dir = str(tmp_path / ".scruple")
    _auth.save_cached("blender", "sk_live_abc", cache_dir=cache_dir)
    _auth.clear_cached("blender", cache_dir=cache_dir)
    assert _auth.load_cached("blender", cache_dir=cache_dir) == {}


def test_apply_manual_key_rejects_malformed_keys(tmp_path):
    cache_dir = str(tmp_path / ".scruple")
    assert _auth.apply_manual_key("blender", "not-a-real-key", cache_dir=cache_dir) is False
    assert _auth.load_cached("blender", cache_dir=cache_dir) == {}


def test_apply_manual_key_accepts_sk_prefixed_key(tmp_path):
    cache_dir = str(tmp_path / ".scruple")
    assert _auth.apply_manual_key("blender", "sk_live_xyz", cache_dir=cache_dir) is True
    assert _auth.load_cached("blender", cache_dir=cache_dir)["api_key"] == "sk_live_xyz"


def test_key_never_appears_in_a_raised_exception_message(tmp_path):
    """capture.py / http.py / client.py never interpolate api_key into an
    error string. Spot-check the modules most likely to (client.py builds
    ScrupleAPIError messages from response bodies, which could echo an
    Authorization header back in a misbehaving server -- but never the
    key itself, which this package never puts in a body)."""
    import inspect

    from scruple_host_sdk import client as _client_mod

    src = inspect.getsource(_client_mod)
    # No f-string / format call anywhere in client.py interpolates the
    # key itself into a message (status/error text is fine; the key is not).
    assert "{self.api_key" not in src
    assert "{api_key" not in src
