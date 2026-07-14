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
- **Ship Sub-measure 1.1.2 for raster image outputs of Scruple Studio** —
  SHIPPED. Classical DCT spread-spectrum + Reed-Solomon ECC reference
  implementation open-sourced at `services/watermark/`. 128-bit payload
  with tier-scoped body (self-contained tiers 1-3; chain-locked tiers
  4-5). Applied at `/api/lock/local`; master-preservation invariant
  honoured (clean master + watermarked derivative both preserved).
  `scruple-verify watermark` subcommand extended for third-party
  decoding. Design at
  `docs/architecture/WATERMARK_DESIGN_v1.md` v1.2.

### Q4 2026 (Oct–Dec) — 1.1.2 extension + chain-lock wiring

- **Sub-measure 1.1.2 extension to video outputs** — per-frame image
  watermark with GOP-level payload rotation via async post-processor;
  covers SeedVR2 and AnimateDiff / VideoHelperSuite output paths.
- **Sub-measure 1.1.2 extension to audio outputs** — frequency-domain
  spread-spectrum via FFT; SynthID Audio evaluation for base-model-side
  embedding continues in parallel (ElevenLabs is the shipping
  precedent for base-model-side audio marking).
- **Chain-lock route wiring** — wire tier 4/5 watermark payloads into
  `/api/lock/chain-*` routes. Local-lock (tier 3) MVP shipped in Q3
  proves the pattern; tier 4/5 requires the SCR-ID timing flow.
- **PDF signing pass-through** — track c2pa-python releases; wire in as
  soon as the `pdf` feature is exposed.
- **application/x-pytorch signing pass-through** — same discipline.
- **`@scruple/watermark` npm package publish** — client-side JS/TS
  library for third-party integrators; separate repository, MIT-licensed.
- **StegaStamp deep-learning encoder evaluation** — Q3 shipped
  classical DCT is adequate for typical distribution transforms; a
  neural encoder is a potential Phase 1.1 upgrade for adversarial
  survival.

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
