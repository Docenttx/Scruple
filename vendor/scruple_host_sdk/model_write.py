"""``model.write``, as a hook with two implementations instead of one.

WO-20 of ``docs/canon/WO-SERIES-2-PROVING-IT.md``. Prose, findings and the
vendor-facing limits: ``docs/canon/MODEL_WRITE_HOOK.md``. The evidence shape
this module witnesses is ``scruple_api.model_write``, which has no network
capability and is where a third-party verifier gets the definitions.

WHY THIS IS NOT ``server_library.py`` WITH ``kind="model_write"``
-----------------------------------------------------------------
``ServerLibraryIntegration`` already takes a ``declared_placement``, and it
already maps ``kind == "model_write"`` onto ``hook: model.write``. It looks
like it covers this. It does not, and the reasons are the WO's subject:

1. **It stamps ``fidelity: as-delivered`` on every leaf.** Correct for an
   inference handler, where the response body IS the artifact. A checkpoint is
   not delivered to anyone -- the trainer wrote it to disk. The honest value is
   ``as-written``, which asserts that a third party holding the file can
   re-derive the hash; ``as-delivered`` asserts they can re-derive the bytes a
   consumer received, and on a training run there is no consumer.
2. **It stamps ``surface: in-process-callback``.** True for a vendor whose
   backend orchestrates training. False for a vendor who isolated the trainer
   and watches the checkpoint volume from a namespace the tenant cannot reach
   -- which is ``filesystem-watch``, and is the placement the vendor gets a
   better tier for.
3. **``witness_file()`` cannot carry a checkpoint at all.** It routes through
   ``capture()``, which base64-inlines the file and refuses anything over
   25 MB. The smallest LoRA this hook will see is about 9 MB and a full
   fine-tune is gigabytes. This module hashes by streaming and sends no bytes.

None of those is a defect in ``server_library.py``: they are what it means
that ``model.write`` had one implementation. The parts of it that ARE the
contract are imported here rather than re-typed -- ``component_preimage`` above
all, because two implementations of a preimage are two preimages, and
``PlacementRefused``, because a second refusal exception would be a second
vocabulary.

WHAT IS STILL DUPLICATED, AND WHERE IT SHOULD GO
-----------------------------------------------
:meth:`ModelWriteIntegration._submit` repeats about forty lines of submission
assembly from ``ServerLibraryIntegration.witness()``. That is a seam the SDK
does not have yet: there is no ``submit_observation(client, observation)``
that takes a surface and a fidelity as arguments instead of assuming them.
Recorded rather than papered over -- the six copy-pasted shells are what
happens when this kind of duplication is left unnamed. The two things that
MUST not be duplicated are not: the preimage is one function, and the network
call is still the single ``http.submit``.

THE HONEST LIMIT, AND IT BELONGS IN THE VENDOR'S HEAD BEFORE THE CODE
--------------------------------------------------------------------
A checkpoint is a file. It is collected by a file browser, JupyterLab, ``scp``
or a remounted volume, and there is no point at which the bytes can be
withheld pending a leaf. So ``watch`` IS the capture rather than a complement
to a gate; there is no fail-closed point; and what replaces "you cannot get
the bytes without a leaf" is the counter travelling in the clear:

    **You can get the bytes. You cannot leave the record undisturbed.**

A tenant who removes the capture stops the counter, and a stopped counter is
visible -- H-4 §4.2's gap and silence accounting, obtained free from the key
schedule. It is a weaker guarantee than ComfyUI's gate and it is stated as
one, because a vendor will design against whatever we tell them they have.
"""

from __future__ import annotations

import os
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence

from scruple_api.model_write import (
    MODEL_WRITE_IN_PROCESS,
    MODEL_WRITE_KIND,
    MODEL_WRITE_VOLUME_WATCH,
    CheckpointFacts,
    ModelWriteSurfaceProfile,
    TrainingRun,
    observe_checkpoint,
)
from scruple_api.surface import (
    Assurance,
    AttestationOutcome,
    CaptureHook,
    Placement,
    PlacementEnforcement,
    PlacementResolution,
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
from .errors import NoBaselineError
from .ratchet import Ratchet
from .server_library import (
    PlacementRefused,
    component_preimage,
    provision_component,
)

__all__ = [
    "CHECKPOINT_EXTENSIONS",
    "DEFAULT_CHECKPOINT_SETTLE_S",
    "ModelWriteOutcome",
    "ModelWriteIntegration",
    "provision_or_refuse",
    "install_safetensors_save_file_hook",
    "install_torch_save_hook",
    "CheckpointVolumeWatch",
]

#: What Kohya's save path and a plain PyTorch loop's save path produce.
#: Everything else that lands in a checkpoint volume -- sample images, logs,
#: TensorBoard events -- is an ``artifact.produced`` and is emitted as one.
#: A file the watcher declines to emit is an invisible hole, and H-4 §7
#: probe 4 exists to catch exactly that.
CHECKPOINT_EXTENSIONS = frozenset({".safetensors", ".ckpt", ".pt", ".pth", ".bin"})

#: Not the ComfyUI watcher's 250 ms, and the reason is the file. A PNG is
#: written in milliseconds; a multi-gigabyte checkpoint is written over tens of
#: seconds by a process that is also saturating a GPU, and a short settle
#: window slices it into several partial hashes -- which on a checkpoint is
#: INDISTINGUISHABLE from the tamper case it is not. A mitigation, not a fix;
#: the fix is inotify's real IN_CLOSE_WRITE.
DEFAULT_CHECKPOINT_SETTLE_S = 15.0


def _utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


@dataclass
class ModelWriteOutcome:
    """One witnessed checkpoint. Every field is a fact, not a claim."""

    counter: int
    mac: str
    content_hash: str
    witnessed: bool
    queued: bool
    kind: str
    hook: str
    leaf_id: Optional[str]
    leaf_hash: Optional[str]
    #: ``'verified'`` | ``'passthrough'``. A refused placement raises before
    #: this object exists, so it is never ``None`` on a returned outcome.
    leaf_status: Optional[str]
    #: The safetensors structural fingerprint, or ``None`` for a format that
    #: has none -- a ``.pt`` pickle has no header and this is how that is said.
    header_hash: Optional[str] = None
    #: FALSE, TODAY, ON EVERY OUTCOME, and deliberately surfaced rather than
    #: left to be discovered. ``header_hash`` is not a field in
    #: ``lib/leaf/registry.yaml``, is not in ``/v2/witness``'s accepted body,
    #: and is not read by ``component_preimage()`` -- so it rides on the wire,
    #: is not covered by the MAC, and is not persisted on the leaf. Closing it
    #: is one registry entry, one Zod field, and the same three lines in the
    #: three preimage implementations (``server_library.py``,
    #: ``lib/leaf/componentPreimage.ts``, ``services/scruple-capture/src/leaf.ts``).
    #: None of those five files belongs to this WO. See MODEL_WRITE_HOOK.md §4.
    header_hash_covered: bool = False
    workflow_hash: Optional[str] = None
    input_hash: Optional[str] = None
    model_fingerprints_hash: Optional[str] = None
    leaf: Optional[Dict[str, Any]] = None
    predicate: Optional[Dict[str, Any]] = None
    envelope: Optional[Dict[str, Any]] = None
    error: Optional[str] = None


class ModelWriteIntegration:
    """The object a vendor holds for the life of one training worker.

    ONE INSTANCE OWNS ONE RATCHET, and a ratchet is single-threaded by
    contract: a counter must never be issued twice under one
    ``component_id``. A vendor running N trainers provisions N components,
    which is also what lets reconciliation say WHICH trainer went silent.

    THE PLACEMENT IS RESOLVED, NEVER DECLARED. Any of the four is accepted as
    a declaration; ``resolve_placement`` decides what it actually is, and a
    declaration whose enforcement is absent lands on ``unattested-client``,
    where no leaf may be issued at all. That is the shape today's in-pod Kohya
    hook has, and it is refused rather than downgraded.
    """

    def __init__(
        self,
        client: Any,
        *,
        component: ComponentIdentity,
        ratchet: Ratchet,
        declared_placement: Placement = Placement.SERVER_LIBRARY,
        enforcement: PlacementEnforcement = PlacementEnforcement.NO_TENANT_CODE,
        surface_profile: ModelWriteSurfaceProfile = MODEL_WRITE_IN_PROCESS,
        attestation_provider: str = "none",
        attestation_outcome: AttestationOutcome = AttestationOutcome.NONE,
        quote_ref: Optional[str] = None,
        verifier_reference: Optional[str] = None,
        declared_mime: Optional[str] = None,
        declared_properties: Optional[Mapping[str, str]] = None,
        envelope_signers: Sequence[EnvelopeSigner] = (),
        seal_path: Optional[str] = None,
    ) -> None:
        self.client = client
        self.component = component
        self.ratchet = ratchet
        self.profile = surface_profile
        self.envelope_signers = list(envelope_signers)
        self.seal_path = seal_path
        self.attestation_provider = attestation_provider
        self.attestation_outcome = AttestationOutcome(attestation_outcome)
        self.quote_ref = quote_ref
        self.verifier_reference = verifier_reference

        # DECLARED, OR ABSENT. There is no registered media type for
        # safetensors and none at all for a torch pickle, and
        # `application/octet-stream` is not a fallback -- it is a declaration
        # that is false, and it silently gates the server's image-only
        # watermarker shut. A vendor who has a type for their volume declares
        # it; one who does not passes nothing, and the route records
        # `mime_declared: false`, which is the honest record of "nobody was
        # entitled to declare a type".
        if declared_mime is not None and not declared_mime.strip():
            raise ValueError(
                "declared_mime was empty. Declare a type, or pass None to say that "
                "nothing was entitled to declare one. An empty string is neither."
            )
        self.declared_mime = declared_mime

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

        self.resolution: PlacementResolution = resolve_placement(
            Placement(declared_placement), PlacementEnforcement(enforcement)
        )
        self._assurance = assurance_for(self.resolution.effective, self.attestation_outcome)

    # -- posture ----------------------------------------------------------

    def assurance(self) -> Assurance:
        """The computed posture. Print it. A vendor who first learns their
        tier from an auditor was told by omission."""
        return self._assurance

    @property
    def can_claim(self) -> bool:
        return self._assurance.can_claim

    def refuse_if_unclaimable(self) -> None:
        """Raise :class:`PlacementRefused` if no leaf may be issued.

        Called at the top of every event path AND by
        :func:`provision_or_refuse` before a token is spent, so a refused
        deployment burns no provisioning token and never seals an IK anywhere
        the tenant can read it (H-4 §7 probe 3).
        """
        if not self._assurance.can_claim:
            raise PlacementRefused(self._assurance, self.resolution)

    def predicate(self) -> Dict[str, Any]:
        """This configuration's ``scruple-vendor-baseline`` predicate.

        The declared surface carries this hook's real surface and fidelity
        rather than the inference handler's, which is the whole reason this
        class exists.
        """
        surface = DeclaredSurface(
            name=self.profile.name,
            surface=self.profile.surface,
            fidelity=self.profile.fidelity,
            hooks=(CaptureHook.MODEL_WRITE, CaptureHook.ARTIFACT_PRODUCED),
        )
        return build_vendor_baseline_predicate(
            component=self.component,
            declared_placement=self.resolution.declared,
            enforcement=self.resolution.enforcement,
            attestation_provider=self.attestation_provider,
            attestation_outcome=self.attestation_outcome,
            surfaces=[surface],
            declared_properties=self.declared_properties,
            quote_ref=self.quote_ref,
            verifier_reference=self.verifier_reference,
        )

    # -- the event path ---------------------------------------------------

    def witness_checkpoint(
        self,
        path: str,
        run: TrainingRun,
        *,
        mime: Optional[str] = None,
        project_id: Optional[int] = None,
        observed_at: Optional[str] = None,
    ) -> ModelWriteOutcome:
        """One checkpoint. Hash it, commit the run to it, witness it.

        ``run`` is per-RUN and ``path`` is per-EVENT, which is the distinction
        §4.1's "checkpoint + dataset root + hyperparameters" was reaching for:
        one training run writes many checkpoints and every one of them commits
        to the same dataset, the same recipe and the same base model.

        Raises :class:`PlacementRefused` BEFORE hashing anything and before
        spending a counter. Raises
        :class:`scruple_api.model_write.DirectoryCheckpointError` if handed a
        sharded checkpoint directory -- see that exception for why it refuses
        rather than inventing an answer.
        """
        self.refuse_if_unclaimable()
        facts = observe_checkpoint(path)
        return self._submit(
            facts=facts,
            run=run,
            kind=MODEL_WRITE_KIND,
            hook=CaptureHook.MODEL_WRITE,
            mime=mime if mime is not None else self.declared_mime,
            project_id=project_id,
            observed_at=observed_at,
        )

    def witness_artifact(
        self,
        path: str,
        *,
        run: Optional[TrainingRun] = None,
        mime: Optional[str] = None,
        project_id: Optional[int] = None,
        observed_at: Optional[str] = None,
    ) -> ModelWriteOutcome:
        """A file in the checkpoint volume that is not a checkpoint.

        Sample images, logs, TensorBoard events. Emitted as
        ``artifact.produced`` / ``kind: artifact`` rather than dropped,
        because a file the capture declines to emit is a hole nothing can see
        and probe 4 exists to find exactly those.
        """
        self.refuse_if_unclaimable()
        facts = observe_checkpoint(path)
        return self._submit(
            facts=facts,
            run=run,
            kind="artifact",
            hook=CaptureHook.ARTIFACT_PRODUCED,
            mime=mime,
            project_id=project_id,
            observed_at=observed_at,
        )

    # -- offline ----------------------------------------------------------

    def drain(self) -> Dict[str, int]:
        """Retry everything the queue holds. Call it from the vendor's own
        scheduler; there is no background thread in this package."""
        return self.client.detach()

    @property
    def queue_depth(self) -> int:
        return self.client.queue_depth

    # -- internals --------------------------------------------------------

    def _seal(self) -> None:
        if self.seal_path:
            self.ratchet.seal_to_file(self.seal_path, component_id=self.component.component_id)

    def _submit(
        self,
        *,
        facts: CheckpointFacts,
        run: Optional[TrainingRun],
        kind: str,
        hook: CaptureHook,
        mime: Optional[str],
        project_id: Optional[int],
        observed_at: Optional[str],
    ) -> ModelWriteOutcome:
        if not self.client.state.baseline_ref:
            raise NoBaselineError(
                "No baseline established for this session. Call Client.attach() first — "
                "witnessing without a baseline is refused client-side (D-3), and the "
                "counter is not spent on a call that cannot succeed."
            )
        if mime is not None and not mime.strip():
            raise ValueError("mime was empty. Declare a type, or pass None.")

        workflow_hash = run.workflow_hash() if run else None
        input_hash = run.input_hash() if run else None
        fingerprints = run.model_fingerprints() if run else None
        model_fingerprints_hash = fingerprints[1] if fingerprints else None

        # What this deployment OBSERVED, as distinct from what the leaf
        # commits to. `absent is null, never omitted`: a key dropped from this
        # object changes the canonical JSON and therefore the MAC, so every
        # field this surface cannot fill is a null in a stable shape.
        capture_block: Dict[str, Any] = {
            "surface": self.profile.surface.value,
            "hook": hook.value,
            "fidelity": self.profile.fidelity.value,
            "size_bytes": facts.size_bytes,
            "mime_source": "vendor-config" if mime else None,
            "correlation_id": run.run_id if run else None,
            # The correlation on a training host is a RUN, not a prompt. Kohya
            # has no graph to correlate to and neither does a PyTorch loop.
            "correlation_method": "training-run" if run else "none",
            "egress": f"file:{os.path.basename(facts.path)}",
            "close_detection": self._close_detection(),
            # MACed, because it is in the component preimage's capture block.
            # The server recomputes the same value from `training` on receipt;
            # nothing currently compares the two, which is MODEL_WRITE_HOOK.md
            # §6's open item and not a thing this module can close alone.
            "workflow_hash": workflow_hash,
            "observed_at": observed_at or _utc_now(),
            "attestation_status": self._assurance.leaf,
        }

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
            "content_hash": facts.content_hash,
            "capture": capture_block,
            "component": component_envelope,
        }
        if mime is not None:
            body["mime"] = mime
        if input_hash is not None:
            body["input_hash"] = input_hash
        if model_fingerprints_hash is not None:
            body["model_fingerprints_hash"] = model_fingerprints_hash

        # The MAC first, over the same function the server calls. Assembling a
        # separate field list here is how the two drift.
        fields = component_preimage(body)
        counter, mac = self.ratchet.mac(fields)
        # Seal BEFORE the network call: a process that dies between the MAC
        # and the submission must come back holding K_{n+1}. Re-issuing a
        # spent counter is indistinguishable from a replay, and the server
        # refuses it -- which would lose the event permanently rather than
        # queue it.
        self._seal()
        component_envelope["counter"] = counter
        body["mac"] = mac

        # Everything below the MAC is carried but not sealed by it, and the
        # route re-derives each one independently. `training` is what the
        # server hashes into workflow_hash; `model_fingerprints` is what it
        # hashes into model_fingerprints_hash and REFUSES if it disagrees with
        # the value above -- which is the cross-check that makes sending both
        # worth more than sending either.
        if run is not None:
            body["training"] = run.recipe
            if run.base_model_fingerprints:
                body["model_fingerprints"] = run.base_model_fingerprints
        if project_id is not None:
            body["project_id"] = project_id
        # ON THE WIRE, NOT ON THE LEAF. See ModelWriteOutcome.header_hash_covered:
        # there is no registry field, no accepted body field and no preimage
        # slot for this today, so a server that grows one needs no client
        # change, and until it does the outcome says the field is uncovered
        # rather than letting its presence imply otherwise.
        if facts.header_hash is not None:
            capture_block["header_hash"] = facts.header_hash
            capture_block["structural_summary"] = facts.structural

        result = _http.submit(
            self.client,
            "POST",
            "/api/v2/witness",
            body=body,
            queue_kind="witness",
            queue_replay=body,
        )

        common = {
            "counter": counter,
            "mac": mac,
            "content_hash": facts.content_hash,
            "kind": kind,
            "hook": hook.value,
            "leaf_status": self._assurance.leaf,
            "header_hash": facts.header_hash,
            "workflow_hash": workflow_hash,
            "input_hash": input_hash,
            "model_fingerprints_hash": model_fingerprints_hash,
        }

        if result.queued or not result.ok:
            # The counter is spent and the bytes are on disk. A drain re-sends
            # these exact bytes; the queued entry must never be re-MACed,
            # which would mean two counters for one event.
            return ModelWriteOutcome(
                witnessed=False,
                queued=result.queued,
                leaf_id=None,
                leaf_hash=None,
                error=result.error,
                **common,
            )

        b = result.body or {}
        leaf: Dict[str, Any] = {
            "content_hash": facts.content_hash,
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
        return ModelWriteOutcome(
            witnessed=bool(b.get("witnessed", False)),
            queued=False,
            leaf_id=b.get("leaf_id"),
            leaf_hash=b.get("leaf_hash"),
            leaf=leaf,
            predicate=predicate,
            envelope=envelope,
            **common,
        )

    def _close_detection(self) -> str:
        """How this deployment knew the file was finished.

        ``save-returned`` is the strongest of the three and is available only
        in-process: the trainer's own save call returned, so the file is
        complete by construction. A watcher has to approximate it, and saying
        which one produced the leaf is what lets a reader weigh §10 C-10's
        partial-hash ambiguity.
        """
        return (
            "save-returned"
            if self.profile is MODEL_WRITE_IN_PROCESS
            else "quiescence"
        )


# ── Provisioning that refuses first ─────────────────────────────────────────


def provision_or_refuse(
    client: Any,
    *,
    token: str,
    build_measurement: str,
    declared_placement: Placement,
    enforcement: PlacementEnforcement,
    attestation_outcome: AttestationOutcome = AttestationOutcome.NONE,
    attestation: Optional[Mapping[str, Any]] = None,
    seal_path: Optional[str] = None,
):
    """Resolve the placement BEFORE spending a one-time provisioning token.

    ``KOHYA_REPLACEMENT.md`` §1 records this as the runner's most important
    behaviour and it is worth restating: refusing after provisioning would
    burn a token and seal an IK into a filesystem the tenant can read, which
    is the exact condition H-4 §7 probe 3 exists to detect. A configuration
    that may not issue a leaf must never hold a key.

    Returns ``(identity, ratchet)`` exactly as
    :func:`server_library.provision_component` does.
    """
    resolution = resolve_placement(Placement(declared_placement), PlacementEnforcement(enforcement))
    posture = assurance_for(resolution.effective, AttestationOutcome(attestation_outcome))
    if not posture.can_claim:
        raise PlacementRefused(posture, resolution)
    return provision_component(
        client,
        token=token,
        build_measurement=build_measurement,
        attestation=attestation,
        seal_path=seal_path,
    )


# ── Implementation 1 — the Kohya shape: safetensors.torch.save_file ─────────


def install_safetensors_save_file_hook(
    module: Any,
    integration: ModelWriteIntegration,
    run_provider: Callable[[], Optional[TrainingRun]],
    *,
    mime: Optional[str] = None,
    attribute: str = "save_file",
) -> Callable[[], None]:
    """Wrap ``safetensors.torch.save_file``. Returns an uninstall callable.

    THE SAME CALL SITE KOHYA'S IN-POD HOOK PATCHES, and deliberately so: the
    hook did not change when the placement did (``PLACEMENT_AND_SURFACES.md``
    §7.2). What changed is who runs it and whether the key it seals with is
    reachable by the party being measured. Installed from a vendor's own
    backend at ``server-library``, the identical patch produces a leaf; dropped
    into a pod the tenant has root in, it produces nothing, and
    :meth:`ModelWriteIntegration.refuse_if_unclaimable` is what makes the
    difference mechanical rather than editorial.

    ``module`` is passed in rather than imported, so this function does not
    drag torch into any process that did not already want it, and so the
    tests can exercise it without a GPU stack.

    THE ORIGINAL RUNS FIRST, ALWAYS. Instrumentation that can lose a
    checkpoint is worse than no instrumentation. Unlike the in-pod hook, this
    one does NOT swallow errors afterwards: the reason that hook swallows is
    that it has no queue and a network failure would otherwise break training,
    and here ``http.submit`` already spools a failed submission by
    construction. What is left after that is bugs, and a bug that silently
    drops a checkpoint's leaf is the invisible hole probe 4 exists to catch.
    """
    integration.refuse_if_unclaimable()
    original = getattr(module, attribute)

    def hooked(tensors: Any, filename: str, metadata: Any = None) -> Any:
        result = original(tensors, filename, metadata)
        integration.witness_checkpoint(filename, run_provider() or _no_run(), mime=mime)
        return result

    setattr(module, attribute, hooked)

    def uninstall() -> None:
        setattr(module, attribute, original)

    return uninstall


# ── Implementation 2 — the plain-PyTorch shape: torch.save ─────────────────


def install_torch_save_hook(
    module: Any,
    integration: ModelWriteIntegration,
    run_provider: Callable[[], Optional[TrainingRun]],
    *,
    mime: Optional[str] = None,
    attribute: str = "save",
    only_paths_under: Optional[str] = None,
) -> Callable[[], None]:
    """Wrap ``torch.save``. Returns an uninstall callable.

    THE SECOND IMPLEMENTATION, AND WHAT IT PROVED. A plain PyTorch loop calls
    ``torch.save(state_dict, path)`` and writes a zip-wrapped pickle. Running
    the same contract over it surfaced three things the Kohya-only
    specification could not have:

    1. **``header_hash`` does not exist here.** A pickle has no safetensors
       header, so the structural fingerprint that ``KOHYA_REPLACEMENT.md``
       leans on -- the thing that distinguishes a metadata edit from a
       re-train -- is simply unavailable. ``CheckpointFacts.header_hash`` is
       ``None`` and the leaf says so. The hook is portable; half its evidence
       is a property of the FORMAT, not of the hook.
    2. **``torch.save`` is not a checkpoint call.** It is a generic serializer:
       the same function writes optimizer state, a resume file, a cached
       tensor. ``only_paths_under`` exists because of that -- a vendor scopes
       it to their checkpoint directory rather than witnessing every
       ``torch.save`` in the process as a model write. Kohya's call site
       needed no such scoping, which is exactly why one implementation could
       not have told us this.
    3. **A torch pickle has no media type.** Not "we did not look" -- there
       is none. So ``mime`` stays ``None`` and the route records
       ``mime_declared: false``, which is the honest record. Reaching for
       ``application/octet-stream`` here is the same false declaration five of
       the six shells made.
    """
    integration.refuse_if_unclaimable()
    original = getattr(module, attribute)
    root = os.path.abspath(only_paths_under) if only_paths_under else None

    def hooked(obj: Any, f: Any, *args: Any, **kwargs: Any) -> Any:
        result = original(obj, f, *args, **kwargs)
        if isinstance(f, (str, bytes, os.PathLike)):
            path = os.fspath(f)
            if isinstance(path, bytes):
                path = path.decode()
            if root is None or os.path.abspath(path).startswith(root + os.sep):
                integration.witness_checkpoint(path, run_provider() or _no_run(), mime=mime)
        return result

    setattr(module, attribute, hooked)

    def uninstall() -> None:
        setattr(module, attribute, original)

    return uninstall


def _no_run() -> TrainingRun:
    """A checkpoint with no run context.

    A legitimate state -- a watcher that opened before the run started sees
    exactly this -- and it produces a leaf with NO run commitment rather than
    a fabricated one. Absent is honest; invented is not.
    """
    return TrainingRun(recipe={}, dataset=None, base_model_fingerprints=None, run_id=None)


# ── The sidecar path — watch IS the capture ────────────────────────────────


class CheckpointVolumeWatch:
    """``filesystem-watch`` over a checkpoint volume, for the isolated vendor.

    Deliberately a SCAN driven by the caller rather than a thread: there is no
    background thread anywhere in this package, an embedded interpreter is not
    a place to start one a host did not ask for, and a pull loop is what makes
    the settle window testable with an injected clock instead of with sleeps.

    QUIESCENCE IS AN APPROXIMATION OF ``IN_CLOSE_WRITE`` AND THE CAVEAT IS
    LOAD-BEARING (§10 C-10): a writer that stalls past the window gets its
    partial file hashed, and then hashed again when it finishes. On an image
    that is noise. On a checkpoint the resulting two-hashes record is
    indistinguishable from the tamper case it is not, which is why the default
    window is 15 s rather than the ComfyUI watcher's 250 ms, and why that is a
    mitigation rather than a fix.
    """

    def __init__(
        self,
        volume: str,
        integration: ModelWriteIntegration,
        run_provider: Callable[[], Optional[TrainingRun]] = lambda: None,
        *,
        settle_s: float = DEFAULT_CHECKPOINT_SETTLE_S,
        clock: Callable[[], float] = time.monotonic,
        mime: Optional[str] = None,
        log: Optional[Callable[[str], None]] = None,
    ) -> None:
        self.volume = volume
        self.integration = integration
        self.run_provider = run_provider
        self.settle_s = settle_s
        self.clock = clock
        self.mime = mime
        self.log = log or (lambda line: None)
        self._seen: Dict[str, str] = {}
        self._pending: Dict[str, tuple] = {}

    def open(self) -> None:
        """MUST fail loudly if the position cannot be acquired.

        A surface that silently fails to open is the ComfyUI WebSocket gap by
        another name: it reports nothing and looks identical to a volume in
        which nothing happened.
        """
        self.integration.refuse_if_unclaimable()
        if not os.path.isdir(self.volume):
            raise FileNotFoundError(
                f"{self.volume!r} does not exist. Refusing to open a watcher that observes "
                "nothing — an empty watch and a quiet volume are indistinguishable from "
                "the outside, and only one of them is a deployment."
            )

    def scan(self) -> List[ModelWriteOutcome]:
        """Emit every file that has been byte-stable for the settle window.

        Called on a timer by the vendor. Returns the outcomes it produced, so
        a caller can account for them; it never returns silently on an error
        it could have reported.
        """
        now = self.clock()
        outcomes: List[ModelWriteOutcome] = []
        for path in self._files():
            try:
                stat = os.stat(path)
            except OSError:
                self._pending.pop(path, None)
                continue
            previous = self._pending.get(path)
            if previous is None or previous[0] != stat.st_size or previous[1] != stat.st_mtime:
                self._pending[path] = (stat.st_size, stat.st_mtime, now)
                continue
            if now - previous[2] < self.settle_s:
                continue

            facts = observe_checkpoint(path)
            if self._seen.get(path) == facts.content_hash:
                continue
            if path in self._seen:
                # RECORDED, NOT RESOLVED. Both events go to the witness; this
                # line does not decide which of the two explanations is true,
                # because from here they are the same evidence.
                self.log(
                    f"{path} closed again with a different hash "
                    f"({self._seen[path][:12]} → {facts.content_hash[:12]}). Both are "
                    "recorded. On a checkpoint this is AMBIGUOUS by construction: a "
                    "trainer that stalled past the settle window produces exactly the "
                    "same pair of events as a tamper."
                )
            self._seen[path] = facts.content_hash
            run = self.run_provider()
            if os.path.splitext(path)[1].lower() in CHECKPOINT_EXTENSIONS:
                outcomes.append(
                    self.integration.witness_checkpoint(path, run or _no_run(), mime=self.mime)
                )
            else:
                outcomes.append(self.integration.witness_artifact(path, run=run))
        return outcomes

    def _files(self) -> List[str]:
        found: List[str] = []
        for dirpath, dirnames, filenames in os.walk(self.volume, followlinks=False):
            dirnames.sort()
            for name in sorted(filenames):
                p = os.path.join(dirpath, name)
                if os.path.isfile(p) and not os.path.islink(p):
                    found.append(p)
        return found
