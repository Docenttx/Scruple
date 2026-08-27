"""D-3: witnessing without a baseline must be impossible from the SDK,
not merely discouraged. Verified two ways -- the exception, and that no
network call happened at all."""

from __future__ import annotations

import pytest

from scruple_host_sdk import witness_flow
from scruple_host_sdk.errors import NoBaselineError


def test_witness_refuses_locally_with_no_baseline(make_client):
    client, opener = make_client(script=[])
    assert client.state.baseline_ref is None

    with pytest.raises(NoBaselineError):
        witness_flow.witness(client, kind="document_save", content_hash="a" * 64, mime="image/png")

    assert opener.calls == []  # refused before any HTTP request was built


def test_attach_verifies_an_existing_baseline(make_client):
    client, opener = make_client(script=[("ok", 200, {"baseline_ref": "deadbeef" * 8})])

    result = client.attach(code_paths=[])

    assert result.established is False
    assert result.baseline_ref == "deadbeef" * 8
    assert client.state.baseline_ref == "deadbeef" * 8


def test_attach_establishes_when_none_exists(make_client):
    client, opener = make_client(
        script=[
            ("http_error", 404, {"error": {"code": "not_found", "message": "no baseline"}}),
            ("ok", 201, {"baseline_ref": "cafef00d" * 8}),
        ]
    )

    result = client.attach(code_paths=[])

    assert result.established is True
    assert client.state.baseline_ref == "cafef00d" * 8

    # And now witness() no longer refuses.
    opener.script.append(("ok", 201, {"leaf_id": "1", "leaf_hash": "x", "witnessed": True, "leaf_scheme": "v2", "baseline_ref": "cafef00d" * 8}))
    outcome = witness_flow.witness(client, kind="document_save", content_hash="a" * 64, mime="image/png")
    assert outcome.queued is False


def test_attach_failure_leaves_no_baseline_and_witness_still_refuses(make_client):
    client, opener = make_client(
        script=[
            ("http_error", 404, {"error": {"code": "not_found", "message": "no baseline"}}),
            ("network_error",),
        ]
    )

    from scruple_host_sdk.errors import ScrupleAPIError

    with pytest.raises(ScrupleAPIError):
        client.attach(code_paths=[])

    assert client.state.baseline_ref is None
    with pytest.raises(NoBaselineError):
        witness_flow.witness(client, kind="document_save", content_hash="a" * 64, mime="image/png")
