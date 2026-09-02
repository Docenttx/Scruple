# Scruple for 3D design

**Category page.** Source content for the 3D design category page on scruple.ai.
**Version:** 1.1
**Date:** 2026-09-02
**Owner:** Docent LLC (dba Docent Technologies), publisher of the Scruple product

**Revision note (v1.1, 2026-09-02).** Modality descriptions corrected against
measurement of the shipping code. See `docs/canon/FILING_CORRECTIONS.md`.

---

## What Scruple provides for 3D design

3D design and CAD workflows produce artifacts that carry real
engineering, IP, and legal weight — a mechanical assembly, a
manufactured-part spec, a design revision that later becomes a
regulatory submission. Scruple attaches cryptographic provenance to
those artifacts as they leave the design environment, so a downstream
verifier can confirm what was designed, in which version of the
tooling, on which date, and by which author — without contacting the
design team.

Every export event the customer chooses to witness produces a Scruple
leaf: signed by an attested key, bound to the integration's baseline
(the specific design application version and add-in set that produced
the artifact), and chained to prior exports from the same integration.
Customers select the output modalities per export — a C2PA content
credential attached to 2D exports (PDF, JPEG, PNG), a pixel-space
watermark on rendered images, and/or a public-ledger anchor on the
export's leaf hash. Modalities are composable and independent; see
*The Scruple Standard v1.7* §9.

## Supported host applications

| Host | Notes |
|---|---|
| **Autodesk Fusion (360)** | Palette shipped; provenance capture on export events proven end-to-end |

Scope note: the Scruple Standard describes capability classes, not
specific hosts. A licensee shipping a Scruple integration for a
different CAD application (e.g., Inventor, Solidworks, FreeCAD,
OnShape, PTC Creo) still meets the Standard, provided the integration
implements the required attestations at the export/save boundary.

## Which Scruple modalities are available in the 3D design integrations

- **C2PA content credentials** — attached to 2D exports (PDF, JPG, PNG). Native 3D formats (STEP, IGES, DWG, F3D, etc.) are not currently in the C2PA specification's supported media types; Scruple's C2PA modality applies to the 2D renderings and export bundles. **Availability:** the signing modality is not yet selectable in the shipping product — the Signer CVM is powered down pre-launch and requests return an explicit unavailable response rather than a silent downgrade.
- **Watermarking** — an imperceptible frequency-domain mark on rendered still images (PNG, JPEG, WebP, TIFF). Measured 2026-09-02: survives re-encoding to roughly JPEG q70 and colour transforms; **lost by any resize, crop, rotation or flip**. It carries a timestamp, not a content hash or chain pointer, and it is unkeyed. Native CAD files have no pixel data and are not watermarkable.
- **Chain lock (public-ledger anchor)** — every export event's leaf hash may be inscribed on a distributed public ledger. **The shipping chain-lock modality mints on the Ravencoin testnet.** A testnet inscription is a demonstration anchor, not a censorship-resistant production one, and Scruple states which network an anchor is on rather than letting a testnet txid read as a mainnet one.
- **Local lock** — the default; every event produces a customer-side receipt.

For 3D design outputs where C2PA and pixel-watermarking do not apply
(native CAD file exports), the underlying Scruple evidence-based
provenance — baseline binding, audit chain, operator-independent
witness — still attaches to the event via the local lock and (if
selected) chain lock.

## Hardware witnessing levels

3D design integrations support Levels 1 and 2 of customer hardware
witnessing per *The Scruple Standard v1.7* §12.3 — self-witnessing
compute (Level 1, cloud or local) or third-party hardware observer
(Level 2, cloud or local). Design workstations are typically local;
customers building on a cloud CAD infrastructure retain the same
level ladder.

## Intended users

- CAD teams under regulatory-submission obligations (medical device design, aerospace, defense) needing tamper-evident export records
- Design firms whose delivered files become contractual artifacts and need portable proof of authorship and version
- OEMs building AI-assisted CAD features who need to mark AI-generated design elements per emerging content-authenticity obligations

## Availability

The Autodesk Fusion integration is available today by request.
Contact: `scruple@docentechs.com`.

## Related

- *The Scruple Standard v1.7* — capability register and threat models
- *Scruple and C2PA: How they relate* — companion chart
