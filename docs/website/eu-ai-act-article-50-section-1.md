# Scruple's posture under the EU AI Act Article 50 Code of Practice on Transparency of AI-Generated Content, Section 1

**Reviewer landing page.** Source content for the EU AI Act Article 50 signatory-posture page on scruple.ai. Designed so every one of the AI Office's verification asks (per their letter to prospective signatories) is positively answered on this single page.
**Version:** 1.1
**Date:** 2026-09-02
**Owner:** Docent LLC (dba Docent Technologies), publisher of the Scruple product

**Revision note (v1.1, 2026-09-02).** Section "Measure 2 — watermarking",
"On the two mandatory measures", and "Provider role" were corrected against
measurement of the shipping code. v1.0 described video watermarking, resize
survival, and a chain hash carried in the mark; none of the three is what the
implementation does. Every capability statement below is now either measured
or marked as not implemented. Corrections tracked in
`docs/canon/FILING_CORRECTIONS.md`.

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
at the moment of generation or export, using the in-band signed
metadata mechanism named by the Code.

The full capability register for Scruple is described in
*The Scruple Standard, v1.7*, downloadable from this page.

## Section 1 mandatory measures — Scruple's position on each

The Code names two mandatory marking and detection measures under
Section 1 and permits satisfaction by either. **Scruple's Section 1
position rests on the first — in-band signed metadata.** Its
watermarking work is described in full below and is deliberately
**not** offered as satisfaction of the second measure, because
measurement of the implementation does not support that claim.

Each subsection separates what has been measured from what is not
yet available to a customer.

### Measure 1 — in-band signed metadata attached to the content

Scruple is a **C2PA Generator Product**, meaning a tool of the type
the Coalition for Content Provenance and Authenticity's specification
defines as a producer of C2PA-conformant content credentials. The
signer produces an in-band C2PA manifest over the asset, signed by a
Scruple-witnessed attested key, and the resulting manifests validate
in `c2pa-rs`-based verifiers.

**Measured scope.** Content credentials have been produced and read
back at `validation_state=Valid` for still images (PNG), video (MP4),
audio (WAV, MP3, FLAC, M4A), and — via an external sidecar manifest —
a `.safetensors` model file. AAC is refused by the underlying library
and Scruple does not claim it. The reference evidence is the
`bundle-29e9a40e1d43` provenance bundle, which the AI Office may
request in full. Signatures in that bundle carry Docent's own root CA,
which is not in `c2pa-rs`'s built-in trust list; a verifier must supply
that root as a trust anchor, and validation then succeeds.

That bundle's Merkle root is anchored on the **Ravencoin testnet**. It
is a demonstration anchor, and this page does not present it as a
production one.

**What is not yet available to a customer.** The signing modality is
**not selectable in the shipping product today.** The Signer
confidential-computing VM is deliberately powered down pre-launch, and
the product's modality endpoint answers a `c2pa` request with an
explicit `signer_unavailable` outstanding-item rather than silently
substituting a weaker modality. Scruple therefore has the capability,
demonstrable on request, and does not yet expose it as a per-event
customer selection. Scruple will not describe this measure as
customer-selectable until it is.

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

The table above is the full status disclosure. (v1.0 of this page
cited *The Scruple Standard* §12 for it. The Standard removed its
Conformance Program section at v1.7 and renumbered Hardware Attestation
into §12, so the disclosure now lives here and nowhere else.)

**Independent verification.** The AI Office may confirm this status
independently by writing to `conformance@c2pa.org` with the Intake
ID above.

### Measure 2 — watermarking

**Scruple does not today implement a marking measure that meets
Section 1, and this page does not claim one.** The paragraphs below
state exactly what exists, what it survives, and what it carries,
because a marking claim the AI Office cannot reproduce is worse than
no marking claim.

**Media coverage — still images only.** Scruple implements an
imperceptible mark in the frequency domain of the luma channel, for
still images that a raster imaging library can decode: PNG, JPEG,
WebP and TIFF. **There is no video watermark embedder and no audio
watermark embedder.** No such code exists in the product in any form,
and the apply path skips every non-image output explicitly. v1.0 of
this page said "image and video outputs"; that was wrong.

**Robustness — measured, not asserted.** Measured 2026-09-02 on a
512×512 test image, embed then decode:

