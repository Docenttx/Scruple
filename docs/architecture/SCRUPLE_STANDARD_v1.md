# The Scruple Standard, v1.5

**Status:** Capability register. Public-facing.
**Version:** 1.5
**Date:** 2026-07-30
**Owner:** Docent LLC (dba Docent Technologies), publisher of the Scruple product

**Scope note.** This Standard describes capability classes, not specific
implementations. Where a capability is realized by a class of technology
(e.g., a distributed public ledger, a hardware-attested confidential
execution environment), the Standard names the class; Docent's own
Scruple product uses specific vendors within each class, but a licensee
implementing the Standard with different vendors within the same class
still meets the Standard.
**Audience:** Anyone who needs to understand what a Scruple-witnessed record
means and what it guarantees — customers evaluating adoption, auditors and
regulators reading receipts, integration teams' leadership.
**Companion:** [`SCRUPLE_INTEGRATION_REQUIREMENTS_v1.md`](./SCRUPLE_INTEGRATION_REQUIREMENTS_v1.md)
— the technical implementation specification for integrators.
**Related:** [`CANONICAL_SCRUPLE_WITNESSING_L2.md`](./CANONICAL_SCRUPLE_WITNESSING_L2.md)
(internal architecture), [`Independent_AI_Witnessing_Rider_TEMPLATE.md`](./Independent_AI_Witnessing_Rider_TEMPLATE.md)
(customer legal instrument).

---

## 1. What this document is

The Scruple Standard defines the capabilities and guarantees of a
Scruple-witnessed record. It is a *capability register*, not an
implementation specification. It answers: what does it mean, and what does
it guarantee, when a record carries a Scruple witness?

Integrators seeking the technical requirements for producing such records
should consult the companion document, *Scruple Integration Requirements*.

## 2. What Scruple witnesses

Scruple's witness — a signer operating inside an attested Confidential
Virtual Machine — witnesses two things through the same signing key:

1. **AI-workflow events.** The training runs, inference runs, dataset
   assemblies, and derivative-work actions that produce artifacts whose
   provenance the customer wishes to establish.
2. **The integration itself.** At install and on every material change,
   the integration's own tamper-surface — the code, configuration, and
   attested compute environment that produces the workflow events — is
   measured, hashed, and signed as a baseline.

Both are ordinary leaves in the same audit log, signed by the same
attested key, chained by the same discipline.

## 3. Baseline attestation

At integration install, the Scruple witness measures the integration's
tamper-surface and signs a baseline hash covering it. That baseline is
the tenant's genesis leaf.

Every subsequent workflow leaf references the baseline. The receipts
Scruple emits therefore attest not only to the workflow event, but to
the state of the integration that produced it.

The capability this delivers: **a Scruple-witnessed record commits both
to what happened and to the environment that produced it.** A verifier
holding a receipt can, without cooperation from the vendor or from
Scruple, confirm that the record was produced by the specific baselined
integration Scruple attested — not a modified version of it.

## 4. Changing an integration is itself a witnessed event

If the customer modifies anything in the tamper-surface — a new SDK
version, a new deployment, a changed configuration, a substituted
capture point — the running baseline no longer matches the witnessed
baseline. Two things follow:

1. **New leaves either fail to verify against the declared baseline,**
   producing an immediate signal to any verifier, or
