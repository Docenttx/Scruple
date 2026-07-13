# The Scruple Standard, v1.0

**Status:** Normative. This document defines what an integration MUST meet to
qualify as Scruple-witnessed.
**Version:** 1.0
**Date:** 2026-07-13
**Owner:** Docent Technologies LLC (dba Scruple)
**Audience:** Any organization integrating the Scruple witnessing API into
their platform, product, or workflow.
**Related:** [`CANONICAL_SCRUPLE_WITNESSING_L2.md`](./CANONICAL_SCRUPLE_WITNESSING_L2.md)
(internal architecture), [`Independent_AI_Witnessing_Rider_TEMPLATE.md`](./Independent_AI_Witnessing_Rider_TEMPLATE.md)
(customer legal instrument).

The words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** in
this document are used in the sense of RFC 2119.

---

## 1. What this Standard exists to do

The value of any provenance receipt is exactly the trustworthiness of the
capture point that produced it. A witness leaf signed by Scruple that
attests to bytes the end user could have substituted, edited, or fabricated
before the hash was taken proves nothing beyond "the user chose to show us
these bytes at this time."

This Standard specifies the minimum properties an integration MUST have so
that the receipt it produces is meaningful — so that when a Scruple-witnessed
artifact is presented in court, in regulatory review, in a copyright claim,
or in a marketplace listing, the receipt carries the weight it appears to
carry.

An integration that does not meet this Standard MUST NOT be described,
marketed, or represented as Scruple-witnessed. Scruple reserves the right
to revoke API access to integrations found to fall out of compliance.

## 2. Who this applies to

Any party that:

- Holds a Scruple tenant API key, and
- Calls the Scruple witnessing API on behalf of an end user, or embeds a
  Scruple-provided client into a product used by end users.

This includes but is not limited to: AI inference platforms, model-training
services, creative-tool vendors, content-management systems, and enterprise
compliance stacks that use Scruple as their provenance backend.

## 3. The load-bearing principle

> **The end user MUST NOT have access to the layer that performs the
> witnessing.**

Everything in Section 4 follows from this one principle. If your integration
lets the user modify the code that hashes the artifact, control the API key
that authenticates the witness call, choose whether the witness fires, or
substitute bytes between hash and POST — the witness is theater and the
integration does not meet this Standard.

## 4. The Seven Rules

### R1 — Witness-boundary integrity

The code that computes the artifact hash and submits the witness leaf MUST
run in a boundary the end user does not control.

**Acceptable boundaries:**
- Server-side capture in your platform's backend
- Attested-client capture in a code-signed installer where the user cannot
  modify the running binary (examples: Fusion palette running inside
  Autodesk's app, code-signed UXP plugin inside Adobe apps, code-signed
  desktop agent with tamper-detection)
- Trusted-execution-environment worker (AMD SEV-SNP, Intel TDX, AWS Nitro
  Enclave, Google Confidential Space) where the workload is measured and
  attested

**Unacceptable boundaries:**
- Browser JavaScript the user can inspect and modify via DevTools
- ComfyUI custom nodes, Kohya plugins, or similar user-installable modules
  where the user can disable or replace the integration at runtime
- Server-side code the user has shell or admin access to (their own EC2
  instance, their own RunPod pod with root)

### R2 — Capture-point discipline

The hash MUST be computed at a point where the artifact cannot be modified
between hash computation and witness submission.

- **Training:** Hash the trained model file from within the training
  process, from a controlled path the user cannot write to. If the model
  is written to a user-writable location, the hash MUST be taken from an
  in-memory buffer before that write.
- **Inference:** Hash the output artifact within the inference server's
  process, before the bytes are served to the user, and MUST NOT accept a
  user-supplied hash for the same artifact.
- **Post-processing / edit:** Hash within the application's Save handler,
  before the user has an opportunity to swap files. The Save handler MUST
  read the file bytes it just wrote (not accept a user-supplied filename
  the user could point elsewhere).
- **Dataset capture:** Hash all constituent files before the training job
  begins. The dataset Merkle root MUST be computed and witnessed prior to
  the first training step, not reconstructed after the fact.

### R3 — API key custody

The Scruple tenant API key MUST be held by the platform. End users MUST NOT
possess, view, or transmit the key.

**Acceptable:**
- Platform's server-side secret manager (AWS Secrets Manager, Azure Key
  Vault, GCP Secret Manager, HashiCorp Vault, OCI Vault)
- Attested-client keychain-scoped storage where the OS keystore prevents
  extraction by non-signing processes

**Unacceptable:**
- API key embedded in client-side JavaScript, mobile app bundle, or any
  bytecode the user can dump
- API key distributed to end users via email, config file, or environment
  variable in a user-controlled shell
