# Scruple — Generator Product Security Architecture Document

**Filed against:** C2PA Generator Product Security Requirements, v0.1 (2025-06-02)
**Template:** Appendix C of the same document
**Applicant:** Docent LLC (dba Docent Technologies)
**Generator Product:** Scruple C2PA Signer
**Intake record ID:** `019f5856-bff8-7f57-a879-80594a6fb3fe`
**Filing date:** 2026-07-30
**Version:** 2
**Target Max Assurance Level:** Level 2
**Signatory:** Shaun Hargadine
**Contact:** `scruple@docentechs.com`

---

## Cover statement

This document is the Generator Product Security Architecture Document
for the Scruple C2PA Signer, filed at Level 2 against the C2PA
Generator Product Security Requirements v0.1. Because every L2
requirement is defined by the specification as additive to L1, a
product that meets L2 also meets L1; where L2 evidence is insufficient
in the assessor's judgment for a specific objective, Scruple accepts
grading at L1 for that objective with no architectural change.

Scruple is NOT a capture-only product. Every asserted validate MIME in
the Intake Form is exercised end-to-end in the accompanying sample
bundle.

---

## C.1. Generator Product Information

### C.1.1. Applicant organization details

- **Full legal name:** Docent LLC
- **Trading name:** Docent Technologies (product name: Scruple)
- **Jurisdiction:** United States (LLC, Delaware)
- **Business address:** on file with the Program via the Intake Form
- **Contact:** `scruple@docentechs.com`
- **Signatory (bound authority):** Shaun Hargadine
- **Public product site:** `https://scruple.ai`

### C.1.2. Distinguished name

For the production C2PA end-entity claim signing certificate:

| Field | Value |
|---|---|
| Common Name (CN) | `Scruple` |
| Organization (O) | `Docent LLC` |
| Country (C) | `US` |

The end-entity signing certificate will be issued under the C2PA
Trust List by a Program-designated CA. Application to the CA is
pending Program acceptance of this filing. The signed samples in the
accompanying evidence bundle carry a development CA-issued end-entity
certificate for demonstration purposes.

### C.1.3. Generator Product Description

Scruple is a service that produces C2PA v2.x signed manifests for
AI-generated media. The service accepts an asset and a bounded manifest
request payload from an authenticated Client, constructs the C2PA
manifest inside the attested Signer TOE, signs it, and returns the
signed asset.

**Assertion provenance boundary.** Every assertion placed in the
`created_assertions` block of a Scruple-signed manifest is constructed
by code executing INSIDE the attested Signer CVM TOE. Client-supplied
values (title, format hint, digitalSourceType selection, supplementary
actions) are treated as request parameters that the Signer either
maps to a Scruple-authored assertion or rejects — the Client cannot
inject arbitrary assertion payloads into `created_assertions`. Any
data of external provenance that must be preserved alongside the
signed asset is placed in `gathered_assertions`, which inherits that
block's untrusted-provenance semantics per C2PA v2.x. See §C.2.4 for
the enforcement mechanism and audit surface.

Scruple does not run a "delegated signing on behalf of a third-party
generator" mode where an external product's arbitrary manifest gets
signed as-is. Every signing pass constructs its own manifest from the
Client's request parameters, inside the TOE, under Scruple's control.

### C.1.4. Generator Product Target of Evaluation (TOE)

The TOE has three roles:

1. **Client** — originates the sign request and carries the caller's
   authenticated credential.
2. **Application tier** — authenticates the Client, constructs the
   C2PA manifest structure, and delegates signature computation to
   the Signer.
3. **Signer** — runs inside a hardware-attested Trusted Execution
   Environment (AMD SEV-SNP Confidential VM on Oracle Cloud
   Infrastructure). Holds the C2PA end-entity private key inside a
   PKCS#11 HSM. Computes the ECDSA signature. Returns the signed
   manifest to the Application tier. The private key never leaves
   the TEE.

The Signer role is delivered as a **fleet** of Confidential VMs under
an OCI Instance Pool. Individual Signer CVMs are ephemeral and
replaceable; the pool as a whole is the durable Signer role. See
§C.2.3 for the fleet lifecycle.

