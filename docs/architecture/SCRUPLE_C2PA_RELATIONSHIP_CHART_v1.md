# Scruple and C2PA: How they relate

**Status:** Public-facing chart. Companion to *The Scruple Standard, v1.7* §9.
**Version:** 1.2
**Date:** 2026-07-30
**Owner:** Docent LLC (dba Docent Technologies), publisher of the Scruple product
**Supersedes:** the prior *SCRUPLE vs C2PA* comparison chart. That framing
was misleading. The two are not alternatives.

---

## The relationship in one paragraph

**Scruple provides both EU AI Act Article 50 Section 1 mandatory
marking measures as peer output modalities.** In-band signed metadata
via a standard C2PA content credential (Scruple is a C2PA Generator
Product) and EU-compliant watermarking via an imperceptible mark with
a timestamp payload — a customer can select one, the other, or both
per event. **Scruple also provides additional evidence-based
provenance** — a baseline-bound, chain-anchored audit log with an
attested-signer, operator-independent witness — that lives below both
mandatory measures and works whether or not either is attached.
**Chain lock adds a distinct Scruple SCR_ID watermark** whose payload
encodes the Scruple ID rather than a timestamp, providing out-in-the-
wild lookup back to the chain-lock inscription that anchors the
event's provenance. The customer composes across these modalities per
event.

The chart below shows what each variant provides. The columns are
options a Scruple customer composes; they are not competing products.

## The chart

