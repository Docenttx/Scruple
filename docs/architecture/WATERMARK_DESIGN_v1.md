# Scruple Watermark — Design Specification v1.1

**Status:** Draft, for review.
**Author:** Scruple Engineering
**Date:** 2026-07-14
**Depends on:** `SCRUPLE_STANDARD_v1.md` v1.2; `SCRUPLE_INTEGRATION_REQUIREMENTS_v1.md` v1.2
**Companion:** `docs/eu-ai-office/evidence-bundle-2026-07-14/03-marking-implementation/marking-technical-spec.md` — this doc closes the Sub-measure 1.1.2 gap noted there.

## Change log

- **v1.1 (2026-07-14, later same day):** major architectural revision.
  Watermark step moved from generation-time to publication-time so the
  artist's working master stays clean; downstream img2img / img2vid /
  training pipelines get untainted input. New "master preservation
  invariant" (§4.2). Two-download UX. API contract for client-side
  watermarking added (§7.4). Storage/retention policy added (§8).
- **v1.0 (2026-07-14):** initial draft. Watermark step at ingest.

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

### 1.1 The "master vs release" separation

The watermark is a *release-time* mark, not a *generation-time* one. The
artist's clean master must survive every intermediate step of their
workflow (img2img, ControlNet, LoRA training input, further generation
passes). Perceptual watermarks are known to:

- **Partially propagate through low-denoise img2img**, distorting into
  specific regions of the output — decoders fail on the derivative.
- **Not propagate to img2vid outputs** (the model hallucinates new frames)
  — chain of custody breaks silently.
- **Be learned by training pipelines** if consistent across a training
  set (documented in the mid-2023 Getty Images / Stable Diffusion case).

For those reasons, applying the watermark at generation-time would fight
the artist's workflow AND poison downstream models. The watermark applies
only when the artist has decided to publish — locking, chain-locking, or
explicitly opting a checkpoint in.

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

Watermarking happens **at publication/lock time as a signed derivative
of the clean master**, not at generation. The pipeline splits into two
phases:

### 4.1 Phase A — generation (watermark never applied)

```
generate raw output (ComfyUI / Kohya / Fusion / external caller)
        │
        ▼
compute output_hash on CLEAN bytes
        │
        ▼
C2PA sign clean bytes (existing signer)
        │
        ▼
witness leaf commits clean output_hash
        │
        ▼
persist clean master + serve as the artist's working artifact
```

At this phase the artist can iterate freely — img2img, ControlNet, LoRA
training input, further generation passes — with no watermark interference.

### 4.2 Phase B — publication / lock (watermark applied as derivative)

Triggered by: user hits `Local Lock`, `Chain Lock`, `Publish`, or
`Checkpoint` with the (opt-in) watermark preference on.

```
clean master bytes (already exist from Phase A)
        │
        ▼
determine watermark payload for the requested tier:
    - Tier 1/2 (C2PA-only / checkpoint):  manifest_fingerprint
    - Tier 3 (local lock):                local_lock_hash
    - Tier 4 (chain-lock basic):          scr_id
    - Tier 5 (chain-lock pinned):         scr_id + pinned_hint
        │
        ▼
pack payload + ECC per §3
        │
        ▼
embed watermark → derivative bytes            ← ★ watermark step
(applied client-side by the customer's code
 using @scruple/watermark; server-side for
 Scruple Studio only — see §7.4)
        │
        ▼
compute derivative_output_hash on watermarked bytes
        │
        ▼
C2PA sign derivative bytes with:
    - action = "c2pa.edited"
    - ingredient = clean master (hash + reference)
    - assertion "org.scruple.watermark.v1" = watermark parameters
        │
        ▼
witness leaf commits derivative_output_hash
(chained as a child of the clean master's leaf)
        │
        ▼
persist derivative alongside master
        │
        ▼
serve BOTH via the two-download UX (see §4.3)
```

The clean master is never overwritten. The derivative is a distinct
artifact with its own hash, its own manifest, its own witness leaf, and
an explicit C2PA lineage assertion pointing back to the master.

### 4.3 Master preservation invariant (unconditional)

Regardless of any lock tier, watermark preference, or user action, the
following invariant holds:

> The clean master bytes produced at generation time are preserved and
> accessible to the owner for the artifact's entire retention window.
> No watermark, lock, or publication step ever modifies, overwrites, or
> deletes the master.

The clean master is:

- **Always downloadable** by the owner via the "Master" download control
  on the receipt page and by the `getMaster()` method on the API.
- **Always usable as pipeline input** — img2img source, ControlNet
  reference, LoRA training image, new generation prompt seed.
- **Always the primary c2pa.actions.v2 `c2pa.created` record**; every
  derivative traces back to it via `ingredient` assertions.

### 4.4 Tier determination — timing

- Tier of the master is always effectively "0 / unwatermarked."
- Tier of a derivative is set when the user triggers publication and
  the corresponding watermark payload is computed. Derivatives can be
  produced at multiple tiers over the artifact's lifetime (e.g. an
  artifact might get a Local Lock derivative on day 1 and a Chain Lock
  derivative on day 30 — both live alongside the master).
- The default per-tier watermark preferences (see §11) are user-adjustable
  in Settings; a `Watermark policy` value of `Follow lock tier default`
  produces the tabulated behavior.

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

### 7.4 Encoder API — client-side vs server-side

The Scruple witness architecture is zero-content by design: customers
send hashes, not bytes. That constraint carries into the watermark layer.
The encoder must be able to run in the customer's own process so raw
bytes never leave their environment.

**Distribution:**

- **`@scruple/watermark`** — Node/TypeScript library, browser + Node,
  MIT-licensed. Ships the image + audio encoders + decoders + payload
  builder. Reference implementation of the spec in this doc.
- **`scruple-watermark` (PyPI)** — Python equivalent for server-side
  integrations (Kohya trainer, ComfyUI custom node, generic scripts).
- **Rust core** (`scruple-watermark-core`) — perf-critical primitives,
  WASM build for browser use.
- Server-side operation available for callers on the SaaS `scruple.ai`
  surface only (Scruple Studio Web, direct API callers who accept
  transmitting bytes).

**Two API shapes:**

**Client-side embedding (default for integrators):**

```typescript
import { buildPayload, embedWatermark } from '@scruple/watermark';

// 1. Ask Scruple for the payload that corresponds to the intended tier
//    (returns the manifest fingerprint or SCR-ID + tier byte).
const { payload, tier } = await scruple.requestWatermarkPayload({
  masterHash: sha256(cleanBytes),
  intendedTier: 'chain-lock-basic',
});

// 2. Embed locally — bytes never transit.
const derivativeBytes = await embedWatermark(cleanBytes, {
  mimeType: 'image/png',
  payload,
  tier,
});

// 3. Hash the derivative and hand back the hash for signing + witness.
const derivativeHash = sha256(derivativeBytes);
const receipt = await scruple.signDerivative({
  masterHash: sha256(cleanBytes),
  derivativeHash,
  tier,
});
```

**Server-side embedding (for SaaS surfaces only):**

```typescript
// Bytes uploaded once; Scruple runs the whole pipeline in-process.
const { masterReceipt, derivativeReceipt } =
  await scrupleSaas.publishWithWatermark({
    bytes: cleanBytes,
    mimeType: 'image/png',
    tier: 'chain-lock-basic',
  });
```

**Payload-request endpoint** (client-side flow, called at step 1 above):

```
POST /v1/watermark/payload
Authorization: Bearer <tenant_key>
X-Scruple-Signature: <hmac over body>

{
  "master_hash": "sha256:...",
  "intended_tier": "chain-lock-basic",
  "chain_lock_id_ref": "SCR_A38E30FF"   // required for tier 4/5
}
→
{
  "payload_hex": "5c14a3...",   // 32 hex = 128 bits, packed per §3
  "tier": 4,
  "version": 1,
  "encoder_recommendation": "stegastamp-v1"
}
```

**Sign-derivative endpoint** (called at step 3, mirrors existing /v1/log
ingest with lineage fields):

```
POST /v1/log/<stream>
Authorization: Bearer <tenant_key>
X-Scruple-Signature: <hmac>

{
  ...standard leaf fields...
  "master_hash": "sha256:<clean-bytes-hash>",
  "watermark_payload_hex": "5c14a3...",
  "action": "c2pa.edited",
  "ingredient_master_leaf_hash": "sha256:<clean-master-leaf>"
}
```

