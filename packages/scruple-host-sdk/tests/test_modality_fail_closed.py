"""Property 2: an unknown or unavailable modality refuses locally rather
than downgrading to something cheaper that looks similar (CANON_SKELETON
§5). Mandatory per the build brief: a test that the placeholder/unknown
modality path refuses rather than downgrades."""

from __future__ import annotations

import pytest

from scruple_host_sdk import capabilities as _capabilities
from scruple_host_sdk import witness_flow
from scruple_host_sdk.errors import ModalityUnavailableError


def test_unknown_modality_refuses_without_any_network_call(make_client):
    client, opener = make_client(script=[])  # empty: any call raises AssertionError

    cap = _capabilities.check(client, host="blender", mime="image/png", modality="holotape")

    assert cap.available is False
    assert "Unknown modality" in cap.reason
    assert opener.calls == []  # refused before touching the network at all


def test_server_reports_unavailable_refuses_with_the_servers_reason(make_client):
    client, opener = make_client(
        script=[
            (
                "ok",
                200,
                {
                    "modalities": [
                        {
                            "modality": "c2pa",
                            "available": False,
                            "reason": "C2PA has no manifest format for parametric CAD files.",
                        }
                    ]
                },
            )
        ]
    )

    cap = _capabilities.check(client, host="fusion360", mime="model/step", modality="c2pa")

    assert cap.available is False
    assert "parametric CAD" in cap.reason


def test_mark_raises_before_sending_the_mark_request_for_unavailable_modality(make_client):
    client, opener = make_client(
        script=[
            ("ok", 200, {"modalities": [{"modality": "watermark", "available": False, "reason": "no embedder for model/step"}]}),
            # Deliberately no second script entry: if mark() sent the
            # POST anyway, FakeOpener would raise "script exhausted" and
            # fail this test with a different, more confusing error --
            # asserting ModalityUnavailableError proves it never got there.
        ]
    )

    with pytest.raises(ModalityUnavailableError):
        witness_flow.mark(client, leaf_id="1", host="fusion360", mime="model/step", modalities=["watermark"])

    assert len(opener.calls) == 1  # only the capabilities GET, never the mark POST


def test_capabilities_unreachable_fails_closed_not_open(make_client):
    """If GET /capabilities itself cannot be reached, the modality is
    NOT assumed available -- the whole point of failing closed."""
    client, opener = make_client(script=[("network_error",)])

    cap = _capabilities.check(client, host="blender", mime="image/png", modality="chain")

    assert cap.available is False
    assert "Could not reach" in cap.reason


def test_empty_modalities_list_is_valid_and_means_local_lock_only(make_client):
    client, opener = make_client(script=[("ok", 200, {"leaf_id": "1", "modalities_requested": [], "modalities_applied": ["local"], "outstanding": [], "local_lock": {"scr_id": None, "receipt_url": "/x"}, "witnessed": True})])

    outcome = witness_flow.mark(client, leaf_id="1", host="blender", mime="image/png", modalities=[])

    assert outcome.modalities_applied == ["local"]
    assert len(opener.calls) == 1  # no capabilities lookup needed for an empty request
