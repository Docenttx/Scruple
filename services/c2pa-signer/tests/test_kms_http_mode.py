"""WO-B6 — the kms-http signing mode, and the two honesty properties it must
not break.

The mode exists because there was no way to produce a C2PA credential whose
key this process does not hold: real Vault mode needs draft-cavage
instance-principal credentials, and services/cvm-surrogate speaks the KMS
Sign wire without them. The witness server's leaf_signer.js has had exactly
this mode since H-1; this is the same thing for the C2PA signer.

Two properties are load-bearing and both are asserted here:

  1. `signing_mode()` NEVER returns 'vault' for kms-http. sign.py prints this
     string into its result and the route folds it into a canonical payload
     whose sha256 becomes a witness leaf, so a wrong value is a false claim
     about key custody committed into an append-only record.

  2. kms-http does NOT satisfy `_is_production_signer()`. If it did,
     `runtime_assertion()` would stamp the LOCAL host's instance OCID into a
     signed C2PA manifest as the signing runtime -- a false claim about the
     signing environment, signed, inside a credential third parties verify.
     Observed during WO-B6 before the fix: the age guard read this app-tier
     VM's IMDS, found it 156 days old, and refused to sign.
"""

import base64
import importlib
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature

HERE = Path(__file__).resolve().parent.parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

SURROGATE_OCID = "ocid1.key.oc1.us-surrogate-1.surrogate.aaaaaaaaSURROGATEKEYnotarealkey"
REAL_OCID = "ocid1.key.oc1.us-ashburn-1.aaaaaaaarealproductionkey"


@pytest.fixture
def clean_env(monkeypatch):
    for k in ("SCRUPLE_C2PA_VAULT_KEY_OCID", "SCRUPLE_C2PA_KMS_ENDPOINT",
              "SCRUPLE_C2PA_VAULT_CRYPTO_ENDPOINT", "SCRUPLE_C2PA_FORCE_DEV"):
        monkeypatch.delenv(k, raising=False)
    import vault_sign
    importlib.reload(vault_sign)
    return vault_sign


def test_mode_dispatch(clean_env, monkeypatch):
    vs = clean_env
    assert vs.signing_mode() == "local"
    monkeypatch.setenv("SCRUPLE_C2PA_VAULT_KEY_OCID", REAL_OCID)
    assert vs.signing_mode() == "vault"
    monkeypatch.setenv("SCRUPLE_C2PA_KMS_ENDPOINT", "http://127.0.0.1:8799")
    assert vs.signing_mode() == "kms-http"


def test_CONTROL_kms_http_is_never_reported_as_vault(clean_env, monkeypatch):
    """MUST NOT FIRE. An unauthenticated HTTP call to a software surrogate
    reported as `vault` is a false custody claim in an append-only record."""
    vs = clean_env
    monkeypatch.setenv("SCRUPLE_C2PA_VAULT_KEY_OCID", SURROGATE_OCID)
    monkeypatch.setenv("SCRUPLE_C2PA_KMS_ENDPOINT", "http://127.0.0.1:8799")
    assert vs.signing_mode() != "vault"
    identity = vs.signer_identity()
    assert identity.startswith("kms-http:")
    assert "surrogate=true" in identity
    assert "vault:" not in identity


def test_a_non_surrogate_ocid_is_not_flagged_as_one(clean_env, monkeypatch):
    """The flag must be about the key, not about the mode."""
    vs = clean_env
    monkeypatch.setenv("SCRUPLE_C2PA_VAULT_KEY_OCID", REAL_OCID)
    monkeypatch.setenv("SCRUPLE_C2PA_KMS_ENDPOINT", "http://127.0.0.1:8799")
    assert "surrogate=false" in vs.signer_identity()
    assert vs.is_surrogate_key(SURROGATE_OCID) is True
    assert vs.is_surrogate_key(REAL_OCID) is False


def test_kms_http_is_not_a_production_signer(monkeypatch):
    monkeypatch.delenv("SCRUPLE_C2PA_FORCE_DEV", raising=False)
    import signer_runtime
    importlib.reload(signer_runtime)
    monkeypatch.setenv("SCRUPLE_C2PA_VAULT_KEY_OCID", SURROGATE_OCID)
    monkeypatch.setenv("SCRUPLE_C2PA_KMS_ENDPOINT", "http://127.0.0.1:8799")
    # False unless this host really is a CVM -- signal 2 still decides.
    assert signer_runtime._is_production_signer() == os.path.exists("/dev/sev-guest")


