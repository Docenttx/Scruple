# Scruple — C2PA Conformance Program Evidence Bundle

**Intake record ID:** `019f5856-bff8-7f57-a879-80594a6fb3fe`
**Product name:** Scruple
**Bundle date:** 2026-07-14
**Bundle version:** 1.0

This directory contains the evidence samples the C2PA Conformance Program
reviewer requested on 2026-07-14 to accompany our Intake Form.

## Bundle structure

Per the reviewer's specification:

```
Generate.output.<mediatype>/       — signed sample per asserted GENERATE MIME
    scruple-<ext>-seed<N>.<ext>    — the actual signed file
    scruple-<ext>-seed<N>.json     — c2pa.Reader().json() output for the file
    NOT_SUPPORTED.txt              — (only when the current c2pa-python
                                     wrapper doesn't yet expose signing
                                     for the MIME; raw sample provided)

Raw.input.<mediatype>/             — unsigned input per asserted VALIDATE MIME
    scruple-<ext>-seed<N>.<ext>    — the unsigned raw file

Validate.output.<mediatype>/       — signed output from ingesting the Raw.input
    scruple-<ext>-seed<N>.<ext>    — signed file with ingredient reference
                                     to the corresponding Raw.input file
    scruple-<ext>-seed<N>.json     — c2pa.Reader().json() output
    NOT_SUPPORTED.txt              — (same wrapper-limit note as above)
```

The single top-level `_bundle_report.json` summarizes coverage: which MIMEs
signed successfully, which are wrapper-limited, and the file byte counts.

## Coverage vs. Intake assertions

**Generate side — 15 of 16 asserted MIMEs producing valid signed samples:**

| MIME | Status | Notes |
|---|---|---|
| image/png | ✓ signed | |
| image/jpeg | ✓ signed | |
| image/webp | ✓ signed | |
| image/svg+xml | ✓ signed | |
| image/tiff | ✓ signed | |
| image/x-adobe-dng | ✓ signed | DNG built as valid TIFF + DNG-specific tags |
| image/heic | ✓ signed | |
| image/heif | ✓ signed | |
| image/avif | ✓ signed | |
| video/mp4 | ✓ signed | |
| video/quicktime | ✓ signed | |
| audio/wav | ✓ signed | |
| audio/flac | ✓ signed | |
| audio/mpeg | ✓ signed | MP3 via libmp3lame |
| audio/mp4 | ✓ signed | AAC in .m4a container |
| **application/x-pytorch** | ⊘ raw only | See "Known wrapper limits" below |

**Validate side — 18 of 20 asserted MIMEs producing signed ingested output:**

| MIME | Status | Notes |
|---|---|---|
| image/jpeg | ✓ validated + signed | |
| image/jxl | ✓ validated + signed | |
| image/png | ✓ validated + signed | |
| image/svg+xml | ✓ validated + signed | |
| image/gif | ✓ validated + signed | |
| image/x-adobe-dng | ✓ validated + signed | |
| image/tiff | ✓ validated + signed | |
| image/webp | ✓ validated + signed | |
| image/heic | ✓ validated + signed | |
| image/heif | ✓ validated + signed | |
| image/avif | ✓ validated + signed | |
| video/x-msvideo | ✓ validated + signed | AVI |
| video/mp4 | ✓ validated + signed | |
| video/quicktime | ✓ validated + signed | |
| audio/flac | ✓ validated + signed | |
| audio/mpeg | ✓ validated + signed | |
| audio/wav | ✓ validated + signed | |
| audio/mp4 | ✓ validated + signed | |
| **application/pdf** | ⊘ raw only | See "Known wrapper limits" below |
| **application/x-pytorch** | ⊘ raw only | See "Known wrapper limits" below |

## Known wrapper limits (as of `c2pa-python 0.89.0`)

The following MIMEs are on our Intake assertion but are **not currently
signable via the c2pa-python 0.89 wrapper**. They ARE supported by the
underlying c2pa-rs Rust library behind feature flags that the Python
bindings do not yet expose. The corresponding folders contain the raw
input plus a `NOT_SUPPORTED.txt` note; a signed evidence file will be
supplied when the wrapper catches up.

- `application/pdf` — validate side only affected. c2pa-rs supports PDF
  in a `pdf` feature; the Python wheel is built without it.
