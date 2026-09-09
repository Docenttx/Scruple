"""WO-E1 — the signer must refuse a certificate it did not sign with.

WO-D7 found the hole (docs/STATE.md §4.3 in the desktop repo): with
SCRUPLE_C2PA_VAULT_KEY_OCID + SCRUPLE_C2PA_KMS_ENDPOINT set, sign.py signed
through the surrogate with one key and embedded keys/signer.pem -- the
certificate issued for the LOCAL key -- because lib/c2pa/signAsset.ts picks
`cert_path` (`?? DEV_CERT`) independently of which key `vault_sign_es256`
dispatches to. The route answered ok:true, and c2pa.Reader answered
['signingCredential.untrusted', 'claimSignature.mismatch']: a credential
nothing can verify, from a call that reported success.

The properties asserted here, and every one has a control that must not fire:

  1. A mismatched pair is REFUSED, with reason `signature_does_not_verify`.
     Control: the matched pair is accepted, in the same mode, over the same
     code path -- so the refusal is about the key and not about the mode.

  2. The refusal survives the kms-http configuration that produced the
     defect, reproduced in-process against a fake OCI-KMS-shaped endpoint.
     Control: the same endpoint with a certificate carrying ITS public key
     is accepted.

  3. An outage is NOT a mismatch. A KMS that cannot be reached raises what
     it raises; it must never be reported as a certificate that does not
     match, because the two have different owners and only one is permanent.

  4. The subject DN is not the test. The dev certificate and the surrogate
     certificate this sandbox issues carry the IDENTICAL Distinguished Name
     (both come from keys/cert.cnf) and differ only in their public key, so
     any check that compared names would have passed the defect through.

  5. sign.py refuses end to end, with code=certificate_key_mismatch, and
     WRITES NO OUTPUT ASSET. Control: the matched pair signs and the result
     carries key_binding.matches true.
"""

from __future__ import annotations

import base64
import importlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, rsa

SIGNER_DIR = Path(__file__).resolve().parent.parent
if str(SIGNER_DIR) not in sys.path:
    sys.path.insert(0, str(SIGNER_DIR))

KEYS = SIGNER_DIR / "keys"
DEV_KEY = KEYS / "signer.key"
DEV_CERT = KEYS / "signer.pem"
REGEN = KEYS / "regen-dev-cert.sh"
SIGN_PY = SIGNER_DIR / "sign.py"

SURROGATE_OCID = "ocid1.key.oc1.us-surrogate-1.surrogate.aaaaaaaaSURROGATEKEYnotarealkey"



def _ensure_dev_material() -> bool:
    """signer.key/signer.pem are gitignored, so a fresh clone has neither.
    Regenerate rather than skip -- a suite that skips itself into green on
    the box that matters is how §4.3 went unnoticed for a fortnight."""
    if DEV_KEY.exists() and DEV_CERT.exists():
        return True
    if not REGEN.exists():
        return False
    try:
        subprocess.run([str(REGEN)], cwd=str(KEYS), check=True,
                       capture_output=True, timeout=120)
    except Exception:
        return False
    return DEV_KEY.exists() and DEV_CERT.exists()


HAVE_KEYS = _ensure_dev_material()
needs_keys = pytest.mark.skipif(
    not HAVE_KEYS, reason="no dev signing material and regen-dev-cert.sh could not run"
)


