"""The surrogate must be wire-compatible AND unmistakable.

Two properties in tension, and both are load-bearing:

  compatible   — a caller written for OCI must work against it unchanged,
                 including the parts that fail. A mock that is more
                 lenient than production teaches you the wrong thing.
  unmistakable — nothing it emits may be confusable with a real OCI
                 identifier, and it must never claim hardware protection.
                 This is the RVN-testnet property: same protocol, prefixes
                 that cannot collide.
"""

from __future__ import annotations

import base64
import json
import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import pytest
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import (
    decode_dss_signature, encode_dss_signature,
)

HERE = Path(__file__).resolve().parent.parent
KEY_OCID_SUFFIX = "surrogate.aaaaaaaaSURROGATEKEYnotarealkey"


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture(scope="module")
def base_url(tmp_path_factory):
    port = _free_port()
    env = {
        **os.environ,
        "SURROGATE_PORT": str(port),
        "SURROGATE_KEY_PATH": str(tmp_path_factory.mktemp("k") / "key.pem"),
    }
    proc = subprocess.Popen(
        [sys.executable, str(HERE / "surrogate.py")],
        env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    url = f"http://127.0.0.1:{port}"
    for _ in range(50):
        try:
            urllib.request.urlopen(f"{url}/health", timeout=0.3)
            break
        except Exception:
            time.sleep(0.1)
    else:
        proc.kill()
        pytest.fail("surrogate did not start")
    yield url
    proc.terminate()
    proc.wait(timeout=5)


def _post(url, obj):
    req = urllib.request.Request(
        url, data=json.dumps(obj).encode(),
        headers={"Content-Type": "application/json"},
    )
    return json.load(urllib.request.urlopen(req))


def _key_ocid(base_url):
    return json.load(urllib.request.urlopen(f"{base_url}/health"))["key_ocid"]


class TestUnmistakable:
    def test_every_ocid_is_visibly_a_surrogate(self, base_url):
        h = json.load(urllib.request.urlopen(f"{base_url}/health"))
        assert ".surrogate." in h["key_ocid"]
        assert h["region"] == "us-surrogate-1"

    def test_imds_identifiers_cannot_pass_for_real(self, base_url):
        req = urllib.request.Request(
            f"{base_url}/opc/v2/instance/",
            headers={"Authorization": "Bearer Oracle"},
        )
        d = json.load(urllib.request.urlopen(req))
        for field in ("id", "image", "compartmentId"):
            assert ".surrogate." in d[field] or "surrogate" in d[field], field

    def test_every_response_carries_the_surrogate_header(self, base_url):
        for path in ("/health", "/testnet/pubkey.pem"):
            with urllib.request.urlopen(f"{base_url}{path}") as r:
                assert r.headers.get("X-Scruple-Surrogate") == "1", path

    def test_it_reports_SOFTWARE_protection_never_HSM(self, base_url):
        key = _key_ocid(base_url)
        d = json.load(urllib.request.urlopen(f"{base_url}/20180608/keys/{key}"))
        assert d["protectionMode"] == "SOFTWARE"
        assert d["protectionMode"] != "HSM", (
            "a surrogate claiming HSM protection would be exactly the "
            "dev-indistinguishable-from-production failure this exists to avoid"
        )


class TestWireCompatible:
    def test_sign_returns_base64_der_that_decodes_to_64_raw_bytes(self, base_url):
        """The exact transformation vault_sign.py performs on the response."""
        key = _key_ocid(base_url)
        msg = b"canonical leaf"
        resp = _post(f"{base_url}/20180608/sign", {
            "keyId": key, "message": base64.b64encode(msg).decode(),
            "messageType": "RAW", "signingAlgorithm": "ECDSA_SHA_256",
        })
        r, s = decode_dss_signature(base64.b64decode(resp["signature"]))
        raw = r.to_bytes(32, "big") + s.to_bytes(32, "big")
        assert len(raw) == 64, "c2pa-python's from_callback requires 64 raw bytes"

    def test_the_signature_actually_verifies(self, base_url):
        key = _key_ocid(base_url)
        msg = b"a witnessed event"
        resp = _post(f"{base_url}/20180608/sign", {
            "keyId": key, "message": base64.b64encode(msg).decode(),
            "messageType": "RAW", "signingAlgorithm": "ECDSA_SHA_256",
        })
        pub = serialization.load_pem_public_key(
            urllib.request.urlopen(f"{base_url}/testnet/pubkey.pem").read()
        )
        r, s = decode_dss_signature(base64.b64decode(resp["signature"]))
        pub.verify(encode_dss_signature(r, s), msg, ec.ECDSA(hashes.SHA256()))

    def test_a_tampered_message_does_not_verify(self, base_url):
        key = _key_ocid(base_url)
        resp = _post(f"{base_url}/20180608/sign", {
            "keyId": key, "message": base64.b64encode(b"original").decode(),
            "messageType": "RAW", "signingAlgorithm": "ECDSA_SHA_256",
        })
        pub = serialization.load_pem_public_key(
            urllib.request.urlopen(f"{base_url}/testnet/pubkey.pem").read()
        )
        r, s = decode_dss_signature(base64.b64decode(resp["signature"]))
        with pytest.raises(Exception):
            pub.verify(encode_dss_signature(r, s), b"tampered", ec.ECDSA(hashes.SHA256()))

    def test_the_key_is_stable_across_requests(self, base_url):
        """A verifier that cached the public key must not be broken by it."""
        a = urllib.request.urlopen(f"{base_url}/testnet/pubkey.pem").read()
        b = urllib.request.urlopen(f"{base_url}/testnet/pubkey.pem").read()
        assert a == b


class TestItFailsWhereProductionFails:
    """A mock more permissive than the real service teaches the wrong lesson."""

    def test_imds_401s_without_the_bearer_oracle_header(self, base_url):
        with pytest.raises(urllib.error.HTTPError) as e:
            urllib.request.urlopen(f"{base_url}/opc/v2/instance/")
        assert e.value.code == 401

    def test_an_unknown_key_ocid_404s(self, base_url):
        with pytest.raises(urllib.error.HTTPError) as e:
            _post(f"{base_url}/20180608/sign", {
                "keyId": "ocid1.key.oc1.iad.someoneelseskey",
                "message": base64.b64encode(b"x").decode(),
                "messageType": "RAW", "signingAlgorithm": "ECDSA_SHA_256",
            })
        assert e.value.code == 404

    def test_an_unsupported_algorithm_400s(self, base_url):
        with pytest.raises(urllib.error.HTTPError) as e:
            _post(f"{base_url}/20180608/sign", {
                "keyId": _key_ocid(base_url),
                "message": base64.b64encode(b"x").decode(),
                "messageType": "RAW", "signingAlgorithm": "RSA_PSS_SHA_256",
            })
        assert e.value.code == 400

    def test_malformed_base64_400s(self, base_url):
        with pytest.raises(urllib.error.HTTPError) as e:
            _post(f"{base_url}/20180608/sign", {
                "keyId": _key_ocid(base_url), "message": "!!!not base64!!!",
                "messageType": "RAW", "signingAlgorithm": "ECDSA_SHA_256",
            })
        assert e.value.code == 400


class TestAgainstTheRealClientCode:
    def test_signer_runtime_parses_the_surrogates_imds(self, base_url, monkeypatch):
        """The unmodified production module, pointed at the surrogate."""
        sys.path.insert(0, str(HERE.parent / "c2pa-signer"))
        monkeypatch.setenv("SCRUPLE_C2PA_VAULT_KEY_OCID", _key_ocid(base_url))
        import signer_runtime as sr
        monkeypatch.setattr(sr, "IMDS_URL", f"{base_url}/opc/v2/instance/")
        sr._cache.clear()

        info = sr.signer_runtime_info()
        assert info is not None, "signer_runtime rejected the surrogate's IMDS"
        assert ".surrogate." in info["instance_id"]
        assert sr.age_guard_verdict()["refuse"] is False
        assert sr.runtime_assertion()["label"] == "ai.scruple.signer-runtime.v1"
