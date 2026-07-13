# Scruple Integration Requirements, v1.2

**Status:** Implementation specification. Integrator-facing.
**Version:** 1.2
**Date:** 2026-07-13
**Owner:** Docent Technologies LLC (dba Scruple)
**Audience:** Engineers implementing a Scruple integration on behalf of
their organization.
**Companion:** [`SCRUPLE_STANDARD_v1.md`](./SCRUPLE_STANDARD_v1.md) — the
capability register that this document implements.
**Related:** [`CANONICAL_SCRUPLE_WITNESSING_L2.md`](./CANONICAL_SCRUPLE_WITNESSING_L2.md)
(internal architecture).

The words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY**
in this document are used in the sense of RFC 2119.

---

## 1. What this document is

The companion Standard defines what a Scruple-witnessed record *means*.
This document defines what a customer's integration must implement so
that the baseline Scruple attests to *means anything useful*.

Compliance under the Standard is binary: an integration is
Scruple-witnessed or it is not, determined by whether the baseline
verifies against the running integration. The eight properties in §2
below are the requirements a baseline must be constructed against; if
any property fails, the baseline attests to nothing useful, and the
integration therefore cannot be Scruple-witnessed.

These properties are *not compliance tiers*. There is no "meeting some
of them" state that qualifies for a lower level. Either all applicable
properties hold and the baseline is meaningful, or the integration is
not Scruple-witnessed.

## 2. The eight properties of a sound baseline

### P1 — Runtime boundary integrity

The code that computes the artifact hash and submits the witness leaf
MUST run in a runtime boundary the end user does not control. The
baseline attestation MUST cover the entirety of that boundary's code
and configuration.

**Acceptable boundaries:**
- Server-side capture in the platform's backend
- Attested-client capture in a code-signed installer where the running
  binary is measurably immutable (examples: Fusion palette running
  inside Autodesk's app, code-signed UXP plugin inside Adobe apps,
  code-signed desktop agent with tamper-detection)
- Trusted-execution-environment worker (AMD SEV-SNP, Intel TDX, AWS
  Nitro Enclave, Google Confidential Space) where the workload is
  measured and attested

**Unacceptable boundaries:**
- Browser JavaScript the user can inspect and modify via DevTools
- Custom nodes, plugins, or middleware the user can disable or replace
  at runtime
- Server-side code the user has shell or admin access to (their own EC2
  instance, their own container with root)

### P2 — Baseline coverage of the capture path

The baseline attestation MUST cover the complete code path from event
trigger, through hash computation, through witness submission. Any
executable, script, or configuration file that participates in taking
the hash or dispatching the leaf MUST be included in the tamper-surface
that produces the baseline.

The historical requirement about *when* the hash is taken relative to
the artifact's lifecycle (before the user can substitute bytes, before
the artifact is served, from within a Save handler that reads the bytes
it just wrote) is subsumed by this property: the code that takes the
hash is measured by the baseline, so timing behavior is measurable, not
merely asserted.

### P3 — API key custody

The Scruple tenant API key MUST be held by the platform. End users
MUST NOT possess, view, or transmit the key. The key material (or its
handle in a secret manager) MUST be part of the tamper-surface the
baseline covers.

**Acceptable:**
- Platform's server-side secret manager (AWS Secrets Manager, Azure
  Key Vault, GCP Secret Manager, HashiCorp Vault, OCI Vault)
- Attested-client OS-keychain storage where the keystore prevents
  extraction by non-signing processes

**Unacceptable:**
- API key embedded in client-side JavaScript, mobile app bundle, or
  any bytecode the user can dump
- API key distributed to end users via email, configuration file, or
  environment variable in a user-controlled shell
- Shared "team" API key extractable by any end user from an admin
  console

### P4 — Principal identity

The `principal_id` field on every witness call MUST be derived from
authenticated session state on the platform, MUST NOT be a value the
end user can supply or modify in the request, and MUST be stable
across sessions for the same end user.

If the platform allows end users to see or change their own principal
identifier for their own purposes, the platform MUST cryptographically
bind the principal identifier to authenticated identity at witness
time (e.g. the platform signs the principal ID using its own key
before including it in the witness payload).

### P5 — Immutable event chain

Once a witness leaf is submitted and acknowledged, the platform MUST
NOT attempt to alter or delete prior leaves for the same project or
stream.