def test_CONTROL_real_vault_mode_is_still_a_production_signer(monkeypatch):
    """MUST NOT FIRE. The fix must narrow kms-http and nothing else: a
    deployment on the real Signer CVM keeps its age guard and its runtime
    assertion."""
    monkeypatch.delenv("SCRUPLE_C2PA_FORCE_DEV", raising=False)
    monkeypatch.delenv("SCRUPLE_C2PA_KMS_ENDPOINT", raising=False)
    import signer_runtime
    importlib.reload(signer_runtime)
    monkeypatch.setenv("SCRUPLE_C2PA_VAULT_KEY_OCID", REAL_OCID)
    assert signer_runtime._is_production_signer() is True


class _KMS(BaseHTTPRequestHandler):
    key = None
    seen = []

    def log_message(self, *a):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        _KMS.seen.append(body)
        msg = base64.b64decode(body["message"])
        if body["messageType"] == "RAW":
            der = _KMS.key.sign(msg, ec.ECDSA(hashes.SHA256()))
        else:
            from cryptography.hazmat.primitives.asymmetric.utils import Prehashed
            der = _KMS.key.sign(msg, ec.ECDSA(Prehashed(hashes.SHA256())))
        out = json.dumps({"signature": base64.b64encode(der).decode(),
                          "keyId": body["keyId"],
                          "signingAlgorithm": body["signingAlgorithm"]}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)


@pytest.fixture
def kms_server():
    _KMS.key = ec.generate_private_key(ec.SECP256R1())
    _KMS.seen = []
    srv = HTTPServer(("127.0.0.1", 0), _KMS)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_address[1]}", _KMS.key.public_key()
    srv.shutdown()


def test_the_signature_is_real_and_over_the_bytes_it_was_given(clean_env, monkeypatch, kms_server):
    url, pub = kms_server
    vs = clean_env
    monkeypatch.setenv("SCRUPLE_C2PA_VAULT_KEY_OCID", SURROGATE_OCID)
    monkeypatch.setenv("SCRUPLE_C2PA_KMS_ENDPOINT", url)

    data = b"the bytes c2pa-rs hands the callback"
    raw = vs.vault_sign_es256(data)
    assert len(raw) == 64, "c2pa-python expects RFC 8152 raw R||S, 64 bytes"
    der = encode_dss_signature(int.from_bytes(raw[:32], "big"), int.from_bytes(raw[32:], "big"))
    pub.verify(der, data, ec.ECDSA(hashes.SHA256()))

    assert _KMS.seen[0]["messageType"] == "RAW"
    assert _KMS.seen[0]["signingAlgorithm"] == "ECDSA_SHA_256"


def test_CONTROL_a_signature_over_other_bytes_does_not_verify(clean_env, monkeypatch, kms_server):
    """MUST FIRE THE OTHER WAY, or the test above is checking that 64 bytes
    came back."""
    url, pub = kms_server
    vs = clean_env
    monkeypatch.setenv("SCRUPLE_C2PA_VAULT_KEY_OCID", SURROGATE_OCID)
    monkeypatch.setenv("SCRUPLE_C2PA_KMS_ENDPOINT", url)
    raw = vs.vault_sign_es256(b"one thing")
    der = encode_dss_signature(int.from_bytes(raw[:32], "big"), int.from_bytes(raw[32:], "big"))
    from cryptography.exceptions import InvalidSignature
    with pytest.raises(InvalidSignature):
        pub.verify(der, b"a different thing", ec.ECDSA(hashes.SHA256()))


def test_over_the_RAW_limit_it_switches_to_DIGEST(clean_env, monkeypatch, kms_server):
    """OCI refuses RAW past 4096 bytes. The same signature over the same
    bytes either way -- and c2pa payloads with a thumbnail exceed it."""
    url, pub = kms_server
    vs = clean_env
    monkeypatch.setenv("SCRUPLE_C2PA_VAULT_KEY_OCID", SURROGATE_OCID)
    monkeypatch.setenv("SCRUPLE_C2PA_KMS_ENDPOINT", url)

    big = b"x" * (vs._KMS_RAW_MAX_BYTES + 1)
    raw = vs.vault_sign_es256(big)
    der = encode_dss_signature(int.from_bytes(raw[:32], "big"), int.from_bytes(raw[32:], "big"))
    pub.verify(der, big, ec.ECDSA(hashes.SHA256()))
    assert _KMS.seen[-1]["messageType"] == "DIGEST"
    assert "message_type=DIGEST" in vs.signer_identity()