def _issue(public_key) -> bytes:
    """A leaf+root chain PEM over `public_key`, leaf first.

    Issued by openssl, through keys/cert.cnf, by the same procedure as
    keys/regen-dev-cert.sh and scripts/d7-surrogate-cert.sh -- including
    -force_pubkey, which is how a certificate comes to attest a key this
    process does not hold. It has to be that procedure and not a hand-rolled
    x509.CertificateBuilder: c2pa-rs rejects a self-signed leaf, and rejects
    a leaf whose DN carries fewer than cert.cnf's C/ST/L/O/OU/CN attributes,
    and the symptom of the second is `claimSignature.mismatch` -- the very
    string these tests are about (cert.cnf, isolated 2026-07-12).

    Every leaf therefore carries the SAME Distinguished Name, which is
    property 4 for free: these fixtures differ only in their public key.
    """
    d = Path(tempfile.mkdtemp(prefix="e1-cert-"))
    pub = d / "pub.pem"
    pub.write_bytes(public_key.public_bytes(
        serialization.Encoding.PEM,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    ))
    root_cnf = d / "root.cnf"
    root_cnf.write_text(
        "[req]\ndistinguished_name=d\nprompt=no\n[d]\n[v3_ca]\n"
        "basicConstraints=critical, CA:TRUE\n"
        "keyUsage=critical, keyCertSign, cRLSign\n"
        "subjectKeyIdentifier=hash\n"
    )

    def sh(*args):
        r = subprocess.run(args, capture_output=True, timeout=60)
        assert r.returncode == 0, f"{args[:3]}: {r.stderr.decode()[-300:]}"

    sh("openssl", "ecparam", "-name", "prime256v1", "-genkey", "-noout",
       "-out", str(d / "root.key"))
    sh("openssl", "req", "-new", "-x509", "-key", str(d / "root.key"), "-days", "3650",
       "-subj", "/C=US/ST=CA/L=Somewhere/O=Scruple Test Root CA/OU=FOR TESTING_ONLY/CN=Scruple Test Root CA",
       "-extensions", "v3_ca", "-config", str(root_cnf), "-out", str(d / "root.pem"))
    sh("openssl", "ecparam", "-name", "prime256v1", "-genkey", "-noout",
       "-out", str(d / "throwaway.key"))
    sh("openssl", "req", "-new", "-key", str(d / "throwaway.key"),
       "-out", str(d / "leaf.csr"), "-config", str(KEYS / "cert.cnf"))
    sh("openssl", "x509", "-req", "-in", str(d / "leaf.csr"),
       "-force_pubkey", str(pub), "-CA", str(d / "root.pem"),
       "-CAkey", str(d / "root.key"), "-CAcreateserial", "-days", "365",
       "-extfile", str(KEYS / "cert.cnf"), "-extensions", "v3_req",
       "-out", str(d / "leaf.pem"))
    chain = (d / "leaf.pem").read_bytes() + (d / "root.pem").read_bytes()
    shutil.rmtree(d, ignore_errors=True)
    return chain


@pytest.fixture
def vs(monkeypatch):
    """vault_sign, reloaded, with every mode-selecting variable cleared and
    the module-level signer cache empty."""
    for k in ("SCRUPLE_C2PA_VAULT_KEY_OCID", "SCRUPLE_C2PA_KMS_ENDPOINT",
              "SCRUPLE_C2PA_VAULT_CRYPTO_ENDPOINT", "SCRUPLE_C2PA_LOCAL_KEY_PATH"):
        monkeypatch.delenv(k, raising=False)
    import vault_sign
    importlib.reload(vault_sign)
    return vault_sign


def _local_key(tmp_path, monkeypatch) -> ec.EllipticCurvePrivateKey:
    key = ec.generate_private_key(ec.SECP256R1())
    p = tmp_path / "local.key"
    p.write_bytes(key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ))
    monkeypatch.setenv("SCRUPLE_C2PA_LOCAL_KEY_PATH", str(p))
    return key


# --------------------------------------------------------------- local mode

def test_a_certificate_for_another_key_is_refused(vs, tmp_path, monkeypatch):
    key = _local_key(tmp_path, monkeypatch)
    other = ec.generate_private_key(ec.SECP256R1())
    with pytest.raises(vs.CertificateKeyMismatch) as e:
        vs.assert_certificate_matches_signing_key(_issue(other.public_key()))
    assert e.value.reason == "signature_does_not_verify"
    assert e.value.audit["matches"] is False
    assert e.value.audit["signing_mode"] == "local"
    assert key  # the signing key existed and was usable; the cert was wrong


def test_CONTROL_the_matched_pair_is_accepted(vs, tmp_path, monkeypatch):
    """MUST NOT FIRE. Same mode, same function, same code path -- if this
    refused too, the test above would only be proving the guard says no."""
    key = _local_key(tmp_path, monkeypatch)
    audit = vs.assert_certificate_matches_signing_key(_issue(key.public_key()))
    assert audit["matches"] is True
    assert audit["checked"] is True
    assert audit["method"] == "es256-challenge"
    assert audit["cert_curve"] == "secp256r1"


def test_an_identical_subject_with_a_different_key_is_still_refused(vs, tmp_path, monkeypatch):
    """Property 4. keys/signer.pem and the surrogate leaf carry the SAME DN
    -- both are issued from keys/cert.cnf -- and differ only in the public
    key. A name comparison would have waved the defect straight through."""
    key = _local_key(tmp_path, monkeypatch)
    mine = x509.load_pem_x509_certificate(_issue(key.public_key()))
    theirs_pem = _issue(ec.generate_private_key(ec.SECP256R1()).public_key())
    theirs = x509.load_pem_x509_certificate(theirs_pem)
    assert mine.subject == theirs.subject, "the fixture must share the DN or it tests nothing"
    with pytest.raises(vs.CertificateKeyMismatch) as e:
        vs.assert_certificate_matches_signing_key(theirs_pem)
    assert e.value.reason == "signature_does_not_verify"