| Transformation | Payload recovered |
|---|---|
| No transformation | Yes |
| Re-encode to JPEG, quality 95 / 90 / 85 / 80 / 75 / 70 | Yes |
| Re-encode to JPEG, quality 65 and below | **No** |
| Re-encode to WebP, quality 90 | Yes |
| Colour transforms — greyscale, brightness, contrast, saturation | Yes |
| Resize 512→480, 512→511, 512→256, 512→1024 | **No** |
| Crop 8 pixels | **No** |
| Rotate 1 degree | **No** |
| Horizontal flip | **No** |

The decoder derives its block indices from the width of the image it
is handed, so any change to the image geometry re-indexes every bit
and the mark is lost. It is robust to re-encoding above roughly JPEG
q70 and to colour transforms; **it is not robust to resizing,
cropping, rotation, flipping, or aggressive re-compression.** v1.0 of
this page listed resizing among the transformations survived; the
opposite is true.

**Payload — what the mark actually carries.** 128 bits: an 8-bit magic
byte, a 4-bit version, a 4-bit tier discriminator, and a 112-bit
tier-specific body. In the tier the shipping product emits, that body
is a 64-bit wall-clock timestamp and 48 reserved bits. **The mark does
not carry a hash of the content, a leaf hash, or any pointer into the
Scruple audit chain.** v1.0 of this page said it "encodes a hash back
into the Scruple audit chain"; it does not. Two higher tiers that
would carry a Scruple ID resolvable to a public-ledger inscription are
implemented but are not invoked by any shipping code path.

**No cryptographic binding.** The mark is an error-corrected payload
embedded by a published, unkeyed scheme. No signing key, secret, or
message-authentication code is involved in producing or reading it.
Recovering the mark demonstrates that a Scruple-format payload is
present; it does not authenticate origin, and anyone implementing the
scheme can produce a payload that decodes. Origin authentication in
Scruple comes from the signed leaf and the C2PA manifest, not from the
mark.

**The marked copy is not in the audit chain.** Scruple's design keeps
the master bytes clean and marks a separate derivative copy. In the
shipping order of operations the derivative is produced *after* the
event is sealed, and the witness refuses further entries for a sealed
project, so the derivative has never been given a leaf. The column
reserved for it has been empty since it was added. A mark recovered
from a downstream copy therefore resolves to nothing.

**Consequence.** A recovered mark today tells a verifier "this passed
through Scruple at approximately this time." It does not identify the
content, the event, or the customer, and it applies to no video or
audio. Scruple does not offer this as a Section 1 marking measure and
does not ask the AI Office to accept it as one.

The watermarking capability class is described in *The Scruple
Standard, v1.7* §9.2. §9.2.2 (video) and §9.2.3 (audio) of that
document describe capabilities that are not implemented; a correction
to the Standard is tracked in `docs/canon/FILING_CORRECTIONS.md`.

### Which of the two mandatory measures Scruple relies on

The Code permits satisfaction of Section 1 by implementing *either*
in-band signed metadata *or* watermarking. **Scruple relies on the
in-band signed metadata measure.** The watermark is a secondary,
image-only aid described above, not a Section 1 measure, and this
page does not present the two as peers.

Where both are applied to one output, they do **not** today give two
paths back to a single audit chain. The C2PA manifest does point back
to the Scruple leaf. The marked copy is a separate derivative that
has never been entered into the chain, and the mark carries no
identifier to look up. v1.0 of this page said both paths point back to
the same chain; only one does.

Scruple's architecture is designed to close this — mark the
derivative, witness it while the event is still open, and sign the
released derivative with the master as a C2PA ingredient. That work
is not done, and this page will not describe it as though it were.

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
  manifest signature. It does **not** sign the watermark: the mark is
  unkeyed and carries no cryptographic binding (see Measure 2).
- **Claim generator** — Scruple is the C2PA "claim generator"
  identity on every issued content credential.
- **Manifest publisher and watermark embedder** — Scruple produces
  the in-band C2PA manifest, and embeds a still-image pixel-space
  mark. It does not embed a mark in video or audio.
- **Neutral notary** — Scruple does not itself generate AI content.
  It witnesses and marks content that other platforms produce. This
  neutrality is intentional: the same Scruple substrate serves many
  integrators, and no integrator's identity ever signs another
  integrator's output.

## Documentation and independent verification

The following documents are downloadable directly from this page:

- **The Scruple Standard, v1.7** — the public capability register.
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
