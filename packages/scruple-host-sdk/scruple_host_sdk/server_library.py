"""The ``server-library`` placement — the SDK path a vendor calls from their
own backend.

WO-6 of ``docs/canon/WO-SERIES-CANON-AS-FLOOR.md``. This is where Hugging
Face and RunPod-serverless actually live: the vendor's inference handler
calls this from a process the *measured party* — the tenant — has no code
execution in at all.

WHY THIS FILE IS NAMED AFTER A PLACEMENT AND NOT AFTER A VENDOR
---------------------------------------------------------------
``PLACEMENT_AND_SURFACES.md`` §4 is emphatic that placement is not topology
and not a vendor: a vendor offering bring-your-own-container alongside a
managed path has TWO configurations, two placements and two tiers, and §7.3
records that as "the single most commercially important line in the
document". A module named ``huggingface.py`` would have encoded the wrong
noun. ``server_library.py`` is the value ``Placement.SERVER_LIBRARY`` spells,
character for character, which is the rule the rest of the canon runs on:
one vocabulary, imported, never restated.

WHAT IS FREE HERE AND WHAT IS NOT — read this before selling it
--------------------------------------------------------------
P1 is free: the tenant cannot modify the code that measures them, because
they cannot execute code in this process. P3 is ordinary secret management.
That is two of the eight for nothing, and it is why this placement is the
shortest path to a vendor running real traffic.

**It buys nothing toward a `verified` leaf.** ``PLACEMENT_AND_SURFACES.md``
§5.2's top-right cell: ``server-library`` + attestation ``none`` still yields
``passthrough``. Nothing lifts a leaf to ``verified`` except an attestation
chained to a vendor root, and no verifier plugin in the estate can produce
one today. :meth:`ServerLibraryIntegration.assurance` reports the tier every
time and the reference integration prints it, because the alternative is a
vendor discovering the gap at the moment they quote a customer.

THE POSTURE IS COMPUTED, NEVER DECLARED
---------------------------------------
Nothing in this file hand-rolls a tier. ``placement.effective``, P1, P3,
``leaf_status``, ``can_claim`` and the conditions all come from
:func:`resolve_placement` and :func:`assurance_for` in
``scruple_api.surface`` — the same two functions the server calls and the
same two the predicate validator recomputes with. DEFECT-1 in the axes doc
is the record of what happens when a host can grade itself, and a vendor
that declares ``server-library`` while running a custom-handler feature
resolves to ``unattested-client`` here exactly as it does there. When it
does, :meth:`witness_file` REFUSES rather than emitting a leaf nobody may
claim.

ORDERING, WHICH IS THE THING THAT IS EASY TO GET WRONG SILENTLY
---------------------------------------------------------------
H-4 §5: **derive, MAC, ratchet, then enqueue.** The counter is consumed when
the MAC is computed, not when the submission succeeds. :meth:`_seal` runs
between the MAC and the network call so a process death mid-flight cannot
resurrect a spent counter, and the submission itself goes through
``http.submit`` with ``queue_kind="witness"`` — which is what puts the queue
in the failure path *by construction* (``CANON_SKELETON.md`` §5 property 3)
rather than by this module remembering to call it. There is no ``try/except``
around the network here, and that absence is the design: adding one would be
writing the retry that the adapter rule forbids.

TWO SEALS, TWO SCOPES — stated because a reader will otherwise assume one
-------------------------------------------------------------------------
* The **ratchet MAC** covers H-4 §4.3's canonical preimage: which component,
  which counter, which build, and the leaf's hashes. It is what the server
  verifies, and it is what makes a suppressed event visible as a gap.
* The **DSSE signature** covers the whole statement — the leaf verbatim plus
  the ``scruple-vendor-baseline`` predicate. It is what a third party checks.

The MAC does not cover the predicate. That is a deliberate boundary and not
an oversight: the predicate is the *vendor's* declaration about their own
configuration, signed with the vendor's own key, and at ``server-library``
the vendor is not the adversary — the tenant is, and the tenant is outside
this process. A component that could mint postures would be a different
threat model, and it is the sidecar's (H-4 §1), not this one's.
"""

from __future__ import annotations

import os
from datetime import datetime, timezone
from dataclasses import dataclass
from typing import Any, Dict, List, Mapping, Optional, Sequence

