# Scope inventory — systems, services, deployment contexts

**Companion:** `scope-matrix.csv` (same data, CSV format for the AI Office's tabular preference per the DSA Article 24 template pattern).

**Basis under Section 1 of the Code:** third-party marking-technology-vendor slot ("providers of marking and detection solutions… to demonstrate that their marking and detection solutions comply with the requirements of Article 50(2) and (5)") PLUS ordinary downstream-provider slot for the specific outputs of Scruple Studio.

## Rows

| # | System | Deployment surface | Content types | Marking method | Standards | Detection endpoint | Interop status (2027-02-02) |
|---|---|---|---|---|---|---|---|
| 1 | Stable Diffusion 1.5 (Runway / Stability AI upstream) | Scruple Studio Web (`scruple.ai`) | image | 1.1.1 C2PA v2.x + 1.1.2 DCT imperceptible watermark (128-bit payload, Reed-Solomon ECC) applied at publication time + 1.1.3 Merkle-anchored witness leaf | C2PA v2.x; ISO/IEC 21617-1:2025 compatible manifest engine; Scruple watermark reference (open source at `services/watermark/`) | `scruple-verify` (npm, open source; includes watermark subcommand); planned public verify URL per §6 of cover letter | 1.1.1 shipped; 1.1.2 shipped (raster image, local-lock); 1.1.3 shipped |
| 2 | Stable Diffusion XL (Stability AI upstream) | Scruple Studio Web | image | same as row 1 | same | same | same |
| 3 | FLUX.1 dev / schnell (Black Forest Labs upstream) | Scruple Studio Web | image | same as row 1 | same | same | same |
| 4 | Kohya-ss LoRA trainer (base = SDXL / SD 1.5) | Scruple Studio (Kohya tab) + Kohya-ss on Modal integration | LoRA fine-tune (mlModel/pytorch) | 1.1.1 C2PA sidecar manifest bound to training output hash + 1.1.3 witness leaf on final checkpoint | C2PA v2.x mlModel category (wrapper feature pending, see appendix); IPTC `trainedAlgorithmicMedia` | `scruple-verify` | 1.1.1 shipped for sidecar; wrapper limit acknowledged; 1.1.3 shipped |
| 5 | SeedVR2 video upscaler (numz upstream) | Scruple Studio (Canvas) + ComfyUI integration | video | 1.1.1 C2PA v2.x + 1.1.3 witness leaf | C2PA v2.x video (MP4/MOV/AVI); BMFF hash assertion | `scruple-verify` | 1.1.1 shipped; 1.1.3 shipped |
| 6 | AnimateDiff / VideoHelperSuite (Kosinkadink upstream) | Scruple Studio (Canvas) + ComfyUI integration | video | same as row 5 | same | same | same |
| 7 | Third-party AI systems using Scruple Witness API | `witness.scruple.ai` public API | image, video, audio, text-adjacent artefacts (as reported by caller) | 1.1.1 signature + 1.1.3 witness leaf, both applied by Scruple to hashes supplied by caller; 1.1.2 available to callers via the open-source Scruple watermark reference (invoked client-side by caller, then chained via `/v1/log` fields `master_hash` + `watermark_payload_hex` + `ingredient_master_leaf_hash`) | C2PA v2.x; Scruple Standard v1.2; Scruple watermark reference | Same public verify URL when it publishes | 1.1.1 shipped; caller assertion; 1.1.2 API surface shipped, caller integration; 1.1.3 shipped |
| 8 | Adobe Photoshop (embedded Scruple UXP plugin) | Adobe Photoshop | image (any Adobe-supported output type) | Save-hook 1.1.1 C2PA manifest + 1.1.3 witness leaf | C2PA v2.x; Content Credentials-compatible | Adobe Verify + `scruple-verify` | 1.1.1 shipped; plugin release pending Adobe developer account activation |
| 9 | Adobe Illustrator / InDesign / Premiere / After Effects / Lightroom (embedded Scruple UXP plugins) | Respective Adobe applications | image / video / composite | same pattern as row 8 | same | same | same |
| 10 | Autodesk Fusion 360 (embedded Scruple palette add-in) | Autodesk Fusion 360 | image + CAD assets (Adobe-DNG, TIFF for renders) | 1.1.1 C2PA manifest on rendered exports + 1.1.3 witness leaf on CAD source hash | C2PA v2.x | `scruple-verify` | 1.1.1 shipped; 1.1.3 shipped |
| 11 | Any customer-hosted generative AI pipeline (custom single-tenant deployment) | Bespoke per customer; runs the same Witness API stack against customer's own compute | image / video / audio / mlModel per customer | 1.1.1 + 1.1.3 applied by Scruple witness layer identically to public API | C2PA v2.x; Scruple Standard v1.2 | Same public verify URL when it publishes | Same as row 7 |

## Basis-under-Article-50(2) mapping

- All rows 1–11 satisfy Article 50(2)'s **machine-readable** requirement via C2PA (Sub-measure 1.1.1).
- All rows satisfy the **detectable as artificially generated or manipulated** requirement via the `c2pa.actions.v2` assertion (`c2pa.created` or `c2pa.opened + c2pa.edited`) plus the IPTC `trainedAlgorithmicMedia` / `compositeSynthetic` Digital Source Type values embedded within the C2PA manifest.
- **Effective** — verified by independent readback in the C2PA Conformance evidence bundle (15 of 16 GENERATE MIMEs verified `validation_state=Valid`).
- **Interoperable** — C2PA is the industry consensus for Sub-measure 1.1.1; JPEG Trust ISO/IEC 21617-1:2025 adopts the same manifest engine.
- **Robust and reliable as far as technically feasible** — the 1.1.3 witness Merkle chain addresses C2PA's documented manifest-stripping failure mode; the 1.1.2 imperceptible watermark (raster image outputs) survives typical downstream re-encoding and resize.

## Basis under Article 3(3) — downstream provider

For rows 1–6, Scruple is the **downstream provider** in the Article 3(3) sense: we place these AI systems into the Union market inside our own product (Scruple Studio) under our own name, with our own Article 50(2) marking responsibility for the outputs. Base-model providers retain their own upstream responsibilities.

For rows 8–10, Scruple is the **provider of the marking technology** embedded in a third-party host application. The generative operation itself belongs to the operator of the host application (e.g. the Photoshop user); Scruple is responsible for the marking regime applied.

For rows 7 and 11, Scruple is the **provider of the marking service** consumed by another provider. That upstream provider retains their own Article 50(2) responsibility for their outputs; Scruple guarantees the marking mechanics for the hashes they submit.

## SME proportionality (Section 1)

Docent Technologies has ≤10 headcount and turnover well under the SME threshold. Section 1 of the Code provides for lighter documentation for SMEs and small mid-caps, with regular intervals against internal benchmarks. This annex is designed to satisfy the qualification request while respecting that proportionality principle — structured tables + short prose per field, no gold-plated compliance surface.
