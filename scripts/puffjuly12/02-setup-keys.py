"""Generate the two puffjuly12 signing keys — ES256 for c2pa + Ed25519 for witness checkpoint.

Uses cryptography library, not SoftHSM/pkcs11 (API friction). The L2 attestation
story is that in production these keys are held inside a SoftHSM in a SEV-SNP
CVM (proven separately by docs/l2-evidence/2026-07-12T174954Z/).

Produces + saves both keys PLUS a proper c2pa cert chain over the ES256 pubkey
(root CA → leaf, full C/ST/L/O/OU/CN DN, EKU=critical emailProtection,
KU=digitalSignature+nonRepudiation — matching the fixed cert.cnf profile).
"""
import hashlib
from datetime import datetime, timezone, timedelta
from pathlib import Path

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography import x509
from cryptography.x509.oid import NameOID, ObjectIdentifier

KEYS = Path("/tmp/puffjuly12/keys")
KEYS.mkdir(parents=True, exist_ok=True)


def dn(cn: str, o: str) -> x509.Name:
    return x509.Name([
        x509.NameAttribute(NameOID.COUNTRY_NAME, "US"),
        x509.NameAttribute(NameOID.STATE_OR_PROVINCE_NAME, "CA"),
        x509.NameAttribute(NameOID.LOCALITY_NAME, "Somewhere"),
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, o),
        x509.NameAttribute(NameOID.ORGANIZATIONAL_UNIT_NAME, "PUFFJULY12_L2_DEMO"),
        x509.NameAttribute(NameOID.COMMON_NAME, cn),
    ])


def build_cert(subj, iss, pub, sign_key, is_ca: bool):
    now = datetime.now(timezone.utc)
    b = (x509.CertificateBuilder()
         .subject_name(subj).issuer_name(iss).public_key(pub)
         .serial_number(x509.random_serial_number())
         .not_valid_before(now - timedelta(minutes=10))
         .not_valid_after(now + timedelta(days=365))
         .add_extension(x509.BasicConstraints(ca=is_ca, path_length=None), critical=True)
         .add_extension(x509.SubjectKeyIdentifier.from_public_key(pub), critical=False))
    if not is_ca:
        b = b.add_extension(x509.KeyUsage(digital_signature=True, content_commitment=True, key_encipherment=False,
                                          data_encipherment=False, key_agreement=False, key_cert_sign=False,
                                          crl_sign=False, encipher_only=False, decipher_only=False), critical=True)
        b = b.add_extension(x509.ExtendedKeyUsage([ObjectIdentifier("1.3.6.1.5.5.7.3.4")]), critical=True)
        b = b.add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(sign_key.public_key()), critical=False)
    else:
        b = b.add_extension(x509.KeyUsage(digital_signature=True, content_commitment=False, key_encipherment=False,
                                          data_encipherment=False, key_agreement=False, key_cert_sign=True,
                                          crl_sign=True, encipher_only=False, decipher_only=False), critical=True)
    return b.sign(sign_key, hashes.SHA256())


# ------ ES256 for C2PA ------
c2pa_priv = ec.generate_private_key(ec.SECP256R1())
c2pa_pub = c2pa_priv.public_key()

ca_priv = ec.generate_private_key(ec.SECP256R1())
root = build_cert(dn("puffjuly12 Root CA", "Scruple puffjuly12 Root CA"),
                  dn("puffjuly12 Root CA", "Scruple puffjuly12 Root CA"),
                  ca_priv.public_key(), ca_priv, True)
leaf = build_cert(dn("puffjuly12 C2PA Signer", "Scruple puffjuly12 Signing Cert"),
                  dn("puffjuly12 Root CA", "Scruple puffjuly12 Root CA"),
                  c2pa_pub, ca_priv, False)

(KEYS / "c2pa-es256.pem").write_bytes(c2pa_priv.private_bytes(
    serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
(KEYS / "c2pa-es256-pubkey.pem").write_bytes(c2pa_pub.public_bytes(
    serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo))
(KEYS / "c2pa-signer-leaf.pem").write_bytes(leaf.public_bytes(serialization.Encoding.PEM))
(KEYS / "c2pa-root-ca.pem").write_bytes(root.public_bytes(serialization.Encoding.PEM))
(KEYS / "c2pa-cert-chain.pem").write_bytes(
    leaf.public_bytes(serialization.Encoding.PEM) + root.public_bytes(serialization.Encoding.PEM))
c2pa_pub_der = c2pa_pub.public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
(KEYS / "c2pa-es256-pubkey-sha256.txt").write_text(hashlib.sha256(c2pa_pub_der).hexdigest() + "\n")

# ------ Ed25519 for witness checkpoint ------
w_priv = Ed25519PrivateKey.generate()
w_pub = w_priv.public_key()
(KEYS / "witness-ed25519.pem").write_bytes(w_priv.private_bytes(
    serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
(KEYS / "witness-ed25519-pubkey.pem").write_bytes(w_pub.public_bytes(
    serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo))
w_pub_der = w_pub.public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
(KEYS / "witness-ed25519-pubkey-sha256.txt").write_text(hashlib.sha256(w_pub_der).hexdigest() + "\n")

print(f"c2pa ES256 pubkey SHA-256: {hashlib.sha256(c2pa_pub_der).hexdigest()}")
print(f"witness Ed25519 pubkey SHA-256: {hashlib.sha256(w_pub_der).hexdigest()}")
print(f"\nfiles in {KEYS}:")
for p in sorted(KEYS.iterdir()):
    print(f"  {p.name} ({p.stat().st_size} bytes)")
