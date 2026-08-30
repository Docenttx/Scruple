"""The component half of H-4, against the SHARED vectors.

`test/vectors/ratchet-vectors.json` is consumed by this file and by
`test/v2/ratchet.test.ts`. That is the entire point: two implementations
that each pass their own tests and disagree on the wire is the failure
this file exists to prevent, and per CANON_SKELETON it is the failure the
six SDK forks actually had.

These vectors were GENERATED from this module. That makes the Python
suite's vector tests a regression check (this module must not drift from
what it once produced) and the TypeScript suite's the real cross-language
proof. The TS suite additionally checks its hand-written full-HKDF against
Node's built-in crypto.hkdfSync, so Node's OpenSSL is an independent third
implementation over the same construction.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import stat

import pytest

from scruple_host_sdk.ratchet import (
    HASH_LEN,
    INFO_IK,
    INFO_MAC,
    INFO_RATCHET,
    CounterExhausted,
    Ratchet,
    RatchetError,
    canonical_preimage,
    derive_ik,
    hkdf_expand,
    hkdf_extract,
    hkdf_sha256,
)

VECTORS_PATH = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "..", "test", "vectors", "ratchet-vectors.json")
)


@pytest.fixture(scope="module")
def vectors():
    assert os.path.exists(VECTORS_PATH), (
        f"shared vectors missing at {VECTORS_PATH}. Both suites read this one file; "
        "if it is gone, the cross-language guarantee is gone with it."
    )
    with open(VECTORS_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


# ---------------------------------------------------------------------------
# RFC 5869 conformance -- so a bug in our HKDF is caught against the RFC's
# own numbers and not only against ourselves.
# ---------------------------------------------------------------------------


def test_rfc5869_test_case_1():
    """RFC 5869 Appendix A.1 -- SHA-256, basic."""
    ikm = bytes.fromhex("0b" * 22)
    salt = bytes.fromhex("000102030405060708090a0b0c")
    info = bytes.fromhex("f0f1f2f3f4f5f6f7f8f9")
    prk = hkdf_extract(salt, ikm)
    assert prk.hex() == "077709362c2e32df0ddc3f0dc47bba6390b6c73bb50f9c3122ec844ad7c2b3e5"
    okm = hkdf_expand(prk, info, 42)
    assert okm.hex() == (
        "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865"
    )


def test_rfc5869_test_case_3_empty_salt_and_info():
    """RFC 5869 Appendix A.3 -- zero-length salt takes the HashLen-zeros path."""
    ikm = bytes.fromhex("0b" * 22)
    prk = hkdf_extract(b"", ikm)
    assert prk.hex() == "19ef24a32c717b167f33a91d6f648bdf96596776afdb6377ac434c1c293ccb04"
    okm = hkdf_expand(prk, b"", 42)
    assert okm.hex() == (
        "8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8"
    )


def test_full_hkdf_is_extract_then_expand():
    assert hkdf_sha256(b"ikm", b"salt", b"info", 32) == hkdf_expand(
        hkdf_extract(b"salt", b"ikm"), b"info", 32
    )


def test_expand_is_not_full_hkdf():
    """The spec's asymmetry, pinned. If someone 'fixes' the chain steps to
    use full HKDF, this fails -- which is the point, because that change is
    silent everywhere else and invalidates every component in the field."""
    k = bytes(range(32))
    assert hkdf_expand(k, INFO_MAC, 32) != hkdf_sha256(k, b"", INFO_MAC, 32)


def test_expand_at_hashlen_is_one_hmac_block():
    """L=32 means T(1) alone: HMAC(prk, info || 0x01). Spelled out so an
    implementer porting this to a third language has the shortest possible
    thing to match."""
    k = bytes(range(32))
    expected = hmac.new(k, INFO_RATCHET + b"\x01", hashlib.sha256).digest()
    assert hkdf_expand(k, INFO_RATCHET, 32) == expected


# ---------------------------------------------------------------------------
# The shared vectors
# ---------------------------------------------------------------------------


def test_vectors_declare_the_construction(vectors):
    c = vectors["construction"]
    assert "FULL HKDF" in c["ik"]
    assert "EXPAND ONLY" in c["mac_key"]
    assert "EXPAND ONLY" in c["next_chain_key"]


def test_ik_matches_vectors(vectors):
    bdk = bytes.fromhex(vectors["bdk_hex"])
    for case in vectors["cases"]:
        ik = bytes(derive_ik(bdk, case["component_id"]))
        assert ik.hex() == case["ik_hex"], case["component_id"]


def test_chain_keys_mac_keys_and_macs_match_vectors(vectors):
    bdk = bytes.fromhex(vectors["bdk_hex"])
    for case in vectors["cases"]:
        r = Ratchet(bytes(derive_ik(bdk, case["component_id"])), 0)
        by_n = {e["n"]: e for e in case["events"]}
        top = max(by_n)
        for n in range(top + 1):
            k_n = r.chain_key()
            pre = canonical_preimage(by_n[n]["preimage_fields"]) if n in by_n else b"filler"
            m_n = hkdf_expand(k_n, INFO_MAC, HASH_LEN)
            used, mac = r.mac(pre)
            assert used == n
            if n in by_n:
                e = by_n[n]
                assert k_n.hex() == e["chain_key_hex"], f"K_{n} for {case['component_id']}"
                assert m_n.hex() == e["mac_key_hex"], f"M_{n} for {case['component_id']}"
                assert pre.decode("utf-8") == e["canonical_preimage_utf8"]
                assert mac == e["mac_hex"], f"mac at n={n}"


def test_large_counter_is_exercised(vectors):
    """A ratchet that is only ever tested at n=0 and n=1 is not tested."""
    ns = {e["n"] for c in vectors["cases"] for e in c["events"]}
    assert 0 in ns and 1 in ns
    assert max(ns) >= 500, "vectors must reach far enough to exercise ratcheting forward"


def test_raw_preimage_vectors(vectors):
    block = vectors["raw_preimage_cases"]
    bdk = bytes.fromhex(vectors["bdk_hex"])
    r = Ratchet(bytes(derive_ik(bdk, block["component_id"])), 0)
    for e in block["events"]:
        assert r.counter == e["n"]
        assert r.chain_key().hex() == e["chain_key_hex"]
        used, mac = r.mac(bytes.fromhex(e["preimage_hex"]))
        assert used == e["n"]
        assert mac == e["mac_hex"]


def test_canonical_preimage_vectors(vectors):
    for c in vectors["canonical_preimage_cases"]:
        pre = canonical_preimage(c["fields"])
        assert pre.decode("utf-8") == c["canonical_utf8"]
        assert pre.hex() == c["canonical_hex"]
        assert hashlib.sha256(pre).hexdigest() == c["sha256_hex"]


# ---------------------------------------------------------------------------
# Ratchet behaviour
# ---------------------------------------------------------------------------


def test_counter_advances_and_is_returned_with_the_mac():
    r = Ratchet(bytes(range(32)))
    assert r.counter == 0
    n0, _ = r.mac(b"a")
    n1, _ = r.mac(b"b")
    assert (n0, n1) == (0, 1)
    assert r.counter == 2


def test_same_preimage_at_different_counters_gives_different_macs():
    """The property that makes the counter mean anything."""
    r = Ratchet(bytes(range(32)))
    _, a = r.mac(b"identical")
    _, b = r.mac(b"identical")
    assert a != b


def test_the_key_that_produced_an_event_is_gone_afterwards():
    """Forward secrecy, at the level Python can actually demonstrate: the
    chain key buffer that MACed event n is zero after the ratchet step, and
    the ratchet holds no way back to it. SHA-256's one-wayness is what makes
    that irreversible; the wipe only shortens the window (see the module
    docstring -- do not oversell it)."""
    r = Ratchet(bytes(range(32)))
    k0 = r.chain_key()
    r.mac(b"event zero")
    k1 = r.chain_key()
    assert k1 != k0
    assert hkdf_expand(k0, INFO_RATCHET, HASH_LEN) == k1  # forward: easy
    # and there is no exposed operation going the other way
    assert not hasattr(r, "rewind")
    assert not hasattr(r, "previous_key")


def test_zeroize_wipes_the_buffer_it_owns():
    r = Ratchet(bytes(range(32)))
    inner = r._k  # noqa: SLF001 -- asserting on the wipe requires reaching it
    assert any(inner)
    r.destroy()
    assert not any(inner), "the bytearray we own must be zero after destroy()"
    assert r.spent


def test_a_destroyed_ratchet_refuses_to_mac():
    r = Ratchet(bytes(range(32)))
    r.destroy()
    with pytest.raises(RatchetError):
        r.mac(b"x")
    r.destroy()  # idempotent


def test_ik_requires_exactly_32_bytes():
    with pytest.raises(RatchetError):
        Ratchet(b"short")
    with pytest.raises(RatchetError):
        Ratchet(bytes(33))


def test_negative_counter_refused():
    with pytest.raises(RatchetError):
        Ratchet(bytes(32), -1)


def test_counter_exhaustion_is_an_error_not_a_wrap():
    r = Ratchet(bytes(range(32)), 2**53)
    with pytest.raises(CounterExhausted):
        r.mac(b"x")


# ---------------------------------------------------------------------------
# Isolation -- the property the whole derivation hierarchy exists for
# ---------------------------------------------------------------------------


def test_a_component_cannot_derive_another_components_ik(vectors):
    """A component holds K_n and nothing else. It has no BDK, so the only
    inputs it can feed the ratchet are its own. Every operation available
    to it from its own state lands nowhere near another component's IK."""
    bdk = bytes.fromhex(vectors["bdk_hex"])
    a, b = vectors["cases"][0], vectors["cases"][1]
    ik_a = bytes(derive_ik(bdk, a["component_id"]))
    ik_b = bytes(derive_ik(bdk, b["component_id"]))
    assert ik_a != ik_b
    assert ik_a.hex() == a["ik_hex"] and ik_b.hex() == b["ik_hex"]

    # Component A, 40 events in, holding only K_40 and its own id.
    ra = Ratchet(ik_a, 0)
    for i in range(40):
        ra.mac(f"event {i}".encode())
    k40 = ra.chain_key()

    reachable = {
        ik_a,
        k40,
        hkdf_expand(k40, INFO_MAC, HASH_LEN),
        hkdf_expand(k40, INFO_RATCHET, HASH_LEN),
        # A tries every label it knows, against B's id and its own:
        hkdf_expand(k40, INFO_IK, HASH_LEN),
        hkdf_sha256(k40, b["component_id"].encode(), INFO_IK, HASH_LEN),
        hkdf_sha256(k40, a["component_id"].encode(), INFO_IK, HASH_LEN),
        hkdf_sha256(ik_a, b["component_id"].encode(), INFO_IK, HASH_LEN),
        # and A ratcheting on regardless
        *(_forward(k40, i) for i in range(1, 200)),
    }
    assert ik_b not in reachable
    # The real statement: without the BDK, B's IK is not a function of
    # anything A holds. With the BDK it is one HKDF call -- which is why
    # the BDK never leaves the server.
    assert hkdf_sha256(bdk, b["component_id"].encode(), INFO_IK, HASH_LEN) == ik_b


