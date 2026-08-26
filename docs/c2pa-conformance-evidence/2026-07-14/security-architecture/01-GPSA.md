# Scruple — Generator Product Security Architecture Document

**Filed against:** C2PA Generator Product Security Requirements, v0.1 (2025-06-02)
**Template:** Appendix C of the same document
**Applicant:** Docent LLC (dba Docent Technologies)
**Generator Product:** Scruple C2PA Signer
**Intake record ID:** `019f5856-bff8-7f57-a879-80594a6fb3fe`
**Filing date:** 2026-07-16
**Target Max Assurance Level:** Level 2
**Signatory:** Shaun Hargadine
**Contact:** `scruple@docentechs.com`

---

## Cover statement

This document responds to the Generator Product Security Requirements
evidence ask for Scruple's Intake submission at the Level 2 tier.
Because every L2 requirement is defined by the specification as
additive to L1, a product that meets L2 also meets L1; where L2
evidence is insufficient in the assessor's judgment for a specific
objective, Scruple accepts grading at L1 for that objective with no
architectural change.

Scruple is NOT a capture-only product. Every asserted validate MIME
in the Intake Form is exercised end-to-end in the accompanying
sample bundle.

---

## C.1. Generator Product Information

### C.1.1. Applicant organization details

- **Full legal name:** Docent LLC
- **Trading name:** Scruple
- **Jurisdiction:** United States (LLC)
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
pending Program acceptance of this filing. The signed samples in
the accompanying evidence bundle carry a development CA-issued
end-entity certificate for demonstration purposes.

### C.1.3. Generator Product Description

Scruple is a service that produces C2PA v2.x signed manifests for
AI-generated media and for third-party generator products that
delegate signing to Scruple.

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

External infrastructure consumed but outside the TOE: public
ledgers used for optional ledger-anchored audit records; a payment
processor for billing. Neither touches asset bytes or C2PA
assertions.

### C.1.5. Implementation Class

**Distributed.** The Client, the Application tier, and the Signer
are separate subsystems with authenticated network boundaries
between them. §6.5.1 Distributed-Class requirements for mutual
authentication and TLS 1.3 apply; both are satisfied per §C.2.5.

### C.1.6. Target Max Assurance Level

**Level 2**, with implicit Level 1 conformance.

| Obj | L1 | L2 | Mechanism satisfying the requirement |
|---|---|---|---|
| **O.1** Automated cert enrollment (§6.1) | N/A | N/A | Program-designated Trust List CAs use manual CSR enrollment. §6.1 is only applicable to products relying on automated enrollment. |
| **O.2** Signing-key confidentiality (§6.2) | ✓ | ✓ | ECDSA P-256 (ES256) key generated and held inside a PKCS#11 HSM inside an AMD SEV-SNP Confidential VM. Key is non-extractable by PKCS#11 attribute. Hardware-Root-of-Trust attestation binds the specific key to the specific TEE; two independent live attestation bundles attached. See §C.2.2. |
| **O.3** Claim Generator hardening (§6.3) | ✓ | ✓ | SCA, SAST, SBOM, and known-vulnerable release-blocker wired in CI. Signer is isolated from the Application tier by the TEE boundary. Patch recency for the TEE substrate is pinned by the attestation report's TCB field. See §C.2.3. |
| **O.4** Content-processing hardening (§6.4) | ✓ | ✓ | Same CI coverage as O.3. Signer subprocess runs under systemd hardening (isolation, no-new-privileges, memory-write-execute prohibition, syscall filter). See §C.2.4. |
| **O.5** Traffic protection (§6.5) | ✓ | ✓ | TLS 1.3 on external traffic; mTLS 1.3 between Application tier and Signer with per-request authentication seal on top of the TLS layer. See §C.2.5. |
| **O.6** Hosting environment (§6.6) | ✓ | ✓ | Cloud IAM RBAC. Tenancy-wide audit logging with 365-day retention. HIDS deployed. Network segmentation. Coordinated vulnerability disclosure with 30/90/180-day CVSS-severity remediation SLAs. See §C.2.6. |

### C.1.7. Target Generator Product capabilities

**Claim generation** (per the Intake Form):

