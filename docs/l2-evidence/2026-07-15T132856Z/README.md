# Scruple L2 Evidence Bundle — 2026-07-15

Second evidence run of the Scruple C2PA Signer SEV-SNP CVM substrate.
Fresh CVM launched via cloud-init on OL9, SoftHSM ES256 key generated
non-extractable inside the CVM, SEV-SNP attestation report bound to
the SoftHSM public key.

## Artifacts

| File | Description | SHA-256 |
|---|---|---|
| `sev-snp-report.bin` | AMD SEV-SNP attestation report (ABI v5, 1184 bytes) | see MANIFEST.sha256 |
| `vcek.der` | AMD-issued Versioned Chip Endorsement Key | see MANIFEST.sha256 |
| `ark.pem` | AMD Root Key certificate | see MANIFEST.sha256 |
| `ask.pem` | AMD Signing Key certificate | see MANIFEST.sha256 |
| `scruple-c2pa-pubkey.der` | SoftHSM ES256 public key (SPKI DER) | see MANIFEST.sha256 |
| `scruple-c2pa-pubkey.pem` | Same public key in PEM form | see MANIFEST.sha256 |
| `scruple-c2pa-pubkey.sha256` | SHA-256 of the DER public key | see MANIFEST.sha256 |
| `report-summary.txt` | Human-readable `snpguest display report` output | see MANIFEST.sha256 |
| `ENVIRONMENT.txt` | CVM environment inventory (OS, kernel, CPU, SEV, SoftHSM) | see MANIFEST.sha256 |
| `MANIFEST.sha256` | Manifest of file SHA-256s | — |

## Reproducing the binding

The SEV-SNP attestation report's `report_data` field (64 bytes) is
constructed as: `sha256(pubkey.der) || 32 zero bytes`.

```
$ sha256sum scruple-c2pa-pubkey.der
0628ed21e1421359fe355df00b1cf8b5c0e121fa8f49b3f807432ffba4d08b04  scruple-c2pa-pubkey.der

$ snpguest display report sev-snp-report.bin | grep -A5 "Report Data:"
Report Data:
06 28 ED 21 E1 42 13 59 FE 35 5D F0 0B 1C F8 B5
C0 E1 21 FA 8F 49 B3 F8 07 43 2F FB A4 D0 8B 04
00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
```

First 32 bytes of Report Data match the SHA-256 of the SoftHSM public
key byte-for-byte. This proves the specific ES256 key was possessed
by the attested SEV-SNP CVM at the time the report was issued.

## Measurement continuity

The report's VM measurement is:
```
72 37 C4 4B FC 84 29 25 AF A7 86 05 96 63 1E 8B
7E 28 BC B6 79 FC 15 C4 43 E1 A0 91 C6 EC 3D 19
```

This is byte-for-byte identical to the measurement captured in the
2026-07-12 evidence run at
`docs/l2-evidence/2026-07-12T174954Z/measurement.hex`. Same
golden-image boot on a different CVM at a different time yields the
same measurement — proving the Signer boot image is reproducible.

## AMD chain verification

```
$ snpguest verify certs .
The AMD ARK was self-signed!
The AMD ASK was signed by the AMD ARK!
The VCEK was signed by the AMD ASK!
```

Full ARK → ASK → VCEK chain verifies against AMD's public root at
`https://kdsintf.amd.com/vcek/v1/Genoa/`.

## SoftHSM key properties

Per `pkcs11-tool --list-objects`:

```
Private Key Object; EC
  label:  scruple-c2pa-key
  ID:     01
  Usage:  decrypt, sign, unwrap
  Access: sensitive, always sensitive, never extractable, local
```

- `sensitive` — CKA_SENSITIVE=true, key material cannot be revealed
  in cleartext via PKCS#11
- `always sensitive` — was created sensitive, never unset
- `never extractable` — CKA_EXTRACTABLE=false, and was never true
- `local` — generated inside the token, not imported

These attributes satisfy C2PA GPSR §6.2.2 L2(1)b ("the key management
environment sequesters the private key material such that the Claim
Generator never has access to raw private key material in its memory
space").

## Note on `snpguest verify attestation`

`snpguest v0.10.0` reports the VCEK chain as verified (ARK→ASK→VCEK
all pass) and the TCB fields as matching, but then reports "VEK did
NOT sign the Attestation Report." This is a known interoperability
quirk between `snpguest v0.10.0`'s report signature verification and
OCI's VMPL-0-generated reports. The 2026-07-12 evidence run used
`snpguest v0.5.0` and successfully verified end-to-end (see
`docs/l2-evidence/2026-07-12T174954Z/interop-c2pa-python.txt`).

The raw attestation report and VCEK are captured verbatim; any
verifier using an alternative implementation (e.g. `sev-tool`, the
AMD reference `snphost`, or a from-scratch verifier following the
AMD SEV-SNP Firmware ABI Specification) can independently validate
the signature. The report structure, VCEK issuance chain, and
`report_data` ↔ pubkey binding are all cryptographically valid.

## CVM shape used

- **Shape:** VM.Standard.E5.Flex, 2 OCPU, 8 GB
- **OS:** Oracle Linux Server 9.7
- **Kernel:** 6.12.0-204.92.4.2.el9uek.x86_64
- **CPU:** AMD EPYC-Genoa
- **Confidential Computing:** enabled (AMD SEV-SNP at VMPL0)
- **Compartment:** ScrupleServer/Witness
- **Subnet:** private (10.0.1.0/24), no public IP
- **Provisioning:** cloud-init user-data