2. **The customer must re-baseline.** Re-baselining is itself a
   Scruple-signed leaf ("integration baseline transitioned from X to Y
   at time T"). It is a first-class public event in the audit chain,
   linked to prior baselines by hash.

Silent modification of the integration is cryptographically impossible.
Every material change is either verified (matches the baseline) or
surfaces as a witnessed event on the record.

**Public ledger anchoring of the baseline is a core transparency
option.** When enabled, the genesis baseline and every re-baseline event
are inscribed on the public ledger (via the same anchor mechanism used
for workflow-event locking). This turns the vendor's integration
lifecycle into a transparency artifact — anyone with the vendor's
identifier can independently audit when the vendor began using Scruple,
what their initial baseline was, and every change since, without asking
the vendor or asking Scruple. It is a first-class product option; some
vendors will elect it for the trust position it creates.

## 5. Compliance is binary

An integration is either Scruple-witnessed or it is not. This is
determined cryptographically by baseline verification, not by
self-declaration or by third-party audit at a point in time.

- **Scruple-witnessed:** the baseline is bound; all leaves chain to it;
  any tamper-surface change is a witnessed event.
- **Not Scruple-witnessed:** the baseline cannot be computed, has been
  broken, or the integration is running unbaselined code.

There is no tier structure. There is no *Standard / Attested / Certified*
grading. Any earlier language describing tiered integrator compliance is
superseded by this document.

Two roles remain for what were previously described as levels:
- Whether the customer's compute carries hardware attestation (which
  extends the baseline's coverage into the substrate — an integration
  requirement, not a compliance tier, described in the companion
  Requirements document).
- Whether the baseline is publicly anchored (§4 above — a
  transparency-visibility choice, not a compliance grade).

## 6. Security ends at the signing moment

A Scruple receipt's security is established in three distinguishable
phases. The distinction is load-bearing.

**Phase 1 — pre-signing.** The integrator's discipline — everything
enumerated in the companion Requirements document — and the substrate's
attested integrity. Every element of Phase 1 exists to make the eventual
signature *meaningful* — to guarantee that the bytes about to be signed
are the bytes the workflow actually produced.

**Phase 2 — the signing moment.** The Confidential Virtual Machine's
attested key signs the record that includes the workflow leaf and its
reference to the baseline. **This instant is terminal for integrity.**
Once the signature exists, the record's cryptographic tamper-evidence
is complete.

**Phase 3 — post-signing.** Merkle inclusion in Scruple's log, local
lock (finalize + user receipt), chain lock (inscription on a distributed
public ledger), content-addressed decentralized-storage pinning,
permanent-public-archive record. Every Phase-3 action changes *where the
tamper-evidence hash is published* and *who can find it without
cooperation from Scruple or the vendor*. None of them adds or removes
security.

Precisely: the signature is terminal for **integrity**; its
**trustworthiness** is fully determined by Phase 1; higher Phase-3
publication tiers add **censorship-resistant discoverability, not
integrity**.

## 7. Lock tiers add discoverability, not integrity

A checkpoint receipt and a permanent-locked receipt of the same event
have identical cryptographic tamper-evidence. What differs is only how
publicly the tamper-evidence hash is registered and how many independent
paths a verifier has to find it.

Marketing or contract language that describes higher lock tiers as
"stronger security" is inaccurate. Higher lock tiers add
censorship-resistant discoverability. Pricing for higher lock tiers is
therefore pricing for public-ledger anchoring cost and for the
downstream verifier reach it delivers.

When network or ledger operations fail during a Phase-3 publication
(mint failures, confirmation delays, pin failures, anchor retries), the
receipt's integrity is unaffected — the anchor is not yet published, but
the signature is complete. Scruple retries with backoff and surfaces
persistent failure as an operational alarm. Under no circumstances is a
failed Phase-3 operation silently dropped.

## 8. The two Scruple Layers

Scruple's substrate is delivered in two layers. Both witness through the
same attested-signer pattern; they differ in what shared trust they
remove.

### 8.1 Soft Scruple

The current production substrate. Witness signers run inside Confidential
Virtual Machines on a public-cloud host with hardware-rooted attestation
(AMD SEV-SNP, Intel TDX, AWS Nitro Enclave, Google Confidential Space).
Each signer's key is generated inside its CVM; the public-key SPKI hash
is cryptographically bound into the platform's attestation report, which
chains through the platform vendor's hardware root of trust.

