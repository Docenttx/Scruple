"""Auth handshake tests -- now against scruple_host_sdk.auth.

Same eleven behaviours the addon's own auth.py was tested for; the SDK's
module is a direct port of that file ("the healthiest of the six forks",
its docstring says) parametrized by `host`. The only shape change in
these tests is that every call names the host, and the cache path is
derived from it: ~/.scruple/blender-auth.json is what host="blender"
produces, which is the same file the old hardcoded constant named.
"""

from __future__ import annotations

import os
import stat
import threading
import time
import urllib.error
import urllib.request

from adapter import sdk as _sdk
from scruple_host_sdk import auth as _auth

HOST = _sdk.HOST


def test_save_and_load_round_trip(isolated_auth_cache):
    _auth.save_cached(HOST, "sk_test_deadbeef", base_url="https://example.test")
    data = _auth.load_cached(HOST)
    assert data["api_key"] == "sk_test_deadbeef"
    assert data["base_url"] == "https://example.test"
    assert "saved_at" in data


def test_cache_path_is_still_the_blender_one(isolated_auth_cache):
    """host="blender" must resolve to blender-auth.json -- an existing
    install's key is in that file and a rename would sign everyone out."""
    assert os.path.basename(_auth._cache_file(HOST)) == "blender-auth.json"


def test_cache_file_permissions(isolated_auth_cache):
    _auth.save_cached(HOST, "sk_test_abc")
    mode = stat.S_IMODE(os.stat(isolated_auth_cache).st_mode)
    assert mode == 0o600


def test_load_missing_returns_empty(isolated_auth_cache):
    assert _auth.load_cached(HOST) == {}


def test_clear_removes_file(isolated_auth_cache):
    _auth.save_cached(HOST, "sk_test_abc")
    assert isolated_auth_cache.exists()
    _auth.clear_cached(HOST)
    assert not isolated_auth_cache.exists()


def test_apply_manual_key_rejects_bad_prefix(isolated_auth_cache):
    assert not _auth.apply_manual_key(HOST, "not-a-key")
    assert _auth.load_cached(HOST) == {}


def test_apply_manual_key_accepts_sk_prefix(isolated_auth_cache):
    assert _auth.apply_manual_key(HOST, "sk_test_valid_abc")
    assert _auth.load_cached(HOST)["api_key"] == "sk_test_valid_abc"


def test_build_signin_url_shape():
    url = _auth.build_signin_url("https://scruple.ai", 53171, host=HOST)
    assert url.startswith("https://scruple.ai/settings/keys/desktop?")
    assert "redirect=http" in url
    assert "callback" in url


def test_callback_server_round_trip(isolated_auth_cache):
    """Spin up the callback server, hit /callback?key=sk_..., verify it exits."""
    server = _auth.LocalCallbackServer(_auth._pick_port())
    server.start()
    port = server.port
    try:
        def _hit():
            time.sleep(0.1)
            urllib.request.urlopen(
                f"http://127.0.0.1:{port}/callback?key=sk_test_helloworld",
                timeout=2,
            ).read()
        t = threading.Thread(target=_hit, daemon=True)
        t.start()
        key = server.wait(timeout_seconds=5)
        t.join(timeout=2)
    finally:
        server.stop()
    assert key == "sk_test_helloworld"


def test_callback_server_rejects_bad_key(isolated_auth_cache):
    server = _auth.LocalCallbackServer(_auth._pick_port())
    server.start()
    port = server.port
    try:
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{port}/callback", timeout=2).read()
        except urllib.error.HTTPError as e:
            assert e.code == 400
        else:
            assert False, "expected 400"
        key = server.wait(timeout_seconds=1)
    finally:
        server.stop()
    assert key is None


def test_run_browser_handshake_returns_none_on_timeout(isolated_auth_cache):
    captured = []

    def _fake_open(url):
        captured.append(url)
        return True

    key = _auth.run_browser_handshake(
        "https://scruple.ai", HOST, open_browser=_fake_open, timeout_seconds=0.5,
    )
    assert key is None
    assert captured, "webbrowser.open should have been called"
    assert captured[0].startswith("https://scruple.ai/settings/keys/desktop?")


def test_run_browser_handshake_receives_key(isolated_auth_cache):
    def _fake_open(url):
        import urllib.parse as up
        parsed = up.urlparse(url)
        qs = dict(up.parse_qsl(parsed.query))
        redirect = qs["redirect"]

        def _post_key():
            time.sleep(0.1)
            urllib.request.urlopen(f"{redirect}?key=sk_test_endtoend", timeout=2).read()

        threading.Thread(target=_post_key, daemon=True).start()
        return True

    key = _auth.run_browser_handshake(
        "https://scruple.ai", HOST, open_browser=_fake_open, timeout_seconds=5,
    )
    assert key == "sk_test_endtoend"
    assert _auth.load_cached(HOST)["api_key"] == "sk_test_endtoend"
