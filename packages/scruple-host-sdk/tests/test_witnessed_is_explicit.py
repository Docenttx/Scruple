"""D-8: `witnessed` is always explicit and never inferred from the HTTP
status code. §5's non-blocking-capture design means a 201 can legitimately
carry witnessed=false (the witness service was unreachable but the event
still landed) -- the SDK must surface exactly that, not paper over it."""

from __future__ import annotations

from scruple_host_sdk import witness_flow


def test_201_with_witnessed_false_is_reported_as_false_not_coerced_true(make_client):
    """This is the exact bug D-8 fixed server-side (ingest.ts returning
    ok:true over a failed witness). Prove the client doesn't reintroduce
    it by reading the status instead of the field."""
    client, opener = make_client(
        script=[
            (
                "ok",
                201,
                {
                    "leaf_id": "42",
                    "leaf_hash": "raw-content-hash-used-as-fallback",
                    "witnessed": False,
                    "leaf_scheme": "v1",
                    "baseline_ref": "a" * 64,
                },
            )
        ]
    )
    client.state.baseline_ref = "a" * 64

    outcome = witness_flow.witness(client, kind="document_save", content_hash="b" * 64, mime="image/png")

    assert outcome.witnessed is False
    assert outcome.leaf_scheme == "v1"
    assert outcome.leaf_id == "42"  # captured, just not witnessed -- both true at once


def test_201_with_witnessed_true_is_reported_as_true(make_client):
    client, opener = make_client(
        script=[
            ("ok", 201, {"leaf_id": "43", "leaf_hash": "h", "witnessed": True, "leaf_scheme": "v2", "baseline_ref": "a" * 64}),
        ]
    )
    client.state.baseline_ref = "a" * 64

    outcome = witness_flow.witness(client, kind="document_save", content_hash="c" * 64, mime="image/png")

    assert outcome.witnessed is True
    assert outcome.leaf_scheme == "v2"


def test_missing_witnessed_field_defaults_false_never_true(make_client):
    """If the server ever omitted the field, the SDK must not treat 2xx
    as an implicit witnessed=True."""
    client, opener = make_client(script=[("ok", 201, {"leaf_id": "44", "leaf_hash": "h", "baseline_ref": "a" * 64})])
    client.state.baseline_ref = "a" * 64

    outcome = witness_flow.witness(client, kind="document_save", content_hash="d" * 64, mime="image/png")

    assert outcome.witnessed is False
