"""C2PA ES256 signer callback — OCI Vault mode + local-file fallback.

Two modes controlled by env vars — both expose the SAME `vault_sign_es256(data)`
signature so `sign.py` never changes when we swap:

  VAULT MODE (production / L2 evidence): set
    SCRUPLE_C2PA_VAULT_KEY_OCID=ocid1.key.oc1.us-ashburn-1.xxx
    SCRUPLE_C2PA_VAULT_CRYPTO_ENDPOINT=https://xxx-crypto.kms.us-ashburn-1.oraclecloud.com
    (Instance-principal auth via the compute instance's Dynamic Group.
     Requires `pip install oci` on the host.)

  KMS-HTTP MODE (sandbox / surrogate): set
    SCRUPLE_C2PA_VAULT_KEY_OCID=ocid1.key.oc1.us-surrogate-1.surrogate.xxx
    SCRUPLE_C2PA_KMS_ENDPOINT=http://127.0.0.1:8799
    POSTs {endpoint}/20180608/sign with no request signing. Wire-identical
    to the OCI KMS Crypto Sign API, which is exactly what the witness
    server's leaf_signer.js already does for H-1 leaf signatures
    (/opt/scruple-witness/leaf_signer.js:26-29, mode `kms-http`). It exists
    for the same reason: services/cvm-surrogate speaks that wire, the real
    Vault needs draft-cavage instance-principal credentials, and until
    those land there was NO WAY to produce a C2PA credential whose key
    this process does not hold. WO-B6 needed one.

    THE MODE IS NEVER `vault`. signing_mode() returns 'kms-http' and
    signer_identity() carries `surrogate=` for a surrogate OCID, so
    nothing downstream can mistake a software-signed credential for an
    HSM-backed one. That distinction is the whole reason the surrogate
    reports protectionMode SOFTWARE truthfully.

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

from cryptography import x509
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import (
    decode_dss_signature,
    encode_dss_signature,
)


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


#: OCI's documented ceiling for `messageType: RAW`. Past it the service
#: requires the caller to hash and send `DIGEST`. The surrogate accepts
#: both, so honouring the real limit here is what keeps a sandbox run
#: predictive of production rather than merely green.
_KMS_RAW_MAX_BYTES = 4096

#: Which message_type the last kms-http signature used. Reported by
#: signer_identity() because RAW and DIGEST are two different things the
#: signer did, and a reader of the manifest is entitled to know which.
_kms_last_message_type: str | None = None


def _kms_http_signer_from_env() -> Callable[[bytes], bytes]:
    """ES256 raw-R||S signer that POSTs to an OCI-KMS-shaped Sign endpoint.

    No request signing, which is precisely why this is not the production
    path and why `signing_mode()` refuses to call it `vault`.
    """
    import base64
    import json
    import urllib.request

    key_ocid = os.environ["SCRUPLE_C2PA_VAULT_KEY_OCID"]
    endpoint = os.environ["SCRUPLE_C2PA_KMS_ENDPOINT"].rstrip("/")

    def _sign(data: bytes) -> bytes:
        global _kms_last_message_type
        # RAW means the service SHA-256s the message. Over the limit that
        # is not an option, so hash here and send DIGEST -- the same
        # signature over the same bytes either way. Silently truncating,
        # or sending RAW and letting the service refuse, would both end
        # as an unexplained signing outage.
        if len(data) <= _KMS_RAW_MAX_BYTES:
            message, message_type = data, "RAW"
        else:
            message = hashes.Hash(hashes.SHA256())
            message.update(data)
            message, message_type = message.finalize(), "DIGEST"
        payload = json.dumps({
            "keyId": key_ocid,
            "message": base64.b64encode(message).decode("ascii"),
            "messageType": message_type,
            "signingAlgorithm": "ECDSA_SHA_256",
        }).encode("utf-8")
        req = urllib.request.Request(
            f"{endpoint}/20180608/sign",
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = json.loads(resp.read())
        sig_b64 = body.get("signature")
        if not sig_b64:
            raise RuntimeError(
                f"KMS Sign at {endpoint} returned no signature field: {body!r}"
            )
        der = base64.b64decode(sig_b64)
        r, s = decode_dss_signature(der)
        _kms_last_message_type = message_type
        return r.to_bytes(32, "big") + s.to_bytes(32, "big")

    return _sign


def is_surrogate_key(ocid: str) -> bool:
    """Is this OCID the CVM surrogate's? Same test leaf_signer.js uses
    (leaf_signer.js:219), so the two tiers cannot disagree about which
    leaves are software-signed."""
    return ".surrogate." in ocid or "us-surrogate-1" in ocid


_cached_signer: Callable[[bytes], bytes] | None = None
_active_local_key: Path | None = None


def vault_sign_es256(data: bytes) -> bytes:
    """The Signer.from_callback callback. Dispatch on env var presence."""
    global _cached_signer
    if _cached_signer is None:
        mode = signing_mode()
        if mode == "kms-http":
            _cached_signer = _kms_http_signer_from_env()
        elif mode == "vault":
            _cached_signer = _vault_signer_from_env()
        else:
            _cached_signer = _local_signer_from_env_or_default()
    return _cached_signer(data)


def signing_mode() -> str:
    """Return 'vault', 'kms-http' or 'local' — for logs + audit trail.

    `kms-http` is checked FIRST and is a separate value rather than a
    flavour of `vault`, because sign.py prints this string into its
    result and app/api/scruple/c2pa/sign/route.ts folds it into the
    canonical payload whose sha256 becomes a witness leaf. Reporting an
    unauthenticated HTTP call to a software surrogate as `vault` would
    commit a false claim about key custody into an append-only record —
    the exact failure signer_identity()'s docstring is about.
    """
    if not os.environ.get("SCRUPLE_C2PA_VAULT_KEY_OCID"):
        return "local"
    return "kms-http" if os.environ.get("SCRUPLE_C2PA_KMS_ENDPOINT") else "vault"


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
    mode = signing_mode()
    if mode == "kms-http":
        ocid = os.environ.get("SCRUPLE_C2PA_VAULT_KEY_OCID", "")
        endpoint = os.environ.get("SCRUPLE_C2PA_KMS_ENDPOINT", "")
        # `surrogate=` is stated on EVERY kms-http identity, true or
        # false, because an absent flag reads as "not a surrogate" and
        # this string is the only place the distinction survives into the
        # signed record.
        return (
            f"kms-http:{endpoint}:...{ocid[-8:]}"
            f" surrogate={str(is_surrogate_key(ocid)).lower()}"
            f" message_type={_kms_last_message_type or 'none-yet'}"
        )
    if mode == "vault":
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


# ---------------------------------------------------------------------------
# The certificate must belong to the key that signs.
# ---------------------------------------------------------------------------
#
# WO-D7 found the hole and docs/STATE.md §4.3 (desktop repo) recorded it: with
# SCRUPLE_C2PA_VAULT_KEY_OCID + SCRUPLE_C2PA_KMS_ENDPOINT set, the signer signs
# through the surrogate with one key and embeds keys/signer.pem -- the
# certificate issued for the LOCAL key -- because lib/c2pa/signAsset.ts picks
# `cert_path` (`?? DEV_CERT`) independently of which key `vault_sign_es256`
# will dispatch to. The route answered ok:true and c2pa.Reader answered
# ['signingCredential.untrusted', 'claimSignature.mismatch']: a credential
# nothing can verify, from a call that reported success.
#
# HOW THE COMPARISON IS MADE, AND WHY NOT BY FETCHING A PUBLIC KEY.
# The obvious implementation is to obtain the signing key's public half and
# compare its SubjectPublicKeyInfo against the certificate's. That needs a
# different answer per mode -- derive it from the PEM in local mode, GET
# /testnet/pubkey.pem from the surrogate in kms-http mode, call the OCI
# KMS *management* API (a different endpoint from the crypto one this module
# holds) in vault mode -- so it is three code paths, two of which can only be
# exercised where their service is. It is also weaker: a public key served by
# an endpoint is a claim about the signing key, and the thing being guarded
# against is precisely a configuration where the claim and the key disagree.
#
# So the comparison is a challenge instead. The signing path signs a
# domain-separated probe; the certificate's public key verifies it. That is
# the same question -- "is this certificate's key the key that signs?" --
# asked of the signer rather than about it, it is one code path for all three
# modes, and it cannot be satisfied by anything except the private key the
# next signature will use.
#
# THERE IS NO OVERRIDE. Not an env var, not a warning, not a fall back to the
# local key. A mismatch is a refusal, because every other outcome ships a
# credential whose signature cannot be verified by the certificate shipped
# with it, and does so silently.
#
# COST: one extra ES256 signature per sign call -- one more KMS round trip in
# kms-http and vault mode. It is paid before anything is written.

#: Domain separation. A C2PA claim signature is over a COSE Sig_structure,
#: which begins b"\x84\x6aSignature1"; this prefix cannot collide with one,
#: so a probe signature can never be replayed as a claim signature.
_KEY_BINDING_PROBE_PREFIX = b"scruple.c2pa.key-binding-probe.v1\x00"


class CertificateKeyMismatch(RuntimeError):
    """The certificate does not belong to the key that would sign.

    A distinct type, like LocalKeyMissing, because it is a configuration
    fault rather than a signing outage: it fails 100% of the time and
    retrying never helps. `reason` says which of the three ways it failed,
    because the fix differs -- a wrong certificate file, a certificate for
    the wrong algorithm, and a certificate on the wrong curve are three
    different mistakes with three different corrections.
    """

    def __init__(self, reason: str, message: str, audit: dict) -> None:
        self.reason = reason
        self.audit = dict(audit, checked=True, matches=False, reason=reason)
        super().__init__(message)


def _leaf_public_key(cert_pem: bytes):
    """The public key of the FIRST certificate in the chain PEM.

    Leaf-first is the order c2pa-rs expects and the order both
    keys/regen-dev-cert.sh and scripts/d7-surrogate-cert.sh emit, so the
    first block is the end-entity certificate whose key must sign.
    """
    cert = x509.load_pem_x509_certificate(cert_pem)
    return cert, cert.public_key()


def _spki_sha256(public_key) -> str:
    from hashlib import sha256

    der = public_key.public_bytes(
        encoding=serialization.Encoding.DER,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    return sha256(der).hexdigest()


def assert_certificate_matches_signing_key(cert_pem: bytes) -> dict:
    """Refuse unless the leaf certificate's key is the key that will sign.

    Returns an audit dict on success. Raises CertificateKeyMismatch when the
    two disagree.

    It does NOT convert a signing outage into a mismatch: only the
    verification step is caught. A KMS that is unreachable, a local key that
    is not on disk, a malformed signature -- all of those propagate as
    themselves, because "the signer is down" and "the certificate is for
    another key" are different facts with different owners, and the second
    one is permanent.
    """
    mode = signing_mode()
    cert, pub = _leaf_public_key(cert_pem)
    audit = {
        "signing_mode": mode,
        "cert_subject": cert.subject.rfc4514_string(),
        "cert_serial": format(cert.serial_number, "x"),
        "method": "es256-challenge",
    }

    if not isinstance(pub, ec.EllipticCurvePublicKey):
        raise CertificateKeyMismatch(
            "not_an_ec_key",
            f"the certificate at the head of the chain carries a "
            f"{type(pub).__name__}, and the signing path is ES256. Nothing "
            f"this signer produces could ever verify under it. "
            f"subject={audit['cert_subject']}",
            audit,
        )
    audit["cert_spki_sha256"] = _spki_sha256(pub)
    audit["cert_curve"] = pub.curve.name
    if pub.curve.name != "secp256r1":
        raise CertificateKeyMismatch(
            "wrong_curve",
            f"the certificate's key is on {pub.curve.name}; ES256 requires "
            f"secp256r1 (P-256). subject={audit['cert_subject']}",
            audit,
        )

    # The challenge. `vault_sign_es256` is the exact callback c2pa-python is
    # about to be handed, so whatever it dispatches to is what signs the
    # claim -- there is no second resolution of the key here that could
    # disagree with the first.
    probe = _KEY_BINDING_PROBE_PREFIX + os.urandom(32)
    raw = vault_sign_es256(probe)
    if len(raw) != 64:
        raise RuntimeError(
            f"signing callback returned {len(raw)} bytes; ES256 raw R||S is 64"
        )
    der = encode_dss_signature(
        int.from_bytes(raw[:32], "big"), int.from_bytes(raw[32:], "big")
    )
    try:
        pub.verify(der, probe, ec.ECDSA(hashes.SHA256()))
    except InvalidSignature:
        raise CertificateKeyMismatch(
            "signature_does_not_verify",
            f"the certificate does not belong to the key that would sign. "
            f"signing_mode={mode}, signer={_identity_for_error()}, "
            f"cert_subject={audit['cert_subject']}, "
            f"cert_spki_sha256={audit['cert_spki_sha256']}. Embedding it "
            f"would produce a credential whose claimSignature no verifier "
            f"can check against the certificate shipped inside it. Point "
            f"SCRUPLE_C2PA_CERT at a certificate issued for this key.",
            audit,
        ) from None

    audit["checked"] = True
    audit["matches"] = True
    return audit


def _identity_for_error() -> str:
    """signer_identity(), but never raising -- this runs inside an error path."""
    try:
        return signer_identity()
    except Exception as e:  # pragma: no cover - defensive
        return f"<identity unavailable: {type(e).__name__}>"
