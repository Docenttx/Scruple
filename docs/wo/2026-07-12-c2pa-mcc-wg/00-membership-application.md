# Application for C2PA Membership and Participation in the Model Content Credentials Work Area

**Applicant:** Docent Technologies LLC (product name: **Scruple**)
**Membership tier requested:** Contributor
**Primary area of contribution:** ML model provenance — sidecar Content Credentials for trained weights, C2PA Assurance Level 2 signing substrate
**Point of contact:** Docent Technologies LLC, legal signatory (name and address on file with LFX enrollment)
**Date:** 2026-07-12

---

## 1. Purpose of this application

Docent Technologies LLC ("Docent"), operating the Scruple content-provenance product, respectfully requests admission to the C2PA as a Contributor member and requests observer / participant status in the Technical Working Group task force covering AI/ML content credentials, including the "Model Content Credential" future-guidance work referenced in the AI/ML guidance section of the C2PA specification (v2.2 and v2.4). We would also like to engage with the Creator Assertions Working Group on the `cawg.training-mining` assertion, given our implementation experience carrying training-time metadata inside a signed C2PA manifest attached to trained model weights.

We come to the WG with a shipping reference implementation, not with a proposal-on-paper. Sections 3 and 4 below summarize the evidence.

## 2. About Docent Technologies and Scruple

Docent Technologies LLC is a US limited-liability company that develops content-provenance infrastructure for AI-generated media. Scruple is our commercial product line: a hosted witnessing and signing service that produces C2PA-conformant Content Credentials for still images, video, audio, and — beginning 2026-07-12 — trained ML model files.

Scruple has been building against the C2PA specification since early 2026. Our current production surfaces are:

- **Image, video, audio Content Credentials.** Every signed asset validates under `c2pa.Reader` with a `Valid` state, subject only to the expected `signingCredential.untrusted` warning until our production signing certificate is issued under a C2PA-trust-listed root. Interop coverage is exercised through `c2patool` (c2pa-rs 0.86) and c2pa-python.
- **Assurance Level 2 substrate.** Signing keys are held inside an AMD SEV-SNP Confidential VM on Oracle Cloud Infrastructure (`VM.Standard.E5.Flex`, Ubuntu 24.04, kernel 6.17), with SoftHSM 2 gating all signing operations. The SEV-SNP attestation report cryptographically binds the SoftHSM ES256 public key into the platform Root of Trust. Full evidence bundle including AMD ARK/ASK chain, VCEK certificate, VM measurement, chip identifier, and reported TCB is captured at `docs/l2-evidence/2026-07-12T174954Z/` in our repository.
- **Blockchain and IPFS/Arweave anchoring.** Every signed asset's canonical record is Merkle-tree'd, Ed25519 checkpoint-signed, and anchored to Ravencoin testnet, IPFS, and Arweave. The anchor tuple is carried inside a namespace-custom C2PA assertion so an auditor can walk from the signed manifest to the public ledger without contacting Scruple.

## 3. Shipping reference implementation (evidence)

On 2026-07-12 we shipped an end-to-end demonstration bundle, `bundle-29e9a40e1d43`, that exercises the full stack across four media modalities and one ML-model modality:

- **Still images:** Five fresh FLUX.1 Stay Puft cyberpunk iterations from a Modal-hosted ComfyUI runner, each C2PA-L2-signed with an ES256 key from the SEV-SNP substrate. All five report `c2pa.Reader` state `Valid`. Merkle root `29e9a40e1d436ce7c4aae2edd4c28bad73bfcece8e9477b9da9b43375543016c`. Scruple identifier `SCR_3DE79573`. Ravencoin testnet txid `8f8f95867d1c9185a1f4439e12f3aad88f0697a41ee23874c1822e06bc5d9e93`.
- **Video and audio:** Companion iterations covering `video/mp4` and `audio/wav` (with format-matrix evidence extending to `audio/flac`, `audio/mpeg`, and `audio/mp4`), all `Valid` under `c2pa.Reader`.
- **Trained model (LoRA):** Project 181, a Stay Puft cyberpunk LoRA (rank-4 PEFT, 1,120 attention layers, trained via Kohya-ss under the `diffusers+peft` trainer family). Whole-file SHA-256 `3141eb757d4dbc6b9ef5eb33cb7c7ab8334b8598fef18a007b515d2722bbe900`. (Corrected 2026-09-02: this line previously carried the BASE model's digest — `sd_xl_base_1.0.safetensors` — rather than the trained LoRA's. See `docs/canon/FILING_CORRECTIONS.md` F-01. The cryptography was never wrong; the sidecar has always bound the correct value.) Sidecar signed via `c2pa.Builder.sign(format="c2pa", …)` — the C2PA-defined external-manifest store — producing a 16,498-byte COSE_Sign1 (ES256) manifest with an `x5chain` leaf-plus-root DER pair. Anchored as `SCR_DB433994` on Ravencoin testnet via txid `32882d63ff67b75c99d4c5fbcc651b5c7d83d862a771f8651b091af22f52b616`.

