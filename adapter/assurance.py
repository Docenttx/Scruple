"""What a leaf's evidence ACTUALLY is, recorded rather than asserted.

WO-B3. Everything in this module exists because of one measured fact:
the addon cannot see most of the L2 evidence it is supposed to carry,
and the difference between "there is no signature" and "nobody told us
whether there is a signature" is the difference between an honest
receipt and a flattering one.

MEASURED AGAINST THE SANDBOX ON 2026-09-07 (see
docs/canon/blender-l2/03-V2-WITNESS-L2.md for the transcripts):

  * The witness server DOES produce H-1 fields. Row 1 of the scratch
    witness DB carries `leaf_signature = MEYCIQDCzSNc...`,
    `leaf_signer_key_id = ocid1.key...surrogate...`,
    `leaf_signature_alg = ECDSA_SHA_256`, `leaf_signer_surrogate = 1`.
  * `POST /api/v2/witness` returns NONE of them, `GET /api/v2/receipt/
    {leaf_id}` returns none of them, and `iterations` has no column to
    put them in. The app tier stores the witness's HMAC in
    `witness_signature` and drops the ECDSA signature on the floor.
  * `GET /api/v2/verify/{content_hash}` therefore computes
    `independently_verifiable` from the HMAC. It answered `true`, with
    `verification_basis.kind = "asymmetric_leaf_signature"`, for a leaf
    whose `leaf_signature` is NULL in the witness's own database
    (leaf 3, witnessed while the surrogate was stopped).

So this addon is in a position where the truthful record of a leaf's
signature is not `null` and not a value -- it is "the server does not
disclose one". `SignatureRecord.source` is that third answer, and
`independently_verifiable_checked` is never set from what /verify
claims, because this client holds no signature it could check.

THE STATES ARE FIVE, NOT ONE, AND NOT THREE.

WO-B3 asks for the three measurement-honesty states the v2 route names
(`witnessed`, queued, delivered-but-not-witnessed). Two more are needed
to keep those three honest:

  REJECTED         a 4xx. Delivered, refused, and NOT queued -- the SDK
                   queues transport failures and 5xx only (http.py:162).
                   Collapsing this into QUEUED would tell a user their
                   capture is coming back when it never will. This is not
                   hypothetical: every `kind` this addon sent before
                   WO-B3 was rejected with `invalid_body`.
  REFUSED_LOCALLY  never left the machine (no baseline, undeclarable
                   MIME, over the inline limit). Distinct from QUEUED for
                   the same reason.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Dict, List, Optional

from scruple_api.canonical import CANONICALIZATION_PROFILE as CLIENT_CANONICALIZATION_PROFILE


# ---- the measurement states --------------------------------------------

WITNESSED = "witnessed"
DELIVERED_NOT_WITNESSED = "delivered_not_witnessed"
QUEUED = "queued"
REJECTED = "rejected"
REFUSED_LOCALLY = "refused_locally"

#: Every state a capture can be in, in descending order of goodness. A
#: consumer that wants "did this work" asks `state == WITNESSED`; there is
#: deliberately no `ok` property, because four different failures that
#: need four different responses would collapse into one boolean.
STATES = (WITNESSED, DELIVERED_NOT_WITNESSED, QUEUED, REJECTED, REFUSED_LOCALLY)

#: The three the v2 route's own header names (route.ts:563). Kept as a
#: separate tuple so a test can assert this addon carries all three and
#: not merely "success or not".
MEASUREMENT_HONESTY_STATES = (WITNESSED, DELIVERED_NOT_WITNESSED, QUEUED)

_STATE_SENTENCE = {
    WITNESSED: "Witnessed. The server confirmed a leaf was written.",
    DELIVERED_NOT_WITNESSED: (
        "Delivered but NOT witnessed. The server accepted the request and "
        "did not write a witness leaf for it."
    ),
    QUEUED: (
        "Not delivered. Spooled on disk and will be retried; nothing is on "
        "the record yet."
    ),
    REJECTED: (
        "Rejected by the server. This will NOT be retried and will not "
        "succeed on its own."
    ),
    REFUSED_LOCALLY: "Refused here, before anything was sent.",
}


def sentence_for(state: str) -> str:
    return _STATE_SENTENCE.get(state, f"Unknown state {state!r}.")


# ---- where a field came from -------------------------------------------
# The distinction this whole module exists for.

FROM_WITNESS_RESPONSE = "witness_response"
FROM_RECEIPT = "receipt"
FROM_CLIENT = "client"
#: The server has no field for it on any route this client may call. NOT
#: the same as a null value: a null says "there is none", this says
#: "nobody was asked and nobody answered".
NOT_DISCLOSED = "not_disclosed"


@dataclass(frozen=True)
class SignatureRecord:
    """The H-1 triple, and where it came from.

    All three values are `None` today for every leaf this addon produces,
    with `source = NOT_DISCLOSED`. That is a statement about the API, not
    about the leaf -- the witness signed it, and the app tier did not pass
    the signature on. Anything rendering this must not print "unsigned".
    """

    leaf_signature: Optional[str] = None
    leaf_signer_key_id: Optional[str] = None
    leaf_signature_alg: Optional[str] = None
    #: True when the signing key is known to be a software surrogate. Only
    #: ever set from a field the server sent; never inferred from a key id
    #: this client pattern-matched, because a client that decides for
    #: itself what counts as hardware-backed is the failure mode the CVM
    #: surrogate exists to prevent.
    signer_surrogate: Optional[bool] = None
    source: str = NOT_DISCLOSED

    @property
    def present(self) -> bool:
        return bool(self.leaf_signature)

    @property
    def explanation(self) -> str:
        if self.present:
            backing = (
                "software surrogate key -- NOT hardware-backed"
                if self.signer_surrogate
                else "signer backing not stated by the server"
            )
            return f"ECDSA leaf signature present ({self.leaf_signature_alg or 'algorithm not stated'}; {backing})."
        if self.source == NOT_DISCLOSED:
            return (
                "No leaf signature was disclosed. /api/v2/witness and "
                "/api/v2/receipt return no signature field, so this client "
                "cannot tell a signed leaf from an unsigned one."
            )
        return "The server reported no leaf signature for this leaf."


@dataclass(frozen=True)
class CanonicalizationRecord:
    """Which canonicalization rule the leaf's hashes were computed under.

    Two fields because there are two answers and they currently DISAGREE:
    `scruple_api.canonical.CANONICALIZATION_PROFILE` is `jcs-1` and the
    server stamps `jcs-2` into `iterations.canonicalization_profile`
    (lib/leaf/canonicalJson.ts:104). The serializers agree byte-for-byte
    -- measured: an identical document containing `1e-5` and `3.0` hashed
    to the same `workflow_hash` on both sides -- so this is a divergence
    in the LABEL, which is the thing an auditor reads to know which rule
    to replay. Recording one number would be picking a side.

    `server` is `None` on every leaf today: no v2 route returns the
    profile it stored.
    """

    client: str = CLIENT_CANONICALIZATION_PROFILE
    server: Optional[str] = None
    source: str = NOT_DISCLOSED
    #: sha256 over the canonical form of the graph THIS CLIENT sent,
    #: computed locally with the same function. An auditor holding the
    #: leaf can compare it against `iterations.workflow_hash`; this client
    #: cannot, because no v2 route returns that either.
    client_workflow_hash: Optional[str] = None

    @property
    def agrees(self) -> Optional[bool]:
        """True/False when both labels are known, None when only one is.
        None is not "fine" -- it is the honest answer to a question the
        API does not let this client ask."""
        if self.server is None:
            return None
        return self.client == self.server


@dataclass(frozen=True)
class LeafAssurance:
    """One capture, and everything this client actually knows about it."""

    state: str
    kind: str
    mime: Optional[str]
    content_hash: Optional[str] = None
    leaf_id: Optional[str] = None
    leaf_hash: Optional[str] = None
    leaf_scheme: Optional[str] = None
    baseline_ref: Optional[str] = None
    filename: Optional[str] = None
    error: Optional[str] = None

    signature: SignatureRecord = field(default_factory=SignatureRecord)
    canonicalization: CanonicalizationRecord = field(default_factory=CanonicalizationRecord)

    #: §12.4 / floor item 7. 'verified' | 'passthrough' | None, exactly as
    #: the server said it. None means no attestation was supplied, which
    #: reads differently from 'passthrough' and must not be rendered as it.
    attestation_status: Optional[str] = None
    attestation_source: str = NOT_DISCLOSED

    #: What GET /api/v2/verify claimed, and whether THIS client checked it.
    #: Two fields on purpose. The second is False on every leaf, because
    #: the client holds no signature and no public key -- and because the
    #: claim has been observed to be wrong (see the module docstring).
    independently_verifiable_claimed: Optional[bool] = None
    independently_verifiable_checked: bool = False
    verification_basis_kind: Optional[str] = None

    #: The addon declares no deployment, so every Blender leaf is
    #: `undeclared` and claims_standard is false. Stated rather than
    #: omitted -- an absent key is a fact nobody reads.
    seal_state: str = "undeclared"
    claims_standard: bool = False

    #: The addon sends no §4.3 component envelope (H-4 is not closed here),
    #: so no leaf it produces is component-verified.
    component_verified: bool = False

    queue_depth_after: int = 0

    @property
    def witnessed(self) -> bool:
        return self.state == WITNESSED

    @property
    def assurance_tier(self) -> str:
        """The one line a panel shows. Never better than what was proven.

        'verified' requires BOTH an attestation the server verified AND a
        signature this client can point at. Neither is achievable today,
        and a tier computed from one of them alone would read as the
        other."""
        if self.state != WITNESSED:
            return "not witnessed"
        if self.attestation_status == "verified" and self.signature.present:
            return "verified"
        if self.signature.present and self.signature.signer_surrogate:
            return "passthrough (software-signed)"
        if self.signature.present:
            return "passthrough"
        if self.signature.source == NOT_DISCLOSED:
            return "undisclosed"
        return "passthrough"

    def to_dict(self) -> Dict[str, Any]:
        d = asdict(self)
        d["assurance_tier"] = self.assurance_tier
        d["sentence"] = sentence_for(self.state)
        d["signature"]["explanation"] = self.signature.explanation
        d["canonicalization"]["agrees"] = self.canonicalization.agrees
        return d


# ---- addressing one capture ---------------------------------------------


def capture_key(rec) -> str:
    """A stable handle for one tracker row.

    WO-B5's drill-down has to name a capture across redraws, and the
    tracker is a bounded deque that new captures push onto the FRONT --
    so a positional index points at a different capture the moment
    anything else is witnessed. It is also not the record object, because
    `state.replace_assurance()` swaps the object when a settlement
    updates a capture.

    Leaf id first, then content hash: both survive every in-place update
    the tracker performs. A capture that has neither -- refused before it
    was hashed -- gets a key derived from what it does have, which is
    unique enough to address a row and is never used as an identifier for
    anything on the record.
    """
    leaf_id = getattr(rec, "leaf_id", None)
    if leaf_id:
        return f"leaf:{leaf_id}"
    content_hash = getattr(rec, "content_hash", None)
    if content_hash:
        return f"hash:{content_hash}"
    return "local:{}:{}:{}".format(
        getattr(rec, "state", ""),
        getattr(rec, "filename", "") or "",
        (getattr(rec, "error", "") or "")[:40],
    )


# ---- builders -----------------------------------------------------------

def state_for(outcome) -> str:
    """Map a `WitnessOutcome` onto one of STATES.

    Reads `witnessed` and `queued` as separate fields and NEVER infers
    either from the other or from the absence of an exception (D-8). The
    REJECTED branch is the one the SDK cannot express on its own: it
    returns queued=False for both a 4xx and a client-side refusal, so the
    caller supplies `sent` to tell them apart.
    """
    if outcome.witnessed:
        return WITNESSED
    if outcome.queued:
        return QUEUED
    if getattr(outcome, "leaf_id", None):
        # A leaf id came back, so the request was delivered and processed.
        return DELIVERED_NOT_WITNESSED
    if outcome.error:
        return REJECTED
    return DELIVERED_NOT_WITNESSED


def from_outcome(
    outcome,
    *,
    kind: str,
    mime: Optional[str],
    content_hash: Optional[str] = None,
    filename: Optional[str] = None,
    client_workflow_hash: Optional[str] = None,
    state: Optional[str] = None,
    queue_depth_after: int = 0,
) -> LeafAssurance:
    """Build the record from what the witness call returned, and nothing
    else. Every field the server did not send stays at its NOT_DISCLOSED
    default -- there is no place in this function that fills a gap with a
    plausible value."""
    return LeafAssurance(
        state=state or state_for(outcome),
        kind=kind,
        mime=mime,
        content_hash=content_hash,
        leaf_id=outcome.leaf_id,
        leaf_hash=outcome.leaf_hash,
        leaf_scheme=outcome.leaf_scheme,
        baseline_ref=outcome.baseline_ref,
        filename=filename,
        error=outcome.error,
        canonicalization=CanonicalizationRecord(client_workflow_hash=client_workflow_hash),
        queue_depth_after=queue_depth_after,
    )


def refused(reason: str, *, kind: str = "", mime: Optional[str] = None) -> LeafAssurance:
    return LeafAssurance(state=REFUSED_LOCALLY, kind=kind, mime=mime, error=reason)


def with_receipt(rec: LeafAssurance, receipt: Dict[str, Any]) -> LeafAssurance:
    """Fold in GET /api/v2/receipt/{leaf_id}.

    The receipt carries the attestation status and nothing else this
    record does not already have -- notably NOT the signature triple and
    NOT the canonicalization profile. Fields absent from the receipt are
    left absent here rather than defaulted.
    """
    from dataclasses import replace

    att = receipt.get("attestation")
    status = att.get("status") if isinstance(att, dict) else None

    sig = rec.signature
    if any(k in receipt for k in ("leaf_signature", "leaf_signer_key_id", "leaf_signature_alg")):
        # Not reachable against today's server. Written anyway so that the
        # day the route carries the field, this client reads it instead of
        # needing a change -- and so a test can drive the path.
        sig = SignatureRecord(
            leaf_signature=receipt.get("leaf_signature"),
            leaf_signer_key_id=receipt.get("leaf_signer_key_id"),
            leaf_signature_alg=receipt.get("leaf_signature_alg"),
            signer_surrogate=receipt.get("leaf_signer_surrogate"),
            source=FROM_RECEIPT,
        )

    canon = rec.canonicalization
    if receipt.get("canonicalization_profile") is not None:
        from dataclasses import replace as _replace
        canon = _replace(
            canon,
            server=receipt["canonicalization_profile"],
            source=FROM_RECEIPT,
        )

    return replace(
        rec,
        signature=sig,
        canonicalization=canon,
        attestation_status=status,
        attestation_source=FROM_RECEIPT if att is not None or "attestation" in receipt else rec.attestation_source,
        leaf_hash=receipt.get("leaf_hash", rec.leaf_hash),
        content_hash=receipt.get("content_hash", rec.content_hash),
        mime=receipt.get("mime", rec.mime),
        leaf_scheme=receipt.get("leaf_scheme", rec.leaf_scheme),
        baseline_ref=receipt.get("baseline_ref", rec.baseline_ref),
    )


def with_verification(rec: LeafAssurance, verify: Dict[str, Any]) -> LeafAssurance:
    """Fold in GET /api/v2/verify/{content_hash}.

    `independently_verifiable_claimed` is exactly what the server said.
    `independently_verifiable_checked` is NOT set here and cannot be: this
    client holds no leaf signature and no verifying key, so it has checked
    nothing. Keeping the two apart is the whole point -- the server's claim
    has been observed to be true for a leaf that carries no asymmetric
    signature at all.
    """
    from dataclasses import replace

    basis = verify.get("verification_basis")
    return replace(
        rec,
        independently_verifiable_claimed=verify.get("independently_verifiable"),
        verification_basis_kind=basis.get("kind") if isinstance(basis, dict) else None,
        independently_verifiable_checked=False,
    )