- Retractions MUST be modeled as new witness events ("event X was
  retracted at time Y for reason Z"), not as deletions.
- Late-arriving events MUST be witnessed with both the actual event
  time and the actual server-received time; never backdated.
- If a platform bug causes an incorrect leaf to be submitted, the
  correction MUST be a new leaf that references and supersedes the
  incorrect one. The incorrect leaf remains in the audit chain.

### P6 — Zero-content posture

Payload bytes — prompts, images, model weights, source files, PII —
MUST NOT be transmitted to Scruple. Only cryptographic hashes, small
structured metadata (counts, timestamps, tags), and identifiers.

The Scruple ingest schema rejects payload-bytes-shaped fields with a
4xx response. Integrations MUST NOT attempt to work around this by
encoding content into permitted fields (e.g. base64 in a metadata
string, JSON containing raw bytes). Doing so is a failure of P6
regardless of whether a specific attempt evades schema validation.

Integrations that must preserve full-resolution evidence bundles MUST
preserve them in the customer's own storage (WORM bucket, evidence
locker) and submit only the hash-commitment leaf to Scruple.

### P7 — Attestation declaration

If the platform's compute environment provides hardware attestation
(AMD SEV-SNP, Intel TDX, AWS Nitro Enclave, Google Confidential Space,
TPM 2.0 Quote, NVIDIA H100 confidential mode, or similar), the baseline
manifest MUST declare an `attestation.provider` value naming the
attestation type. A stable reference to the attestation (or the
attestation itself) MUST be included with the baseline and refreshed on
each re-baseline. The mechanics of per-event attestation import are
governed by P8.

If the platform's compute environment does not provide hardware
attestation, the baseline manifest declares `attestation.provider: none`
and P8 is not applicable. The integration is still Scruple-witnessed on
the strength of Scruple's own substrate attestation, provided all other
properties hold. Whether the customer requires their own compute
attestation is a scope question for their specific evidence claim, not
a compliance criterion.

### P8 — Attestation import discipline

If P7 declares an `attestation.provider` other than `none`, every leaf
MUST carry a `platform_attestation` envelope conforming to the shape
defined in §4. The envelope MUST satisfy the following:

- The `nonce` field MUST equal SHA-256 of the leaf preimage (excluding
  the `platform_attestation` envelope itself). This binds the attestation
  to the specific event; a stale or replayed attestation will not verify.
- The `attestation_time` MUST be within the tenant's configured
  freshness window. The default maximum is fifteen minutes at the time
  of leaf submission; tenants MAY configure shorter windows for stricter
  postures.
- For `attestation_type` values Scruple maintains a built-in verifier
  for (AMD SEV-SNP, Intel TDX, AWS Nitro Enclave, NVIDIA H100
  confidential mode, Azure Attestation Service, TPM 2.0), the attestation
  MUST verify server-side at ingest. Leaves whose attestation fails
  verification are rejected with a 4xx and do not enter the log.
- For `attestation_type` values Scruple does not verify natively (uncommon
  or emerging formats), the integration MUST supply a `verifier_reference`
  URL naming an independent verifier the customer trusts. The envelope
  is anchored as-is; the resulting receipt is labeled **Passthrough
  attestation**, distinct from Scruple-verified.

The integration SHOULD fetch a fresh attestation per witness call.
Cached attestations MAY be reused within the tenant's freshness window.
When the window expires, the next witness call MUST re-fetch.

Baselines MUST NOT mix `attestation.provider` values across a single
integration's leaves. If the compute environment changes (e.g., customer
migrates from AMD SEV-SNP compute to NVIDIA H100 confidential), the
integration MUST re-baseline with the new provider before submitting
leaves under it.

## 3. HMAC vs signature — what each does

The audit log uses two distinct cryptographic mechanisms; integrators
must understand which is which so receipts are interpreted correctly.

**Per-leaf HMAC.** Every leaf carries an HMAC computed with a per-tenant
symmetric key at the moment of ingest by the witness server. Purpose:
ingest-time integrity — the leaf as accepted into the log matches the
leaf as submitted, and cannot be silently modified within the log by
Scruple's own operators. HMAC is not attestation; it is a fast
tamper-detection primitive.

