#!/usr/bin/env python3
"""Sign a witness leaf hash with the SAME key that signs C2PA manifests.

WHY THIS IS A THIN WRAPPER AND NOT A NEW CLIENT

`vault_sign.py` already talks to OCI Vault KMS with instance-principal
auth, and it is not theoretical code: it signed the 33 conformance
samples on the production Signer CVM for the GPSA v3 resubmission. Every
hard part — the federation handshake, request signing, the DER-to-raw
conversion — is proven there, in the context that matters.

Writing a second implementation in another language would mean a second
thing to get right, a second thing to keep right, and almost certainly a
second key.

That last point is the real argument. Standard §2 says Scruple witnesses
workflow events and the integration itself "through the SAME signing
key". With a separate witness signer that sentence stays aspirational.
Routing leaf signatures through this wrapper, against the same
SCRUPLE_C2PA_VAULT_KEY_OCID, makes it literally true.

USAGE

    python3 sign_leaf.py <leaf_hash_hex>
    echo <leaf_hash_hex> | python3 sign_leaf.py
    python3 sign_leaf.py --pubkey          # emit the verifying key (local mode)

Output is one JSON object on stdout:

    {
      "signature":     base64 of the DER-encoded ECDSA signature,
      "signature_raw": base64 of the 64-byte R||S form,
      "alg":           "ECDSA_SHA_256",
      "mode":          "vault" | "local",
      "key_id":        the OCI key OCID, or "local:<path>"
    }

DER is the primary form because a verifier should be able to check it
with any standard library. The raw R||S form is included because that is
what c2pa-python's Signer.from_callback consumes, and emitting both here
means neither caller has to know about the other's convention.

Failures print JSON to stderr and exit non-zero. The caller must treat a
non-zero exit as "no signature", never as "signature unknown" — a leaf
without a signature is honestly unverifiable, and that is a state the
witness records rather than hides.

EXIT CODES — a configuration fault is not a signing outage

    0  signed
    1  signing failed (transient, or the key is real and the signature
       still did not come back)
    2  bad input — not a 64-character hex leaf hash
    3  MISCONFIGURED: local mode and there is no key on disk

3 exists because the two states need different reactions and the caller
cannot tell them apart from a bare non-zero exit. From 2026-07-13 to
2026-09-02 this script's local-mode default named a key that had been
purged from the repository, and services/witness-server/leaf_signer.js
sets no override — so in `vault-py` mode with no Vault OCID, EVERY leaf
signature failed, every one was swallowed into resolve(null), and every
leaf was recorded as not independently verifiable. Which was true, and
told nobody anything. CANON_SKELETON D-10 (§7): a failed Phase-3
operation surfaces; it is never silently dropped.

The default now resolves through vault_sign.local_key_path(), the one
resolver, so the common case simply works. When it genuinely cannot, the
error carries a `code` and a `key_path` and says outright that retrying
will not help.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from cryptography.hazmat.primitives import serialization  # noqa: E402
from cryptography.hazmat.primitives.asymmetric.utils import (  # noqa: E402
    encode_dss_signature,
)

import vault_sign  # noqa: E402

ALG = "ECDSA_SHA_256"


def _key_id() -> str:
    ocid = os.environ.get("SCRUPLE_C2PA_VAULT_KEY_OCID")
    if ocid:
        return ocid
    # vault_sign.signer_identity() already prefixes local: so a local-mode
    # key can never be mistaken for an OCI OCID in a log line or a
    # database column, and it names the key that ACTUALLY signed rather
    # than the one this process would pick if asked again.
    return vault_sign.signer_identity()


def _public_key_pem() -> str:
    """The verifying key, in local mode.

    In vault mode the private key never leaves OCI and the public half
    comes from the KMS management API, not from here — so this refuses
    rather than guessing.
    """
    if vault_sign.signing_mode() == "vault":
        raise RuntimeError(
            "In vault mode the public key comes from the OCI KMS management "
            "API (GetKeyVersion), not from this process. Configure the "
            "witness with SCRUPLE_WITNESS_KMS_PUBKEY_URL instead."
        )
    key_path = vault_sign.local_key_path()
    if not key_path.exists():
        raise vault_sign.LocalKeyMissing(key_path)
    priv = serialization.load_pem_private_key(key_path.read_bytes(), password=None)
    return priv.public_key().public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode()


def main(argv: list[str]) -> int:
    if "--pubkey" in argv:
        try:
            sys.stdout.write(_public_key_pem())
            return 0
        except vault_sign.LocalKeyMissing as e:
            json.dump(
                {"error": str(e), "code": "local_key_missing",
                 "key_path": str(e.key_path), "retryable": False},
                sys.stderr,
            )
            return 3
        except Exception as e:
            json.dump({"error": str(e), "code": "pubkey_failed"}, sys.stderr)
            return 1

    args = [a for a in argv[1:] if not a.startswith("-")]
    leaf_hex = (args[0] if args else sys.stdin.read()).strip()

    if len(leaf_hex) != 64 or any(c not in "0123456789abcdef" for c in leaf_hex.lower()):
        json.dump(
            {"error": f"expected a 64-character hex leaf hash, got {len(leaf_hex)} chars"},
            sys.stderr,
        )
        return 2

    try:
        raw = vault_sign.vault_sign_es256(bytes.fromhex(leaf_hex))
    except vault_sign.LocalKeyMissing as e:
        # Loud, and distinguishable. This is not a signing outage that a
        # retry might clear — it is a box configured so that no leaf will
        # ever be signed. Exit 3, a machine-readable code, and a line on
        # stderr that says so in words for whoever is reading the journal.
        sys.stderr.write(
            "[sign_leaf] MISCONFIGURED: no local signing key. EVERY witness "
            "leaf will be recorded UNSIGNED until this is fixed. Retrying "
            "will not help.\n"
        )
        json.dump(
            {
                "error": str(e),
                "code": "local_key_missing",
                "key_path": str(e.key_path),
                "mode": vault_sign.signing_mode(),
                "retryable": False,
            },
            sys.stderr,
        )
        return 3
    except Exception as e:
        # Deliberately not swallowed into a zero exit. The witness treats a
        # non-zero exit as "no signature" and records the leaf as not
        # independently verifiable, which is the truth.
        json.dump(
            {
                "error": f"signing failed: {e}",
                "code": "signing_failed",
                "mode": vault_sign.signing_mode(),
                "retryable": True,
            },
            sys.stderr,
        )
        return 1

    if len(raw) != 64:
        json.dump({"error": f"signer returned {len(raw)} bytes, expected 64"}, sys.stderr)
        return 1

    import base64

    r = int.from_bytes(raw[:32], "big")
    s = int.from_bytes(raw[32:], "big")
    der = encode_dss_signature(r, s)

    json.dump(
        {
            "signature": base64.b64encode(der).decode("ascii"),
            "signature_raw": base64.b64encode(raw).decode("ascii"),
            "alg": ALG,
            "mode": vault_sign.signing_mode(),
            "key_id": _key_id(),
        },
        sys.stdout,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