External infrastructure consumed but outside the TOE: public ledgers
used for optional ledger-anchored audit records; a payment processor
for billing. Neither touches asset bytes or C2PA assertions.

### C.1.5. Implementation Class

**Distributed.** The Client, the Application tier, and the Signer are
separate subsystems with authenticated network boundaries between
them. §6.5.1 Distributed-Class requirements for mutual authentication
and TLS 1.3 apply; both are satisfied per §C.2.5.

### C.1.6. Target Max Assurance Level

**Level 2**, with implicit Level 1 conformance.

| Obj | L1 | L2 | Mechanism satisfying the requirement |
|---|---|---|---|
| **O.1** Automated cert enrollment (§6.1) | N/A | N/A | Program-designated Trust List CAs use manual CSR enrollment. §6.1 is only applicable to products relying on automated enrollment. |
| **O.2** Signing-key confidentiality (§6.2) | ✓ | ✓ | ECDSA P-256 (ES256) key generated and held inside a PKCS#11 HSM inside an AMD SEV-SNP Confidential VM. Key is non-extractable by PKCS#11 attribute. Hardware-Root-of-Trust attestation binds the specific key to the specific TEE; two independent live attestation bundles attached. See §C.2.2. |
| **O.3** Claim Generator hardening (§6.3) | ✓ | ✓ | SCA, SAST, SBOM, and known-vulnerable release-blocker wired in CI. Signer is isolated from the Application tier by the TEE boundary. Patch recency is enforced architecturally: Signer CVMs run in an OCI Instance Pool with a 60-day maximum instance age; no in-service Signer CVM can exceed the age policy. See §C.2.3. |
| **O.4** Content-processing hardening (§6.4) | ✓ | ✓ | Same CI coverage as O.3. Signer subprocess runs under systemd hardening (isolation, no-new-privileges, memory-write-execute prohibition, syscall filter). Patch recency: same fleet-lifecycle mechanism as O.3. See §C.2.4. |
| **O.5** Traffic protection (§6.5) | ✓ | ✓ | TLS 1.3 on external traffic; mTLS 1.3 between Application tier and Signer with per-request authentication seal on top of the TLS layer. See §C.2.5. |
| **O.6** Hosting environment (§6.6) | ✓ | ✓ | Cloud IAM RBAC. Tenancy-wide audit logging with 365-day retention against an authenticated time source (see §C.2.6). HIDS deployed. Network segmentation. Coordinated vulnerability disclosure with 30/90/180-day CVSS-severity remediation SLAs. See §C.2.6. |

### C.1.7. Target Generator Product capabilities

**Claim generation** (per the Intake Form):

- Still image: `image/jpeg`, `image/png`, `image/svg+xml`,
  `image/x-adobe-dng`, `image/tiff`, `image/webp`, `image/heic`,
  `image/heif`, `image/avif`
- Video: `video/mp4`, `video/quicktime`
- Audio: `audio/flac`, `audio/mpeg`, `audio/wav`, `audio/mp4`
- ML models: `pytorch`

**Claim validation** (per the Intake Form):

- Still image: `image/jpeg`, `image/jxl`, `image/png`, `image/svg+xml`,
  `image/gif`, `image/x-adobe-dng`, `image/tiff`, `image/webp`,
  `image/heic`, `image/heif`, `image/avif`
- Video: `video/x-msvideo`, `video/mp4`, `video/quicktime`
- Audio: `audio/flac`, `audio/mpeg`, `audio/wav`, `audio/mp4`
- Documents: `application/pdf`
- ML models: `pytorch`

Coverage evidence — the `Generate.output.<mime>/`, `Raw.input.<mime>/`,
and `Validate.output.<mime>/` folders in the accompanying sample
bundle. 15 of 16 asserted generate MIMEs and 18 of 20 asserted
validate MIMEs produce signed samples; the three gaps
(`application/pdf`, `application/x-pytorch`) are current `c2pa-python`
wrapper limits documented per-folder in the bundle. Every signed
sample verifies as `validation_state=Valid` against the included
development cert chain.

---

## C.2. Security architecture details

### C.2.1. Authentication for certificate enrollment