**Per-checkpoint CVM signature.** Periodically (configurable per stream),
Scruple's witness computes a Merkle root over the leaves accumulated
since the last checkpoint and signs it with the attested key held inside
the Confidential Virtual Machine. Purpose: **the terminal integrity
attestation.** This is the "signing moment" referenced in the Standard's
Phase 2 — the instant the set of leaves in the checkpoint becomes
cryptographically finalized under an operator-independent signer.

Baselines and workflow events are both leaves. A baseline's terminal
attestation comes from the same mechanism: the baseline leaf enters the
audit log with an HMAC at ingest, then becomes cryptographically final
when the CVM signs the checkpoint that includes it.

Verification order for a receipt:
1. Recompute the leaf hash and validate its HMAC.
2. Walk the Merkle path from the leaf hash up to the checkpoint's
   Merkle root.
3. Validate the CVM signature on the checkpoint root.
4. Validate the CVM signer's attestation chain to the platform vendor's
   hardware root of trust.
5. If a Phase-3 anchor is claimed (chain-lock, IPFS pin, Arweave
   record), verify the anchor's presence on the referenced ledger.

Steps 1–4 establish integrity. Step 5 establishes discoverability;
its failure does not compromise integrity.

## 4. Attestation import — the envelope and the protocol split

Where §15 of the Standard defines the capability (two-chain receipt
architecture, verified vs. passthrough distinction, freshness
deferral), this section defines the mechanics an integration must
implement to satisfy P7 and P8.

### 4.1 The envelope

Every attestation submitted with a leaf uses the normalized envelope:

```json
{
  "attestation_type": "nvidia-h100-cc" | "amd-sev-snp" | "intel-tdx"
                    | "aws-nitro-enclave" | "gcp-confidential-space"
                    | "azure-attestation-service" | "tpm-2.0-quote"
                    | "<other; requires verifier_reference>",
  "attestation_report": "<base64 raw bytes or JWT>",
  "certificate_chain": ["<pem1>", "<pem2>", ...],
  "nonce": "<hex; MUST equal SHA-256 of the leaf preimage>",
  "attestation_time": "<RFC 3339>",
  "verifier_reference": "<optional URL; required if attestation_type
                          is not natively supported by Scruple>"
}
```

The envelope is the same shape at baseline time (submitted with the
baseline manifest) and at witness time (submitted with each leaf). The
nonce binding differs: at baseline time the nonce binds the baseline's
signing-key SPKI hash; at witness time it binds the leaf preimage.

### 4.2 Protocol split — where each side lives

The attestation import protocol has three implementation surfaces.
Integrators need only implement the first; the other two are Scruple's
responsibility and shipped for downstream use.

**SDK (customer-side, integrator implements against):**

- Per-vendor fetcher modules:
  `scruple.attestation.nvidia_h100_cc.fetch(nonce)`,
  `scruple.attestation.amd_sev_snp.fetch(nonce)`,
  `scruple.attestation.aws_nitro.fetch(nonce)`,
  `scruple.attestation.azure_maa.fetch(nonce)`,
  `scruple.attestation.tpm_2.fetch(pcrs, nonce)`, etc.
- Each fetcher wraps the platform vendor's native attestation API and
  returns a valid envelope.
- Auto-inclusion: the SDK includes the envelope on every witness call
  when the baseline declares an `attestation.provider` other than `none`.
- Envelope validation before send: schema check, freshness check
  against configured window.

**API (Scruple server-side, integrators consume as a service):**

- Verifies the envelope at ingest by dispatching to a plugin selected
  by `attestation_type`.
- For built-in types, chains the report to the vendor's public root,
  confirms `nonce` matches SHA-256 of the received leaf preimage,
  confirms `attestation_time` is within freshness window.
- For passthrough types (attestation_type not natively supported),
  stores the envelope as-is with the `verifier_reference`; does not
  itself verify.
- Records verification status in the leaf's audit record.
- Rejects invalid attestations with 4xx (rejected leaves do not
  enter the log).

**Reference verifier CLI (`scruple-verify`, third-party operable):**

- Ships the same verifier plugin code the API uses, so anyone can
  independently re-verify a receipt's attestations without calling
  Scruple's API. This is what makes a Scruple-verified attestation
  truly self-authenticating; a receipt consumer with the CLI does not
  have to trust Scruple's word that the verification passed.

### 4.3 Verified vs. passthrough — integrator-facing implications