from scruple_api.capture import capture as _capture_file
from scruple_api.surface import (
    Assurance,
    AttestationOutcome,
    CaptureHook,
    ObservationFidelity,
    Placement,
    PlacementEnforcement,
    PlacementResolution,
    SurfaceKind,
    assurance_for,
    resolve_placement,
)

from . import http as _http
from .envelope import (
    ComponentIdentity,
    DeclaredSurface,
    EnvelopeSigner,
    attest_leaf,
    build_vendor_baseline_predicate,
)
from .errors import NoBaselineError, ScrupleAPIError
from .ratchet import Ratchet

__all__ = [
    "SERVER_LIBRARY_SURFACE",
    "component_preimage",
    "PlacementRefused",
    "ServerLibraryOutcome",
    "ServerLibraryIntegration",
    "provision_component",
]


# ── the MAC preimage — ONE definition, called by every party ────────────────


def component_preimage(submission: Mapping[str, Any]) -> Dict[str, Any]:
    """The field set a capture component's ratchet MACs.

    §10 C-1 fixed the ENCODING of ``canonical_preimage`` (UTF-8 JSON, keys
    sorted by Unicode code point, compact separators, floats refused) and
    left the FIELD SET open — which is exactly how two conforming
    implementations end up disagreeing. A component that MACs fields the
    server cannot reconstruct from the submission has a MAC that
    authenticates the component and says nothing about the event.

    So this takes the submission itself and every party calls it: the
    component before sending, and the server on receipt, over the same JSON.
    The TypeScript counterparts are ``lib/leaf/componentPreimage.ts`` (the
    route) and ``services/scruple-capture/src/leaf.ts`` (the sidecar), and
    the three are held together by
    ``test/vectors/component-preimage-vectors.json`` — the same defence
    ``ratchet-vectors.json`` gives the key schedule, for the field set
    rather than the arithmetic.

    ABSENT IS NULL, NEVER OMITTED. A key dropped from the object changes
    the canonical JSON and therefore the MAC, so a submission with no
    ``capture`` block must produce the same preimage SHAPE as one whose
    capture fields are empty. ``server-library`` legitimately fills less of
    that block than a sidecar does, and the difference has to be a value.
    """
    c = submission.get("capture") or {}
    comp = submission["component"]
    att = comp.get("attestation") or {}
    return {
        "component_id": comp["component_id"],
        "counter": comp["counter"],
        "build_measurement": comp.get("build_measurement"),
        "attestation_provider": att.get("provider"),
        "baseline_ref": submission.get("baseline_ref"),
        "kind": submission.get("kind"),
        "content_hash": submission["content_hash"],
        "mime": submission.get("mime"),
        "input_hash": submission.get("input_hash"),
        "model_fingerprints_hash": submission.get("model_fingerprints_hash"),
        "machine_manifest_hash": submission.get("machine_manifest_hash"),
        "surface": c.get("surface"),
        "hook": c.get("hook"),
        "fidelity": c.get("fidelity"),
        "size_bytes": c.get("size_bytes"),
        "mime_source": c.get("mime_source"),
        "correlation_id": c.get("correlation_id"),
        "correlation_method": c.get("correlation_method"),
        "egress": c.get("egress"),
        "close_detection": c.get("close_detection"),
        "workflow_hash": c.get("workflow_hash"),
        "observed_at": c.get("observed_at"),
        "attestation_status": c.get("attestation_status"),
    }


def _utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


class PlacementRefused(ScrupleAPIError):
    """The resolved placement does not permit a leaf to be issued.

    Raised BEFORE anything is hashed, MACed or sent. ``can_claim: false`` is
    a well-formed answer, not an error condition in the model
    (PLACEMENT_AND_SURFACES.md §4.1 — the fourth placement exists so the
    standard can refuse a shape), and this exception is how that refusal
    reaches a caller who asked for a leaf anyway.
    """

    def __init__(self, assurance: Assurance, resolution: PlacementResolution) -> None:
        super().__init__(
            "Refusing to witness at this placement: no leaf may be issued.\n"
            f"  declared:    {resolution.declared.value}\n"
            f"  enforcement: {resolution.enforcement.value}\n"
            f"  effective:   {resolution.effective.value}\n"
            f"  why:         {resolution.reason}\n"
            f"  assurance:   {assurance.reason}\n"
            "Events at this placement may be RECORDED as declared. They may never be "
            "reported as witnessed (D-8)."
        )
        self.assurance = assurance
        self.resolution = resolution


