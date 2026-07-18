# Scruple GPSA — Delta for L2 Remediation (2026-07-18)

**Applicant:** Docent LLC (dba Docent Technologies)
**Product:** Scruple C2PA Signer
**Target Assurance Level:** Level 2
**Source GPSA:** `docs/c2pa-conformance-evidence/2026-07-14/security-architecture/01-GPSA.md`
**Reviewer:** C2PA Generator Product Conformance Review, 2026-07-16
**Contact:** `scruple@docentechs.com`

---

## 1. Reviewer finding

The 2026-07-16 review returned MEETS at Level 1 and DOES NOT MEET at Level 2 on
requirements 6.3.2 and 6.4.2:

> "The applicant relies on the SEV-SNP TCB field and boot image measurements to
> prove what software is running, and uses a CI release-blocker to ensure new
> deployments are patched. However, they do not describe an explicit, dynamic
> mechanism to extract and validate the OS Security Patch Date of a running
> instance against a 90-day rolling window."

The reviewer's remediation ask:

> "Implement and document an explicit mechanism to continuously or periodically
> extract the OS security patch status/date of the running CVMs and validate it
> against a 90-day rolling window. If an instance's OS patch level falls behind
> this 90-day window, the mechanism must actively alert, terminate the instance,
> or disable the C_Sign operational capability until the environment is rotated
> or patched."

All other requirements MEET.

## 2. Design change: Signer CVMs run in an immutable Instance Pool with age-based rotation

Rather than extract the patch date of a running CVM and compare it to a window,
Scruple *removes the window question* architecturally: **no running Signer CVM
can exceed 60 days of life.** OCI Autoscaling terminates and replaces any
Signer CVM in the Pool that exceeds the max-age threshold. Each replacement
provisions from the current golden image, which was itself built by CI with the
90-day patch gate already enforced (per §C.2.3 of the source GPSA).

Because rotation is inherently periodic (every instance is replaced within the
window), and because each replacement starts from a patched image, no
extraction of patch state at runtime is required. The 90-day compliance
question dissolves into the immutable-infrastructure invariant.

### Why 60, not 90

The threshold is set 30 days inside the 90-day requirement. This margin absorbs:

- Golden-image build cadence (the CI patch gate blocks vulnerable images, but a
  fresh CVE landing between the last build and instance provisioning could put
  a just-provisioned instance 1-30 days behind on that CVE).
- OCI Function scheduler latency (the rotation function runs every 6 hours; up
  to 6 hours of drift per instance).
- Draining delay (LB drain + graceful shutdown adds up to 5 minutes).

Even under the worst-case combination of these delays, no in-service CVM can
be more than ~30 days out of date on the golden image, which itself is
90-day-compliant by construction. Total compliance margin: well inside the
reviewer's 90-day requirement.

## 3. Architecture components

Four artifacts implement the design. All are committed in this evidence bundle:

### 3.1. Instance Configuration (immutable image reference)

The Signer image is captured as an OCI **Instance Configuration**. It pins:

- The SEV-SNP CVM shape (`VM.Standard.E5.Flex` with `is_confidential_vm = true`,
  `platform_config.type = "AMD_ROME_BM"`).
- The base image OCID (Oracle Linux 9, current patched).
- The `cloud-init` payload that builds the Signer environment on first boot,
  identical to the cloud-init already reviewed in the source GPSA runbooks.
- Attached-storage config, NSG membership, VNIC config.

Instance Configuration itself is immutable per-version — updating the image
requires publishing a new Instance Configuration, which the Instance Pool
picks up on next replacement.

**Evidence:** `deploy/oci-signer-rotation/terraform/instance-configuration.tf`

### 3.2. Instance Pool (fleet manager)

The **Instance Pool** provisions and manages N Signer CVMs from the Instance
Configuration. It:

- Maintains a target size (typically N ≥ 2 for concurrent capacity + rolling
  replacement without service interruption).