def _forward(k: bytes, steps: int) -> bytes:
    for _ in range(steps):
        k = hkdf_expand(k, INFO_RATCHET, HASH_LEN)
    return k


def test_past_mac_keys_are_not_recoverable_from_current_state():
    """After event n the component cannot recompute M_0..M_n-1 -- 'an
    attacker who takes the container gets future events, not history'."""
    r = Ratchet(bytes(range(32)), 0)
    m0 = hkdf_expand(r.chain_key(), INFO_MAC, HASH_LEN)
    for _ in range(10):
        r.mac(b"x")
    k10 = r.chain_key()
    forward_only = {_forward(k10, i) for i in range(0, 50)}
    assert m0 not in forward_only
    assert not any(hkdf_expand(k, INFO_MAC, HASH_LEN) == m0 for k in forward_only)


# ---------------------------------------------------------------------------
# Canonical preimage -- the spec gap this WO had to fill
# ---------------------------------------------------------------------------


def test_key_order_does_not_change_the_preimage():
    assert canonical_preimage({"b": "2", "a": "1"}) == canonical_preimage({"a": "1", "b": "2"})


def test_floats_are_refused_rather_than_silently_formatted():
    """Python repr and JS Number#toString disagree on doubles. A MAC that
    depends on float formatting fails intermittently and unreproducibly."""
    with pytest.raises(RatchetError, match="float"):
        canonical_preimage({"duration": 1.5})


