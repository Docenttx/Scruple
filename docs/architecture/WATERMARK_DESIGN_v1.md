# Scruple Watermark — Design Specification v1.2

**Status:** Draft, for review.
**Author:** Scruple Engineering
**Date:** 2026-07-14
**Depends on:** `SCRUPLE_STANDARD_v1.md` v1.2; `SCRUPLE_INTEGRATION_REQUIREMENTS_v1.md` v1.2
**Companion:** `docs/eu-ai-office/evidence-bundle-2026-07-14/03-marking-implementation/marking-technical-spec.md` — this doc closes the Sub-measure 1.1.2 gap noted there.

**Design principle:** minimum compliance now, expansion-ready. Ship the
smallest thing that satisfies EU Code Sub-measure 1.1.2 + Article 50(2)
without introducing new server-side surfaces we'd have to maintain,
secure, and reason about GDPR-wise. Every optional expansion is
architected in but not implemented.

## Change log

- **v1.2 (2026-07-14, evening):** simplification. Recognized that no
  regulation requires per-artifact public receipts (see §10), and that
  Scruple's own receipts are user-controlled by design. Removed
  Scruple-hosted `witness.scruple.ai/v1/watermark-lookup` registry
  entirely — RVN is the public lookup for tier 4/5, tier 1-3 need no
  lookup at all. Removed `POST /v1/watermark/payload` — payload
  construction is fully client-side (nothing tier 1-3 needs from us;
  chain-lock event already gave the client the SCR_ID for tier 4-5).
  Simplified payload structure per §3 accordingly.
- **v1.1 (2026-07-14, later):** watermark moved to publication/lock as
  signed derivative; master preservation invariant; two-download UX;
  client-side API surface; storage/retention.
- **v1.0 (2026-07-14):** initial draft (watermark at ingest, single
  copy). Superseded.

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

Tier byte determines how the 112 body bits are interpreted. Load-bearing
principle: **no tier body encodes anything that requires a Scruple-hosted
server-side lookup to resolve.** Tier 1-3 are self-contained (magic + time
+ future-optional bits); tier 4-5 encode SCR_ID which resolves against
the public RVN chain, not Scruple infrastructure.

```
tier | name               | body layout                                                       | resolution path
-----+--------------------+-------------------------------------------------------------------+---------------------------------
0    | reserved           | (unused)                                                          | —
1    | c2pa-signed        | [ signed_at_unix_seconds: 64 bits ] [ reserved: 48 bits ]         | no lookup (self-contained)
2    | checkpoint         | [ signed_at_unix_seconds: 64 bits ] [ reserved: 48 bits ]         | no lookup (self-contained)
3    | local-lock         | [ signed_at_unix_seconds: 64 bits ] [ reserved: 48 bits ]         | no lookup (self-contained)
4    | chain-lock basic   | [ scr_id: 64 bits ] [ reserved: 48 bits ]                         | public RVN asset lookup
5    | chain-lock pinned  | [ scr_id: 64 bits ] [ pinned_hint: 48 bits ]                      | public RVN + IPFS/Arweave
6..15| reserved           | (future — subscription tiers, per-jurisdiction marks, etc.)       | TBD
```

Where:
- `signed_at_unix_seconds` = the Scruple signer's UTC timestamp at the
  moment the derivative was signed. 64-bit unsigned. Useful in verifier
  UX ("AI-generated at time T"), does NOT link to any artist identity or
  private receipt.
- `scr_id` = the 8-byte / 16-hex Scruple SCR-ID that names the RVN asset
  minted at chain-lock time. Packed as a big-endian u64. (SCR-IDs are
  6-8 hex chars → 24-32 bits; padded to 64 for future room.)
- `pinned_hint` = short lookup key that resolves the IPFS CID and Arweave
  txid through the RVN asset's chain metadata (avoids embedding the full
  IPFS CID in a 48-bit budget).

**Why no manifest_fingerprint anymore:** the v1.1 design encoded a
14-byte fingerprint of the C2PA manifest for tier 1-3, resolvable via a
Scruple-hosted registry endpoint that returned the receipt URL. But no
regulation requires per-artifact public receipts (see §10), and Scruple's
own receipts are user-controlled by design (per SCRUPLE_STANDARD_v1.md).
A Scruple-hosted registry would leak information the artist chose to
keep private and add a server-side surface with GDPR + retention +
availability obligations that aren't compliance-required. The v1.2
simplification removes it entirely.

### 3.2 Payload lookup rules for a decoder

Given a decoded payload:

1. Verify `magic == 0x5C` and `version` is supported. If either fails,
   return `no-scruple-watermark`.
2. Read tier.
3. Dispatch:
   - **Tier 1/2/3** → no lookup. Decoder returns
     `{ tier, version, signed_at_unix_seconds }`. Verifier UX renders
     "AI-generated by Scruple-marked pipeline at time T. To identify
     the artist or verify the full C2PA manifest, obtain the file's
     receipt from the artist or from any location where they've
     published it (e.g. IPFS)."
   - **Tier 4/5** → resolve SCR-ID to RVN asset directly against the
     public RVN chain (no Scruple dependency). RVN asset metadata
     includes the content hash; optionally IPFS CID + Arweave txid for
     tier 5. From there the verifier fetches the full provenance
     package publicly (if the artist pinned it) or contacts the artist.
4. Return the composite verdict object (see §7.2).

**What tier 1-3 does NOT reveal:** identity of the artist, contents of
the manifest, workflow, model, machine, time-of-generation (only
time-of-signing), lock history, or anything that would link the artifact
back to a specific Scruple account.

