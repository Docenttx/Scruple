"""End-to-end through the public Client -- the surface an adapter
actually uses. Exercises the path the smaller unit tests exercise in
isolation (witness_flow.witness directly, capture.capture directly) but
through Client.attach() / Client.witness_file() / Client.mark() /
Client.receipt() / Client.verify(), the way Blender's register()
callback and save_post handler would."""

from __future__ import annotations

from scruple_host_sdk import Client
from scruple_host_sdk.errors import NoBaselineError


def test_full_flow_attach_witness_file_mark_receipt(tmp_path, make_client):
    out = tmp_path / "render.png"
    out.write_bytes(b"pretend-png-bytes")

    client, opener = make_client(
        script=[
            ("http_error", 404, {"error": {"code": "not_found", "message": "no baseline"}}),
            ("ok", 201, {"baseline_ref": "a" * 64}),
            ("ok", 201, {"leaf_id": "7", "leaf_hash": "h7", "witnessed": True, "leaf_scheme": "v2", "baseline_ref": "a" * 64}),
            ("ok", 200, {"modalities": [{"modality": "chain", "available": True, "reason": "always applies"}]}),
            (
                "ok",
                200,
                {
                    "leaf_id": "7",
                    "modalities_requested": ["chain"],
                    "modalities_applied": ["local"],
                    "outstanding": [{"modality": "chain", "reason": "not wired to the locker yet"}],
                    "local_lock": {"scr_id": None, "receipt_url": "/api/v2/receipt/7"},
                    "witnessed": True,
                },
            ),
            ("ok", 200, {"leaf_id": "7", "witnessed": True, "modalities_applied": ["local"]}),
        ]
    )

    attach_result = client.attach(code_paths=[__file__])
    assert attach_result.established is True

    outcome = client.witness_file(str(out), mime="image/png", kind="artifact")
    assert outcome.witnessed is True
    assert outcome.leaf_id == "7"
    assert client.state.recent_receipts[0]["leaf_id"] == "7"  # witness_file() records a receipt in session state

    mark_outcome = client.mark(leaf_id="7", mime="image/png", modalities=["chain"])
    assert mark_outcome.modalities_applied == ["local"]
    assert len(mark_outcome.outstanding) == 1
    assert mark_outcome.outstanding[0].modality == "chain"

    receipt = client.receipt("7")
    assert receipt["witnessed"] is True


def test_witness_file_without_attach_raises_before_any_capture_reaches_the_network(tmp_path, make_client):
    out = tmp_path / "render.png"
    out.write_bytes(b"bytes")
    client, opener = make_client(script=[])

    try:
        client.witness_file(str(out), mime="image/png", kind="artifact")
        assert False, "expected NoBaselineError"
    except NoBaselineError:
        pass

    assert opener.calls == []
