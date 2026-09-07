"""Mint a C2PA leaf certificate over the CVM surrogate's PUBLIC key.

WO-B6. `sign.py` in kms-http mode never sees a private key: the surrogate
holds it and answers `/20180608/sign`. c2pa-rs still needs a certificate
chain, and the chain has to bind the key that will actually sign or the
manifest fails `claimSignature.mismatch` at readback -- which is the
correct failure, and is the control this file is checked by.

So: fetch `/testnet/pubkey.pem` from the surrogate, issue a leaf
certificate over THAT public key, signed by a scratch root CA whose key
is generated here and thrown away with the sandbox.

WHAT THE CERT SAYS ABOUT WHAT PROTECTED THE KEY -- NOTHING, DELIBERATELY.
A certificate cannot attest to key custody, and the surrogate reports
`protectionMode: SOFTWARE` truthfully. The OU therefore reads
CVM_SURROGATE_SOFTWARE_KEY so a human reading `openssl x509 -subject`
cannot mistake it, and `surrogate_key_metadata()` returns the mode the
surrogate itself reports rather than one this file asserts.

The extension profile is copied from services/c2pa-signer/keys/cert.cnf,
including the full C/ST/L/O/OU/CN DN: c2pa-rs rejects a CN-only DN with
`claimSignature.mismatch`, and rejects a self-signed leaf outright. Both
were isolated 2026-07-12 and both are why there is a root CA here at all.
"""

from __future__ import annotations

import datetime as _dt
import json
import os
import urllib.request
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

SURROGATE = os.environ.get("SCRUPLE_CVM_SURROGATE", "http://127.0.0.1:8799")

#: The key the surrogate signs with, from services/cvm-surrogate/surrogate.py.
SURROGATE_KEY_OCID = os.environ.get(
    "SCRUPLE_C2PA_VAULT_KEY_OCID",
    "ocid1.key.oc1.us-surrogate-1.surrogate.aaaaaaaaSURROGATEKEYnotarealkey",
)


def surrogate_public_key() -> ec.EllipticCurvePublicKey:
    """The verifying half of the key that will sign. Fetched, never assumed."""
    pem = urllib.request.urlopen(f"{SURROGATE}/testnet/pubkey.pem", timeout=15).read()
    key = serialization.load_pem_public_key(pem)
    if not isinstance(key, ec.EllipticCurvePublicKey):
        raise RuntimeError(f"surrogate published a {type(key).__name__}, not an EC key")
    return key


def surrogate_key_metadata() -> dict:
    """What the surrogate says about the key, in its own words.

    `protectionMode` comes back SOFTWARE. Recorded from the wire so no
    part of this run can claim hardware backing on a key nobody claimed
    was hardware-backed.
    """
    url = f"{SURROGATE}/20180608/keys/{SURROGATE_KEY_OCID}"
    return json.loads(urllib.request.urlopen(url, timeout=15).read())


def _name(org: str, cn: str) -> x509.Name:
    # Every attribute cert.cnf lists. A shorter DN passes the cert
    # validator and then fails the signature check, which reads as
    # tampering.
    return x509.Name([
        x509.NameAttribute(NameOID.COUNTRY_NAME, "US"),
        x509.NameAttribute(NameOID.STATE_OR_PROVINCE_NAME, "CA"),
        x509.NameAttribute(NameOID.LOCALITY_NAME, "Somewhere"),
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, org),
        x509.NameAttribute(NameOID.ORGANIZATIONAL_UNIT_NAME, "CVM_SURROGATE_SOFTWARE_KEY"),
        x509.NameAttribute(NameOID.COMMON_NAME, cn),
    ])


