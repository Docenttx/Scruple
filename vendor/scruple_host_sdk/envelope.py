"""The Python mirror of ``lib/envelope/`` — DSSE envelope, statement, and the
``scruple-vendor-baseline`` predicate.

SPEC: ``docs/canon/PREDICATE_scruple-vendor-baseline.md``. That document
describes a TypeScript implementation (``lib/envelope/{pae,dsse,statement,
predicate,attest}.ts``) because that is where WO-2 landed. WO-6's
``server-library`` path runs in a vendor's **Python** backend, so the same
four layers have to exist here, and the only thing standing between one
vocabulary and two is a shared artifact both sides read.

That artifact is ``test/vectors/vendor-baseline-predicate-vectors.json``:
the enum sets, the emitted JSON Schema, the twelve-cell assurance table and
a list of build/validate cases, GENERATED FROM THE TYPESCRIPT and consumed
by ``tests/test_server_library.py`` here and by
``test/v2/predicate-vectors.test.ts`` there. It is the same defence
``test/vectors/ratchet-vectors.json`` provides for the key schedule, for the
same reason: two implementations that each pass their own tests and disagree
on the wire is the failure this cannot be allowed to have.

WHY THIS IS A SEPARATE MODULE FROM ``server_library.py``
-------------------------------------------------------
Because that is the whole point of WO-2. The compliance vocabulary (P1-P8,
placement, surfaces) and the signing machinery version independently, and
neither is a property of the ``server-library`` placement — the sidecar and
the plugins will emit the same predicate. Folding these four layers into the
placement path would re-fuse exactly what the split exists to separate, one
directory later.

WHAT IS NOT HERE, AND WHY
-------------------------
No signature ALGORITHM. ``sign_envelope()`` takes signers; it does not know
what ECDSA is. This package is pure standard library (it runs inside
embedded interpreters where pip cannot be assumed) and ``cryptography`` is
not a dependency; more importantly, a key custody story is H-4 §4's, not
this file's. ``examples/server-library-vendor/`` supplies a signer backed by
the CVM surrogate, which is where a real deployment's signer also lives:
outside the component.
"""

from __future__ import annotations

import base64
import json
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence

from scruple_api.surface import (
    AttestationOutcome,
    ObservationFidelity,
    Placement,
    PlacementEnforcement,
    PropertyDisposition,
    SurfaceKind,
    CaptureHook,
    assurance_for,
    resolve_placement,
)

__all__ = [
    "DSSE_VERSION",
    "SCRUPLE_STATEMENT_PAYLOAD_TYPE",
    "SCRUPLE_STATEMENT_TYPE_BASE",
    "SCRUPLE_STATEMENT_VERSION",
    "VENDOR_BASELINE_PREDICATE_BASE",
    "VENDOR_BASELINE_PREDICATE_VERSION",
    "BUILTIN_ATTESTATION_PROVIDERS",
    "EnvelopeError",
    "StatementError",
    "PredicateError",
    "pae",
    "statement_type",
    "vendor_baseline_predicate_type",
    "sign_envelope",
    "verify_envelope",
    "decode_unverified_payload",
    "leaf_subject",
    "leaf_from_subject",
    "build_statement",
    "serialize_statement",
    "parse_statement",
    "build_vendor_baseline_predicate",
    "validate_vendor_baseline_predicate",
    "attest_leaf",
    "open_leaf_attestation",
    "DeclaredSurface",
    "ComponentIdentity",
    "EnvelopeSigner",
    "EnvelopeVerifier",
    "VerifiedPayload",
]


# ── layer 1: PAE ────────────────────────────────────────────────────────────
#
# PAE(type, body) = "DSSEv1" SP LEN(type) SP type SP LEN(body) SP body
#
# secure-systems-lab/dsse/protocol.md. Reimplemented from the formula, not
# copied from any implementation — oss-study/SYNTHESIS.md §5 is the reason
# (every DSSE implementation in the study set carries an Apache-2.0 patent
# grant with a termination-on-litigation clause, which has to be weighed
# against Docent's own patent work BEFORE a line is copied, not after).
#
# LEN is the BYTE length in shortest decimal form. Python's len() over a
# str would count code points, which is the same class of bug as
# JavaScript's String.length counting UTF-16 code units: correct for ASCII
# forever, wrong the first time a payloadType is not. Everything here is
# measured after encoding.