The Standard requires (§15.4) that a passthrough attestation MUST NOT
present identically to a Scruple-verified attestation on the receipt.
The integrator's responsibility is only to correctly declare the
`attestation_type` and to supply a `verifier_reference` when the type
is not Scruple-verified. The receipt's visual distinction is Scruple's
responsibility, not the integrator's.

Integrators SHOULD NOT declare a well-known `attestation_type` for
attestations they know Scruple's built-in verifier will reject. Doing
so wastes ingest calls; using a passthrough envelope with a
`verifier_reference` is the correct path for unusual formats.

### 4.4 Freshness windows — per-tenant configuration

The Standard §15.5 defers freshness windows to this document. The
current normative values:

- **Default maximum:** 15 minutes at leaf-submission time.
- **Tenant-configurable minimum:** as short as 60 seconds. Shorter
  windows narrow the replay surface at the cost of higher fetch
  rates against the platform's attestation subsystem.
- **Cache scope:** attestations MAY be cached within the window and
  reused across leaves whose preimages produce the same nonce (i.e.,
  they don't — each leaf has a unique preimage, so caching only
  helps if the same leaf is retried).
- **Long-lived integrations that don't produce leaves frequently
  SHOULD** schedule proactive attestation refreshes so a fresh
  attestation is always available on demand.

An attestation older than the tenant's freshness window at
leaf-submission time is rejected at ingest. The integration MUST
re-fetch.

## 5. Rejection criteria — concrete anti-patterns

These patterns are explicit failures. They exist as worked examples so
integration teams do not replicate them.

- **Browser POSTs directly to Scruple.** Client JavaScript holds the
  API key and calls the witness endpoint from the user's browser.
  Fails P1 and P3. The user can inspect the request, extract the key,
  and forge witness calls for any content they choose.
- **Optional integration node.** A ComfyUI custom node or similar
  plugin the user installs and can uninstall at will, wired to fire
  witness calls only when present. Fails P1. A user who wishes to
  produce unwitnessed content trivially disables the node. This
  pattern is unacceptable regardless of user-facing warnings against
  disabling it.
- **User-supplied output hash.** The platform accepts a hash from the
  user's client and forwards it as the witness leaf's `content_hash`.
  Fails P2. The user can supply the hash of whatever bytes flatter
  their claim, not the bytes they actually produced.
- **User-controlled principal.** The platform allows the end user to
  set their own principal identifier as a request parameter and passes
  it through unchanged. Fails P4. Two users can trade principal
  identifiers and impersonate each other in the audit chain.
- **Silent-drop of failed witness calls.** The integration catches
  witness-API errors and continues without a leaf, without recording
  the failure. Fails P5. The event that was supposed to be witnessed
  has no representation in the chain and no gap marker. Failed
  witness calls MUST be retried with backoff and, if permanently
  failing, surfaced as an operational alarm — never silently
  discarded.
- **Content in the metadata.** Base64-encoded image bytes stuffed
  into a `meta.description` field to "keep everything together."
  Fails P6.
- **Development attestation in production.** A P7-declaring integration
  that ships with a mock attestation report generated at build time
  rather than a live report from a real trusted-execution environment.
  Fails P7. The attestation must be a live report from the actual
  running compute, or P7 does not apply.
- **Baseline exclusions.** A baseline computed over a subset of the
  tamper-surface (e.g. the SDK binary but not the wrapping middleware
  that mutates the leaf between capture and POST). Fails P2. The
  baseline must cover the complete path.
- **Unwitnessed re-baseline.** The integration is modified in
  production and a new baseline is not submitted. The running
  integration no longer matches the witnessed baseline. Verification
  fails; the integration is not Scruple-witnessed until re-baseline
  is completed.
- **Stale attestation reuse beyond the freshness window.** The
  integration reuses an attestation captured hours or days ago rather
  than fetching a fresh one within the tenant's configured window.
  Fails P8. Server rejects at ingest.
- **Nonce not bound to leaf.** The integration supplies a
  `platform_attestation` envelope whose `nonce` is arbitrary (random
  UUID, timestamp, unrelated hash) instead of SHA-256 of the leaf
  preimage. Fails P8. Server rejects at ingest.
- **Passthrough attestation with no `verifier_reference`.** The
  integration declares an `attestation_type` Scruple does not natively
  verify but does not supply a `verifier_reference`. Fails P8. Server
  rejects at ingest.