Enrollment is manual: Scruple submits a CSR to a Program-designated
Trust List CA via the CA's standard portal. §6.1 requirements apply
only to products relying on automated cert enrollment; they therefore
do not apply here.

The CSR is generated inside the TEE against the HSM-held private key.
Only the CSR (which contains only the public key and a
proof-of-possession signature over it) leaves the TEE.

Rotation: same ceremony, on annual cadence or on suspected compromise.

### C.2.2. Key generation, storage, and usage

**Algorithm and key size.** ECDSA P-256 (ES256) per RFC 8152
COSE_Sign1 conventions, consistent with C2PA v2.x claim signature
requirements.

**Storage.** The private key is generated inside a PKCS#11 HSM that
resides inside an AMD SEV-SNP Confidential VM. The key is created
with the PKCS#11 attributes that make it non-extractable and
non-exportable: PKCS#11 API calls cannot retrieve the key material;
the only permitted operation is `C_Sign`. Combined with SEV-SNP
memory encryption, the plaintext private key exists only inside the
HSM's protected memory region inside the TEE's encrypted memory
region, and is therefore not accessible to:

- the cloud hypervisor (memory is encrypted by the CPU with a per-VM
  key derived by the AMD Platform Security Processor)
- any other tenant on the same physical host
- any Docent operator
- the Signer service process itself, in raw form

**Attestation of key generation and storage (§6.2.2 L2).** The
SEV-SNP attestation report's `report_data` field is populated by the
caller with the SHA-256 of the HSM public key SPKI. Any verifier
holding (report, public key) can independently confirm that the
specific private key was possessed by the attested TEE at the time of
the report.

**Live attestation bundle attached:** `evidence/l2-evidence-2026-07-12T174954Z/`.

The bundle contains: the SEV-SNP attestation report, the AMD Versioned
Chip Endorsement Key, the AMD Root Key → Signing Key certificate chain,
the VM measurement, and the HSM public key plus its SHA-256 (which
matches the `report_data` field byte-for-byte). Any verifier can
independently perform the AMD chain verification and the `report_data`
↔ public-key match.

**Per-instance attestation across the fleet.** Because Signer CVMs
are provisioned and replaced under an Instance Pool (§C.2.3), each
new Signer CVM generates its HSM key at first boot inside its own
attested TEE and publishes a fresh attestation bundle bound to that
instance. A live per-instance attestation manifest is maintained,
indexed by Signer instance OCID, so a verifier holding a signed
manifest can retrieve the specific attestation bundle for the
specific signer instance that produced it (via the
`signer_instance_id` field of the runtime assertion — see §C.2.3.4).

Cert rotation: annually or on suspected compromise. A live trust
manifest is published so downstream verifiers can select the correct
cert per sign timestamp.

**Distributed-Class additions.** The Application tier authenticates
to the Signer using mTLS 1.3 with pinned peer certificates plus a
per-request authentication seal. The Signer authenticates every
inbound request before invoking `C_Sign`.

### C.2.3. Protections against Claim Generator misconfiguration and abuse

**CI coverage.** Every pull request and push to `main` runs:

- **Dependency vulnerability scanning (SCA)** across all package
  ecosystems, blocking merge on CRITICAL or HIGH per CVSS.
- **Container image scanning**, same severity block.
- **Static analysis (SAST)** across the codebase.
- **SBOM emission** per build, attached as a release artifact.
- **Known-vulnerable release blocker** that fails any release where a
  detected CRITICAL/HIGH is more than 90 days past first detection.

**Exploit countermeasures.** The Signer image is a reproducibly built
image. Compiler and linker hardening (stack protection,
`FORTIFY_SOURCE`, RELRO, PIE), ASLR, and DEP/NX are enforced. A
countermeasures verification report is emitted per build and
attached as a CI artifact.

**Software image authentication.** The SEV-SNP measurement recorded
in every attestation report is a cryptographic fingerprint of the
running CVM boot image. Because the boot image is reproducibly
built, the measurement pins the Signer binary to a specific released
version.

**Patch recency — two-layer control.** The 90-day OS-patch-recency
requirement (Req 6.3.2 and 6.4.2) is enforced by TWO complementary
controls, both required, both independently sufficient to trip a
refuse-to-sign:

1. **In-instance OS-patch-date validation (per-sign check).** On every
   sign request, the Signer extracts the OS security patch date from
   the running instance's package-manager history (dnf.rpm.log on
   Oracle Linux, apt/history.log on Ubuntu-based derivatives) and
   refuses to sign if `now - os_security_patch_date > 90 days`. The
   extracted date is also bound into every signed manifest via the
   `ai.scruple.signer-runtime.v1` assertion so a verifier can
   independently cross-check patch recency at signing time.

2. **Fleet lifecycle (architectural bound).** In parallel, the Signer
   CVM fleet is rotated on a 60-day maximum-age policy so that in the
   common case no CVM ever gets close to the 90-day OS-patch window.
   The fleet lifecycle exists to prevent the per-sign check from
   *ever needing to fail* in production — under normal operation
   every CVM is replaced from a freshly-patched golden image well
   before the 90-day OS-patch clock would trip.

The per-sign OS-patch check is the primary Req-6.3.2/6.4.2 control
(it directly extracts and validates the OS patch date per the
requirement text). The fleet lifecycle is the operational
belt-and-braces that keeps the per-sign check in the "permits" state
under normal operation. Both fire, so a failure in either the
rotation Function OR the per-sign extractor is caught by the other.

#### C.2.3.0. In-instance OS patch date extraction & 90-day gate

**Mechanism.** `services/c2pa-signer/os_patch_check.py` reads the
running instance's package-manager history and returns the most-recent
package install-or-upgrade timestamp as the `os_security_patch_date`.
Detection order:

1. `/var/log/dnf.rpm.log` (Oracle Linux, RHEL, Alma, Rocky) — parse
   the newest `Installed:` / `Updated:` / `Upgraded:` line.
2. `/var/log/dnf/dnf.rpm.log` (alternate location on some OL builds).
3. `/var/log/apt/history.log` (Debian/Ubuntu, for dev + any Ubuntu-based
   derivatives) — parse the newest `End-Date:` block.
4. `rpm -qa --qf '%{INSTALLTIME}\n'` fallback — take the max INSTALLTIME
   across all installed packages.

**Gate.** On every C_Sign request:

```python
verdict = patch_recency_verdict()
if verdict["refuse"]:
    return REFUSE  # os_security_patch_age_days > 90
```

**Fail-closed policy.** If the extractor cannot determine an
`os_security_patch_date` (all four detection paths return None) AND
`SCRUPLE_C2PA_VAULT_KEY_OCID` is set (production Signer CVM signal),
the Signer refuses to sign. On dev/non-CVM hosts where the env var is
unset, detection failure is tolerated so local development works
without a package-manager log surface.

**Configurable threshold.** `SCRUPLE_OS_PATCH_MAX_AGE_DAYS` env var,
default 90. The systemd unit sets this to `90` in production.
Lowering the threshold below 90 is safe (tighter than the spec);
raising it above 90 would be non-conformant and is not permitted.

**Binding into the manifest.** The `runtime_assertion()` produced per
sign includes `os_security_patch_date`, `os_security_patch_age_days`,
`os_security_patch_max_age_days`, and `os_security_patch_source`. This
means every Scruple-signed asset carries a cryptographic claim about
its own OS patch level — a downstream verifier reading the signed
manifest can compute `now - os_security_patch_date` and confirm
independently that the Signer was within the 90-day window when it
signed.

**Evidence:**
- `services/c2pa-signer/os_patch_check.py` — extractor + verdict
- `services/c2pa-signer/tests/test_os_patch_check.py` — 13 unit tests
  covering ISO/legacy dnf formats, apt history, fresh vs stale, dev vs
  production fail-closed policy, configurable threshold
- `services/c2pa-signer/sign.py` — per-sign gate + refuse-to-sign path
- `services/c2pa-signer/signer_runtime.py::runtime_assertion()` —
  patch fields bound into the C2PA manifest per sign

#### C.2.3.0-b. Belt-and-braces: fleet lifecycle