DSSE_VERSION = b"DSSEv1"
_SP = b"\x20"


def pae(payload_type: str, payload: bytes) -> bytes:
    """The exact byte sequence a signer signs and a verifier verifies.

    Nothing else may be signed — in particular not the envelope JSON and
    not the payload alone. Without the length prefixes ``("a", "b c")`` and
    ``("a b", "c")`` produce identical bytes, so a signature over one is a
    signature over the other; that injectivity is the entire reason PAE
    exists.
    """
    t = payload_type.encode("utf-8")
    b = bytes(payload)
    return b"".join(
        [
            DSSE_VERSION,
            _SP,
            str(len(t)).encode("ascii"),
            _SP,
            t,
            _SP,
            str(len(b)).encode("ascii"),
            _SP,
            b,
        ]
    )


# ── layer 2: the DSSE envelope ──────────────────────────────────────────────


class EnvelopeError(Exception):
    pass


@dataclass(frozen=True)
class EnvelopeSigner:
    """Signs PAE BYTES, deliberately not "signs a payload".

    A signer that took a payload could be handed one without its type,
    which is precisely the confusion PAE exists to prevent.
    """

    keyid: str
    sign: Callable[[bytes], bytes]


@dataclass(frozen=True)
class EnvelopeVerifier:
    keyid: str
    verify: Callable[[bytes, bytes], bool]


@dataclass(frozen=True)
class VerifiedPayload:
    """THE verified bytes. Use these; never decode the envelope again.

    ``envelope.md``: an implementation "MUST ensure that the same payload
    bytes that are verified are the ones sent to the application layer".
    :func:`parse_statement` therefore takes bytes rather than an envelope,
    so the correct path is also the shorter one.
    """

    payload: bytes
    payload_type: str
    accepted_keyids: List[str]


def _b64(b: bytes) -> str:
    return base64.b64encode(b).decode("ascii")


def _unb64(s: str, what: str) -> bytes:
    # Either standard or URL-safe base64 is legal per the spec.
    try:
        return base64.b64decode(s.replace("-", "+").replace("_", "/"), validate=True)
    except Exception:
        raise EnvelopeError(f"{what} is not base64") from None


def sign_envelope(
    payload_type: str, payload: bytes, signers: Sequence[EnvelopeSigner]
) -> Dict[str, Any]:
    """Wrap a payload and sign it.

    Multiple signers produce multiple signatures over the SAME PAE bytes —
    the spec's m-of-n shape, not a countersignature chain.
    """
    if not payload_type:
        raise EnvelopeError("payloadType must not be empty")
    if not signers:
        raise EnvelopeError("an envelope with no signature authenticates nothing")
    pae_bytes = pae(payload_type, payload)
    return {
        "payload": _b64(payload),
        "payloadType": payload_type,
        "signatures": [{"keyid": s.keyid, "sig": _b64(s.sign(pae_bytes))} for s in signers],
    }


def _assert_envelope_shape(e: Mapping[str, Any]) -> None:
    if not isinstance(e, Mapping):
        raise EnvelopeError("envelope must be a JSON object")
    if not isinstance(e.get("payload"), str):
        raise EnvelopeError("payload must be a base64 string")
    pt = e.get("payloadType")
    if not isinstance(pt, str) or not pt:
        raise EnvelopeError("payloadType must be a non-empty string")
    sigs = e.get("signatures")
    if not isinstance(sigs, list):
        raise EnvelopeError("signatures must be an array")
    for s in sigs:
        if not isinstance(s, Mapping) or not isinstance(s.get("sig"), str):
            raise EnvelopeError("signatures[].sig must be a base64 string")


