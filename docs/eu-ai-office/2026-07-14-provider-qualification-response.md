# Response to the AI Office — Provider Qualification under Section 1 of the Code of Practice on Transparency of AI-Generated Content

**From:** Shaun Hargadine, on behalf of Docent Technologies DBA / Scruple
**To:** The AI Office
**Date:** 2026-07-14
**Re:** Signature to the Code of Practice on Transparency of AI-Generated Content — Provider qualification

---

Dear AI Office,

Thank you for your acknowledgement of our signature and for the opportunity to complete the assessment. Below is the information supporting our qualification as a provider of generative AI systems under Section 1 of the Code, together with a description of the systems, services, and deployment contexts covered by our signature.

## 1. Who we are

Scruple is a product of Docent Technologies (US-registered), operating publicly under the trade name "Scruple." Our public web presence is `scruple.ai`. We build cryptographic provenance and transparency infrastructure for AI-generated content, and we operate a reference generative-AI product that uses that infrastructure end-to-end.

We fall within Section 1 on two grounds simultaneously:

1. We **provide** generative AI systems under our own name (Scruple Studio, described below).
2. We **provide** the transparency infrastructure (Scruple Witness API + C2PA signing) that other providers use to satisfy their Article 50(2) marking obligations. Our signature covers both roles because both roles produce content into the Union market.

## 2. Systems we deploy (Section 1 — "AI systems")

The following third-party model families are deployed within our own product surfaces and therefore fall within our provider scope under Section 1:

| Model family | Modality | Purpose in Scruple |
|---|---|---|
| Stable Diffusion 1.5 | Image (txt2img, img2img) | Reference generation in Scruple Studio |
| Stable Diffusion XL (SDXL) | Image | Reference generation in Scruple Studio |
| FLUX.1 (dev, schnell) | Image | Reference generation in Scruple Studio |
| Kohya-ss trainer (with SDXL / SD1.5 base) | LoRA fine-tune | Reference training in Scruple Studio |
| SeedVR2 upscaler | Video super-resolution | Reference generation in Scruple Studio |
| AnimateDiff / VideoHelperSuite | Image → video / video composition | Reference generation in Scruple Studio |

None of these models are trained or owned by Scruple. We are their **downstream provider** in the sense of AI Act Article 3(3): we place these systems into the market inside our own product, under our own name, with our own responsibilities for output marking under Article 50(2). Where a base model already carries its own upstream provider (Stability AI, Black Forest Labs, etc.), we do not claim to be the model provider — we are the provider of the *system* that deploys them into Union-facing services.

## 3. Services we operate (Section 1 — "services")

The following are the current Scruple service surfaces, each of which either generates or bears responsibility for marking AI-generated content:

### 3.1 Scruple Studio (`scruple.ai`)

A web application that permits an end user to generate images, video, and fine-tuned models using the model set in §2. Every output produced by Scruple Studio is:

- **Cryptographically signed** with a C2PA v1/v2 manifest (see §5 for the technical evidence).
- **Marked as AI-generated** using the `c2pa.actions` assertion (action = `c2pa.created` when produced from scratch, `c2pa.opened + c2pa.edited` when derived from an ingested asset). The mark is machine-readable and satisfies Article 50(2)(a).
- **Imperceptibly watermarked at publication time** for raster image outputs, via a classical DCT spread-spectrum encoder with Reed-Solomon ECC protecting a 128-bit payload. The clean master is preserved unmodified; the watermark is applied to a derivative alongside for public distribution. Reference implementation is open at `services/watermark/`. Video and audio watermarking follows in Q4 2026.
- **Bound to the specific workflow and model weights** that produced it, via the leaf preimage of the Scruple witness chain (see §5). This provides an independent transparency layer beyond the C2PA manifest and the watermark.

### 3.2 Scruple Witness API (`witness.scruple.ai`)

A public HTTPS API that receives cryptographic hashes of AI-generated content from third-party providers, HMAC-signs a canonical audit leaf, chains the leaves, and publishes a Merkle root to a public ledger on a fixed cadence. Third-party providers use this API to satisfy their own Article 50(2) obligations without themselves having to operate the signing infrastructure.

The Witness API does not itself generate content. However, because we ship it as the infrastructure by which content is marked, and because a mismark by our infrastructure would defeat the Article 50(2) purpose for every content item it touched, we consider it inside the scope of our signature.

### 3.3 Scruple integrations (embedded in third-party creative tools)

We ship first-party integrations that mark AI-generated content at the moment of creation inside third-party host applications:

