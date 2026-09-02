# Scruple for illustration and design

**Category page.** Source content for the illustration category page on scruple.ai.
**Version:** 1.1
**Date:** 2026-09-02
**Owner:** Docent LLC (dba Docent Technologies), publisher of the Scruple product

**Revision note (v1.1, 2026-09-02).** Modality descriptions corrected against
measurement of the shipping code. See `docs/canon/FILING_CORRECTIONS.md`.

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
*The Scruple Standard v1.7* §9 for the full modality inventory.

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
  (JPEG, PNG, TIFF, PDF, and other C2PA-supported types). A Save As /
  Export can carry a Scruple-signed C2PA manifest with the claim
  generator identity, digitalSourceType where the source was
  AI-generated, and (when the customer's compute chain is attested) a
  bound hardware-attestation assertion. **Availability:** the signing
  modality is not yet selectable in the shipping product — the Signer
  CVM is powered down pre-launch and requests return an explicit
  unavailable response rather than a silent downgrade.
- **Watermarking** — an imperceptible frequency-domain mark on the
  exported still image. Measured 2026-09-02: it survives re-encoding
  down to roughly JPEG q70, and greyscale, brightness, contrast and
  saturation changes; it is **lost by any resize, by an 8-pixel crop,
  by a 1-degree rotation, and by a horizontal flip**, and by JPEG
  compression at q65 or below. The payload carries a magic byte, a
  version, a tier and a timestamp — **not** a content hash and **not**
  a pointer into the Scruple audit chain — and it is unkeyed, so
  recovering it does not authenticate origin.
- **Chain lock (public-ledger anchor)** — the event's leaf hash may
  be inscribed on a distributed public ledger, discoverable by anyone
  holding the receipt. **The shipping chain-lock modality mints on the Ravencoin testnet.** A testnet inscription is a demonstration anchor, not a censorship-resistant production one, and Scruple states which network an anchor is on rather than letting a testnet txid read as a mainnet one.
- **Local lock** — the default; every event produces a customer-side
  receipt.

Applying C2PA and the watermark to the same export does **not** today
give two paths back to one audit chain. The C2PA manifest does point
back to the Scruple leaf. The watermarked copy is a separate
derivative that is produced after the event is sealed and has never
been entered into the chain, and the mark carries no identifier to
look up. Closing that is designed and not built; this page will not
describe it as though it were.

## Regulatory positioning

The EU AI Act Article 50 Code of Practice on Transparency of
AI-Generated Content names two mandatory measures under Section 1 and
permits satisfaction by either. The Adobe integrations address the
first — **in-band signed metadata**, via the C2PA content credential
modality (§9.1 of the Standard). Scruple does **not** offer its
watermark as satisfaction of the second measure; see the Article 50
signatory-posture page for the measured robustness and payload.
Customers under Article 50 obligations should plan on the C2PA
path.

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

- *The Scruple Standard v1.7* — capability register and threat models
- *Scruple and C2PA: How they relate* — companion chart
