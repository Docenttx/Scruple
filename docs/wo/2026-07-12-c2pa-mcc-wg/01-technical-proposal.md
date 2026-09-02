# Scruple's Sidecar-Plus-Hash-Chain Reference Architecture for ML Model Content Credentials

**Author:** Docent Technologies LLC (product: **Scruple**)
**Target audience:** C2PA Technical Working Group task force covering AI/ML content credentials; Creator Assertions Working Group
**Status:** Draft, external-facing. Prepared for WG submission alongside the accompanying membership application (see `00-membership-application.md`).
**Version:** 0.1 (2026-07-12)
**Reference bundle:** `docs/provenance-bundles/bundle-29e9a40e1d43/`
**L2 evidence bundle:** `docs/l2-evidence/2026-07-12T174954Z/`

---

## 1. Executive summary

The C2PA specification, through version 2.4, does not yet define a normative Model Content Credential. The v2.2 and v2.4 AI/ML guidance documents explicitly identify this as a future work area. Public tooling reflects the gap: `c2pa-rs` ships no `Builder` handler for `.safetensors`, `.pt`, or `.onnx`; c2pa-python inherits that limitation; the IntelLabs `atlas-c2pa-lib` remains research-stage. As a practical matter, no vendor is publicly shipping production Content Credentials bound to trained model weights today.

We propose a sidecar-plus-hash-chain architecture for ML model Content Credentials, and offer our shipping implementation as a candidate reference. Under this design the model file is left byte-identical; a separate `.c2pa` external manifest store carries the signed assertions; the model file is bound into the manifest by SHA-256 in `c2pa.hash.data`; a training-mining assertion records the training run; and a namespace-custom assertion carries a Merkle-tree leaf together with blockchain, IPFS, and Arweave anchors so that offline verifiers can walk the whole chain without contacting the issuer.

We believe this architecture is the right compromise across four constraints the WG's normative work will need to satisfy: (a) byte-preservation for downstream tools, (b) hardware Root-of-Trust for L2 signers, (c) chain-anchored offline verifiability, and (d) no new format-container handlers required in `c2pa-rs`. This document describes the architecture, points to the shipping reference implementation, compares against the alternatives the WG is known to be considering, and lists open questions we would like the WG to help resolve.

## 2. Problem statement

### 2.1 Current state of ML model provenance

C2PA v2.4 provides mature Content Credentials for still images, video, and audio. Model files sit outside that surface. The v2.2 AI/ML guidance addresses model provenance obliquely: it recommends "ingredient assertions with URI references and hard bindings" and, for multi-file models, "a top-level manifest for the model, and providing an asset reference assertion for each file." It also notes that "existing machine learning datasets are either text or binary files which prevents the embedding of a C2PA Manifest in the file" and endorses sidecar manifests for such cases. The same reasoning applies to model files.

The Creator Assertions Working Group publishes a training-and-data-mining assertion (label `cawg.training-mining`, v1.0 approved 2024-03-18) that lets a content owner declare permissions — `allowed`, `constrained`, `notAllowed` — for uses like `cawg.ai_training`, `cawg.ai_generative_training`, and `cawg.data_mining`. This assertion is well-designed for the "may this asset be used to train?" question, but does not itself describe "this asset *is* the trained weights, and here is what it was trained on." That descriptive/provenance role remains uncovered.

### 2.2 Gaps in c2pa-rs and c2pa-python

`c2pa-rs` presents a `Builder` API that requires a format-specific handler to parse and rewrite the source container. The library ships handlers for images (JPEG, PNG, HEIC, AVIF, TIFF, WebP), video (MP4, MOV), audio (WAV, MP3, M4A, FLAC), and a handful of documents (PDF). It does not ship a `.safetensors` handler. `.pt` (PyTorch pickle) and `.onnx` (protobuf) are also unhandled. c2pa-python 0.36 wraps c2pa-rs and inherits the same gap.

An implementer wanting to embed a JUMBF box inside a `.safetensors` file today would have to (a) understand the safetensors header format, (b) modify the file bytes without invalidating the header length prefix, (c) accept that every existing downstream loader that hashes the model file will now see a different SHA-256, and (d) submit an upstream PR against a Hugging-Face-controlled format specification. None of that is trivially achievable, and (c) alone is disqualifying for many downstream workflows.