**What tier 4-5 does reveal:** the SCR-ID (which the artist affirmatively
published to RVN by chain-locking) and everything derivable from that
public marker. The artist opted into that disclosure at chain-lock time.

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

## 6. Public lookup infrastructure

**Scruple hosts no watermark registry.** All public lookup uses
infrastructure that already exists and is not operated by Scruple:

- **Tier 4** — SCR_ID resolves against the public Ravencoin chain via any
  RVN explorer or direct chain query. The RVN asset's data field carries
  the content hash the artist chain-locked. The verifier fetches the
  provenance package from the artist directly, or from IPFS if the
  artist chose to pin.
- **Tier 5** — same RVN resolution, and the `pinned_hint` bits let the
  verifier construct the IPFS CID + Arweave txid without a Scruple
  round-trip. Both IPFS and Arweave are public infrastructure.
- **Tier 1-3** — no lookup needed by design (see §3.1). The watermark
  says "AI-generated, Scruple-marked pipeline, time T" and stops there.
  Artist controls disclosure beyond that.

**No `watermark_registry` table on Scruple's side.** No
`witness.scruple.ai/v1/watermark-lookup/` endpoint. No new database
migration. No new public HTTP surface with GDPR / retention / availability
obligations.

**If future compliance requirements demand a Scruple-hosted lookup
service:** the 48 reserved bits per tier body (§3.1) leave room to
encode a future `fingerprint_or_lookup_ref` field without breaking v1
decoders. Version 2 of the payload spec would carry it; v1 decoders
would gracefully ignore it and return the same "self-contained" verdict
they do today. Expansion-ready without over-building now.

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

**Payload construction — fully client-side (no server round-trip):**

The payload is a pure function of `tier + (timestamp OR scr_id + hint)`.
All inputs are known to the client at watermark time:

- Tier 1-3: `signed_at_unix_seconds` is the client's current UTC time
  captured just before embed; no lookup needed.
- Tier 4-5: `scr_id` was returned to the client by the preceding chain-lock
  operation (existing `/v1/lock/chain-lock-*` endpoints already return it).
  `pinned_hint` is derived locally from the IPFS CID / Arweave txid the
  client already holds after the pin.

`@scruple/watermark` and `scruple-watermark` both ship a `buildPayload()`
helper that packs the 128 bits per §3 given a tier and the relevant local
inputs. No network call. No API key required for this step.

**Sign-derivative endpoint** (called after client-side embed, mirrors
existing /v1/log ingest with lineage fields):

```
POST /v1/log/<stream>
Authorization: Bearer <tenant_key>
X-Scruple-Signature: <hmac>

{
  ...standard leaf fields...
  "master_hash": "sha256:<clean-bytes-hash>",
  "watermark_payload_hex": "5c...",
  "action": "c2pa.edited",
  "ingredient_master_leaf_hash": "sha256:<clean-master-leaf>"
}
```

The server verifies:
- `watermark_payload_hex` bytes 0 = `0x5C` (magic) and bytes 1 = supported version
- Payload's tier byte matches the tier the caller is claiming
- For tier 4/5: the payload's SCR_ID matches the caller's actual chain-lock
  record on file. Prevents a caller from claiming a chain-lock watermark
  without actually holding the corresponding lock.
- For tier 1/2/3: the payload's timestamp is within a reasonable clock-skew
  window of the sign request time (guards against replay-mismatch).

No new endpoints. `POST /v1/log/<stream>` gains three optional fields; the
server-side validation logic gains ~30 lines.

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

The 6-question list in v1.1 was reduced by the v1.2 simplification.
Three questions were resolved by design:

- ~~Patent check on StegaStamp~~ — 5+ years in the wild, MIT-licensed
  reference implementation, no enforcement action. Ship with StegaStamp;
  fall back to classical DCT if any signal emerges. Not a lawyer question.
- ~~Registry GDPR review~~ — no registry exists in v1.2 (see §6). The
  data-controller surface is unchanged from today. Not a lawyer question.
- ~~Tier 3 semantics~~ — no registry means no lookup means no ambiguity.
  Tier 3 watermarks are self-contained "AI-generated at time T" marks,
  same as tier 1-2. Resolved by removal.

Remaining real questions (product decisions):

1. **Audio floor duration:** 7-second minimum for 20 bps schemes. What
   do we do for shorter clips? Options: (a) don't watermark, return a
   `watermark-skipped-short-clip` flag in the C2PA manifest, or (b) use
   a lower-payload scheme (fewer bits, reduced tier granularity) for
   short clips. Recommend (a) — simpler, honest.
2. **Video async re-encode UX:** the watermarked video has a different
   hash than the un-watermarked one. Do we hold delivery until watermark
   is done, or serve un-watermarked with a `watermark-pending` header
   and re-serve when ready? Recommend hold — simpler, no confusion.
3. **Attack response cadence:** if a specific watermark stripper is
   published, how fast can we ship v2? What signals do we watch for?
   Recommend defining a signal set + response SLA before Phase 1 ships
   so we're not scrambling later.

## 15. Version history

- **v1.2** (2026-07-14, evening) — minimum-compliance simplification.
  Registry endpoint removed; payload construction fully client-side;
  tier 1-3 payloads are self-contained "AI-generated at time T" marks;
  tier 4-5 resolve against public RVN chain (no Scruple dependency).
  48 reserved bits per body leave room for a future v2 payload without
  breaking v1 decoders.
- **v1.1** (2026-07-14, later) — watermark moved to publication/lock as
  signed derivative; master preservation invariant; two-download UX;
  client-side API surface; storage/retention.
- **v1.0** (2026-07-14) — initial draft (watermark at ingest, single
  copy). Superseded.
