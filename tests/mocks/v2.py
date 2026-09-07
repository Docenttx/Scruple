"""Route table for the /api/v2 surface, as the addon exercises it.

One place that knows the shape of a v2 response, so a test that cares
about a single field does not have to restate the other six. Every
response body here is keyed the way `app/api/v2/*/route.ts` keys it --
snake_case, `witnessed` as an explicit boolean, `outstanding` as a list
of {modality, reason} -- because the SDK reads those names out by name
and a mock that used the v1 spellings would let a regression through.

WO-B3: THIS MOCK USED TO BE MORE GENEROUS THAN THE SERVER, AND THAT IS
HOW THE ADDON SHIPPED A `kind` NO ROUTE ACCEPTS.

Two corrections, both measured against the scratch app on 2026-09-07
rather than read off the route source:

  1. `kind` is a CLOSED enum. `_witness` now refuses anything outside
     `LEAF_KINDS` with a 400 body shaped like `v2Error('invalid_body')`,
     exactly as the route does. Before this, the mock accepted 'render',
     'save' and 'export' -- none of which the real route accepts -- so
     176 green tests were compatible with an addon that could not
     witness anything.

         kind=render        -> invalid_body      kind=document_save -> OK
         kind=save          -> invalid_body      kind=artifact      -> OK
         kind=export        -> invalid_body

  2. The witness response carries NO `canonicalization_profile` and NO
     signature fields. The old mock returned `canonicalization_profile:
     'jcs-2'`; the real route does not, and neither does
     /api/v2/receipt. A mock that invents a field is a mock that hides
     the absence the client has to be honest about.

`register_v2_disclosing()` is the opposite case, kept separate: a
hypothetical server that DOES return the H-1 triple and the profile. It
exercises the addon's read path so that code is tested rather than
merely written, and its separateness is the point -- the default mock
must keep telling the truth about today's server.
"""

from __future__ import annotations

import hashlib
from typing import Any, Dict, List, Optional

from . import http_mock as _http_mock

BASELINE_REF = "bl_" + "a" * 24

#: The closed `kind` enum, copied from app/api/v2/witness/route.ts:110 and
#: confirmed against the live scratch app on 2026-09-07.
LEAF_KINDS = ("document_save", "artifact", "graph_execute", "model_write")

#: What the SERVER stamps into iterations.canonicalization_profile
#: (lib/leaf/canonicalJson.ts:104). Deliberately NOT equal to
#: scruple_api.canonical.CANONICALIZATION_PROFILE, which is 'jcs-1' -- the
#: divergence is real and a mock that hid it would hide the finding.
SERVER_CANONICALIZATION_PROFILE = "jcs-2"

#: An H-1 triple as the WITNESS SERVER produces it -- the shape observed in
#: the scratch witness DB on 2026-09-07, surrogate flag included. No v2
#: route returns this today; `register_v2(discloses_signature=True)` is a
#: hypothetical server, used to prove the addon's read path works.
SURROGATE_SIGNATURE = {
    "leaf_signature": "MEYCIQDCzSNc2VOY5wvyWnksnBR9B1ZFWVLo1DOrEXAMPLEONLY",
    "leaf_signer_key_id": "ocid1.key.oc1.us-surrogate-1.surrogate.aaaaaaaaSURROGATEKEYnotarealkey",
    "leaf_signature_alg": "ECDSA_SHA_256",
    "leaf_signer_surrogate": True,
}


#: Re-exported so a v2 route can refuse without importing http_mock. ONE
#: class, not two -- the opener catches `http_mock.Rejected` by identity.
Rejected = _http_mock.Rejected


