# Scruple Watermark — Design Specification v1.0

**Status:** Draft, for review.
**Author:** Scruple Engineering
**Date:** 2026-07-14
**Depends on:** `SCRUPLE_STANDARD_v1.md` v1.2; `SCRUPLE_INTEGRATION_REQUIREMENTS_v1.md` v1.2
**Companion:** `docs/eu-ai-office/evidence-bundle-2026-07-14/03-marking-implementation/marking-technical-spec.md` — this doc closes the Sub-measure 1.1.2 gap noted there.

---

## 1. Motivation

Scruple's current marking regime satisfies EU Code Sub-measures 1.1.1 (C2PA
digitally signed metadata) and 1.1.3 (witness Merkle chain — fingerprinting/
logging). It does not satisfy 1.1.2 (imperceptible watermark). More
importantly, both existing layers depend on file-level structure that
downstream processing routinely destroys:

- C2PA manifests are stripped by most social platforms
- Witness leaf lookups require the bytes to be re-hashable, which normal
  re-encoding breaks

An imperceptible watermark **embedded in the content itself** survives
manifest strip, most re-encoding, and moderate re-cropping. It is the only
layer that persists to the leaf of the distribution graph — where a
journalist or auditor typically encounters the content.

The design goal is not "add another layer for Code compliance." The design
goal is: **a Scruple-marked image that a stranger finds on Twitter should
be traceable back to its receipt using only the pixel bytes, no external
metadata.**

## 2. Goals and non-goals

### In scope

- Image watermarking (raster: PNG, JPEG, WebP, TIFF, HEIC/HEIF/AVIF, GIF-still)
- Audio watermarking (WAV, FLAC, MP3, AAC/M4A)
- Video watermarking (MP4, MOV — per-frame with GOP-level variation)
- Payload structure that supports 4+ tiers of Scruple content status
- Public open-source decoder shipped with `scruple-verify`
- Public registry endpoint for tier-1 (C2PA-signed only) content lookup
- Integration into the existing `ingestIteration` pipeline
- Compliance mapping to EU Code Sub-measure 1.1.2 and Article 50(2)

### Out of scope for v1.0

- Text watermarking (Scruple does not generate text)
- SVG / vector formats (no meaningful perceptual watermark surface)
- ML model file watermarking (structured differently; separate spec later)
- PDF watermarking (limited perceptual surface; visible watermark via
  reportlab is possible but out of this scheme's scope)
- Watermarking on inputs the user supplied to us (only outputs Scruple
  produces or signs)
- Attack-hardened schemes against adversarial removal (see §8)

## 3. Payload structure

All Scruple watermarks share a common bit layout, decoded identically
regardless of media type. Total payload before ECC: **128 bits (16 bytes)**.

```
| offset | bits | field              | notes                                       |
|--------|------|--------------------|---------------------------------------------|
|   0    |   8  | magic              | 0x5C ("Scruple") — enables decoder FPR gate |
|   8    |   4  | version            | v1..v15; this doc = v1 (0x1)                |
|  12    |   4  | tier               | 0..15 — see §3.1                            |
|  16    | 112  | tier-specific body | see §3.1 per tier                           |
```

After 128-bit payload comes a Reed-Solomon ECC block sized per media type
(see §5). Total embedded bits including ECC: ~256 for image, higher for
video across GOP.

### 3.1 Tier layout

Tier byte determines how the 112 body bits are interpreted:

```
tier | name               | body layout                                                | resolution path
-----+--------------------+------------------------------------------------------------+------------------
0    | reserved           | (unused)                                                   | —
1    | c2pa-signed        | [ manifest_fingerprint: 112 bits (14 bytes) ]              | registry lookup
2    | checkpoint         | [ manifest_fingerprint: 112 bits ] (same as tier 1)        | registry lookup
3    | local-lock         | [ local_lock_hash: 112 bits ]                              | registry lookup
4    | chain-lock basic   | [ scr_id: 64 bits ] [ reserved: 48 bits ]                  | RVN asset lookup
5    | chain-lock pinned  | [ scr_id: 64 bits ] [ pinned_hint: 48 bits ]               | RVN + IPFS/Arweave
6..15| reserved           | (future — subscription tiers, per-jurisdiction marks)      | —
```

Where:
- `manifest_fingerprint` = first 14 bytes of `SHA-256(canonical_c2pa_manifest_bytes)`.
  Sufficient collision resistance at Scruple-scale ingest volume; registry
  disambiguates the rare collision.
- `scr_id` = the 8-byte / 16-hex Scruple SCR-ID assigned at chain-lock time,
  packed as a big-endian u64. (SCR-IDs are already 6-8 hex chars → 24-32
  bits; padded to 64 for future room.)
- `pinned_hint` = short lookup key that resolves the IPFS CID and Arweave
  txid through the RVN asset's chain metadata (avoids embedding the full
  IPFS CID in a 48-bit budget).

