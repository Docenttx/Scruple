# EU AI Office Evidence Bundle — Plan (draft, pending research)

**Status:** Skeleton. The research agent will return with information about
how other Code signatories present evidence + what the AI Office actually
expects, and this plan will be refined accordingly.

**Companion:** The C2PA Conformance bundle at
`/data/scruple-web/docs/c2pa-conformance-evidence/2026-07-14/` is the
technical proof layer. The EU bundle is the *governance + qualification*
layer that references it.

## What this bundle needs to prove

Article 50(2) of the AI Act + Section 1 of the Code together require a
signatory to demonstrate:

1. **Provider status is honestly claimed.** We must identify the systems,
   services, and deployment contexts covered by our signature (this was
   the AI Office's specific ask on 2026-07-14).

2. **Every AI-generated output IS marked as such** — with a
   machine-readable mark that survives normal downstream processing.

3. **The mark is independently detectable** — a third party can verify
   it without runtime dependency on us.

4. **Internal governance is real** — who is responsible, how are
   incidents handled, when does the marking change.

## Planned structure

```
evidence-bundle-2026-07-14/
  00-BUNDLE-PLAN.md                       — this file
  01-cover-letter.md                       — reply letter (already drafted:
                                              ../2026-07-14-provider-qualification-response.md)
  02-provider-identification/
    org-legal-identity.md                 — Docent Technologies DBA, EEA rep if any
    signatory-authority.md                — Shaun Hargadine's authority to sign
    scope-inventory.md                    — full systems × services × contexts matrix
  03-marking-implementation/
    c2pa-technical-spec.md                — high-level explanation of our C2PA impl
    witness-chain-supplement.md           — the second-layer Scruple witness chain
    detection-tools.md                    — how a downstream party detects our marks
    → link to C2PA evidence bundle
  04-coverage-per-modality/
    coverage-matrix.md                    — which marks apply to which output types
    known-gaps.md                         — the c2pa-python wrapper limits, honest disclosure
  05-governance/
    responsibility-matrix.md              — who owns what re: compliance
    incident-response.md                  — what happens if a mark is broken
    change-management.md                  — how we communicate marking changes to
                                            downstream detectors
  06-appendices/
    references.md                         — links to public tools + specs
    contact.md                            — sub-team contacts
```

## Reuse from existing work

- `../../c2pa-conformance-evidence/2026-07-14/` — full technical bundle
- `../../architecture/SCRUPLE_STANDARD_v1.md` — public spec of what we sign
- `../../architecture/SCRUPLE_INTEGRATION_REQUIREMENTS_v1.md` — how integrators wire in
- `../../api/witness-integration.md` — customer integration guide
- The provider-qualification response letter — 90% of §02 content is there

## Things the research agent should surface

- Whether the AI Office publishes a template or checklist
- Whether other signatories have posted their submissions publicly (Anthropic,
  OpenAI, Google DeepMind, Adobe, Microsoft, Mistral, etc.)
- Any EU-preferred format (structured template? free-form letter? technical
  annex with schemas?)
- Whether the signature confers a safe harbor or is purely voluntary
- Enforcement timeline (when must we actually demonstrate compliance vs.
  just declare intent)

## Placeholder timeline

- Tonight: skeleton + best-guess content pinned to research recommendations
- Morning: refine per research findings, land in Drive + repo, hand over
  for user review before send

## Non-scope for this bundle

- Anything about copyright compliance (that's a separate Code)
- Anything about safety/security (also separate)
- Base-model provider claims (we don't provide any base model)
- Deep-fake specific mitigations (we don't operate a deep-fake product)