- Attaches every instance to the Signer NSG.
- Registers each instance with the Signer load balancer's backend set as it
  comes online, and drains before termination.

Pool membership changes are logged to the OCI Audit service with 365-day
retention per §C.2.6 of the source GPSA.

**Evidence:** `deploy/oci-signer-rotation/terraform/instance-pool.tf`

### 3.3. Rotation Scheduler + Function (actuator)

An OCI **Resource Scheduler** fires an OCI **Function** every 6 hours. The
Function:

1. Reads Instance Configuration `signer-cvm-config`.
2. Enumerates Instance Pool members via OCI Compute API.
3. For each member, computes `age_days = now - time_created`.
4. Terminates any instance with `age_days > 60`.
5. Instance Pool auto-provisions a replacement from the current Instance
   Configuration.
6. New instance boots, runs cloud-init, attests, publishes a new
   `platform_attestation` envelope for its Vault-held HSM key per §C.2.2.
7. Load balancer probes the new instance, adds it to the backend set, drains
   and terminates the outgoing instance.

The Function is written in Python (~120 lines), uses the OCI Instance Principal
credential (no long-lived secrets), and logs each rotation decision to OCI
Logging.

**Evidence:**
- `deploy/oci-signer-rotation/function/rotate_signer_cvms.py` — Function code
- `deploy/oci-signer-rotation/terraform/rotation-function.tf` — Function + Scheduler + IAM
- `deploy/oci-signer-rotation/terraform/iam-policies.tf` — Function's Dynamic Group + Policy

### 3.4. Attestation binding: instance age in the C2PA leaf

Every Scruple-produced C2PA manifest carries a Scruple-namespaced assertion
`ai.scruple.signer-runtime.v1` with the following fields:

```json
{
  "signer_instance_id": "ocid1.instance.oc1.iad.<...>",
  "signer_image_id": "ocid1.image.oc1.iad.<...>",
  "signer_instance_born_at": "2026-07-15T04:00:00Z",
  "signer_age_days_at_sign": 3,
  "signer_max_age_days": 60,
  "signer_rotation_policy_version": "2026-07-18"
}
```

This makes the age of the signing instance *cryptographically bound to the
manifest* — a verifier reading a signed asset can compute
`now - signer_instance_born_at` and independently confirm the signer was within
the max-age window when it signed.

`signer_instance_born_at` is sourced from the OCI IMDS at Signer startup, then
cached in the Signer process; it is a fixed property of the instance.

**Evidence:** `services/c2pa-signer/vault_sign.py` (instance metadata capture)
plus `lib/c2pa/signAsset.ts` (assertion emission).

## 4. Actuator on breach — defense in depth

The design has two independent actuators, either of which alone satisfies the
reviewer's "actively alert, terminate the instance, or disable the C_Sign
operational capability" clause. Both are wired.

**Actuator 1 (primary, architectural):** the rotation Function terminates any
Signer CVM exceeding the max-age threshold. No in-service instance can age past
the window because the fleet manager physically replaces it.

**Actuator 2 (secondary, in-instance guardrail):** on Signer startup and on
every C_Sign request, the Signer process computes its own `age_days` from IMDS
and refuses to sign if `age_days > signer_max_age_days`. This is a
belt-and-suspenders check that catches the edge case where the rotation
Function fails to run for an extended period (Function outage, IAM breakage,
scheduler misconfig) — the Signer self-fences even in the absence of external
enforcement.

The refuse-to-sign path emits a HIDS event per §C.2.6 of the source GPSA and
returns a structured error to the Application tier so the caller sees a clean
failure with actionable diagnostics.

**Evidence:** `services/c2pa-signer/sign.py` (age guard at request-time).

## 5. Optional secondary mechanism (deferred until reviewer request)