### 2.3 The "modifying model bytes breaks byte-identity" problem

Downstream ML tooling — `diffusers`, ComfyUI, kohya-ss, the Hugging Face Hub, `transformers`, `peft` — key model caches, integrity checks, model-registry entries, and license attribution to the whole-file SHA-256 of the model container. Any Content Credential mechanism that mutates the model bytes forks the ecosystem: pre-C2PA and post-C2PA copies of the same weights will hash differently, break cache reuse, and (in HF Hub's case) require a re-upload and re-verification cycle for every model that adopts the standard.

### 2.4 The "no consensus on where to put JUMBF" problem

The WG has been discussing three broad approaches to model-file Content Credentials — embed JUMBF into the container, ship a separate sidecar file, or hash-bind the model into a chain-of-custody record. Each has proponents. None has landed in `c2pa-rs`. We think the sidecar-plus-hash-chain approach captures the strengths of the other two while paying the cost of neither, and we describe it in Section 3.

## 3. Proposed architecture

### 3.1 The four-layer stack

Our shipping architecture stacks four verification layers, bottom-to-top:

1. **Chain-anchored blockchain proof.** The provenance record's Merkle root is committed to a public blockchain (Ravencoin testnet today, with mainnet migration on our roadmap). This gives an auditor an issuer-independent timestamp and integrity anchor.
2. **Merkle tree of witness leaves.** For a multi-iteration training or generation run, each iteration's canonical record hashes to a leaf; the leaves reduce to a single Merkle root. For a single-iteration training run, the leaf is the root. The root is signed by a dedicated Ed25519 checkpoint key (`witness signer pubkey SHA-256: 406afbff4401344692b635aca58bc0430349a07fc33acba00b52c4313064a4bc` in the reference bundle).
3. **Canonical training-time record.** A JSON preimage per iteration or per training run, hashed to form the leaf. The preimage schema includes: `workflow_hash`, `model_fingerprints_hash`, `machine_manifest_hash`, `training_dataset_hash`, `output_hash`, and `prev_record_hash`. This record is what a compliance auditor examines to answer "what exactly happened during this training run."
4. **External `.c2pa` sidecar.** A JUMBF-wrapped, COSE_Sign1-signed C2PA manifest store, delivered as a sibling file to the model weights (e.g. `stay-puft-cyberpunk-lora-r4.safetensors.c2pa` next to `stay-puft-cyberpunk-lora-r4.safetensors`). Signed with an ES256 key rooted in a hardware-attested substrate.

### 3.2 Leaf preimage schema

For the reference bundle, each leaf's preimage is a canonical JSON object:

```jsonc
{
  "iteration": <int>,
  "output_sha256": "<64 hex>",
  "signed_output_sha256": "<64 hex>",   // for signed-media leaves
  "workflow_sha256": "<64 hex>",
  "modal_prompt_id": "<uuid>",
  "modal_gpu": "T4",
  "c2pa_reader_state": "Valid"
}
```

For training leaves the shape extends with `model_fingerprints_hash`, `training_dataset_hash`, and `machine_manifest_hash`. Concrete example from `iterations/1/`:

```
output_sha256:        3a2f0adf0fe0f8f3b2ad39d81ceee69a865bd09d1d2695a6990113003c8a09d9
signed_output_sha256: 91e8a75a54631e53185b01fcb052c12569ecc7dfcc66f1be9d183e9d46f92912
workflow_sha256:      e318c264043999ecf81d7249b4ccf458c5139c275ee97953da16f27f243932eb
leaf_hash:            e3b7e76cd200f15513c7592a4740439c9009e0a8c797f3d82414e05cba8de5e9
```

The five leaves reduce to the bundle Merkle root `29e9a40e1d436ce7c4aae2edd4c28bad73bfcece8e9477b9da9b43375543016c`, which is committed on-chain as Ravencoin testnet asset `SCR_3DE79573`.

### 3.3 Signing key architecture

The C2PA signing key is an ES256 (P-256, ECDSA, SHA-256) key generated inside a SoftHSM 2 token running inside an AMD SEV-SNP Confidential VM on Oracle Cloud Infrastructure. The SoftHSM DB resides only on the CVM's memory-encrypted disk, gated by a PIN required for every signing operation.

The AMD SEV-SNP attestation report (`sev-snp-report.bin`, ABI v5, 1184 bytes) binds the SoftHSM public key into the platform Root of Trust by placing `SHA-256(SPKI_DER(pubkey))` into the report's 64-byte `report_data` field. Our captured evidence at `docs/l2-evidence/2026-07-12T174954Z/` gives concrete values:

```
VM measurement:            7237c44bfc842925afa7860596631e8b7e28bcb679fc15c443e1a091c6ec3d1999b90c43b0580a414dde18cb3efbd45a
chip_id (VCEK anchor):     bd296e674119acb7367311bf0be06eaf0f6d15b5f0fc78d4f38653f46ca48baa285388d4f07f2964fa62ede902111de6115ada7b4f0289b2beaeae49e7a65aa4
reported TCB:              0x581c00000000000a
SoftHSM pubkey SPKI SHA-256: d5b782d80eb3e4f38ac8a54c1ff6ef496fb30fb841f0ebf417996eb73c7398ab
```

The signer certificate is a two-cert `x5chain`: a leaf issued by a distinct root CA over the SoftHSM public key, with an EKU of `documentSigning` and `emailProtection` (both required by c2pa-rs 0.86; see §3.5 below). The manifest is COSE_Sign1 with header alg `-7` (ES256, per RFC 8152 §8.1), and the `x5chain` header carries both DER-encoded certs so an offline verifier can walk to the root without a network fetch.

The witness Ed25519 key is a distinct key with its own attested substrate story (see the L2 evidence bundle). Separating the two keys — one for C2PA COSE_Sign1 signatures on individual assets, one for periodic Merkle-checkpoint signatures — gives us key-rotation and revocation independence, and lets us align each key with its own certificate profile.

### 3.4 Assertion vocabulary

The signed manifest carries three assertions:

**`c2pa.actions`.** A `c2pa.created` action with `digitalSourceType` `http://cv.iptc.org/newscodes/digitalsourcetype/algorithmicMedia` (as recommended by the C2PA AI/ML guidance for AI-generated assets). The action's `parameters` map carries Scruple's namespace-custom keys (`com.scruple.project_id`, `com.scruple.scr_id`, `com.scruple.output_filename`, `com.scruple.output_content_hash_sha256_hex`, `com.scruple.dataset_merkle_sha256_hex`, `com.scruple.leaf_scheme`, `com.scruple.trainer`, `com.scruple.output_bytes`) as immediate, human-inspectable action provenance.

**`c2pa.assertion.training-mining`.** A training-run description. We stress candidly that this label is **not** presently a normative C2PA or CAWG label — the CAWG-normative label is `cawg.training-mining` and its schema addresses permissions, not training telemetry. Our shipping assertion carries a `training_run` sub-object with:

- `trainer` and `trainer_family` (e.g. `"diffusers+peft"`, `"kohya-ss / diffusers+peft"`)
- `base_model.{path, sha256_hex}` — the SDXL 1.0 or FLUX base referenced by the training script
- `dataset.{merkle_root_sha256_hex, image_count, caption_count}`
- `lora.{output_filename, content_hash_sha256_hex, output_bytes, network_dim, network_alpha, rank, steps, resolution, learning_rate}`
- `session_hash_sha256_hex` — hash over the canonical training-session record
- `structural_layer_count` — for PEFT LoRAs, the count of adapted attention layers (1,120 for Project 181)

For the WG's review, we propose either (a) landing this training-provenance schema as a new sub-branch inside `cawg.training-mining`, keeping the permission tri-state alongside a descriptive `training_run` block, or (b) minting a sibling assertion — for example `cawg.training-provenance` — reserved for the descriptive role.

**`c2pa.hash.data`.** The model file's whole-file SHA-256, encoded as a 32-byte CBOR byte string in the `hash` field, with `alg: sha256`. This is the only mechanism binding the manifest to the model bytes. Our shipping implementation stores the hash as raw bytes, not as a base64 or hex string; we found (see §5) that c2pa-python 0.36's JSON-to-CBOR serializer requires the hash be passed as an array of ints for the resulting CBOR bstr to carry the raw 32 bytes rather than the ASCII of a base64 string. This is a c2pa-python detail, not a spec ambiguity — we mention it because it caught us and may catch other implementers.

**`com.scruple.leaf`** (namespace-custom). A structured object carrying:

- `anchor.{merkle_root_sha256_hex, package_hash_sha256_hex, rvn_txid, rvn_network, ipfs_cid, arweave_tx, iteration_count, witnessed_count}`
- `leaf.{leaf_hash_sha256_hex, output_hash_sha256_hex, model_fingerprints_hash_sha256_hex, workflow_hash_sha256_hex, machine_manifest_hash_sha256_hex, previous_hash_sha256_hex, run_sequence, scheme}`
- `project.{id, name, scr_id, status, locked_at, type}`
- `witness.{witness_id, witness_signature, witness_timestamp}`
- `signer_pubkey_sha256_hex` — cross-binding to the L2 signer

We propose this shape as the basis for a normative `c2pa.provenance-anchor` assertion. Concrete values live in every iteration's `verification-report.json` in the reference bundle.

### 3.5 Sidecar container

The sidecar is produced by calling `c2pa.Builder.sign(signer, "c2pa", empty_source, dst_stream)`. Passing the format literal `"c2pa"` instructs c2pa-rs to treat the manifest store as its own self-contained asset, which is the external-manifest format the C2PA spec provides for cases where the source container does not admit embedded JUMBF (see §2.1). The empty source stream lets the sign call succeed without needing to parse a `.safetensors` header. The resulting bytes are a JUMBF superbox containing an assertions box, a claim box, and a signature box holding a COSE_Sign1 (ES256, `x5chain` in the protected header).

For the Project 181 LoRA the sidecar is 16,498 bytes. Sidecar SHA-256 is `39b5efae880261776bd4b2e526752538c5d6484ce52d5c66041bdbd4996d72ee`. (Corrected 2026-09-02: the previous value corresponded to nothing shipped and contradicted the bundle's own `verification-report.json`, which already recorded the correct digest. The 16,498-byte length was right, so it was the same artifact with a wrong digest printed beside it. F-04.) Manifest first 16 bytes are `000040726a756d620000001e6a756d64`, which is the JUMBF `jumb ` + `jumd ` header sequence — a decomposer can confirm the container shape without a C2PA library.

Naming convention: `<model>.<ext>.c2pa` sits alongside `<model>.<ext>`. We recommend the WG standardize this convention (see Section 7).

## 4. Verification path

We describe the offline verification path an auditor holding only `stay-puft-cyberpunk-lora-r4.safetensors` and its sidecar `stay-puft-cyberpunk-lora-r4.safetensors.c2pa` would follow. No access to Scruple servers is required at any step.

**Note added 2026-09-02, before transmission.** That premise was true of the design and false of what we shipped: the provenance bundle contained the sidecar but **not the model**, so a reviewer doing exactly what Step 1 says had nothing to hash. The model file was also absent from the artifact store — iteration 170 carried a non-content-addressed `source_file` — and was recovered from the Drive substrate, its digest re-verified as `3141eb75…`, which independently confirms the F-01 correction above. **Any package transmitted must ship the model beside the sidecar**, or this section must name where the reviewer obtains it. See `docs/canon/FILING_CORRECTIONS.md` F-05.

**Step 1 — Hash the model.** Compute `sha256sum stay-puft-cyberpunk-lora-r4.safetensors` and confirm the result equals `3141eb757d4dbc6b9ef5eb33cb7c7ab8334b8598fef18a007b515d2722bbe900`. This is the value stored in the sidecar's `c2pa.hash.data.hash` CBOR field (raw 32-byte bstr at byte offset 1864 of the 16,498-byte sidecar). **Corrected 2026-09-02.** This step previously named the BASE model's digest, so a reviewer following it exactly got a mismatch — the exact signature of tampering, produced by our own prose. `docs/canon/FILING_CORRECTIONS.md` F-01.

**Step 2 — Extract and inspect the manifest.** Parse the JUMBF container in the sidecar; extract the assertions box, the claim box, and the signature box. Verify the assertion labels present (`c2pa.actions.v2`, `c2pa.assertion.training-mining`, `com.scruple.leaf`) and confirm the stored `c2pa.hash.data.hash` matches the model's computed SHA-256.

**Step 3 — Verify the COSE_Sign1.** Confirm the protected header's `alg` is `-7` (ES256), extract the `x5chain`, parse the leaf certificate. Confirm the leaf certificate's DN has full C/ST/L/O/OU/CN fields, that the certificate is issued by a distinct root CA (also in `x5chain`), and that the leaf has EKU `emailProtection` marked critical (per the c2pa-rs 0.86 profile check we documented in commit `43cf346`). Verify the ECDSA signature over the C2PA claim payload using the leaf public key. c2pa-rs's `c2pa.Reader` does this end-to-end.

**Step 4 — Walk the leaf to the Merkle root.** Read `com.scruple.leaf.leaf.leaf_hash_sha256_hex` and `com.scruple.leaf.anchor.merkle_root_sha256_hex`. For a single-iteration training run, these are equal (Project 181: `1404513c398fe04b98a88523b3c1dfac82c1c53c3de7e70eb34d56c49ccfbe97`). For a multi-iteration run, walk the Merkle path (public tools can reconstruct the tree from the leaves).

**Step 5 — Verify the chain anchor on-chain.** Read `com.scruple.leaf.anchor.rvn_txid` (`32882d63ff67b75c99d4c5fbcc651b5c7d83d862a771f8651b091af22f52b616` for Project 181), query a Ravencoin testnet block explorer, confirm the asset issued at that txid names the SCR ID (`SCR_DB433994`) and its OP_RETURN carries the anchor `package_hash`. Cross-check with the IPFS CID and Arweave transaction ID.

**Step 6 (optional) — Verify the L2 substrate.** Fetch the Scruple L2 evidence bundle. Verify `vcek.der` chains to AMD ARK via `amd-cert-chain.pem` (or fetch fresh from `https://kdsintf.amd.com/vcek/v1/Genoa/<chip_id>?...`). Verify the `sev-snp-report.bin` signature using `vcek.der`. Compute `SHA-256(SPKI_DER(signer public key))` and confirm it equals the 32-byte prefix of the report's `report_data` field.

At every step, the auditor's verification is Scruple-independent: the artifacts they need to consult are AMD-issued (VCEK), the model file itself (SHA-256), the C2PA-standard tooling (c2pa.Reader), and a public blockchain (Ravencoin). We think this Scruple-independence is essential for the WG's normative work: no vendor should be a required party to a Content Credential's verification.

## 5. Reference implementation

Everything described in Sections 3 and 4 is public in the Scruple git history and reproducible from the reference bundle. Key anchors:

- **Commit `43cf346` — cert-profile fix and c2pa.Reader interop.** Isolated the c2pa-rs 0.86+ profile requirements (full-DN leaf, distinct root CA, critical EKU `emailProtection`) and fixed cert-generation. Wired `scripts/verify-c2pa-reader.py` into `scripts/test-c2pa-sign-witness-e2e.ts`.
- **Commit `7497f78` — puffjuly12 full-send.** End-to-end: five FLUX iterations, Merkle tree, Ed25519 checkpoint, C2PA-L2 sign, RVN mint. Bundle at `docs/provenance-bundles/bundle-29e9a40e1d43/`.
- **Commit `8adb9ff` — Project 181 LoRA sidecar retrofit.** The sidecar-based Content Credential for a shipping trained model. Files at `docs/provenance-bundles/bundle-29e9a40e1d43/iterations/training-181/` (manifest.json, sidecar bytes, verification-report.json, NOTES.md, README.md).

Two honest caveats we would not want a technical reviewer to be surprised by:

**Caveat 1 — the LoRA sidecar is a retrofit script, not an integrated pipeline step yet.** The sidecar for Project 181 was produced by running `scripts/puffjuly12/12-emit-lora-sidecar.py` against an already-shipped, already-anchored training run. Kohya-ss and our RunPod-hosted training path do not yet emit the sidecar automatically as part of the training pipeline. Our roadmap item is to move the sidecar emission into the training-completion webhook so every LoRA ships with its Content Credential from the moment it enters storage. Until that lands, the sidecar for any given LoRA is generated by an out-of-band script.

**Caveat 2 — the L2 substrate proves capability, not that every production sign happens inside it yet.** The evidence bundle at `docs/l2-evidence/2026-07-12T174954Z/` proves we can, and did, sign a test asset inside the SEV-SNP substrate; the puffjuly12 signer key is functionally equivalent to that substrate's key. Formal L2 filing under the C2PA Generator Product Security Requirements v0.1 §6.1.2 / §6.2.2 requires additional evidence (production cert issued under a C2PA-trust-listed root, reproducible-build hash of the signer binary, static-analysis output for §6.3.2). Those items are tracked in our L2 filing work orders and are open. We would not present ourselves as an L2-certified signer today; we would present ourselves as a signer with a demonstrable L2-capable substrate and a documented path to formal filing.

## 6. Comparison against alternatives

The WG has been considering three approaches. We explain why we did not pick each.

**Alternative A — embed JUMBF inside `.safetensors`.** Attractive in symmetry with C2PA for JPEG or MP4, but disqualified in practice by three problems. First, byte-identity: modifying a `.safetensors` container invalidates every existing cache keyed by SHA-256 of the model file (which is the near-universal practice across `diffusers`, ComfyUI, kohya-ss, and HF Hub). Second, downstream-tool support: no existing safetensors loader tolerates trailing bytes or an in-container metadata region reserved for JUMBF; adding one requires coordination with Hugging Face who own the format specification. Third, no `c2pa-rs` handler exists today, and building one requires a spec-controlled position on where the JUMBF box goes in the file layout. The WG could pursue this over the medium term, but not without an ecosystem migration story.

**Alternative B — hash-bind the model into a chain-of-custody record without a sidecar.** This is what we did before the Project 181 retrofit: our `com.scruple.leaf` structure has carried the LoRA hash in a canonical record on our servers and on-chain since 2026-07-05. It is enough to prove provenance if you trust our servers to serve up the record. It is not enough to be a Content Credential in the C2PA sense: without a C2PA manifest an off-the-shelf `c2pa.Reader` cannot verify anything, and offline verification requires learning the Scruple-specific schema. It fails the "no vendor should be a required party" test in Section 4.

**Alternative C — sidecar plus hash-bound manifest (our proposal).** Delivers a standard C2PA external-manifest store, preserves model bytes, verifies under an unmodified `c2pa.Reader` (subject to trust-list configuration), gives an offline verifier the artifact-plus-sidecar workflow that C2PA already recommends for datasets in the v2.2 and v2.4 AI/ML guidance, and lets the auditor walk to a blockchain anchor without contacting the issuer. The costs are (a) two files travel together instead of one, and (b) a small trust-list update at the C2PA verifier to accept L2-attested signer certs — a policy question the WG is already navigating.

## 7. Open questions for the WG

We offer four questions for WG deliberation. We do not have strong positions on the answers and would defer to the working group's judgment.

**Q1 — Where should the training-provenance sub-schema live?** Our shipping sidecar carries a `training_run` sub-object under `c2pa.assertion.training-mining` (Section 3.4). The CAWG-normative label is `cawg.training-mining` and covers permissions rather than training telemetry. Should the training-provenance schema be added as an optional sub-branch inside `cawg.training-mining`, or minted as a sibling assertion (candidate label: `cawg.training-provenance`)? Which body — CAWG or the C2PA TWG — owns the decision?

**Q2 — Should we formalize a hardware-attestation profile for signer keys?** Our L2 evidence bundle stakes out one concrete answer: the signer's ES256 public key is bound into an AMD SEV-SNP attestation report's `report_data` field. Intel TDX, Arm CCA, and AWS Nitro attestations have analogous constructions. Should the WG define a normative "L2-attested signer" profile (with fields like `attestation_type`, `attestation_report_ref`, `pubkey_binding_hex`) that trust-list operators can key off?

**Q3 — Should `com.scruple.leaf` be lifted to a standard cross-vendor `c2pa.provenance-anchor` assertion?** The pattern — Merkle root plus blockchain txid plus IPFS CID plus Arweave tx plus package hash — is not Scruple-specific in its structure. Other vendors doing blockchain-anchored provenance would benefit from an assertion vocabulary that lets them express the same shape without namespace-custom fields. We would offer to help draft a vendor-neutral version.

**Q4 — How should sidecar discovery be standardized?** We propose `<model>.<ext>.c2pa` as a naming convention that colocates sidecar with model. An alternative is a manifest-registry lookup (client hashes the model, queries a registry, retrieves the sidecar). Both have merit — the naming convention is offline-first; the registry supports discovery when the sidecar has been separated from the model. Should the WG endorse both, with the naming convention as the SHOULD-ship-with-model default?

## 8. Bibliography and references

- C2PA. *Content Credentials: C2PA Technical Specification v2.4* (January 2026). https://spec.c2pa.org/specifications/specifications/2.4/specs/C2PA_Specification.html
- C2PA. *Guidance for Artificial Intelligence and Machine Learning* (spec v2.2 and v2.4). https://spec.c2pa.org/specifications/specifications/2.4/ai-ml/ai_ml.html
- C2PA. *C2PA and Content Credentials Explainer* (spec v2.4). https://spec.c2pa.org/specifications/specifications/2.4/explainer/Explainer.html
- Creator Assertions Working Group. *Training and Data Mining Assertion v1.0* (approved 2024-03-18). https://cawg.io/training-and-data-mining/1.0/
- Creator Assertions Working Group. *training-and-data-mining-assertion* repository. https://github.com/creator-assertions/training-and-data-mining-assertion
- Content Authenticity Initiative. `c2pa-rs` — Rust SDK for the core C2PA specification. https://github.com/contentauth/c2pa-rs
- Content Authenticity Initiative. `c2pa-c` — C bindings and fixtures (including `training.json` fixture illustrating training-related assertion shape). https://github.com/contentauth/c2pa-c
- IntelLabs. `atlas-c2pa-lib` — research-stage Rust library for C2PA in ML workflows (research-stage; explicitly not for production use). https://github.com/IntelLabs/atlas-c2pa-lib
- IETF. RFC 8152 — CBOR Object Signing and Encryption (COSE). Used for `COSE_Sign1` protected header `alg` (`-7` for ES256) and the `x5chain` header. https://datatracker.ietf.org/doc/html/rfc8152
- Hugging Face. `safetensors` — reference implementation and format specification. https://github.com/safetensors/safetensors
- AMD. *SEV Secure Nested Paging Firmware ABI Specification* (Rev. 1.55+). Publisher: AMD. Public copy referenced by our L2 evidence: https://www.amd.com/system/files/TechDocs/56860.pdf
- AMD. *VCEK Certificate Distribution Service* (Genoa). https://kdsintf.amd.com/vcek/v1/Genoa/
- Ravencoin. Asset issuance protocol reference (mainnet and testnet). https://ravencoin.org/
- SLSA. *Supply-chain Levels for Software Artifacts — SLSA for AI (Draft)*. https://slsa.dev/spec/draft/
- Scruple / Docent Technologies. Reference bundle at `docs/provenance-bundles/bundle-29e9a40e1d43/` and L2 evidence bundle at `docs/l2-evidence/2026-07-12T174954Z/`, both in the `scruple-web` repository (commits `43cf346`, `7497f78`, `8adb9ff`).

---

*Prepared 2026-07-12 by Docent Technologies LLC for submission to the C2PA Technical Working Group and Creator Assertions Working Group. All hash values, transaction identifiers, and file paths cited above are exact and reproducible from the referenced evidence bundles.*
