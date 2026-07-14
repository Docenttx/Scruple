# Interoperability roadmap — through 2 February 2027 Code deadline

The Code's Section 1 interoperability obligation activates on
**2 February 2027**. This document tracks the workstreams closing gaps
identified in `../03-marking-implementation/marking-technical-spec.md` and
`../04-coverage-per-modality/coverage-matrix.md`.

## Milestones

### Q3 2026 (Jul–Sep) — foundational

- **Publish canonical Scruple Standard v1.2** — SHIPPED. Public at
  `docs/architecture/SCRUPLE_STANDARD_v1.md`. Two-document harmonised set:
  Capability Register (public) + Integration Requirements (implementation
  spec).
- **Publish witness integration guide as normative reference** —
  SHIPPED (draft). At `docs/api/witness-integration.md`. Currently v1.2;
  Q4 2026 will bump to v2.0 with the marking-tech vendor obligations
  explicitly enumerated.
- **Expose Sub-measure 1.1.1 signing surface to downstream vendors via
  Witness API** — SHIPPED. Public HTTPS endpoint at `witness.scruple.ai`.

### Q4 2026 (Oct–Dec) — 1.1.2 evaluation

- **Sub-measure 1.1.2 evaluation for image outputs** — begin. Candidate:
  Google SynthID Image integration for outputs produced by Scruple Studio
  directly (where Scruple has control over the generator hook), gated on
  SynthID model-family availability for the base models we deploy (SD 1.5,
  SDXL, FLUX.1).
- **Sub-measure 1.1.2 evaluation for audio outputs** — begin. Candidate:
  Google SynthID Audio (ElevenLabs is the shipping precedent).
- **PDF signing pass-through** — track c2pa-python releases; wire in as
  soon as the `pdf` feature is exposed.
- **application/x-pytorch signing pass-through** — same discipline.

### Q1 2027 (Jan–Feb, deadline 2 February)

- **Public verification URL** — publish `scruple.ai/verify` per OpenAI
  `openai.com/verify` pattern. Accepts any Scruple-signed artefact (any
  C2PA-compatible artefact in principle by delegation to c2pa-python) and
  returns the interoperable verdict.
- **Interoperable trust-anchor publication** — publish our production
  trust manifest at `witness.scruple.ai/.well-known/witness-trust.json`
  in the same schema `scruple-verify` already consumes for
  third-party trust verification.
- **AI Office notification of interoperability status** — send
  interoperability-status letter to the AI Office prior to 2 February 2027
  enforcement, describing verified interoperability across the shipped
  1.1.1 + 1.1.3 layers and the current status of the 1.1.2 evaluation.

### Ongoing — throughout

- **C2PA v2.x compliance track** — as C2PA specification advances, update
  our Python + TypeScript signer wrappers in the same commit as the C2PA
  Conformance re-validation.
- **JPEG Trust (ISO/IEC 21617-1:2025) conformance track** — validate
  compatibility as JPEG Trust reader implementations mature.
- **AI Omnibus tracking** — the provisional 2 December 2026 grandfathering
  deadline for pre-existing systems affects the Scruple Studio surface
  (rows 1–6 of the scope inventory) that pre-dates the Code. Position:
  we do not intend to invoke the grandfathering allowance; Scruple Studio
  outputs since Q3 2026 already carry both layers.