| Capability | C2PA alone (an off-the-shelf C2PA generator) | Scruple's evidence layer, without C2PA attached | Scruple with C2PA attached (composed) |
|---|---|---|---|
| In-band signed metadata (C2PA manifest attached to content) | ✓ | — | ✓ (Scruple is the C2PA signer) |
| EU-compliant watermarking — imperceptible mark, timestamp payload, peer of C2PA under Article 50 Section 1 | — | Optional (customer selects) — image, video, audio | Optional (customer selects) — image, video, audio |
| Scruple SCR_ID watermarking — imperceptible mark, SCR_ID payload for out-in-the-wild chain-lock lookup | — | Attached automatically when the chain-lock modality is selected | Attached automatically when the chain-lock modality is selected |
| Human-verifiable identity of claim generator | ✓ (per C2PA claim generator info) | ✓ (per Scruple leaf) | ✓ (both surfaces) |
| Trust-list verification of signing certificate | ✓ (via C2PA trust list) | ✓ (via Scruple attestation chain) | ✓ (both trust roots) |
| Baseline binding — the receipt attests the environment that produced the content | — | ✓ | ✓ |
| Chained audit log — tamper-evident event ordering across the customer's history | — | ✓ | ✓ |
| Operator-independent witness — signing key protected in an attested Confidential VM whose vendor is not the customer or Scruple | — | ✓ | ✓ (the C2PA manifest is signed by that same key) |
| Signer-fleet lifecycle enforced by architecture — no signer runs past its max-age window | — | ✓ | ✓ |
| Public-ledger anchor — leaf-hash discoverability without cooperation from vendor or Scruple | — | Optional (customer selects chain-lock modality) | Optional (customer selects) |
| Content-addressed decentralized-storage pinning + permanent-public-archive publication of the anchor | — | Optional | Optional |
| Hardware attestation of customer compute, bound into the receipt | — | ✓ (when the customer's compute chain is attested) | ✓ (surfaces on the C2PA manifest too, as an assertion) |
| Cross-integration provenance chain — every change to the integration itself is a witnessed event, linked by hash to prior baselines | — | ✓ | ✓ |
| Verification without cooperation from the content vendor | ✓ | ✓ | ✓ |
| Verification without cooperation from Scruple | ✓ (via standard C2PA tools) | ✓ (via the receipt + public anchors) | ✓ (either path independently) |
| EU AI Act Article 50 Code of Practice — "in-band signed metadata" mandatory measure (§9.1) | ✓ | — (not this measure; use the EU-compliant watermarking peer below) | ✓ |
| EU AI Act Article 50 Code of Practice — "watermarking" mandatory measure (§9.2) | — | ✓ (when the EU-compliant watermarking modality is selected) | ✓ (when the EU-compliant watermarking modality is also selected — the two Article 50 measures composed) |

## How to read the chart

**Row-by-row:** each capability is either present (`✓`), absent (`—`),
or a customer selection. A `—` in a column means that column does not
provide that capability on its own; it does **not** mean the capability
is unavailable to the customer — a Scruple customer composes across
columns.

**Column-by-column:**

- **"C2PA alone"** is what a generic C2PA generator gives you.
  Reasonable, well-standardised, verifier-portable. It stops at the
  content credential.

- **"Scruple's evidence layer, without C2PA attached"** is what a
  Scruple customer receives when they choose modalities other than
  C2PA — chain-lock, watermark, local receipt. The evidence layer is
  Scruple's core: the attested-signer witnessing, the baseline
  binding, the chained audit log, the operator-independent posture.
  This layer does not carry a C2PA sidecar, but does carry everything
  a downstream verifier needs to reconstruct the event.

- **"Scruple with C2PA attached"** is the composed configuration. A
  standard C2PA content credential, signed by the same attested key
  that Scruple's evidence layer uses, with Scruple's baseline binding
  and audit-chain leaf still underneath it. Both verification paths
  (C2PA-tool path and Scruple-receipt path) yield the same identity
  and the same event.

## Hardware witnessing level (orthogonal to output modality)

Independent of the output-modality composition above, every Scruple
event carries a **customer hardware witnessing level**. This is a
second axis: it modifies what the receipt attests about the compute
that produced the content, and is selected by the customer per event.
It is orthogonal to the C2PA / watermark / chain-lock composition —
any modality composition above can be paired with any level below.

| Position (weakest → strongest) | Level | Lane | What witnesses | Content-to-compute binding |
|---|---|---|---|---|
| 1 | **Level 1** — self-witnessing compute | **Cloud** | The compute vouches for itself via cloud TEE/CVM/confidential-compute | Software (integration-asserted) |
| 2 | **Level 1** — self-witnessing compute | **Local** | The compute vouches for itself via on-premise TEE/GPU | Software (integration-asserted) |
| 3 | **Level 2** — third-party hardware observer | **Cloud** | Independent hardware observes the cloud compute directly | Physical (observer sees the actual bytes) |
| 4 | **Level 2** — third-party hardware observer | **Local** | Independent hardware observes the on-premise compute directly | Physical (observer sees the actual bytes) |

**Threat comparison in one sentence:** compromised GPU versus
compromised network. Level 1 is defeated by a compromised GPU (the
GPU vouches for itself, so if its vendor or firmware is subverted the
attestation cannot detect it). Level 2's counterpart threat is a
compromised third-party observer — defeating it requires subverting a
second, independent hardware supply chain.

Level 2 strictly dominates Level 1 for the evidentiary property
Scruple measures. The cloud-vulnerability axis (a runtime-
confidentiality concern) is orthogonal to evidentiary strength;
customers with sovereignty, air-gap, or provider-independence
requirements will prefer a local lane at either level, but the
provenance guarantee is defined by the level, not the lane.

Details, threat models, and edge cases: *The Scruple Standard, v1.7*
§12.3.

## What "Scruple provides C2PA" means, precisely

Scruple is a **C2PA Generator Product** — that is, a tool of the type
the C2PA specification defines as a producer of C2PA-conformant
content credentials. When the C2PA output modality is selected for a
Scruple event, the resulting content carries an in-band C2PA manifest
signed by the Scruple witness, and validates in any C2PA-compliant
verifier (`verify.contentcredentials.org`, `c2patool`, `c2pa-rs`,
etc.).

## What "additional evidence-based provenance" means

Scruple's evidence layer sits below the modalities and is present on
every Scruple event regardless of which modalities are attached. It
delivers:

- **Baseline binding.** The event references the specific integration
  version (code, config, deployment, attested substrate) that
  produced it. A verifier can confirm the record was produced by the
  exact baselined integration Scruple attested — not a modified
  version.
- **Chained audit log.** Every event is a leaf in a hash-chained log.
  A single missing or reordered leaf breaks the chain.
- **Attested-signer witness.** The signing key lives inside a
  Confidential Virtual Machine whose attestation chains to a hardware
  root Scruple does not control. The Scruple operator cannot extract
  the key or forge historical records.
- **Signer-fleet lifecycle.** No signer runs past the max-age window;
  the running signer's identity and age are bound into every signed
  event.
- **Optional attestation of customer compute.** When the customer
  presents a hardware attestation from their own compute environment,
  the receipt binds that attestation to the event via nonce.

## What C2PA can be "part of" here

A Scruple event's evidentiary framework is a set of attestations
about (a) the environment that produced the content, (b) the moment
it was produced, and (c) the content itself. The C2PA content
credential is a well-standardised, verifier-portable **wrapper for
(c)** — a signed statement about the content, in a format the whole
C2PA ecosystem understands. When the customer selects C2PA as the
output modality, the C2PA manifest becomes one of the attestations
inside the Scruple event's framework, and the same attested key that
underwrites (a) and (b) also signs the C2PA manifest.

That is what "C2PA can be included as part of that evidentiary
provenance" means: not a fork in the road, not a choice of which one
to use, but a composition where the C2PA sidecar is one of the
attestations Scruple can attach.

## Change log

- **2026-07-30, v1.2** — synced with Standard v1.7. Removed a
  paragraph describing external-program status (Intake ID,
  submission dates, review state, language discipline); that
  content class no longer belongs in either the Standard or this
  chart. Bumped Standard cross-references from v1.6 to v1.7 and
  changed the §15.3 cross-reference to §12.3 to match the
  Standard's renumbering. Removed a stale cross-reference to the
  Standard's §12 (that section is no longer present in v1.7).
  Also split the watermarking row of the main table into two
  peer rows: EU-compliant watermarking (peer to C2PA under
  Article 50 mandatory measures) and Scruple SCR_ID watermarking
  (attached automatically when the chain-lock modality is
  selected). Opening one-paragraph relationship and EU-measure
  rows updated accordingly.
- **2026-07-30, v1.0** — initial draft. Supersedes the prior
  "SCRUPLE vs C2PA" comparison chart authored in the Base44 site
  content for `scruple.ai/standard`. Reframes the relationship from
  *versus* to *composition*: Scruple provides C2PA, also provides
  additional evidence-based provenance, and C2PA can be included as
  one modality within Scruple's evidentiary framework. Also adds a
  second-axis sub-section on **customer hardware witnessing level**
  (Level 1 self-witnessing / Level 2 third-party observer, each with
  cloud/local lanes, ordered by evidentiary strength). Companion
  chart to *The Scruple Standard* §9 (Output modality options),
  §11 (Four axes), and §12.3 (The blind spot only a third-party
  hardware observer closes).
