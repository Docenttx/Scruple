"""WO-B6 — the seal, read and then CHECKED, with the controls.

Every must-fire assertion here is paired with a must-NOT-fire control,
because the thing being tested is a verifier, and a verifier that cannot
fail is not one. The signatures are real ECDSA P-256, produced in the
test over a real leaf hash, so a bug in the check is a failing test and
not a mocked `True`.

The three states that must stay apart, and the control that keeps each
apart from the next:

  checked_ok True   verified here, against the published key
  checked_ok False  tested here and REJECTED -- tampering, or the wrong key
  checked_ok None   not tested. The key server was unreachable, or the
                    receipt published no address. An outage must never be
                    reported as a bad signature: that accuses the leaf for
                    a fault in the network.
"""

import base64
import os
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
for p in (ROOT, os.path.join(ROOT, "vendor")):
    if p not in sys.path:
        sys.path.insert(0, p)

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec

from adapter import assurance as _a

LEAF_HASH = "4eb771c2e78c35f67432ddafcb0b4a4ddcf73749def64a23af08e0de10a327ba"
SURROGATE_OCID = "ocid1.key.oc1.us-surrogate-1.surrogate.aaaaaaaaSURROGATEKEYnotarealkey"


@pytest.fixture(scope="module")
def keypair():
    key = ec.generate_private_key(ec.SECP256R1())
    pem = key.public_key().public_bytes(
        serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo
    )
    return key, pem


def sign(key, leaf_hash=LEAF_HASH):
    """Exactly what the KMS does: sign the 32 RAW bytes, not their hex."""
    return base64.b64encode(key.sign(bytes.fromhex(leaf_hash), ec.ECDSA(hashes.SHA256()))).decode()


VERIFICATION = {
    "signed_over": "leaf_hash",
    "message": f"the 32 raw bytes of leaf_hash {LEAF_HASH} (hex-decoded)",
    "message_type": "RAW",
    "signature_encoding": "base64(DER(ECDSA))",
    "public_key_url": "http://key-server.invalid/api/signer/pubkey",
    "public_key_path": "/api/signer/pubkey",
}


def receipt(signature, **overrides):
    """A receipt in the shape lib/leaf/signatureDisclosure.ts emits."""
    sig = {
        "state": "signed",
        "leaf_signature": signature,
        "leaf_signer_key_id": SURROGATE_OCID,
        "leaf_signature_alg": "ECDSA_SHA_256",
        "leaf_signer_surrogate": True,
        "key_protection": "software",
        "independently_verifiable": True,
        "verification": dict(VERIFICATION),
        "note": "Signed by the CVM surrogate.",
    }
    sig.update(overrides)
    return {
        "leaf_id": "47",
        "leaf_hash": LEAF_HASH,
        "content_hash": "6b" * 32,
        "mime": "image/png",
        "witnessed": True,
        "attestation": None,
        "signature": sig,
        "independently_verifiable": sig.get("independently_verifiable"),
        "canonicalization_profile": "jcs-2",
    }


def witnessed():
    return _a.LeafAssurance(
        state=_a.WITNESSED, kind="artifact", mime="image/png", leaf_id="47", leaf_hash=LEAF_HASH
    )


# ── 1. the disclosure is READ ────────────────────────────────────────────

def test_the_nested_disclosure_is_read(keypair):
    key, _ = keypair
    rec = _a.with_receipt(witnessed(), receipt(sign(key)))
    assert rec.signature.present
    assert rec.signature.source == _a.FROM_RECEIPT
    assert rec.signature.state == "signed"
    assert rec.signature.key_protection == "software"
    assert rec.signature.signer_surrogate is True
    assert rec.signature.leaf_signature_alg == "ECDSA_SHA_256"
    # The tier that made this WO necessary: before the nested reader this
    # said `undisclosed` while the receipt in the same call said `signed`.
    assert rec.assurance_tier == "passthrough (software-signed)"


def test_CONTROL_a_receipt_that_discloses_nothing_stays_undisclosed():
    """MUST NOT FIRE. A pre-S1 server sends no `signature` key at all, and
    the reader must not manufacture one -- `undisclosed` is the honest
    answer and it has to remain reachable, or the field means nothing."""
    bare = {"leaf_id": "9", "leaf_hash": LEAF_HASH, "witnessed": True, "attestation": None}
    rec = _a.with_receipt(witnessed(), bare)
    assert not rec.signature.present
    assert rec.signature.source == _a.NOT_DISCLOSED
    assert rec.signature.state is None
    assert rec.assurance_tier == "undisclosed"