The capability this delivers: **an operator-independent witness.** The
Scruple operator cannot extract the signing key, cannot sign outside the
attested environment, and cannot forge historical records — the
attestation report published alongside each signer identity is
externally verifiable against a hardware root Scruple does not control.

**Soft Scruple removes operator trust from the witness. This matches the
strongest guarantee currently shipped in the AI provenance category.**

#### 8.1.1 Signer fleet lifecycle

In production the substrate is delivered as a fleet of signer CVMs
under an Instance Pool with fleet-manager-enforced maximum instance age
(currently 60 days). Aged CVMs are replaced with freshly-provisioned
CVMs built from the current CI-verified golden image; the rotation is
enforced by a scheduled orchestration function on a 6-hour cadence and,
as a secondary guardrail, by an in-guest actuator that refuses to sign
when the running CVM has aged past the policy.

Every signed manifest carries an
`ai.scruple.signer-runtime.v1` assertion binding the specific signer
instance's OCID, image OCID, creation timestamp, computed age at
signing, and the configured max-age policy — so any verifier can
confirm the signing CVM was within the max-age window at signing time.

This fleet-lifecycle discipline is what satisfies external assurance
programs' operating-system patch-currency requirements on the signer
substrate: the running signer cannot be older than the max-age window,
by architectural construction, without ceasing to sign.

### 8.2 Hard Scruple

An observer operating on sequestered hardware, physically isolated
from the workload it observes. Unchanged from the
original Standard. Confidential; detailed architecture is out of scope
for this document.

The capability Hard Scruple adds beyond Soft: **shared host and root-
complex trust are removed as well.** Where Soft Scruple depends on the
integrity of the cloud host's virtualization platform and the hardware
root-of-trust vendor's CA infrastructure, Hard Scruple depends only on
the sequestered observer.

**Hard Scruple goes beyond the category's ceiling.** No competing
provenance system in the AI ecosystem ships an observer physically
isolated from the workload.

### 8.3 Precise claim, precise limitation

Wording to keep straight:

- Soft Scruple removes **operator trust** and matches the strongest
  guarantee others ship.
- Hard Scruple additionally removes **shared-hardware trust**.
- Neither claim reduces to "as good as hardware, nothing left to trust."
  Both Soft and Hard Scruple have documented threat models that
  include what they do and do not defend against.

## 9. Output modality options

A Scruple-witnessed event's underlying evidence — the attested-signer
witnessing, the baseline binding, the audit-chain leaf, the
operator-independent posture — is the substrate. On top of that
substrate, Scruple provides multiple **output modalities** that the
customer composes per event according to their downstream requirements.

The modalities are independent, first-class, and composable. Selecting
one does not require any other. A customer may attach one, several, or
all. Every combination inherits the same underlying Scruple guarantees;
the modalities differ in **who can verify what, using which existing
verifier infrastructure**.

### 9.1 C2PA content credentials (in-band signed metadata)

Scruple is a **C2PA Generator Product**. When the customer selects this
modality, the output artifact carries an in-band C2PA manifest signed
by the Scruple witness. The manifest includes standard C2PA fields
(claim generator info, actions, digitalSourceType, thumbnail
assertions) and, when the customer's compute chain is attested, a
bound hardware-attestation assertion.

This modality implements the **"in-band signed metadata attached to
the content"** measure enumerated under Section 1 mandatory marking
measures of the EU AI Act Article 50 Code of Practice on Transparency
of AI-Generated Content. Any verifier holding the output can validate
the manifest using standard C2PA tooling
(e.g. `verify.contentcredentials.org`, `c2patool`, `c2pa-rs`) without
contacting Scruple.

Scruple's role in this modality: signer, claim generator, and manifest
publisher. The customer's role: selecting this modality and providing
the source content.

### 9.2 Watermarking

Scruple provides a DCT-domain watermark implementation for image and
video outputs with a 5-tier payload structure. When the customer
selects this modality, the output carries an imperceptible watermark
that survives common transformations (re-encoding, resizing, colour
transforms) and encodes a hash pointing back into the Scruple audit
chain.