#: The one surface this placement has. ``in-process-callback``, because the
#: vendor's handler calls ``capture()`` directly, and ``as-delivered``,
#: because for a managed inference path the response body IS the artifact
#: (PLACEMENT_AND_SURFACES.md §7.3). Note this is the *same surface value*
#: as Kohya's monkey-patch and the opposite assurance — surface says how you
#: see, placement says whether what you saw is worth anything.
SERVER_LIBRARY_SURFACE = DeclaredSurface(
    name="server-library-inference-handler",
    surface=SurfaceKind.IN_PROCESS_CALLBACK,
    fidelity=ObservationFidelity.AS_DELIVERED,
    hooks=(CaptureHook.GRAPH_EXECUTE, CaptureHook.ARTIFACT_PRODUCED),
)


@dataclass
class ServerLibraryOutcome:
    """What one witnessed event produced. Every field is a fact, not a claim.

    ``witnessed`` is the server's answer read out by name (D-8); ``queued``
    means the submission is durably spooled and the counter it carries is
    already spent. Both can be false at once — a 4xx is neither.
    """

    counter: int
    mac: str
    content_hash: str
    witnessed: bool
    queued: bool
    leaf_id: Optional[str]
    leaf_hash: Optional[str]
    #: 'verified' | 'passthrough'. Never None on a returned outcome: a
    #: refused placement raises before this object exists.
    leaf_status: Optional[str]
    leaf: Optional[Dict[str, Any]] = None
    predicate: Optional[Dict[str, Any]] = None
    #: None when the event was queued. Attesting a leaf the witness never
    #: saw would assert something that did not happen.
    envelope: Optional[Dict[str, Any]] = None
    error: Optional[str] = None


