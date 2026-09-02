"""C2PA ES256 signer callback — OCI Vault mode + local-file fallback.

Two modes controlled by env vars — both expose the SAME `vault_sign_es256(data)`
signature so `sign.py` never changes when we swap:

  VAULT MODE (production / L2 evidence): set
    SCRUPLE_C2PA_VAULT_KEY_OCID=ocid1.key.oc1.us-ashburn-1.xxx
    SCRUPLE_C2PA_VAULT_CRYPTO_ENDPOINT=https://xxx-crypto.kms.us-ashburn-1.oraclecloud.com
    (Instance-principal auth via the compute instance's Dynamic Group.
     Requires `pip install oci` on the host.)

  LOCAL-FILE MODE (development / interop testing): default when the vault
  env vars are unset. Loads the PEM named by local_key_path() —
  SCRUPLE_C2PA_LOCAL_KEY_PATH, or keys/signer.key — and signs with
  Python's cryptography library. Same ES256 raw R||S output.

  local_key_path() is the ONLY place that path is resolved. It used to be
  resolved independently in four places against a key name that 0b6ee43
  purged on 2026-07-13, so local mode failed everywhere it was not handed
  the env var explicitly — which meant every witness leaf signature, and
  the failure was swallowed. See docs/canon/demo-readiness/c2pa-watermark.md §0.

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


#: The dev key that keys/regen-dev-cert.sh actually produces. Everything
#: that needs a local key path asks local_key_path() for it; nothing
#: re-derives it, because four independent derivations is how this file
#: came to name a key that had not existed for seven weeks.
DEFAULT_LOCAL_KEY = Path(__file__).parent / "keys" / "signer.key"


def local_key_path() -> Path:
    """The local-mode ES256 private key, resolved in exactly one place.

    SCRUPLE_C2PA_LOCAL_KEY_PATH wins when set (sign.py sets it from the
    job spec's key_path). Otherwise the dev key regen-dev-cert.sh emits.
    """
    env = os.environ.get("SCRUPLE_C2PA_LOCAL_KEY_PATH")
    return Path(env) if env else DEFAULT_LOCAL_KEY


class LocalKeyMissing(RuntimeError):
    """The local key is not on disk. A distinct type because it is a
    configuration fault, not a signing outage: it fails 100% of the time
    and retrying never helps. Callers surface it as such."""

    def __init__(self, key_path: Path) -> None:
        self.key_path = key_path
        super().__init__(
            f"local signing key not found at {key_path}. This is a "
            f"configuration fault, not a transient failure: every signature "
            f"will fail until it is fixed. Either run "
            f"services/c2pa-signer/keys/regen-dev-cert.sh to produce the dev "
            f"pair (signer.key + signer.pem), or point "
            f"SCRUPLE_C2PA_LOCAL_KEY_PATH at the real key. For production, "
            f"set SCRUPLE_C2PA_VAULT_KEY_OCID and never touch a local key."
        )


def _local_signer_from_env_or_default() -> Callable[[bytes], bytes]:
    """Return an ES256 raw-R||S signer using a local PEM private key."""
    key_path = local_key_path()
    if not key_path.exists():
        raise LocalKeyMissing(key_path)
    priv_pem = key_path.read_bytes()
    priv = serialization.load_pem_private_key(priv_pem, password=None)
    if not isinstance(priv, ec.EllipticCurvePrivateKey):
        raise RuntimeError(f"expected EC private key at {key_path}")

    # Record what actually signed, so signer_identity() reports the key
    # that produced the signature rather than a string someone typed.
    global _active_local_key
    _active_local_key = key_path.resolve()

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
_active_local_key: Path | None = None


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
    """A human-safe identifier of the key that signed. Never key material.

    THIS VALUE IS NOT A LOG LINE. sign.py returns it, signAsset.ts passes
    it through as `signerIdentity`, and app/api/scruple/c2pa/sign/route.ts
    folds it into the canonical payload whose sha256 becomes a witness
    leaf's payload_hash. So a wrong value here is a false claim committed
    into an append-only audit chain — and because only the hash is stored,
    it is neither visible nor correctable afterwards: a verifier
    recomputing the payload with the true identity gets a mismatch, which
    is indistinguishable from tampering.

    Until 2026-09-02 this returned a hardcoded string naming a key file
    that 0b6ee43 purged on 2026-07-13 and that never signed anything.

    It now reports the key that actually signed, or refuses. There is no
    third answer.
    """
    if signing_mode() == "vault":
        ocid = os.environ.get("SCRUPLE_C2PA_VAULT_KEY_OCID", "")
        # Mask everything except the last 8 chars for public logs.
        return f"vault:...{ocid[-8:]}" if ocid else "vault:unknown"

    # Local mode. If a signature has already been produced this process,
    # name the file that produced it — not the file we would pick now,
    # which an env-var change could have moved out from under us.
    if _active_local_key is not None:
        return f"local:{_active_local_key}"

    # Nothing has signed yet: report what would sign, but only if it is
    # really there. Naming an absent file is the defect this replaces.
    key_path = local_key_path()
    if not key_path.exists():
        raise LocalKeyMissing(key_path)
    return f"local:{key_path.resolve()}"
