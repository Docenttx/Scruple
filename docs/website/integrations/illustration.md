# Scruple for illustration and design

**Category page.** Source content for the illustration category page on scruple.ai.
**Version:** 1.0
**Date:** 2026-07-30
**Owner:** Docent LLC (dba Docent Technologies), publisher of the Scruple product

---

## What Scruple provides for illustration and design

Digital illustration is where the AI content-authenticity question is
most visible today. Publishers, agencies, and creators need portable
proof that an image was authored under a specific tool chain — with
which AI generators involved (if any), at which stage, under whose
identity — attached in a form standard verifiers can read.

Scruple attaches that proof at the **Save** and **Export** moments of
the customer's Adobe workflow. Every save event the customer chooses
to witness produces a Scruple leaf, signed by an attested key and
bound to the integration's baseline (specific Adobe application
version, installed extensions, any AI-assist tools active). The output
modalities are composable per event: a C2PA content credential
embedded in the exported asset, a pixel-space watermark, a public-
ledger anchor on the leaf hash, or any combination. See
*The Scruple Standard v1.5* §9 for the full modality inventory.

## Supported host applications

Scruple ships as a UXP plugin for the Adobe Creative Suite, currently
built for:

| Host | Status | Notes |
|---|---|---|
| **Adobe Photoshop** | Installable today (via request) | Plugin skeleton + save-hook provenance capture + palette UI shipped; Adobe Marketplace public listing pending Adobe developer-account approval |
| **Adobe Illustrator** | Installable today (via request) | Same UXP monorepo as Photoshop |
| **Adobe InDesign** | Installable today (via request) | Same UXP monorepo as Photoshop |

**Distribution note.** All three plugins are built and installable
today by direct install; the Adobe Marketplace public listing is
pending completion of the Adobe developer partner account process.
Customers with immediate need can install directly from the shipped
`.ccx` package by contacting `scruple@docentechs.com`.

## Which Scruple modalities are available in the Adobe integrations

- **C2PA content credentials** — embedded in-band in the exported asset
  (JPEG, PNG, TIFF, PDF, and other C2PA-supported types). Every Save
  As / Export can carry a Scruple-signed C2PA manifest with the claim
  generator identity, digitalSourceType where the source was
  AI-generated, and (when the customer's compute chain is attested) a
  bound hardware-attestation assertion.
- **Watermarking** — imperceptible pixel-space marks on the exported
  image, encoding a hash back into the Scruple audit chain. Survives
  common transformations (re-encoding, resizing, colour transforms).
- **Chain lock (public-ledger anchor)** — the event's leaf hash may
  be inscribed on a distributed public ledger for censorship-resistant
  discoverability by anyone holding the receipt.
- **Local lock** — the default; every event produces a customer-side
  receipt.

Selecting C2PA + watermarking on the same export gives the resulting
image two independent verification paths — a standard C2PA verifier
(e.g., `verify.contentcredentials.org`) reads the manifest; a
watermark verifier recovers the tamper-evidence hash from pixels
alone. Both point back to the same Scruple audit chain.

## Regulatory positioning

The Adobe integrations implement both mandatory measures the EU AI
Act Article 50 Code of Practice on Transparency of AI-Generated
Content names under Section 1: **in-band signed metadata** (via the
C2PA content credential modality — §9.1 of the Standard) and
**watermarking** (via the pixel-space watermarking modality — §9.2 of
the Standard). Customers producing AI-integrated illustration work
under Article 50 obligations may select either or both per export.

## Intended users

- Publishers, editorial teams, and news organisations needing verifiable
  authorship attribution on delivered images
- Agencies and studios producing brand assets with mixed
  human-and-AI-assisted workflows
- Independent illustrators establishing tamper-evident authorship for
  IP and copyright purposes
- Enterprise creative teams whose delivered assets carry contractual
  provenance obligations

## Availability

Direct install available today by request. Adobe Marketplace public
listing pending. Contact: `scruple@docentechs.com`.

## Related

- *The Scruple Standard v1.5* — capability register and threat models
- *Scruple and C2PA: How they relate* — companion chart