def verify_envelope(
    envelope: Mapping[str, Any],
    verifiers: Sequence[EnvelopeVerifier],
    *,
    threshold: int = 1,
) -> VerifiedPayload:
    """Verify at least ``threshold`` distinct verifiers over the envelope.

    A verifier is tried against every signature, not only the one whose
    ``keyid`` matches: keyid is a HINT, and a producer that omitted it must
    not therefore be unverifiable.

    Raises on failure rather than returning something false-ish, so a caller
    cannot reach the payload without having passed.
    """
    if threshold < 1:
        raise EnvelopeError("threshold must be at least 1")
    _assert_envelope_shape(envelope)

    body = _unb64(envelope["payload"], "payload")
    pae_bytes = pae(envelope["payloadType"], body)

    accepted: List[str] = []
    for v in verifiers:
        for s in envelope["signatures"]:
            try:
                ok = v.verify(pae_bytes, _unb64(s["sig"], "sig"))
            except Exception:
                ok = False
            if ok:
                accepted.append(v.keyid)
                break

    if len(accepted) < threshold:
        raise EnvelopeError(
            f"envelope did not meet the signature threshold: {len(accepted)} of {threshold}"
        )
    return VerifiedPayload(payload=body, payload_type=envelope["payloadType"], accepted_keyids=accepted)


def decode_unverified_payload(envelope: Mapping[str, Any]) -> bytes:
    """Decode WITHOUT verifying anything.

    Named to be uncomfortable at a call site. Legitimate for inspection and
    logging; never legitimate as the input to a decision.
    """
    _assert_envelope_shape(envelope)
    return _unb64(envelope["payload"], "payload")


# ── layer 3: the statement ──────────────────────────────────────────────────

SCRUPLE_STATEMENT_PAYLOAD_TYPE = "application/vnd.scruple.statement+json"
SCRUPLE_STATEMENT_TYPE_BASE = "https://scruple.ai/attestation/Statement/"
SCRUPLE_STATEMENT_VERSION = 1


def statement_type(version: int = SCRUPLE_STATEMENT_VERSION) -> str:
    return f"{SCRUPLE_STATEMENT_TYPE_BASE}v{version}"


class StatementError(Exception):
    pass


# lib/leaf/registry.yaml records this rename rather than reconciling it: the
# preimage says `output_hash`, the wire and the storage column say
# `content_hash`. Both bind here and this layer never learns there are two
# names — which is the first time WO-1's alias table has actually paid off.
_OUTPUT_HASH_SPELLINGS = ("output_hash", "content_hash")


def _read_output_hash(leaf: Mapping[str, Any]) -> Optional[str]:
    for k in _OUTPUT_HASH_SPELLINGS:
        v = leaf.get(k)
        if isinstance(v, str) and len(v) == 64 and all(c in "0123456789abcdef" for c in v):
            return v
    return None


def leaf_subject(leaf: Mapping[str, Any]) -> Dict[str, Any]:
    """Bind a leaf as the subject of a statement.

    The leaf rides VERBATIM — not normalized, not re-keyed, not
    canonicalized. The envelope wraps; it does not reshape. Integrity comes
    from the DSSE signature over the whole statement, which is why nothing
    here hashes the leaf and why nothing here MAY: ``digest.sha256`` is the
    leaf's own ``output_hash``, the one digest a third party holding the
    artifact can re-derive. Inventing a "hash of the leaf object" would
    create a second preimage for something that already has one.

    A leaf with no ``output_hash`` is REFUSED rather than given a synthetic
    digest. It is not a weaker subject; it is an unidentifiable one.
    """
    output_hash = _read_output_hash(leaf)
    if output_hash is None:
        raise StatementError(
            "leaf carries no output_hash (registry id; spelled content_hash on the submit "
            "and storage surfaces). The subject digest is the artifact hash and is not "
            "synthesised here."
        )
    witness_id = leaf.get("witness_id")
    name = f"scruple:leaf:{witness_id}" if isinstance(witness_id, str) and witness_id else "scruple:leaf"
    return {"name": name, "digest": {"sha256": output_hash}, "leaf": dict(leaf)}


def leaf_from_subject(subject: Mapping[str, Any]) -> Dict[str, Any]:
    """The leaf back out. No copy, no normalization, no repair."""
    if not isinstance(subject, Mapping) or not isinstance(subject.get("leaf"), Mapping):
        raise StatementError("subject carries no leaf")
    return subject["leaf"]


