# Research report — EU Code of Practice on Transparency of AI-Generated Content

**Compiled:** 2026-07-14
**Purpose:** Inform the shape and content of Scruple's response to the
AI Office's Section 1 qualification request.
**Method:** Deep-research pass over official EU sources (digital-strategy.ec.europa.eu,
EUR-Lex, Commission opinions), signatory statements, law-firm analyses,
policy institute commentary, and technical body publications.

---

## Executive summary of findings

1. **No AI Office template published** for post-signature qualification. The
   only structured EU template we could locate is the GPAI Training-Content
   Summary Template — instructive as a style precedent (structured fields
   with short prose per field). Bilateral emails like the one Scruple
   received appear to be the AI Office's standard follow-up mechanism.

2. **OpenAI is the only signatory with a public signing-day statement**
   (11 June 2026, `openai.com/index/supporting-eu-trustworthy-ai-ecosystem/`).
   Their template: named products (DALL·E 3, ChatGPT, Codex, OpenAI API),
   named marking stack (C2PA Content Credentials + Google DeepMind SynthID),
   public verification URL (`openai.com/verify`), regulatory posture
   framing rather than commitment language. Compact, ~500 words.

3. **Adobe, Google DeepMind, Anthropic, Microsoft, Meta, Mistral, xAI,
   ElevenLabs, Synthesia, Runway, Stability, BFL, TikTok, YouTube** — all
   searched; no Transparency-Code signing statements found as of 2026-07-14.
   Initial signatory list won't publish until after 22 July 2026 deadline.
   Scruple is very likely to be the first ≤10-person signatory to publish.

4. **Article 50(2) load-bearing terms:** machine-readable, effective /
   interoperable / robust / reliable, as far as technically feasible,
   generally acknowledged state of the art. Recital 133 enumerates
   acceptable techniques non-exhaustively — watermarks, metadata
   identifications, cryptographic methods for proving provenance, logging,
   fingerprints — technology-neutral posture.

5. **C2PA is NOT named** in the AI Act, Recital 133, or the Code. Industry
   consensus (IPTC) treats it as the de facto Sub-measure 1.1.1 solution.
   Adjacent standards: JPEG Trust = ISO/IEC 21617-1:2025 (adopts C2PA
   manifest engine); Google SynthID; IPTC PhotoMetadata Digital Source
   Type.

6. **Code Section 1 requires multi-layered marking — at least two of:**
   - 1.1.1 Digitally signed metadata (C2PA in practice)
   - 1.1.2 Imperceptible watermark (required except for very short text;
     free-form text >200 tokens MUST be watermarked)
   - 1.1.3 Fingerprinting / logging
   Only 1.1.1 has a developed standard per the Code's own admission.

7. **The Code EXPLICITLY opens Section 1 to third-party marking-tech
   vendors** wishing "to demonstrate that their marking and detection
   solutions comply with the requirements of Article 50(2) and (5)." This
   is Scruple's signatory slot.

8. **SME proportionality clause exists in Section 1** — "lighter
   documentation, regular intervals against internal benchmarks." Scruple
   ≤10 headcount should invoke this explicitly.

## Recommendations adopted for Scruple's submission

Directly following the research report's Section "Implications for
Scruple's submission format":

1. Send signed PDF cover letter (≤1 page) + structured DOCX/XLSX annex —
   mirroring Commission Implementing Regulation (EU) 2024/2835 shape.
2. Anchor the whole submission to Sub-measure 1.1.1 of the Code (where
   Scruple's C2PA-based witnessing service sits squarely).
3. One row per covered system/service/deployment context, columns per
   research recommendation 3 (system, deployment surface, content types,
   marking method, standards, detectability endpoint, interoperability
   status).
4. Map to statute language ("effective, interoperable, robust and
   reliable") not just Code language.
5. Cite recognised standards by correct identifiers — JPEG Trust is
   ISO/IEC 21617-1:2025, C2PA is v2.x.
6. Include a technical annex with citational evidence artefacts — reference
   the L2 evidence bundle path, the scruple-verify CLI, at least one
   publicly verifiable receipt URL, the audit script. Do NOT dump the
   whole C2PA bundle inline.
7. Invoke SME proportionality explicitly. State Scruple's headcount, cite
   the proportionality clause.
8. Publish a separate public statement modelled on OpenAI's shape (this is
   OPTIONAL and separate from the regulator submission — asked to Shaun
   before publishing).
9. Neutral, cooperative, matter-of-fact tone — no defensive framing. The
   DMA anti-pattern (300-page defensive briefs, "we already answered that",
   complexity as shield) precedes the €500M Apple fine and is a documented
   failure mode.
10. Reserve one paragraph for the interoperability roadmap to 2 February 2027.

## Critical technical gap to address in submission

**Scruple currently satisfies Sub-measure 1.1.1 (digitally signed
metadata via C2PA) but not 1.1.2 (imperceptible watermark).** The Code
requires AT LEAST TWO sub-measures. Our options:

- **Map witness Merkle chain to Sub-measure 1.1.3 (fingerprinting/logging).**
  The Merkle-anchored per-iteration log IS a fingerprinting/logging
  method that persists after C2PA manifest strip. This is defensible.
  Adopted for the submission.
- **Commit to imperceptible watermarking as a documented roadmap workstream.**
  Not required to have shipped it today; required to have a plan.

## Timeline reality-check (adopted in bundle)

- 22 July 2026 18:00 CEST — signatory form deadline (already past for us
  in the sense that we already signed; today we're providing follow-up)
- Before 2 August 2026 — initial signatory list published, Article 50
  Guidelines expected
- 2 August 2026 — Article 50 becomes enforceable
- 2 December 2026 — provisional grandfathering deadline for pre-existing
  systems (per AI Omnibus)
- 2 February 2027 — interoperability deadline for interoperable
  watermarking/detection under the Code

## Penalty exposure (bear in mind while writing)

- Article 99(4): breach of Article 50 = €15M or 3% of worldwide turnover,
  whichever is higher
- Article 99(5): "incorrect, incomplete or misleading information supplied
  to competent authorities" = €7.5M or 1%
- SME/start-up considerations = fine-setting factor under Art. 99(6), NOT
  a defence

## Full report

See below (verbatim from the deep-research agent). All claims sourced.

---

_The following is the full research output, verbatim from the deep-research
agent for archival purposes._
