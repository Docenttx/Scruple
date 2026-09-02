"""Every format we advertise is signed here, against a real fixture.

WHY THIS EXISTS

The 2026-09-02 survey found four hand-maintained lists disagreeing about
what Scruple can sign, and the existing suites would have caught none of
it: `services/c2pa-signer/tests/` tested the assertion partition and the
source-type contract and never signed anything, and the TypeScript suite
stubbed the Python signer with a shell shim. The one test that did sign
(`test_digital_source_type.py`) signs PNG only.

So this file signs one real fixture per advertised MIME, reads the result
back through `c2pa.Reader`, and requires `validation_state=Valid`. The
fixtures are the ones already in the repository, in
`docs/c2pa-conformance-evidence/2026-07-14/Raw.input.<mime>/` — the same
bytes that went to the C2PA conformance reviewer.

MUST-FIRE IS HALF A TEST

`TestUnsupportedReallyIsUnsupported` is the control. A green list with no
control proves only that it cannot fail. Each `UNSUPPORTED` entry is put
to the same library and must come back refused — if c2pa-rs ever gains a
WebM handler, that class goes red and tells us to promote it rather than
leaving a capability hidden for a year, which is what happened to GIF,
JXL and AVI.
"""

from __future__ import annotations

import io
import json
import os
import subprocess
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
SIGNER_DIR = os.path.dirname(HERE)
REPO = os.path.dirname(os.path.dirname(SIGNER_DIR))
sys.path.insert(0, SIGNER_DIR)

from formats import (  # noqa: E402
    FORMATS,
    GENERATE_MIMES,
    INTAKE_ASSERTED_NOT_SUPPORTED,
    UNSUPPORTED,
    VALIDATE_MIMES,
    mime_from_path,
    refusal_reason,
)

FIXTURES = os.path.join(REPO, "docs", "c2pa-conformance-evidence", "2026-07-14")
KEYS = os.path.join(SIGNER_DIR, "keys")
KEY = os.path.join(KEYS, "signer.key")
CERT = os.path.join(KEYS, "signer.pem")
REGEN = os.path.join(KEYS, "regen-dev-cert.sh")

c2pa = pytest.importorskip("c2pa", reason="c2pa-python not installed")


def _ensure_dev_material() -> bool:
    """signer.key and signer.pem are gitignored, so a fresh clone has
    neither. Regenerate rather than skip — a suite that skips itself into
    green on the box that matters is how this went unnoticed."""
    if os.path.exists(KEY) and os.path.exists(CERT):
        return True
    if not os.path.exists(REGEN):
        return False
    try:
        subprocess.run([REGEN], cwd=KEYS, check=True, capture_output=True, timeout=120)
    except Exception:
        return False
    return os.path.exists(KEY) and os.path.exists(CERT)


HAVE_KEYS = _ensure_dev_material()
needs_keys = pytest.mark.skipif(
    not HAVE_KEYS, reason="no dev signing material and regen-dev-cert.sh could not run"
)


def _fixture_for(mime: str) -> str | None:
    d = os.path.join(FIXTURES, "Raw.input." + mime.replace("/", ".", 1))
    if not os.path.isdir(d):
        return None
    entries = [e for e in sorted(os.listdir(d)) if not e.startswith("NOT_SUPPORTED")]
    return os.path.join(d, entries[0]) if entries else None


@pytest.fixture(scope="module")
def signer():
    os.environ["SCRUPLE_C2PA_LOCAL_KEY_PATH"] = KEY
    os.environ.pop("SCRUPLE_C2PA_VAULT_KEY_OCID", None)
    import vault_sign

    c2pa.load_settings(
        json.dumps(
            {
                "builder": {
                    "created_assertion_labels": [
                        "c2pa.actions",
                        "c2pa.thumbnail.claim",
                        "c2pa.thumbnail.ingredient",
                        "c2pa.ingredient",
                    ]
                },
                "verify": {"verify_after_sign": False, "verify_trust": False},
            }
        ),
        "json",
    )
    return c2pa.Signer.from_callback(
        callback=vault_sign.vault_sign_es256,
        alg=c2pa.C2paSigningAlg.ES256,
        certs=open(CERT, encoding="utf-8").read(),
        tsa_url=None,
    )


def _sign_bytes(signer, mime: str, source_path: str) -> bytes:
    b = c2pa.Builder(
        {"claim_generator": "Scruple/0.1-test", "format": mime, "title": "t", "assertions": []}
    )
    b.set_intent(c2pa.C2paBuilderIntent.CREATE, c2pa.C2paDigitalSourceType.TRAINED_ALGORITHMIC_MEDIA)
    out = io.BytesIO()
    with open(source_path, "rb") as src:
        b.sign(signer, mime, src, out)
    return out.getvalue()