def build_statement(
    subjects: Sequence[Mapping[str, Any]],
    predicate_type: str,
    predicate: Any,
    version: int = SCRUPLE_STATEMENT_VERSION,
) -> Dict[str, Any]:
    if not subjects:
        raise StatementError("a statement with no subject is about nothing")
    if not predicate_type:
        raise StatementError("predicateType must not be empty")
    return {
        "_type": statement_type(version),
        "subject": [dict(s) for s in subjects],
        "predicateType": predicate_type,
        "predicate": predicate,
    }


def serialize_statement(s: Mapping[str, Any]) -> bytes:
    """Serialize for the envelope payload. Insertion order, and stable."""
    return json.dumps(s, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode("utf-8")


def parse_statement(payload: bytes) -> Dict[str, Any]:
    """Parse VERIFIED payload bytes back into a statement.

    Takes bytes, not an envelope, on purpose: the only bytes that should
    reach here are the ones :func:`verify_envelope` handed back.
    """
    try:
        raw = json.loads(payload.decode("utf-8"))
    except Exception as e:
        raise StatementError(f"statement payload is not JSON: {e}") from None
    if not isinstance(raw, dict):
        raise StatementError("statement must be a JSON object")
    t = raw.get("_type")
    if not isinstance(t, str) or not t.startswith(SCRUPLE_STATEMENT_TYPE_BASE):
        raise StatementError(f"unrecognised statement _type: {t!r}")
    if not isinstance(raw.get("subject"), list) or not raw["subject"]:
        raise StatementError("statement must carry at least one subject")
    if not isinstance(raw.get("predicateType"), str) or not raw["predicateType"]:
        raise StatementError("statement must carry a predicateType")
    return raw


# ── layer 4: the scruple-vendor-baseline predicate ──────────────────────────

VENDOR_BASELINE_PREDICATE_BASE = "https://scruple.ai/attestation/vendor-baseline/"
VENDOR_BASELINE_PREDICATE_VERSION = 1


def vendor_baseline_predicate_type(version: int = VENDOR_BASELINE_PREDICATE_VERSION) -> str:
    return f"{VENDOR_BASELINE_PREDICATE_BASE}v{version}"


#: P7's provider axis. NOT :class:`AttestationOutcome` — see §5.1 of the
#: predicate doc. Both spell their empty case 'none' and they mean different
#: things: provider 'none' is "this compute offers no hardware attestation";
#: outcome 'none' is "this leaf carries no envelope". SEV-SNP hardware whose
#: leaves carry nothing is provider 'amd-sev-snp' + outcome 'none', which is
#: a P8 failure the validator below catches. Collapsing the axes would make
#: that state unrepresentable rather than invalid, which is worse.
BUILTIN_ATTESTATION_PROVIDERS = (
    "none",
    "amd-sev-snp",
    "intel-tdx",
    "aws-nitro-enclave",
    "gcp-confidential-space",
    "azure-attestation-service",
    "nvidia-h100-cc",
    "tpm-2.0-quote",
)


class PredicateError(Exception):
    pass


@dataclass(frozen=True)
class ComponentIdentity:
    """Migration 041 ``components``, spelled the way that table spells it."""

    component_id: str
    tenant_id: str
    #: 'sha256:...' of the published image. None until the component declares one.
    build_measurement: Optional[str] = None

    def as_dict(self) -> Dict[str, Any]:
        return {
            "component_id": self.component_id,
            "tenant_id": self.tenant_id,
            "build_measurement": self.build_measurement,
        }


@dataclass(frozen=True)
class DeclaredSurface:
    """One declared observation position. ``CaptureSurface``, as data."""

    name: str
    surface: SurfaceKind
    fidelity: ObservationFidelity
    hooks: Sequence[CaptureHook]
    #: REQUIRED when fidelity is INDUCED (DEFECT-3's consequence): a surface
    #: that manufactures a serialization, hashes it and deletes it emits a
    #: leaf only Scruple can ever read.
    induced_artifact_ref: Optional[str] = None

    def as_dict(self) -> Dict[str, Any]:
        d: Dict[str, Any] = {
            "name": self.name,
            "surface": SurfaceKind(self.surface).value,
            "fidelity": ObservationFidelity(self.fidelity).value,
            "hooks": [CaptureHook(h).value for h in self.hooks],
        }
        if self.induced_artifact_ref is not None:
            d["induced_artifact_ref"] = self.induced_artifact_ref
        return d


_DECLARED_PROPERTY_KEYS = ("p2", "p4", "p5", "p6", "p7", "p8")
_ALL_PROPERTY_KEYS = ("p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8")
_DISPOSITIONS = tuple(d.value for d in PropertyDisposition)


def build_vendor_baseline_predicate(
    *,
    component: ComponentIdentity,
    declared_placement: Placement,
    enforcement: PlacementEnforcement,
    attestation_provider: str,
    attestation_outcome: AttestationOutcome,
    surfaces: Sequence[DeclaredSurface],
    declared_properties: Mapping[str, Any],
    quote_ref: Optional[str] = None,
    verifier_reference: Optional[str] = None,
    version: int = VENDOR_BASELINE_PREDICATE_VERSION,
) -> Dict[str, Any]:
    """Build a predicate, DERIVING everything that is derivable.

    §4.1 of the predicate doc: a predicate cannot grade itself. The caller
    supplies axes and declarations; it cannot supply a posture.
    ``placement.effective``, ``p1``, ``p3``, ``leaf_status``, ``can_claim``
    and ``conditions`` are computed here from :func:`resolve_placement` and
    :func:`assurance_for`, which are the same two functions the server uses.
    A forged posture is a schema error, not a judgement call.
    """
    missing = [k for k in _DECLARED_PROPERTY_KEYS if k not in declared_properties]
    if missing:
        raise PredicateError(
            f"declared_properties is missing {', '.join(missing)}. The six declarations are "
            "required precisely so WO-9's self-grade harness has something to contradict."
        )

    resolution = resolve_placement(Placement(declared_placement), PlacementEnforcement(enforcement))
    assurance = assurance_for(resolution.effective, AttestationOutcome(attestation_outcome))

    attestation: Dict[str, Any] = {
        "provider": attestation_provider,
        "quote_ref": quote_ref,
        "outcome": AttestationOutcome(attestation_outcome).value,
    }
    if verifier_reference is not None:
        attestation["verifier_reference"] = verifier_reference

    properties = {k: PropertyDisposition(declared_properties[k]).value for k in _DECLARED_PROPERTY_KEYS}
    properties["p1"] = assurance.p1.value
    properties["p3"] = assurance.p3.value

    return {
        "predicate_version": version,
        "component": component.as_dict(),
        "placement": {
            "declared": resolution.declared.value,
            "enforcement": resolution.enforcement.value,
            "effective": resolution.effective.value,
            "honoured": resolution.honoured,
            "reason": resolution.reason,
        },
        "attestation": attestation,
        "surfaces": [s.as_dict() for s in surfaces],
        "properties": {k: properties[k] for k in _ALL_PROPERTY_KEYS},
        "leaf_status": assurance.leaf,
        "can_claim": assurance.can_claim,
        "conditions": list(assurance.conditions),
    }


def validate_vendor_baseline_predicate(value: Any) -> List[str]:
    """Check a predicate that arrived from somewhere else.

    Returns EVERY problem rather than the first, because a producer fixing a
    baseline wants the list. An empty list means valid — INCLUDING the
    ``unattested-client`` case, which is valid and refused: §4.2 of the
    predicate doc exists so the standard can say no to a shape rather than
    fail to describe it, so a predicate whose ``can_claim`` is false is
    well-formed and must not be a schema error.

    This is the Python half of a pair. The TypeScript half is
    ``validateVendorBaselinePredicate()`` in ``lib/envelope/predicate.ts``,
    and the two are held together by the shared vectors file, which carries
    a case for every rule below with the errors each must produce.
    """
    errs: List[str] = []
    p = value
    if not isinstance(p, Mapping):
        return ["predicate must be a JSON object"]

    if not isinstance(p.get("predicate_version"), int) or isinstance(p.get("predicate_version"), bool):
        errs.append("predicate_version must be an integer")

    c = p.get("component")
    if not isinstance(c, Mapping):
        errs.append("component is required")
    else:
        if not isinstance(c.get("component_id"), str) or not c.get("component_id"):
            errs.append(
                "component.component_id is required — it is the HKDF salt for the IK, not a label"
            )
        if not isinstance(c.get("tenant_id"), str) or not c.get("tenant_id"):
            errs.append("component.tenant_id is required")
        bm = c.get("build_measurement", None)
        if bm is not None and not isinstance(bm, str):
            errs.append("component.build_measurement must be a string or null")

    pl = p.get("placement")
    placements = tuple(x.value for x in Placement)
    enforcements = tuple(x.value for x in PlacementEnforcement)
    if not isinstance(pl, Mapping):
        errs.append("placement is required")
    else:
        if pl.get("declared") not in placements:
            errs.append(f"placement.declared must be one of {', '.join(placements)}")
        if pl.get("enforcement") not in enforcements:
            errs.append(f"placement.enforcement must be one of {', '.join(enforcements)}")
        if not errs:
            r = resolve_placement(Placement(pl["declared"]), PlacementEnforcement(pl["enforcement"]))
            if pl.get("effective") != r.effective.value:
                errs.append(
                    f"placement.effective is declared '{pl.get('effective')}' but "
                    f"resolvePlacement('{pl['declared']}', '{pl['enforcement']}') yields "
                    f"'{r.effective.value}'. Effective placement is derived; a self-declared "
                    "one is DEFECT-1 reopened."
                )
            if pl.get("honoured") != r.honoured:
                errs.append("placement.honoured disagrees with resolvePlacement()")

    at = p.get("attestation")
    outcomes = tuple(x.value for x in AttestationOutcome)
    if not isinstance(at, Mapping):
        errs.append("attestation is required")
    else:
        provider = at.get("provider")
        if not isinstance(provider, str) or not provider:
            errs.append("attestation.provider is required ('none' when the compute offers none)")
        if at.get("outcome") not in outcomes:
            errs.append(f"attestation.outcome must be one of {', '.join(outcomes)}")
        builtin = provider in BUILTIN_ATTESTATION_PROVIDERS
        if not builtin and not at.get("verifier_reference"):
            errs.append(
                f"attestation.provider '{provider}' has no built-in verifier, so P8 requires a "
                "verifier_reference naming an independent verifier the customer trusts."
            )
        if provider == "none" and at.get("outcome") != "none":
            errs.append(
                "attestation.provider is 'none' (P7: no hardware attestation, P8 not applicable) "
                f"but outcome is '{at.get('outcome')}'. A leaf cannot carry an envelope from a "
                "subsystem the baseline says does not exist."
            )
        if provider != "none" and at.get("outcome") == "none":
            errs.append(
                f"attestation.provider is '{provider}', so P8 requires EVERY leaf to carry a "
                "platform_attestation envelope; outcome 'none' means none do."
            )
        if provider == "none" and at.get("quote_ref"):
            errs.append("attestation.quote_ref is set but provider is 'none'")

    surfaces = p.get("surfaces")
    surface_kinds = tuple(x.value for x in SurfaceKind)
    fidelities = tuple(x.value for x in ObservationFidelity)
    hooks = tuple(x.value for x in CaptureHook)
    if not isinstance(surfaces, list) or not surfaces:
        errs.append(
            "surfaces must name at least one observation position — a baseline claiming none "
            "observes nothing"
        )
    else:
        for i, s in enumerate(surfaces):
            if not isinstance(s, Mapping):
                errs.append(f"surfaces[{i}] must be an object")
                continue
            if not isinstance(s.get("name"), str) or not s.get("name"):
                errs.append(f"surfaces[{i}].name is required")
            if s.get("surface") not in surface_kinds:
                errs.append(f"surfaces[{i}].surface must be one of {', '.join(surface_kinds)}")
            if s.get("fidelity") not in fidelities:
                errs.append(f"surfaces[{i}].fidelity must be one of {', '.join(fidelities)}")
            hs = s.get("hooks")
            if not isinstance(hs, list) or not hs:
                errs.append(f"surfaces[{i}].hooks must name at least one hook")
            else:
                for h in hs:
                    if h not in hooks:
                        errs.append(f"surfaces[{i}] declares unknown hook '{h}'")
            if s.get("fidelity") == "induced" and not s.get("induced_artifact_ref"):
                errs.append(
                    f"surfaces[{i}] is 'induced' fidelity with no induced_artifact_ref. The hashed "
                    "serialization has to be obtainable again or the leaf is evidence only "
                    "Scruple can read."
                )

    pr = p.get("properties")
    if not isinstance(pr, Mapping):
        errs.append("properties is required")
    else:
        for k in _ALL_PROPERTY_KEYS:
            if pr.get(k) not in _DISPOSITIONS:
                errs.append(f"properties.{k} must be holds | conditional | fails")

    if isinstance(pl, Mapping) and isinstance(at, Mapping) and isinstance(pr, Mapping) and not errs:
        a = assurance_for(Placement(pl["effective"]), AttestationOutcome(at["outcome"]))
        if pr["p1"] != a.p1.value:
            errs.append(f"properties.p1 says '{pr['p1']}'; the assurance function says '{a.p1.value}'")
        if pr["p3"] != a.p3.value:
            errs.append(f"properties.p3 says '{pr['p3']}'; the assurance function says '{a.p3.value}'")
        if p.get("can_claim") is not a.can_claim:
            errs.append(
                f"can_claim says {p.get('can_claim')}; the assurance function says {a.can_claim}"
            )
        if p.get("leaf_status") != a.leaf:
            errs.append(
                f"leaf_status says '{p.get('leaf_status')}'; the assurance function says '{a.leaf}'"
            )

    return errs


# ── composition — the only function that knows both halves ──────────────────


def attest_leaf(
    leaf: Mapping[str, Any],
    predicate: Mapping[str, Any],
    signers: Sequence[EnvelopeSigner],
    *,
    predicate_version: int = VENDOR_BASELINE_PREDICATE_VERSION,
    statement_version: int = SCRUPLE_STATEMENT_VERSION,
    validate: bool = True,
) -> Dict[str, Any]:
    """Wrap one leaf and one baseline posture in a signed envelope.

    The predicate is validated before signing by default, because a
    signature over an unsound posture is a durable assertion of it.
    """
    if validate:
        errs = validate_vendor_baseline_predicate(predicate)
        if errs:
            raise PredicateError(
                "refusing to sign an invalid vendor-baseline predicate:\n  " + "\n  ".join(errs)
            )
    statement = build_statement(
        [leaf_subject(leaf)],
        vendor_baseline_predicate_type(predicate_version),
        predicate,
        statement_version,
    )
    return sign_envelope(
        SCRUPLE_STATEMENT_PAYLOAD_TYPE, serialize_statement(statement), signers
    )


@dataclass(frozen=True)
class OpenedAttestation:
    statement: Dict[str, Any]
    leaf: Dict[str, Any]
    predicate: Dict[str, Any]
    predicate_type: str
    accepted_keyids: List[str]


def open_leaf_attestation(
    envelope: Mapping[str, Any],
    verifiers: Sequence[EnvelopeVerifier],
    *,
    threshold: int = 1,
) -> OpenedAttestation:
    """Verify, THEN read — and the payload read is the one verification
    returned. The envelope is never re-parsed after verification, which is
    ``envelope.md``'s one hard rule."""
    verified = verify_envelope(envelope, verifiers, threshold=threshold)
    if verified.payload_type != SCRUPLE_STATEMENT_PAYLOAD_TYPE:
        raise EnvelopeError(f"unexpected payloadType '{verified.payload_type}'")
    statement = parse_statement(verified.payload)
    return OpenedAttestation(
        statement=statement,
        leaf=statement["subject"][0]["leaf"],
        predicate=statement["predicate"],
        predicate_type=statement["predicateType"],
        accepted_keyids=verified.accepted_keyids,
    )