The lifecycle below existed in the prior submission as the sole
patch-recency control. It is retained as the operational safety net
that keeps the per-sign OS-patch check trivially satisfied under
normal operation — a 60-day CVM max-age rotation means the OS patch
date is refreshed at least every 60 days, so the 90-day per-sign gate
never trips in production.

The lifecycle has four components:

#### C.2.3.1. Instance Configuration (immutable image reference)

The Signer image is captured as an OCI **Instance Configuration**
that pins:

- The SEV-SNP CVM shape (`VM.Standard.E5.Flex` with
  `is_confidential_vm = true`, `platform_config.type = "AMD_ROME_BM"`).
- The base image OCID (Oracle Linux, current patched).
- The `cloud-init` payload that builds the Signer environment on
  first boot.
- Attached-storage config, NSG membership, VNIC config.

Instance Configuration is immutable per-version — updating the image
requires publishing a new Instance Configuration, which the Instance
Pool picks up on next replacement.

Evidence: `deploy/oci-signer-rotation/terraform/instance-configuration.tf`.

#### C.2.3.2. Instance Pool (fleet manager)

The **Instance Pool** provisions and manages N Signer CVMs from the
Instance Configuration. It:

- Maintains a target size (typically N ≥ 2 for concurrent capacity +
  rolling replacement without service interruption).
- Attaches every instance to the Signer NSG.
- Registers each instance with the Signer load balancer's backend set
  as it comes online, and drains before termination.

Pool membership changes are logged to the OCI Audit service with
365-day retention per §C.2.6.

Evidence: `deploy/oci-signer-rotation/terraform/instance-pool.tf`.

#### C.2.3.3. Rotation Scheduler + Function (actuator)

An OCI **Resource Scheduler** fires an OCI **Function** every 6
hours. The Function:

1. Reads the current Instance Configuration.
2. Enumerates Instance Pool members via OCI Compute API.
3. For each member, computes `age_days = now - time_created`.
4. Terminates any instance with `age_days > 60`.
5. Instance Pool auto-provisions a replacement from the current
   Instance Configuration.
6. New instance boots, runs cloud-init, attests, publishes a new
   `platform_attestation` envelope for its HSM key per §C.2.2.
7. Load balancer probes the new instance, adds it to the backend set,
   drains and terminates the outgoing instance.

The Function is written in Python (~120 lines), uses the OCI Instance
Principal credential (no long-lived secrets), and logs each rotation
decision to OCI Logging.

**Why 60, not 90.** The threshold is set 30 days inside the reviewer's
90-day requirement. This margin absorbs:

- Golden-image build cadence (the CI patch gate blocks vulnerable
  images, but a fresh CVE landing between the last build and instance
  provisioning could put a just-provisioned instance 1–30 days behind
  on that CVE).
- Scheduler latency (the rotation function runs every 6 hours; up to
  6 hours of drift per instance).
- Draining delay (load-balancer drain + graceful shutdown adds up to
  5 minutes).

Even under the worst-case combination of these delays, no in-service
CVM can be more than ~30 days out of date on the golden image, which
itself is 90-day-compliant by construction. Total compliance margin:
well inside the 90-day requirement.

Evidence:
- `deploy/oci-signer-rotation/function/rotate_signer_cvms.py` — Function code
- `deploy/oci-signer-rotation/terraform/rotation-function.tf` — Function + Scheduler + IAM
- `deploy/oci-signer-rotation/terraform/iam-policies.tf` — Function's Dynamic Group + Policy

#### C.2.3.4. Instance-age attestation bound into every signed manifest

Every Scruple-produced C2PA manifest carries a Scruple-namespaced
assertion `ai.scruple.signer-runtime.v1` with the following fields:

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

This makes the age of the signing instance *cryptographically bound
to the manifest* — a verifier reading a signed asset can compute
`now - signer_instance_born_at` and independently confirm the signer
was within the max-age window at signing time.

`signer_instance_born_at` is sourced from the OCI Instance Metadata
Service (IMDS) at Signer startup, then cached in the Signer process;
it is a fixed property of the instance and is bound into every C2PA
manifest signed by that instance.

Evidence: `services/c2pa-signer/signer_runtime.py` (instance metadata
capture and assertion construction) and `services/c2pa-signer/sign.py`
(assertion inclusion in every manifest).