def test_CONTROL_unsigned_is_not_undisclosed_and_not_passthrough():
    """MUST NOT FIRE. `unsigned` means the witness answered and held none.
    Reporting it as `passthrough` claims evidence that does not exist;
    reporting it as `undisclosed` claims nobody answered."""
    r = receipt(None, state="unsigned", leaf_signature=None, key_protection="unknown",
                leaf_signer_surrogate=None, independently_verifiable=False, verification=None)
    rec = _a.with_receipt(witnessed(), r)
    assert rec.assurance_tier == "unsigned (Scruple audit record only)"
    assert rec.assurance_tier != "passthrough"
    assert rec.assurance_tier != "undisclosed"


def test_CONTROL_the_flat_pre_S1_shape_still_reads():
    """A deployment on the pre-S1 build is still a deployment."""
    flat = {"leaf_hash": LEAF_HASH, "leaf_signature": "AAAA", "leaf_signer_key_id": SURROGATE_OCID,
            "leaf_signature_alg": "ECDSA_SHA_256", "leaf_signer_surrogate": True}
    rec = _a.with_receipt(witnessed(), flat)
    assert rec.signature.present and rec.signature.source == _a.FROM_RECEIPT


# ── 2. the signature is CHECKED ──────────────────────────────────────────

def test_a_good_signature_verifies_here(keypair):
    key, pem = keypair
    rec = _a.with_receipt(witnessed(), receipt(sign(key)))
    rec = _a.check_signature(rec, fetch_key=lambda url: pem)
    assert rec.signature.checked_ok is True
    assert rec.signature.check_note is None
    assert rec.independently_verifiable_checked is True
    assert "checked by this client" in rec.signature.explanation


def test_CONTROL_a_tampered_signature_is_REJECTED(keypair):
    """MUST FIRE THE OTHER WAY. One byte of the DER, flipped."""
    key, pem = keypair
    good = base64.b64decode(sign(key))
    bad = bytearray(good)
    bad[-1] ^= 0x01
    rec = _a.with_receipt(witnessed(), receipt(base64.b64encode(bytes(bad)).decode()))
    rec = _a.check_signature(rec, fetch_key=lambda url: pem)
    assert rec.signature.checked_ok is False
    assert rec.independently_verifiable_checked is False
    assert rec.assurance_tier == "SIGNATURE DID NOT VERIFY"


def test_CONTROL_a_signature_over_a_DIFFERENT_leaf_is_REJECTED(keypair):
    """The signature is real and the key is right; it is over other bytes.
    A check that passed this would be checking that base64 decodes."""
    key, pem = keypair
    other = "00" * 32
    rec = _a.with_receipt(witnessed(), receipt(sign(key, leaf_hash=other)))
    rec = _a.check_signature(rec, fetch_key=lambda url: pem)
    assert rec.signature.checked_ok is False


def test_CONTROL_the_wrong_key_is_REJECTED(keypair):
    key, _ = keypair
    other_pem = ec.generate_private_key(ec.SECP256R1()).public_key().public_bytes(
        serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo
    )
    rec = _a.with_receipt(witnessed(), receipt(sign(key)))
    rec = _a.check_signature(rec, fetch_key=lambda url: other_pem)
    assert rec.signature.checked_ok is False


def test_CONTROL_hex_spelling_would_not_verify(keypair):
    """The distinction the receipt's instructions exist to state: a signer
    that signed the 64-character hex STRING produces a signature this
    check rejects. If both passed, the check is not reading the message."""
    key, pem = keypair
    over_hex = base64.b64encode(
        key.sign(LEAF_HASH.encode("ascii"), ec.ECDSA(hashes.SHA256()))
    ).decode()
    rec = _a.check_signature(_a.with_receipt(witnessed(), receipt(over_hex)), fetch_key=lambda u: pem)
    assert rec.signature.checked_ok is False


# ── 3. the reasons a check does NOT run ──────────────────────────────────

