# Response to the C2PA Conformance Program reviewer

**From:** Shaun Hargadine, on behalf of Docent Technologies (DBA "Scruple")
**Date:** 2026-07-15
**Re:** Evidence samples supporting Scruple's Intake Form
**Intake record ID:** `019f5856-bff8-7f57-a879-80594a6fb3fe`

---

Dear reviewer,

Thank you for the follow-up on the Intake Form and for the specificity of the evidence request. Attached is the evidence bundle you requested — signed samples across every asserted GENERATE and VALIDATE MIME, together with reader-parsed manifest JSON and the dev cert chain used for signing.

## What's in the bundle

- **Generate side:** 15 of 16 asserted MIMEs producing valid signed samples. See `README.md` §"Coverage vs. Intake assertions" for the per-MIME table.
- **Validate side:** 18 of 20 asserted MIMEs producing signed ingested output.
- **The two gaps** (`application/pdf`, `application/x-pytorch`) are both current wrapper limits in `c2pa-python` 0.89. The underlying `c2pa-rs` supports both; the Python bindings do not yet expose them. Raw samples are provided; a `NOT_SUPPORTED.txt` note in each affected folder documents the wrapper-level cause. We will supplement with signed samples for both MIMEs as soon as the wrapper exposes the feature.
- **Every signed sample independently verifies** as `validation_state=Valid` via a fresh `c2pa.Reader` against the included dev cert chain. `_bundle_report.json` is the machine-readable coverage summary.
- **Dev cert chain** is included as `02 — dev-root-ca.pem` and `03 — dev-signer-cert.pem`. Production signing uses ES256 in an AMD SEV-SNP + OCI Vault-isolated key.

## Reproducibility

The bundle producer, signer, and validator are all in the same public repository at `github.com/Docenttx/Scruple/tree/feature/witnessing-l2-sprint1/testing/scripts/c2pa-conformance-bundle/`. A fresh build produces a byte-similar bundle (the signature timestamps differ, otherwise identical).

## What we're claiming

- Scruple satisfies C2PA Conformance Program requirements for the asserted GENERATE and VALIDATE MIMEs listed in the Intake Form, subject to the two `c2pa-python` wrapper limits noted above.
- All signed samples are structurally interoperable with any C2PA v2.x reader — Adobe Verify, Truepic Lens, `c2pa-rs` CLI, `c2pa-python`, IPTC verifier.

Happy to walk through any specific sample or explain any element of the methodology. Let us know how you'd like to proceed.

Thank you again for the opportunity and for the review.

Best regards,

**Shaun Hargadine**
Docent Technologies (DBA Scruple)

- Technical: `partners@scruple.ai`
- Compliance / Conformance: `compliance@scruple.ai`
- Public product: `scruple.ai`
- Public source + evidence: `github.com/Docenttx/Scruple`
