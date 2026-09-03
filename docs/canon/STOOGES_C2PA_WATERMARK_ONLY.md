# Adding Scruple to Stooges — content credentials and watermarking only

_2026-09-03. A report for the Stooges session. Scope set by the founder:
**C2PA and watermarking on artifacts Stooges creates. No provenance.**_

## What "no provenance" means in code, and why it is already supported

Stooges would sign artifacts and optionally watermark them. It would **not**
mint leaves, call the witness, build a hash chain, or make any claim that an
artifact's history was recorded.

That distinction is already a first-class state in the signer rather than
something to bolt on. `signAsset()` takes a `tier`, and at `tier: 'bare'` it
**omits the Scruple provenance assertion entirely** — the code's own reason is
that the alternative would be "asserting a witness that never happened."

So the integration is: call the signer at `bare`, and do not touch
`lib/iterations/*`, `lib/scruple/witness.ts` or anything under `lib/leaf/`.
A Stooges artifact gets a **content credential**, not a receipt.

The manifest a `bare` signature carries is `c2pa.actions.v2`,
`c2pa.hash.*` and `cawg.training-mining`. Not `ai.scruple.provenance`.
That is the honest shape and it needs no new code to produce.

## What is measured working

**C2PA signing — 13 formats**, each exercised through c2pa-python 0.36.0 and
read back to `validation_state: Valid`:

`image/jpeg` · `image/png` · `image/svg+xml` · `image/x-adobe-dng` ·
`image/tiff` · `image/webp` · `image/heic` · `image/heif` · `image/avif` ·
`video/mp4` · `video/quicktime` · `audio/flac` · `audio/mpeg`

**`video/webm` is explicitly refused** with a reason that names the fix
(transcode to MP4 or MOV). It does not fail obscurely — `lib/c2pa/formats.ts`
carries the refusal as data.

**Watermarking — images only.** `embedImageWatermark` is a DCT scheme
(`dct-v1`) that produces a derivative; `decodeImageWatermark` reads the payload
back. Proven on a real artifact on 2026-09-02: the derivative decodes to
`{found: true, tier: 3, version: 1}` and the master returns **null**, which is
the pair that matters — the watermark is in the derivative and not in the
original.

**There is no video watermarking.** None. If Stooges needs watermarked video,
that is a build, not an integration.

Output format matters: the default is PNG because it is lossless and a lossy
re-encode destroys the mark. A JPEG/WebP path exists with a quality parameter
and has not been characterised for survival.

## The three things that need a decision before any of this ships

### 1. Which certificate signs — and Stooges has real users

This is the whole decision, and it is different for Stooges than for Studio.

The signer currently falls back to a **development certificate** committed in
`services/c2pa-signer/keys/`. Assets signed with it validate to
`validation_state: Valid` with one code: `signingCredential.untrusted`. That is
a true statement about the CA, not a defect — the dev CA is deliberately not in
c2pa's trust list.

For **Studio** that is fine: it is a blueprint with no users. **Stooges has
paying customers**, and emitting a credential on a customer's artifact that any
verifier reports as untrusted is a product decision with a support cost, not a
technical detail. `lib/iterations/signOnIngest.ts` already says signing is off
"until WO-26 settles which certificate signs", and that sentence was written
about a product with no users.

**Recommendation:** do not ship customer-facing credentials on the dev cert.
Either obtain a production certificate first, or ship behind a flag that is off
by default and clearly labelled in the UI as a development credential.

### 2. `digitalSourceType` is required and must not be guessed

`signAsset` **refuses to sign without one** and has no default. That refusal is
deliberate: defaulting to `TRAINED_ALGORITHMIC_MEDIA` would assert that
generative AI made an asset, which is a false statement for anything a human
composed.

Stooges must decide per artifact, and the two that will come up are:

- `TRAINED_ALGORITHMIC_MEDIA` — a model generated it outright.
- `COMPOSITE_WITH_TRAINED_ALGORITHMIC_MEDIA` — a generated asset with any
  human-supplied or non-generated input in it.

Getting this wrong is a false claim inside a signed manifest, which is worse
than no manifest. The enum is SCREAMING_CASE; the error message lists the
valid values.

### 3. The signer is a Python subprocess

`signAsset` spawns `services/c2pa-signer/sign.py`. Stooges' deployment must
have that tree, a Python with `c2pa-python` installed, and the key material.
It is not a pure-Node dependency and it will not work by importing a package.

## What I would hand the implementer

- **Entry point:** `signAsset()` in `lib/c2pa/signAsset.ts`. Inputs:
  `assetPath`, `outputPath`, `product`, `tier: 'bare'`, `format` (MIME),
  `digitalSourceType`, optional `title`. It returns `assetSha256` and
  `outputManifestSha256`, both worth storing.
- **Format gate:** `lib/c2pa/formats.ts`. Ask it before signing; it answers
  with a reason when it says no.
- **Watermark:** `buildPayloadHex` then `embedImageWatermark` in
  `lib/watermark/embed.ts`; verify with `decodeImageWatermark`.
- **Verification for tests:** `scripts/verify-c2pa-reader.py <file>`. Exit 0
  means `Valid` or dev-cert-untrusted; anything else is a real failure. Use it
  in CI — the Rust verifier does **not** check the COSE signature bytes, which
  is how an invalid signature passed a shipping test on 2026-07-12.

## Two things not to copy from Studio

Studio is an exemplar rather than a product, and two of its habits are wrong
for a live service:

- **Sidecar naming.** Studio writes `<artifact>.c2pa` beside the artifact and
  serves the unsigned bytes. For Stooges, decide deliberately whether the
  customer downloads the signed asset or the original, and make one of them
  canonical. Serving both without saying which is which is how a verifier ends
  up checking the wrong file.
- **Storing the watermarked derivative as a separate artifact.** In Studio the
  derivative gets its own leaf. With no provenance, the derivative is just a
  file — so Stooges must decide which one the customer receives, and say so.

## What this does not give anyone

Worth stating plainly so nobody oversells it internally: a `bare` content
credential says **this software signed these bytes and declared how they were
made.** It does not say the artifact's history was recorded, that inputs were
committed, or that anything was witnessed. Those are the provenance claims and
they are explicitly out of scope here.