def mint(out_dir: str) -> dict:
    """Write `surrogate-chain.pem` (leaf, then root) into `out_dir`."""
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)

    leaf_pub = surrogate_public_key()
    meta = surrogate_key_metadata()

    now = _dt.datetime.now(_dt.timezone.utc)
    root_key = ec.generate_private_key(ec.SECP256R1())
    root_name = _name("Scruple B6 Surrogate Root CA", "Scruple B6 Surrogate Root CA")
    root = (
        x509.CertificateBuilder()
        .subject_name(root_name)
        .issuer_name(root_name)
        .public_key(root_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - _dt.timedelta(minutes=5))
        .not_valid_after(now + _dt.timedelta(days=365))
        .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
        .add_extension(
            x509.KeyUsage(
                digital_signature=False, content_commitment=False, key_encipherment=False,
                data_encipherment=False, key_agreement=False, key_cert_sign=True,
                crl_sign=True, encipher_only=False, decipher_only=False,
            ),
            critical=True,
        )
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(root_key.public_key()), critical=False)
        .sign(root_key, hashes.SHA256())
    )

    leaf = (
        x509.CertificateBuilder()
        .subject_name(_name("Scruple B6 Surrogate Signing Cert", "Scruple CVM Surrogate Signer"))
        .issuer_name(root_name)
        # THE POINT OF THE WHOLE FILE: the surrogate's public key, so the
        # signature the surrogate produces is the one this cert vouches for.
        .public_key(leaf_pub)
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - _dt.timedelta(minutes=5))
        .not_valid_after(now + _dt.timedelta(days=90))
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(
            x509.ExtendedKeyUsage([ExtendedKeyUsageOID.EMAIL_PROTECTION]), critical=True
        )
        .add_extension(
            x509.KeyUsage(
                digital_signature=True, content_commitment=True, key_encipherment=False,
                data_encipherment=False, key_agreement=False, key_cert_sign=False,
                crl_sign=False, encipher_only=False, decipher_only=False,
            ),
            critical=True,
        )
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(leaf_pub), critical=False)
        # c2pa-rs refuses a leaf with no AuthorityKeyIdentifier -- "Signature:
        # the certificate is invalid", raised at sign time, before any
        # signature is computed. `openssl x509 -req` emits AKI by default and
        # the dev chain therefore has one, which is why nothing in
        # regen-dev-cert.sh mentions it. Measured 2026-09-07: the identical
        # chain minus this one extension fails, with it succeeds.
        .add_extension(
            x509.AuthorityKeyIdentifier.from_issuer_public_key(root_key.public_key()),
            critical=False,
        )
        .sign(root_key, hashes.SHA256())
    )

    chain = out / "surrogate-chain.pem"
    chain.write_bytes(
        leaf.public_bytes(serialization.Encoding.PEM)
        + root.public_bytes(serialization.Encoding.PEM)
    )
    (out / "surrogate-root.pem").write_bytes(root.public_bytes(serialization.Encoding.PEM))
    (out / "surrogate-pub.pem").write_bytes(
        leaf_pub.public_bytes(
            serialization.Encoding.PEM,
            serialization.PublicFormat.SubjectPublicKeyInfo,
        )
    )

    info = {
        "chain_path": str(chain),
        "leaf_subject": leaf.subject.rfc4514_string(),
        "leaf_issuer": leaf.issuer.rfc4514_string(),
        "leaf_serial": str(leaf.serial_number),
        "key_ocid": SURROGATE_KEY_OCID,
        # Straight off the wire. Never a literal typed here.
        "surrogate_protection_mode": meta.get("protectionMode"),
        "surrogate_key_algorithm": meta.get("algorithm"),
        "surrogate_curve": meta.get("curveId"),
        "hardware_backed": False,
        "hardware_backed_basis": (
            f"the surrogate reports protectionMode={meta.get('protectionMode')!r} for "
            f"{SURROGATE_KEY_OCID}. A certificate cannot attest key custody, so nothing "
            "in this chain claims any."
        ),
    }
    # Written beside the chain so the harness reads the protection mode
    # off the wire rather than off a literal in its own source.
    (out / "chain-info.json").write_text(json.dumps(info, indent=2))
    return info


if __name__ == "__main__":
    import sys
    print(json.dumps(mint(sys.argv[1] if len(sys.argv) > 1 else "."), indent=2))