The server verifies the payload matches the tier + master combination
before signing the derivative — so a caller cannot claim a chain-lock
watermark without actually holding the corresponding chain lock.

## 7.5 Two-download UX

Every artifact that has BOTH a clean master and one or more derivatives
exposes two distinct download controls:

- **"Master (clean, for re-editing / re-generation)"** — the untainted
  bytes produced at Phase A. Always available to the owner. Use this for
  further pipeline work (img2img, LoRA training, downstream generation).
- **"Release (watermarked, for public distribution / evidence)"** — the
  most recent derivative for the artifact's highest active lock tier.
  Use this when publishing publicly, when the compliance/evidence value
  of the watermark matters, or when handing the artifact to a court /
  regulator / journalist.

For artifacts with multiple derivative tiers (e.g. Local-Lock derivative
+ Chain-Lock derivative for the same master), the UI shows all of them
grouped by tier with the highest tier as the primary "Release" control.

**On the receipt page:** master and each derivative are shown with their
own hashes and a lineage diagram (master → derivative-1 → derivative-2)
so a third party sees the full chain at a glance.

**In the Evidence Bundle** (when we ship that product concept): both the
master and the current release are included in the ZIP, plus a
`LINEAGE.md` explaining the relationship for the reader.

**API surface — `getMaster()` and `getRelease()`:**

```typescript
const master = await scruple.getMaster(scrId);              // clean bytes
const release = await scruple.getRelease(scrId);            // watermarked
const releases = await scruple.listReleases(scrId);         // all derivatives
```

Access control: the master download requires owner authentication.
Release downloads are public per the artifact's publication mode
(Full / Hash-only / Witness-only).

## 8. Storage and retention policy

### 8.1 What Scruple stores

For each artifact:

- **Clean master bytes** — stored under user's storage provider (Drive /
  OneDrive / GitHub) or Scruple-hosted for the SaaS surface. Retained
  for the artifact's entire lifecycle regardless of watermark or lock
  activity.
- **Master hash + signed manifest + witness leaf** — always, forever
  (they're the ledger record).
- **Derivative bytes** — stored alongside the master under the same
  storage provider, one per watermark tier applied. Retained same as
  master.
- **Derivative hashes + signed manifests + witness leaves** — always,
  forever.

### 8.2 What integrators / customers store

For zero-content integrations (Kohya, ComfyUI, custom customer flows):

- Customer's environment retains the clean master bytes (they never
  transit to Scruple).
- Customer's environment computes the derivative bytes locally using
  `@scruple/watermark`.
- Customer's environment retains derivative bytes for as long as the
  customer needs them for public distribution / evidence.
- Scruple retains only the hashes and signatures.

Customers integrating this must design their own retention policy for
the master bytes; Scruple's witness chain will remain valid indefinitely
regardless of whether the customer still has the bytes.

### 8.3 Recovery

If a customer loses the master bytes but has retained the derivative:

- The derivative is still a valid signed C2PA artifact — evidence value
  intact.
- The lineage assertion inside the derivative's manifest points back to
  the master's hash. If the master bytes are later recovered from any
  source, the hash match re-links the two.
- If the master bytes are permanently lost, the derivative alone is
  still verifiable — the evidence chain is not broken.

## 9. Robustness posture — what we claim + what we don't

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

## 10. Compliance mapping

### 10.1 EU Code of Practice — Sub-measure 1.1.2

- **Timing:** watermark applied at publication/lock, not at generation.
  This matches the Code's framing — the mark is on content the provider
  places into the market, not on internal artifacts.
- **Applies to:** all Scruple-produced published/locked content across
  all tiers where the user has opted in (default: on for Local Lock and
  Chain Lock; opt-in for Checkpoint; not applied to unpublished masters
  by design).
- **Not applied to:** masters intended for internal pipeline reuse
  (img2img input, training input) — technically feasible reason: applying
  a perceptual watermark to pipeline-input images degrades downstream
  model output and can poison training data, defeating the mark's
  purpose. Article 50(2)'s "as far as technically feasible" clause
  applies here.
- **Media types satisfied at v1.0 launch:** raster images, audio.
- **Media types with roadmap gap:** video (Phase 2), model files (out
  of scope for this layer entirely).

