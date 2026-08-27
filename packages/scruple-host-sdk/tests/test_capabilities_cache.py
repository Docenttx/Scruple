from __future__ import annotations

from scruple_host_sdk import capabilities as _capabilities


def test_capabilities_are_cached_per_host_and_mime(make_client):
    client, opener = make_client(
        script=[("ok", 200, {"modalities": [{"modality": "chain", "available": True, "reason": "always"}]})]
    )

    first = _capabilities.check(client, host="blender", mime="image/png", modality="chain")
    second = _capabilities.check(client, host="blender", mime="image/png", modality="chain")

    assert first.available is True
    assert second.available is True
    assert len(opener.calls) == 1  # second check() reused the cache, no second GET


def test_different_mime_is_a_cache_miss(make_client):
    client, opener = make_client(
        script=[
            ("ok", 200, {"modalities": [{"modality": "chain", "available": True, "reason": "a"}]}),
            ("ok", 200, {"modalities": [{"modality": "chain", "available": False, "reason": "cad has no pixels"}]}),
        ]
    )

    png = _capabilities.check(client, host="fusion360", mime="image/png", modality="chain")
    step = _capabilities.check(client, host="fusion360", mime="model/step", modality="chain")

    assert png.available is True
    assert step.available is False
    assert len(opener.calls) == 2
