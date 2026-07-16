"""HTTP client tests against the in-memory MockOpener."""

from __future__ import annotations

import json

import pytest

from lib.scruple_client import ScrupleClient, ScrupleClientError
from tests.mocks import http_mock


def _client(opener):
    return ScrupleClient(base_url="https://scruple.test", api_key="sk_test_xyz", opener=opener)


def _hget(headers, name):
    for k, v in headers.items():
        if k.lower() == name.lower():
            return v
    return ""


def test_bearer_header_present():
    opener = http_mock.new()
    opener.register("GET", "/api/projects", {"projects": []})
    c = _client(opener)
    c.list_projects()
    rec = opener.recorded[0]
    assert _hget(rec.headers, "authorization") == "Bearer sk_test_xyz"
    assert "scruple-blender-addon" in _hget(rec.headers, "user-agent")


def test_list_projects_unwraps_projects_key():
    opener = http_mock.new()
    opener.register("GET", "/api/projects", {"projects": [{"id": 1}], "activeId": 1})
    projs = _client(opener).list_projects()
    assert projs == [{"id": 1}]


def test_create_project_sends_kind():
    opener = http_mock.new()
    opener.register("POST", "/api/projects", {"ok": True, "id": 42, "name": "X", "status": "unlocked"})
    resp = _client(opener).create_project(name="X", kind="cad")
    assert resp["id"] == 42
    body = opener.recorded[0].body
    assert body["name"] == "X"
    assert body["kind"] == "cad"


def test_witness_posts_expected_body():
    opener = http_mock.new()
    opener.register("POST", "/api/witness/cad", {
        "ok": True, "iteration": {"id": 1}, "leafHash": "abc" * 21 + "d",
        "runSequence": 1, "machineManifestHash": "deadbeef" * 8,
    })
    resp = _client(opener).witness(
        99, filename="out.png",
        inline_base64="aGVsbG8=",
        machine_manifest={"host": "blender"},
        prompt="hi",
    )
    assert resp["ok"] is True
    body = opener.recorded[0].body
    assert body["projectId"] == 99
    assert body["filename"] == "out.png"
    assert body["inlineBase64"] == "aGVsbG8="
    assert body["machineManifest"] == {"host": "blender"}
    assert body["prompt"] == "hi"


def test_error_raises_scruple_client_error():
    opener = http_mock.new()
    opener.register("GET", "/api/projects", {"error": "boom"}, status=500)
    with pytest.raises(ScrupleClientError) as exc:
        _client(opener).list_projects()
    assert exc.value.status == 500


def test_create_payment_intent_posts_action_and_project():
    opener = http_mock.new()
    opener.register("POST", "/api/stripe/payment-intent", {"paymentIntentId": "pi_123", "status": "succeeded"})
    resp = _client(opener).create_payment_intent(42, action="checkpoint")
    assert resp["paymentIntentId"] == "pi_123"
    body = opener.recorded[0].body
    assert body["projectId"] == 42
    assert body["action"] == "checkpoint"


def test_lock_endpoints_carry_pi():
    for endpoint, method in [
        ("lock_checkpoint", "/api/lock/checkpoint"),
        ("lock_local", "/api/lock/local"),
        ("lock_chain", "/api/lock/chain"),
    ]:
        opener = http_mock.new()
        opener.register("POST", method, {"ok": True})
        client = _client(opener)
        if endpoint == "lock_chain":
            getattr(client, endpoint)(42, "pi_abc", tier="pinned")
            body = opener.recorded[0].body
            assert body["tier"] == "pinned"
        else:
            getattr(client, endpoint)(42, "pi_abc")
            body = opener.recorded[0].body
        assert body["projectId"] == 42
        assert body["paymentIntentId"] == "pi_abc"


def test_get_project_by_id():
    opener = http_mock.new()
    opener.register("GET", "/api/projects/7", {"id": 7, "status": "unlocked"})
    resp = _client(opener).get_project(7)
    assert resp["id"] == 7