- Shared "team" API key that multiple end users can extract from an
  admin console

### R4 — Principal identity

The `principal_id` field on every witness call MUST be derived from
authenticated session state on the platform, MUST NOT be a value the
end user can supply or modify in the request, and MUST be stable across
sessions for the same end user.

If the platform allows end users to see or change their own principal ID,
the platform MUST cryptographically bind the principal ID to authenticated
identity at witness time (e.g. server signs the principal ID using its own
key before including in the witness payload).

### R5 — Immutable event chain

Once a witness leaf is submitted and acknowledged, the platform MUST NOT
attempt to alter or delete prior leaves for the same project or stream.

- Retractions MUST be modeled as new witness events ("event X was
  retracted at time Y for reason Z"), not as deletions.
- Late-arriving events MUST be witnessed with the actual event time and
  the actual server-received time — never backdated.
- If a platform bug causes an incorrect leaf to be submitted, the
  correction MUST be a new leaf that references and supersedes the
  incorrect one. The incorrect leaf remains in the audit chain.

### R6 — Zero-content posture

Payload bytes — prompts, images, model weights, source files, PII —
MUST NOT be transmitted to Scruple. Only cryptographic hashes, small
structured metadata (counts, timestamps, tags), and identifiers.

The Scruple ingest schema rejects payload_bytes-shaped fields with a 4xx
response. Integrations MUST NOT attempt to work around this by encoding
content into permitted fields (e.g. base64 in a metadata string, JSON
containing raw bytes). Doing so is a compliance violation regardless of
whether the schema catches the specific attempt.

Integrations that need to preserve full-resolution evidence bundles MUST
preserve them in the customer's own storage (WORM bucket, evidence
locker) and submit only the hash-commitment leaf to Scruple.

### R7 — Attestation transport (Level 2 and above)

If the platform's compute environment provides hardware attestation
(AMD SEV-SNP, Intel TDX, AWS Nitro Enclave, Google Confidential Space,
TPM 2.0 Quote), the attestation report or a stable reference to it MUST
be included with each witness call so the leaf's provenance chain
terminates in hardware, not in the platform's assertion.

For Level 1 (Standard) integrations, R7 does not apply. R7 is normative
only for platforms seeking Level 2 (Attested) or Level 3 (Certified)
qualification.

## 5. Compliance Levels

Every Scruple-integrated deployment operates at one of three levels. The
level is agreed at contract time and appears on receipts and public
verification pages.

### Level 1 — Standard

**Requirements:** R1 through R6.

**Fitness:** Platform-hosted SaaS integrations where the platform's own
operational trust is adequate for the evidence claim being made.

**Typical use:** Creative platforms attesting user-authored work,
marketplaces recording provenance for listing purposes, workflow tools
where the audit posture is commercial rather than regulatory.

**Public label:** "Scruple L1" or "Scruple Standard."

### Level 2 — Attested

**Requirements:** R1 through R7.

**Fitness:** Regulatory and legal contexts where the trust chain must
terminate in hardware. The platform's compute environment provides
hardware attestation and that attestation is bound into every leaf.

**Typical use:** EU AI Act Article 50 obligations, US SEC audit
requirements, FDA compliance, financial-industry evidence chains,
cross-border legal defensibility.

**Public label:** "Scruple L2 Attested."

### Level 3 — Certified

**Requirements:** Level 2 plus periodic third-party audit against this
Standard, on a cadence defined in the contract (typically annual, with
event-triggered re-audit on material integration change).

**Fitness:** Public-attestation postures where the integration is itself
under external scrutiny.

**Typical use:** Newsroom evidence chains (AP, Getty), court-admissibility
positions where the integration will be subject to discovery, high-value
provenance registries.

**Public label:** "Scruple L3 Certified."

## 6. Rejection Criteria — concrete anti-patterns

The following patterns are explicit compliance failures. They exist as
worked examples to save integration teams from replicating them.

- **Browser POSTs directly to Scruple.** Client JavaScript holds the API
  key and calls the witness endpoint from the user's browser. Violates R1
  and R3. The user can inspect the request, steal the key, and forge
  witness calls for any content they choose.
- **Optional integration node.** A ComfyUI custom node or plugin the user
  installs and can uninstall at will, wired to fire witness calls only
  when present. Violates R1. A user who wishes to produce unwitnessed
  content trivially disables the node.
- **User-supplied output hash.** The platform accepts a hash from the
  user and forwards it as the witness leaf's `content_hash`. Violates
  R2. The user can supply the hash of whatever bytes flatter their
  claim, not the bytes they actually produced.