- Still image: `image/jpeg`, `image/png`, `image/svg+xml`,
  `image/x-adobe-dng`, `image/tiff`, `image/webp`, `image/heic`,
  `image/heif`, `image/avif`
- Video: `video/mp4`, `video/quicktime`
- Audio: `audio/flac`, `audio/mpeg`, `audio/wav`, `audio/mp4`
- ML models: `pytorch`

**Claim validation** (per the Intake Form):

- Still image: `image/jpeg`, `image/jxl`, `image/png`,
  `image/svg+xml`, `image/gif`, `image/x-adobe-dng`, `image/tiff`,
  `image/webp`, `image/heic`, `image/heif`, `image/avif`
- Video: `video/x-msvideo`, `video/mp4`, `video/quicktime`
- Audio: `audio/flac`, `audio/mpeg`, `audio/wav`, `audio/mp4`
- Documents: `application/pdf`
- ML models: `pytorch`

Coverage evidence — the `Generate.output.<mime>/`, `Raw.input.<mime>/`,
and `Validate.output.<mime>/` folders in the accompanying sample
bundle. 15 of 16 asserted generate MIMEs and 18 of 20 asserted
validate MIMEs produce signed samples; the three gaps
(`application/pdf`, `application/x-pytorch`) are current
`c2pa-python` wrapper limits documented per-folder in the bundle.
Every signed sample verifies as `validation_state=Valid` against
the included development cert chain.

---

## C.2. Security architecture details

### C.2.1. Authentication for certificate enrollment

Enrollment is manual: Scruple submits a CSR to a Program-designated
Trust List CA via the CA's standard portal. §6.1 requirements
apply only to products relying on automated cert enrollment; they
therefore do not apply here.

The CSR is generated inside the TEE against the HSM-held private
key. Only the CSR (which contains only the public key and a
proof-of-possession signature over it) leaves the TEE.

Rotation: same ceremony, on annual cadence or on suspected
compromise.

### C.2.2. Key generation, storage, and usage

**Algorithm and key size.** ECDSA P-256 (ES256) per RFC 8152
COSE_Sign1 conventions, consistent with C2PA v2.x claim signature
requirements.

**Storage.** The private key is generated inside a PKCS#11 HSM
that resides inside an AMD SEV-SNP Confidential VM. The key is
created with the PKCS#11 attributes that make it non-extractable
and non-exportable: PKCS#11 API calls cannot retrieve the key
material; the only permitted operation is `C_Sign`. Combined with
SEV-SNP memory encryption, the plaintext private key exists only
inside the HSM's protected memory region inside the TEE's
encrypted memory region, and is therefore not accessible to:

- the cloud hypervisor (memory is encrypted by the CPU with a
  per-VM key derived by the AMD Platform Security Processor)
- any other tenant on the same physical host
- any Docent operator
- the Signer service process itself, in raw form

**Attestation of key generation and storage (§6.2.2 L2).** The
SEV-SNP attestation report's `report_data` field is populated by
the caller with the SHA-256 of the HSM public key SPKI. Any
verifier holding (report, public key) can independently confirm
that the specific private key was possessed by the attested TEE at
the time of the report.

**Two live attestation bundles are attached:**

- `evidence/l2-evidence-2026-07-12T174954Z/` — first bundle
- `evidence/l2-evidence-2026-07-15T132856Z/` — second bundle,
  independently provisioned. Byte-identical VM measurement to the
  first bundle, demonstrating boot-image reproducibility.

Each bundle contains: the SEV-SNP attestation report, the AMD
Versioned Chip Endorsement Key, the AMD Root Key → Signing Key
certificate chain, the VM measurement, and the HSM public key
plus its SHA-256 (which matches the `report_data` field
byte-for-byte). Any verifier can independently perform the AMD
chain verification and the `report_data` ↔ public-key match.

Rotation: annually or on suspected compromise. A live trust
manifest is published so downstream verifiers can select the
correct cert per sign timestamp.

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
- **Known-vulnerable release blocker** that fails any release where
  a detected CRITICAL/HIGH is more than 90 days past first detection.