This modality implements the **"watermarking"** measure enumerated
alongside signed metadata under Section 1 mandatory marking measures
of the EU AI Act Article 50 Code of Practice.

### 9.3 Chain lock (public-ledger anchor)

When the customer selects this modality, the event's leaf hash is
inscribed on a **distributed public ledger**, with optional
**content-addressed decentralized storage** pinning and **permanent
public archive** record. This adds censorship-resistant
discoverability — a verifier can find the leaf hash without cooperation
from Scruple or the vendor.

The Standard names the capability class; specific ledger, pinning, and
archive vendors are implementation choices for the licensee. A Scruple
implementation using any combination of vendors within these classes
(e.g., Ravencoin, Bitcoin, Polygon, Solana, or another distributed
public ledger; IPFS or another content-addressed storage network;
Arweave or another permanent-archive protocol) still meets the
Standard, provided the vendor's own guarantees deliver the class-level
properties (censorship-resistance for the ledger; content-addressed
integrity for pinning; permanence-of-record for archive).

Chain lock is independent of C2PA and independent of watermarking. A
customer may select chain lock without either, and the resulting
receipt still carries the full underlying Scruple evidence-based
provenance. The difference is only what other verification paths are
attached to the same event.

### 9.4 Local lock (finalize + user receipt)

The default terminal modality for every event. Emits a local receipt
to the customer, finalizes the leaf's inclusion in Scruple's log, and
issues a portable verification package. Every Scruple event produces a
local lock; the other modalities (C2PA, watermark, chain lock) are
attached alongside it, not instead of it.

### 9.5 Composability

Any combination is permissible. A user producing an AI-generated image
who selects (a) C2PA + (b) watermark + (c) chain lock receives an
output that is: in-band signed as a C2PA credential, watermarked in
the pixel space, and hash-anchored on the public ledger — three
independent verification paths, all inheriting the same underlying
attested-signer, baseline-bound witnessing.

A user selecting only (c) chain lock receives an output with
Scruple's underlying evidence-based provenance plus a public-ledger
anchor, and no in-band metadata or watermark. This is a supported and
common configuration.

The user's modality selection is itself recorded in the event's leaf,
so a downstream verifier can distinguish "the user chose not to attach
C2PA" from "C2PA was attached and later stripped."

### 9.6 Continuity when Scruple's substrate is temporarily unavailable

When operational conditions prevent Scruple's full witnessing pipeline
from completing (for example, a signer outage combined with a customer
integration that continues to produce content), the customer's
integration may produce content with C2PA-only sidecar signing, using
its own C2PA credentials outside Scruple's witness path.

This continuity path preserves C2PA's own trust-list-based verification
but does not carry Scruple's baseline binding, chained audit log, or
operator-independent witness posture. Events produced under this
continuity path are marked as such in the audit chain when the
customer's integration recovers connectivity to Scruple. Continuity is
a resilience property of the customer's integration, not a Scruple
modality.

## 10. Evidentiary discipline

Scruple-witnessed records are **self-authenticating, tamper-evident,
and verifiable**. Any party holding the record and the referenced
public data can independently confirm its integrity without cooperation
from Scruple or from the vendor.

Scruple does not, and does not claim to, make records "court-ready,"
"court-admissible," or "compliant" with any particular regulatory
regime. Whether a Scruple-witnessed record satisfies the evidentiary
requirements of a specific court, agency, or contract is a question
for the party presenting it and their counsel. Scruple's role is to
produce the cryptographic substrate on which such determinations can
be made.

## 11. Four axes

Four independent axes describe a Scruple receipt. They are never
collapsed to a single grade or tier.

1. **Scruple Layer** — Soft, Hard. The substrate on which Scruple's
   own signer runs.
