"""The host hook, host-agnostic — how a host declares itself, and what it may
then say about bytes the gate can see but cannot read.

WO-D6. This module is the Python mirror of ``lib/capture/hostRegistry.ts``.
The TypeScript file is the one the component imports and the one the tests
pin; keep the two in sync by hand, exactly as ``surface.py`` and
``surface.ts`` are kept.

There are exactly two levels and nothing in between:

**Level 1** — the host points its ComfyUI address at the gate. That is the
whole integration. It costs the host nothing, requires no code from us, and
captures the workflow, the uploads and the outputs, because every ComfyUI
bridge ever written speaks plain HTTP ``/prompt`` plus a websocket. What it
produces is an honest record that is SEMANTICALLY BLIND: an anonymous PNG was
uploaded, an anonymous PNG came back. A wire does not carry the fact that
those pixels were the viewport of scene X at frame Y through camera Z.

**Level 2** — the host registers an adapter. The adapter supplies the meaning,
and only the meaning.

⚑ THE LEVEL IS ON THE LEAF, AND LEVEL 1 SAYS SO. ``capture.host_semantics``
is three-valued and never null on a component leaf, and the leaf builder
DEFAULTS it to ``blind`` — so a deployment with no adapter does not emit a
leaf that is quietly thinner than a Level-2 one, it emits a leaf that declares
it had nobody to ask.

WHY THIS IS NOT A NEW CONTRACT
------------------------------
``surface.py`` already calls :class:`~scruple_api.surface.ObservationSink`
"the interface a vendor implements for a host we have not met". A host adapter
is that interface COMPOSED, never a second one: :func:`host_adapter_sink`
returns an ``ObservationSink`` wrapping an ``ObservationSink``.

The consequence worth stating plainly: THE HOST DOES NOT WRITE THE SINK. It
writes :meth:`HostAdapter.semantics_for`, a pure function from an observation
to a mapping, and the SDK writes everything around it. That is
CANON_SKELETON.md §5's adapter rule made structural rather than promised. A
host that wrote its own sink could construct an HTTP request, decide a MIME,
drop an observation or spend a ratchet counter; a host that writes
``semantics_for`` cannot reach any of those, because it is never handed the
inner sink at all.

WHAT A REGISTRATION MAY NOT SAY
-------------------------------
A host declares WHAT IT IS. It does not declare HOW GOOD IT IS. ``attestation``
is refused as a registration key: :func:`~scruple_api.surface.assurance_for_host`
derives the grade from the RESOLVED placement, and a host handing in its own
``attestation="verified"`` would be grading its own exam.

REGISTRATION IS STATIC — ``surface.py``'s caveat binds identically. An adapter
loaded at runtime from a path the measured party can write to is
``unattested-client`` by definition, whatever it declares.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, List, Mapping, Optional, Protocol, Sequence

from .canonical import canonicalize
from .surface import (
    CaptureHook,
    CaptureObservation,
    ObservationFidelity,
    ObservationSink,
    Placement,
    PlacementEnforcement,
    SurfaceKind,
    AttestationOutcome,
    HostCaptureProfile,
    assurance_for_host,
)

__all__ = [
    "HostSemantics",
    "host_capture_level",
    "HostRegistration",
    "HostRegistrationError",
    "RegisteredHost",
    "HostAdapter",
    "HostEnrichmentRecord",
    "hash_host_evidence",
    "host_profile_of",
    "register_host",
    "registered_hosts",
    "lookup_host",
    "host_adapter_sink",
]


class HostSemantics(str, Enum):
    """What a leaf says about who supplied its meaning.

    Three values, and the middle one is what a two-valued design would lose.

    🔴 ``DECLINED`` IS NOT A DEGRADED ``BLIND``. Collapsing them would make
    "we had nobody to ask" and "we asked and got nothing" the same reading,
    and those have different fixes: the first is an integration that was never
    done, the second is an integration that is not working. Exactly the
    distinction ``upstream_uncaptured_reason``'s ``not_queried`` holds open
    one field over.
    """

    #: No adapter was registered for this component. LEVEL 1.
    BLIND = "blind"
    #: An adapter WAS registered and had nothing to say about THIS
    #: observation. LEVEL 2, and the leaf is as thin as a Level-1 one.
    DECLINED = "declined"
    #: The adapter supplied semantics and they are on the leaf. LEVEL 2.
    SUPPLIED = "supplied"


def host_capture_level(state: HostSemantics) -> int:
    """DERIVED, never a field a host sets. Level 2 is "an adapter was in the
    path", which is true whether or not it had anything to say."""
    return 1 if HostSemantics(state) is HostSemantics.BLIND else 2


