# Patent Claim Brief — Witnessed AI Model Training with Cryptographic Provenance

**Prepared for:** Patent counsel (external)
**Prepared by:** Docent Technologies LLC (dba Scruple)
**Date:** 2026-07-12
**Status:** DRAFT technical brief. NOT a filing document. NOT a legal opinion.
**Purpose:** Enable counsel to (a) understand the concrete architecture, (b) identify defensible claim scope under 35 U.S.C. §101 (Alice/Mayo), and (c) draft narrow specific-composition claims.

> **Reader warnings.** This document contains an inventor's characterization of prior art and identifies specific patent references (Adobe, Verisart, Truepic, Numbers Protocol) that counsel MUST independently verify — inventor citations to third-party patent numbers should be treated as unverified starting points, not confirmed facts. Every place where the inventor is uncertain is flagged inline with the phrase "counsel to verify" or "uncertain." No claim in this document has been vetted for §101, §102, §103, §112, or infringement scope.

---

## 1. Executive Summary

Docent Technologies LLC (dba Scruple) has built and shipped an end-to-end architecture that produces cryptographically verifiable, offline-auditable provenance for AI model training artifacts (LoRAs, full fine-tunes, adapter weights). The system is live at `/data/scruple-web` (private) with a concrete embodiment in commit `7497f78` (puffjuly12 end-to-end demo) and a training-specific sidecar in commit `8adb9ff` (Project 181 LoRA `.safetensors.c2pa` sidecar).

The invention composes six elements: (i) a canonical training-time record binding dataset, workflow, machine manifest, base-model and output-model hashes into a single SHA-256 preimage; (ii) signing by a private key custodied inside SoftHSM inside an AMD SEV-SNP Confidential VM, with the public-key SPKI hash cryptographically bound into the SEV-SNP attestation report's `report_data` field; (iii) Merkle inclusion into a periodic checkpoint; (iv) anchoring the checkpoint root onto a public blockchain by inscribing it into an asset-issuance metadata field (Ravencoin testnet in embodiment; production-portable), with parallel IPFS pin and Arweave record for redundancy; (v) emission of a C2PA-vocabulary sidecar (`application/c2pa` container, JUMBF-wrapped, COSE_Sign1-signed with ES256, whose `x5chain` header carries the L2 signer's cert chain) containing standard C2PA assertions (`c2pa.hash.data`, `c2pa.assertion.training-mining`) and a namespace-custom `com.scruple.leaf` assertion carrying the anchor tuple; (vi) an offline verification path that requires no cooperation from the issuer — an auditor holding the model file, the sidecar, and public data (AMD ARK, RVN block explorer, IPFS gateway) can independently confirm the full chain.

Commercial significance: the LoRA / fine-tune / adapter marketplace is materially blocked by an inability to prove what a model was trained on and by whom. This architecture converts that blocker into a discoverable public record that can be attached to a copyright suit, a marketplace listing, or a regulatory filing. Novelty likely resides in the specific composition — none of the constituent primitives is individually new, but the assembly, and the particular choice of binding the signer's key possession to hardware Root of Trust attestation as part of the AI-model-provenance signing profile, does not appear (as of inventor's knowledge) in the public literature or in shipped systems.

---

## 2. Technical Description

### 2.1 Feature 1 — Canonical training-time record

The training-time record ("leaf" in system terminology) is a JSON object whose fields are serialized in a fixed order, with compact JSON (no whitespace), sorted-key dictionaries, and empty-string defaults for absent optional fields. The current production leaf schema is v2.3 for training records; the audit-API leaf schema is v23; both share the canonicalization discipline. Fields bound into the training leaf preimage include:

- `training_dataset_hash` — SHA-256 of the Merkle root over the dataset image files, caption files, and label files. In embodiment (`8adb9ff`), computed as SHA-256 over a balanced binary Merkle tree of per-file SHA-256s in filename-sorted order.
- `workflow_hash` — SHA-256 of the canonicalized JSON representation of the training workflow (Kohya-ss / diffusers+peft config, hyperparameters, LR schedule, network dim/alpha, rank, steps, resolution).
- `machine_manifest_hash` — SHA-256 of the pinned compute environment (ComfyUI/Kohya-ss version, model volume state hash, custom-node commit SHAs, base container image hash).
- `model_fingerprints_hash` — SHA-256 of the trained model output file's byte content (the `.safetensors` blob or the PyTorch `state_dict` serialization). Whole-file hash; no exclusions.
- `base_model_hash` — SHA-256 of the base model's byte content (e.g. `sd_xl_base_1.0.safetensors`).
- `input_hash` — SHA-256 of any conditioning inputs (unused for training-only leaves; populated for inference leaves).
- `previous_hash` — SHA-256 of the prior training-run record for the same project, forming a per-project chain independent of the audit-log-wide chain.
- `run_sequence` — monotonic integer within the project.
- `server_timestamp` — RFC 3339 UTC at the witness server.
- `witness_id`, `signer_pubkey_sha256_hex` — signer identity fields.

The audit-log-wide chain hash — `chain_hash = sha256(prev_chain_hash_bytes || leaf_hash_bytes)`, both inputs decoded from hex to raw bytes before hashing — enforces cross-language byte-level parity. The exact algorithm is in `/data/scruple-web/lib/witness/canonicalLeafV23.ts` and its Python twin `/data/scruple-web/services/witness/canonical_leaf_v23.py`; a parity fixture set in `/data/scruple-web/test/fixtures/canonical-leaf-v23-vectors.json` gates any change to either side.

Hash algorithm throughout: SHA-256 (FIPS 180-4 §6.2).

### 2.2 Feature 2 — Hardware-attested signing key

