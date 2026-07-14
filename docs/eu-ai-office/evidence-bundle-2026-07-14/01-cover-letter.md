# Response to the AI Office — Provider Qualification under Section 1 of the Code of Practice on Transparency of AI-Generated Content

**Signatory:** Shaun Hargadine, on behalf of Docent Technologies (DBA "Scruple")
**Date:** 2026-07-14
**Re:** Follow-up to signature of the Code of Practice on Transparency of AI-Generated Content — information supporting qualification as a provider

---

Dear AI Office,

Thank you for your acknowledgement and for the opportunity to complete the assessment. This letter identifies the systems, services and deployment contexts covered by Scruple's signature. Structured tables are attached as annex; this letter provides context per the AI Office's preferred style precedent (GPAI Training-Content Summary Template — short prose per field, structured artefact separately).

## 1. Provider identity

Docent Technologies (US-registered), trading publicly as **Scruple** (`scruple.ai`). Small mid-cap in the sense of the Code's Section 1 proportionality principle — ≤10 headcount as of the signature date. We invoke that proportionality clause where relevant below.

## 2. Basis of qualification under Section 1

Scruple qualifies under Section 1 on the third-party marking-technology-vendor basis explicitly opened by the Code: we provide marking and detection solutions for AI-generated content. We additionally operate a reference generative product (Scruple Studio) that uses that infrastructure end-to-end, which brings us under the ordinary provider basis for the specific outputs of that reference product.

## 3. Marking regime — multi-layered per Section 1

Scruple satisfies the multi-layered requirement of Section 1 with the following two sub-measures on every AI-generated output produced through our infrastructure:

- **Sub-measure 1.1.1 — Digitally signed metadata.** Every output is signed with a C2PA v2.x manifest (ES256 in production, key-isolated in AMD SEV-SNP + OCI Vault). Machine-readable per Article 50(2); technique family enumerated in Recital 133 ("cryptographic methods for proving provenance and authenticity of content"); industry-consensus solution recognised by IPTC as the current de facto Sub-measure 1.1.1 implementation.

- **Sub-measure 1.1.3 — Fingerprinting / logging.** Every output additionally emits a per-iteration cryptographic leaf into the Scruple witness chain. Leaves are Merkle-chained and the root is anchored to a public ledger on a fixed cadence. This is a fingerprint+logging method in the Recital 133 sense that persists even if the C2PA manifest is stripped downstream — a documented C2PA v2.0 failure mode that the second layer directly addresses.

We do not currently satisfy Sub-measure 1.1.2 (imperceptible watermark). Interoperability roadmap in §6 below.

## 4. Standards conformance

- **C2PA specification v2.x** — normative for Sub-measure 1.1.1 outputs. Evidence bundle at `github.com/Docenttx/Scruple/tree/feature/witnessing-l2-sprint1/docs/c2pa-conformance-evidence/2026-07-14` demonstrates 15/16 asserted GENERATE media types and 18/20 asserted VALIDATE media types signing and validating correctly with cryptographically verified manifests (C2PA Conformance Program Intake record ID `019f5856-bff8-7f57-a879-80594a6fb3fe`).
- **ISO/IEC 21617-1:2025 (JPEG Trust)** — Scruple manifests are structurally compatible; JPEG Trust adopts the same C2PA manifest engine.
- **IPTC PhotoMetadata Digital Source Type** — `trainedAlgorithmicMedia` / `compositeSynthetic` categories are the values we emit inside our C2PA `c2pa.actions.v2` assertions.

## 5. Systems, services, deployment contexts — see structured annex

The full inventory is in `02-provider-identification/scope-inventory.md` and its accompanying `scope-matrix.csv`. Summary counts:

- **AI systems deployed** (Scruple as downstream provider under Article 3(3)): 6 model families (Stable Diffusion 1.5, SDXL, FLUX.1, Kohya-ss LoRA trainer, SeedVR2 video upscaler, AnimateDiff / VideoHelperSuite). Base models remain the responsibility of their upstream providers.
- **Service surfaces** produced or marked by Scruple: 4 (Scruple Studio Web, Scruple Witness API, embedded integrations for Adobe/Fusion/Kohya/ComfyUI, custom single-tenant deployments).
- **Deployment contexts:** public SaaS, public HTTPS API, embedded plugin, custom single-tenant. All Union-facing where offered.

## 6. Interoperability roadmap to 2 February 2027

- Q3 2026: publish canonical Scruple Standard v1.2 to `docs/architecture/SCRUPLE_STANDARD_v1.md` at repo permalink — done.
- Q4 2026: expose the Sub-measure 1.1.1 signing surface to downstream vendors via the same Witness API path our integrations use; publish `witness-integration.md` as normative for third parties — done in draft form.
- Q4 2026: begin Sub-measure 1.1.2 (imperceptible watermark) evaluation; candidate: Google SynthID open-source (image, audio, text-open) integration for outputs produced by Scruple Studio directly, gated on SynthID model-family availability for the base models we deploy.
- Q1 2027 (target: 2 February 2027 deadline): interoperable detection endpoint per the Code — publish a public verification URL similar to OpenAI's `openai.com/verify` model that accepts any Scruple-signed artefact (any C2PA-compatible artefact in principle) and returns the interoperable verdict.

## 7. What our signature explicitly does not cover

- We are not the provider of any general-purpose AI model. Base models remain their upstream providers' responsibility.
- Our signature does not extend to third-party AI systems that use the Witness API without themselves signing the Code — those providers remain responsible for their own Article 50(2) compliance.
- We do not currently operate any deep-fake product. Should we do so, we will supplement this qualification.

## 8. Compliance contact

- Signatory (bound authority): Shaun Hargadine, Docent Technologies
- Technical: `partners@scruple.ai`
- Compliance / Code obligations: `compliance@scruple.ai`
- Public product: `scruple.ai`
- Public source + evidence: `github.com/Docenttx/Scruple`

We are available for a call or bilateral clarification at any time. Attached: structured scope annex, marking-implementation annex, coverage matrix, governance and roadmap, evidence appendix.

Sincerely,

**Shaun Hargadine**
Docent Technologies (DBA Scruple)
