"""The SDK Client, as the addon drives it.

This file replaces the tests for lib/scruple_client.py, whose subject no
longer exists. What survives is every property those tests actually
asserted -- a bearer header goes out, a body is shaped the way the route
expects, an error is surfaced rather than swallowed -- restated against
the routes the addon now calls. What is new is the two properties the v1
client could not have had: a failed Phase-3 call is on disk before the
caller hears about it, and a query is not.
"""

from __future__ import annotations

import pytest

from adapter import sdk as _sdk
from scruple_host_sdk.errors import NoBaselineError, ScrupleAPIError
from tests.mocks import http_mock, v2


def _hget(headers, name):
    for k, v in headers.items():
        if k.lower() == name.lower():
            return v
    return ""


def test_bearer_header_present(attached_client, http_opener):
    rec = http_opener.recorded[0]
    assert _hget(rec.headers, "authorization") == "Bearer sk_test_xyz"
    assert "scruple-host-sdk" in _hget(rec.headers, "user-agent")


def test_client_identifies_itself_as_blender(sdk_client):
    assert sdk_client.host == "blender"
    assert sdk_client.integration_version == _sdk.integration_version()


def test_attach_establishes_a_baseline_when_the_server_has_none(sdk_client, http_opener):
    v2.register_v2(http_opener, baseline_exists=False)
    result = sdk_client.attach(code_paths=[])
    assert result.established is True
    assert sdk_client.state.baseline_ref == v2.BASELINE_REF
    paths = [r.path for r in http_opener.recorded]
    assert "/api/v2/baseline/current" in paths
    assert "/api/v2/baseline" in paths


def test_attach_verifies_an_existing_baseline_without_creating_one(sdk_client, http_opener):
    v2.register_v2(http_opener, baseline_exists=True)
    result = sdk_client.attach(code_paths=[])
    assert result.established is False
    assert [r.path for r in http_opener.recorded if r.method == "POST"] == []


def test_witness_without_a_baseline_is_refused_before_any_network_call(sdk_client, http_opener):
    """D-3. The refusal is client-side; the control is that the opener
    recorded nothing at all."""
    with pytest.raises(NoBaselineError):
        sdk_client.witness(kind="render", content_hash="a" * 64, mime="image/png")
    assert http_opener.recorded == []


def test_witness_posts_v2_and_reads_witnessed_out_by_name(attached_client, http_opener):
    outcome = attached_client.witness(kind="render", content_hash="b" * 64, mime="image/png")
    assert outcome.witnessed is True
    assert outcome.leaf_id
    post = [r for r in http_opener.recorded if r.path == "/api/v2/witness"][0]
    assert post.body["baseline_ref"] == v2.BASELINE_REF
    assert post.body["mime"] == "image/png"
    assert post.body["content_hash"] == "b" * 64


def test_a_delivered_but_unwitnessed_response_is_not_reported_as_witnessed(sdk_client, http_opener):
    """D-8: witnessed is read from the body, never inferred from a 200."""
    v2.register_v2(http_opener, witnessed=False)
    sdk_client.attach(code_paths=[])
    outcome = sdk_client.witness(kind="render", content_hash="c" * 64, mime="image/png")
    assert outcome.witnessed is False
    assert outcome.queued is False
    assert outcome.leaf_id, "the server did return a leaf id; only `witnessed` was false"


def test_a_5xx_on_witness_is_queued_before_the_caller_hears_about_it(attached_client, http_opener):
    """Queue-by-construction. The entry is on disk by the time witness()
    returns -- not because a caller remembered to enqueue it."""
    http_opener.register("POST", "/api/v2/witness", {"error": "db offline"}, status=503)
    outcome = attached_client.witness(kind="render", content_hash="d" * 64, mime="image/png")
    assert outcome.queued is True
    assert outcome.witnessed is False
    assert attached_client.queue_depth == 1
    [entry] = attached_client.queue.load_all()
    assert entry["kind"] == "witness"
    assert entry["path"] == "/api/v2/witness"
    assert entry["body"]["content_hash"] == "d" * 64


def test_a_failed_query_is_NOT_queued(attached_client, http_opener):
    """The control for the check above. /receipt is a query: there is
    nothing to replay, so a failure must not spool."""
    http_opener.register("GET", "/api/v2/receipt/leaf_x", {"error": "boom"}, status=503)
    with pytest.raises(ScrupleAPIError):
        attached_client.receipt("leaf_x")
    assert attached_client.queue_depth == 0


def test_detach_drains_what_the_outage_queued(attached_client, http_opener):
    http_opener.register("POST", "/api/v2/witness", {"error": "db offline"}, status=503)
    attached_client.witness(kind="render", content_hash="e" * 64, mime="image/png")
    assert attached_client.queue_depth == 1

    v2.register_v2(http_opener)  # server comes back
    result = attached_client.detach()
    assert result["succeeded"] == 1
    assert attached_client.queue_depth == 0


def test_receipt_and_verify_hit_the_v2_read_routes(attached_client, http_opener):
    http_opener.register("GET", "/api/v2/receipt/leaf_abc", {"leaf_id": "leaf_abc"})
    http_opener.register("GET", "/api/v2/verify/" + "f" * 64, {"verified": True})
    assert attached_client.receipt("leaf_abc")["leaf_id"] == "leaf_abc"
    assert attached_client.verify("f" * 64)["verified"] is True


def test_error_status_is_surfaced_not_swallowed(attached_client, http_opener):
    http_opener.register("GET", "/api/v2/receipt/nope", {"error": "not found"}, status=404)
    with pytest.raises(ScrupleAPIError) as exc:
        attached_client.receipt("nope")
    assert exc.value.status == 404
