"""Capture surface + placement — the two axes CANON_SKELETON.md §4 was missing.

§4's host hook contract says WHEN capture fires. It does not say HOW the bytes
are observed (*surface*) or WHERE the observing code runs (*placement*), and
those two are what decide whether P1 and P3 can hold at all.

Full rationale, the six-host mapping and the named abstraction defects:
``docs/canon/PLACEMENT_AND_SURFACES.md``.

This module is the Python mirror of ``lib/capture/surface.ts``. The TypeScript
file is the one the server imports and the one the placement test pins; keep
the two in sync by hand until the leaf-field registry (WO-1) grows a generator
that can emit both.

**Interface shape** follows TestifySec witness's ``Attestor``
(``Name``/``Type``/``RunType``/``Attest``/``Schema``), as already translated in
``docs/canon/oss-study/witness.md`` §6.1. That study's ``CapturePlugin`` is the
*evidence* contract — what is captured, in which phase. ``CaptureSurface`` here
is the *transport* contract — how the bytes are seen at all. A surface hosts
capture plugins; it does not replace them.

**Caveat carried from that study:** witness's attestors are compiled in via Go
``init()`` and are not hot-pluggable. Neither are these. Registration is an
explicit call made at build or startup time by code we publish and measure.
There is no dynamic plugin loading and there will not be one — a capture
surface loaded at runtime from a path the measured party can write to is
``unattested-client`` by definition, whatever its placement claims.

**What a surface may not do** — CANON_SKELETON.md §5's adapter rule binds
surfaces identically. A surface MUST NOT construct an HTTP request, handle
payment, decide MIME, decide applicability, or write its own retry. It also
MUST NOT compute a MAC, advance the ratchet counter, or decide whether a leaf
is verified or passthrough. If a surface needs one of those, the SDK is missing
something and the SDK is where it gets added.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Dict, List, Mapping, Optional, Protocol, Sequence

__all__ = [
    "CaptureHook",
    "SurfaceKind",
    "Placement",
    "PlacementEnforcement",
    "ObservationFidelity",
    "AttestationOutcome",
    "PropertyDisposition",
    "PlacementResolution",
    "Assurance",
    "ObservedBytes",
    "CaptureObservation",
    "ObservationSink",
    "CaptureSurfaceContext",
    "CaptureSurface",
    "HostCaptureProfile",
    "resolve_placement",
    "assurance_for",
    "assurance_for_host",
    "attestation_outcome_of",
    "all_assurance_cells",
    "register_capture_surface",
    "registered_surfaces",
]


# ── Axis 1 — Hook. When capture fires. (CANON_SKELETON.md §4, unchanged.) ────


class CaptureHook(str, Enum):
    ATTACH = "attach"
    DETACH = "detach"
    DOCUMENT_OPEN = "document.open"
    DOCUMENT_CLOSE = "document.close"
    DOCUMENT_SAVE = "document.save"
    ARTIFACT_PRODUCED = "artifact.produced"
    GRAPH_EXECUTE = "graph.execute"
    MODEL_WRITE = "model.write"
    IDLE_TICK = "idle.tick"


# ── Axis 2 — Surface. How the bytes are observed. ───────────────────────────


class SurfaceKind(str, Enum):
    """A mechanism of observation, not a location.

    The same value appears at wildly different assurance levels: Kohya's
    ``safetensors.save_file`` monkey-patch and a Hugging-Face-shaped vendor
    calling this SDK from its own inference handler are BOTH
    ``IN_PROCESS_CALLBACK``. What separates them is placement, never surface.

    SURFACE DOES NOT AFFECT ASSURANCE. It affects COVERAGE. A surface that
    misses an egress path does not produce a weaker leaf — it produces no leaf,
    for events that happened. That is the ComfyUI two-path finding (H-4 §2)
    stated as a general property, and it is why :func:`assurance_for` takes no
    surface argument.
    """

    #: Observed in transit through a proxy the measured party cannot route
    #: around. ComfyUI's POST /prompt, GET /view, WS binary frames.
    NETWORK_GATE = "network-gate"
    #: Observed as a completed file. Hash on IN_CLOSE_WRITE — tamper-EVIDENT,
    #: not tamper-proof (H-4 §6).
    FILESYSTEM_WATCH = "filesystem-watch"
    #: Capture code runs inside the producing process, reached by a hook, a
    #: monkey-patch, or a direct SDK call.
    IN_PROCESS_CALLBACK = "in-process-callback"
    #: The host application hands the event across a published, host-enforced
    #: API boundary — bpy handlers, Fusion add-in events, Adobe UXP.
    HOST_API_CALLBACK = "host-api-callback"


class ObservationFidelity(str, Enum):
    """What the hashed bytes actually are.

    DEFECT-3 in PLACEMENT_AND_SURFACES.md, closed here. The surface axis as
    originally given conflates observing bytes with *causing bytes to exist and
    observing those*.

    Fidelity does NOT enter the assurance function — it says nothing about who
    could tamper with the capture code. It says whether the resulting leaf is
    checkable by a third party holding the artifact, which is precisely the
    adversary the desktop plugins exist for.

    It is a property of the observation rather than a fifth surface value
    because it cross-cuts: a network gate is normally AS_DELIVERED, a
    filesystem watch AS_WRITTEN, and a host API callback can be any of three.
    """

    #: The exact bytes the consumer received. A third party holding the
    #: artifact can re-hash it and match the leaf.
    AS_DELIVERED = "as-delivered"
    #: The exact bytes the host wrote to disk.
    AS_WRITTEN = "as-written"
    #: The surface CAUSED a serialization and hashed that. Fusion's add-in
    #: drives ExportManager into a tempfile, hashes it, and unlinks it. Unless
    #: the host's exporter is byte-deterministic, nobody can re-derive the hash.
    INDUCED = "induced"


# ── Axis 3 — Placement. Where the observing code runs. ──────────────────────


class Placement(str, Enum):
    """NOT topology. The answer to exactly one question:

        Can the party whose behaviour is being measured modify the code that
        measures it, or reach the key that seals the measurement?

    Kohya's in-pod hook is server-side, runs on a machine the tenant does not
    own, and is nonetheless ``UNATTESTED_CLIENT``, because the tenant has root
    in that container. Read these values by that question and only that one.
    """

    #: The vendor's own backend calls the SDK. The measured party has no code
    #: execution in that process at all. P1 free; P3 ordinary secret handling.
    SERVER_LIBRARY = "server-library"
    #: A separate container/namespace the measured party has no exec, debug or
    #: filesystem access to, sitting on their only route to the workload.
    SIDECAR_GATE = "sidecar-gate"
    #: Capture runs inside a host application that enforces code integrity at
    #: load. Must be EARNED (see PlacementEnforcement), never self-declared.
    ATTESTED_CLIENT = "attested-client"
    #: Capture code the measured party can read and edit. Exists so the model
    #: can refuse a shape — a placement that cannot pass is better named than
    #: excluded.
    UNATTESTED_CLIENT = "unattested-client"


class PlacementEnforcement(str, Enum):
    """What actually keeps the measured party out of the capture code."""

    #: The host verifies a signature at load and refuses unsigned code.
    HOST_ENFORCED_SIGNATURE = "host-enforced-signature"
    #: Separate container/namespace; no exec, no debug, no shared filesystem
    #: into the capture process.
    ISOLATED_NAMESPACE = "isolated-namespace"
    #: The measured party cannot execute code in the capture process at all.
    #: A property of a CONFIGURATION, not of a vendor: a vendor offering
    #: bring-your-own-container alongside a managed path has two placements.
    NO_TENANT_CODE = "no-tenant-code"
    #: Nothing enforces it.
    NONE = "none"


_REQUIRED_ENFORCEMENT: Dict[Placement, PlacementEnforcement] = {
    Placement.SERVER_LIBRARY: PlacementEnforcement.NO_TENANT_CODE,
    Placement.SIDECAR_GATE: PlacementEnforcement.ISOLATED_NAMESPACE,
    Placement.ATTESTED_CLIENT: PlacementEnforcement.HOST_ENFORCED_SIGNATURE,
    Placement.UNATTESTED_CLIENT: PlacementEnforcement.NONE,
}


@dataclass(frozen=True)
class PlacementResolution:
    declared: Placement
    enforcement: PlacementEnforcement
    effective: Placement
    honoured: bool
    reason: str


def resolve_placement(
    declared: Placement, enforcement: PlacementEnforcement
) -> PlacementResolution:
    """Reduce a declared placement + enforcement to the effective placement.

    DEFECT-1 in PLACEMENT_AND_SURFACES.md: as three bare axes, a host assigns
    itself its own assurance tier by naming its placement. Splitting the axis
    into *declared* and *effective* closes that while keeping
    :func:`assurance_for` a pure function of ``(placement, attestation)``.

    A declared placement is honoured only when its required enforcement is
    present. Anything else lands on ``UNATTESTED_CLIENT`` — never on an
    intermediate tier, because "some enforcement, but not the one this tier
    needs" is not a partial claim, it is a different claim that was not made.

    Total over all 4 x 4 combinations.
    """
    required = _REQUIRED_ENFORCEMENT[declared]
    if enforcement is required:
        reason = (
            "declared unattested; nothing to enforce"
            if declared is Placement.UNATTESTED_CLIENT
            else f"enforcement {enforcement.value!r} satisfies {declared.value!r}"
        )
        return PlacementResolution(declared, enforcement, declared, True, reason)
    return PlacementResolution(
        declared,
        enforcement,
        Placement.UNATTESTED_CLIENT,
        False,
        f"{declared.value!r} requires enforcement {required.value!r}; got "
        f"{enforcement.value!r}. Degraded to unattested-client — an unenforced "
        f"placement is a declaration, not a boundary.",
    )


# ── The assurance function ──────────────────────────────────────────────────


class AttestationOutcome(str, Enum):
    """H-5's dispatch result, reduced to the three cases assurance cares about.

    Vocabulary is ``packages/scruple-attestation-verifiers/src/verifier.ts``.
    ``VERIFIED`` means chained to the vendor root, nonce matched, inside the
    freshness window — all three. ``PASSTHROUGH`` means stored and anchored
    opaquely; every built-in verifier plugin is in that position today.
    ``NONE`` means the leaf carries no envelope. A hard verification failure
    (``ok: False``) is not an input here: the leaf is rejected before assurance
    is computed.
    """

    VERIFIED = "verified"
    PASSTHROUGH = "passthrough"
    NONE = "none"


def attestation_outcome_of(result: Optional[Mapping[str, Any]]) -> AttestationOutcome:
    """Reduce an H-5 VerifyResult mapping to an AttestationOutcome."""
    if not result or not result.get("ok"):
        return AttestationOutcome.NONE
    if result.get("status") == "verified":
        return AttestationOutcome.VERIFIED
    return AttestationOutcome.PASSTHROUGH


class PropertyDisposition(str, Enum):
    #: True by construction of the placement.
    HOLDS = "holds"
    #: True if and only if the named conditions are evidenced. Compliance is
    #: still binary (Standard §5) — this is a statement about what makes the
    #: claim CHECKABLE, not a third compliance state.
    CONDITIONAL = "conditional"
    #: Cannot be true at this placement, by any amount of evidence.
    FAILS = "fails"


@dataclass(frozen=True)
class Assurance:
    placement: Placement
    attestation: AttestationOutcome
    #: Runtime boundary integrity.
    p1: PropertyDisposition
    #: Signing/API key custody.
    p3: PropertyDisposition
    #: ``"verified"`` | ``"passthrough"`` | ``None``. ``None`` is NOT an
    #: attestation status: it means no leaf may be issued at all.
    leaf: Optional[str]
    #: Can this configuration claim the Standard? False only at
    #: unattested-client, where it is false regardless of attestation.
    can_claim: bool
    conditions: Sequence[str] = field(default_factory=tuple)
    reason: str = ""


_PROBE_CONDITIONS = (
    "H-4 §7 probe 1: the measured party cannot reach the workload bypassing the gate",
    "H-4 §7 probe 2: the measured party cannot reach the component admin/provisioning surface",
    "H-4 §7 probe 4: a file written into the output volume produces a leaf within the drain window",
    "H-4 §7 probe 5: output retrieved over the non-file path produces a leaf",
)

_ATTESTED_CLIENT_CONDITIONS = (
    "the host verifies the plugin signature at load and refuses unsigned code",
    "the running build measurement matches a build we published",
    "the host does not expose a scripting console that can call the plugin with forged arguments",
)


def assurance_for(
    placement: Placement, attestation: AttestationOutcome
) -> Assurance:
    """ASSURANCE IS A PURE FUNCTION OF PLACEMENT AND ATTESTATION, AND NOTHING ELSE.

    Not of surface, not of hook, not of host, not of modality, not of fidelity.
    That is the property that makes the skeleton general: a new host is
    onboarded by naming its hooks, its surfaces and its placement, and never by
    writing new evidence logic.

    Total over all 4 placements x 3 attestation outcomes.
    """
    if placement is Placement.UNATTESTED_CLIENT:
        # Attestation is deliberately IGNORED. A page or a patched hook can
        # relay a genuine root-verified quote obtained from somewhere else;
        # that quote proves something about a machine and nothing about the
        # capture. Letting it lift this tier would make the standard claimable
        # by anyone who can make one HTTP request.
        return Assurance(
            placement=placement,
            attestation=attestation,
            p1=PropertyDisposition.FAILS,
            p3=PropertyDisposition.FAILS,
            leaf=None,
            can_claim=False,
            conditions=(),
            reason=(
                "unattested-client: the measured party can modify the capture code "
                "and reach its key. Cannot claim the standard. Events may be "
                "RECORDED as declared, never as witnessed (D-8). Attestation is "
                "ignored at this placement by design."
            ),
        )

    conditions: List[str] = []
    if placement is Placement.SERVER_LIBRARY:
        p1 = PropertyDisposition.HOLDS
    elif placement is Placement.SIDECAR_GATE:
        p1 = PropertyDisposition.CONDITIONAL
        conditions.extend(_PROBE_CONDITIONS)
    else:  # ATTESTED_CLIENT
        p1 = PropertyDisposition.CONDITIONAL
        conditions.extend(_ATTESTED_CLIENT_CONDITIONS)

    if placement is Placement.SERVER_LIBRARY:
        p3 = PropertyDisposition.HOLDS
    elif attestation is AttestationOutcome.VERIFIED:
        # Sealing the initial key to the build measurement (H-4 §4.4) turns
        # "software-protected, and the tenant is not that user" into "a
        # modified build cannot unseal it".
        p3 = PropertyDisposition.HOLDS
    else:
        p3 = PropertyDisposition.CONDITIONAL
        conditions.append(
            "the sealed key is 0600 and owned by a principal the measured party "
            "is not (H-4 §4.4)"
        )

    leaf = "verified" if attestation is AttestationOutcome.VERIFIED else "passthrough"

    return Assurance(
        placement=placement,
        attestation=attestation,
        p1=p1,
        p3=p3,
        leaf=leaf,
        can_claim=True,
        conditions=tuple(conditions),
        reason=(
            f"{placement.value} + attestation:{attestation.value} → P1 {p1.value}, "
            f"P3 {p3.value}, leaf {leaf}. "
            + (
                "No root-chained attestation, so the leaf is passthrough and the "
                "receipt must read as such."
                if leaf == "passthrough"
                else "Root-chained attestation present; the key is sealed to the "
                "build measurement."
            )
        ),
    )


def all_assurance_cells() -> List[Assurance]:
    """Every (placement, attestation) pair, for exhaustiveness testing."""
    return [
        assurance_for(p, a) for p in Placement for a in AttestationOutcome
    ]


# ── Observations ────────────────────────────────────────────────────────────


@dataclass
class ObservedBytes:
    #: SHA-256, streamed. Hex, no prefix.
    content_hash: str
    #: See ObservationFidelity. Required — there is no safe default.
    fidelity: ObservationFidelity
    #: DECLARED, NEVER GUESSED (CANON_SKELETON.md §5 property 1). Taken from
    #: the producing node's type, the host API, or the gate's declared content
    #: type — never from an extension, never from ``mimetypes.guess_type()``.
    #: A surface that cannot determine a MIME emits the observation without one
    #: and lets ``capture.capture()`` refuse, rather than supplying
    #: ``application/octet-stream`` as five shells did.
    mime: Optional[str] = None
    size_bytes: Optional[int] = None
    #: Required when fidelity is INDUCED: where the hashed serialization can be
    #: obtained again. A surface that induces bytes, hashes them and deletes
    #: them without retaining or addressing them emits a leaf nobody can check.
    induced_artifact_ref: Optional[str] = None


@dataclass
class CaptureObservation:
    hook: CaptureHook
    surface: SurfaceKind
    observed_at: str
    #: Correlates observations belonging to one logical event (ComfyUI
    #: ``prompt_id``).
    correlation_id: Optional[str] = None
    bytes_: Optional[ObservedBytes] = None
    #: Hook-shaped evidence — the workflow graph for ``graph.execute``, the
    #: training config for ``model.write``, document context for
    #: ``document.save``. Opaque here; its schema is the capture plugin's, per
    #: ``oss-study/witness.md`` §6.1.
    evidence: Optional[Dict[str, Any]] = None


class ObservationSink(Protocol):
    """Where observations go. The surface calls this and nothing else.

    Implemented by the SDK, never by a surface. This is the seam that enforces
    CANON_SKELETON.md §5.
    """

    def emit(self, observation: CaptureObservation) -> None: ...


@dataclass
class CaptureSurfaceContext:
    sink: ObservationSink
    #: Effective placement, already resolved. Informational to the surface.
    placement: Placement
    #: Free-form vendor topology config (bind address, watched path, …).
    config: Dict[str, Any] = field(default_factory=dict)


class CaptureSurface(Protocol):
    """Lifecycle: ``open`` → ``observe`` (n times) → ``close``.

    ``open()`` acquires the observation position — bind the gate, start the
    inotify watch, install the host callback. It MUST raise if the position
    cannot be acquired: a surface that silently fails to open is the ComfyUI WS
    gap by another name.

    ``observe()`` drives the surface's own event source and emits to the sink.
    It is on the interface so a host with no event source of its own
    (``idle.tick``) can be pumped.

    ``close()`` releases and flushes anything the sink has not taken. It does
    NOT drain the SDK queue; that is the SDK's.
    """

    def name(self) -> str: ...
    #: Versioned predicate URI, e.g. "scruple.dev/evidence/comfyui-workflow/v1".
    def evidence_type(self) -> str: ...
    def surface(self) -> SurfaceKind: ...
    def fidelity(self) -> ObservationFidelity: ...
    #: Which §4 hooks this surface can serve. Declared, checked at registration.
    def hooks(self) -> Sequence[CaptureHook]: ...
    #: Where this surface's code runs, as DECLARED. Resolved before it is trusted.
    def placement(self) -> Placement: ...
    def enforcement(self) -> PlacementEnforcement: ...
    #: JSON Schema of this surface's own evidence shape (witness Attestor.Schema).
    def schema(self) -> Dict[str, Any]: ...

    def open(self, ctx: CaptureSurfaceContext) -> None: ...
    def observe(self) -> None: ...
    def close(self) -> None: ...


@dataclass(frozen=True)
class HostCaptureProfile:
    """A host's declared capture configuration.

    DEFECT-2, NOT CLOSED: nothing in this type — or in the three axes — can say
    that a set of surfaces COVERS every egress path of a host. ComfyUI needs
    two surfaces and a profile naming one is expressible and wrong.
    Completeness is established outside the model, by H-4 §7 probes 4 and 5 and
    by ratchet gap accounting (H-4 §4.2).
    """

    host: str
    hooks: Sequence[CaptureHook]
    surfaces: Sequence[SurfaceKind]
    fidelity: ObservationFidelity
    declared_placement: Placement
    enforcement: PlacementEnforcement
    attestation: AttestationOutcome


def assurance_for_host(profile: HostCaptureProfile):
    """Resolve a host profile all the way to (resolution, assurance)."""
    resolution = resolve_placement(profile.declared_placement, profile.enforcement)
    return resolution, assurance_for(resolution.effective, profile.attestation)


# ── Registration. Explicit, static, build-time. See the module caveat. ──────

_SURFACE_REGISTRY: Dict[str, CaptureSurface] = {}


def register_capture_surface(surface: CaptureSurface) -> None:
    name = surface.name()
    if name in _SURFACE_REGISTRY:
        raise ValueError(f"capture surface {name!r} already registered")
    if not surface.hooks():
        raise ValueError(f"capture surface {name!r} declares no hooks")
    _SURFACE_REGISTRY[name] = surface


def registered_surfaces() -> List[str]:
    return sorted(_SURFACE_REGISTRY)


def _reset_surface_registry_for_tests() -> None:
    _SURFACE_REGISTRY.clear()
