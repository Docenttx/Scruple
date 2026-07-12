# Security Architecture Document — Scruple Generator Product

**Applicant:** Docent Technologies LLC (dba Scruple)
**Generator Product:** Scruple Web Studio C2PA Signer
**Version:** [signer binary version + git SHA]
**Filed against:** C2PA Generator Product Security Requirements v0.1
(June 2025)
**Filing date:** [YYYY-MM-DD]
**Assurance level requested:** L2
**Attestation form answer:** None of the above (see §3 below)

> **Template usage note.** This file is the shape of the Security
> Architecture Document we submit with our L2 Conformance filing. Every
> `[bracketed]` placeholder is a real value or artifact captured during
> the L2 evidence run (see the WO-CVM-01 playbook). Populate it, sign
> it, submit it. **Do not commit populated versions to a public repo** —
> the run-specific values include measurements that reveal our build
> configuration.

---

## 1. Executive summary

Scruple's C2PA Generator Product is a server-side signing pipeline
running on Oracle Cloud Infrastructure. The signing environment is a
confidential virtual machine (AMD SEV-SNP) inside which a PKCS#11
software HSM (SoftHSM 2) generates and holds the C2PA end-entity signing
key. The Claim Generator (Next.js application) invokes signing via a
`Signer.from_callback` seam that dispatches to the enclave-bound
SoftHSM; the raw private key never enters the Claim Generator's memory.

We file at Assurance Level 2. Because our hardware Root of Trust is
AMD SEV-SNP attestation (not one of the enumerated Appendix B.3
attestation providers), we answer "None of the above" on the intake
form and attach this document per Appendix C guidance.

## 2. Threat model coverage

C2PA Security Considerations §4.3.2.2 (stolen key) and §4.3.2.13
(tampered signing code) define the two adversary models L2 elevates
against. Our architecture closes both in a single mechanism:

| Threat | Mechanism | Evidence artifact |
|---|---|---|
| Stolen signing key (§4.3.2.2) | Key generated + held inside SoftHSM inside SEV-SNP CVM. Sealed to enclave measurement. Non-exportable in the operational sense — the encrypted memory is inaccessible even to the Oracle hypervisor. | AMD SEV-SNP attestation report (`[artifact: sev-snp-report.bin]`) |
| Tampered signing code (§4.3.2.13) | SEV-SNP attestation report includes VM image measurement + AMD firmware measurement chain rooted at AMD PSP CA. The exact bytes of the Scruple signer boot image are hashed and appear in the report. | Same attestation report + reproducible-build hash (`[artifact: image-hash.txt]`) |

## 3. Answer to intake form's attestation question

"Please select the key and/or integrity attestation method(s) that your
Generator Product is capable of invoking."

**Selection: None of the above.**

Our mechanism is **AMD Secure Encrypted Virtualization with Secure
Nested Paging (SEV-SNP) attestation reports, produced by an OCI
Confidential Compute VM** containing a SoftHSM instance holding the
C2PA signing key sealed to the enclave measurement.

This is functionally equivalent to (and shares the same substrate
category as) two Appendix B.3 entries — `AWS_NitroEnclaveAttestation`
(different vendor, same TEE class) and
`GoogleCloud_ConfidentialVMAttestation` (identical vendor
technology on GCP; ours is on OCI). Appendix B.3 is explicitly
"non-exhaustive and does not represent formal endorsement," so
membership in that list is not necessary for functional acceptance.

The attestation report format is `[SEV-SNP report format version
2 — see AMD SEV-SNP Firmware ABI Specification]`. Verification requires
AMD's public Versioned Chip Endorsement Key (VCEK) or Versioned Loaded
Endorsement Key (VLEK) plus the AMD Root Key certificate chain
publicly available at `https://kdsintf.amd.com/vcek/...`.

## 4. §6.1.2 evidence — binary integrity at enrollment