### 3.2 Payload lookup rules for a decoder

Given a decoded payload:

1. Verify `magic == 0x5C` and `version` is supported. If either fails,
   return `no-scruple-watermark`.
2. Read tier.
3. Dispatch:
   - Tier 1/2/3 → `HTTPS GET witness.scruple.ai/v1/watermark-lookup/<hex_fingerprint>`
     → returns the C2PA manifest (or reference to it) if we signed it.
   - Tier 4/5 → resolve SCR-ID to RVN asset directly, no Scruple dependency.
     Optionally fetch pinned metadata via IPFS/Arweave if tier=5.
4. Return the composite verdict object (see §7.2).

## 4. Integration point in the pipeline

Watermarking MUST happen **before** the output_hash is computed, so the
signed bytes are the watermarked bytes. Order:

```
generate raw output (ComfyUI / Kohya / Fusion / external caller)
        │
        ▼
compute intended tier (from lock state or caller declaration)
        │
        ▼
pack payload + ECC per §3
        │
        ▼
embed watermark → watermarked bytes             ← ★ watermark step
        │
        ▼
compute output_hash on watermarked bytes
        │
        ▼
C2PA sign watermarked bytes (existing signer)
        │
        ▼
witness leaf commits watermarked output_hash    (existing chain)
        │
        ▼
persist + serve
```

Concretely: `lib/iterations/ingest.ts` gains a call to
`lib/watermark/embed.ts` immediately before `sha256Hex(imageBytes)`. The
watermark call is a no-op if the tier is `0` or if the media type is
unsupported (SVG, model files, etc.).

### 4.1 Tier determination

At ingest time, tier is determined by:

- `p.spec.publicationTier` if the caller specified (Adobe/Fusion palette
  can pre-declare "this will be chain-locked")
- Default: tier 1 (C2PA-signed) — always safe
- On subsequent lock operations (checkpoint / local lock / chain lock),
  the tier is upgraded and the watermark is **re-embedded** with the new
  payload before the lock signature. This means chain-locking an existing
  iteration re-generates the file bytes with the SCR-ID encoded.

Re-embedding IS a byte change. Callers who care about byte stability
across lock upgrades must accept new hashes. This is documented in
`SCRUPLE_STANDARD_v1.md` §5.

## 5. Per-media scheme selection

### 5.1 Image (raster)

**Scheme:** StegaStamp-style deep-learning perceptual watermark for MVP.
Fallback: classical mid-frequency DCT for constrained environments (SVG-
adjacent formats where StegaStamp is inapplicable).

**Rationale:**
- StegaStamp is open-source (MIT-licensed research code), well-benchmarked,
  survives 30% quality JPEG re-encoding, 50% crop, moderate re-color.
- DCT is a well-understood classical fallback with tunable robustness/
  quality trade-off.

**Payload size after ECC:** 256 bits (128-bit payload + 128-bit Reed-Solomon
ECC for BER ~10⁻³).

**Quality cost:** invisible to the human eye at default parameters
(PSNR > 40 dB, SSIM > 0.99).

**Compute cost:** ~50–200 ms per image on CPU; ~5–20 ms on GPU. Negligible
in the ingest hot path (Modal runs are already GPU-bound).

### 5.2 Audio

**Scheme:** Spread-spectrum in the frequency domain — embed the payload
across a wide band of psychoacoustically-masked frequencies.

**Rationale:**
- Well-solved for decades; multiple open-source implementations
  (WavMark, AudioMarker, custom SS)
- Survives MP3 128 kbps, AAC 128 kbps, radio broadcast
- Payload capacity: 5–50 bps depending on scheme + audio content

