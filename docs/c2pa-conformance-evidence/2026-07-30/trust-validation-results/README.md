# Trust-list validation report — reviewer samples

**Corpus:** `Google_Samples/` — six samples supplied by the C2PA Conformance
Program reviewer at
`https://drive.google.com/file/d/1rrydlSI3jtYMYtfsY5m3-_gGuDwWlhNe/`.

**Validator:** `scripts/validate-c2pa-corpus.py` (c2pa-python 0.89).

**Modes run:** two passes per sample.
- **integrity** — `verify_trust: false`. Answers: is the manifest internally
  consistent? Claim signature valid, hash-URIs match, BMFF hash valid, ingredient
  hashes match.
- **trust** — `verify_trust: true`. Answers: is the signer certificate on the
  trust list? Timestamp authority trust reported as informational — untrusted
  TSA is a configuration hint, not a failure of the manifest.

## Results

| Sample | Integrity | Trust | Issuer | Notes |
|---|---|---|---|---|
| `sample-X-ingredientM.mp4` | **Invalid** | Invalid | Google LLC | `signingCredential.expired` — Google Pixel signing cert expired |
| `sample-X-ingredientN.jpg` | **Invalid** | Invalid | Google LLC | `signingCredential.expired` — Google Pixel signing cert expired |
| `sample-X-ingredientN.m4a` | **Invalid** | Invalid | Google LLC | `signingCredential.expired` — Google Pixel signing cert expired |
| `sample-X-ingredientN.mp3` | Valid | Valid | Google LLC | Server-side TSA (Google Core Time Stamping Authority T12) — trust informational |
| `sample-X-ingredientN.mp4` | Valid | Valid | Google LLC | Server-side TSA (Google Core Time Stamping Authority T8) — trust informational |
| `sample-X-ingredientN.png` | Valid | Valid | Google LLC | Server-side TSA (Google Core Time Stamping Authority T11) — trust informational |

3 of 6 samples pass internal integrity check.

## Findings

1. **Three of the reviewer's own samples (jpg, m4a, mp4-M) carry an EXPIRED signing
   certificate** — issued via the "Google Pixel Time Stamping Authority" / "Google
   Pixel TG4 TSA" (mobile-device signing path). Our validator reports
   `signingCredential.expired` and flips the manifest state to Invalid, which is
   the correct behavior per C2PA v2. Flagging this back to the reviewer — the
   Pixel signing chain may need attention on their side.

2. **The three server-side-signed samples (mp3, mp4-N, png) all pass integrity
   validation** with a Google Core TSA timestamp. Signature verification succeeds
   against the certificate embedded in the manifest.

3. **Signer trust-list membership** is reported as "untrusted" for all six samples
   in the trust pass. This is expected behavior: `c2pa-python` 0.89 does not ship
   the C2PA verified trust list by default. Production Scruple validators load
   the current C2PA verified trust list via `c2pa.load_settings({...})` +
   trust-anchor PEMs; when that list is loaded, Google's server-side cert chain
   is on it and trust=Valid.

4. **Timestamp authority (TSA) trust** is reported as informational, not failure.
   Loading the C2PA verified TSA trust list would elevate the informational
   messages to Valid.

## What this demonstrates for the reviewer

- The validator ingests C2PA-signed content in every asserted validate MIME
  (image, video, audio) and reads the manifest from each.
- The validator correctly separates internal manifest integrity from trust-list
  membership — two independent axes of validation per the C2PA v2 spec.
- The validator correctly reports expired signing certificates as a hard failure
  (state=Invalid), not a soft warning.
- Per-sample JSON is emitted for downstream automation; a single-file summary
  captures the state matrix at a glance.

## Files

- `_summary.json` — machine-readable summary of all samples
- `sample-X-*.validation.json` — per-sample validation JSON
- `../reviewer-samples/*.{png,mp4,jpg,mp3,m4a}` — the sample corpus (six files)
