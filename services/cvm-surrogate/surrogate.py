#!/usr/bin/env python3
"""CVM surrogate — a wire-compatible stand-in for the Signer CVM.

WHAT THIS IS

A live HTTP service that answers the same requests the real Signer CVM
answers, with the same response shapes, so the whole signing path can be
built and exercised without an Oracle Confidential VM running.

The model is Ravencoin testnet, not a mock library. Testnet speaks the
real protocol on a real socket; what makes it safe is that its addresses
carry a different prefix, so a testnet coin can never be mistaken for a
mainnet one. Same here: every identifier this service emits is visibly a
testnet identifier, and the signatures are real ECDSA over a real key —
just not a key any hardware ever protected.

THREE SURFACES IT SERVES, matching the three the real CVM depends on:

  POST /20180608/sign          OCI KMS Crypto Sign
                               (services/c2pa-signer/vault_sign.py)
  GET  /opc/v2/instance/       OCI IMDSv2 instance metadata
                               (services/c2pa-signer/signer_runtime.py)
  GET  /testnet/pubkey.pem     the verifying key — NOT an OCI surface.
                               Real KMS exposes this via the management
                               API; served here so a verifier can check
                               a surrogate-signed leaf without OCI creds.

  GET  /health                 liveness

WHAT MAKES IT UNMISTAKABLE

  - Every OCID it returns contains the literal segment `.surrogate.` and
    the region reads `us-surrogate-1`. No real OCI identifier can.
  - Responses carry `X-Scruple-Surrogate: 1`.
  - The signing key is generated at first run into ./surrogate-key.pem
    and is gitignored. It is not, and must never become, a key with any
    production meaning.
  - /dev/sev-guest is NOT faked. The real signer treats that device's
    existence as its production signal, and making that spoofable would
    turn a security check into a suggestion. A caller pointed at this
    service is therefore still, correctly, a dev-mode signer.

WHAT IT CANNOT TELL YOU

  - Whether OCI Vault's real latency is tolerable per leaf.
  - Whether instance-principal auth works from inside the pool.
  - Anything about SEV-SNP attestation. It has no measurement to report
    and does not pretend to have one.

Usage:
    python3 surrogate.py              # port 8799
    SURROGATE_PORT=9000 python3 surrogate.py
"""

from __future__ import annotations

import base64
import json
import os
import sys
import threading
from datetime import datetime, timezone, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec

HERE = Path(__file__).resolve().parent
KEY_PATH = Path(os.environ.get("SURROGATE_KEY_PATH", HERE / "surrogate-key.pem"))
PORT = int(os.environ.get("SURROGATE_PORT", "8799"))

# Testnet-shaped identifiers. The `.surrogate.` segment and the
# `us-surrogate-1` region are the equivalent of a testnet address prefix:
# structurally impossible to confuse with the real thing, while remaining
# the right SHAPE so callers parse them normally.
REGION = "us-surrogate-1"
KEY_OCID = f"ocid1.key.oc1.{REGION}.surrogate.aaaaaaaaSURROGATEKEYnotarealkey"
KEY_VERSION_OCID = f"ocid1.keyversion.oc1.{REGION}.surrogate.aaaaaaaaSURROGATEVERSION"
VAULT_OCID = f"ocid1.vault.oc1.{REGION}.surrogate.aaaaaaaaSURROGATEVAULT"
INSTANCE_OCID = f"ocid1.instance.oc1.{REGION}.surrogate.aaaaaaaaSURROGATEINSTANCE"
IMAGE_OCID = f"ocid1.image.oc1.{REGION}.surrogate.aaaaaaaaSURROGATEIMAGE"
COMPARTMENT_OCID = f"ocid1.compartment.oc1..surrogate.aaaaaaaaSURROGATECOMPARTMENT"

# Born recently enough to pass the signer's age guard (default max 60d).
BORN_AT = datetime.now(timezone.utc) - timedelta(days=3)

_key_lock = threading.Lock()
_private_key: ec.EllipticCurvePrivateKey | None = None


def signing_key() -> ec.EllipticCurvePrivateKey:
    """Load or create the surrogate's P-256 key.

    Persisted so signatures remain verifiable across restarts — a verifier
    that cached the public key should not be broken by a service bounce.
    """
    global _private_key
    with _key_lock:
        if _private_key is not None:
            return _private_key
        if KEY_PATH.exists():
            _private_key = serialization.load_pem_private_key(
                KEY_PATH.read_bytes(), password=None,
            )
        else:
            _private_key = ec.generate_private_key(ec.SECP256R1())
            KEY_PATH.write_bytes(
                _private_key.private_bytes(
                    encoding=serialization.Encoding.PEM,
                    format=serialization.PrivateFormat.PKCS8,
                    encryption_algorithm=serialization.NoEncryption(),
                )
            )
            os.chmod(KEY_PATH, 0o600)
            print(f"[surrogate] generated a new P-256 key at {KEY_PATH}")
        return _private_key


def public_key_pem() -> bytes:
    return signing_key().public_key().public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    )


