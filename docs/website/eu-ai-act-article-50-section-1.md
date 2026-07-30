# Scruple's posture under the EU AI Act Article 50 Code of Practice on Transparency of AI-Generated Content, Section 1

**Reviewer landing page.** Source content for the EU AI Act Article 50 signatory-posture page on scruple.ai. Designed so every one of the AI Office's verification asks (per their letter to prospective signatories) is positively answered on this single page.
**Version:** 1.0
**Date:** 2026-07-30
**Owner:** Docent LLC (dba Docent Technologies), publisher of the Scruple product

---

## Provider identification

- **Legal entity:** **Docent LLC**, a Delaware limited liability company.
- **Doing business as:** Docent Technologies.
- **Product name:** **Scruple**.
- **Registered address:** Tampa, Florida, United States.
- **Point of contact for this Code of Practice:** `scruple@docentechs.com`.

Docent LLC (dba Docent Technologies) is a **Technology provider of a
marking and detection solution** under Section 1 of the EU AI Act
Article 50 Code of Practice on Transparency of AI-Generated Content.
The solution is the Scruple product, described below.

## What Scruple is (functionality)

Scruple is a **cryptographic provenance and content-authenticity
solution** for AI-generated and AI-integrated content. Its primary
integration model is as a **neutral notary and signer** that other
platforms — generative-AI providers, AI-integrated creative-tool
vendors, and content platforms — call from inside their production
pipelines. Scruple attaches cryptographic provenance to their outputs
at the moment of generation or export, using the mandatory marking
mechanisms named by the Code.

The full capability register for Scruple is described in
*The Scruple Standard, v1.5*, downloadable from this page.

## Section 1 mandatory measures — how Scruple implements each

The Code names two mandatory marking and detection measures under
Section 1. Scruple implements both.

### Measure 1 — in-band signed metadata attached to the content

Scruple is a **C2PA Generator Product**, meaning a tool of the type
the Coalition for Content Provenance and Authenticity's specification
defines as a producer of C2PA-conformant content credentials. When
this modality is selected for a Scruple event, the resulting content
carries an in-band C2PA manifest, signed by a Scruple-witnessed
attested key, and validates in any C2PA-compliant verifier (including
`verify.contentcredentials.org`, `c2patool`, and `c2pa-rs`-based
tools).

**Current status in the C2PA Generator Product Conformance Program:**

| Field | Value |
|---|---|
| Program | C2PA Generator Product Conformance Program |
| Applicant | Docent LLC (dba Docent Technologies) |
| Product | Scruple |
| Intake ID | `019f5856-bff8-7f57-a879-80594a6fb3fe` |
| Initial submission | 2026-07-14 |
| Reviewer's preliminary assessment on that submission | Level 1 requirements MEET; Level 2 requirements pending completion of remediation review |
| Remediation submission | 2026-07-18 |
| Status as of this page's date | Amendment in review with the Conformance Program |

The full status disclosure — with the language discipline this
program's terminology requires — is documented in
*The Scruple Standard, v1.5* §12.

**Independent verification.** The AI Office may confirm this status
independently by writing to `conformance@c2pa.org` with the Intake
ID above.

### Measure 2 — watermarking

Scruple implements an imperceptible pixel-space watermark for image
and video outputs. When the watermarking modality is selected for a
Scruple event, the output carries a mark that survives common
transformations (re-encoding, resizing, colour transforms) and
encodes a hash back into the Scruple audit chain. The mark is
recoverable by a Scruple-verifier tool from any downstream copy of
the content — the mark itself does not require intact metadata.

The watermarking capability is described in *The Scruple Standard,
v1.5* §9.2.

### On the two mandatory measures being *both* implemented

The Code permits satisfaction of Section 1 by implementing *either*
in-band signed metadata *or* watermarking. Scruple implements *both*
and lets the customer select one, the other, or both per event. When
both are selected on a single output, the output carries two
independent verification paths — a standard C2PA verifier reads the
manifest; a watermark verifier recovers the tamper-evidence hash
from pixels alone — and both paths point back to the same Scruple
audit chain.

### On the optional measures the Code lists

The Code lists fingerprinting, logging, rich provenance metadata,
and forensic detection as optional measures that a signatory may
also implement. Scruple provides several of these as first-class
capabilities within its evidence layer. These optional capabilities
are additive to Scruple's Section 1 posture; they do not substitute
for the mandatory measures above, and this page does not lead with
them.

## Intended users of the solution

Scruple's intended users are:

- **Providers of generative AI systems** who need to attach Article
  50-compliant marking and detection to the content their systems
  produce, without building the marking and detection primitives
  themselves. Scruple is the tool they integrate.
- **AI-integrated creative-tool vendors** whose products embed
  generative AI features and who need the same marking and detection
  attached to what their tools produce (see the Scruple integrations
  for 3D design, illustration, motion, and broadcast).
- **Model operators and content platforms** who need portable proof
  of what an AI system produced, when, and under which pipeline —
  for editorial, contractual, or regulatory reasons.

Downstream individuals whose content ultimately carries Scruple's
provenance are not Scruple's direct users; they are beneficiaries of
the marking that Scruple's direct users have chosen to attach.

## Provider role

Scruple's role in providing the mandatory measures under Section 1:

- **Signer** — Scruple's attested signing key produces the C2PA
  manifest signature and (where applicable) the watermark's
  cryptographic binding.
- **Claim generator** — Scruple is the C2PA "claim generator"
  identity on every issued content credential.
- **Manifest publisher and watermark embedder** — Scruple produces
  the in-band C2PA manifest and embeds the pixel-space watermark.
- **Neutral notary** — Scruple does not itself generate AI content.
  It witnesses and marks content that other platforms produce. This
  neutrality is intentional: the same Scruple substrate serves many
  integrators, and no integrator's identity ever signs another
  integrator's output.

## Documentation and independent verification

The following documents are downloadable directly from this page:

- **The Scruple Standard, v1.5** — the public capability register.
  Describes what a Scruple-witnessed record means, what it
  guarantees, and how the mandatory Section 1 measures are
  implemented at capability level. IP-safe (does not disclose
  implementation mechanisms of Scruple's core witnessing and
  baseline techniques).
- **Scruple and C2PA: How they relate, v1.0** — companion chart. A
  three-column composition table showing what C2PA alone provides,
  what Scruple's evidence layer adds, and what a composed
  Scruple-with-C2PA event delivers. Includes a hardware-witnessing
  sub-section covering Levels 1 and 2 (self-witnessing compute
  hardware, third-party hardware observer) with cloud and local
  lanes.

Independent verification paths available to the AI Office without
contacting Docent LLC:

1. **C2PA Conformance Program participation** — `conformance@c2pa.org`
   with Intake ID `019f5856-bff8-7f57-a879-80594a6fb3fe`. This
   confirms Scruple is an active, formally-submitted applicant in
   the Program and that the reviewer has issued the preliminary
   assessments described above.
2. **C2PA public conforming-products list** — available at the
   Coalition's public GitHub repository. Products appear on this
   list only after final certification is issued; Scruple's amendment
   is currently in review and Scruple will appear on the list once
   the review completes. The Intake ID above is the reference in the
   interim.

Docent LLC is available to answer any additional questions from the
AI Office at `scruple@docentechs.com`.