**Requirement (verbatim):** "GP TOE SHALL be capable of producing or
deriving verifiable artifacts backed by a hardware Root of Trust,
such as attestations or hardware-derived credentials, from its
underlying platform, confirming the GP binary/binaries via package
names, hashes, code signing certificates, other digital certificates,
or a combination of the above."

**How we satisfy:**

- The Scruple signer binary is delivered to the CVM as a
  reproducible-build artifact. The build hash appears in
  `[artifact: image-hash.txt]` and is committed to git at
  `[commit SHA]`.
- On CVM boot, the AMD PSP measures the boot image and firmware chain
  and includes those measurements in the attestation report.
- On demand, the CVM fetches an attestation report via `/dev/sev-guest`
  containing the current VM measurement + firmware chain + optional
  caller-supplied `REPORT_DATA` (nonce for freshness).
- The attestation report is signed by AMD's VCEK / VLEK, which chains
  to AMD's publicly published Root Key.
- Anyone with AMD's public certs can verify the report and thereby
  confirm the exact code that was running when a given C2PA sign
  occurred.
- The verifier CLI (`packages/scruple-verify/`) includes an optional
  `--verify-attestation` mode that performs this validation
  automatically against a signed asset's associated attestation report.

**Artifact:** `[docs/l2-evidence/YYYY-MM-DD/sev-snp-report.bin]` +
`[docs/l2-evidence/YYYY-MM-DD/amd-vcek-chain.pem]` +
`[docs/l2-evidence/YYYY-MM-DD/verifier-attestation-validation.log]`

## 5. §6.2.2 evidence — key confidentiality

**Requirement (verbatim):** signer environment must (a) authenticate
callers, (b) never expose raw private key to the Claim Generator's
memory, (c) use hardware-derived wrapping keys, and (d) satisfy
**one of**: (i) hardware-RoT attestation confirming key possession, OR
(ii) accredited third-party auditor certification.

**How we satisfy — (a) caller authentication:**

- The Claim Generator (Next.js app) authenticates users via NextAuth
  session cookie OR API key bearer (SHA-256 hash lookup in
  `api_keys` table).
- The signing route `/api/scruple/c2pa/sign` requires an authenticated
  session before dispatching to `signAsset()`.
- Between the app and the signer daemon: Unix domain socket permissions
  gate access to the daemon (0660 root:app-user), so only the app user
  can initiate a sign call.

**How we satisfy — (b) raw private key never in Claim Generator memory:**

- The signer path uses `c2pa.Signer.from_callback(vault_sign_es256,
  ES256, cert_pem, tsa_url)`. The `vault_sign_es256` callback is a
  Python function that dispatches ES256 signature requests to SoftHSM
  over PKCS#11.
- The Node.js Claim Generator process (`app/api/scruple/c2pa/sign/
  route.ts`) at no point handles raw key bytes. It receives only the
  signed asset path and hash correlation back from the signer subprocess.
- The signer subprocess (`services/c2pa-signer/sign.py`) also never
  handles raw key bytes — it invokes SoftHSM via PKCS#11 for the sign
  operation. Only SoftHSM (running in the same enclave) reads the key
  material.
- **Artifact:** `[git diff services/c2pa-signer/sign.py from_info →
  from_callback]` from commit 0d45097.

**How we satisfy — (c) hardware-derived wrapping keys:**

- SoftHSM's token database is stored on the CVM's encrypted disk.
  Disk encryption uses OCI's platform-managed encryption at rest,
  which is rooted in Oracle-controlled key material.
- The CVM's memory is encrypted at the CPU-hardware level via
  SEV-SNP; the encryption key is generated by the AMD PSP per VM and
  is not accessible to Oracle's hypervisor or to any other tenant.
- The SoftHSM token PIN is stored as a Kubernetes Secret / OCI Vault
  Secret and injected as an environment variable at CVM boot. The PIN
  itself is a wrapping key for the SoftHSM token; the SoftHSM token
  contains the C2PA signing key.