_HOST_ID = re.compile(r"^[a-z0-9][a-z0-9._-]{1,63}$")
#: ``<authority>/evidence/<name>/v<N>`` — the shape surface.py's own surfaces
#: already use ("scruple.dev/evidence/comfyui-workflow/v1").
_EVIDENCE_TYPE = re.compile(r"^[a-z0-9][a-z0-9.-]*/evidence/[a-z0-9][a-z0-9-]*/v[0-9]+$")


@dataclass(frozen=True)
class HostRegistration:
    """How a host declares itself.

    Everything here is a STATEMENT OF FACT about the integration; nothing here
    is a claim about its strength. Deliberately a superset of
    :class:`~scruple_api.surface.HostCaptureProfile`'s shape rather than a
    subclass of it — :func:`host_profile_of` projects one into the other, and
    the projection is where ``attestation`` is filled in by us instead of by
    them.
    """

    #: Stable host id. It lands in ``capture.host`` and in a MAC preimage, so
    #: it may not be a display name that changes when marketing does.
    host: str
    #: Which build of the host declared itself. A leaf whose semantics came
    #: from an add-on that cannot be identified cannot be re-examined when
    #: that add-on turns out to have been reporting the wrong camera.
    host_version: str
    #: Stable adapter id. SEPARATE FROM THE HOST because one host has several:
    #: a viewport adapter and a render-queue adapter observe the same Blender
    #: and mean different things.
    adapter: str
    adapter_version: str
    #: Versioned predicate URI. It is on the leaf so a verifier knows which
    #: document ``host_evidence`` is before reading a byte of it.
    evidence_type: str
    #: Which §4 hooks this adapter serves. Declared, checked at registration.
    hooks: Sequence[CaptureHook]
    #: Which surfaces the host's capture reaches it through.
    surfaces: Sequence[SurfaceKind]
    fidelity: ObservationFidelity
    #: Where the adapter's code runs, as DECLARED. Resolved before it is
    #: trusted — the gap between declared and enforced is the finding.
    declared_placement: Placement
    enforcement: PlacementEnforcement
    #: JSON Schema of the host's own evidence shape. Must be an object schema
    #: with a non-empty ``required``: a schema that validates everything makes
    #: ``DECLINED`` unreachable, and an adapter that can never decline is an
    #: adapter whose ``SUPPLIED`` says nothing.
    schema: Mapping[str, Any] = field(default_factory=dict)
    capability_classes: Optional[Sequence[str]] = None
    custody_locus: Optional[str] = None