- `application/x-pytorch` — both sides affected. c2pa-rs supports
  pytorch mlModel behind an equivalent feature flag.

We can produce raw samples of both formats via the same `producers.py`
module used elsewhere in this bundle (see repro instructions below), so
the intake assertion for both formats remains accurate on the READ /
INGEST side and is trivially provable once the wrapper exposes signing.

## Signing identity used in this bundle

**IMPORTANT — this is a DEV signer, not our production signer.**

```
Subject: C = US, ST = CA, L = Somewhere,
         O = Scruple Dev Signing Cert,
         OU = FOR TESTING_ONLY,
         CN = Scruple Dev Signer
Issuer:  C = US, ST = CA, L = Somewhere,
         O = Scruple Dev Root CA,
         OU = FOR TESTING_ONLY,
         CN = Scruple Dev Root CA
Algorithm: ES256 (P-256 ECDSA)
```

Production signing runs the same wrapper against **OCI Vault**
(hardware-backed key isolation, HSM-signed operations). The vault-signed
outputs are identical in structure and manifest content; only the cert
chain differs — production certs chain to a Scruple public root that
appears on our C2PA product listing card once approved.

We chose to submit dev-cert evidence because (a) the reviewer's task is
to verify that our signer correctly emits C2PA-compliant manifests
across our asserted MIMEs — which requires only that the signatures be
cryptographically valid, not that they chain to a public trust anchor —
and (b) submitting production-cert samples of research data would
irreversibly commit them to on-chain evidence. Reviewers can substitute
a `c2pa-verify` invocation with `--trust-manifest <dev root>` against
the included `dev-root-ca.pem` to walk the full chain.

## Reproducing this bundle

From a clean checkout of `github.com/Docenttx/Scruple` on the branch
tagged for this submission:

```bash
# One-time dependencies (all in-tree, no proprietary code)
pip install --user reportlab pillow-heif imageio pillow-avif-plugin \
    soundfile jxlpy pypdf c2pa

# One-time cert regeneration (produces services/c2pa-signer/keys/signer.{key,pem})
bash services/c2pa-signer/keys/regen-dev-cert.sh

# Build the evidence bundle
SCRUPLE_C2PA_DEV=1 python3 services/c2pa-signer/build_evidence_bundle.py \
    --out docs/c2pa-conformance-evidence/2026-07-14
```

The build is fully deterministic: same producer seeds → byte-identical
raw inputs. The signed outputs differ only in the UUID that c2pa-rs
mints for the claim label; every other byte of the manifest matches
across reproductions.

## Independent verification (recommended for reviewers)

```python
import c2pa, json, os
os.environ.setdefault('SCRUPLE_C2PA_DEV', '1')
# Relax trust anchor for the dev root; production chain uses real anchors.
c2pa.load_settings('{"verify":{"verify_trust":false}}', 'json')

with open('Generate.output.image.png/scruple-png-seed1001.png', 'rb') as f:
    reader = c2pa.Reader('image/png', f)
    data = json.loads(reader.json())
    reader.close()

print(data['validation_state'])   # → "Valid"
```

For a full cross-language verification you can also install
`@scruple/verify` (npm) and run `scruple-verify leaf --proof <file>` —
same result, independent implementation, useful as a triangulation
check.

## Copy of the "capture only" confirmation for the reviewer

The intake letter contained a form-letter mismatch:

> [You indicated no validate attributes asserting that your Generator
> Product is a "capture only" application and does not ingest files
> that may have manifests. Please confirm.]

**Confirmation NOT applicable.** Scruple is NOT a capture-only
application. The Intake Form we submitted DOES list validate attributes
(image, video, audio, documents, mlModel — all populated). Scruple
ingests C2PA-signed inputs as ingredients as a core capability of the
training-mining assertion pipeline. Please treat the validate list as
authoritative; the `Raw.input.*` + `Validate.output.*` folders in this
bundle are the evidence of that ingest path working end-to-end.

## Contact

- Technical: `partners@scruple.ai`
- Security: `security@scruple.ai`
- This bundle was produced by `services/c2pa-signer/build_evidence_bundle.py`
  in the branch tagged `c2pa-conformance-2026-07-14` on Docenttx/Scruple.