- The chain of wrapping: C2PA private key → SoftHSM token (wrapped
  with PIN) → disk (encrypted with OCI key) → memory (encrypted with
  SEV-SNP key derived by AMD PSP).
- The deepest wrapping layer (AMD PSP-derived memory encryption key)
  is hardware-derived per §6.2.2(c).

**How we satisfy — (d)(i) hardware-RoT attestation of key possession:**

- The SEV-SNP attestation report contains a `REPORT_DATA` field
  populated by the caller with a nonce.
- Our evidence-run playbook fetches the attestation report with
  `REPORT_DATA = sha256(signer_public_key)`. This binds the report
  to a specific key.
- The signature-verification chain: attestation report → AMD PSP →
  AMD Root CA → published trust anchor. Anyone with AMD's public
  certs can confirm that the specific key was possessed by an
  attested CVM at the time of the report.
- **Artifact:** `[docs/l2-evidence/YYYY-MM-DD/attestation-with-key-
  binding.bin]` + validation code (`[packages/scruple-verify/src/
  cli.mjs verify-attestation subcommand]`).

## 6. §6.3.2 evidence — Claim Generator hardening

**Requirement summary:** exploit countermeasures, static analysis
results, higher-privilege enforcement, patch-recency attestation.

**How we satisfy:**

- **Exploit countermeasures:** the CVM runs `[Ubuntu 22.04 LTS / Oracle
  Linux 8]` with default kernel hardening (ASLR, DEP/NX, stack
  canaries, CET when hardware supports it). Node.js is compiled with
  default V8 mitigations. Python's `cryptography` library uses
  constant-time ECDSA implementations.
- **Static analysis:** `[Semgrep + ESLint + mypy]` run on every commit
  via `[.github/workflows/security.yml]`. Latest passing run:
  `[artifact: static-analysis.txt]`.
- **Higher-privilege enforcement:** signer daemon runs as dedicated
  `scruple-signer` OS user (systemd unit with `NoNewPrivileges=yes,
  PrivateTmp=yes, ProtectSystem=strict`).
- **Patch recency:** SEV-SNP attestation report includes firmware
  measurement. The measurement pins the exact AMD firmware version
  in use, which anyone can cross-reference against AMD's published
  advisory list to confirm no known-vulnerable firmware version.

## 7. Signing key lifecycle

- **Generation:** performed inside the CVM by SoftHSM 2 on first boot.
  ECDSA-P256. Never exported.
- **Storage:** SoftHSM token stored on encrypted disk inside the CVM.
- **Usage:** every C2PA sign is dispatched via the
  `Signer.from_callback` seam described in §5.
- **Rotation:** annual. Fresh CVM provisioned with new image; new key
  generated inside; trust manifest publishes both keys with
  `active_from` / `deprecated_at` fields; verifiers select the
  correct key per sign timestamp.
- **Revocation:** if compromise suspected, publish CRL entry, provision
  new CVM immediately, publish new key in trust manifest with a
  `revoked_at` on the old.
- **Backup:** none. Sealed keys are intentionally non-recoverable — key
  loss = generate a new one. The historical signs remain valid because
  the trust manifest carries the historical pubkey with active-window
  metadata.

## 8. Per-sign audit trail

Every C2PA sign event emits a leaf to the `scruple.c2pa.sign` stream
of the Scruple witness audit chain. See
`docs/architecture/CANONICAL_SCRUPLE_WITNESSING_L2.md` §5.4 and
`docs/architecture/SCRUPLE_CONTINUOUS_AUDIT_API_DESIGN.md` for
architectural detail. The leaf commits the asset hash, output manifest
hash, signer identity string, signing tier, timestamp, and cert serial.
The leaf lands in a signed, chained, Merkle-hashed checkpoint within
the checkpoint interval (default 5 minutes at `enhanced` tier), and
the checkpoint's super-root is periodically anchored to Ravencoin +
Arweave + IPFS.

This audit trail is verifiable end-to-end via the reference verifier
CLI `scruple-verify c2pa <signed-asset>` (published on npm as
`@scruple/verify`) and constitutes third-party-verifiable evidence of
which asset was signed, when, by which key, in which signing
environment.

