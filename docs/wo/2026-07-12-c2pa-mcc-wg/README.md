# C2PA Model Content Credentials Working Group — Application Package

**Applying entity:** Docent Technologies LLC
**Product name:** Scruple
**Prepared:** 2026-07-12
**Status:** Draft. Not yet submitted. Documents in this folder are under internal review pending counsel sign-off and executive approval before transmission to the C2PA / CAWG.

## Documents in this package

| File | Description |
| --- | --- |
| `00-membership-application.md` | Formal application for C2PA Contributor membership and for observer / participant status in the Technical Working Group task force covering AI/ML content credentials. Introduces Docent Technologies and Scruple, summarizes the shipping architecture, and names four specific contributions we would offer the WG. Approx. 1,200 words. |
| `01-technical-proposal.md` | Technical proposal detailing our sidecar-plus-hash-chain reference architecture for ML model Content Credentials, with executive summary, problem statement, four-layer architecture, offline verification path, reference implementation pointers, comparison against alternative approaches, open questions for the WG, and bibliography. Approx. 3,425 words. |
| `README.md` | This file. |

## Evidence bundles cross-referenced by both documents

- **puffjuly12 provenance bundle:** `/data/scruple-web/docs/provenance-bundles/bundle-29e9a40e1d43/` — five FLUX iterations, video + audio + LoRA sidecar iterations, L2 substrate copy, witness Merkle checkpoint. Merkle root `29e9a40e1d436ce7c4aae2edd4c28bad73bfcece8e9477b9da9b43375543016c`. Scruple ID `SCR_3DE79573`. RVN testnet txid `8f8f95867d1c9185a1f4439e12f3aad88f0697a41ee23874c1822e06bc5d9e93`.
- **L2 substrate evidence bundle:** `/data/scruple-web/docs/l2-evidence/2026-07-12T174954Z/` — AMD SEV-SNP report, VCEK certificate, AMD ARK/ASK chain, SoftHSM signer public key with `report_data` cross-binding, populated Security Architecture Document mapping to C2PA GPSR §6.1.2 / §6.2.2.
- **Project 181 LoRA sidecar:** `/data/scruple-web/docs/provenance-bundles/bundle-29e9a40e1d43/iterations/training-181/` — the shipping example of a sidecar-based Content Credential bound to a trained model file. LoRA content hash `31e35c80fc4829d14f90153f4c74cd59c90b779f6afe05a74cd6120b893f7e5b`. Scruple ID `SCR_DB433994`.

## Git commit anchors

- `43cf346` — cert-profile fix; wired real c2pa.Reader interop check.
- `7497f78` — puffjuly12 full-send provenance demo.
- `8adb9ff` — Project 181 LoRA C2PA sidecar (feat/l2/training).

## Next steps

1. **Executive review inside Docent Technologies.** Membership application and technical proposal to be reviewed by Docent leadership for accuracy, tone, and commercial-positioning fit before external transmission.
2. **Counsel review of the technical proposal for patent-disclosure concerns.** The sidecar-plus-hash-chain architecture, the hardware-attested signer profile, and the training-provenance sub-schema each touch subject matter we are actively considering for patent filings. Counsel needs to scope which specific technical details can be disclosed in a public WG contribution and which need to be gated behind provisional filings first. Do not submit either document externally until this review completes.
3. **LFX enrollment.** File the Contributor membership application through the Linux Foundation LFX enrollment portal (`enrollment.lfx.linuxfoundation.org/?project=c2pa-fund`). Attach a link to the technical proposal in the application narrative.
4. **Transmit to WG chair.** Once Contributor membership is confirmed, forward the technical proposal to the chair of the C2PA Technical Working Group task force covering AI/ML content credentials (name to be confirmed via the C2PA members-only wiki once enrolled), with a copy to the Creator Assertions Working Group chair given the overlap on `cawg.training-mining`.
5. **Presentation slot request.** Ask the task force chair for a 20-minute WG-meeting slot to demo the shipping architecture against the reference bundle. Prepare a screencast of the offline verification path (Section 4 of the technical proposal) in case the live demo is not accepted.

## Contact

Docent Technologies LLC — legal signatory contact and technical point of contact TBD at formal filing time; both to be filled in prior to WG transmission.
