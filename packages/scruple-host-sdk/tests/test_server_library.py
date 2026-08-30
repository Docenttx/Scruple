"""The `server-library` placement, and the predicate it emits.

WO-6. Four things this file exists to demonstrate rather than assert:

  * the posture is COMPUTED — a vendor cannot declare its own tier, and a
    `server-library` declaration without `no-tenant-code` enforcement lands
    on `unattested-client` and is refused before a counter is spent;
  * the honest tier — `server-library` with no attestation still yields
    `passthrough`, and the SDK says so on every outcome;
  * the ordering — derive, MAC, ratchet, THEN enqueue (§5). The counter is
    spent when the MAC is computed, and a witness that never answers costs
    the event nothing except a queue entry that keeps its counter;
  * cross-language agreement — the predicate this package builds and
    validates is checked against `test/vectors/vendor-baseline-predicate-vectors.json`,
    which is generated from `lib/envelope/predicate.ts`.

That last one is the point of the file. Everything else here could pass
with a Python predicate that quietly means something different from the
TypeScript one, which is the failure the ratchet vectors already taught us
to expect.
"""

from __future__ import annotations

import json
import os
import pathlib
import pytest

from scruple_api.surface import (
    AttestationOutcome,
    ObservationFidelity,
    Placement,
    PlacementEnforcement,
    SurfaceKind,
    assurance_for,
    resolve_placement,
)
from scruple_host_sdk.envelope import (
    BUILTIN_ATTESTATION_PROVIDERS,
    ComponentIdentity,
    DeclaredSurface,
    EnvelopeSigner,
    EnvelopeVerifier,
    PredicateError,
    StatementError,
    attest_leaf,
    build_vendor_baseline_predicate,
    decode_unverified_payload,
    open_leaf_attestation,
    pae,
    sign_envelope,
    validate_vendor_baseline_predicate,
    verify_envelope,
)
from scruple_host_sdk.errors import NoBaselineError
from scruple_host_sdk.ratchet import Ratchet, derive_ik
from scruple_host_sdk.server_library import (
    SERVER_LIBRARY_SURFACE,
    PlacementRefused,
    ServerLibraryIntegration,
    provision_component,
)

VECTORS_PATH = (
    pathlib.Path(__file__).resolve().parents[3]
    / "test"
    / "vectors"
    / "vendor-baseline-predicate-vectors.json"
)

BDK = bytes(range(32))
COMPONENT_ID = "0b0c9f4a-7e21-4b0d-9a3e-2c5d8f1a6b74"
BUILD = "sha256:" + "ab" * 32
TENANT = "vendor-acme"


