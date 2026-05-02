# SCRUPLE Studio — Technical Overview

_Extracted from scruple-studio.docx (Apr 8 2026)_

SCRUPLE Studio — Technical Overview

What It Is

SCRUPLE Studio (patent pending) is an AI provenance middleware platform developed by Docent Technologies (Aquanomous LLC). It is a desktop application that creates cryptographically verifiable, blockchain-anchored proof-of-authorship records for AI-generated content and AI model training workflows. The system functions as a middleware layer that sits between a creator's existing AI tools and a multi-tier storage and blockchain infrastructure — capturing, hashing, and permanently anchoring the full creative history of an AI-assisted work without disrupting the creative process itself.

The core problem SCRUPLE addresses is a structural gap in AI content workflows: when a creator produces work using generative AI tools, there is currently no neutral, tamper-proof mechanism to establish who created it, when, what inputs were used, what creative decisions were made iteratively, and what model or training data produced the underlying output. SCRUPLE fills that gap by treating each generation or training event as a provenance artifact, building a mathematical proof structure over the full creative session, and anchoring that proof to a permanent, publicly verifiable record.

Intended Users

SCRUPLE Studio targets professional and semi-professional creators who produce AI-generated content with genuine commercial or legal value. Primary user categories include:

Visual artists and digital illustrators using AI image generation tools (ComfyUI, Stable Diffusion, Flux-based workflows) to create original works for commercial licensing, gallery representation, or publication

AI model developers and fine-tuners who train custom LoRA or full-model checkpoints on proprietary datasets and need to establish ownership of both the training inputs and the resulting model files

Creative studios and production teams who need institutional-grade provenance documentation for AI-assisted outputs — whether for client deliverables, rights management, or compliance with emerging AI transparency requirements

Photographers, concept artists, and game asset creators whose AI-assisted workflows generate monetizable assets requiring proof of original authorship

Legal and IP professionals working with creators who need documentary evidence suitable for copyright registration, licensing disputes, or authorship attribution

The platform is designed for creators where the value of the output justifies the cost of provenance insurance — the same economic logic as title insurance in real estate.

Core Functional Architecture

1. Sensor Layer — Capture at Source

SCRUPLE deploys lightweight "sensor" nodes directly inside the creator's AI tools. These are Python-based custom nodes that integrate natively into ComfyUI's node graph system, functioning as invisible workflow participants:

ScrupleStudioTerminal captures each image generation run: the prompt, seed, model selection, workflow parameters, and a SHA-256 hash of the output image file computed at the moment of creation — before the user has any opportunity to modify it

ScrupleTrainingTerminal (in development) captures each LoRA or model training run: the full hyperparameter set, dataset folder Merkle root, training configuration (auto-captured from Kohya_ss TOML config files), and a hash of the output .safetensors model file

For Kohya_ss training workflows, SCRUPLE uses a TOML file watcher — Kohya auto-generates a TOML configuration file at training start, which SCRUPLE treats as the authoritative execution record. This approach captures what the AI actually ran rather than what the UI displayed.

The sensor layer communicates with the Electron desktop application via a session handshake protocol. At startup, SCRUPLE writes a UUID session file to the ComfyUI working directory; the Python node reads this session ID and includes it in every provenance payload it generates. This prevents ghost ingestion from stale files across sessions.

2. Provenance Processing Layer — Merkle Tree Construction

As each creative iteration is captured, SCRUPLE's main application engine processes the incoming provenance data:

Each captured generation produces a leaf hash — a SHA-256 hash of the output content and its associated metadata. These leaf hashes are stored in a local SQLite database and used to build a Merkle tree over the entire project session.

The Merkle tree algorithm:

Sorts leaf hash pairs alphabetically before concatenation, preventing positional manipulation

Builds the tree level by level, storing every intermediate node in the database

Computes a Merkle root that cryptographically represents the entire creative history of the project

Derives a unique SCR identifier (format: SCR_XXXXXX) from the first six hex characters of the Merkle root

This means the SCR ID is not arbitrarily assigned — it is mathematically derived from the actual content of every iteration in the project. Any modification to any leaf in the chain would produce a different root and a different SCR ID, making retroactive tampering detectable.