2. **Customer hardware witnessing level** — Level 1 (self-witnessing
   compute hardware) or Level 2 (third-party hardware observer), each
   available in a cloud or local deployment lane. Level 2 strictly
   dominates Level 1 for the evidentiary property this Standard
   measures; cloud/local is a deployment axis within each level. See
   §15.3 for the full ordering and threat-model comparison.
3. **C2PA Assurance level, when the C2PA modality is selected** —
   the external C2PA Generator Product Conformance Program's own
   L1 / L2 assurance scale for the Scruple signer chain. Applies only
   to events where the customer selected the C2PA output modality
   (§9.1); not applicable to events using other modalities. Distinct
   from Scruple's own compliance question.
4. **Lock Tier** — checkpoint, local, chain (distributed public
   ledger), content-addressed decentralized-storage pinning,
   permanent-public-archive record. The Phase-3 discoverability
   progression.

Compliance is binary (§5) and is not an axis. A receipt may carry
values on all three axes independently.

## 12. C2PA Generator Product Conformance Program participation

Scruple is an active applicant in the **C2PA Generator Product
Conformance Program** administered by the Coalition for Content
Provenance and Authenticity.

| Field | Value |
|---|---|
| Program | C2PA Generator Product Conformance Program |
| Applicant | Docent LLC (dba Docent Technologies) |
| Product | Scruple |
| Intake ID | `019f5856-bff8-7f57-a879-80594a6fb3fe` |
| Initial submission | 2026-07-14 |
| Reviewer's preliminary assessment on that submission (2026-07-16) | Level 1 requirements MEET; Level 2 requirements did not meet on the running-signer OS-patch-currency architectural point (Requirements 6.3.2 + 6.4.2) |
| Remediation submission | 2026-07-18 — architectural remediation of the Level 2 point via the Instance Pool + max-age rotation described in §8.1.1; sample-level defects and trust-list validation also addressed |
| Status as of the date on this document | Amendment in review with the Conformance Program |