Interop caveat we discovered and repaired during this run: the c2pa-rs 0.86+ certificate-profile check rejects manifests whose leaf certificate has a sparse Distinguished Name (CN-only), is self-signed, or lacks a critical `emailProtection` Extended Key Usage. The outer symptom reported by `c2pa.Reader` was `claimSignature.mismatch`, which is misleading — the underlying ECDSA signature and payload were valid. We fixed our cert-generation pipeline to require full C/ST/L/O/OU/CN, a distinct root CA, and `critical, emailProtection` EKU (commit `43cf346`). We wired a real `c2pa.Reader` interop check into our end-to-end test harness so this class of regression cannot recur silently. We would flag this issue to the WG as a candidate for clearer diagnostic messaging in c2pa-rs.

## 4. Why we want to participate

The C2PA v2.2 and v2.4 AI/ML guidance calls out "Future Guidance for a Model Content Credential" as an open area. Public C2PA-conformant tooling for ML model files is thin: `c2pa-rs` does not ship a `Builder` handler for `.safetensors`, `.pt`, or `.onnx`; the IntelLabs `atlas-c2pa-lib` remains research-stage and explicitly marked "not for production use." No vendor is, to our knowledge, currently publishing production C2PA Content Credentials bound to trained model weights.

We have a working sidecar-plus-hash-chain architecture for ML model provenance, shipping today, and would like to contribute it to the WG's normative work before the community settles on a final approach. We believe our design — external `.c2pa` manifest bound by `c2pa.hash.data`, carrying a training-mining assertion plus a namespace-custom anchor assertion — respects two constraints that any workable ML-model Content Credential must respect: **byte-preservation of the model file** (downstream loaders like `diffusers`, ComfyUI, kohya-ss, and Hugging Face Hub key their caches by whole-file SHA-256), and **offline verifiability** (an auditor with only the model file and the sidecar can walk the chain to a blockchain anchor without contacting the issuer).

## 5. Specific contributions we would make

If admitted we would offer the following as work product for the WG:

1. **A public reference implementation of the sidecar approach for `.safetensors`, `.pt`, and `.onnx`,** upstreamable to `c2pa-rs` as either a first-party handler set or as a documented pattern that binds by `c2pa.hash.data` without requiring the Builder to parse the container format. Our shipping implementation is in Python via c2pa-python 0.36 at `scripts/puffjuly12/12-emit-lora-sidecar.py`.
2. **A documented signer profile for L2-attested keys backed by AMD SEV-SNP.** We would contribute our Security Architecture Document evidence template (populated at `docs/l2-evidence/2026-07-12T174954Z/POPULATED_SECURITY_ARCH_DOC.md`) as a candidate model for how L2 signers evidence GPSR §6.1.2 (binary integrity) and §6.2.2 (key confidentiality) through hardware Confidential Compute plus SoftHSM.
3. **A training-provenance sub-schema for the training-mining assertion.** The CAWG's `cawg.training-mining` assertion presently addresses training permissions (allowed / constrained / notAllowed) rather than a description of "this asset *is* the trained weights and here is what it was trained on." Our shipping sidecar carries a `training_run` sub-schema with dataset Merkle root, trainer family, base-model reference, PEFT hyperparameters, and structural layer count. We would propose this as a candidate additive sub-schema for either CAWG or C2PA-side normative work.
4. **Blockchain-anchored chain-of-custody assertion pattern.** Our `com.scruple.leaf` namespace-custom assertion is a stable, documented pattern for embedding chain anchors (Merkle root plus RVN txid plus IPFS CID plus Arweave tx) inside a C2PA manifest. We would offer to help draft a vendor-neutral `c2pa.provenance-anchor` assertion in the WG's normative track.

## 6. Posture

We come to the WG as a technical contributor, not a promoter. All hash values, transaction identifiers, and file paths cited in this application are exact and reproducible from the referenced evidence bundle. Our shipping implementation has known limitations, which we describe candidly in the accompanying technical proposal (see `01-technical-proposal.md`, sections on "Reference implementation" and "Open questions"). We look forward to the WG's review and, where our approach diverges from the direction the WG intends to take, to adjusting to align with the community consensus.

Respectfully submitted,
**Docent Technologies LLC** (dba Scruple)