- **Mixed attestation providers within a baseline.** The baseline
  declares `attestation.provider: nvidia-h100-cc` but individual leaves
  attempt to import AWS Nitro attestations for a different attestation
  surface. Fails P7 (baseline declares one provider). Server rejects at
  ingest. Re-baseline is required to change providers.
- **Declaring a well-known `attestation_type` for an attestation
  Scruple will reject.** The integration knows a report is malformed
  or from a broken driver but submits it under a well-known type,
  hoping Scruple's verifier will pass it. Fails P8. Server rejects.
  The correct path for known-broken or non-standard attestations is
  passthrough with `verifier_reference`, not misdeclaration.

## 6. Retrofit checklist

For teams designing a new integration or auditing an existing one,
work through this gate. If any answer is "no," the baseline will not
be sound and the integration will not be Scruple-witnessed.

**Boundary and coverage**
- [ ] Is the code that hashes and submits the leaf running in a
      runtime boundary the end user cannot modify?
- [ ] Does the baseline cover the complete capture-path code, from
      event trigger through hash to POST?
- [ ] Is the API key held server-side or in an attested-client
      keystore, and is its handle covered by the baseline?

**Identity**
- [ ] Does the principal ID on every call derive from authenticated
      session state, not from a user-supplied parameter?

**Chain integrity**
- [ ] Are historical leaves treated as immutable? Retractions modeled
      as new events?
- [ ] Are failed witness calls retried with backoff, and if
      permanently failed, surfaced as alarms rather than silently
      dropped?

**Content posture**
- [ ] Does the integration send only hashes and small structured
      metadata? No payload bytes anywhere in the request tree?

**Attestation**
- [ ] If the compute environment provides hardware attestation, is
      the report (or a stable reference to it) included with the
      baseline and refreshed on each re-baseline?

**Baseline lifecycle**
- [ ] Is the integration prepared to re-baseline (and submit that
      re-baseline as a first-class witness event) on any change to
      the tamper-surface?

**Attestation import** *(only if `attestation.provider != none`)*
- [ ] Does the SDK fetch a fresh attestation on every witness call, or
      only reuse cached attestations within the tenant's freshness
      window?
- [ ] Is the `nonce` field of every `platform_attestation` envelope
      set to SHA-256 of the leaf preimage (excluding the envelope
      itself)?
- [ ] Is `attestation_time` reliably within the tenant's configured
      freshness window at the moment of leaf submission?
- [ ] For `attestation_type` values Scruple does not natively verify,
      is a valid `verifier_reference` URL supplied?
- [ ] Is the baseline's declared `attestation.provider` consistent
      with the attestation type submitted on every leaf?

## 7. Getting to a valid baseline

Two paths lead to a valid baseline. Both are legitimate; the choice is
a matter of team capacity and preferred engagement model.

### 7.1 Self-implementation

The customer's team designs and implements the integration to meet the
seven properties, computes a candidate baseline, and submits it to
Scruple for provisioning. Scruple's provisioning process attempts to
verify the baseline against the customer's declared tamper-surface. If
verification succeeds, the integration is provisioned; if it fails, the
specific failure is reported and the customer iterates.

Self-implementation suits teams with strong platform-security
discipline and internal review capacity.

Note: what Scruple performs at this stage is baseline verification, not
a compliance-tier grade. There is no form Scruple reviews and countersigns.
The result is binary: your baseline verifies, or it does not.

### 7.2 Scruple-assisted design

Scruple engineers work with the customer's team to design the
integration against the properties. Deliverables typically include:

- Capture-path map for the customer's specific pipeline
- Reference implementations for each capture point in the customer's
  primary languages
- Review of the completed integration against the properties
- Assistance provisioning the baseline

This path is a paid engagement scoped at contract signing. It is
standard practice for teams new to provenance-system integration. The
paid engagement is help implementing correctly; the "certification"
outcome is the same as self-implementation — the baseline verifies, or
it does not.

## 8. Re-baseline discipline

A re-baseline MUST be submitted when the tamper-surface changes
materially. Material changes include:

- Any change to the code covered by P1 or P2
- Any change to how the API key is stored or accessed (P3)
- Any change to principal-ID derivation (P4)
- Any change to the compute environment that alters the attestation
  measurement (P7)