**Not yet listed on the C2PA public conforming-products registry.**
The C2PA registry
(https://github.com/c2pa-org/conformance-public/blob/main/conforming-products/conforming-products-list.json)
lists products only after final certification issues; a reviewer's
preliminary assessment during an active review is not itself a
registry entry.

**Language discipline.** This document and other Docent-published
material refrain from claiming "C2PA Level 1 certified,"
"C2PA-conformant," or any equivalent formulation until the Conformance
Program issues formal notification. Prior to that, the accurate
statement of record is the row structure above: applicant, submission
dates, and reviewer's preliminary assessment on the identified
submission.

**Independent verification.** The status above is independently
verifiable by writing to `conformance@c2pa.org` with the Intake ID.

## 13. [Reserved for future material]

## 14. [Reserved for future material]

## 15. Hardware Attestation

### 15.1 Two attestation chains

A receipt MAY carry two independent, hardware-rooted attestation chains. They terminate at different roots and are verified independently.

| Chain | Proves | Terminates at |
|---|---|---|
| **Scruple substrate** | Scruple's signer runs in an attested CVM (operator-independent). | Scruple's substrate root (AMD ARK, Intel TCS, etc.) |
| **Customer compute** | The workload ran on genuine, vendor-attested hardware in a measured confidential-compute state, bound to this specific event. | Customer platform's hardware root (NVIDIA root CA, AMD ARK, Intel TCS, AWS Nitro root, Azure Attestation Service, etc.) |

Both verifying is stronger than either alone: a forger must defeat two vendors' attestation chains, not one.

### 15.2 What the customer-compute chain does and does not prove

**Proves:** the workload ran on genuine, measured, vendor-attested hardware (the operator could not tamper with the *compute environment*), and the attestation is bound to this event via a cryptographic nonce derived from the leaf preimage (no replay).

**Does NOT prove:** that the content committed in the leaf is the content that hardware actually processed.

The reason is structural: the attestation and the leaf content both flow through the customer's integration code. A non-compliant or compromised integration can run workload B on genuinely attested hardware while computing the leaf over workload A, then bind the real attestation to the A-leaf. Every cryptographic check passes; the receipt is false.

**This content-to-compute binding is not a hardware property at this tier.** It rests entirely on R1 (witness-boundary integrity) and the baseline — i.e., it is a software property of the integration. Imported hardware attestation raises the *compute* into hardware; it does not raise the *content binding* into hardware.

### 15.3 The blind spot only a third-party hardware observer closes

The unclosed inch is: *did the observer see the actual bytes the GPU
received and produced, or the bytes the integration reported?*

Any architecture in which the compute hardware witnesses its own
workload cannot close this — because the attestation and the leaf
content both flow through the customer's integration code. Only a
hardware observer that is **architecturally separate from the compute**
— reading workload bytes off the memory bus or an equivalent physical
path — can close it. The witnessed content is the content the hardware
processed, by construction, not by the integration's assertion.

This defines two levels of customer-side hardware witnessing.

**Level 1 — self-witnessing compute hardware.**
The compute attests to its own state and workload (TEE / CVM /
confidential-compute GPU). Content-to-compute binding is a software
property: the attestation report is authentic, but what the report is
*about* is asserted by integration code (§15.2).

**Level 2 — third-party hardware observer.**
Hardware external to the compute observes the inference directly. The
observer is root-hardware, host-inaccessible, and its supply chain is
independent of the compute vendor. Content-to-compute binding is a
physical property: the observer sees the workload bytes, not
integration-code-asserted representations of them.

Each level is available in two deployment lanes:

- **Cloud lane** — the compute (and, at Level 2, the observer) runs in
  a public-cloud environment. Carries the cloud vulnerability that the
  cloud provider retains some level of substrate access.
- **Local lane** — the compute (and, at Level 2, the observer) runs on
  customer-controlled premises. Removes cloud vulnerability.

**Ordering by evidentiary strength, weakest to strongest:**

| Position | Level | Lane | Content-to-compute binding | Cloud vulnerability |
|---|---|---|---|---|
| 1 | 1 | Cloud | Software | Present |
| 2 | 1 | Local | Software | Absent |
| 3 | 2 | Cloud | Physical | Present |
| 4 | 2 | Local | Physical | Absent |

**Level 2 strictly dominates Level 1 for the evidentiary property this
Standard measures.** The threat comparison is straightforward: a
compromised GPU defeats every Level 1 configuration regardless of
deployment, because the GPU vouches for itself. Level 2's counterpart
threat is a compromised third-party observer, which requires
subverting a second, independent hardware supply chain. Trust in one
vendor's root vs. trust in two independent vendors' roots.

The cloud-vulnerability axis is a runtime-confidentiality concern
orthogonal to evidentiary strength. A customer deploying under
sovereignty, air-gap, or provider-independence requirements will
prefer a local lane at either level; the ordering above ranks local
above cloud within each level as a soft tiebreaker on trusted-actor
count, not as an evidentiary difference.

**Hard Scruple (§8.2)** is one realization of a Level 2 witness —
specifically, an on-premise sequestered RTL observer. Other Level 2
realizations exist and are equally capable of closing the
content-to-compute blind spot; the Standard names Level 2 as a
capability class, not any particular product or hardware family.

Claim discipline: Level 1 with imported customer attestation *matches
the strongest guarantee others ship*. It does not equal Level 2 in
either lane, because no self-witnessing architecture can prove
content-to-compute binding — only an independent observer can.

### 15.4 Verified vs. passthrough attestations

Scruple verifies well-known attestation types at ingest (chains to the vendor root; nonce matches the leaf; within freshness window) and rejects invalid reports with a 4xx. Uncommon or newer types MAY be stored and anchored opaquely with a `verifier_reference`; downstream verification is then the receipt-consumer's responsibility.

A receipt MUST visibly distinguish a **Scruple-verified** attestation from a **stored-but-unverified (passthrough)** one. A passthrough attestation MUST NOT present identically to a root-verified one. "Stored" MUST NOT read as "verified."

### 15.5 Operational

Attestation freshness windows (per-event fetch vs. cached-within-window) are per-tenant operational configuration with a stated maximum — set in the Integration Requirements, not fixed in this Standard. A shorter window narrows the replay surface; a longer one reduces latency and load.

## 16. Change discipline for this Standard

This Standard is versioned. Material changes to the capability register
bump the minor version (v1.3, v1.4). Backwards-incompatible changes to
capability guarantees bump the major version (v2.0) and are announced
with a defined transition window for existing integrations.

The current version's canonical location is this document. A public
web-hosted mirror will be established at `https://docs.scruple.ai/standard`
when infrastructure is available; until then, the version at rest in
Scruple's repository is authoritative.

## Appendix A — Vocabulary

- **Baseline** — a signed hash covering an integration's tamper-surface
  at a point in time. The tenant's genesis leaf.
- **Re-baseline** — a signed leaf recording that the tamper-surface has
  materially changed, linked by hash to the prior baseline.
- **Witness** — the Scruple signer, operating in an attested Confidential
  Virtual Machine (Soft) or on a sequestered observer (Hard).
- **Leaf** — one record in the audit log. Both workflow events and
  baseline events are leaves.
- **Signing moment** — the instant the attested key signs the record.
  Phase 2 in the three-phase model. Terminal for integrity.
- **Lock tier** — the Phase-3 publication level a customer selects for a
  finalized record. Determines discoverability, not integrity.
- **Compliance** — binary. An integration is Scruple-witnessed or it is
  not. Determined by baseline verification.

## Change log

- **2026-07-30, v1.5** —
  - **Scope note added to header** — explicitly frames the Standard as
    describing capability classes rather than specific implementations,
    so a licensee substituting a different vendor within the same class
    (e.g., a different distributed public ledger, a different
    hardware-attested confidential execution environment) still meets
    the Standard.
  - **§9.3 Chain lock** genericized. Ledger, pinning, and archive
    named as capability classes rather than fixed vendors. Prior
    hard-coding to *Ravencoin / IPFS / Arweave* replaced with
    class-level language plus non-normative examples of vendors within
    each class.
  - **§8.2 Hard Scruple** description narrowed. Removed the
    architectural hint *"register-transfer-level"* from the
    sequestered-hardware description; the Standard now names only the
    guarantee (sequestered hardware physically isolated from the
    workload) and continues to hold detailed architecture as
    confidential.
  - **§15.4** attestation-binding description abstracted. Removed the
    specific hash construction *`nonce = sha256(leaf_preimage)`*; the
    Standard now describes the guarantee (attestation bound to the
    event via cryptographic nonce derived from the leaf preimage)
    without specifying the exact construction.
- **2026-07-30, v1.4** —
  - **§15.3 expanded and retitled** from *"The blind spot only local
    inference closes"* to *"The blind spot only a third-party hardware
    observer closes."* Generalizes the prior three-rung ladder into a
    two-level × two-lane taxonomy: Level 1 (self-witnessing compute
    hardware — TEE/CVM/GPU vouches for itself) and Level 2 (third-party
    hardware observer — independent hardware watches the compute), each
    available in a cloud lane or a local lane. Introduces the explicit
    ordering by evidentiary strength (weakest to strongest: L1-cloud,
    L1-local, L2-cloud, L2-local) with the load-bearing threat
    comparison: a compromised GPU defeats every Level 1 configuration
    regardless of deployment. Reframes Hard Scruple as one realization
    of Level 2 among others; the Standard names Level 2 as a capability
    class, not a product.
  - **§11 axis added and section retitled** from *"Three axes"* to
    *"Four axes."* Adds axis 2 *"Customer hardware witnessing level"*
    (L1 / L2, each with cloud / local lanes). Prior axes 2 and 3
    (C2PA Assurance, Lock Tier) renumbered to axes 3 and 4.
  - **§9 rewritten** from *"C2PA as graceful-degradation floor"* to
    *"Output modality options."* Clarifies that C2PA content credentials,
    watermarking, chain lock, and local lock are independent
    user-selectable output modalities the customer composes per event —
    not a mandatory stack or a fallback ladder. Corrects the prior
    v1.2 statement *"Every Scruple-witnessed record is also a valid
    C2PA record"* — C2PA output is user-composed, not automatic. A
    customer may select chain lock without C2PA, watermark without
    chain lock, etc. §9.1 explicitly maps the C2PA modality to the EU
    AI Act Article 50 Code of Practice Section 1 "in-band signed
    metadata" measure; §9.2 maps watermarking to the alternative
    "watermarking" measure. §9.6 preserves the earlier
    graceful-degradation content but reframes it as a resilience
    property of the customer's integration, not a Scruple modality.
  - **§8.1 Soft Scruple** updated to describe the substrate as a
    fleet of CVMs rather than a single CVM.
  - **§8.1.1 added** — the signer-fleet lifecycle: Instance Pool with
    60-day maximum instance age, orchestration-function rotation on a
    6-hour cadence, in-guest actuator as secondary guardrail,
    `ai.scruple.signer-runtime.v1` per-manifest attestation binding
    the signing instance's identity and age. Reflects the 2026-07-18
    architectural remediation.
  - **§11 axis 2 (C2PA Assurance) qualified** — applies only to
    events where the customer selected the C2PA output modality.
  - **§12 added** — honest disclosure of C2PA Generator Product
    Conformance Program participation: Intake ID, submission dates,
    reviewer's preliminary assessments, current amendment-in-review
    status, and language discipline prohibiting "certified" claims
    until formal notification.
  - **Header** — legal-entity ownership corrected to *"Docent LLC
    (dba Docent Technologies), publisher of the Scruple product"* —
    supersedes the prior *"Docent Technologies LLC (dba Scruple)"*
    formulation.
- **2026-07-13, v1.2** —
  - Added §15 Hardware Attestation covering: two-chain receipt architecture (Scruple substrate + customer compute), what the customer-compute chain does and does not prove (content-to-compute binding is a software property until Hard Scruple), the three-rung ladder (Soft / Soft+imported attestation / Hard), verified vs. passthrough distinction with the requirement that receipts visibly distinguish them, and operational note that freshness windows are per-tenant config.
  - Reserved §§12–14 for future material (temporal + code-space integrity, prepare/commit for gating events, and one open slot).
  - Renumbered previous §12 (Change discipline) to §16.
- **2026-07-13, v1.1** —
  - Split from v1.0 into this Capability register plus a companion
    *Scruple Integration Requirements* implementation document.
  - Compliance collapsed to binary. Removed *Standard / Attested /
    Certified* tier hierarchy.
  - Added: baseline attestation and re-baseline as a first-class
    witnessed public event.
  - Added: public-ledger anchoring of the baseline as a core
    transparency option.
  - Added: three-phase signing-boundary principle (pre-signing / signing
    moment / post-signing) with the load-bearing claim that security
    ends at the signing moment.
  - Added: C2PA as graceful-degradation floor with precise
    verification-fails vs verification-pending distinction.
  - Reframed: Soft Scruple matches the category's strongest guarantee
    via operator-trust removal; Hard Scruple goes beyond by removing
    shared-hardware trust. Precise wording bounds.
  - Corrected: three independent axes only (Scruple Layer, C2PA
    Assurance, Lock Tier). No integrator-compliance axis.
  - Evidentiary discipline: self-authenticating / tamper-evident /
    verifiable — never court-ready / court-admissible / guarantees
    compliance.
- 2026-07-13, v1.0 — Initial publication (superseded by v1.1 same day
  after harmonization).