**Payload duration:** 128 bits at 20 bps → ~7 seconds of audio required.
Meaning very short clips (< 5 s) are unwatermarkable — flagged as
`insufficient-duration` at embed time and the flag surfaces in the C2PA
manifest.

### 5.3 Video

**Scheme:** Per-frame image watermark applied to keyframes and select
P-frames, with GOP-level payload variation (payload byte 0 in GOP 0,
byte 1 in GOP 1, cyclic) so codec compression doesn't collapse identical
frame content.

**Rationale:**
- Reuses image-watermark encoder → less code
- Payload survives frame-drop attacks (any N consecutive GOPs recover it)
- Temporal spread reduces per-frame perceptual cost

**Compute cost:** ~1–3× real-time on CPU, sub-real-time on GPU. Video
watermarking runs asynchronously post-ingest — the watermarked video
replaces the unwatermarked one, at which point the witness re-signs the
new bytes.

**v1.0 scope:** ship image + audio in the ingest hot path; video ships as
a Phase-2 async post-processor (see §10).

## 6. Registry endpoint (for tier 1–3 lookup)

**Endpoint:** `GET https://witness.scruple.ai/v1/watermark-lookup/{fingerprint_hex}`

**Auth:** none (public — the whole point is any finder can trace).

**Rate limit:** aggressive per-IP (100/min baseline) to discourage
scraping our manifest registry.

**Request:** `fingerprint_hex` — 28-char lowercase hex (14 bytes = 112 bits).

**Response 200:**
```json
{
  "found": true,
  "manifest_url": "https://scruple.ai/receipt/SCR_A38E30FF",
  "manifest_hash_sha256": "…64 hex…",
  "signed_at": "2026-07-14T12:00:00Z",
  "signer_identity": "Scruple/0.1 via OCI Vault"
}
```

**Response 404:**
```json
{ "found": false, "detail": "no scruple-signed content with this fingerprint" }
```

**Storage:** SQLite table `watermark_registry` keyed on `manifest_fingerprint`,
populated at C2PA sign time. One row per signed manifest. Estimated volume:
one row per iteration; small.

**Privacy:** the endpoint returns the receipt URL, which is already public.
No new information disclosed.

## 7. Decoder API

Ships in three surfaces:

### 7.1 npm `@scruple/verify` (extend the existing verifier)

```typescript
import { readWatermark } from '@scruple/verify';
const result = await readWatermark(imageBytes, { mimeType: 'image/jpeg' });
// { found: true, tier: 1, version: 1, payload: { manifest_fingerprint: '…hex…' } }
```

### 7.2 CLI

```bash
scruple-verify watermark ./image.jpg
# → composite verdict: reads watermark, dispatches per tier, returns full
#   provenance graph as JSON (or human summary with --human)
```

### 7.3 Public URL (Q1 2027 per interoperability roadmap)

`https://scruple.ai/verify` accepts drag-and-drop or POST — decodes the
watermark, follows the resolution path, renders the receipt.

## 8. Robustness posture — what we claim + what we don't

**Watermark v1.0 survives (target):**
- JPEG re-encoding at quality ≥ 60
- Resize to 50% of original
- Crop to ≥ 60% of original
- Common social-platform re-encoding (Twitter/X, Facebook, Instagram, Discord)
- Mild color adjustment (± 10% brightness/contrast/saturation)
- Screenshot-of-a-screen (one pass only)

**Watermark v1.0 does NOT survive:**
- Intentional adversarial removal (dedicated ML-based watermark stripper)
- Extreme crop (< 50% of original)
- Heavy compositing / inpainting that replaces the watermarked region
- Screenshot-of-screenshot-of-screenshot (multi-hop analog holes)
- Prints followed by re-scan

**Failure mode when the watermark cannot be recovered:** decoder returns
`no-scruple-watermark`. Provenance verification falls back to C2PA + witness
chain (both layers still present when the file has not been re-encoded).

**False positive target:** < 10⁻⁶ (1 in a million random images should ever
produce a valid magic + ECC-passing payload). Enforced by:
- 8-bit magic prefix (2⁻⁸ prior)
- 128-bit ECC-protected payload (further orders of magnitude)
- Registry lookup (tier 1–3 payloads that resolve to real manifests are the
  only accepted positives)

## 9. Compliance mapping

### 9.1 EU Code of Practice — Sub-measure 1.1.2

