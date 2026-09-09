"""WO-D6 — the host hook, host-agnostic. The Python mirror's own tests.

``lib/capture/hostRegistry.ts`` is the canonical implementation and
``test/v2/host-hook.test.ts`` is the suite that pins it. This file holds the
mirror to the same shape, because a mirror that drifts is worse than no mirror:
a vendor writing a Python adapter against it would produce leaves the
TypeScript component refuses, and the refusal would arrive as a 422 in
somebody's production estate rather than here.
"""

from __future__ import annotations

import pytest

from scruple_api.host_registry import (
    HostRegistration,
    HostRegistrationError,
    HostSemantics,
    _reset_host_registry_for_tests,
    hash_host_evidence,
    host_adapter_sink,
    host_capture_level,
    register_host,
    registered_hosts,
)
from scruple_api.surface import (
    CaptureHook,
    CaptureObservation,
    ObservationFidelity,
    ObservedBytes,
    Placement,
    PlacementEnforcement,
    SurfaceKind,
)


def phantom(**over) -> HostRegistration:
    """A host we have not met, which is the phrase surface.py uses for what the
    ObservationSink contract exists for. Deliberately not Blender: a test that
    could only be satisfied by the host we happen to have would be testing the
    special case rather than the hook."""
    base = dict(
        host="phantom-cam",
        host_version="4.2.1",
        adapter="viewport",
        adapter_version="1.0.0",
        evidence_type="scruple.dev/evidence/phantom-cam-viewport/v1",
        hooks=[CaptureHook.ARTIFACT_PRODUCED, CaptureHook.GRAPH_EXECUTE],
        surfaces=[SurfaceKind.HOST_API_CALLBACK],
        fidelity=ObservationFidelity.AS_WRITTEN,
        declared_placement=Placement.ATTESTED_CLIENT,
        enforcement=PlacementEnforcement.NONE,
        schema={
            "type": "object",
            "required": ["scene", "frame", "camera"],
            "properties": {
                "scene": {"type": "string"},
                "frame": {"type": "integer"},
                "camera": {"type": "string"},
            },
        },
    )
    base.update(over)
    return HostRegistration(**base)


def observation(**over) -> CaptureObservation:
    o = CaptureObservation(
        hook=CaptureHook.ARTIFACT_PRODUCED,
        surface=SurfaceKind.NETWORK_GATE,
        observed_at="2026-09-09T00:00:00.000Z",
        correlation_id="prompt-1",
        bytes_=ObservedBytes(
            content_hash="c" * 64, fidelity=ObservationFidelity.AS_DELIVERED, mime="image/png"
        ),
        evidence={"egress": "/view"},
    )
    for k, v in over.items():
        setattr(o, k, v)
    return o


class Collector:
    """Where observations go. Nothing here reaches a wire."""

    def __init__(self) -> None:
        self.seen = []

    def emit(self, observation: CaptureObservation) -> None:
        self.seen.append(observation)


class Adapter:
    def __init__(self, answer, registration=None) -> None:
        self.registration = registration or phantom()
        self._answer = answer

    def semantics_for(self, observation):
        return self._answer(observation)


@pytest.fixture(autouse=True)
def _clean_registry():
    _reset_host_registry_for_tests()
    yield
    _reset_host_registry_for_tests()


def test_a_well_formed_host_registers_and_its_assurance_is_derived():
    entry = register_host(phantom())
    assert registered_hosts() == ["phantom-cam"]
    # It DECLARED attested-client and nothing enforces that, so the resolved
    # placement degrades. The grade follows the resolution, never the
    # declaration — which is why a host may not hand in its own attestation.
    assert entry.resolution.declared is Placement.ATTESTED_CLIENT
    assert entry.resolution.effective is Placement.UNATTESTED_CLIENT


def test_a_host_may_not_grade_itself():
    """A host declares WHAT IT IS. It does not declare HOW GOOD IT IS."""
    with pytest.raises(TypeError):
        # The dataclass has no `attestation` field at all, which is the
        # strongest form of this refusal available in Python: the TypeScript
        # mirror has to check for the key because a JSON object can carry
        # anything, and here it cannot be constructed.
        phantom(attestation="verified")


def test_an_unversioned_evidence_type_is_refused():
    for bad in ("phantom-cam-viewport", "scruple.dev/evidence/viewport", "HTTP://x/evidence/y/v1"):
        with pytest.raises(HostRegistrationError) as e:
            register_host(phantom(evidence_type=bad))
        assert e.value.code == "evidence_type_unversioned", bad


def test_a_schema_that_requires_nothing_is_refused():
    """An adapter that can never decline is an adapter whose SUPPLIED says
    nothing."""
    with pytest.raises(HostRegistrationError) as e:
        register_host(phantom(schema={"type": "object", "required": []}))
    assert e.value.code == "schema_requires_nothing"