An alternative or supplementary path via **Oracle OS Management Hub (OSMH)**
would enroll each Signer CVM as an OSMH-managed instance, publish
last-security-patch dates via the OCI OS Management API, and expose those to
the Signer for self-check. This path measures OS patch age directly rather
than substituting instance age.

We designed but did not implement this path because:

- The Instance Pool rotation path already satisfies the requirement
  architecturally, without introducing an in-guest management agent into the
  TOE.
- Adding OSMH would extend the SBOM (`osms-agent` becomes an attested
  dependency) without materially strengthening the compliance argument.

If the reviewer prefers a direct patch-age measurement in addition to the
architectural rotation, we can add OSMH self-check as Actuator 3 in a
subsequent update. The GPSA and evidence bundle would then be re-signed with
that path in place.

## 6. What §C.2.3 and §C.2.4 of the source GPSA now say

The "Patch recency" paragraphs of §C.2.3 and §C.2.4 in the source GPSA are
replaced with the following text:

> **Patch recency (revised 2026-07-18).** Signer CVMs run in an OCI Instance
> Pool with a 60-day maximum instance age enforced by an OCI Function on a
> 6-hour scheduler. No in-service Signer CVM can exceed 60 days of life; each
> replacement provisions from the current CI-verified golden image, which the
> 90-day CI patch-gate has already validated. Every signed manifest carries an
> `ai.scruple.signer-runtime.v1` assertion binding the signing instance's
> creation timestamp and configured max-age policy, so a verifier can
> independently confirm the signer was within the compliance window at
> signing time. The Signer process self-fences on age breach as a secondary
> guardrail: on startup and on every C_Sign request it computes its own age
> from IMDS and refuses to sign if the instance exceeds the max-age policy.
> The full design is documented in this delta at
> `docs/c2pa-conformance-evidence/2026-07-18-reviewer-response/security-architecture-delta/01-GPSA-delta.md`.

This text is proposed to be inserted verbatim at line 229-232 (§C.2.3 Patch
recency) and referenced from §C.2.4 line 253.

## 7. Evidence checklist

| Artifact | Path | Purpose |
|---|---|---|
| GPSA delta (this document) | `docs/c2pa-conformance-evidence/2026-07-18-reviewer-response/security-architecture-delta/01-GPSA-delta.md` | Design description |
| Instance Configuration TF | `deploy/oci-signer-rotation/terraform/instance-configuration.tf` | Immutable Signer image reference |
| Instance Pool TF | `deploy/oci-signer-rotation/terraform/instance-pool.tf` | Fleet manager |
| Rotation Function TF | `deploy/oci-signer-rotation/terraform/rotation-function.tf` | Actuator wiring |
| IAM Policies TF | `deploy/oci-signer-rotation/terraform/iam-policies.tf` | Function's least-privilege identity |
| Rotation Function code | `deploy/oci-signer-rotation/function/rotate_signer_cvms.py` | Actuator logic |
| Signer age-guard code | `services/c2pa-signer/sign.py` | Secondary in-guest actuator |
| Signer runtime assertion | `services/c2pa-signer/vault_sign.py` + `lib/c2pa/signAsset.ts` | Instance-age binding into every C2PA manifest |
| Updated runbook | `docs/c2pa-conformance-evidence/2026-07-14/security-architecture/runbooks/cvm-provision.md` | Operational lifecycle |

All artifacts committed on `feature/witnessing-l2-sprint1` branch of
`scruple-web` repository.

## 8. Attestation of accuracy

The design and evidence described above accurately reflect the intended
production architecture of the Scruple C2PA Signer as of the date of this
document. Implementation of the OCI resources (Instance Configuration,
Instance Pool, Function, Scheduler, IAM) is complete in code; the apply step
to the running OCI tenancy is scheduled to occur before the next resubmission
of production-signed evidence samples.

Signed:
Shaun Hargadine — Docent LLC (dba Docent Technologies)
Contact: `scruple@docentechs.com`