def test_a_non_ec_certificate_is_refused_before_any_signature(vs, tmp_path, monkeypatch):
    _local_key(tmp_path, monkeypatch)
    rsa_pub = rsa.generate_private_key(public_exponent=65537, key_size=2048).public_key()
    with pytest.raises(vs.CertificateKeyMismatch) as e:
        vs.assert_certificate_matches_signing_key(_issue(rsa_pub))
    assert e.value.reason == "not_an_ec_key"


def test_a_p384_certificate_is_refused(vs, tmp_path, monkeypatch):
    _local_key(tmp_path, monkeypatch)
    p384 = ec.generate_private_key(ec.SECP384R1()).public_key()
    with pytest.raises(vs.CertificateKeyMismatch) as e:
        vs.assert_certificate_matches_signing_key(_issue(p384))
    assert e.value.reason == "wrong_curve"
    assert e.value.audit["cert_curve"] == "secp384r1"


def test_the_leaf_is_the_certificate_that_is_checked(vs, tmp_path, monkeypatch):
    """The chain PEM is leaf-first, as c2pa-rs requires and as both
    regen-dev-cert.sh and d7-surrogate-cert.sh emit. A chain whose LEAF is
    wrong must be refused even when a later block would have matched."""
    key = _local_key(tmp_path, monkeypatch)
    wrong_leaf = _issue(ec.generate_private_key(ec.SECP256R1()).public_key())
    right_but_second = _issue(key.public_key())
    with pytest.raises(vs.CertificateKeyMismatch):
        vs.assert_certificate_matches_signing_key(wrong_leaf + right_but_second)


# ------------------------------------------------------------ kms-http mode

class _KMS(BaseHTTPRequestHandler):
    key = None
    seen = []

    def log_message(self, *a):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        msg = base64.b64decode(body["message"])
        _KMS.seen.append((msg, body["messageType"]))
        if body["messageType"] == "RAW":
            der = _KMS.key.sign(msg, ec.ECDSA(hashes.SHA256()))
        else:
            from cryptography.hazmat.primitives.asymmetric.utils import Prehashed
            der = _KMS.key.sign(msg, ec.ECDSA(Prehashed(hashes.SHA256())))
        out = json.dumps({"signature": base64.b64encode(der).decode()}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)


@pytest.fixture
def kms():
    _KMS.key = ec.generate_private_key(ec.SECP256R1())
    _KMS.seen = []
    srv = HTTPServer(("127.0.0.1", 0), _KMS)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_address[1]}", _KMS.key
    srv.shutdown()


def test_the_D7_configuration_is_refused(vs, kms, tmp_path, monkeypatch):
    """§4.3, in process: the KMS key signs, a certificate for a DIFFERENT
    key would be embedded. This is the exact pairing that produced
    claimSignature.mismatch from a call that reported success."""
    url, _ = kms
    monkeypatch.setenv("SCRUPLE_C2PA_VAULT_KEY_OCID", SURROGATE_OCID)
    monkeypatch.setenv("SCRUPLE_C2PA_KMS_ENDPOINT", url)
    local_cert = _issue(ec.generate_private_key(ec.SECP256R1()).public_key())
    with pytest.raises(vs.CertificateKeyMismatch) as e:
        vs.assert_certificate_matches_signing_key(local_cert)
    assert e.value.reason == "signature_does_not_verify"
    assert e.value.audit["signing_mode"] == "kms-http"


def test_CONTROL_the_paired_kms_certificate_is_accepted(vs, kms, tmp_path, monkeypatch):
    """MUST NOT FIRE. scripts/d7-surrogate-cert.sh's whole job is to issue
    this certificate; if the guard refused it too, kms-http signing would be
    dead rather than guarded."""
    url, key = kms
    monkeypatch.setenv("SCRUPLE_C2PA_VAULT_KEY_OCID", SURROGATE_OCID)
    monkeypatch.setenv("SCRUPLE_C2PA_KMS_ENDPOINT", url)
    audit = vs.assert_certificate_matches_signing_key(_issue(key.public_key()))
    assert audit["matches"] is True
    assert audit["signing_mode"] == "kms-http"