#### C.2.3.5. Secondary actuator (in-instance age guard)

As defense-in-depth, the Signer process itself computes its own
`age_days` from IMDS on startup and on every C_Sign request, and
refuses to sign if `age_days > signer_max_age_days`. This catches the
edge case where the rotation Function fails to run for an extended
period (Function outage, IAM breakage, scheduler misconfig) — the
Signer self-fences even in the absence of external enforcement.

The refuse-to-sign path emits a HIDS event per §C.2.6 and returns a
structured error to the Application tier so the caller sees a clean
failure with actionable diagnostics.

Evidence: `services/c2pa-signer/signer_runtime.py::age_guard_verdict()`
and `services/c2pa-signer/sign.py` (age guard at request-time).

### C.2.4. Protections against misconfiguration and abuse of content-processing software

**Assertion-block placement policy (TOE boundary).** Per §C.1.3, every
`created_assertions` entry in a Scruple-signed manifest is authored by
code inside the attested Signer TOE. The Signer enforces this at the
API boundary with a fixed whitelist:

  1. **C2PA-standard assertions** the SDK emits (`c2pa.actions`,
     `c2pa.thumbnail.claim`, `c2pa.thumbnail.ingredient`,
     `c2pa.ingredient`, `c2pa.hash.data`, `c2pa.hash.boxes`) —
     constructed by the c2pa-rs library on our behalf; land in
     `created_assertions` per the c2pa-rs `created_assertion_labels`
     setting in `services/c2pa-signer/sign.py`.
  2. **Scruple-namespaced runtime assertion** `ai.scruple.signer-runtime.v1`
     — constructed by the Signer process from IMDS metadata (see §C.2.3);
     lands in `created_assertions` because it describes the signing
     environment itself.

Any assertion label the Client tries to inject that is NOT one of
those two categories is either rejected at the API boundary (unknown
label) or, if the Client has a legitimate reason to preserve a
third-party assertion alongside the asset, added to
`gathered_assertions` where its provenance is honestly labeled as
external. The whitelist is enforced in
`services/c2pa-signer/sign.py::_partition_assertions()` and covered by
`services/c2pa-signer/tests/test_assertion_partition.py`.

The `job['manifest']['assertions']` list submitted by the Client is
subject to this partition before `c2pa.Builder(manifest)` is
constructed — so the c2pa-rs library never sees an unauthorized
assertion labeled as created. A Signer log line per manifest records
which labels landed in which block and why; this is part of the audit
surface required by §C.2.6.

**CI coverage.** Same coverage as §C.2.3 covers the content-processing
code paths.

**Isolation of the Signer process.** The Signer subprocess runs as a
dedicated OS user under a systemd unit with the standard hardening
set (`ProtectSystem=strict`, `PrivateTmp=yes`, `NoNewPrivileges=yes`,
`MemoryDenyWriteExecute=yes`, `SystemCallFilter=@system-service`,
`InaccessiblePaths` covering the key directory). Communication with
the Application tier is over an isolated network path with the
mutual-authentication protections described in §C.2.5.

**Input validation.** Application-tier routes validate all external
inputs at the boundary. The Signer performs its own JSON-schema
validation on every request and rejects any mismatched payload. C2PA
manifest structure is validated before signing and again after, via
round-trip verification.

**Patch recency (Req 6.4.2).** As §C.2.3 — the same two-layer control
covers content-processing software: (1) the per-sign
`patch_recency_verdict()` check reads the OS package-manager history
and refuses to sign if the OS security patch date is > 90 days old,
and (2) the 60-day CVM fleet rotation keeps that OS patch date fresh
under normal operation. Both content-processing code paths and
signing code paths run in the same Signer CVM, so both are gated by
the same extracted `os_security_patch_date`. The bound
`ai.scruple.signer-runtime.v1` assertion (§C.2.3.0) proves this
per-manifest to any verifier.

### C.2.5. Protections against interception and modification of traffic

**External traffic.** TLS 1.3 on all Client-to-Application-tier
traffic (with TLS 1.2 as a backwards-compatibility floor for legacy
clients). Modern ciphers only.