@needs_keys
class TestEveryAdvertisedFormatActuallySigns:
    @pytest.mark.parametrize("mime", GENERATE_MIMES)
    def test_signs_and_reads_back_valid(self, signer, mime):
        fixture = _fixture_for(mime)
        assert fixture, (
            f"{mime} is in GENERATE_MIMES but has no fixture at "
            f"{FIXTURES}/Raw.input.{mime.replace('/', '.', 1)}/. A format we "
            f"advertise but cannot exercise is a format we cannot claim."
        )
        signed = _sign_bytes(signer, mime, fixture)
        assert len(signed) > 0

        reader = c2pa.Reader(mime, io.BytesIO(signed))
        state = json.loads(reader.json()).get("validation_state")
        assert state == "Valid", (
            f"{mime} signed but reads back validation_state={state!r}. "
            f"Advertising it is an overclaim."
        )

    @pytest.mark.parametrize("mime", VALIDATE_MIMES)
    def test_validate_mimes_have_a_reader_handler(self, mime):
        """Ingesting a manifest as an ingredient needs a Reader handler.
        Garbage bytes are fine: a MIME with no handler answers
        'Reader does not support <mime>' before it looks at them."""
        try:
            c2pa.Reader(mime, io.BytesIO(b"\x00" * 64))
        except Exception as e:  # noqa: BLE001
            assert "does not support" not in str(e), (
                f"{mime} is in VALIDATE_MIMES but c2pa {c2pa.__version__} has "
                f"no Reader handler for it: {e}"
            )


@needs_keys
class TestUnsupportedReallyIsUnsupported:
    """The must-NOT-fire control."""

    @pytest.mark.parametrize("entry", UNSUPPORTED, ids=lambda e: e.mime)
    def test_library_still_refuses(self, signer, entry):
        b = c2pa.Builder(
            {"claim_generator": "probe", "format": entry.mime, "title": "t", "assertions": []}
        )
        b.set_intent(
            c2pa.C2paBuilderIntent.CREATE, c2pa.C2paDigitalSourceType.TRAINED_ALGORITHMIC_MEDIA
        )
        with pytest.raises(Exception) as exc:
            b.sign(signer, entry.mime, io.BytesIO(b"\x00" * 64), io.BytesIO())
        assert "does not support" in str(exc.value), (
            f"c2pa {c2pa.__version__} no longer refuses {entry.mime} outright "
            f"({exc.value}). If it can now be signed, PROMOTE it into FORMATS "
            f"— GIF, JXL and AVI sat signable-but-unadvertised for a year "
            f"because nothing looked."
        )

    def test_intake_gaps_are_not_re_asserted(self):
        for mime in INTAKE_ASSERTED_NOT_SUPPORTED:
            assert mime not in GENERATE_MIMES or mime == "application/pdf", (
                f"{mime} is documented as an intake gap (a NOT_SUPPORTED.txt "
                f"shipped to the reviewer in the 2026-07-14 bundle) and must "
                f"not be re-asserted as generatable."
            )
        assert "application/x-pytorch" not in GENERATE_MIMES
        assert "application/x-pytorch" not in VALIDATE_MIMES
        assert "application/pdf" not in GENERATE_MIMES


class TestRegistryShape:
    def test_no_mime_is_both_supported_and_unsupported(self):
        supported = {f.mime for f in FORMATS}
        assert not (supported & {u.mime for u in UNSUPPORTED})

    def test_extensions_are_unique_and_normalised(self):
        seen: dict[str, str] = {}
        for ext, owner in [
            (e, f.mime) for f in FORMATS for e in f.extensions
        ] + [(e, u.mime) for u in UNSUPPORTED for e in u.extensions]:
            assert ext == ext.lower() and ext.startswith("."), ext
            assert ext not in seen, f"{ext} claimed by both {seen[ext]} and {owner}"
            seen[ext] = owner

    def test_generate_is_a_subset_of_validate(self):
        """We can always ingest what we can produce."""
        assert set(GENERATE_MIMES) <= set(VALIDATE_MIMES)

    def test_webm_resolves_to_its_true_mime_and_is_refused(self):
        """Not octet-stream. The refusal has to be able to name it."""
        assert mime_from_path("/out/take.WEBM") == "video/webm"
        reason = refusal_reason("video/webm")
        assert reason and "video/webm" in reason and "MP4" in reason

    def test_unknown_extension_refuses_rather_than_guessing(self):
        assert mime_from_path("/out/model.safetensors") == "application/octet-stream"
        assert refusal_reason("application/octet-stream")

    def test_signable_mimes_are_not_refused(self):
        for mime in GENERATE_MIMES:
            assert refusal_reason(mime) is None