def test_CONTROL_an_unreachable_kms_is_not_reported_as_a_mismatch(vs, monkeypatch):
    """MUST NOT FIRE as a mismatch. `the signer is down` and `the
    certificate is for another key` are different facts with different
    owners; only the second is permanent, and a guard that collapsed them
    would send an operator to rewrite a certificate over an outage."""
    import socket
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    dead = f"http://127.0.0.1:{s.getsockname()[1]}"
    s.close()
    monkeypatch.setenv("SCRUPLE_C2PA_VAULT_KEY_OCID", SURROGATE_OCID)
    monkeypatch.setenv("SCRUPLE_C2PA_KMS_ENDPOINT", dead)
    cert = _issue(ec.generate_private_key(ec.SECP256R1()).public_key())
    with pytest.raises(Exception) as e:
        vs.assert_certificate_matches_signing_key(cert)
    assert not isinstance(e.value, vs.CertificateKeyMismatch), (
        f"an unreachable KMS was reported as a certificate mismatch: {e.value!r}"
    )


def test_CONTROL_a_missing_local_key_is_not_reported_as_a_mismatch(vs, tmp_path, monkeypatch):
    """MUST NOT FIRE as a mismatch. LocalKeyMissing already exists to say
    this; the guard must not overwrite it with a wrong diagnosis."""
    monkeypatch.setenv("SCRUPLE_C2PA_LOCAL_KEY_PATH", str(tmp_path / "nope.key"))
    cert = _issue(ec.generate_private_key(ec.SECP256R1()).public_key())
    with pytest.raises(vs.LocalKeyMissing):
        vs.assert_certificate_matches_signing_key(cert)


def test_the_probe_is_domain_separated_from_a_cose_signature(vs):
    """A COSE Sig_structure begins b'\\x84\\x6aSignature1'. The probe cannot
    be one, so a probe signature can never be replayed as a claim
    signature."""
    assert not vs._KEY_BINDING_PROBE_PREFIX.startswith(b"\x84\x6aSignature1")
    assert vs._KEY_BINDING_PROBE_PREFIX.startswith(b"scruple.c2pa.key-binding-probe.")


# ------------------------------------------------------- sign.py, end to end

def _run_sign(job: dict, env: dict) -> dict:
    e = dict(os.environ)
    e.pop("SCRUPLE_C2PA_VAULT_KEY_OCID", None)
    e.pop("SCRUPLE_C2PA_KMS_ENDPOINT", None)
    e.pop("SCRUPLE_C2PA_LOCAL_KEY_PATH", None)
    e.update(env)
    proc = subprocess.run(
        [sys.executable, str(SIGN_PY)], input=json.dumps(job), text=True,
        capture_output=True, timeout=180, cwd=str(SIGNER_DIR), env=e,
    )
    start, end = proc.stdout.find("{"), proc.stdout.rfind("}")
    assert start != -1, f"no JSON from sign.py: {proc.stdout!r} {proc.stderr[-400:]!r}"
    return json.loads(proc.stdout[start:end + 1])


def _png(path: Path) -> Path:
    import struct
    import zlib
    raw = b"".join(b"\x00" + bytes((5, 9, 13)) * 8 for _ in range(8))

    def chunk(t, d):
        b = t + d
        return struct.pack(">I", len(d)) + b + struct.pack(">I", zlib.crc32(b) & 0xffffffff)

    path.write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", 8, 8, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw))
        + chunk(b"IEND", b"")
    )
    return path


def _job(src: Path, out: Path, cert: Path, key: Path | None) -> dict:
    return {
        "asset_path": str(src),
        "output_path": str(out),
        "cert_path": str(cert),
        **({"key_path": str(key)} if key else {}),
        "manifest": {"claim_generator": "Scruple/0.1", "format": "image/png",
                     "title": "e1", "assertions": []},
        "intent": "CREATE",
        "digital_source_type": "DIGITAL_CREATION",
        "actions": [],
    }


@needs_keys
def test_sign_py_refuses_a_mismatched_pair_and_writes_nothing(tmp_path):
    pytest.importorskip("c2pa", reason="c2pa-python not installed")
    src = _png(tmp_path / "in.png")
    out = tmp_path / "out.png"
    stranger = ec.generate_private_key(ec.SECP256R1())
    cert = tmp_path / "stranger.pem"
    cert.write_bytes(_issue(stranger.public_key()))

    res = _run_sign(_job(src, out, cert, DEV_KEY), {"SCRUPLE_C2PA_DEV": "1"})
    assert res["ok"] is False
    assert res["code"] == "certificate_key_mismatch"
    assert res["key_binding"]["reason"] == "signature_does_not_verify"
    assert not out.exists(), "a refusal must leave no output asset behind"


