# Scruple L2 Evidence Bundle — SEV-SNP + SoftHSM

**Purpose:** evidence of C2PA Assurance Level 2 signing substrate for
"None of the above" filing under C2PA GPSR §6.1.2 (binary integrity)
+ §6.2.2 (key confidentiality).

**Substrate:** OCI Confidential Compute VM (VM.Standard.E5.Flex,
Ubuntu 24.04.4) with AMD SEV-SNP memory encryption + attestation,
running SoftHSM 2 for key confinement.

## Evidence chain

1. **CVM measurement** (`measurement.hex`) — AMD SEV-SNP attestation
   report proves the VM firmware + kernel + initrd measurement.
2. **VCEK certificate** (`vcek.der`) — AMD-issued cert binds
   `chip_id.hex` to SEV firmware TCB. Chained to AMD ARK/ASK
   in `amd-cert-chain.pem`.
3. **SEV-SNP report** (`sev-snp-report.bin`) — 1184-byte binary
   report with `report_data` (64B) cryptographically binding the
   SoftHSM ES256 public key (SHA-256 of `signer-pubkey.der`).
4. **SoftHSM public key** (`signer-pubkey.der`, `signer-pubkey.pem`)
   — never left the CVM in raw private form; SoftHSM PIN-gated.
5. **Signer cert chain** (`signer-cert-chain.pem`) — dev CA issues
   end-entity cert over the SoftHSM public key with EKU
   `documentSigning` + `emailProtection` (required by c2pa-rs).
6. **Signed test asset** (`signed-test-asset.png`) — proves the
   CVM environment can produce a valid C2PA-signed PNG (via
   c2patool baseline; see NOTES-c2pa-python-0.36-bug.md for
   context on the SoftHSM signing path).
7. **Environment fingerprint** (`ENVIRONMENT.txt`) — dmesg SEV
   activation, `/dev/sev-guest`, configfs-tsm interface, softhsm2
   token slots, python + c2patool versions.

## GPSR §6.1.2 (binary integrity)

Satisfied by AMD SEV-SNP:
- Memory encryption (all VM RAM encrypted with ephemeral key held
  in AMD PSP, opaque to host hypervisor).
- Attestation (`sev-snp-report.bin` + `vcek.der` + AMD chain)
  binds VM measurement to platform hardware Root of Trust.
- The VM measurement (`measurement.hex`) can be reproduced from
  a known firmware+kernel+initrd (see Reproducible Build claim
  in the security architecture document).

## GPSR §6.2.2 (key confidentiality)

Satisfied by SoftHSM 2 running inside the SEV-SNP-encrypted VM:
- Private key material generated inside SoftHSM (SoftHSM PIN
  required for any signing operation).
- SoftHSM DB resides only on the CVM's encrypted memory + disk;
  hypervisor cannot read it.
- Public key is bound into `sev-snp-report.bin.report_data`,
  cryptographically tying the signing key to the attested VM.

## Verification

Any auditor with this bundle can:
- Verify `vcek.der` chains to AMD ARK using `amd-cert-chain.pem`
  (or fetch fresh from https://kdsintf.amd.com/vcek/v1/Genoa/).
- Verify `sev-snp-report.bin` signature using `vcek.der`.
- Compute SHA-256 of `signer-pubkey.der` and confirm it matches
  the 32-byte prefix of the 64-byte `report_data` field.
- Verify `signer-cert-chain.pem` includes the SoftHSM public
  key with `documentSigning` EKU.
- Verify `signed-test-asset.png` C2PA claim using c2patool.
- Cross-check `MANIFEST.sha256` against files.
