"""The vendor's own signing key, through the CVM surrogate.

WHOSE KEY THIS IS, because it decides whether the example is honest.

At `server-library`, P3 is "ordinary secret management" — and the thing
being managed is the vendor's signing key, in the vendor's own vault, in the
vendor's own backend. That is why the DSSE envelope is signed HERE and not
by Scruple: the predicate is the VENDOR'S declaration about the VENDOR'S
configuration, and a declaration signed by the party it is about is the only
version of it that means anything.

`services/cvm-surrogate/` stands in for that vault. Its README frames it as
a wire-compatible stand-in for OCI KMS Crypto Sign, which is exactly the
shape a vendor's real key custody has, and its signatures are real ECDSA
P-256 over a real key — what is absent is any hardware that protected it.
That absence is why this configuration's attestation outcome is `none` and
its leaf is `passthrough`, and the demo says so rather than letting the
presence of a signature imply more.

The ratchet MAC is a different seal with a different scope: it says which
component and which counter, and it is what the witness verifies. The DSSE
signature says what the vendor asserts about its own posture, and it is what
a third party checks. Two seals, two scopes; see `server_library.py`.
"""

from __future__ import annotations

import base64
import json
import urllib.request
from typing import Optional, Tuple

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, utils

from scruple_host_sdk.envelope import EnvelopeSigner, EnvelopeVerifier

DEFAULT_ENDPOINT = "http://127.0.0.1:8799"
KEY_OCID = "ocid1.key.oc1.us-surrogate-1.surrogate.aaaaaaaaSURROGATEKEYnotarealkey"


def _post(endpoint: str, path: str, payload: dict) -> dict:
    req = urllib.request.Request(
        endpoint.rstrip("/") + path,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read())


def health(endpoint: str = DEFAULT_ENDPOINT) -> Optional[dict]:
    try:
        with urllib.request.urlopen(endpoint.rstrip("/") + "/health", timeout=2) as r:
            return json.loads(r.read())
    except Exception:
        return None


def signer(endpoint: str = DEFAULT_ENDPOINT, keyid: str = "vendor-acme-kms") -> EnvelopeSigner:
    """Signs PAE BYTES — deliberately not "signs a payload".

    A signer that took a payload could be handed one without its type,
    which is the confusion PAE exists to prevent. The digest is computed
    here and sent as messageType DIGEST, which is what a real KMS wants for
    anything larger than a few kilobytes.
    """

    def _sign(pae_bytes: bytes) -> bytes:
        digest = hashes.Hash(hashes.SHA256())
        digest.update(pae_bytes)
        res = _post(
            endpoint,
            "/20180608/sign",
            {
                "keyId": KEY_OCID,
                "message": base64.b64encode(digest.finalize()).decode(),
                "messageType": "DIGEST",
                "signingAlgorithm": "ECDSA_SHA_256",
            },
        )
        # OCI returns base64 of a DER-encoded ECDSA signature. DSSE does not
        # specify an encoding, so it rides as the KMS produced it and the
        # verifier below decodes the same way.
        return base64.b64decode(res["signature"])

    return EnvelopeSigner(keyid=keyid, sign=_sign)


def verifier(endpoint: str = DEFAULT_ENDPOINT, keyid: str = "vendor-acme-kms") -> EnvelopeVerifier:
    """A third party's view: fetch the public key and check the envelope.

    Fetched over the network rather than passed in from the signer, so the
    demo's verification step shares nothing with its signing step except
    the bytes. A verifier that borrowed the signer's key object would prove
    that an object agrees with itself.
    """
    with urllib.request.urlopen(endpoint.rstrip("/") + "/testnet/pubkey.pem", timeout=10) as r:
        public_key = serialization.load_pem_public_key(r.read())

    def _verify(pae_bytes: bytes, sig: bytes) -> bool:
        try:
            public_key.verify(sig, pae_bytes, ec.ECDSA(hashes.SHA256()))
            return True
        except Exception:
            return False

    return EnvelopeVerifier(keyid=keyid, verify=_verify)