- **User-controlled principal.** The platform allows the end user to set
  their own principal ID as a request parameter, and the platform passes
  it through unchanged. Violates R4. Two users can trade principal IDs
  and impersonate each other in the audit chain.
- **Silent-drop of failed witness calls.** The integration catches
  witness-API errors and continues without a leaf, without recording the
  drop. Violates R5 (the event that was supposed to be witnessed now has
  no representation in the chain, and no gap-marker). Failed witness
  calls MUST be retried with backoff and, if permanently failing,
  surfaced as an operational alarm — never silently discarded.
- **Content in the metadata.** Base64-encoded image bytes stuffed into
  a `meta.description` field to "keep everything together." Violates R6.
- **Development attestation in production.** A Level 2 integration that
  ships with a mock attestation report generated at build time rather
  than a live report from a real TEE. Violates R7.

## 7. Retrofit Checklist

For teams designing a new integration or auditing an existing one, work
through this gate. If any answer is "no," the integration is not L1
compliant.

**Boundary**
- [ ] Is the code that hashes and POSTs the leaf running in a boundary the
      end user cannot modify at runtime?
- [ ] Is the API key held server-side or in an attested-client keystore?

**Capture**
- [ ] Is the hash taken before the user has any opportunity to substitute
      bytes?
- [ ] For training: is the dataset hashed before the first training step?
- [ ] For inference: is the output hashed before it's served to the user?
- [ ] For edits: is the file hashed by the Save handler, from bytes the
      handler just wrote?

**Identity**
- [ ] Does the principal ID on every call derive from authenticated
      session state on the platform, not from a user-supplied parameter?

**Chain integrity**
- [ ] Are historical leaves treated as immutable? Retractions modeled as
      new events?
- [ ] Are failed witness calls retried, and if permanently failed,
      surfaced as alarms rather than silently dropped?

**Content posture**
- [ ] Does the integration send only hashes and small structured
      metadata? No payload bytes anywhere in the request tree?

**Attestation (L2 only)**
- [ ] Does the compute environment produce a hardware attestation report,
      and is that report (or a stable reference) included with each
      witness call?

## 8. Getting to compliance

There are two paths to a compliant integration. Both are legitimate; the
choice is a matter of team capacity and preferred engagement model.

### 8.1 Self-implementation

Your team designs and implements the integration to this Standard, then
submits a self-certification attestation to Scruple describing how each
rule is met. Scruple reviews the attestation and, on satisfaction, enables
production API access at the declared level.

Self-certification suits teams with strong platform-security discipline
and an existing security-review practice.

The self-certification form and submission instructions are provided at
contract signing.

### 8.2 Scruple-assisted design

Scruple engineers work with your team to design the integration against
the Standard. Deliverables typically include:

- Capture-point map for your specific pipeline
- Reference implementations for each capture point in your primary
  languages
- Security review of the completed integration
- Level attestation on completion

This path is a paid engagement scoped at contract signing and is standard
practice for teams new to provenance-system integration.

## 9. Revocation and re-certification

A Scruple integration's compliance status may be revoked if:

- A material change to the integration is made without notification and
  re-review (any change to capture point, API-key handling, principal
  derivation, or attestation transport)
- A compliance violation is discovered in production (through customer
  audit, Scruple monitoring, or third-party report)
- The Level 3 audit cadence is missed for more than one cycle

Revocation is reversible via re-review. The integration's public status
page (if operated) MUST reflect the revocation within 72 hours.

## 10. Change discipline for this Standard

This Standard is versioned. Material changes bump the minor version
(v1.1, v1.2). Backwards-incompatible changes bump the major version
(v2.0) and existing integrations are granted a defined transition period.

Rule additions, clarifications, or new anti-pattern examples that do not
require existing integrations to change constitute minor versions.

New rules that require existing integrations to change constitute a
major version. Scruple will not publish a major version without a
minimum 90-day transition window and direct notification to all
integration owners.

The current version's canonical URL is:
`https://docs.scruple.ai/standard/v1` (once `docs.scruple.ai` is live;
until then, the version at rest in the Scruple repository is
authoritative).

## Appendix A — Vocabulary

- **Witness call** — a POST to the Scruple ingest API that produces a leaf.
- **Leaf** — a canonical, HMAC-signed record of one event in the audit log.
- **Principal** — the end user or entity on whose behalf a witness call
  is made.
- **Tenant** — the customer (organization) that holds the Scruple API key.
- **Platform** — the software system operated by the tenant that hosts the
  integration.
- **End user** — a user of the tenant's platform.
- **Attestation** — a hardware- or TEE-signed statement about the state
  of the compute environment producing a witness call.

## Change log

- 2026-07-13, v1.0 — Initial publication. Seven rules, three levels,
  RFC 2119 normative language.