@needs_keys
def test_CONTROL_sign_py_still_signs_the_matched_dev_pair(tmp_path):
    """MUST NOT FIRE. Local-key signing with the local certificate is the
    path every existing suite uses; the guard must not have closed it."""
    pytest.importorskip("c2pa", reason="c2pa-python not installed")
    src = _png(tmp_path / "in.png")
    out = tmp_path / "out.png"
    res = _run_sign(_job(src, out, DEV_CERT, DEV_KEY), {"SCRUPLE_C2PA_DEV": "1"})
    assert res["ok"] is True, res
    assert res["key_binding"]["matches"] is True
    assert res["key_binding"]["signing_mode"] == "local"
    assert out.exists() and out.stat().st_size > src.stat().st_size


@needs_keys
def test_sign_py_refuses_the_D7_pairing_against_a_fake_kms(tmp_path, kms):
    """The whole §4.3 configuration, through the subprocess: a KMS key
    signs and the LOCAL certificate would be embedded."""
    pytest.importorskip("c2pa", reason="c2pa-python not installed")
    url, _ = kms
    src = _png(tmp_path / "in.png")
    out = tmp_path / "out.png"
    res = _run_sign(_job(src, out, DEV_CERT, None), {
        "SCRUPLE_C2PA_DEV": "1",
        "SCRUPLE_C2PA_VAULT_KEY_OCID": SURROGATE_OCID,
        "SCRUPLE_C2PA_KMS_ENDPOINT": url,
    })
    assert res["ok"] is False
    assert res["code"] == "certificate_key_mismatch"
    assert res["key_binding"]["signing_mode"] == "kms-http"
    assert not out.exists()


@needs_keys
def test_CONTROL_sign_py_signs_against_a_kms_whose_certificate_matches(tmp_path, kms):
    """MUST NOT FIRE. Same KMS, same subprocess, a certificate carrying its
    public key -- which is what scripts/d7-surrogate-cert.sh issues."""
    pytest.importorskip("c2pa", reason="c2pa-python not installed")
    url, key = kms
    src = _png(tmp_path / "in.png")
    out = tmp_path / "out.png"
    cert = tmp_path / "kms.pem"
    cert.write_bytes(_issue(key.public_key()))
    res = _run_sign(_job(src, out, cert, None), {
        "SCRUPLE_C2PA_DEV": "1",
        "SCRUPLE_C2PA_VAULT_KEY_OCID": SURROGATE_OCID,
        "SCRUPLE_C2PA_KMS_ENDPOINT": url,
    })
    assert res["ok"] is True, res
    assert res["key_binding"]["matches"] is True
    assert res["signing_mode"] == "kms-http"
    assert out.exists()


@needs_keys
def test_the_probe_signs_first_and_the_claim_signs_last(tmp_path, kms):
    """Order matters, and it is asserted off the KMS's own record.

    vault_sign keeps `_kms_last_message_type` from the LAST signature it
    made, and signer_identity() reports it. That value is not a log line:
    sign.py returns it, and app/api/scruple/c2pa/sign/route.ts folds it into
    the canonical payload whose sha256 becomes a witness leaf. A probe that
    ran after the claim -- or a probe counted as the claim -- would commit a
    false statement about how the signature was produced into an append-only
    record, which is the failure signer_identity()'s docstring is about.

    So: exactly two signatures, the probe first and identifiable by its
    domain-separation prefix, the claim last and not.
    """
    pytest.importorskip("c2pa", reason="c2pa-python not installed")
    url, key = kms
    src = _png(tmp_path / "in.png")
    out = tmp_path / "out.png"
    cert = tmp_path / "kms.pem"
    cert.write_bytes(_issue(key.public_key()))
    res = _run_sign(_job(src, out, cert, None), {
        "SCRUPLE_C2PA_DEV": "1",
        "SCRUPLE_C2PA_VAULT_KEY_OCID": SURROGATE_OCID,
        "SCRUPLE_C2PA_KMS_ENDPOINT": url,
    })
    assert res["ok"] is True, res

    import vault_sign
    prefix = vault_sign._KEY_BINDING_PROBE_PREFIX
    msgs = [m for m, _ in _KMS.seen]
    assert len(msgs) == 2, f"expected probe + claim, got {len(msgs)} signatures"
    assert msgs[0].startswith(prefix), "the probe did not go first"
    assert not msgs[-1].startswith(prefix), "the probe had the last word"
    assert msgs[-1].startswith(b"\x84\x6aSignature1"), (
        "the last signature was not a COSE Sig_structure, so it was not the claim"
    )