**Exploit countermeasures.** The Signer image is a reproducibly
built image. Compiler and linker hardening (stack protection,
`FORTIFY_SOURCE`, RELRO, PIE), ASLR, and DEP/NX are enforced. A
countermeasures verification report is emitted per build and
attached as a CI artifact.

**Software image authentication.** The SEV-SNP measurement recorded
in every attestation report is a cryptographic fingerprint of the
running CVM boot image. Because the boot image is
reproducibly built, the measurement pins the Signer binary to a
specific released version.

**Patch recency.** The attestation report's TCB field pins the
substrate firmware and kernel version at attestation time,
verifiable against the vendor's published advisories. The 90-day
release-blocker in CI covers dependency-side patch recency.

### C.2.4. Protections against misconfiguration and abuse of content-processing software

**CI coverage.** Same coverage as §C.2.3 covers the content-processing
code paths.

**Isolation of the Signer process.** The Signer subprocess runs as
a dedicated OS user under a systemd unit with the standard hardening
set (`ProtectSystem=strict`, `PrivateTmp=yes`, `NoNewPrivileges=yes`,
`MemoryDenyWriteExecute=yes`, `SystemCallFilter=@system-service`,
`InaccessiblePaths` covering the key directory). Communication with
the Application tier is over an isolated network path with the
mutual-authentication protections described in §C.2.5.

**Input validation.** Application-tier routes validate all external
inputs at the boundary. The Signer performs its own JSON-schema
validation on every request and rejects any mismatched payload.
C2PA manifest structure is validated before signing and again after,
via round-trip verification.

**Patch recency.** As §C.2.3.

### C.2.5. Protections against interception and modification of traffic

**External traffic.** TLS 1.3 on all Client-to-Application-tier
traffic (with TLS 1.2 as a backwards-compatibility floor for legacy
clients). Modern ciphers only.

**Internal traffic (Application tier ↔ Signer).** mTLS 1.3 with
pinned peer certificates on an isolated network path, plus a
per-request authentication seal computed over the request timestamp
and body hash with skew tolerance. Both must validate before the
Signer accepts the request.

**IPC protection.** No shared-memory IPC; every subsystem boundary
is either a mutually-authenticated network path or an
authenticated same-host channel. ACLs restrict every IPC endpoint
to its intended caller.

### C.2.6. Protections against exploitation of hosting environment

**IAM and RBAC.** Cloud IAM controls all resource access. Non-human
access is by instance-bound identities (no long-lived service
credentials). Human admin access requires MFA. All privileged
operations are logged to the cloud provider's audit log with 365-day
retention.

**HIDS.** Host-based intrusion detection is deployed on every host
in the TOE, with file integrity monitoring on the Signer binary
and its unit files, listening-socket monitoring, suid/sgid change
detection, and kernel-module load monitoring. Logs forwarded to
central storage.

**Network segmentation.** The Signer runs on a private network
segment with no public IP. Ingress to the Application tier is
gated by an edge tunnel; no directly-Internet-facing listeners
exist on any TOE host. Security lists deny all inter-segment
traffic except the whitelisted Application-tier-to-Signer path.

**Coordinated vulnerability disclosure.** `SECURITY.md` at the
public repository root documents the contact
(`scruple@docentechs.com`), triage SLA (48 hours), and remediation
timeline: 30 days for high-severity CVSS, 90 days for moderate,
180 days for low, per the Requirements Document footnote. The
release-blocker in CI enforces the 90-day cap on shipping with a
known CRITICAL/HIGH.

**Audit logging.** Cloud audit (infrastructure) and application-level
audit (auth events, sign operations) both retained.

---

## Elapsed-time dependencies

The one item with real elapsed time between filing acceptance and
production customer availability is Trust List CA processing of the
CSR (§C.2.1). Everything else is scripted internally and executes
in under a day.

## Attestation of accuracy

The above reflects Scruple's production security architecture as of
the filing date. The two attached attestation bundles demonstrate
the substrate end-to-end with cryptographically verifiable hardware
Root-of-Trust binding. Happy to answer any follow-up questions or
take a video-conference review at your convenience.

Signed:

**Shaun Hargadine**
On behalf of Docent LLC (dba Docent Technologies)
Date: 2026-07-16