class HostRegistrationError(ValueError):
    """Raised by :func:`register_host`. ``code`` mirrors the TypeScript
    ``HostRegistrationCode`` value for the same refusal."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class RegisteredHost:
    registration: HostRegistration
    profile: HostCaptureProfile
    resolution: Any
    assurance: Any


def host_profile_of(r: HostRegistration) -> HostCaptureProfile:
    """Project a registration into the profile the assurance function grades.

    ``attestation`` IS SET HERE, to ``NONE``, and never read off the
    registration. A host that ships attestable compute gets that recognised
    through ``enforcement``, which is checked — not through a self-report.
    """
    return HostCaptureProfile(
        host=r.host,
        hooks=tuple(r.hooks),
        surfaces=tuple(r.surfaces),
        fidelity=r.fidelity,
        declared_placement=r.declared_placement,
        enforcement=r.enforcement,
        attestation=AttestationOutcome.NONE,
    )


_HOST_REGISTRY: Dict[str, RegisteredHost] = {}


def register_host(r: HostRegistration) -> RegisteredHost:
    """Register a host. Explicit, static, build-time — see the module header.

    Every refusal below is a way a registration could be accepted and then
    mean nothing on a leaf. None of them is a schema formality.
    """
    if not isinstance(r.host, str) or not _HOST_ID.match(r.host):
        raise HostRegistrationError(
            "host_id_malformed",
            f"host id {r.host!r} is not a stable lowercase identifier. It lands in "
            "`capture.host` and in a MAC preimage.",
        )
    if r.host in _HOST_REGISTRY:
        raise HostRegistrationError(
            "host_already_registered",
            f"host {r.host!r} is already registered. Two adapters for one host is a "
            "legitimate configuration — register them under distinct host ids, or one "
            "leaf cannot say which of the two named it.",
        )
    if not isinstance(r.host_version, str) or not r.host_version.strip():
        raise HostRegistrationError(
            "host_version_missing",
            f"host {r.host!r} declared no version.",
        )
    if (
        not isinstance(r.adapter, str)
        or not _HOST_ID.match(r.adapter)
        or not isinstance(r.adapter_version, str)
        or not r.adapter_version.strip()
    ):
        raise HostRegistrationError(
            "adapter_malformed",
            f"host {r.host!r} must declare a stable lowercase `adapter` id and a "
            "non-empty `adapter_version`.",
        )
    if not isinstance(r.evidence_type, str) or not _EVIDENCE_TYPE.match(r.evidence_type):
        raise HostRegistrationError(
            "evidence_type_unversioned",
            f"`evidence_type` {r.evidence_type!r} is not a versioned predicate URI of the "
            "form `<authority>/evidence/<name>/v<N>`. An evidence shape that changes "
            "without changing its name is unreadable in hindsight.",
        )
    if not r.hooks:
        raise HostRegistrationError(
            "hooks_empty",
            f"host {r.host!r} declares no hooks. surface.py refuses a capture surface on "
            "the same ground: an adapter that serves no hook can never be reached.",
        )
    for h in r.hooks:
        CaptureHook(h)  # raises ValueError on an unknown hook
    if not r.surfaces:
        raise HostRegistrationError(
            "surfaces_empty",
            f"host {r.host!r} declares no surfaces. DEFECT-2 is that a surface list cannot "
            "PROVE coverage; an empty one does not even claim it.",
        )
    for s in r.surfaces:
        SurfaceKind(s)
    ObservationFidelity(r.fidelity)
    Placement(r.declared_placement)
    PlacementEnforcement(r.enforcement)
    schema = r.schema or {}
    if not isinstance(schema, Mapping) or schema.get("type") != "object":
        raise HostRegistrationError(
            "schema_not_an_object_schema",
            f"host {r.host!r} must declare `schema` as a JSON Schema with type 'object'.",
        )
    required = schema.get("required")
    if not isinstance(required, (list, tuple)) or len(required) == 0:
        raise HostRegistrationError(
            "schema_requires_nothing",
            f"host {r.host!r} declared a schema that requires nothing. A schema that "
            "validates everything makes DECLINED unreachable, and an adapter that can "
            "never decline is an adapter whose SUPPLIED says nothing.",
        )

    profile = host_profile_of(r)
    resolution, assurance = assurance_for_host(profile)
    entry = RegisteredHost(
        registration=r, profile=profile, resolution=resolution, assurance=assurance
    )
    _HOST_REGISTRY[r.host] = entry
    return entry


def registered_hosts() -> List[str]:
    return sorted(_HOST_REGISTRY)


def lookup_host(host: str) -> Optional[RegisteredHost]:
    return _HOST_REGISTRY.get(host)


def _reset_host_registry_for_tests() -> None:
    _HOST_REGISTRY.clear()


class HostAdapter(Protocol):
    """What a host implements. THE WHOLE INTERFACE.

    ``semantics_for`` receives the observation the gate made and returns the
    meaning the gate could not see, or ``None`` to decline. It may read
    whatever the host's own transport gives it — a file the add-on dropped, an
    RPC back into the host, a table it filled when the render started. The SDK
    takes no view on that; transport is the adapter's business and the
    contract is the return value.

    IT MAY NOT: mutate the observation, call the inner sink, construct an HTTP
    request, decide a MIME, compute a MAC, spend a counter, or take a view on
    whether the leaf is verified or passthrough. It CANNOT do the second — it
    is never handed the inner sink.

    IT MAY RAISE. :func:`host_adapter_sink` catches, records ``DECLINED``, and
    delivers the observation anyway: a host adapter bug must cost the leaf its
    semantics and must never cost the artifact its leaf.
    """

    registration: HostRegistration

    def semantics_for(self, observation: CaptureObservation) -> Optional[Mapping[str, Any]]: ...


@dataclass
class HostEnrichmentRecord:
    """Why an observation was declined, kept for the operator. NEVER SENT — an
    explanation on the wire is a field to be forged."""

    observed_at: str
    correlation_id: Optional[str]
    content_hash: Optional[str]
    state: HostSemantics
    reason: str
    host_evidence_hash: Optional[str]


def hash_host_evidence(evidence: Optional[Mapping[str, Any]]) -> Optional[Dict[str, str]]:
    """``host_evidence_hash`` — binds the manifest the leaf carries.

    RFC 8785 over the whole document, unlike ``model_fingerprints_hash``,
    whose top-level-only sort is committed to in leaves that already exist and
    cannot be changed without invalidating them. This field is new, so it gets
    the canonicalization the others would have if they were written today —
    which is also what lets a Python adapter and a TypeScript one agree on the
    bytes.

    Returns ``None`` for an absent or empty manifest, so callers store NULL
    rather than the hash of ``{}``: that digest would assert we asked the host
    and it genuinely had nothing, which is what ``DECLINED`` says and this
    must not.
    """
    if not evidence:
        return None
    text = canonicalize(dict(evidence))
    return {
        "json": text,
        "hash": hashlib.sha256(text.encode("utf-8")).hexdigest(),
    }


class _HostAdapterSink:
    """The composition. A module-level class rather than a closure so that the
    enrichment log is an attribute an operator can read after the run."""

    def __init__(self, adapter: HostAdapter, inner: ObservationSink, log: Any = None) -> None:
        self._adapter = adapter
        self._reg = adapter.registration
        self._inner = inner
        self._log = log or (lambda line: None)
        self.enrichments: List[HostEnrichmentRecord] = []

    def _decline(
        self, observation: CaptureObservation, ev: Dict[str, Any],
        rec: HostEnrichmentRecord, reason: str,
    ) -> None:
        """DECLINE, AND SAY SO ON THE LEAF.

        ⚑ THIS IS THE HALF THAT IS EASY TO GET WRONG. Delegating the
        observation unchanged would leave the host fields absent, the leaf
        builder would default ``host_semantics`` to ``blind``, and a Level-2
        deployment whose adapter had nothing to say would be indistinguishable
        on the evidence from a Level-1 one that had nobody to ask. That
        collapse is the whole reason DECLINED exists.

        So a decline still NAMES the host, the adapter and the evidence type —
        facts about the integration, true whether or not this observation was
        announced — and carries no manifest and no hash, which is what DECLINED
        means.
        """
        rec.state = HostSemantics.DECLINED
        rec.reason = reason
        self.enrichments.append(rec)
        observation.evidence = {
            **ev,
            "host": self._reg.host,
            "host_adapter": f"{self._reg.adapter}@{self._reg.adapter_version}",
            "host_evidence_type": self._reg.evidence_type,
            "host_semantics": HostSemantics.DECLINED.value,
        }
        self._inner.emit(observation)

    def emit(self, observation: CaptureObservation) -> None:
        reg = self._reg
        ev = dict(observation.evidence or {})
        rec = HostEnrichmentRecord(
            observed_at=observation.observed_at,
            correlation_id=observation.correlation_id,
            content_hash=getattr(observation.bytes_, "content_hash", None),
            state=HostSemantics.DECLINED,
            reason="no-announcement",
            host_evidence_hash=None,
        )

        # MAY NOT OVERWRITE. Two parties disagreeing about what an artifact
        # meant is a finding; silently preferring ours would erase it.
        if "host_semantics" in ev or "host_evidence" in ev:
            rec.reason = "already-present"
            self.enrichments.append(rec)
            self._inner.emit(observation)
            return

        # NOT A HOOK THIS ADAPTER DECLARED. Registration said which §4 hooks it
        # serves; an adapter answering for one it never claimed is a coverage
        # claim nobody checked.
        if CaptureHook(observation.hook) not in [CaptureHook(h) for h in reg.hooks]:
            self._decline(observation, ev, rec, f"hook-not-declared: {observation.hook}")
            return

        try:
            evidence = self._adapter.semantics_for(observation)
        except Exception as exc:  # noqa: BLE001 — a host bug is not our outage
            self._log(f"adapter threw: {exc}")
            # "threw", not "raised": the reason strings are part of what an
            # operator reads in both languages and a mirror that renames them
            # makes one runbook wrong.
            self._decline(observation, ev, rec, f"threw: {exc}")
            return

        if not evidence:
            self._decline(observation, ev, rec, "no-announcement")
            return

        # AGAINST THE ADAPTER'S OWN DECLARED SCHEMA. A partial announcement is
        # DECLINED rather than supplied-with-holes: the leaf either carries the
        # document the evidence type promises or it says it has none.
        missing = [k for k in reg.schema.get("required", ()) if k not in evidence]
        if missing:
            self._decline(observation, ev, rec, "schema:missing " + ",".join(missing))
            return

        hashed = hash_host_evidence(evidence)
        if hashed is None:
            self._decline(observation, ev, rec, "empty-announcement")
            return

        rec.state = HostSemantics.SUPPLIED
        rec.reason = "supplied"
        rec.host_evidence_hash = hashed["hash"]
        self.enrichments.append(rec)
        observation.evidence = {
            **ev,
            "host": reg.host,
            "host_adapter": f"{reg.adapter}@{reg.adapter_version}",
            "host_evidence_type": reg.evidence_type,
            "host_semantics": HostSemantics.SUPPLIED.value,
            "host_evidence": dict(evidence),
            "host_evidence_hash": hashed["hash"],
        }
        self._inner.emit(observation)


def host_adapter_sink(
    adapter: HostAdapter,
    inner: ObservationSink,
    log: Any = None,
) -> ObservationSink:
    """THE COMPOSITION, AND THE SDK OWNS IT.

    Returns an ``ObservationSink`` for the component's adapter seam. The host
    never sees ``inner``, so it cannot swallow an observation — a gate surface
    awaits ``sink.emit`` before forwarding a byte and fails closed if it
    raises, so a wrapper that dropped one would silently un-witness an
    artifact. Every path in :class:`_HostAdapterSink` ends in a delegation.
    """
    return _HostAdapterSink(adapter, inner, log)  # type: ignore[return-value]
