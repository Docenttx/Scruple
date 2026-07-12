# Security Architecture Document — Scruple Generator Product (POPULATED)

**Applicant:** Docent Technologies LLC (dba Scruple)
**Generator Product:** Scruple Web Studio C2PA Signer
**Version:** feature/collab-take @ (uncommitted at capture time)
**Filed against:** C2PA Generator Product Security Requirements v0.1 (June 2025)
**Filing date:** 2026-07-12 (evidence-run date; formal filing date TBD)
**Assurance level requested:** L2
**Attestation form answer:** None of the above (per §3 below)

> This is the POPULATED evidence-run version. Placeholders in the
> template at `docs/architecture/L2_EVIDENCE_TEMPLATE.md` are filled
> in below with values captured during the 2026-07-12 live run on an
> OCI SEV-SNP CVM. Do not publish beyond the L2 filing pack — the
> measurements + chip_id leak our substrate details.

---

## Captured evidence values (populated from the 2026-07-12 run)

| Field | Value |
|---|---|
| CVM shape | `VM.Standard.E5.Flex` |
| CVM image | Ubuntu 24.04.4 LTS |
| CVM kernel | `6.17.0-1011-oracle` |
| CVM CPU | AMD EPYC-Genoa-v2 (family 0x19 model 0x11) |
| CVM instance OCID | `ocid1.instance.oc1.iad.anuwcljtzjtltxictqqomtd7thg73al5xlwmjs62omtnbbfjn63nell22hoa` (terminated 2026-07-12T17:52Z) |
| SEV state (dmesg) | `Memory Encryption Features active: AMD SEV SEV-ES SEV-SNP` + `SEV: SNP running at VMPL0` |
| SEV report file | `sev-snp-report.bin` (1184 bytes, ABI version 5) |
| VM measurement | `7237c44bfc842925afa7860596631e8b7e28bcb679fc15c443e1a091c6ec3d1999b90c43b0580a414dde18cb3efbd45a` |
| Chip ID (VCEK anchor) | `bd296e674119acb7367311bf0be06eaf0f6d15b5f0fc78d4f38653f46ca48baa285388d4f07f2964fa62ede902111de6115ada7b4f0289b2beaeae49e7a65aa4` |
| Reported TCB | `0x581c00000000000a` (bl=0x0a, tee=0x00, snp=0x1c, ucode=0x58) |
| Report data (bound key) | `d5b782d80eb3e4f38ac8a54c1ff6ef496fb30fb841f0ebf417996eb73c7398ab` (= sha256 of SoftHSM ES256 SPKI DER) |
| SoftHSM pubkey SPKI SHA-256 | `d5b782d80eb3e4f38ac8a54c1ff6ef496fb30fb841f0ebf417996eb73c7398ab` |
| VCEK certificate | `vcek.der` (1347 bytes, subject "SEV-VCEK", issuer "SEV-Genoa") |
| AMD ARK+ASK chain | `amd-cert-chain.pem` (4602 bytes) |
| End-entity cert | `signer-cert-chain.pem` — dev CA over SoftHSM pubkey; EKU `1.3.6.1.5.5.7.3.36` (documentSigning) + `1.3.6.1.5.5.7.3.4` (emailProtection) |
| Sample signed asset | `signed-test-asset.png` (16050 bytes, C2PA-verified via c2patool 0.9.12 = c2pa-rs 0.37.0) |

**Cross-binding:** the 32-byte prefix of the SEV-SNP report's `report_data`
field equals the SHA-256 of the SoftHSM public key SPKI DER. Any verifier
holding the report + the public key can independently confirm the CVM
was in possession of that specific key at attestation time.

## Sections mapping to captured artifacts

### §6.1.2 binary integrity — SATISFIED
- VM measurement `7237c44b...` recorded in `sev-snp-report.bin`.
- Report signature verifiable by `vcek.der` chained to AMD ARK via `amd-cert-chain.pem`.
- Fresh AMD-published VCEK reachable at `https://kdsintf.amd.com/vcek/v1/Genoa/{chip_id}?...` — reproducible.

### §6.2.2 key confidentiality — SATISFIED
- Key generated inside CVM's SoftHSM 2 (see `ENVIRONMENT.txt` softhsm2-util --show-slots output).
- SoftHSM DB resides in CVM memory + disk both encrypted (SEV-SNP + OCI at-rest).
- Report data cryptographically binds the SoftHSM pubkey to the attested VM — evidence that this specific key was possessed by an attested SEV-SNP CVM at 2026-07-12T17:36Z.

### §6.3.2 GP hardening — PARTIAL (documented; some items TBD in production build)
- Kernel 6.17.0-1011-oracle with standard Ubuntu hardening (ASLR, DEP/NX, stack canaries).
- SoftHSM PIN-gated key operations.
- SEV-SNP firmware measurement pinning (in the same report_body) documents patch level.
- **TBD for production:** reproducible-build hash of Scruple signer binary + Semgrep/ESLint/mypy static-analysis output + signer daemon isolation (systemd unit, dedicated user).

## Open items for formal filing

1. **c2pa-python signing path fix.** During this evidence run, signing via `c2pa.Signer.from_callback` in c2pa-python 0.36.0 produced a manifest whose signature the SAME library's `Reader` reported as `claimSignature.mismatch` — reproduced with both SoftHSM and pure-software ES256 keys. See `NOTES-c2pa-python-0.36-bug.md`. Formal filing requires interop verification passing across ≥2 independent C2PA implementations. Follow-up: downgrade to c2pa-python 0.35.x or use c2patool via PKCS11 external-signer script.
2. **Production cert.** Dev CA used in this run. Formal filing requires DigiCert / SSL.com issuer under C2PA trust list (see `docs/wo/2026-07-12-witnessing-l2/WO-02-c2pa-cert-application.md`).
3. **Reproducible-build hash** of the signer binary — pending WO-04 signer-isolation systemd unit + image pinning.
4. **§6.3.2 static analysis output** — pending `.github/workflows/security.yml` addition.
5. **OCI Audit log export** confirming CVM was ephemeral for evidence-only runs — pull via `oci audit event list` for the launch → terminate window.

## Signatory (pending)

To be signed by Docent Technologies legal signatory at formal filing.