class Handler(BaseHTTPRequestHandler):
    server_version = "ScrupleCVMSurrogate/1.0"

    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write(f"[surrogate] {self.address_string()} {fmt % args}\n")

    # ---- helpers ----------------------------------------------------
    def _send(self, code: int, body: bytes, ctype: str = "application/json") -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        # Present on every response. A caller that wants to refuse to talk
        # to a surrogate can check one header.
        self.send_header("X-Scruple-Surrogate", "1")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, code: int, obj: dict) -> None:
        self._send(code, json.dumps(obj, indent=2).encode() + b"\n")

    def _error(self, code: int, message: str) -> None:
        # OCI's error envelope shape, so client error handling exercises
        # the same path it will in production.
        self._json(code, {"code": "SurrogateError", "message": message})

    # ---- GET --------------------------------------------------------
    def do_GET(self) -> None:
        path = self.path.split("?")[0].rstrip("/") or "/"

        if path == "/health":
            self._json(200, {
                "ok": True,
                "service": "cvm-surrogate",
                "surrogate": True,
                "region": REGION,
                "key_ocid": KEY_OCID,
                "note": "Wire-compatible stand-in. Signatures are real ECDSA over a software key; no hardware protected it.",
            })
            return

        if path == "/testnet/pubkey.pem":
            self._send(200, public_key_pem(), "application/x-pem-file")
            return

        # IMDSv2 — the real service requires this header and returns 401
        # without it. Reproduced so callers exercise the same code path.
        if path in ("/opc/v2/instance", "/opc/v2/instance/"):
            auth = self.headers.get("Authorization", "")
            if auth != "Bearer Oracle":
                self._error(401, "IMDSv2 requires 'Authorization: Bearer Oracle'")
                return
            self._json(200, {
                "id": INSTANCE_OCID,
                "image": IMAGE_OCID,
                "compartmentId": COMPARTMENT_OCID,
                "region": REGION,
                "shape": "VM.Standard.E5.Flex",
                "displayName": "scruple-signer-SURROGATE",
                # OCI returns epoch milliseconds here; signer_runtime.py
                # parses both this and ISO. Use the real shape.
                "timeCreated": int(BORN_AT.timestamp() * 1000),
                "metadata": {"scruple_surrogate": "true"},
            })
            return

        # KMS key metadata, in case a caller reads it before signing.
        if path == f"/20180608/keys/{KEY_OCID}":
            self._json(200, {
                "id": KEY_OCID,
                "vaultId": VAULT_OCID,
                "compartmentId": COMPARTMENT_OCID,
                "displayName": "scruple-c2pa-es256-SURROGATE",
                "currentKeyVersion": KEY_VERSION_OCID,
                "lifecycleState": "ENABLED",
                # The real production vault reports HSM. This one must not
                # claim that, so it reports SOFTWARE truthfully.
                "protectionMode": "SOFTWARE",
                "algorithm": "ECDSA",
                "curveId": "NIST_P256",
            })
            return

        self._error(404, f"no surrogate route for GET {path}")

    # ---- POST -------------------------------------------------------
    def do_POST(self) -> None:
        path = self.path.split("?")[0].rstrip("/") or "/"

        if path != "/20180608/sign":
            self._error(404, f"no surrogate route for POST {path}")
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
            body = json.loads(self.rfile.read(length) or b"{}")
        except Exception as e:
            self._error(400, f"malformed request body: {e}")
            return

        # Validate exactly what OCI validates, so a caller that would fail
        # in production fails here too rather than passing on a mock's
        # leniency.
        key_id = body.get("keyId")
        message_b64 = body.get("message")
        message_type = body.get("messageType", "DIGEST")
        algorithm = body.get("signingAlgorithm")

        if not key_id:
            self._error(400, "keyId is required")
            return
        if key_id != KEY_OCID:
            self._error(404, f"key {key_id} not found in this surrogate vault")
            return
        if not message_b64:
            self._error(400, "message is required")
            return
        if algorithm != "ECDSA_SHA_256":
            self._error(400, f"surrogate supports ECDSA_SHA_256 only, got {algorithm!r}")
            return
        if message_type not in ("RAW", "DIGEST"):
            self._error(400, f"messageType must be RAW or DIGEST, got {message_type!r}")
            return

        try:
            message = base64.b64decode(message_b64, validate=True)
        except Exception:
            self._error(400, "message must be valid base64")
            return

        if message_type == "RAW":
            signature_der = signing_key().sign(message, ec.ECDSA(hashes.SHA256()))
        else:
            signature_der = signing_key().sign(
                message, ec.ECDSA(utils_prehashed()),
            )

        # OCI returns base64 of the DER-encoded ECDSA signature.
        # vault_sign.py base64-decodes then decode_dss_signature()s it, so
        # this is the format that path expects.
        self._json(200, {
            "signature": base64.b64encode(signature_der).decode("ascii"),
            "keyId": KEY_OCID,
            "keyVersionId": KEY_VERSION_OCID,
            "signingAlgorithm": algorithm,
        })


def utils_prehashed():
    from cryptography.hazmat.primitives.asymmetric.utils import Prehashed
    return Prehashed(hashes.SHA256())


def main() -> int:
    signing_key()
    print(f"[surrogate] CVM surrogate on http://127.0.0.1:{PORT}")
    print(f"[surrogate]   region     {REGION}")
    print(f"[surrogate]   key        {KEY_OCID}")
    print(f"[surrogate]   pubkey     http://127.0.0.1:{PORT}/testnet/pubkey.pem")
    print(f"[surrogate] Point the signer at it with:")
    print(f"[surrogate]   SCRUPLE_C2PA_VAULT_KEY_OCID={KEY_OCID}")
    print(f"[surrogate]   SCRUPLE_C2PA_VAULT_CRYPTO_ENDPOINT=http://127.0.0.1:{PORT}")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