Combined with the existing 1.1.1 (C2PA metadata) and 1.1.3 (witness Merkle
chain) layers, this brings Scruple to full THREE-layer compliance under
Section 1 of the Code — one better than the current draft submission
promises.

### 10.2 EU AI Act Article 50(2)

- "Machine-readable" — payload is bit-exact decodable
- "Detectable as artificially generated" — magic + tier bits are the
  detection signal
- "Effective" — measured against the survival matrix in §8
- "Interoperable" — decoder is open source; spec is public in this doc
- "Robust and reliable as far as technically feasible" — §8 states the
  boundary honestly; video Phase-2 gap acknowledged

### 10.3 C2PA v2.x manifest binding

Every C2PA manifest we produce gets a new assertion
`org.scruple.watermark.v1` with fields `{tier, version, magic_hex,
ecc_scheme, encoder_lib_version}`. This lets a C2PA reader verify the
manifest matches the pixel-level watermark. Cross-layer integrity check.

## 11. Per-tier watermark policy defaults

| Lock tier | C2PA sign | Watermark default | Rationale |
|---|---|---|---|
| Generate | ✓ always | never — invariant | Master must stay clean for pipeline reuse |
| Checkpoint | ✓ always | OFF (opt-in) | Save-point, not publication |
| Local lock | ✓ always | ON (opt-out) | Publication implied; local evidence |
| Chain lock (basic) | ✓ always | ON (opt-out) | Public evidence; encodes SCR-ID |
| Chain lock (pinned) | ✓ always | ON (opt-out) | Public evidence; encodes SCR-ID + hint |

**Per-user override** in Settings → Marking:
- `Always on` — apply to every derivative regardless of tier default
- `Always off` — never apply (only for users with explicit non-EU
  jurisdictions; not recommended for EU market)
- `Follow lock tier default` — the values in the table above (default)

**Per-integration override** — Adobe UXP plugin, Fusion palette, and
Kohya integration can override at the request level via
`spec.publicationTier` and `spec.watermarkOverride`. Useful for hosts
where the customer knows in advance that a specific asset flow is
publish-only (Photoshop export) vs iterate-only (Fusion working file).

## 12. Roll-out phases

**Phase 0 — Spec + prototype (2 weeks):** this doc + reference encoder/
decoder in Python + unit tests + robustness test corpus.

**Phase 1 — Image + audio, MVP integration (4 weeks):**
- `@scruple/watermark` npm package (Node + browser) — public library
- `scruple-watermark` PyPI package — public library
- `lib/watermark/embed.ts` — server-side wrapper for the SaaS surface
  (Scruple Studio Web)
- Wire into the lock/publish path (NOT ingest — masters stay clean):
  - `/api/lock/checkpoint` — optional watermark step if opted in
  - `/api/lock/local` — default-on watermark step
  - `/api/lock/chain/*` — default-on watermark step
- Registry table + `witness.scruple.ai/v1/watermark-lookup/` endpoint
- `POST /v1/watermark/payload` + `POST /v1/log/<stream>` derivative
  lineage fields (see §7.4)
- Two-download UX in receipt page: master + release
- `@scruple/verify` CLI + `getMaster()` / `getRelease()` API additions
- New C2PA assertion `org.scruple.watermark.v1`
- Integration guide update: `docs/api/watermark-integration.md`

**Phase 2 — Video (4 weeks):**
- Async post-processor for MP4/MOV (server-side only for now — client-side
  video watermarking is materially more complex and can wait)
- Watermarked video derivative persisted alongside master
- Same decoder surface

**Phase 3 — Public verifier URL (2 weeks):**
- `scruple.ai/verify` — drag-and-drop UI
- Registry proxy for tier 1–3 lookups
- RVN asset lookup for tier 4–5

**Phase 4 — Hardening (ongoing):**
- Attack corpus expansion
- Adversarial-robustness eval per new attack paper
- Per-payload versioning if we bump to v2
- Client-side video watermarking (moves video off the SaaS-only surface)

## 13. Testing plan

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

## 14. Open questions

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

## 15. Version history

- **v1.1** (2026-07-14, later) — watermark moved to publication/lock as
  signed derivative; master preservation invariant; two-download UX;
  client-side API surface; storage/retention.
- **v1.0** (2026-07-14) — initial draft (watermark at ingest, single
  copy). Superseded.
