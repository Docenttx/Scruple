"""C2PA ES256 signer callback — OCI Vault mode + local-file fallback.

Two modes controlled by env vars — both expose the SAME `vault_sign_es256(data)`
signature so `sign.py` never changes when we swap:

  VAULT MODE (production / L2 evidence): set
    SCRUPLE_C2PA_VAULT_KEY_OCID=ocid1.key.oc1.us-ashburn-1.xxx
    SCRUPLE_C2PA_VAULT_CRYPTO_ENDPOINT=https://xxx-crypto.kms.us-ashburn-1.oraclecloud.com
    (Instance-principal auth via the compute instance's Dynamic Group.
     Requires `pip install oci` on the host.)

  LOCAL-FILE MODE (development / interop testing): default when the vault
  env vars are unset. Loads services/c2pa-signer/keys/es256.pem, signs
  with Python's cryptography library. Same ES256 raw R||S output.

Both modes return exactly 64 raw bytes: R (32) || S (32), the RFC 8152
ES256 signature format c2pa-python expects from Signer.from_callback.

Design intent — the C2PA signer never sees a raw private key when running
in Vault mode. The Vault Sign API keeps material inside the Oracle-managed
key material boundary; software-mode is not L2 but the API surface is the
same, so swapping to Virtual Private (HSM) is an env-var change.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Callable

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature


def _local_signer_from_env_or_default() -> Callable[[bytes], bytes]:
    """Return an ES256 raw-R||S signer using a local PEM private key."""
    key_path = os.environ.get(
        "SCRUPLE_C2PA_LOCAL_KEY_PATH",
        str(Path(__file__).parent / "keys" / "es256.pem"),
    )
    priv_pem = Path(key_path).read_bytes()
    priv = serialization.load_pem_private_key(priv_pem, password=None)
    if not isinstance(priv, ec.EllipticCurvePrivateKey):
        raise RuntimeError(f"expected EC private key at {key_path}")

    def _sign(data: bytes) -> bytes:
        der = priv.sign(data, ec.ECDSA(hashes.SHA256()))
        r, s = decode_dss_signature(der)
        return r.to_bytes(32, "big") + s.to_bytes(32, "big")

    return _sign


def _vault_signer_from_env() -> Callable[[bytes], bytes]:
    """Return an ES256 raw-R||S signer that calls OCI Vault KMS Sign."""
    key_ocid = os.environ["SCRUPLE_C2PA_VAULT_KEY_OCID"]
    endpoint = os.environ["SCRUPLE_C2PA_VAULT_CRYPTO_ENDPOINT"]

    # Lazy import — oci SDK is heavy (~100MB) and only needed in vault mode.
    try:
        import oci  # type: ignore
    except ImportError as e:
        raise RuntimeError(
            "SCRUPLE_C2PA_VAULT_KEY_OCID is set but the `oci` Python SDK is "
            "not installed. Run: pip install oci"
        ) from e

    # Instance-principal auth: compute instance identity → Dynamic Group →
    # IAM policy → key. No config file or API keys on disk.
    signer_auth = oci.auth.signers.InstancePrincipalsSecurityTokenSigner()
    client = oci.key_management.KmsCryptoClient(
        config={}, signer=signer_auth, service_endpoint=endpoint,
    )

    def _sign(data: bytes) -> bytes:
        import base64
        resp = client.sign(
            sign_data_details=oci.key_management.models.SignDataDetails(
                key_id=key_ocid,
                message=base64.b64encode(data).decode("ascii"),
                message_type="RAW",
                signing_algorithm="ECDSA_SHA_256",
            )
        )
        # OCI returns base64-encoded DER-encoded ECDSA signature.
        der = base64.b64decode(resp.data.signature)
        r, s = decode_dss_signature(der)
        return r.to_bytes(32, "big") + s.to_bytes(32, "big")

    return _sign


_cached_signer: Callable[[bytes], bytes] | None = None


def vault_sign_es256(data: bytes) -> bytes:
    """The Signer.from_callback callback. Dispatch on env var presence."""
    global _cached_signer
    if _cached_signer is None:
        if os.environ.get("SCRUPLE_C2PA_VAULT_KEY_OCID"):
            _cached_signer = _vault_signer_from_env()
        else:
            _cached_signer = _local_signer_from_env_or_default()
    return _cached_signer(data)


def signing_mode() -> str:
    """Return 'vault' or 'local' — useful for logs + audit trail."""
    return "vault" if os.environ.get("SCRUPLE_C2PA_VAULT_KEY_OCID") else "local"


def signer_identity() -> str:
    """Return a human-safe identifier of the signing key (for audit logs).
    Never returns key material — only ocid or file path."""
    if signing_mode() == "vault":
        ocid = os.environ.get("SCRUPLE_C2PA_VAULT_KEY_OCID", "")
        # Mask everything except the last 8 chars for public logs.
        return f"vault:...{ocid[-8:]}" if ocid else "vault:unknown"
    return "local:services/c2pa-signer/keys/es256.pem"