class ServerLibraryIntegration:
    """The object a vendor holds for the life of their inference process.

    One instance owns one component identity and therefore one ratchet, and
    a ratchet is single-threaded by contract (``ratchet.py``): a counter must
    never be issued twice under one ``component_id``. A vendor running N
    worker processes provisions N components, which is also what makes the
    reconciliation view able to say *which* worker went silent.
    """

    def __init__(
        self,
        client: Any,
        *,
        component: ComponentIdentity,
        ratchet: Ratchet,
        enforcement: PlacementEnforcement = PlacementEnforcement.NO_TENANT_CODE,
        declared_placement: Placement = Placement.SERVER_LIBRARY,
        attestation_provider: str = "none",
        attestation_outcome: AttestationOutcome = AttestationOutcome.NONE,
        quote_ref: Optional[str] = None,
        verifier_reference: Optional[str] = None,
        surfaces: Sequence[DeclaredSurface] = (SERVER_LIBRARY_SURFACE,),
        declared_properties: Optional[Mapping[str, str]] = None,
        envelope_signers: Sequence[EnvelopeSigner] = (),
        seal_path: Optional[str] = None,
    ) -> None:
        self.client = client
        self.component = component
        self.ratchet = ratchet
        self.envelope_signers = list(envelope_signers)
        self.seal_path = seal_path

        self.attestation_provider = attestation_provider
        self.attestation_outcome = AttestationOutcome(attestation_outcome)
        self.quote_ref = quote_ref
        self.verifier_reference = verifier_reference
        self.surfaces = list(surfaces)

        # The six that cannot be computed (predicate doc §4). Declared, so
        # that WO-9's self-grade harness has something to contradict —
        # DEFECT-2 stands: a well-formed declaration is what to PROBE, never
        # evidence that probing would pass.
        self.declared_properties: Dict[str, str] = dict(
            declared_properties
            or {
                "p2": "conditional",
                "p4": "conditional",
                "p5": "conditional",
                "p6": "conditional",
                "p7": "conditional",
                "p8": "conditional",
            }
        )

        self.resolution = resolve_placement(Placement(declared_placement), PlacementEnforcement(enforcement))
        self._assurance = assurance_for(self.resolution.effective, self.attestation_outcome)

    # -- posture ----------------------------------------------------------

    def assurance(self) -> Assurance:
        """The computed posture. Recomputed nowhere else and declared nowhere.

        Call this and print it. A vendor who never sees ``leaf: passthrough``
        until an auditor asks has been told something by omission.
        """
        return self._assurance

    @property
    def can_claim(self) -> bool:
        return self._assurance.can_claim

    def predicate(self) -> Dict[str, Any]:
        """This configuration's ``scruple-vendor-baseline`` predicate.

        Stable for the life of the configuration — it describes a
        deployment, not an event — so it is cheap to call per leaf and
        deliberately not cached: a vendor that mutates ``surfaces`` at
        runtime should see the predicate move with it.
        """
        return build_vendor_baseline_predicate(
            component=self.component,
            declared_placement=self.resolution.declared,
            enforcement=self.resolution.enforcement,
            attestation_provider=self.attestation_provider,
            attestation_outcome=self.attestation_outcome,
            surfaces=self.surfaces,
            declared_properties=self.declared_properties,
            quote_ref=self.quote_ref,
            verifier_reference=self.verifier_reference,
        )

    # -- the event path ---------------------------------------------------

    def witness_file(
        self,
        path: str,
        *,
        mime: str,
        kind: str = "artifact",
        graph: Optional[Dict[str, Any]] = None,
        training: Optional[Dict[str, Any]] = None,
        input_hash: Optional[str] = None,
        model_fingerprints_hash: Optional[str] = None,
        machine_manifest_hash: Optional[str] = None,
        project_id: Optional[int] = None,
    ) -> ServerLibraryOutcome:
        """Hash the artifact the handler just produced and witness it.

        ``mime`` is declared, never guessed — ``capture()`` refuses without
        one rather than supplying ``application/octet-stream``, which is what
        five of the six shells did and which silently gates the server's
        image-only watermarker shut.
        """
        payload = _capture_file(path, mime=mime, kind=kind)
        return self.witness(
            content_hash=payload["content_hash"],
            mime=payload["mime"],
            kind=kind,
            size_bytes=os.path.getsize(path),
            mime_source="caller-declared",
            graph=graph,
            training=training,
            input_hash=input_hash,
            model_fingerprints_hash=model_fingerprints_hash,
            machine_manifest_hash=machine_manifest_hash,
            project_id=project_id,
        )

    def witness(
        self,
        *,
        content_hash: str,
        mime: Optional[str],
        kind: str = "artifact",
        graph: Optional[Dict[str, Any]] = None,
        training: Optional[Dict[str, Any]] = None,
        input_hash: Optional[str] = None,
        model_fingerprints_hash: Optional[str] = None,
        machine_manifest_hash: Optional[str] = None,
        project_id: Optional[int] = None,
        size_bytes: Optional[int] = None,
        mime_source: Optional[str] = None,
        correlation_id: Optional[str] = None,
        observed_at: Optional[str] = None,
    ) -> ServerLibraryOutcome:
        """One event: derive, MAC, ratchet, then enqueue. In that order.

        A vendor generating text rather than files calls this directly with
        the sha256 of the response body — §8.1 of the axes doc, where the
        response body is the artifact and there is no file and no graph.

        ``mime`` is keyword-required and may be explicitly ``None``. It is
        NEVER guessed. Passing ``None`` says "nothing was entitled to
        declare a type", which is H-4 §7 probe 4's unattributed write and
        which the route records as ``mime_declared: false``. At THIS
        placement that should essentially never happen — the handler
        produced the bytes and knows what they are — so ``None`` here is
        usually a bug being made visible rather than a case being handled.
        An empty or whitespace string is refused outright, because that is
        neither a declaration nor an admission that there is none.
        """
        # 1. Posture first. Nothing is hashed, MACed or sent at a placement
        #    that may not issue a leaf, and the counter is not spent on it.
        if not self._assurance.can_claim:
            raise PlacementRefused(self._assurance, self.resolution)

        if not self.client.state.baseline_ref:
            raise NoBaselineError(
                "No baseline established for this session. Call Client.attach() first — "
                "witnessing without a baseline is refused client-side (D-3), not merely "
                "discouraged, and the counter is not spent on a call that cannot succeed."
            )
        if mime is not None and not mime.strip():
            raise ValueError(
                "witness() was given an empty `mime`. Declare a type, or pass None to say "
                "that nothing was entitled to declare one. An empty string is neither, and "
                "a placeholder like application/octet-stream is a declaration that is false."
            )

        # 2. What this placement OBSERVED, as distinct from what the leaf
        #    commits to. At `server-library` there is no separate observer
        #    — the vendor's handler is the observation — so this block is
        #    thinner than a sidecar's and every field it cannot fill is a
        #    null in a stable shape rather than a different shape. It is
        #    sent because the same preimage function reads it on both
        #    sides, and a key dropped from the object changes the
        #    canonical JSON and therefore the MAC.
        capture_block: Dict[str, Any] = {
            "surface": SurfaceKind.IN_PROCESS_CALLBACK.value,
            "hook": (
                CaptureHook.MODEL_WRITE.value
                if kind == "model_write"
                else CaptureHook.ARTIFACT_PRODUCED.value
            ),
            "fidelity": ObservationFidelity.AS_DELIVERED.value,
            "size_bytes": size_bytes,
            "mime_source": mime_source,
            "correlation_id": correlation_id,
            "correlation_method": None,
            "egress": None,
            "close_detection": None,
            "workflow_hash": None,
            "observed_at": observed_at or _utc_now(),
            "attestation_status": self._assurance.leaf,
        }

        # 3. The submission, assembled BEFORE the MAC, because the MAC is
        #    computed over the submission itself via `component_preimage()`
        #    — the same function the server calls on receipt. Assembling a
        #    separate field list here is how the two drift.
        component_envelope: Dict[str, Any] = {
            "component_id": self.component.component_id,
            "build_measurement": self.component.build_measurement,
            "counter": self.ratchet.counter,
            "attestation": {
                "provider": self.attestation_provider,
                "quote_ref": self.quote_ref,
            },
        }
        body: Dict[str, Any] = {
            "baseline_ref": self.client.state.baseline_ref,
            "kind": kind,
            "content_hash": content_hash,
            "capture": capture_block,
            "component": component_envelope,
        }
        # MIME IS SENT WHEN IT WAS DECLARED AND OMITTED WHEN IT WAS NOT.
        # There is no third state and there is no placeholder: H-4 §7 probe
        # 4 (a file appearing in an output volume with no producing node)
        # has nobody entitled to declare a type, and the route records that
        # as `mime_declared: false` rather than as
        # application/octet-stream — which would silently gate the
        # image-only watermarker shut while looking like a declaration.
        if mime is not None:
            body["mime"] = mime
        if input_hash is not None:
            body["input_hash"] = input_hash
        if model_fingerprints_hash is not None:
            body["model_fingerprints_hash"] = model_fingerprints_hash
        if machine_manifest_hash is not None:
            body["machine_manifest_hash"] = machine_manifest_hash

        fields = component_preimage(body)

        # 4. Derive, MAC, ratchet — one call, and the counter is spent when
        #    it returns whether or not anything is ever sent.
        counter, mac = self.ratchet.mac(fields)

        # 5. Seal BEFORE the network call. A process that dies between the
        #    MAC and the submission must come back holding K_{n+1}, not
        #    K_n: re-issuing a spent counter is indistinguishable from a
        #    replay and the server refuses it, which would lose the event
        #    permanently rather than queue it.
        self._seal()

        # The counter the ratchet actually spent, and the MAC over the
        # body as it stands. `component_envelope` is the same object the
        # preimage was read from, so a value that changed between the two
        # would be a MAC over something other than what is sent.
        component_envelope["counter"] = counter
        body["mac"] = mac

        if project_id is not None:
            body["project_id"] = project_id
        if graph is not None:
            body["graph"] = graph
        if training is not None:
            body["training"] = training

        # 6. Through http.submit, which is the ONLY function in this package
        #    that can fail on the wire and which enqueues inline in its own
        #    control flow. No retry, no try/except and no fallback here —
        #    an adapter that writes one has taken over a job the SDK owns.
        result = _http.submit(
            self.client,
            "POST",
            "/api/v2/witness",
            body=body,
            queue_kind="witness",
            queue_replay=body,
        )

        if result.queued or not result.ok:
            # The counter is spent and the bytes are on disk. A drain
            # re-sends these exact bytes and the server drops a genuine
            # duplicate idempotently on (component_id, counter) — which is
            # why the queued entry must never be re-MACed on retry.
            return ServerLibraryOutcome(
                counter=counter,
                mac=mac,
                content_hash=content_hash,
                witnessed=False,
                queued=result.queued,
                leaf_id=None,
                leaf_hash=None,
                leaf_status=self._assurance.leaf,
                error=result.error,
            )

        b = result.body or {}
        leaf: Dict[str, Any] = {
            "content_hash": content_hash,
            "mime": mime,
            "kind": kind,
            "leaf_hash": b.get("leaf_hash"),
            "leaf_scheme": b.get("leaf_scheme"),
            "run_sequence": b.get("run_sequence"),
            "baseline_ref": b.get("baseline_ref"),
            "witness_id": b.get("witness_id"),
            "input_hash": b.get("input_hash"),
            "workflow_hash": b.get("workflow_hash"),
            "model_fingerprints_hash": b.get("model_fingerprints_hash"),
            "machine_manifest_hash": b.get("machine_manifest_hash"),
            "component_id": self.component.component_id,
            "counter": counter,
            "mac": mac,
        }

        predicate = self.predicate()
        envelope = (
            attest_leaf(leaf, predicate, self.envelope_signers)
            if self.envelope_signers
            else None
        )

        return ServerLibraryOutcome(
            counter=counter,
            mac=mac,
            content_hash=content_hash,
            witnessed=bool(b.get("witnessed", False)),
            queued=False,
            leaf_id=b.get("leaf_id"),
            leaf_hash=b.get("leaf_hash"),
            leaf_status=self._assurance.leaf,
            leaf=leaf,
            predicate=predicate,
            envelope=envelope,
        )

    # -- offline ----------------------------------------------------------

    def drain(self) -> Dict[str, int]:
        """Retry everything the queue holds. Call from the vendor's own
        scheduler; there is no background thread in this package and there
        will not be one — an embedded interpreter is not a place to start
        threads a host did not ask for."""
        return self.client.detach()

    @property
    def queue_depth(self) -> int:
        return self.client.queue_depth

    def _seal(self) -> None:
        if self.seal_path:
            self.ratchet.seal_to_file(self.seal_path, component_id=self.component.component_id)


