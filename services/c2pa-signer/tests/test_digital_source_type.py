"""digital_source_type is declared, never defaulted — WO-13.

The bug: `sign.py` read `job.get("digital_source_type",
"TRAINED_ALGORITHMIC_MEDIA")` and `lib/c2pa/signAsset.ts` carried the
same fallback, and no plugin path overrode either. The plugin market is
proof that an artifact was made WITHOUT generative AI — Fusion, Blender,
Meshroom and Toon Boom are CAD / 3D / animation hosts that run no
inference — so the default wrote the exact opposite claim into a signed,
third-party-verifiable manifest. Latent on Fusion (no CAD MIME is
C2PA-signable today), live on Blender, whose PNG and JPEG renders are.

That is a false signed claim, so the fix is the posture this package
already takes in `assertion_partition.py` and that the host SDK takes in
`capture()`: refuse rather than guess. CANON_SKELETON.md §5 property 2.

What is pinned here:

  1. an absent, empty, or non-string digital_source_type is REFUSED, and
     refused early — before the c2pa SDK loads and before the signer
     guards run, so the refusal is legible and cheap
  2. a declared value round-trips all the way into the signed manifest
     as the right IPTC URI, byte for byte
  3. the default cannot creep back into either end of the subprocess
     boundary

Test 2 signs for real with the committed dev key, so it skips cleanly
where c2pa or the dev key material is unavailable. Tests 1 and 3 need
neither.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
SIGNER_DIR = os.path.dirname(HERE)
REPO = os.path.dirname(os.path.dirname(SIGNER_DIR))
SIGN_PY = os.path.join(SIGNER_DIR, "sign.py")
SIGN_ASSET_TS = os.path.join(REPO, "lib", "c2pa", "signAsset.ts")
CERT = os.path.join(SIGNER_DIR, "keys", "signer.pem")
KEY = os.path.join(SIGNER_DIR, "keys", "signer.key")

# The IPTC digitalsourcetype vocabulary URIs, restated as literals.
#
# Not derived from the enum: the whole point is to catch the day the enum
# name and the URI it emits stop lining up. Established two ways — the
# published IPTC definitions at cv.iptc.org (digitalCreation is "Media
# created by a human using non-generative tools"; trainedAlgorithmicMedia
# is the GenAI term), and by signing a PNG at each value with the
# installed c2pa and reading the manifest back, which is exactly what
# test_declared_value_reaches_the_manifest does below.
IPTC = "http://cv.iptc.org/newscodes/digitalsourcetype/"
EXPECTED_URI = {
    # The plugin hosts' value. Fusion, Blender, Meshroom, Toon Boom.
    "DIGITAL_CREATION": IPTC + "digitalCreation",
    # The generation flow's value. Canvas / ComfyUI / Modal.
    "TRAINED_ALGORITHMIC_MEDIA": IPTC + "trainedAlgorithmicMedia",
    # Neither of the above, kept to prove the mapping is not a coincidence
    # of two adjacent enum members.
    "ALGORITHMIC_MEDIA": IPTC + "algorithmicMedia",
}


def _have_signer() -> bool:
    try:
        import c2pa  # noqa: F401
    except Exception:
        return False
    return os.path.exists(CERT) and os.path.exists(KEY)


needs_signer = pytest.mark.skipif(
    not _have_signer(),
    reason="c2pa SDK or dev key material unavailable — the refusal tests still run",
)


def _png(path: str, w: int = 8, h: int = 8) -> str:
    """A real, minimal PNG built here rather than pasted as a base64 blob.

    The signer refuses a nonexistent or unparseable asset, and we want the
    source-type refusal to be the reason a job fails — never the asset.
    """
    import struct
    import zlib

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    raw = b"".join(b"\x00" + b"\xc6\x28\x28" * w for _ in range(h))
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw))
        + chunk(b"IEND", b"")
    )
    with open(path, "wb") as fh:
        fh.write(png)
    return path


def _run(job: dict) -> dict:
    """Run sign.py exactly as signAsset.ts does — a subprocess fed one JSON
    object on stdin — and parse the one JSON object it writes to stdout."""
    env = dict(os.environ)
    env["SCRUPLE_C2PA_DEV"] = "1"          # relax trust-list verification
    env.pop("SCRUPLE_C2PA_VAULT_KEY_OCID", None)  # local key, never Vault
    proc = subprocess.run(
        [sys.executable, SIGN_PY],
        input=json.dumps(job),
        capture_output=True,
        text=True,
        cwd=SIGNER_DIR,
        env=env,
    )
    out = proc.stdout
    start, end = out.find("{"), out.rfind("}")
    assert start != -1 and end != -1, f"no JSON on stdout. stderr: {proc.stderr[-800:]}"
    return json.loads(out[start:end + 1])


def _job(tmp_path, **overrides) -> dict:
    job = {
        "asset_path": _png(str(tmp_path / "asset.png")),
        "output_path": str(tmp_path / "asset.c2pa.png"),
        "cert_path": CERT,
        "key_path": KEY,
        "manifest": {
            "claim_generator": "Scruple/0.1",
            "title": "wo13",
            "format": "image/png",
            "assertions": [],
        },
        "intent": "CREATE",
        "digital_source_type": "DIGITAL_CREATION",
        "actions": [],
    }
    job.update(overrides)
    return job


class TestUndeclaredIsRefused:
    def test_absent_digital_source_type_refuses(self, tmp_path):
        """The bug, stated as a test. Before WO-13 this signed happily and
        asserted trainedAlgorithmicMedia over a human-made asset."""
        job = _job(tmp_path)
        del job["digital_source_type"]
        res = _run(job)
        assert res["ok"] is False, res
        assert "requires an explicit digital_source_type" in res["error"]
        # The message has to carry the reason, or the next person makes
        # the error go away by restoring the default.
        assert "opposite of what the plugin hosts exist to prove" in res["error"]

    @pytest.mark.parametrize(
        "bad", [None, "", "   ", 0, 12, [], {}, ["DIGITAL_CREATION"], True],
    )
    def test_empty_or_non_string_refuses(self, tmp_path, bad):
        res = _run(_job(tmp_path, digital_source_type=bad))
        assert res["ok"] is False, f"{bad!r} was accepted: {res}"
        assert "requires an explicit digital_source_type" in res["error"]

    def test_unknown_name_refuses_rather_than_falling_back(self, tmp_path):
        """An unrecognised name must not degrade to the old default."""
        res = _run(_job(tmp_path, digital_source_type="TOTALLY_MADE_UP"))
        assert res["ok"] is False, res
        assert "unknown digital_source_type" in res["error"]
        assert not os.path.exists(_job(tmp_path)["output_path"])

    def test_refusal_precedes_the_asset_check(self, tmp_path):
        """Fails closed on the declaration before anything else can fail.

        If the source-type check ran after the asset check, a caller would
        first see "asset not found", fix that, and only then discover the
        real problem — or never, because the default would have covered it.
        """
        job = _job(tmp_path, asset_path=str(tmp_path / "nope.png"))
        del job["digital_source_type"]
        res = _run(job)
        assert res["ok"] is False
        assert "requires an explicit digital_source_type" in res["error"]
        assert "asset not found" not in res["error"]

    def test_refusal_does_not_need_the_sdk(self, tmp_path):
        """The refusal is cheap: no c2pa import, no age guard, no patch
        guard. Proved by pointing cert_path at nothing — the cert check
        sits after the source-type check but before the SDK loads."""
        job = _job(tmp_path, cert_path=str(tmp_path / "no-such-cert.pem"))
        del job["digital_source_type"]
        res = _run(job)
        assert res["ok"] is False
        assert "requires an explicit digital_source_type" in res["error"]
        assert "cert not found" not in res["error"]


class TestDeclaredValueRoundTrips:
    @needs_signer
    @pytest.mark.parametrize("name,uri", sorted(EXPECTED_URI.items()))
    def test_declared_value_reaches_the_manifest(self, tmp_path, name, uri):
        """End to end: job spec -> Builder.set_intent -> signed JUMBF ->
        c2pa.Reader. The declared name must become exactly the IPTC URI
        this project expects, with nothing substituted en route."""
        import c2pa

        out = str(tmp_path / f"{name}.png")
        res = _run(_job(tmp_path, digital_source_type=name, output_path=out))
        assert res["ok"] is True, res
        assert os.path.exists(out)

        report = json.loads(c2pa.Reader(out).json())
        manifest = report["manifests"][report["active_manifest"]]
        inception = None
        for assertion in manifest["assertions"]:
            if assertion["label"].startswith("c2pa.actions"):
                inception = assertion["data"]["actions"][0]
                break
        assert inception is not None, "no c2pa.actions assertion in the manifest"
        assert inception["action"] == "c2pa.created", inception
        assert inception["digitalSourceType"] == uri, inception

    @needs_signer
    def test_no_ai_value_never_emits_the_genai_uri(self, tmp_path):
        """The claim that matters. A Blender render signed as
        DIGITAL_CREATION must contain no trace of trainedAlgorithmicMedia
        anywhere in the manifest — that URI is what the plugin exists to
        disprove."""
        out = str(tmp_path / "blender-render.png")
        res = _run(_job(tmp_path, digital_source_type="DIGITAL_CREATION", output_path=out))
        assert res["ok"] is True, res

        import c2pa

        raw = c2pa.Reader(out).json()
        assert "trainedAlgorithmicMedia" not in raw
        assert IPTC + "digitalCreation" in raw


class TestTheDefaultCannotCreepBack:
    """Behavioural tests pass just as happily against a fallback that
    these particular cases never reach. The fallback is the bug, so read
    the sources — the idiom test_assertion_contract.py already uses."""

    def test_sign_py_has_no_default(self):
        with open(SIGN_PY, "r", encoding="utf-8") as fh:
            src = fh.read()
        assert not re.search(
            r"""job\.get\(\s*['"]digital_source_type['"]\s*,""", src
        ), "sign.py supplies a default for digital_source_type — that is the bug"
        assert 'dst_name = job.get("digital_source_type")' in src

    def test_sign_asset_ts_has_no_default(self):
        """Both ends of the subprocess boundary. A default restored on
        either side alone is enough to re-open this."""
        with open(SIGN_ASSET_TS, "r", encoding="utf-8") as fh:
            src = fh.read()
        job = re.search(r"const job = \{.*?\n  \};", src, re.S)
        assert job, "job spec literal not found in signAsset.ts"
        assert not re.search(
            r"digital_source_type:[^\n]*(\?\?|\|\|)", job.group(0)
        ), "signAsset.ts supplies a fallback for digital_source_type"
        assert not re.search(
            r"digitalSourceType\?:", src
        ), "digitalSourceType is optional again on SignAssetInput"

    def test_the_two_ends_share_one_vocabulary(self):
        """Every name signAsset.ts will emit must exist on the c2pa enum
        the Signer resolves it against. A name in the TS union that the
        SDK does not know is a runtime refusal at sign time."""
        pytest.importorskip("c2pa")
        import c2pa

        with open(SIGN_ASSET_TS, "r", encoding="utf-8") as fh:
            src = fh.read()
        block = re.search(
            r"const C2PA_DIGITAL_SOURCE_TYPES = \[(.*?)\] as const;", src, re.S
        )
        assert block, "C2PA_DIGITAL_SOURCE_TYPES block not found in signAsset.ts"
        names = re.findall(r"'([A-Z_]+)'", block.group(1))
        assert names, "no source-type literals found"
        for name in names:
            assert hasattr(c2pa.C2paDigitalSourceType, name), (
                f"{name!r} is offered by signAsset.ts but c2pa "
                f"{getattr(c2pa, '__version__', '?')} has no such enum member — "
                f"the Signer would refuse every asset declared that way."
            )