def test_CONTROL_no_published_key_address_means_not_checked_not_failed(keypair):
    """MUST NOT FIRE. `public_key_url` is null unless the deployment sets
    SCRUPLE_WITNESS_PUBLIC_URL. That is a deployment gap, not a bad leaf,
    and the tier must not move."""
    key, pem = keypair
    v = dict(VERIFICATION, public_key_url=None)
    rec = _a.with_receipt(witnessed(), receipt(sign(key), verification=v))
    rec = _a.check_signature(rec, fetch_key=lambda url: pem)
    assert rec.signature.checked_ok is None
    assert rec.signature.check_note == _a.NO_KEY_ADDRESS
    assert rec.independently_verifiable_checked is False
    assert rec.assurance_tier == "passthrough (software-signed)"


def test_CONTROL_an_unreachable_key_server_does_not_accuse_the_leaf(keypair):
    """MUST NOT FIRE. checked_ok stays None. A network fault reported as
    `SIGNATURE DID NOT VERIFY` is an accusation of tampering."""
    key, _ = keypair

    def boom(url):
        raise OSError("connection refused")

    rec = _a.check_signature(_a.with_receipt(witnessed(), receipt(sign(key))), fetch_key=boom)
    assert rec.signature.checked_ok is None
    assert "could not run" in rec.signature.check_note
    assert rec.assurance_tier != "SIGNATURE DID NOT VERIFY"


def test_CONTROL_an_unrecognised_scheme_is_not_checked(keypair):
    """The client will not invent what was signed over."""
    key, pem = keypair
    v = dict(VERIFICATION, signed_over="content_hash")
    rec = _a.with_receipt(witnessed(), receipt(sign(key), verification=v))
    rec = _a.check_signature(rec, fetch_key=lambda url: pem)
    assert rec.signature.checked_ok is None
    assert rec.signature.check_note == _a.UNSUPPORTED_SCHEME


def test_CONTROL_verification_claim_does_not_erase_the_clients_verdict(keypair):
    """/api/v2/verify has been observed claiming independent verifiability
    for a leaf with no asymmetric signature. Folding its claim in must not
    overwrite a check this client actually ran -- in either direction."""
    key, pem = keypair
    rec = _a.check_signature(_a.with_receipt(witnessed(), receipt(sign(key))), fetch_key=lambda u: pem)
    assert rec.independently_verifiable_checked is True
    rec = _a.with_verification(rec, {"independently_verifiable": False, "verification_basis": {"kind": "hmac"}})
    assert rec.independently_verifiable_claimed is False
    assert rec.independently_verifiable_checked is True, "the server's claim overwrote our check"


# ── 4. the SDK is the only thing that opens the socket ───────────────────

def test_the_key_fetch_refuses_a_file_url():
    """`public_key_url` is a server-supplied string. Over file:// it is a
    local file read chosen by the server."""
    from scruple_host_sdk import http as _http
    from scruple_host_sdk.errors import ScrupleTransportError

    class Session:
        opener = None
        timeout = 5

    # ASSERTED ON THE MESSAGE, NOT THE TYPE, and a mutation is why. With the
    # scheme guard removed, `urlopen` opens the file quite happily, returns a
    # response whose `getcode()` is None, and the `!= 200` branch below raises
    # the SAME exception class -- so a `pytest.raises(ScrupleTransportError)`
    # alone stayed green while the client read /etc/passwd on the way past.
    with pytest.raises(ScrupleTransportError) as e:
        _http.fetch_published_key(Session(), "file:///etc/passwd")
    assert "refusing to fetch" in str(e.value), str(e.value)
    assert "file" in str(e.value)


def test_the_key_fetch_sends_no_api_key():
    """The key server is a different host. Forwarding the tenant
    credential to an absolute URL out of a response body is leakage."""
    from scruple_host_sdk import http as _http

    seen = {}

    class Opener:
        def urlopen(self, req, timeout=None):
            seen["headers"] = dict(req.headers)

            class R:
                def getcode(self):
                    return 200

                def read(self):
                    return b"PEM"

                def __enter__(self):
                    return self

                def __exit__(self, *a):
                    return False

            return R()

    class Session:
        opener = Opener()
        timeout = 5
        api_key = "scr_secret_do_not_leak"

    assert _http.fetch_published_key(Session(), "http://witness.invalid/api/signer/pubkey") == b"PEM"
    joined = " ".join(f"{k}: {v}" for k, v in seen["headers"].items())
    assert "scr_secret_do_not_leak" not in joined, joined
    assert "Authorization" not in seen["headers"] and "Authorization".lower() not in seen["headers"]
