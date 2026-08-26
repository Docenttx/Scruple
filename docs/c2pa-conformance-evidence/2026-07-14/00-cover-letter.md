# Response to the C2PA Conformance Program reviewer

**From:** Shaun Hargadine, on behalf of Docent LLC (dba Docent Technologies)
**Date:** 2026-07-15
**Re:** Evidence samples + Generator Product Security Architecture Document
**Intake record ID:** `019f5856-bff8-7f57-a879-80594a6fb3fe`

---

Dear Scott,

Thank you for the follow-up on the Intake Form and for the specificity
of your evidence request. This message responds to both halves of that
request in one submission.

## Part 1 — Media-type evidence bundle

The requested `Generate.output.<mediatype>/`, `Raw.input.<mediatype>/`,
and `Validate.output.<mediatype>/` folders are in the accompanying
Drive folder. Structure and coverage summary:

- **Generate side:** 15 of 16 asserted MIMEs produce valid signed
  samples. `README.md` §"Coverage vs. Intake assertions" has the
  per-MIME table; `_bundle_report.json` is the machine-readable
  version.
- **Validate side:** 18 of 20 asserted MIMEs round-trip through signed
  ingested output.
- **The two gaps** (`application/pdf`, `application/x-pytorch`) are
  current wrapper limits in `c2pa-python 0.36`. The underlying
  `c2pa-rs` supports both; the Python bindings do not yet expose them.
  Raw samples are provided; `NOT_SUPPORTED.txt` in each affected
  folder documents the wrapper-level cause. We will supplement with
  signed samples for both as soon as the wrapper exposes the feature.
- **Every signed sample independently verifies** as
  `validation_state=Valid` via a fresh `c2pa.Reader` against the
  included dev cert chain (`02 — dev-root-ca.pem` and
  `03 — dev-signer-cert.pem`). Production signing will use OCI Vault
  as documented in Part 2.

Reproducibility: the bundle producer, signer, and validator are all in
the same public repository at
`github.com/Docenttx/Scruple/tree/feature/witnessing-l2-sprint1/`
under `services/c2pa-signer/`.

## Part 2 — Generator Product Security Architecture

Attached under `security-architecture/` is our Generator Product
Security Architecture Document completed per Appendix C of the C2PA
Generator Product Security Requirements v0.1 (2025-06-02). Filed at
**Assurance Level 2**.

Key points for your first-pass review:

- **Confirmation of validate scope.** Scruple is NOT a capture-only
  product. The `Validate.output.<mime>/` samples in Part 1 exercise
  every asserted validate MIME end-to-end. Please treat that as
  confirmation of the bracketed question in your email.
- **Implementation Class: Distributed.** Edge (browser / plugin /
  integrator API caller) → Backend-Web (Next.js on OCI Compute) →
  Backend-Signer (inside OCI SEV-SNP Confidential VM with SoftHSM 2
  holding the ES256 private key). Full architecture diagram +
  subsystem-by-subsystem TOE table in the GPSA §C.1.4.
- **L2 §6.2.2 key confidentiality — evidence attached.** The
  2026-07-12 evidence run captured a complete hardware Root-of-Trust
  attestation binding the C2PA signing key to a specific SEV-SNP
  CVM. Artifacts at
  `security-architecture/evidence/l2-evidence-2026-07-12T174954Z/`:
  `sev-snp-report.bin`, `vcek.der`, `amd-cert-chain.pem`,
  `measurement.hex`, `signer-pubkey-sha256.txt` (which matches the
  attestation report's `report_data` field byte-for-byte), plus a
  C2PA-signed test asset produced by that specific SoftHSM key.
  Anyone with AMD's public VCEK cert chain (fetchable at
  `https://kdsintf.amd.com/vcek/v1/Genoa/{chip_id}?...`) can
  independently verify the whole chain end-to-end.
- **Level 2 across all applicable objectives, self-assessed:** O.2,
  O.3, O.4, O.5, O.6 all satisfy L2 per the shipped state; O.1 (§6.1
  automated cert enrollment) is not applicable because C2PA Trust
  List CA enrollment is manual by design.
- **Operational readiness.** Per-objective evidence, runbooks
  (`security-architecture/runbooks/`) for CVM provisioning, cert
  enrollment, and customer onboarding, and the security CI workflow
  (`.github/workflows/security.yml`) are all committed. The only
  elapsed-time item between filing acceptance and production
  customer availability is Trust List CA processing of our CSR.
- **Vulnerability disclosure.** `SECURITY.md` at repo root documents
  the coordinated-disclosure process, contact address
  (`scruple@docentechs.com`), triage SLA (48 hours), and remediation
  timeline per the GPSR §6.6 footnote (30/90/180 days for
  high/medium/low CVSS).

## What's in the Drive folder

```
Scruple C2PA Conformance Response — 2026-07-15/
├── 00 — Cover Letter — Response to C2PA Conformance reviewer
├── README.md
├── _bundle_report.json
├── scruple-c2pa-evidence-2026-07-14.zip   ← full media evidence bundle
├── 02 — dev-root-ca.pem
├── 03 — dev-signer-cert.pem
└── security-architecture/                  ← Part 2 (GPSA + evidence)
    ├── 01-GPSA.md
    ├── evidence/
    │   ├── l2-evidence-2026-07-12T174954Z/  ← SEV-SNP attestation bundle
    │   ├── architecture-diagram.md
    │   ├── checksec-signer-latest.txt
    │   ├── cloudflare-tls-config.png
    │   ├── oci-iam-policies-redacted.txt
    │   ├── osquery-fleet-status.txt
    │   └── ...other runtime evidence artifacts
    └── runbooks/
        ├── cvm-provision.md
        ├── cert-enrollment.md
        └── customer-onboarding.md
```

Happy to walk through any specific sample, section of the GPSA, or
element of the substrate design. If the Program has a video-conference
review option, we welcome it — a live re-attestation of a currently-
provisioned Signer is doable within same-day turnaround.

Thank you again for the review.

Best regards,

**Shaun Hargadine**
Docent LLC (dba Docent Technologies)

- Contact: `scruple@docentechs.com`
- Public product: `scruple.ai`
- Public source + evidence: `github.com/Docenttx/Scruple`