# -- provisioning ---------------------------------------------------------


def provision_component(
    client: Any,
    *,
    token: str,
    build_measurement: str,
    attestation: Optional[Mapping[str, Any]] = None,
    seal_path: Optional[str] = None,
) -> "tuple[ComponentIdentity, Ratchet]":
    """H-4 §4.4 injection, from the vendor's backend.

    TWO CREDENTIALS, BOTH REQUIRED, and this function sends both: the
    ``client``'s bearer API key says WHO is calling (it must carry
    ``component:provision`` — §10 C-5), and the one-time token says WHICH
    component. Neither alone provisions anything.

    ``queue_kind`` is deliberately absent. Provisioning is a precondition,
    not a Phase-3 event: a queued provisioning request would hand back an IK
    at an unknown later time to a process that has already decided it has
    none. If this fails, it fails now and loudly.

    If the returned IK cannot later be re-sealed and restored, the component
    re-provisions as a NEW ``component_id`` at n=0. It must never guess a
    counter under an existing id.
    """
    body: Dict[str, Any] = {"token": token, "build_measurement": build_measurement}
    if attestation is not None:
        body["attestation"] = dict(attestation)

    result = _http.submit(client, "POST", "/api/v2/components/provision", body=body)
    if not result.ok or not isinstance(result.body, dict):
        raise ScrupleAPIError(
            f"provision_component() failed: {result.error}", status=result.status
        )

    data = result.body.get("data", result.body)
    component_id = data["component_id"]
    ratchet = Ratchet(bytes.fromhex(data["ik_hex"]), int(data.get("counter", 0)))
    identity = ComponentIdentity(
        component_id=component_id,
        tenant_id=data.get("tenant_id") or "",
        build_measurement=data.get("build_measurement", build_measurement),
    )
    if seal_path:
        ratchet.seal_to_file(seal_path, component_id=component_id)
        os.chmod(seal_path, 0o600)
    return identity, ratchet