def test_unsupported_types_are_refused():
    with pytest.raises(RatchetError):
        canonical_preimage({"nested": {"a": 1}})  # type: ignore[dict-item]
    with pytest.raises(RatchetError):
        canonical_preimage({"list": [1, 2]})  # type: ignore[dict-item]


def test_non_ascii_survives_unescaped():
    assert canonical_preimage({"k": "café"}) == '{"k":"café"}'.encode("utf-8")


def test_bools_and_null_are_json_literals():
    assert canonical_preimage({"a": True, "b": False, "c": None}) == b'{"a":true,"b":false,"c":null}'


# ---------------------------------------------------------------------------
# Sealed state (§4.4 step 4)
# ---------------------------------------------------------------------------


def test_sealed_state_round_trips_and_is_0600(tmp_path):
    p = str(tmp_path / "state" / "ik.json")
    r = Ratchet(bytes(range(32)), 0)
    r.mac(b"one")
    r.mac(b"two")
    r.seal_to_file(p, component_id="cid-1")
    assert stat.S_IMODE(os.stat(p).st_mode) == 0o600

    cid, restored = Ratchet.load_from_file(p)
    assert cid == "cid-1"
    assert restored.counter == 2
    assert restored.chain_key() == r.chain_key()
    # and it continues the same chain
    assert restored.mac(b"three") == Ratchet(r.chain_key(), 2).mac(b"three")


def test_unknown_sealed_version_refuses_rather_than_guessing(tmp_path):
    p = tmp_path / "ik.json"
    p.write_text(json.dumps({"v": 99, "component_id": "x", "counter": 0, "chain_key_hex": "00" * 32}))
    with pytest.raises(RatchetError):
        Ratchet.load_from_file(str(p))
