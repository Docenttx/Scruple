# The Scruple Standard, v1.1

**Status:** Capability register. Public-facing.
**Version:** 1.1
**Date:** 2026-07-13
**Owner:** Docent Technologies LLC (dba Scruple)
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
lock (finalize + user receipt), chain lock (inscription on Ravencoin),
IPFS pinning, Arweave record. Every Phase-3 action changes *where the
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

The current production substrate. A witness signer runs inside a
Confidential Virtual Machine on a public-cloud host with hardware-rooted
attestation (AMD SEV-SNP, Intel TDX, AWS Nitro Enclave, Google
Confidential Space). The signer's key is generated inside the CVM; its
public-key SPKI hash is cryptographically bound into the platform's
attestation report, which chains through the platform vendor's hardware
root of trust.

The capability this delivers: **an operator-independent witness.** The
Scruple operator cannot extract the signing key, cannot sign outside the
attested environment, and cannot forge historical records — the
attestation report published alongside each signer identity is
externally verifiable against a hardware root Scruple does not control.

**Soft Scruple removes operator trust from the witness. This matches the
strongest guarantee currently shipped in the AI provenance category.**

### 8.2 Hard Scruple

An observer operating on sequestered register-transfer-level hardware,
physically isolated from the workload it observes. Unchanged from the
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

## 9. C2PA as graceful-degradation floor

Scruple's guarantee is stronger than what C2PA alone provides. When
operational conditions prevent the full Scruple guarantee — for example,
when the CVM signer is temporarily unavailable and the customer's
integration continues to produce signed content — the system degrades
to a **C2PA-only receipt with C2PA's known and stated limitations,
never to no receipt.**

Two distinct failure classes:

- **Verification-fails** — the baseline is broken, the signature does
  not chain, or a tamper-surface change has occurred that was not
  re-baselined. The receipt is not Scruple-witnessed. This is terminal.
- **Verification-pending** — an operational condition (network,
  anchor-ledger congestion, temporary signer outage) means a signature
  is not yet complete or a Phase-3 anchor is not yet published. This is
  retryable and never silently dropped.

The degradation is precise. Under C2PA-only fallback:
- **Preserved:** the C2PA sidecar's own signature and its trust-list-
  based verification path.
- **Lost:** the baseline attestation binding to the integration's state,
  the chained audit log providing tamper-evident event ordering, and
  Scruple's operator-independent witness posture.

C2PA plays a positive role in this architecture: it is the floor the
system stands on, not a hedge Scruple is retreating toward. Every
Scruple-witnessed record is also a valid C2PA record; the additional
Scruple guarantees layer on top.

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

## 11. Three axes

Three independent axes describe a Scruple receipt. They are never
collapsed to a single grade or tier.

1. **Scruple Layer** — Soft, Hard. The substrate.
2. **C2PA Assurance** — the external C2PA program's own L1 / L2
   assurance scale. Distinct from Scruple's compliance question.
3. **Lock Tier** — checkpoint, local, chain (RVN), IPFS, Arweave. The
   Phase-3 discoverability progression.

Compliance is binary (§5) and is not an axis. A receipt may carry
values on all three axes independently.

## 12. Change discipline for this Standard

This Standard is versioned. Material changes to the capability register
bump the minor version (v1.2, v1.3). Backwards-incompatible changes to
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