- Applies to: **all Scruple-produced signed content**, regardless of lock
  tier
- Media types satisfied at v1.0 launch: raster images, audio
- Media types with roadmap gap: video (Phase 2), model files (out of scope
  for this layer entirely)

Combined with the existing 1.1.1 (C2PA metadata) and 1.1.3 (witness Merkle
chain) layers, this brings Scruple to full THREE-layer compliance under
Section 1 of the Code — one better than the current draft submission
promises.

### 9.2 EU AI Act Article 50(2)

- "Machine-readable" — payload is bit-exact decodable
- "Detectable as artificially generated" — magic + tier bits are the
  detection signal
- "Effective" — measured against the survival matrix in §8
- "Interoperable" — decoder is open source; spec is public in this doc
- "Robust and reliable as far as technically feasible" — §8 states the
  boundary honestly; video Phase-2 gap acknowledged

### 9.3 C2PA v2.x manifest binding

Every C2PA manifest we produce gets a new assertion
`org.scruple.watermark.v1` with fields `{tier, version, magic_hex,
ecc_scheme, encoder_lib_version}`. This lets a C2PA reader verify the
manifest matches the pixel-level watermark. Cross-layer integrity check.

## 10. Roll-out phases

**Phase 0 — Spec + prototype (2 weeks):** this doc + reference encoder/
decoder in Python + unit tests + robustness test corpus.

**Phase 1 — Image + audio, MVP integration (4 weeks):**
- `lib/watermark/embed.ts` + `lib/watermark/decode.ts` (thin TS wrappers
  over the reference Python)
- Wire into `lib/iterations/ingest.ts` immediately before output_hash
- Registry table + `witness.scruple.ai/v1/watermark-lookup/` endpoint
- `@scruple/verify` CLI extension
- New C2PA assertion `org.scruple.watermark.v1`

**Phase 2 — Video (4 weeks):**
- Async post-processor for MP4/MOV
- Watermarked video replaces unwatermarked; witness re-signs
- Same decoder surface

**Phase 3 — Public verifier URL (2 weeks):**
- `scruple.ai/verify` — drag-and-drop UI
- Registry proxy for tier 1–3 lookups
- RVN asset lookup for tier 4–5

**Phase 4 — Hardening (ongoing):**
- Attack corpus expansion
- Adversarial-robustness eval per new attack paper
- Per-payload versioning if we bump to v2

## 11. Testing plan

**Fixture set:**
- 1000 diverse images (ImageNet, celebrity photos, screenshots, charts,
  line art) — validate encode/decode round trip
- 100 audio clips (music, speech, silence, noise) — encode/decode
- Attack corpus per §8 — measure survival rate

**Regression tests:**
- Round trip through JPEG q=60, 70, 80, 90
- Round trip through resize to 25%, 50%, 75%
- Round trip through crop to 50%, 75%
- Simulated Twitter, Facebook, Instagram, Discord re-encoding pipelines
- False-positive test: 100k random ImageNet images through decoder →
  expect zero valid magic hits

**CI gate:** watermark tests run per commit. Survival-rate regression
> 5 percentage points fails CI.

## 12. Open questions

1. **Legal:** is any known patent held on the specific StegaStamp
   architecture in commercially deployed form? MVP research indicates no,
   but a lawyer's read before launch.
2. **Registry as GDPR concern:** the registry stores a fingerprint → URL
   mapping. Not personal data on its face. Confirm with counsel.
3. **Tier 3 semantics:** local-lock content isn't published — is a
   registry lookup useful? Alternative: tier 3 encodes local-lock hash
   but registry lookup returns `not-published` even if fingerprint matches.
4. **Audio floor duration:** 7-second minimum. What do we do for shorter
   clips? Options: don't watermark and flag; use a lower-payload scheme
   with reduced tier granularity; refuse to produce.
5. **Video async re-encode:** the watermarked video has a different hash
   than the un-watermarked one. If a caller had already downloaded the
   un-watermarked version, they'll fail verification against the new leaf.
   Design decision: do we hold delivery until watermark is done, or serve
   un-watermarked with a `watermark-pending` header? Recommend hold.
6. **Attack response:** if a specific watermark stripper is published,
   how fast can we ship v2? What signals do we watch for?

## 13. Version history

- **v1.0** (2026-07-14) — initial draft.