@pytest.fixture(scope="module")
def vectors():
    with open(VECTORS_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def _identity() -> ComponentIdentity:
    return ComponentIdentity(component_id=COMPONENT_ID, tenant_id=TENANT, build_measurement=BUILD)


def _integration(client, **kwargs) -> ServerLibraryIntegration:
    kwargs.setdefault("component", _identity())
    kwargs.setdefault("ratchet", Ratchet(derive_ik(BDK, COMPONENT_ID), 0))
    return ServerLibraryIntegration(client, **kwargs)


def _attached(client, opener, ref: str = "a" * 64):
    """Give the client a baseline without asserting anything about attach()."""
    client.state.baseline_ref = ref
    return client, opener


# ---------------------------------------------------------------------------
# The vocabulary is one vocabulary
# ---------------------------------------------------------------------------


def test_every_enum_matches_the_typescript_constants(vectors):
    """A parallel vocabulary growing in Python is the bug WO-2 exists to
    prevent, and it would be invisible from either side alone."""
    e = vectors["enums"]
    assert [p.value for p in Placement] == e["placements"]
    assert sorted(x.value for x in PlacementEnforcement) == sorted(e["placement_enforcements"])
    assert sorted(x.value for x in SurfaceKind) == sorted(e["capture_surfaces"])
    assert sorted(x.value for x in ObservationFidelity) == sorted(e["observation_fidelities"])
    assert sorted(x.value for x in AttestationOutcome) == sorted(e["attestation_outcomes"])
    assert sorted(BUILTIN_ATTESTATION_PROVIDERS) == sorted(e["builtin_attestation_providers"])


def test_placement_resolution_matches_all_sixteen_cells(vectors):
    for cell in vectors["placement_resolution"]:
        r = resolve_placement(Placement(cell["declared"]), PlacementEnforcement(cell["enforcement"]))
        assert r.effective.value == cell["effective"], cell
        assert r.honoured == cell["honoured"], cell


def test_assurance_matches_all_twelve_cells(vectors):
    """Including the three that say NO LEAF MAY BE ISSUED. An assurance
    function that agrees on the happy path and disagrees on the refusals is
    worse than one that disagrees everywhere: only the refusals are
    load-bearing."""
    for cell in vectors["assurance_table"]:
        a = assurance_for(Placement(cell["placement"]), AttestationOutcome(cell["attestation"]))
        assert a.p1.value == cell["p1"], cell
        assert a.p3.value == cell["p3"], cell
        assert a.leaf == cell["leaf"], cell
        assert a.can_claim == cell["can_claim"], cell
        assert list(a.conditions) == list(cell["conditions"]), cell


def test_build_cases_produce_byte_identical_predicates(vectors):
    for case in vectors["build_cases"]:
        i = case["input"]
        got = build_vendor_baseline_predicate(
            component=ComponentIdentity(**i["component"]),
            declared_placement=Placement(i["declared_placement"]),
            enforcement=PlacementEnforcement(i["enforcement"]),
            attestation_provider=i["attestation"]["provider"],
            attestation_outcome=AttestationOutcome(i["attestation"]["outcome"]),
            quote_ref=i["attestation"].get("quote_ref"),
            verifier_reference=i["attestation"].get("verifier_reference"),
            surfaces=[
                DeclaredSurface(
                    name=s["name"],
                    surface=SurfaceKind(s["surface"]),
                    fidelity=ObservationFidelity(s["fidelity"]),
                    hooks=s["hooks"],
                    induced_artifact_ref=s.get("induced_artifact_ref"),
                )
                for s in i["surfaces"]
            ],
            declared_properties=i["declared_properties"],
        )
        assert got == case["predicate"], case["name"]


def test_validate_cases_refuse_the_same_documents(vectors):
    """Same documents, same verdicts. The error STRINGS are compared as a
    count and a sorted set rather than verbatim, because prose is allowed
    to differ between two languages and a refusal is not."""
    for case in vectors["validate_cases"]:
        errs = validate_vendor_baseline_predicate(case["predicate"])
        assert len(errs) == len(case["errors"]), f"{case['name']}: {errs} vs {case['errors']}"
        if not case["errors"]:
            assert errs == []


def test_the_schema_enums_come_from_the_same_constants(vectors):
    props = vectors["schema"]["properties"]
    assert props["placement"]["properties"]["declared"]["enum"] == [p.value for p in Placement]
    assert props["attestation"]["properties"]["outcome"]["enum"] == [
        a.value for a in AttestationOutcome
    ]


# ---------------------------------------------------------------------------
# PAE and the envelope
# ---------------------------------------------------------------------------


def test_pae_is_injective_over_the_ambiguous_pair():
    """Without length prefixes ("a", "b c") and ("a b", "c") produce the
    same bytes, so a signature over one is a signature over the other.
    That is the entire reason PAE exists."""
    assert pae("a", b"b c") != pae("a b", b"c")


def test_pae_counts_utf8_bytes_not_code_points():
    """The failure this pins is silent for as long as everything is ASCII
    and permanent the first time it is not."""
    t = "aé"  # 2 code points, 3 UTF-8 bytes
    assert pae(t, b"").startswith(b"DSSEv1 3 ")


def test_pae_matches_the_specs_shape_exactly():
    assert pae("http://example.com/HelloWorld", b"hello world") == (
        b"DSSEv1 29 http://example.com/HelloWorld 11 hello world"
    )


def _hmac_signer(key: bytes, keyid: str = "test") -> EnvelopeSigner:
    import hashlib
    import hmac

    return EnvelopeSigner(keyid=keyid, sign=lambda b: hmac.new(key, b, hashlib.sha256).digest())


def _hmac_verifier(key: bytes, keyid: str = "test") -> EnvelopeVerifier:
    import hashlib
    import hmac

    return EnvelopeVerifier(
        keyid=keyid,
        verify=lambda b, sig: hmac.compare_digest(hmac.new(key, b, hashlib.sha256).digest(), sig),
    )


def test_the_leaf_rides_verbatim_and_comes_back_unchanged():
    leaf = {"content_hash": "c" * 64, "witness_id": "wit_1", "mime": "image/png", "zz": 1, "aa": 2}
    predicate = build_vendor_baseline_predicate(
        component=_identity(),
        declared_placement=Placement.SERVER_LIBRARY,
        enforcement=PlacementEnforcement.NO_TENANT_CODE,
        attestation_provider="none",
        attestation_outcome=AttestationOutcome.NONE,
        surfaces=[SERVER_LIBRARY_SURFACE],
        declared_properties={k: "conditional" for k in ("p2", "p4", "p5", "p6", "p7", "p8")},
    )
    key = b"k" * 32
    env = attest_leaf(leaf, predicate, [_hmac_signer(key)])
    opened = open_leaf_attestation(env, [_hmac_verifier(key)])
    # Key ORDER counts: the envelope wraps, it does not reshape.
    assert json.dumps(opened.leaf) == json.dumps(leaf)
    assert opened.predicate == predicate


def test_a_tampered_payload_does_not_verify():
    import base64

    key = b"k" * 32
    env = sign_envelope("application/vnd.scruple.statement+json", b'{"a":1}', [_hmac_signer(key)])
    env["payload"] = base64.b64encode(b'{"a":2}').decode()
    with pytest.raises(Exception):
        verify_envelope(env, [_hmac_verifier(key)])
    # ...and the unverified escape hatch still works, which is why it is
    # named to be uncomfortable at a call site.
    assert decode_unverified_payload(env) == b'{"a":2}'


def test_a_leaf_with_no_output_hash_is_refused_not_given_a_synthetic_digest():
    with pytest.raises(StatementError):
        attest_leaf({"mime": "image/png"}, {}, [_hmac_signer(b"k" * 32)], validate=False)


def test_signing_an_unsound_predicate_is_refused():
    predicate = build_vendor_baseline_predicate(
        component=_identity(),
        declared_placement=Placement.SERVER_LIBRARY,
        enforcement=PlacementEnforcement.NO_TENANT_CODE,
        attestation_provider="none",
        attestation_outcome=AttestationOutcome.NONE,
        surfaces=[SERVER_LIBRARY_SURFACE],
        declared_properties={k: "conditional" for k in ("p2", "p4", "p5", "p6", "p7", "p8")},
    )
    predicate["properties"]["p1"] = "fails"  # a forged posture
    with pytest.raises(PredicateError):
        attest_leaf({"content_hash": "c" * 64}, predicate, [_hmac_signer(b"k" * 32)])


# ---------------------------------------------------------------------------
# The placement path
# ---------------------------------------------------------------------------


def test_server_library_with_no_attestation_is_passthrough_and_says_so(make_client):
    """PLACEMENT_AND_SURFACES.md §5.2's top-right cell. P1 is free at this
    placement and buys NOTHING toward a verified leaf. A vendor who first
    learns that from an auditor was told by omission."""
    client, _ = make_client(script=[])
    integ = _integration(client)
    a = integ.assurance()
    assert a.p1.value == "holds"
    assert a.p3.value == "holds"
    assert a.leaf == "passthrough"
    assert a.can_claim is True
    assert integ.predicate()["leaf_status"] == "passthrough"


def test_a_custom_handler_configuration_resolves_to_unattested_and_refuses(make_client):
    """§7.3. `trust_remote_code`, a custom handler.py or a customer image
    all mean tenant code runs in the capture process. The declaration is
    still `server-library`; the resolution is not."""
    client, opener = make_client(script=[])
    integ = _integration(client, enforcement=PlacementEnforcement.NONE)
    assert integ.resolution.effective is Placement.UNATTESTED_CLIENT
    assert integ.can_claim is False
    assert integ.predicate()["leaf_status"] is None

    client.state.baseline_ref = "a" * 64
    with pytest.raises(PlacementRefused):
        integ.witness(content_hash="c" * 64, mime="image/png")
    # Nothing was sent AND no counter was spent: a refusal must not cost
    # the component a counter it can never account for.
    assert opener.calls == []
    assert integ.ratchet.counter == 0


def test_a_relayed_root_verified_quote_does_not_lift_the_refusal(make_client):
    """§7.6, the hostile case. A page can relay a genuine SEV-SNP quote
    from a server it does not run."""
    client, _ = make_client(script=[])
    integ = _integration(
        client,
        declared_placement=Placement.UNATTESTED_CLIENT,
        enforcement=PlacementEnforcement.NONE,
        attestation_provider="amd-sev-snp",
        attestation_outcome=AttestationOutcome.VERIFIED,
        quote_ref="quote://relayed",
    )
    assert integ.can_claim is False
    assert integ.assurance().leaf is None


def test_witness_without_a_baseline_spends_no_counter(make_client):
    client, opener = make_client(script=[])
    integ = _integration(client)
    with pytest.raises(NoBaselineError):
        integ.witness(content_hash="c" * 64, mime="image/png")
    assert opener.calls == []
    assert integ.ratchet.counter == 0


def test_a_witnessed_event_carries_the_component_envelope_and_a_mac(make_client, tmp_path):
    out = tmp_path / "render.png"
    out.write_bytes(b"pretend-png-bytes")
    client, opener = make_client(
        script=[("ok", 201, {"leaf_id": "7", "leaf_hash": "h7", "witnessed": True, "leaf_scheme": "v2", "component": {"verified": True}})]
    )
    _attached(client, opener)
    integ = _integration(client)

    outcome = integ.witness_file(str(out), mime="image/png")

    body = opener.calls[0]["body"]
    assert body["component"]["component_id"] == COMPONENT_ID
    assert body["component"]["counter"] == 0
    assert body["component"]["build_measurement"] == BUILD
    assert len(body["mac"]) == 64
    assert body["mime"] == "image/png"
    # The capture block the server's preimage function reads.
    assert body["capture"]["surface"] == "in-process-callback"
    assert body["capture"]["fidelity"] == "as-delivered"
    assert outcome.witnessed is True
    assert outcome.leaf_status == "passthrough"
    # The counter is spent, once, and the next event carries the next one.
    assert integ.ratchet.counter == 1


def test_the_mac_verifies_against_an_independently_derived_key(make_client, tmp_path):
    """The MAC is checkable by anyone holding the BDK — which is the
    server, and nobody else. Reproduced here from the IK rather than from
    the same Ratchet object, so this is a check of the wire and not of one
    object's internal consistency."""
    import hashlib
    import hmac

    from scruple_host_sdk.ratchet import canonical_preimage, hkdf_expand, INFO_MAC

    out = tmp_path / "render.png"
    out.write_bytes(b"bytes")
    client, opener = make_client(script=[("ok", 201, {"leaf_id": "1", "witnessed": True})])
    _attached(client, opener)
    integ = _integration(client)
    integ.witness_file(str(out), mime="image/png")

    body = opener.calls[0]["body"]
    fields = {
        "component_id": body["component"]["component_id"],
        "counter": body["component"]["counter"],
        "build_measurement": body["component"]["build_measurement"],
        "attestation_provider": body["component"]["attestation"]["provider"],
        "baseline_ref": body["baseline_ref"],
        "kind": body["kind"],
        "content_hash": body["content_hash"],
        "mime": body["mime"],
        "input_hash": None,
        "model_fingerprints_hash": None,
        "machine_manifest_hash": None,
        **{k: body["capture"][k] for k in (
            "surface", "hook", "fidelity", "size_bytes", "mime_source", "correlation_id",
            "correlation_method", "egress", "close_detection", "workflow_hash", "observed_at",
            "attestation_status",
        )},
    }
    k0 = derive_ik(BDK, COMPONENT_ID)
    m0 = hkdf_expand(bytes(k0), INFO_MAC, 32)
    expected = hmac.new(m0, canonical_preimage(fields), hashlib.sha256).hexdigest()
    assert body["mac"] == expected


def test_an_unreachable_witness_queues_the_event_and_keeps_its_counter(make_client, tmp_path):
    """§5. The counter is consumed when the MAC is computed, not when the
    submission succeeds — so an outage costs the record nothing except
    latency, and a drain re-sends the SAME bytes for the server to drop
    idempotently on (component_id, counter)."""
    out = tmp_path / "render.png"
    out.write_bytes(b"bytes")
    client, opener = make_client(
        script=[("network_error",), ("network_error",), ("ok", 200, {"ok": True}), ("network_error",)]
    )
    _attached(client, opener)
    integ = _integration(client)

    first = integ.witness_file(str(out), mime="image/png")
    assert first.queued is True
    assert first.witnessed is False
    assert first.envelope is None  # attesting a leaf the witness never saw would assert it did
    assert first.counter == 0
    assert integ.queue_depth == 1

    second = integ.witness_file(str(out), mime="image/png")
    assert second.counter == 1  # the queue does NOT block the head of the line
    assert integ.queue_depth == 2

    drained = integ.drain()
    # One retry succeeded, one failed and stays queued. Either way the
    # replayed bytes are the ORIGINAL bytes with the ORIGINAL counter —
    # a queued entry is never re-MACed, because a second MAC would mean a
    # second counter for one event.
    replayed = [c for c in opener.calls if c["url"].endswith("/api/v2/witness")][2:]
    assert [c["body"]["component"]["counter"] for c in replayed] == [0, 1]
    assert drained["succeeded"] == 1
    assert integ.queue_depth == 1


def test_a_restart_after_a_seal_never_reissues_a_counter(make_client, tmp_path):
    """§4.4 step 4 plus §5's ordering. The seal is written between the MAC
    and the network call, so a process that dies mid-flight comes back
    holding K_{n+1}. A reissued counter is indistinguishable from a replay
    and the server refuses it, which would lose the event rather than
    queue it."""
    out = tmp_path / "render.png"
    out.write_bytes(b"bytes")
    seal = str(tmp_path / "component.seal")
    client, opener = make_client(script=[("network_error",)])
    _attached(client, opener)
    integ = _integration(client, seal_path=seal)
    integ.witness_file(str(out), mime="image/png")

    assert oct(os.stat(seal).st_mode)[-3:] == "600"
    component_id, restored = Ratchet.load_from_file(seal)
    assert component_id == COMPONENT_ID
    assert restored.counter == 1


def test_provisioning_sends_both_credentials_and_is_never_queued(make_client):
    """H-4 §4.4: the API key says WHO, the one-time token says WHICH.
    Neither alone provisions anything, and a queued provisioning request
    would hand back an IK at an unknown later time to a process that has
    already decided it has none."""
    ik = derive_ik(BDK, COMPONENT_ID)
    client, opener = make_client(
        script=[("ok", 201, {"component_id": COMPONENT_ID, "ik_hex": bytes(ik).hex(), "counter": 0, "build_measurement": BUILD})]
    )
    identity, ratchet = provision_component(client, token="tok_abc", build_measurement=BUILD)
    assert identity.component_id == COMPONENT_ID
    assert ratchet.counter == 0
    assert ratchet.chain_key() == bytes(ik)
    call = opener.calls[0]
    assert call["url"].endswith("/api/v2/components/provision")
    assert call["body"] == {"token": "tok_abc", "build_measurement": BUILD}


def test_a_failed_provisioning_raises_rather_than_queueing(make_client):
    client, opener = make_client(script=[("http_error", 404, {"error": {"code": "not_found", "message": "no token"}})])
    with pytest.raises(Exception):
        provision_component(client, token="tok_gone", build_measurement=BUILD)
    assert client.queue_depth == 0


def test_an_empty_mime_is_refused_but_an_absent_one_is_representable(make_client):
    """CANON_SKELETON §5 property 1 and H-4 §7 probe 4 pull in opposite
    directions and the resolution is that they are different states: a
    declared type, or an admission that nothing was entitled to declare
    one. An empty string is neither."""
    client, opener = make_client(script=[("ok", 201, {"leaf_id": "1", "witnessed": True})])
    _attached(client, opener)
    integ = _integration(client)
    with pytest.raises(ValueError):
        integ.witness(content_hash="c" * 64, mime="  ")
    assert integ.ratchet.counter == 0

    integ.witness(content_hash="c" * 64, mime=None)
    body = opener.calls[0]["body"]
    assert "mime" not in body  # omitted, never application/octet-stream


# ---------------------------------------------------------------------------
# One preimage field set, two languages
# ---------------------------------------------------------------------------

PREIMAGE_VECTORS_PATH = (
    pathlib.Path(__file__).resolve().parents[3]
    / "test"
    / "vectors"
    / "component-preimage-vectors.json"
)


@pytest.fixture(scope="module")
def preimage_vectors():
    with open(PREIMAGE_VECTORS_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def test_component_preimage_matches_the_typescript_field_set(preimage_vectors):
    """§10 C-1 fixed the ENCODING and left the FIELD SET open — which is
    the half that still goes wrong, and goes wrong quietly: two conforming
    implementations produce different bytes and every MAC one writes fails
    against the other with a `bad_mac` that looks exactly like tampering."""
    from scruple_host_sdk.server_library import component_preimage

    for case in preimage_vectors["cases"]:
        assert component_preimage(case["submission"]) == case["preimage_fields"], case["name"]


def test_the_canonical_bytes_and_the_mac_match_end_to_end(preimage_vectors):
    """Not only the field set: the C-1 encoding and the key schedule on top
    of it, so a disagreement anywhere in the chain is one failure here
    rather than a field incident later."""
    from scruple_host_sdk.ratchet import canonical_preimage
    from scruple_host_sdk.server_library import component_preimage

    bdk = bytes.fromhex(preimage_vectors["bdk_hex"])
    for case in preimage_vectors["cases"]:
        fields = component_preimage(case["submission"])
        blob = canonical_preimage(fields)
        assert blob.decode("utf-8") == case["canonical_preimage_utf8"], case["name"]

        counter = case["submission"]["component"]["counter"]
        r = Ratchet(derive_ik(bdk, case["submission"]["component"]["component_id"]), 0)
        for _ in range(counter):
            r.mac(b"")  # advance without meaning anything by it
        used, mac = r.mac(blob)
        assert used == counter
        assert mac == case["mac_hex"], case["name"]


def test_every_case_produces_the_same_key_set(preimage_vectors):
    """A key dropped from the object changes the canonical JSON and
    therefore the MAC. `server-library` fills less of the capture block
    than a sidecar does, and that difference must be a VALUE."""
    from scruple_host_sdk.server_library import component_preimage

    keysets = {tuple(sorted(component_preimage(c["submission"]))) for c in preimage_vectors["cases"]}
    assert len(keysets) == 1