def register_v2(
    opener,
    *,
    baseline_exists: bool = False,
    witnessed: bool = True,
    modalities_available: Optional[List[str]] = None,
    modalities_applied: Optional[List[str]] = None,
    outstanding: Optional[List[Dict[str, str]]] = None,
    discloses_signature: bool = False,
    independently_verifiable: bool = True,
) -> None:
    """Register the routes a witness+mark round trip needs.

    `baseline_exists=False` makes GET /baseline/current 404, which is
    what drives attach() down its POST /baseline branch.
    """
    if baseline_exists:
        opener.register("GET", "/api/v2/baseline/current", {"baseline_ref": BASELINE_REF})
    opener.register("POST", "/api/v2/baseline", {"baseline_ref": BASELINE_REF})
    opener.register("POST", "/api/v2/baseline/rebaseline", {"baseline_ref": BASELINE_REF})

    leaves: Dict[str, Dict[str, Any]] = {}

    def _witness(body: Dict[str, Any]) -> Dict[str, Any]:
        # The closed enum, enforced as the route enforces it. A mock that
        # accepted Blender's own words is what let the addon ship with
        # kind='render'.
        if body.get("kind") not in LEAF_KINDS:
            raise Rejected(400, {
                "error": {
                    "code": "invalid_body",
                    "message": "Witness request did not validate.",
                },
            })
        leaf_id = "leaf_" + hashlib.sha256(
            (body.get("content_hash", "") + body.get("kind", "")).encode()
        ).hexdigest()[:16]
        # Echoed the way the route echoes them (route.ts:560-583). Note
        # what is NOT here: no leaf_signature, no leaf_signer_key_id, no
        # leaf_signature_alg, no canonicalization_profile. The witness
        # server produces the first three and the app tier drops them; the
        # profile is stored on the row and returned by nothing.
        resp = {
            "leaf_id": leaf_id,
            "leaf_hash": hashlib.sha256(leaf_id.encode()).hexdigest(),
            "witnessed": witnessed,
            "leaf_scheme": "v2",
            "run_sequence": len(leaves) + 1,
            "baseline_ref": body.get("baseline_ref"),
            "attestation": None,
            "workflow_hash": (
                hashlib.sha256(repr(sorted(body["graph"].items())).encode()).hexdigest()
                if isinstance(body.get("graph"), dict) else None
            ),
            "machine_manifest_hash": body.get("machine_manifest_hash"),
            "mime": body.get("mime"),
            "mime_declared": bool(body.get("mime")),
            "component": None,
            "component_verified": False,
            "seal": {"deployment_id": None, "state": "undeclared", "seal_ref": None,
                     "claims_standard": False},
        }
        leaves[leaf_id] = {
            "leaf_id": leaf_id,
            "leaf_hash": resp["leaf_hash"],
            "content_hash": body.get("content_hash"),
            "mime": body.get("mime"),
            "witnessed": witnessed,
            "leaf_scheme": "v2",
            "baseline_ref": body.get("baseline_ref"),
            "witnessed_at": "2026-09-07T00:00:00.000Z",
            "modalities_requested": [],
            "modalities_applied": [],
            "outstanding": [],
            "attestation": None,
            "continuity": None,
        }
        return resp

    opener.register("POST", "/api/v2/witness", _witness)

    def _receipt(_body, *, path: str = "") -> Dict[str, Any]:
        leaf_id = path.rsplit("/", 1)[-1]
        receipt = dict(leaves.get(leaf_id) or {})
        if not receipt:
            raise Rejected(404, {"error": {"code": "not_found", "message": "No receipt."}})
        if discloses_signature:
            receipt.update(SURROGATE_SIGNATURE)
            receipt["canonicalization_profile"] = SERVER_CANONICALIZATION_PROFILE
        return receipt

    opener.register_prefix("GET", "/api/v2/receipt/", _receipt)

    def _verify(_body, *, path: str = "") -> Dict[str, Any]:
        content_hash = path.rsplit("/", 1)[-1]
        match = next((v for v in leaves.values() if v["content_hash"] == content_hash), None)
        if match is None:
            # The route's own words for a hash it has never seen. Note it
            # is a 200, not a 404: "not on our record" is an answer, not
            # an error.
            return {
                "found": False,
                "witnessed": False,
                "note": ("This content hash is not on Scruple's record. That means "
                         "Scruple did not witness it; it says nothing about the file itself."),
            }
        return {
            "found": True,
            "witnessed": match["witnessed"],
            # As on the real server this is derived from a signature the
            # CLIENT never sees. The mock reproduces the shape, not the
            # justification -- see test_assurance.py for what the addon is
            # required to do with it.
            "independently_verifiable": independently_verifiable,
            "leaf": {
                "leaf_id": match["leaf_id"],
                "leaf_hash": match["leaf_hash"],
                "leaf_scheme": "v2",
                "baseline_ref": match["baseline_ref"],
                "witnessed_at": match["witnessed_at"],
            },
            "verification_basis": {
                "kind": "asymmetric_leaf_signature" if independently_verifiable else "scruple_record",
                "independently_verifiable": independently_verifiable,
                "algorithm": "ECDSA_SHA_256" if independently_verifiable else None,
            },
            "receipt_url": f"/api/v2/receipt/{match['leaf_id']}",
        }

    opener.register_prefix("GET", "/api/v2/verify/", _verify)

    caps = modalities_available if modalities_available is not None else ["c2pa", "watermark", "chain", "local"]
    opener.register(
        "GET",
        "/api/v2/capabilities",
        {"modalities": [
            {"modality": m, "available": True, "reason": "", "price_cents": 5000}
            for m in caps
        ]},
    )

    def _mark(body: Dict[str, Any]) -> Dict[str, Any]:
        requested = list(body.get("modalities") or [])
        applied = modalities_applied if modalities_applied is not None else requested
        out = outstanding if outstanding is not None else [
            {"modality": m, "reason": "not performed"} for m in requested if m not in applied
        ]
        return {
            "leaf_id": body.get("leaf_id"),
            "modalities_requested": requested,
            "modalities_applied": applied,
            "outstanding": out,
            "local_lock": {"scr_id": "SCR_local", "merkle_root": "a" * 64},
            "witnessed": True,
        }

    opener.register("POST", "/api/v2/mark", _mark)


def register_stripe(opener, *, payment_intent_id: str = "pi_ok", status: str = "succeeded") -> None:
    """The v1 stripe routes the SDK's payment.py still points at. They are
    v1 on purpose: /v2 exposes no route that creates a PaymentIntent, and
    the ones that exist authenticate with a session cookie, not a bearer
    key. See scruple_host_sdk/payment.py's header."""
    opener.register("GET", "/api/stripe/config", {
        "payment_method": {"brand": "Visa", "last4": "4242"},
        "prices": {
            "checkpoint": 500, "finalize": 1000,
            "chain-lock-basic": 5000, "chain-lock-pinned": 10000,
        },
    })
    opener.register("POST", "/api/stripe/payment-intent", {
        "paymentIntentId": payment_intent_id, "status": status,
    })


def register_v2_disclosing(opener, **kwargs) -> None:
    """A server that returns the H-1 triple and the canonicalization
    profile on its receipt. No such server exists -- /api/v2/receipt
    returns neither, measured 2026-09-07 -- and that is precisely why
    this is a separate function rather than the default: the addon's
    read path has to be exercised, and the default mock has to keep
    telling the truth about what today's server sends."""
    kwargs.setdefault("discloses_signature", True)
    register_v2(opener, **kwargs)