Each iteration record also stores a previous hash, forming a hash chain (similar in structure to a blockchain's block linkage) that makes the sequential order of creation cryptographically verifiable.

3. Lock Tiers — Graduated Commitment Model

SCRUPLE uses a three-tier locking system that allows creators to commit provenance with increasing permanence:

Local Disc Lock (Tier 1) The provenance package — including the Merkle tree, all leaf hashes, iteration metadata, output file hashes, and a manifest — is cryptographically sealed and written to the creator's local vault directory. The vault is a tamper-evident snapshot: a manifest file is produced listing every file, its hash, and its hashing method. This tier requires no network connectivity and no fee, and functions as an immediate timestamped record.

Single Chain Lock (Tier 2) The Merkle root is anchored to the Ravencoin blockchain by minting a unique named asset (in the format SCR_XXXXXX) with the Merkle root embedded as the asset's metadata. Ravencoin was selected for its purpose-built asset layer (OP_RVN_ASSET), its proof-of-work consensus model, and its non-Turing-complete scripting — providing a clean, auditable on-chain record without smart contract complexity. Minting burns 500 RVN to the Ravencoin network, creating a permanent, immutable record on a public blockchain that cannot be altered or deleted.

Persistent Chain Lock (Tier 3) In addition to blockchain anchoring, the full provenance package is uploaded to:

IPFS via Pinata — for distributed, content-addressed storage with tamper-evident retrieval by content hash (CID)

Arweave — for permanent, pay-once storage that functions as a directory connecting the on-chain Ravencoin proof to the IPFS-stored content package

The relationship between these three storage layers is deliberate: Ravencoin holds the proof (Merkle root + SCR ID), IPFS holds the content (full provenance package), and Arweave holds the directory (the connection between them). This separation ensures that no single service failure breaks the provenance chain.

Upon completion of a Persistent Chain Lock, SCRUPLE generates a PDF provenance receipt containing the SCR ID, Merkle root, Ravencoin transaction ID, IPFS CID, and Arweave transaction ID — a human-readable summary document suitable for inclusion with rights documentation.

4. Training Provenance — Model Authorship Capture

For AI model training workflows, SCRUPLE extends its provenance architecture to cover the full model development lifecycle:

The dataset Merkle root is computed by hashing every image in the training dataset folder and building a Merkle tree over those hashes — producing a single fingerprint that represents the exact composition of the training data

The output model hash is computed from the .safetensors file header (for speed) or the full file (for maximum fidelity), producing a unique identifier for the trained model artifact

Training hyperparameters — learning rate, network dimensions, batch size, optimizer configuration, scheduler settings, and step counts — are captured from the TOML configuration file

Model selection — the base transformer, VAE, CLIP encoder, and T5 model files used — is recorded as part of the provenance payload

This produces a complete chain of custody for a trained AI model: what data was used to train it, what parameters governed the training, and what model file was produced — all cryptographically linked.

5. Witness Server (Planned)

A forthcoming V1 Witness Server will provide third-party timestamp attestation for each iteration at the moment of capture — before any locking occurs. The witness server uses wallet-signature-based identity (no user accounts), stateless pay-per-action payment processing, and returns a signed server timestamp and witness ID for each iteration record. This adds an independent, network-based timestamp authority to the provenance chain, strengthening the evidentiary weight of the local record even before blockchain anchoring.

Technical Stack

Layer

Technology

Desktop application

Electron (Node.js)

AI tool integration

Python (ComfyUI custom nodes)

Local database

SQLite via better-sqlite3

Cryptographic hashing

SHA-256 (Node.js crypto module)

Blockchain

Ravencoin Core v4.6.1, ElectrumX protocol

Distributed storage

IPFS via Pinata API

Permanent storage

Arweave (ArConnect client-side)

Training capture

Kohya_ss TOML watcher, Gradio integration

Infrastructure

Private Ravencoin node (Oracle Cloud ARM VM), systemd services

Key Design Principles

Hash at source. Actual file hashing occurs at the moment of output creation inside the AI tool, before the user has any possibility of modifying the file. This is what distinguishes genuine tamper-proof provenance from metadata-based approaches that can be stripped or backdated.

No trust required. The provenance proof does not rely on any central authority. The Ravencoin blockchain, IPFS content addressing, and Arweave permanent storage are all independently verifiable by anyone with the SCR ID and Merkle root. A third party can reconstruct and verify the proof without SCRUPLE Studio or Docent Technologies being involved.

Non-disruptive by design. The sensor nodes are structurally invisible to the creator's workflow. ComfyUI continues to operate normally; SCRUPLE captures provenance in the background without interrupting the generation process.

Graduated commitment. The three-tier lock model allows creators to choose the level of permanence appropriate for each project — from instant local sealing of a rough concept to full multi-chain anchoring of a final commercial asset.

Fail-fast integrity. Chain lock operations are atomic: if any step in the sequence fails, the entire operation stops immediately with a detailed error state showing exactly which steps succeeded and which failed. No partial provenance records are accepted as valid.

Public Verifiability

SCRUPLE Studio includes a Python CLI provenance explorer distributed as a free download, and a web-based explorer embedded in the Docent Technologies website (powered by the Arweave GraphQL API). Any member of the public can input a SCR ID to retrieve and verify the associated provenance record — examining the Merkle root, the Ravencoin transaction, the IPFS content package, and the full iteration history — without requiring a SCRUPLE Studio installation or any account.

SCRUPLE-RVN: Custom Blockchain Integration Layer

Overview

Rather than relying on third-party wallet services, hosted RPC providers, or existing Ravencoin libraries as black boxes, SCRUPLE Studio implements a fully custom, native JavaScript blockchain integration layer built from the protocol level up. This layer — collectively referred to internally as the SCRUPLE-RVN stack — handles every aspect of Ravencoin interaction: key derivation, UTXO management, raw transaction construction, asset script encoding, transaction signing, and broadcast. It is purpose-built for SCRUPLE's specific use case and operates without any custodial intermediary.

Native JavaScript Wallet Implementation

The SCRUPLE-RVN stack is composed of four tightly coupled custom modules:

electrumx-client.js implements a direct SSL connection to Ravencoin ElectrumX servers using the Stratum protocol. It handles UTXO queries via scripthash lookup, asset metadata retrieval, fee estimation, and transaction broadcast. The client includes automatic server failover across multiple endpoints, a configurable connection timeout, and an address-to-scripthash conversion utility that correctly handles both mainnet and testnet address formats by stripping the version byte and constructing the canonical P2PKH scriptPubKey before hashing.

asset-encoder.js is a custom raw transaction builder for Ravencoin asset issuance. It constructs the full four-output transaction structure required by the Ravencoin asset protocol: a 500 RVN burn to the network burn address (RXissueAssetXXXXXXXXXXXXXXXXXhhZGt on mainnet), the asset output embedding the SCR ID and Merkle root using the OP_RVN_ASSET opcode and rvnq header format, the companion ownership token (SCR_XXXXXX!), and the change output back to the originating wallet. Private key derivation follows the BIP44 path m/44'/175'/0'/0/x with change address scanning at /1/x, and transaction signing is performed independently using tiny-secp256k1 — no dependency on Ravencoin daemon RPC for any signing operation.

native-issuer.js is the high-level orchestration layer that combines the ElectrumX client and transaction builder into a single asset issuance pipeline. It manages the full sequence: connecting to ElectrumX, verifying the asset name is unclaimed, scanning up to twenty derivation paths for UTXOs, checking minimum balance against the fee quote, constructing and signing the raw transaction, and broadcasting it. It exposes a verifyProof() method that retrieves an on-chain asset's embedded data field and compares it against an expected Merkle root — providing trustless, third-party-verifiable proof confirmation.

wallets-integration-native.js is the Electron IPC layer that bridges the native issuer to the desktop application, handling mnemonic decryption, fee quoting, wallet balance queries, IPFS and Arweave orchestration, and PDF receipt generation as a unified chain lock execution flow.

The motivation for this custom implementation is structural: public Ravencoin RPC endpoints and most hosted wallet services block the issue and sendrawtransaction commands required to mint assets and broadcast transactions. Any architecture dependent on public endpoints cannot complete the chain lock operation. The native JS stack eliminates this dependency entirely — SCRUPLE constructs and signs transactions locally, then broadcasts directly via ElectrumX, with no admin RPC exposure.

Private Ravencoin Network Infrastructure

SCRUPLE operates its own dedicated Ravencoin network infrastructure on a self-managed cloud server (Oracle Cloud free tier, ARM VM, 129.80.132.5). This infrastructure runs both production and testing network environments as permanent system services:

ravend-mainnet — a full Ravencoin mainnet node (Ravencoin Core v4.6.1) running as a systemd service on RPC port 8766, maintaining a complete copy of the mainnet blockchain and providing the authoritative transaction validation environment for production provenance anchoring

ravend-testnet — a full Ravencoin testnet node running as a separate systemd service on RPC port 18766, used for end-to-end testing of the full chain lock pipeline without spending real RVN; the testnet wallet maintains approximately 625,000 testnet RVN for developer and beta tester provisioning

electrumx-testnet — a private ElectrumX server connected to the testnet node, exposed on port 443 via an iptables NAT redirect from the standard SSL port (50002); port 443 was specifically selected to prevent ISP-level blocking in international beta tester environments

Ravencoin Stratum Proxy — a solo mining proxy on port 13333 (based on kralverde's implementation) used to mine testnet RVN for the development and testing pool

The mainnet and testnet environments are architecturally isolated: separate ravend instances, separate wallet files (wallet.json and wallet-testnet.json), separate address derivation (mainnet addresses begin with R; testnet addresses begin with m or n), separate ElectrumX endpoints, and separate network parameter constants in asset-encoder.js (including distinct burn addresses, version bytes, WIF prefixes, and BIP32 key prefixes). The NativeAssetIssuer class and ElectrumXClient are fully network-aware, accepting a network parameter at initialization that routes all downstream operations to the correct parameter set.

This self-hosted infrastructure eliminates dependence on any third-party Ravencoin service for either production operations or development testing, and gives SCRUPLE direct operational control over the full blockchain interaction stack — from node synchronization through transaction broadcast.