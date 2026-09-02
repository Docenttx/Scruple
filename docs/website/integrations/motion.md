# Scruple for motion, animation, and VFX

**Category page.** Source content for the motion category page on scruple.ai.
**Version:** 1.1
**Date:** 2026-09-02
**Owner:** Docent LLC (dba Docent Technologies), publisher of the Scruple product

**Revision note (v1.1, 2026-09-02).** Modality descriptions corrected against
measurement of the shipping code. See `docs/canon/FILING_CORRECTIONS.md`.

---

## What Scruple provides for motion, animation, and VFX

Motion production is unusually vulnerable to the "did the AI actually
produce this?" question — the finished frame carries no self-evidence
of the pipeline that produced it, and a re-encode strips whatever
metadata was attached at render time. Scruple attaches durable
provenance at the render and export moments of the animation and VFX
pipeline, so a downstream verifier holding the receipt or the signed
file can confirm the render's origin. Provenance travels in the C2PA
manifest and the Scruple leaf; it does not survive a re-encode that
strips the manifest, and Scruple does not claim a pixel mark that
does.

Every render and export the customer chooses to witness produces a
Scruple leaf, signed by an attested key and bound to the integration's
baseline (the specific animation/VFX application version, custom
scripts, and any AI-assist tools active in the pipeline). Output
modalities are composable per event: C2PA content credentials on the
rendered stills or video, pixel-space watermarking on frames, or a
public-ledger anchor on the event's leaf hash. See
*The Scruple Standard v1.7* §9.

## Supported host applications

| Host | Category | Status | Notes |
|---|---|---|---|
| **Blender** | 3D animation, modelling, compositing, video editing | Installable today (via request) | Add-on `.zip` shipped, mock-`bpy` pytest suite green (81 tests); Blender-Extensions marketplace listing pending |
| **Toon Boom Harmony** | 2D animation | Installable today (via request) | `.zip` shipped, Node test suite green (128 tests); Toon Boom marketplace listing pending |
| **Meshroom** | Photogrammetry — turns photos into 3D models often used as VFX assets | Installable today (via request) | `.zip` shipped, pytest suite green (98 tests) |

Scope note: the Scruple Standard describes capability classes, not
specific hosts. A licensee shipping a Scruple integration for a
different motion or VFX application (e.g., Maya, Houdini, Cinema 4D,
Nuke, DaVinci Resolve, Cavalry) still meets the Standard, provided
the integration implements the required attestations at the render
or export boundary.

## Which Scruple modalities are available in the motion integrations

- **C2PA content credentials** — attached to rendered stills, exported
  video, and other C2PA-supported output formats. For video output,
  the C2PA manifest is embedded in the file container per the
  specification's video handling. The measured evidence in the
  reference provenance bundle is **MP4**, signed and read back at
  `validation_state=Valid`; QuickTime/MOV is asserted in the signer's
  format registry but is not covered by that bundle. Where the
  customer's compute chain is
  attested, the manifest carries a bound hardware-attestation
  assertion. **Availability:** the signing modality is not yet
  selectable in the shipping product — the Signer CVM is powered down
  pre-launch and requests return an explicit unavailable response
  rather than a silent downgrade.
- **Watermarking — still images only. Not available for video.**
  Scruple's mark is a frequency-domain mark on still-image frames
  (PNG, JPEG, WebP, TIFF). **There is no video watermark embedder.**
  Measured 2026-09-02, the still-image mark survives re-encoding to
  roughly JPEG q70 and colour transforms, and is **lost by any resize,
  crop, rotation, or flip** — the decoder indexes blocks off the
  received image's dimensions. It carries a timestamp, not a content
  hash or a chain pointer, and it is unkeyed, so recovering it does
  not authenticate origin. Treat it as an aid, not as evidence.
- **Chain lock (public-ledger anchor)** — the render event's leaf
  hash may be inscribed on a distributed public ledger. **The shipping chain-lock modality mints on the Ravencoin testnet.** A testnet inscription is a demonstration anchor, not a censorship-resistant production one, and Scruple states which network an anchor is on rather than letting a testnet txid read as a mainnet one.
- **Local lock** — the default; every render/export event produces a
  customer-side receipt.

For long-form video, the leaf may reference the render's frame-hash
manifest so per-frame provenance can be reconstructed from the
receipt, but the C2PA manifest itself remains at the file level per
specification.

## Regulatory positioning

The EU AI Act Article 50 Code of Practice on Transparency of
AI-Generated Content names two mandatory measures under Section 1 and
permits satisfaction by either. The motion integrations address the
first — **in-band signed metadata**, via the C2PA content credential
modality (§9.1 of the Standard). They do **not** satisfy the second:
there is no video watermark, and the still-image mark does not meet
the robustness a marking measure implies. See the Article 50
signatory-posture page for the measured detail. Studios under Article
50 obligations should plan on the C2PA path.

## Intended users

- Studios producing episodic, feature, and short-form motion content
  with AI-assisted pipelines (concept, layout, lookdev, effects,
  in-betweening, upres)
- Independent animators and VFX artists needing portable proof of
  render origin for delivery and IP purposes
- Broadcasters and streaming platforms requiring content-authenticity
  metadata on ingested video for editorial and regulatory reasons
- Photogrammetry-based VFX pipelines that need to prove the input
  photograph set that produced a 3D asset

## Availability

Direct install available today by request for Blender, Toon Boom
Harmony, and Meshroom. Public marketplace listings pending. Contact:
`scruple@docentechs.com`.

## Related

- *The Scruple Standard v1.7* — capability register and threat models
- *Scruple and C2PA: How they relate* — companion chart