- Any change to the ingest-payload construction (fields sent, envelope
  structure)

Non-material changes that do NOT require re-baseline include:
- Rotation of the tenant's API-key value within the same key-handling
  code path (the code that touches the key hasn't changed)
- Configuration values that are read into an existing code path
  (e.g., a rate-limit setting) without changing the code itself
- Log verbosity, metrics endpoints, and other observability changes
  outside the capture path

If in doubt, submit a re-baseline. Re-baselining is a first-class
public event; over-baselining produces noise but no compromise.
Under-baselining silently invalidates the integration.

## 9. Change discipline for this document

This document is versioned. Material changes to property definitions,
new anti-patterns, or new checklist items constitute minor version
bumps (v1.2, v1.3). Changes that require existing integrations to
re-implement to remain valid constitute major version bumps (v2.0)
and are announced with a defined transition window.

The current version's canonical location is this document.

## Appendix A — Vocabulary

- **Baseline** — a signed hash covering an integration's tamper-surface
  at a point in time.
- **Tamper-surface** — the union of code, configuration, key handles,
  and (when P7 applies) attestation coverage that determines what a
  witness leaf actually attests to.
- **Property** (P1–P7) — a baseline-soundness requirement in this
  document. Not a compliance tier.
- **Leaf** — one record in the audit log. Both workflow events and
  baseline events are leaves.
- **HMAC** — per-leaf ingest-integrity primitive. Not attestation.
- **Signature (CVM)** — per-checkpoint terminal attestation. The
  "signing moment" of the Standard's Phase 2.
- **Re-baseline** — a signed leaf recording that the tamper-surface
  has materially changed, linked by hash to the prior baseline.
- **Principal** — the end user or entity on whose behalf a witness
  call is made.
- **Tenant** — the customer organization that holds the Scruple API
  key and operates the integration.

## Change log

- **2026-07-13, v1.2** —
  - Property count expanded from seven to eight to accommodate
    attestation import.
  - **P7 reshaped as "Attestation declaration"** — the baseline-side
    presence/absence question and the requirement to include
    attestation with the baseline. Existing "not applicable if no
    hardware attestation" language preserved.
  - **P8 added — "Attestation import discipline"** — the per-leaf
    envelope requirements: nonce = SHA-256(leaf preimage), freshness
    window compliance, server-side verification for built-in types,
    passthrough with `verifier_reference` for uncommon types, no
    mixing providers within a baseline.
  - **New §4 — "Attestation import — the envelope and the protocol
    split"** covers: the envelope shape (aligned with §15 of the
    Standard); the three implementation surfaces (SDK fetches only;
    API verifies authoritatively; reference verifier CLI ships the
    same plugin code for independent re-verification); verified vs.
    passthrough integrator obligations; and freshness window operational
    ceilings (15-minute default max, 60-second configurable minimum).
  - Renumbered existing sections §4–§8 to §5–§9.
  - Rejection criteria: added five new anti-patterns for attestation
    import (stale reuse, nonce not bound, passthrough without
    verifier_reference, mixed providers within baseline, misdeclared
    well-known type).
  - Retrofit checklist: added attestation-import section, applicable
    only when the baseline declares a non-`none` attestation provider.
- **2026-07-13, v1.1** —
  - Split out of the previous v1.0 Scruple Standard. This document
    now holds implementation requirements; the Standard document
    holds the capability register.
  - Seven rules reframed as *baseline-soundness properties*
    (P1–P7), not compliance tiers.
  - P2 rewritten as "baseline coverage of the capture path" — the
    prior capture-point-discipline framing folded into code
    integrity per the Standard's principle that measuring the code
    subsumes asserting the capture point.
  - P7 clarified as conditional (applies only when compute provides
    hardware attestation), consistent with the Standard's binary
    compliance model.
  - Added: HMAC vs CVM-signature reconciliation section, making
    explicit the roles of per-leaf ingest integrity and
    per-checkpoint terminal attestation.
  - Added: re-baseline discipline section defining what constitutes
    a material change.
  - Added: baseline-exclusions and unwitnessed-re-baseline
    anti-patterns.
  - Removed: "Standard / Attested / Certified" compliance tiers.
    Compliance is binary per the Standard.
  - Removed: "revocation" section — obsolete under baseline
    verification (verification succeeds or fails at query time; no
    revocation registry needed).