**Artifact:** `[docs/l2-evidence/YYYY-MM-DD/sample-c2pa-sign-audit-
trail.txt]` — the full audit trail for a representative sign event,
including leaf ID, inclusion proof, checkpoint signature, and
verification output.

## 9. Cert chain

The end-entity signing cert is issued by `[DigiCert Content Credentials
/ SSL.com]` under the C2PA trust list. Serial `[NUM]`; issuer chain
`[chain PEM]`; EKU `1.3.6.1.5.5.7.3.36` (id-kp-documentSigning). The
public key in the cert matches the public half of the CVM-generated
signing key by exact byte match — verifiable by SHA-256 comparison
per §5(d)(i).

**Artifact:** `[docs/l2-evidence/YYYY-MM-DD/signer-cert-chain.pem]` +
`[docs/l2-evidence/YYYY-MM-DD/cert-key-match-proof.txt]`.

## 10. Interop verification

Our filing includes interop verification demonstrating that assets
signed by the L2 CVM path are validated by independent C2PA
implementations:

- `c2pa-python 0.36` (Python distribution): `[VALID]`
- `c2pa-node 0.6.x` (Node.js distribution, separately packaged from
  c2pa-python): `[VALID]`
- Truepic Lens SDK cross-verification (their `libc2pa` implementation,
  independent from c2pa-rs) against an asset we sign
- `scruple-verify c2pa <asset>` end-to-end: `[VALID]`

**Artifact:** `[docs/l2-evidence/YYYY-MM-DD/interop-v2-report.md]`

## 11. Operational transparency (Rider-adjacent)

The audit chain that captures every C2PA sign event also underpins
Docent Technologies' Independent AI Witnessing Rider, a contractual
instrument attached to enterprise customer DPAs (see
`docs/architecture/Independent_AI_Witnessing_Rider_TEMPLATE.md`).
Customers under the Rider hold direct-issued verification credentials
from the witness service, allowing them to independently verify their
own sign events without Docent's cooperation. This operational
transparency exceeds any C2PA GPSR requirement but is included here
as evidence of Docent's ongoing commitment to third-party-verifiable
provenance.

## 12. Evidence artifact index

All artifacts referenced above live under `docs/l2-evidence/YYYY-MM-DD/`
after the evidence-only run. Populated version:

- `sev-snp-report.bin` — the SEV-SNP attestation report
- `amd-vcek-chain.pem` — AMD public certs for report verification
- `verifier-attestation-validation.log` — output of running our
  attestation-validation code on the report
- `image-hash.txt` — reproducible-build hash of the signer binary
- `signed-test-asset.png` — C2PA-signed asset produced by the CVM signer
- `signer-cert-chain.pem` — end-entity cert + issuer chain
- `cert-key-match-proof.txt` — hash comparison proving cert public key
  matches CVM-generated key
- `sample-c2pa-sign-audit-trail.txt` — witness-chain proof for a sample
  sign event
- `interop-v2-report.md` — verification by c2pa-python, c2pa-node,
  Truepic, and `scruple-verify`
- `oci-audit-cvm-launch-and-teardown.json` — OCI Audit log entries
  showing the CVM was ephemeral for evidence-only runs
- `static-analysis.txt` — Semgrep + ESLint + mypy output on the signer code
- `security-policy.md` — the ongoing security policy for the operational
  L2 signing environment (§7 above expanded)

## 13. Signatory

I, `[NAME, TITLE]`, on behalf of Docent Technologies LLC, attest that
the above architecture reflects the actual production configuration of
the Scruple C2PA Generator Product as of `[YYYY-MM-DD]`. Independent
verification of the SEV-SNP attestation report and the C2PA-signed
test asset is welcome using our published verifier CLI at
`https://www.npmjs.com/package/@scruple/verify`.

Signed: `[signature]`
Date: `[YYYY-MM-DD]`