- **Autodesk Fusion 360** — palette add-in that signs AI-assisted CAD-model exports (shipping).
- **Kohya-ss on Modal** — witness integration for LoRA training outputs (shipping).
- **Adobe apps** (Photoshop, Illustrator, InDesign, Premiere, After Effects, Lightroom) — UXP plugins that hook the save event and sign C2PA manifests on the resulting file (implementation complete; deployment pending Adobe developer account activation).
- **ComfyUI (via Modal-hosted proxy)** — HTTP+WebSocket proxy that captures every graph submitted for inference and produces a signed leaf per iteration (shipping).

In each of these cases, the *ultimate* generation happens inside a third party's software or on a third party's compute. The Scruple integration is the transparency layer applied at the earliest possible moment. We consider this within Section 1 scope because the marking is our responsibility and our signature.

## 4. Deployment contexts

| Context | Description |
|---|---|
| Public SaaS | `scruple.ai` Web Studio — self-service accounts, Stripe billing, US + EU users |
| Public API | `witness.scruple.ai` — customer-scoped API keys, HMAC-authenticated |
| Embedded integrations | Adobe UXP, Fusion 360 add-in, Kohya proxy, ComfyUI proxy (see §3.3) |
| Custom single-tenant | Bespoke deployments per customer, running the same witness stack against the customer's own compute; per our commercial shape memo, this is the anticipated dominant form. Each deployment is registered as a distinct tenant under the same signature. |

All Union-facing deployments implement the same C2PA marking + witness leaf regime.

## 5. How the transparency obligations are satisfied technically

Attached separately (also available at `github.com/Docenttx/Scruple/tree/feature/witnessing-l2-sprint1/docs/c2pa-conformance-evidence/2026-07-14`) is the evidence bundle we assembled for the C2PA Conformance Program (Intake record ID `019f5856-bff8-7f57-a879-80594a6fb3fe`). It contains:

- Signed samples for 15 of the 16 output media types we assert we generate (PNG, JPEG, WebP, SVG, TIFF, Adobe DNG, HEIC, HEIF, AVIF, MP4, QuickTime, WAV, FLAC, MP3, MP4 audio; only PyTorch model manifests are pending an upstream library feature).
- Signed round-trip samples proving we validate C2PA-signed inputs across 18 of the 20 asserted input types (same list plus JPEG XL, GIF, AVI, PDF, PyTorch — with PDF and PyTorch pending the same upstream feature).
- The cryptographic chain used for signing (dev cert included; production signing uses AMD SEV-SNP + OCI Vault-isolated ES256).
- A reproducible Python build system for the bundle.

Every C2PA manifest produced by any of our systems is designed to be:

- **Machine-detectable** via `c2pa.actions.v2` — satisfies Article 50(2)(a).
- **Independently verifiable** via a public reference verifier (`scruple-verify` npm package + `c2pa-python` upstream) with no runtime dependency on Scruple infrastructure.
- **Chained to a public ledger** via the Scruple witness Merkle root, providing tamper-evidence beyond the C2PA manifest itself.

The imperceptible watermark layer (Sub-measure 1.1.2, raster image outputs) is documented in `docs/architecture/WATERMARK_DESIGN_v1.md` (design) and `services/watermark/` (reference implementation). Robustness against JPEG re-encoding at `q=75` and 75% linear resize is validated by `scripts/smoke-watermark.mjs`. Third-party decoding is available via the extended `scruple-verify watermark` subcommand.

## 6. What our signature does NOT cover

For clarity:

- We do NOT provide any general-purpose AI model on our own name. The base models we deploy (§2) remain the responsibility of their respective upstream providers.
- Our signature does not extend to third-party AI systems that use the Witness API without themselves signing the Code. Those providers remain responsible for their own compliance; we simply provide the infrastructure.
- We do not currently operate any deep-fake generation product. If we were to add one, we would supplement this qualification accordingly.

## 7. Contact

- **Signatory:** Shaun Hargadine, Docent Technologies
- **Technical:** `partners@scruple.ai`
- **Compliance / Code obligations:** `compliance@scruple.ai`
- **Public product page:** `scruple.ai`
- **Public evidence & source:** `github.com/Docenttx/Scruple`

Please let us know if any of the above requires elaboration or if the AI Office prefers a different structure for the systems/services/contexts identification. We can also make our technical contacts available for a call.

Thank you again for the opportunity.

Best regards,

**Shaun Hargadine**
Docent Technologies (DBA Scruple)