def test_no_hooks_no_surfaces_and_a_duplicate_are_each_refused():
    with pytest.raises(HostRegistrationError) as e:
        register_host(phantom(hooks=[]))
    assert e.value.code == "hooks_empty"
    with pytest.raises(HostRegistrationError) as e:
        register_host(phantom(surfaces=[]))
    assert e.value.code == "surfaces_empty"
    register_host(phantom())
    with pytest.raises(HostRegistrationError) as e:
        register_host(phantom())
    assert e.value.code == "host_already_registered"


def test_the_level_is_derived_from_the_semantics_never_asserted():
    assert host_capture_level(HostSemantics.BLIND) == 1
    assert host_capture_level(HostSemantics.DECLINED) == 2
    assert host_capture_level(HostSemantics.SUPPLIED) == 2


def test_the_hosts_semantics_reach_the_observation():
    inner = Collector()
    sink = host_adapter_sink(
        Adapter(lambda o: {"scene": "atrium", "frame": 240, "camera": "CAM_hero"}), inner
    )
    sink.emit(observation())
    assert len(inner.seen) == 1, "a sink may never swallow an observation"
    ev = inner.seen[0].evidence
    assert ev["host_semantics"] == "supplied"
    assert ev["host"] == "phantom-cam"
    assert ev["host_adapter"] == "viewport@1.0.0"
    assert ev["host_evidence"] == {"scene": "atrium", "frame": 240, "camera": "CAM_hero"}
    assert ev["egress"] == "/view", "an adapter adds meaning; it does not restate an observation"


def test_an_adapter_with_nothing_to_say_declines_and_that_is_not_blind():
    inner = Collector()
    sink = host_adapter_sink(Adapter(lambda o: None), inner)
    sink.emit(observation())
    ev = inner.seen[0].evidence
    assert ev["host_semantics"] == "declined"
    # It still NAMES the integration: those are facts about the deployment,
    # true whether or not this observation was announced. That is what keeps
    # "not working" distinguishable from "never done".
    assert ev["host"] == "phantom-cam"
    assert "host_evidence" not in ev
    assert "host_evidence_hash" not in ev


def test_a_partial_announcement_is_declined_not_supplied_with_holes():
    inner = Collector()
    sink = host_adapter_sink(Adapter(lambda o: {"scene": "atrium", "frame": 240}), inner)
    sink.emit(observation())
    assert inner.seen[0].evidence["host_semantics"] == "declined"
    assert sink.enrichments[0].reason == "schema:missing camera"


def test_an_adapter_that_raises_costs_the_leaf_its_semantics_not_the_artifact_its_leaf():
    def boom(_o):
        raise RuntimeError("the add-on crashed mid-render")

    inner = Collector()
    sink = host_adapter_sink(Adapter(boom), inner)
    sink.emit(observation())
    assert len(inner.seen) == 1
    assert inner.seen[0].evidence["host_semantics"] == "declined"
    assert sink.enrichments[0].reason.startswith("threw: ")


def test_a_second_adapter_may_not_overwrite_the_first():
    """Two parties disagreeing about what an artifact meant is a finding.
    Silently preferring ours would erase it."""
    inner = Collector()
    sink = host_adapter_sink(Adapter(lambda o: {"scene": "OTHER", "frame": 9, "camera": "b"}), inner)
    sink.emit(
        observation(
            evidence={
                "host": "other-host",
                "host_semantics": "supplied",
                "host_evidence": {"scene": "FIRST"},
            }
        )
    )
    assert inner.seen[0].evidence["host"] == "other-host"
    assert sink.enrichments[0].reason == "already-present"


def test_hash_host_evidence_returns_none_for_an_empty_manifest():
    """NOT the digest of {}, which would assert we asked the host and it
    genuinely had nothing — that is what DECLINED says and this must not."""
    assert hash_host_evidence({}) is None
    assert hash_host_evidence(None) is None


def test_the_digest_agrees_with_the_typescript_implementation():
    """A PINNED CROSS-LANGUAGE VECTOR.

    The value is what ``lib/capture/hostRegistry.ts``'s ``hashHostEvidence``
    returns for the same document. Both sides are ``sha256(RFC 8785)`` over the
    whole manifest — unlike ``model_fingerprints_hash``, whose top-level-only
    sort is committed to in leaves that already exist — so the two agree by
    construction and this pin is what will say so if either stops.

    Reproduce with:
      node --import tsx -e "import('./lib/capture/hostRegistry.ts')
        .then(m => console.log(m.hashHostEvidence(
          {scene:'atrium', frame:240, camera:'CAM_hero'}).hash))"
    """
    got = hash_host_evidence({"scene": "atrium", "frame": 240, "camera": "CAM_hero"})
    assert got["json"] == '{"camera":"CAM_hero","frame":240,"scene":"atrium"}'
    assert got["hash"] == "c11b9a416c53f3b6788e620482c202e0d58c17859b2a9922d871db19670fafb7"