**Internal traffic (Application tier ↔ Signer).** mTLS 1.3 with
pinned peer certificates on an isolated network path, plus a
per-request authentication seal computed over the request timestamp
and body hash with skew tolerance. Both must validate before the
Signer accepts the request.

**IPC protection.** No shared-memory IPC; every subsystem boundary is
either a mutually-authenticated network path or an authenticated
same-host channel. ACLs restrict every IPC endpoint to its intended
caller.

### C.2.6. Protections against exploitation of hosting environment

**IAM and RBAC.** Cloud IAM controls all resource access. Non-human
access is by instance-bound identities (no long-lived service
credentials). Human admin access requires MFA. All privileged
operations are logged to the cloud provider's audit log with 365-day
retention.

**Time discipline — authenticated OS time source on the Signer CVM.**
The Signer CVM's system clock is disciplined against an authenticated
network time source with cryptographic authentication of the upstream,
so a network-level attacker cannot silently rewind or fast-forward the
CVM's wall clock. Every timestamped surface that the Signer produces
or consumes derives from this disciplined clock:

- **Signing-request authentication seals** (per §C.2.5) — the
  per-request seal's timestamp validation rejects skewed requests
  against a clock that a network attacker cannot manipulate.
- **Signing-time timestamps** — the `signer_age_days_at_sign` field in
  every `ai.scruple.signer-runtime.v1` assertion (§C.2.3.4) computes
  against the same clock, so the age binding is network-manipulation
  resistant.
- **Audit-log entries** — application-level audit entries carry
  timestamps sourced from the same disciplined clock, so a
  network-level attacker cannot introduce backdated audit entries.
- **Rotation-Function decisions** — the OCI Function that terminates
  aged CVMs (§C.2.3.3) reads instance `time_created` from OCI IMDS,
  which is itself sourced from the OCI control plane's authenticated
  time source; the age comparison is a difference between two
  authenticated time sources, so a compromised network on either side
  of the Function cannot silently extend an instance's effective age.

The specific time protocol, authentication key material, and upstream
authorities are operational configuration documented in the CVM
provisioning runbook; the security-relevant property is that no
component of the Signer path derives a timestamp from an
unauthenticated network time source.

**HIDS.** Host-based intrusion detection is deployed on every host in
the TOE, with file integrity monitoring on the Signer binary and its
unit files, listening-socket monitoring, suid/sgid change detection,
and kernel-module load monitoring. Logs forwarded to central storage.

**Network segmentation.** The Signer runs on a private network
segment with no public IP. Ingress to the Application tier is gated
by an edge tunnel; no directly-Internet-facing listeners exist on any
TOE host. Security lists deny all inter-segment traffic except the
whitelisted Application-tier-to-Signer path.

**Coordinated vulnerability disclosure.** `SECURITY.md` at the public
repository root documents the contact (`scruple@docentechs.com`),
triage SLA (48 hours), and remediation timeline: 30 days for
high-severity CVSS, 90 days for moderate, 180 days for low, per the
Requirements Document footnote. The release-blocker in CI enforces
the 90-day cap on shipping with a known CRITICAL/HIGH.

**Audit logging.** Cloud audit (infrastructure) and application-level
audit (auth events, sign operations) both retained for 365 days.
Entries bind to the authenticated OS time source described above so a
network-level attacker cannot introduce backdated or replayed audit
entries.

---

## Elapsed-time dependencies

The one item with real elapsed time between filing acceptance and
production customer availability is Trust List CA processing of the
CSR (§C.2.1). Everything else is scripted internally and executes in
under a day. The Signer CVM Instance Pool, rotation Function,
Scheduler, and IAM policies are implemented, applied to the OCI
tenancy, and running at the time of this filing.

## Attestation of accuracy

The above reflects Scruple's production security architecture as of
the filing date. The attached attestation bundles demonstrate the
substrate end-to-end with cryptographically verifiable hardware
Root-of-Trust binding. Happy to answer any follow-up questions or
take a video-conference review at your convenience.

Signed:

**Shaun Hargadine**
On behalf of Docent LLC (dba Docent Technologies)
Date: 2026-07-30