The signing key is generated inside SoftHSM 2 (an open-source PKCS#11 provider) which itself runs inside an AMD SEV-SNP Confidential VM ("CVM"). Concrete embodiment: OCI `VM.Standard.E5.Flex` shape with SEV-SNP enabled, AMD EPYC Genoa CPU (family 0x19 model 0x11), Ubuntu 24.04.4 kernel 6.17.0-1011-oracle. Live capture from the 2026-07-12 evidence run at `/data/scruple-web/docs/l2-evidence/2026-07-12T174954Z/`.

The key element for patenting: **the SEV-SNP attestation report's `report_data` field (64 bytes at offset 0x50 in the report body, per AMD Firmware ABI Specification v1.55 §7.3 SEV_SNP_GUEST_MSG_REPORT_REQ / _RSP) is populated by the CVM at attestation-request time with the SHA-256 of the SoftHSM signer public-key SPKI DER encoding**. Verifiers holding the report + the signer's public key can compute the same SHA-256 and confirm that this specific key was in possession of an SEV-SNP-attested CVM whose VM measurement equals the value in the report's `MEASUREMENT` field (offset 0x90, 48 bytes). Captured evidence:

- Report data (bound key): `d5b782d80eb3e4f38ac8a54c1ff6ef496fb30fb841f0ebf417996eb73c7398ab`
- SoftHSM pubkey SPKI SHA-256: `d5b782d80eb3e4f38ac8a54c1ff6ef496fb30fb841f0ebf417996eb73c7398ab`

The report is signed by the VCEK (Versioned Chip Endorsement Key), whose certificate chains through AMD's ASK (AMD SEV Key) and ARK (AMD Root Key) — root certs are publicly published at `https://kdsintf.amd.com/vcek/v1/Genoa/{chip_id}` and mirrored in `docs/l2-evidence/2026-07-12T174954Z/amd-cert-chain.pem`. The chain terminates at a hardware Root of Trust that Docent does not control and cannot mint.

Referenced specifications:

- AMD Secure Encrypted Virtualization-Secure Nested Paging (SEV-SNP) — AMD Publication 56860, Rev. 1.55.
- AMD SEV-SNP Firmware ABI Specification, revision 1.55.
- SEV-SNP attestation model — AMD Publication 55766.

### 2.3 Feature 3 — Merkle inclusion into a periodic checkpoint

Per stream, a scheduler fires every `checkpoint_secs` (tunable, 60 / 300 / 3600 seconds in current tiers) and performs:

1. Select all unwitnessed leaves for the stream since the previous checkpoint (`tenant_seq > last_checkpoint.last_seq`).
2. Build a balanced binary Merkle tree over leaf hashes in `tenant_seq` order. Internal nodes = SHA-256(left || right) over raw bytes.
3. Emit a canonical checkpoint bundle: `{stream_id, epoch_index, first_seq, last_seq, merkle_root, prev_checkpoint_id, created_at}`, canonicalized per the same rules as leaves.
4. Sign the bundle with an Ed25519 (fallback ECDSA_NIST_P256) key held in a second HSM slot — the "witness checkpoint" key.
5. Publish inclusion proofs (Merkle audit paths) via `/v1/proof/leaf/{stream_id}/{tenant_seq}`.

Empty-interval checkpoints are emitted as **heartbeats** — `merkle_root = sha256(prev_checkpoint.merkle_root)` — so the absence of events is itself witnessed and cannot be silently backfilled. This is a specific design choice with potential independent-claim value (see Slice A, subclaim A.3).

### 2.4 Feature 4 — Public-ledger anchor via asset-issuance metadata

Every `anchor_epoch_secs` (86400s / 3600s / 3600s in current tiers), unanchored checkpoints across all streams are grouped and hashed into a "super-root" (balanced Merkle tree over checkpoint `merkle_root`s in `(stream_id, epoch_index)` order). The super-root is embedded onto a public blockchain by:

1. Issuing a Ravencoin asset (protocol prefix `RVN_ASSET`) whose `asset_data` field carries the SHA-256 of the super-root as raw 32 bytes. Anchor tag `SCR_<8 hex>`. Testnet in current embodiment; production would use RVN mainnet or a functionally equivalent asset-capable UTXO chain.
2. Pinning the anchor JSON (super-root + constituent checkpoint IDs + tree structure) to IPFS; the resulting CID (`bafkrei...`) is stored alongside the txid.
3. Recording the same anchor JSON as an Arweave transaction (permanent storage).

The three-anchor pattern (block-explorer-visible + content-addressed + permanent-storage) is deliberately redundant so no single ledger failure or delisting breaks the audit chain. Concrete embodiment for the puffjuly12 bundle:

- Merkle root: `29e9a40e1d436ce7c4aae2edd4c28bad73bfcece8e9477b9da9b43375543016c`
- RVN txid: `8f8f95867d1c9185a1f4439e12f3aad88f0697a41ee23874c1822e06bc5d9e93`
- IPFS CID: `bafkreickjxn3docjsbkwfaocbv37efl4sqwlb3t7mr2rayksok5cnacbva`
- Arweave tx: `ECrbDO8aojgCS3Fm51tL0AdwlJLrXUBUCIFhbwMd-Xw`

The asset-data-field encoding is protocol-agnostic — any blockchain that supports arbitrary immutable metadata inscription at asset creation time would substitute. Bitcoin OP_RETURN could substitute at the cost of 80-byte payload limits and higher fees; Ordinals-style inscription could substitute at higher permanence but higher cost.

### 2.5 Feature 5 — C2PA-vocabulary sidecar

The sidecar is a stand-alone file emitted alongside the trained-model file at `<model>.<ext>.c2pa` (e.g. `stay-puft-cyberpunk-lora-r4.safetensors.c2pa`). Content type: `application/c2pa` per C2PA v2.1 §11 (JUMBF box structure). The manifest carries:

- `c2pa.actions` — a single `c2pa.created` action with `digitalSourceType = http://cv.iptc.org/newscodes/digitalsourcetype/algorithmicMedia` and namespace-custom parameters (`com.scruple.project_id`, `com.scruple.scr_id`, `com.scruple.output_content_hash_sha256_hex`, `com.scruple.dataset_merkle_sha256_hex`, `com.scruple.leaf_scheme`).
- `c2pa.assertion.training-mining` — carries `training_run.{trainer, base_model.{path, sha256_hex}, dataset.{merkle_root_sha256_hex, image_count, caption_count}, lora.{output_filename, content_hash_sha256_hex, output_bytes, network_dim, network_alpha, rank, steps, resolution, learning_rate}, session_hash_sha256_hex, structural_layer_count}`. This is the C2PA v2.1-defined vocabulary applied to a training run — see C2PA v2.1 §18 (Training and Data Mining Assertions).
- `c2pa.hash.data` — `{alg: "sha256", hash: <32-byte CBOR bstr of the .safetensors whole-file digest>, name: <filename>, exclusions: [], pad: ""}`. Empty exclusions = whole-file hash. Encoded per C2PA v2.1 §17.10.
- `com.scruple.leaf` (custom assertion) — carries the leaf preimage fields, the Merkle inclusion path, the anchor tuple (`merkle_root_sha256_hex`, `rvn_txid`, `rvn_network`, `ipfs_cid`, `arweave_tx`), the witness identity, the signer pubkey SHA-256, and a storage pointer.

The manifest is signed with COSE_Sign1 per RFC 8152 §4.2, algorithm `ES256` (COSE alg id `-7`), with the signer end-entity certificate carried in the `x5chain` protected header per RFC 8152 §3.1 / RFC 9360 §2. The signing operation happens via `Signer.from_callback` in c2pa-rs 0.36 (`Builder.sign(signer, "c2pa", empty_stream, dst)`) — the private key never leaves the SoftHSM PKCS#11 boundary; the c2pa-rs library receives only the raw 64-byte R||S signature over the COSE_Sign1 tbsSigned octets.

The sidecar approach is a deliberate design choice over embedded manifests for `.safetensors` because (a) c2pa-rs 0.36 has no safetensors format handler as of this filing date, (b) modifying model bytes would break byte-identity for downstream loaders (HuggingFace `transformers`, `diffusers`, `peft`), and (c) sidecars are removable — an important requirement for open-source models where downstream users need a raw-weights option.

### 2.6 Feature 6 — Offline-verifiable chain

An auditor holding only:
- the model file bytes,
- the `.c2pa` sidecar,
- public Internet access (or no Internet + pre-fetched public data),

can independently perform:

1. **Byte-identity check** — SHA-256 the model file, compare to `c2pa.hash.data.hash` in the sidecar.
2. **Signature check** — parse the JUMBF manifest, extract COSE_Sign1 payload + signature, verify against the `x5chain` end-entity cert, verify the cert chain against a configured trust anchor list (C2PA trust list or standalone).
3. **Leaf check** — recompute the leaf preimage from `com.scruple.leaf`, SHA-256 to get `leaf_hash`, compare to `leaf.leaf_hash_sha256_hex`.
4. **Merkle inclusion** — walk the audit path from `leaf_hash` up to `anchor.merkle_root_sha256_hex` (single-iteration bundles have identity paths).
5. **Blockchain anchor** — fetch RVN transaction by `anchor.rvn_txid` from any RVN block explorer or full node, read the asset-issuance `asset_data` field, compare to `anchor.merkle_root_sha256_hex`.
6. **Redundant anchors** — fetch the Arweave transaction and the IPFS content to cross-check.
7. **Attestation-back-to-hardware** — fetch the SEV-SNP report via the trust manifest URL, fetch AMD ARK/ASK certs from `kdsintf.amd.com`, verify the report's VCEK signature chains to ARK, extract `report_data` (first 32 bytes), compare to SHA-256 of the sidecar's `signer_pubkey_sha256_hex`.

No step of this verification requires Scruple/Docent servers to be reachable, honest, or even to exist. This is the substantive property the invention delivers — cryptographic independence of the audit path from the issuer.

Reference verifier CLI in embodiment: `packages/scruple-verify/` (Node CLI, MJS modules, subcommand `scruple-verify c2pa <asset>`).

---

## 3. Prior Art Analysis

### 3.1 Prior art the inventor is aware of

The following table lists the closest public prior art. For each entry, "overlap" identifies the specific mechanism the reference shares with our architecture; "gap" identifies what our composition does that the reference does not.

| Reference | Overlap with our system | Gap where we may be novel |
|---|---|---|
| **SLSA — Supply-chain Levels for Software Artifacts** (Google-originated, now Linux Foundation OpenSSF; SLSA v1.0 spec at `slsa.dev`) | Hash-bound provenance manifests; in-toto attestations; verifier tooling | AI-model-training not a native concept in SLSA; no built-in blockchain anchor; no C2PA vocabulary; no hardware-RoT-attested signer as part of the profile |
| **in-toto** (NDSS 2019; `in-toto.io`) | Signed metadata for supply-chain steps; layout files declaring authorized functionaries | Software-oriented; no ML-training-specific fields; no anchoring to public blockchain; no C2PA vocabulary |
| **CycloneDX ML-BOM** (v1.5+) and **SPDX 3.0 AI package profile** | Structured description of ML model dependencies and datasets | Descriptive, not cryptographic-provenance-first; no chain-of-signatures; no blockchain anchor; no C2PA integration |
| **HuggingFace Model Cards** (Mitchell et al. 2019; HuggingFace `README.md` convention) | Informal provenance documentation | Not cryptographic; no verification; not tamper-evident |
| **C2PA v2.1 core spec** (`c2pa.org/specifications/specifications/2.1`) | Sidecar container format; JUMBF box structure; COSE_Sign1 signing profile; `c2pa.hash.data` and `c2pa.assertion.training-mining` assertion definitions; trust-list model | The spec is a vocabulary + container. It does not itself teach a blockchain anchor, a hardware-RoT-attested signer profile, or a canonical training-time leaf preimage schema. The composition — using C2PA vocabulary as one facet of a broader witnessed-training system — appears to be novel. Counsel to verify no C2PA WG normative work has claimed this. |
| **AMD SEV-SNP** (AMD publication 56860 rev 1.55; AMD Firmware ABI Spec 1.55) | The attestation platform and its `report_data` binding facility | Amd IP; not ours to claim. Application to C2PA-vocabulary AI provenance signing may be claimable as a use-composition. |
| **Ravencoin / Arweave / IPFS** | Public-ledger and content-addressed storage targets | Anchor targets, not claimed; the *pattern* of asset-data-field inscription of a Merkle super-root is what we might claim, not the ledger itself |
| **Adobe Content Credentials** (announced 2019; C2PA reference implementation; Firefly integration blog posts 2023-2024) | End-to-end use of C2PA to sign generative-AI outputs; sidecar and embedded flows | (Counsel to verify) Adobe's public disclosures center on image/video output at inference time; the inventor is not aware of Adobe public documentation of a training-time leaf composition combining dataset+workflow+machine-manifest+base-model+output hashes AND hardware-RoT signer AND public-blockchain super-root anchor. Adobe patent filings — see §7 bibliography — MUST be independently searched by counsel. |
| **Verisart** (art-authentication provenance; blockchain-anchored certificates) | Blockchain-anchored provenance at the physical-artwork level | Art domain, not ML model files; no training-time leaf composition |
| **Truepic** (capture-authenticity attestation; C2PA hardware-signed camera path) | Uses C2PA + hardware-attested signing (capture-side) | Capture-side, not training-side; different domain, different assertion set |
| **Numbers Protocol** (Capture app; NFT-anchored image provenance) | Public-ledger anchoring of media provenance | Media assets, not model files; no training-time record schema |

### 3.2 Additional prior-art references counsel should be aware of

The following are additional references the drafter should locate and read before drafting:

1. **"Model Cards for Model Reporting"** — Mitchell, Wu et al., FAccT 2019 (arXiv:1810.03993). Foundational for AI model documentation but explicitly informal, not cryptographic. Distinguishable by our composition's cryptographic and blockchain-anchored properties.
2. **SLSA-for-AI working proposals (2024-2025)** — the OpenSSF SLSA maintainers have discussed extending SLSA to AI/ML supply chains; counsel should search the OpenSSF `slsa` GitHub org for `ai`/`ml` proposals filed 2024-2025 (inventor is aware of discussion, unaware of any accepted normative work as of filing date).
3. **"Attesting AI Training Runs with Confidential Computing"** — inventor is aware of academic-workshop discussion of TEE-attested training but has not identified a specific reference that combines TEE attestation with C2PA vocabulary and public-ledger anchoring. Counsel to search: USENIX Security, ACM CCS 2023-2025; arXiv `cs.CR` for "trusted execution environment" + "model provenance".
4. **Certificate Transparency (RFC 6962 / 9162)** — the Merkle-tree-of-signed-leaves pattern is well-established here for X.509 certs. Our checkpoint/anchor pipeline is structurally similar (append-only log of leaves, signed tree heads, consistency proofs). Distinguishable by (a) leaf semantics (AI-model-training record, not X.509 cert), and (b) anchor to public blockchain rather than to a distributed log-operator quorum.
5. **Sigstore / Rekor** (`sigstore.dev`, Rekor transparency log) — code-signing transparency log built on the CT pattern. Counsel to consider the Rekor claim structure as prior art — Rekor supports arbitrary "hashedrekord" entries that could in principle carry a model-training payload. The distinguishing feature would be the specific composition of AI-training-context fields plus the anchor pipeline plus the hardware-RoT signer profile — not the general idea of a transparency log for AI.
6. **Google DeepMind's "Nature" watermarking paper (SynthID, 2023)** — output-watermarking of AI-generated content. Different problem (content-detection vs. training-provenance) but counsel should be aware.

### 3.3 The composition-novelty argument

Individual primitives are prior art:
- Merkle trees, hash chains, public-blockchain inscription, sidecar signing — all decades old.
- SEV-SNP attestation with `report_data` binding of a nonce or pubkey — AMD spec, not ours.
- C2PA sidecar format and `training-mining` assertion — C2PA WG spec, not ours.

The invention resides in **the specific composition** as a coherent, offline-verifiable system, deployed for AI model training artifacts. Post-*Alice Corp. v. CLS Bank Int'l*, 573 U.S. 208 (2014), pure abstract-idea claims to "witnessing AI training" will die at §101. Surviving claims must recite specific technical improvements over the closest prior art, which for us are (a) SLSA/in-toto (specific improvement: hardware-RoT-attested signer bound via `report_data` to a specific pubkey, and public-blockchain anchor rather than log-operator quorum), (b) C2PA v2.1 (specific improvement: canonical training-time leaf preimage schema binding six named training-context hashes, and the anchor-tuple custom assertion). These specific improvements are the load-bearing basis for the proposed claim slices in §4.

---

## 4. Proposed Claim Slices

Each subsection below drafts (a) a narrow specific-composition claim, (b) an aggressive abstract claim (with the warning that it likely fails §101), (c) design-around notes, and (d) prior art the claim must distinguish over. Claims are DRAFTS for counsel review, not filing-ready language.

### 4.1 Slice A — Canonical training-time leaf preimage with prev-chain and Merkle super-root anchor

**Narrow claim (specific composition).** A computer-implemented method for producing verifiable provenance of a trained machine-learning model, comprising:

1. computing a canonical training record comprising, in a fixed byte order, at least: (i) a first hash value that is the SHA-256 digest of a Merkle root computed over a training dataset comprising per-file image, caption, and label byte sequences; (ii) a second hash value that is the SHA-256 digest of a canonicalized JSON representation of the training workflow specifying at least a training script identifier, hyperparameter values, and a base-model reference; (iii) a third hash value that is the SHA-256 digest of a machine manifest specifying at least a container-image identifier, a plurality of pinned software component identifiers, and their corresponding commit or version identifiers; (iv) a fourth hash value that is the SHA-256 digest of a base-model file byte sequence; (v) a fifth hash value that is the SHA-256 digest of a trained-model output file byte sequence; and (vi) a prev-record hash chaining to a prior training record for the same project;
2. computing a leaf hash as the SHA-256 digest of the canonical training record;
3. including the leaf hash as a leaf in a balanced binary Merkle tree with at least one other leaf, and computing a checkpoint Merkle root;
4. inscribing the checkpoint Merkle root or a super-root derived therefrom onto a public blockchain by populating a metadata field of a blockchain transaction;
5. emitting an inclusion proof comprising an audit path from the leaf hash to the inscribed root;

wherein the inclusion proof, together with the training record and the public-blockchain transaction, is verifiable without any communication with the issuer of the training record.

*Subclaim A.3 (independent-claim candidate).* Wherein an empty-interval checkpoint whose leaf set is empty is emitted with `merkle_root = sha256(prior_checkpoint.merkle_root)` such that the absence of training runs during the interval is itself included in the anchored chain.

**Aggressive/abstract claim (likely fails Alice).** A method of witnessing AI model training comprising storing hashes of training inputs and outputs on a blockchain. *Warning: this reads as an abstract idea implemented on a generic computer; expected to die under Alice step 2 for lack of an inventive concept. Include only as a fallback / continuation seed if counsel judges it strategically useful; do not lead with.*

**Design-around by competitors.** A competitor could avoid this claim by omitting one of the six named hashes (e.g., skipping the machine-manifest hash), or by using a hash tree structure other than balanced binary Merkle, or by anchoring to a source other than a public blockchain (private permissioned ledger; TSA-only). Counsel should consider whether the "six-tuple" is too easily engineered around and whether a broader wrapper claim (three of six) is defensible.

**Prior art to distinguish.** SLSA provenance format (SLSA v1.0 predicate schema — see `slsa.dev/spec/v1.0/provenance`) uses `buildDefinition.externalParameters` and `runDetails.byproducts` but does not require the six-tuple training-time hash composition and does not require public-blockchain inscription. in-toto layout files declare functionaries and steps but likewise do not require the training-time composition or blockchain anchor. Certificate Transparency has the Merkle-tree structure but different leaf semantics.

### 4.2 Slice B — Hardware-attested signer bound to attestation report

**Narrow claim (specific composition).** A method for producing a hardware-attestable signing artifact for an AI model provenance record, comprising:

1. generating an asymmetric signing key pair inside a Hardware Security Module residing inside a Confidential Virtual Machine, wherein the Confidential Virtual Machine is instantiated on a hardware platform providing memory encryption and attestation via a hardware Root of Trust;
2. computing an attestation-binding value as the SHA-256 digest of the SubjectPublicKeyInfo DER encoding of the signing key's public component;
3. requesting an attestation report from the Confidential Virtual Machine's platform-provided attestation facility, populating a caller-provided data field of the report with the attestation-binding value;
4. receiving the attestation report, said report being signed by an endorsement key certified by the hardware platform manufacturer's certificate authority and containing a measurement of the Confidential Virtual Machine's boot image;
5. publishing the signing key's public component, the attestation report, and a manifest linking the two;
6. signing an AI model provenance record with the signing key via a callback interface that never exposes the signing key's private component to the address space of the provenance-generation process;

wherein a verifier holding the report, the public key, and the hardware platform manufacturer's public root certificate can independently confirm that the specific signing key was in possession of a Confidential Virtual Machine matching the attested boot image at the time of attestation.

**Aggressive/abstract claim (likely fails Alice).** A method of signing AI model records with a hardware-attested key. *Warning: too abstract; likely §101 casualty.*

**Design-around by competitors.** A competitor could avoid this claim by using a different TEE (Intel TDX, Nitro Enclave, ARM CCA) rather than SEV-SNP — but if the claim is drafted at the level of "Confidential Virtual Machine providing hardware-Root-of-Trust attestation" with `report_data`-equivalent semantics, the claim can cover the class without naming AMD-specific structures. Counsel should decide whether to file (a) a genus claim covering CVMs generally, and (b) narrower species claims to SEV-SNP, TDX, Nitro individually. Alternative design-around: use a physical HSM with in-HSM attestation (YubiHSM 2, Nitro Enclave with AWS KMS attestation) rather than an in-CVM SoftHSM — the *specific composition* of SoftHSM-in-CVM may be distinguishable from HSM-with-native-attestation.

**Prior art to distinguish.** AMD SEV-SNP itself, RATS (IETF Remote ATtestation procedureS, RFC 9334), AWS Nitro Enclave attestation documents. The distinguishing feature is not the attestation platform but the **use-composition** in the C2PA-vocabulary AI provenance signing profile, and specifically the `report_data`-populated-with-pubkey-SPKI-hash technique used to bind the signing key to the attested VM. The `report_data` binding of an ephemeral nonce is documented in AMD's spec; the *specific binding of an AI-provenance signer key's SPKI hash* into that field, as part of a C2PA training-mining signing profile, appears novel. Counsel to search AMD, Microsoft, Google, and AWS filings for TEE-attested-signer patents.

### 4.3 Slice C — C2PA sidecar profile for AI model files with anchor-tuple custom assertion

**Narrow claim (specific composition).** A method for emitting an offline-verifiable provenance sidecar for a trained-machine-learning-model file, comprising:

1. producing a sidecar container file separate from the trained-model file, said sidecar container conforming to the JUMBF box structure per the C2PA v2.1 core specification;
2. embedding in the sidecar container a first standard assertion binding the trained-model file's whole-file SHA-256 digest via the C2PA `hash.data` assertion with an empty exclusion set;
3. embedding a second standard assertion carrying training-context metadata via the C2PA `assertion.training-mining` assertion including at least a dataset Merkle-root digest and a base-model digest;
4. embedding a namespace-custom assertion carrying an anchor tuple comprising at least (i) a Merkle root of an audit log, (ii) a public-blockchain transaction identifier, (iii) a content-addressed-storage content identifier, and (iv) a permanent-storage transaction identifier;
5. signing the manifest with COSE_Sign1 per RFC 8152 using algorithm ES256, wherein the end-entity certificate chain is carried in an x5chain protected header;

wherein a verifier can, using only the trained-model file and the sidecar container, independently confirm (a) byte identity between the trained-model file and the sidecar-declared hash, (b) validity of the COSE_Sign1 signature, and (c) inclusion of the sidecar-declared leaf in a Merkle root anchored on a public blockchain.

**Aggressive/abstract claim (likely fails Alice).** Any C2PA-format sidecar for an AI model file. *Warning: overbroad; the C2PA WG's normative work claims the format itself.*

**Design-around by competitors.** Embed the manifest inside the model file's metadata region (e.g., a `.safetensors` custom header field) rather than as a sidecar. Counsel should consider whether a companion "embedded manifest" claim is worth filing — the manifest content is the same; only the container differs. Alternative: use a non-C2PA container format carrying the same data. This design-around risk suggests we should either (a) file both container variants, or (b) draft the claim at "structured provenance container" level with C2PA JUMBF and safetensors-embedded as dependent species.

**Prior art to distinguish.** C2PA v2.1 defines the container and the two standard assertion labels but does not require the specific composition with the anchor-tuple custom assertion or the specific use for `.safetensors` model files. Adobe Content Credentials' shipped implementations focus on image/video generative content; counsel MUST verify Adobe has not filed a training-artifact sidecar patent — this is the highest-risk overlap.

### 4.4 Slice D — End-to-end offline verification path

**Narrow claim (specific composition).** A method for verifying provenance of a trained-machine-learning-model file without communication with the model's issuer, comprising:

1. receiving the trained-model file and a sidecar container conforming to a JUMBF box structure;
2. computing the SHA-256 digest of the trained-model file's byte content and comparing it to a standard hash assertion within the sidecar container;
3. extracting a COSE_Sign1 signature and an x5chain certificate chain from the sidecar and verifying the signature against the end-entity certificate;
4. extracting from a namespace-custom assertion within the sidecar (i) a leaf-hash value, (ii) a Merkle audit path, (iii) a Merkle root, (iv) a public-blockchain transaction identifier;
5. recomputing the leaf hash from the leaf preimage and verifying it matches the extracted leaf-hash value;
6. walking the audit path from the leaf hash and confirming the resulting root matches the extracted Merkle root;
7. querying a public source for the public-blockchain transaction and reading a metadata field of the transaction, comparing said metadata field to the extracted Merkle root;
8. optionally fetching, from the hardware platform manufacturer's public certificate authority, certificates sufficient to verify a hardware-attestation report referenced in the sidecar, and confirming the signer's public key SubjectPublicKeyInfo digest matches a value bound into the attestation report;

wherein the verification succeeds only if all of the above steps produce matching values, and the verification requires no communication with the issuer of the trained-model file.

**Aggressive/abstract claim.** Not attempted; verification-side claims tend to be difficult under Alice because verification is inherently mental-step-adjacent.

**Design-around by competitors.** A competitor could split verification across multiple sidecars, add an issuer-hosted lookup step, or omit the hardware-attestation branch. The claim should recite the specific improvement — offline-verifiability without issuer cooperation — clearly enough that competitors relying on issuer-hosted lookups do NOT infringe (which is fine — it's exactly the property we're claiming as inventive).

**Prior art to distinguish.** SLSA verifier, in-toto verifier, Sigstore's `cosign verify-blob` — all require some form of transparency-log or key-server availability at verification time. Certificate Transparency verification requires reachable log operators. Our specific improvement is the anchor-to-public-blockchain-plus-Arweave path — verification is independent of any single operator's continued cooperation.

### 4.5 Slice E — Runtime tier gate spinning up CVM signer per revenue

**Business-method warning.** This slice describes the "spin up the CVM only when a paid tier requires it" cost pattern. Post-*Alice*, business methods without a specific technical improvement typically fail §101 (see *Bilski v. Kappos*, 561 U.S. 593 (2010), and its progeny). The inventor's honest assessment: this slice is unlikely to survive §101 scrutiny as a standalone claim. Flagged for counsel's consideration only.

If pursued, the specific-composition draft would be: a method comprising receiving a request for a signing operation, determining whether the requesting tenant is entitled to a hardware-attested-signer tier, and if so provisioning the Confidential Virtual Machine on-demand from a cloud-provider API, waiting for the CVM's SEV-SNP attestation report to become available, executing the signing operation inside the CVM, and destroying the CVM after a configurable retention window. Even this drafting risks abstract-idea rejection because the "spin up on demand" pattern is generic cloud economics. Counsel should decide whether to file this as a defensive publication (public disclosure to prevent others from claiming) rather than as a patent application.

---

## 5. Filing Strategy Recommendations

### 5.1 New provisional vs. continuation-in-part of prior filings

Per inventor's memory records, Scruple/Docent has provisional filings in the pipeline referenced as "Filing 2" (PCT scheduled for January) and "Filing 3" (PCT scheduled for March). The inventor has not attached the specifications of those filings to this brief. Counsel should first pull those specifications and determine:

- **Written-description overlap.** Do Filings 2 or 3 already contain enabling text for any of the six features in §2? If yes → CIP is preferable (retains priority date for supported subject matter). If no → new provisional buys priority for the new subject matter but does NOT retroactively bootstrap the older filings.
- **Inventorship.** If Filings 2 and 3 have different named inventors than would be named on this new subject matter, CIP creates an inventorship-mismatch problem better handled via new provisional.

Inventor's preliminary recommendation: **file a new provisional immediately** capturing all six features (Slices A-D) with the concrete embodiment references (commits 7497f78 and 8adb9ff, and the L2 evidence bundle at `docs/l2-evidence/2026-07-12T174954Z/`). Then, within 12 months, decide whether the PCT filing extends the new provisional standalone or consolidates with Filings 2/3 as a CIP.

### 5.2 One application vs. split into multiple

Inventor's recommendation is **one provisional covering all four viable slices (A-D)** for priority-date reasons, followed by **strategic splitting into up to three non-provisional applications** at the 12-month conversion point:

- **Application I — Witnessed AI training composition** (Slice A): dataset+workflow+machine-manifest+base-model+output hashes → canonical leaf → Merkle → public-blockchain anchor.
- **Application II — Hardware-attested C2PA signer** (Slice B): SEV-SNP-attested SoftHSM signer bound via `report_data` in the C2PA signing profile.
- **Application III — C2PA sidecar for AI model files with anchor-tuple assertion + offline verification** (Slices C+D): sidecar profile + end-to-end verifier flow.

Splitting into three lets each application present a coherent inventive concept with a clean §112 written description. It also lets counsel calibrate claim scope per application to the closest prior art. Downside: three times the prosecution cost, three examiner interviews, three potential §101 arguments.

### 5.3 Which claims to file provisionally vs. save for PCT

- **Provisional (this filing):** all four slices A-D with narrow specific-composition claims + full enabling specification (~80-120 pages of the technical description in §2 expanded with figures). No abstract claims — provisional dies at 12 months anyway, so include only what enables and disclose everything.
- **PCT (12 months out):** claim strategy locked based on prior-art searches performed during the 12-month interval. Counsel should conduct a formal freedom-to-operate + prior-art search covering Adobe, Google, Microsoft, AWS, Truepic, Verisart, Numbers Protocol, and Sony filings during months 1-6. Post-search, refine claim scope in each of the three planned non-provisionals.

### 5.4 Alice-eligibility discipline

Post-*Alice*, the surviving-claim playbook for software:

1. **Recite specific technical improvements over identified closest prior art.** The specific improvements over SLSA (blockchain-anchored super-root; hardware-RoT-attested signer profile) and over C2PA v2.1 (canonical training-time leaf preimage; anchor-tuple custom assertion; SoftHSM-in-CVM signing) are the load-bearing basis for §101.
2. **Anchor to specific technical structures.** Cite SEV-SNP `report_data` field, COSE_Sign1 x5chain header, JUMBF box structure, SHA-256, ES256 — specific technical facilities, not abstract "cryptography."
3. **Avoid pure information-manipulation framings.** "A method of witnessing training" is bad; "a method of populating a hardware-attestation report's caller-provided data field with the SHA-256 of a signer public-key SPKI DER encoding to bind the signer to an attested boot image" is better.
4. **Include use-and-effect claims that recite the technical improvement's downstream benefit.** "Wherein the inclusion proof, together with the training record and the public-blockchain transaction, is verifiable without any communication with the issuer" is the kind of language that helps at Alice step 2.
5. **Include concrete embodiment specifications** so §112 is unassailable and prosecution has room to narrow if §101 is challenged.

### 5.5 Foreign-filing considerations

The AI-content-provenance market is global; EU AI Act Article 50 creates a European regulatory pull for this technology. Recommendation: file PCT covering EPO, JP, KR national phases. China (CN) is likely valuable for defensive purposes even if enforcement is limited. Discuss cost tradeoffs with client.

---

## 6. Open Questions for Counsel

The inventor requests counsel's judgment on the following:

1. **Use-case vs. architecture claims.** Should we include use-case-framed claims (e.g., "a method of certifying a LoRA training run for marketplace listing"), or restrict to architecture claims and let the use cases fall out naturally? Inventor lean: architecture claims plus one or two illustrative use-case claims as continuation seeds. Use-case-heavy claims risk being read as method-of-organizing-human-activity claims that fail Alice.
2. **Design-around risk if competitors embed the manifest inside `.safetensors` rather than as a sidecar.** The manifest content is identical; only the container differs. Is a wrapper claim at "structured provenance container" level defensible against both variants, or do we need to file both explicitly? Related: the C2PA WG is discussing safetensors-native manifest handling for a future version of `c2pa-rs`. If that ships, sidecar-only claims become weaker.
3. **Foreign filing scope.** EPO and JP are natural given the market; are there jurisdictions (KR, IN, BR) where cost-benefit is favorable given AI-regulation trajectory? Should we file in CN even without expectation of enforcement, purely to prevent Chinese competitors from claiming?
4. **C2PA WG interaction.** The C2PA Working Group's normative work might, at some future revision, incorporate patterns similar to our anchor-tuple custom assertion. Should we (a) offer FRAND terms upstream to the C2PA WG to avoid a normative-blocking situation, (b) wait until we have granted claims before engaging, or (c) file both upstream and prosecute the patent? Inventor lean: engage the C2PA WG with a FRAND-terms letter of intent once the provisional is on file — the goodwill helps our marketplace positioning and the letter doesn't reduce our claim value if we later assert.
5. **Defensive publication for Slice E.** Should we defensive-publish the runtime-tier-gate business method (spin-up-CVM-per-paid-tier) rather than let a competitor claim it later? Cost of defensive publication is trivial vs. leaving it uncovered.

---

## 7. Bibliography

### 7.1 Standards and specifications

- **AMD Secure Encrypted Virtualization** — AMD Publication 55766 ("SEV Secure Nested Paging Firmware ABI Specification"), current revision 1.55 (2024). Available from `developer.amd.com/sev`.
- **AMD SEV-SNP whitepaper** — AMD Publication 56860 rev. 1.55 ("SEV-SNP: Strengthening VM Isolation with Integrity Protection and More").
- **C2PA Core Specification v2.1** — Coalition for Content Provenance and Authenticity, `c2pa.org/specifications/specifications/2.1/specs/C2PA_Specification.html`. Sections cited: §11 (JUMBF), §17.10 (`hash.data`), §18 (Training and Data Mining Assertions).
- **C2PA Generator Product Security Requirements (GPSR) v0.1** (June 2025) — `c2pa-org/conformance-public` repo on GitHub. Sections cited: §6.1.2, §6.2.2, §6.3.2, Appendix B.3, Appendix B.4, Appendix C.
- **CBOR Object Signing and Encryption (COSE)** — RFC 8152 (Schaad, 2017) — cited for §4.2 COSE_Sign1 and §3.1 protected-header carrying. RFC 9052/9053 (2022) supersede RFC 8152 for new work; counsel should reference both.
- **COSE x5chain header parameter** — RFC 9360 §2.
- **Concise Signing and Encryption Header Params** — RFC 8747 (proof-of-possession); RFC 9334 (RATS Architecture, IETF Remote ATtestation procedureS).
- **RFC 3161 Time-Stamp Protocol (TSP)**, RFC 5816 update (ESSCertIDv2).
- **eIDAS Regulation** — Regulation (EU) 910/2014, particularly Article 42 (qualified electronic time stamps).
- **SHA-256** — FIPS PUB 180-4, §6.2.
- **`.safetensors` format** — HuggingFace `safetensors` GitHub repo; format specification.
- **JUMBF (ISO 19566-5)** — JPEG Universal Metadata Box Format, referenced by the C2PA spec for the manifest container.

### 7.2 Prior-art references (patent numbers to verify)

Counsel MUST independently verify all patent numbers below. Inventor cites them as starting points, not confirmed facts.

- **Adobe Content Credentials patents** — inventor is aware Adobe has filed multiple patents around Content Credentials / C2PA integration in Photoshop, Firefly, and camera integration. Counsel should search USPTO Public PAIR for Adobe assignee filings 2019-present in class G06F 21/60 (data protection) and G06T 1/00 (image processing). Publication numbers to check as starting points (**inventor uncertain of exact numbers — counsel to verify**): US2022/0405368; US2023/0106584. Do not rely on these numbers without independent verification.
- **Verisart patents** — art-authentication blockchain provenance filings. Counsel to search USPTO and EPO. Verisart Ltd. as assignee.
- **Truepic patents** — capture-authenticity, camera-attestation, C2PA-hardware-signer patents. Counsel to search USPTO for Truepic Inc. filings.
- **Numbers Protocol / Numbers Co. patents** — Capture app, NFT-anchored image provenance. Counsel to search USPTO and international filings.
- **Sony camera attestation patents** — Alpha camera line with C2PA signing at capture (Sony Semiconductor Solutions filings 2023-2025).

### 7.3 Standards / open-source references

- **SLSA v1.0** — `slsa.dev/spec/v1.0/`.
- **in-toto** — `in-toto.io`; Torres-Arias et al., "in-toto: Providing farm-to-table guarantees for bits and bytes", USENIX Security 2019.
- **Sigstore / Rekor** — `sigstore.dev`; Newman et al., "Sigstore: Software Signing for Everybody", ACM CCS 2023.
- **Certificate Transparency** — RFC 6962 (Laurie et al., 2013), RFC 9162 (Certificate Transparency v2).
- **CycloneDX ML-BOM** — `cyclonedx.org/capabilities/mlbom/`.
- **SPDX 3.0 AI package profile** — `spdx.dev/use/specifications/`.

### 7.4 Concrete embodiment references (Docent internal)

- Commit `7497f78` — puffjuly12 end-to-end demo bundle (5 FLUX iterations, C2PA-signed, Merkle root anchored to RVN testnet + IPFS + Arweave).
- Commit `8adb9ff` — Project 181 LoRA sidecar (`.safetensors.c2pa` external manifest).
- Commit `0d45097` — WO-03 + WO-08 + WO-10 C2PA signer refactor to callback + witness leaf emission + E2E green.
- `docs/l2-evidence/2026-07-12T174954Z/` — SEV-SNP evidence bundle with attestation report, VCEK, AMD cert chain, VM measurement, `report_data`-bound SoftHSM pubkey.
- `docs/provenance-bundles/bundle-29e9a40e1d43/` — full puffjuly12 bundle including 5 iterations, L2 substrate, witness checkpoint, `MANIFEST.sha256`, and the Project 181 training sidecar.
- `docs/architecture/CANONICAL_SCRUPLE_WITNESSING_L2.md` — canonical design document, §18 in particular for SEV-SNP + SoftHSM.
- `docs/architecture/SCRUPLE_CONTINUOUS_AUDIT_API_DESIGN.md` — Continuous Audit API schema and leaf-canonicalization details.
- `lib/witness/canonicalLeafV23.ts` and `services/witness/canonical_leaf_v23.py` — canonical leaf implementation (parity-tested twins).
- `packages/scruple-verify/` — offline verifier CLI (Slice D embodiment).

### 7.5 Related Docent filings (per inventor memory)

- Filing 2 — PCT scheduled January (subject matter: witnessing / Merkle checkpoint / TME orchestrator — counsel to confirm exact scope).
- Filing 3 — PCT scheduled March (subject matter: Kids Mode conductor-mediated safety — counsel to confirm exact scope and whether relevant to the current subject matter).

Counsel should pull specifications for Filings 2 and 3 to determine written-description overlap with this brief before drafting §5.1's CIP-vs-new-provisional decision.

---

**End of brief.** Total intended length: ~5,600 words. Any inaccuracies in prior-art characterization are the inventor's; counsel is invited to correct and refine.
