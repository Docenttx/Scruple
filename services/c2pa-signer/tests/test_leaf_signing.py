"""The local signing key, its identity, and what happens when it is gone.

THREE DEFECTS, ONE SHAPE

Until 2026-09-02 four call sites each resolved the local key path for
themselves, all against a name `0b6ee43` purged from the repository on
2026-07-13:

  - vault_sign.py's local-mode default
  - vault_sign.py's signer_identity(), which returned it as a literal
  - sign_leaf.py's _key_id()
  - sign_leaf.py's _public_key_pem()

`sign.py` happened to set SCRUPLE_C2PA_LOCAL_KEY_PATH from the job spec,
which is the only reason C2PA signing worked at all. Nothing sets it for
`sign_leaf.py`, and `services/witness-server/leaf_signer.js` shells out to
it without one — so in `vault-py` mode with no Vault OCID, EVERY witness
leaf signature failed and was swallowed into `resolve(null)`.

These tests pin all three halves: one resolver, a real identity, and a
failure that is loud and typed.

THE IDENTITY IS NOT A LOG LINE

`signer_identity()` reaches a witness leaf: sign.py returns it,
signAsset.ts passes it through, and app/api/scruple/c2pa/sign/route.ts
folds it into the canonical payload whose sha256 becomes the leaf's
payload_hash. Only the hash is stored, so a wrong value is committed into
an append-only chain, is invisible there, and cannot be corrected — and a
verifier recomputing the payload with the true identity gets a mismatch,
which reads as tampering. Hence: the real key, or a refusal.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
SIGNER_DIR = os.path.dirname(HERE)
sys.path.insert(0, SIGNER_DIR)

import vault_sign  # noqa: E402

SIGN_LEAF = os.path.join(SIGNER_DIR, "sign_leaf.py")
KEYS = os.path.join(SIGNER_DIR, "keys")
KEY = os.path.join(KEYS, "signer.key")
LEAF = "a" * 64


def _run(args, env_overrides):
    env = dict(os.environ)
    env.pop("SCRUPLE_C2PA_VAULT_KEY_OCID", None)
    env.pop("SCRUPLE_C2PA_LOCAL_KEY_PATH", None)
    # Never let a test reach the live witness at 127.0.0.1:5799.
    env["WITNESS_SERVER_URL"] = "http://127.0.0.1:1"
    env.update({k: v for k, v in env_overrides.items() if v is not None})
    return subprocess.run(
        [sys.executable, SIGN_LEAF, *args], env=env, capture_output=True, text=True, timeout=60
    )


class TestPurgedKeyNameIsGone:
    def test_no_source_file_names_the_purged_key(self):
        """The acceptance criterion, as a test. `grep` in CI form."""
        offenders = []
        for name in sorted(os.listdir(SIGNER_DIR)):
            if not name.endswith(".py"):
                continue
            with open(os.path.join(SIGNER_DIR, name), encoding="utf-8") as fh:
                if "es256.pem" in fh.read():
                    offenders.append(name)
        assert not offenders, (
            f"{offenders} still name a key purged from git on 2026-07-13. "
            f"Resolve through vault_sign.local_key_path()."
        )

    def test_there_is_exactly_one_resolver(self):
        """Nothing may re-derive the key path. Four copies is how the same
        defect landed four times."""
        offenders = []
        for name in sorted(os.listdir(SIGNER_DIR)):
            if not name.endswith(".py") or name == "vault_sign.py":
                continue
            with open(os.path.join(SIGNER_DIR, name), encoding="utf-8") as fh:
                src = fh.read()
            if 'os.environ.get(\n        "SCRUPLE_C2PA_LOCAL_KEY_PATH"' in src or (
                '"SCRUPLE_C2PA_LOCAL_KEY_PATH",' in src and "local_key_path" not in src
            ):
                offenders.append(name)
        assert not offenders, (
            f"{offenders} resolve SCRUPLE_C2PA_LOCAL_KEY_PATH independently "
            f"instead of calling vault_sign.local_key_path()."
        )


class TestSignerIdentity:
    def test_names_the_key_that_actually_signed(self):
        os.environ.pop("SCRUPLE_C2PA_VAULT_KEY_OCID", None)
        os.environ["SCRUPLE_C2PA_LOCAL_KEY_PATH"] = KEY
        vault_sign._cached_signer = None
        vault_sign._active_local_key = None
        try:
            vault_sign.vault_sign_es256(b"\x11" * 32)
            identity = vault_sign.signer_identity()
        finally:
            vault_sign._cached_signer = None
            vault_sign._active_local_key = None
            os.environ.pop("SCRUPLE_C2PA_LOCAL_KEY_PATH", None)
        assert identity == f"local:{os.path.realpath(KEY)}"
        assert "es256" not in identity

    def test_refuses_rather_than_naming_an_absent_file(self, tmp_path):
        os.environ.pop("SCRUPLE_C2PA_VAULT_KEY_OCID", None)
        os.environ["SCRUPLE_C2PA_LOCAL_KEY_PATH"] = str(tmp_path / "gone.key")
        vault_sign._cached_signer = None
        vault_sign._active_local_key = None
        try:
            with pytest.raises(vault_sign.LocalKeyMissing):
                vault_sign.signer_identity()
        finally:
            os.environ.pop("SCRUPLE_C2PA_LOCAL_KEY_PATH", None)

    def test_vault_mode_is_masked(self):
        os.environ["SCRUPLE_C2PA_VAULT_KEY_OCID"] = "ocid1.key.oc1.iad.abcdefgh12345678"
        try:
            assert vault_sign.signer_identity() == "vault:...12345678"
        finally:
            os.environ.pop("SCRUPLE_C2PA_VAULT_KEY_OCID", None)


class TestLeafSigningInLocalMode:
    def test_signs_with_no_env_var_at_all(self):
        """The regression pin. This is the exact invocation
        services/witness-server/leaf_signer.js makes, and it returned
        {"error": "signing failed: [Errno 2] No such file or directory"}
        every time from 2026-07-13 to 2026-09-02."""
        if not os.path.exists(KEY):
            pytest.skip("no dev signing material on this box")
        r = _run([LEAF], {})
        assert r.returncode == 0, r.stderr
        out = json.loads(r.stdout)
        assert out["alg"] == "ECDSA_SHA_256"
        assert out["mode"] == "local"
        assert out["signature"] and out["signature_raw"]
        assert out["key_id"] == f"local:{os.path.realpath(KEY)}"

    def test_missing_key_is_loud_typed_and_exit_3(self, tmp_path):
        """CANON_SKELETON D-10 (§7): a failed Phase-3 operation surfaces.
        Not a bare non-zero exit the caller cannot classify."""
        r = _run([LEAF], {"SCRUPLE_C2PA_LOCAL_KEY_PATH": str(tmp_path / "gone.key")})
        assert r.returncode == 3, (r.returncode, r.stderr)
        assert r.stdout == "", "a failed sign must put nothing on stdout"
        assert "MISCONFIGURED" in r.stderr
        assert "UNSIGNED" in r.stderr
        payload = json.loads(r.stderr[r.stderr.index("{") :])
        assert payload["code"] == "local_key_missing"
        assert payload["retryable"] is False
        assert payload["key_path"] == str(tmp_path / "gone.key")

    def test_a_transient_failure_stays_retryable_and_distinct(self, tmp_path):
        """The control: not every failure is a misconfiguration. A key
        that exists but is not an EC key must NOT claim exit 3, or the
        loud banner stops meaning anything."""
        bad = tmp_path / "notakey.key"
        bad.write_text("-----BEGIN PRIVATE KEY-----\nnope\n-----END PRIVATE KEY-----\n")
        r = _run([LEAF], {"SCRUPLE_C2PA_LOCAL_KEY_PATH": str(bad)})
        assert r.returncode == 1, (r.returncode, r.stderr)
        payload = json.loads(r.stderr[r.stderr.index("{") :])
        assert payload["code"] == "signing_failed"
        assert payload["retryable"] is True

    def test_bad_leaf_hash_is_exit_2(self):
        r = _run(["deadbeef"], {})
        assert r.returncode == 2
        assert "64-character hex" in r.stderr

    def test_pubkey_uses_the_same_resolver(self):
        if not os.path.exists(KEY):
            pytest.skip("no dev signing material on this box")
        r = _run(["--pubkey"], {})
        assert r.returncode == 0, r.stderr
        assert r.stdout.startswith("-----BEGIN PUBLIC KEY-----")
