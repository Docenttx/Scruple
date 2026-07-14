# Marking implementation — technical specification

**Purpose:** Detail HOW Scruple satisfies the Code's Section 1 multi-layered
marking requirement across every system/service/deployment context in
`../02-provider-identification/scope-inventory.md`.

**Companion evidence:** Full C2PA Conformance Program evidence bundle at
`github.com/Docenttx/Scruple/tree/feature/witnessing-l2-sprint1/docs/c2pa-conformance-evidence/2026-07-14`
(15/16 GENERATE MIMEs and 18/20 VALIDATE MIMEs producing cryptographically
verified C2PA manifests via our signer wrapper).

## Layer 1 — Sub-measure 1.1.1 (Digitally signed metadata)

**Standard:** C2PA v2.x specification (`spec.c2pa.org/specifications/specifications/2.0/`).
Industry consensus recognition of C2PA as the current de facto implementation
of Sub-measure 1.1.1 is documented by IPTC (June 2026).

**Cryptographic parameters:**
- Signing algorithm: ES256 (P-256 ECDSA) per RFC 8152 COSE_Sign1.
- Key isolation (production): OCI Vault hardware-backed key storage inside
  an AMD SEV-SNP Confidential VM — no operator-side key material access.
- Manifest structure: single active manifest with `c2pa.actions.v2`
  assertion (`c2pa.created` for scratch generation, `c2pa.opened +
  c2pa.edited` for derived-from-ingested outputs). Every manifest embeds
  the IPTC PhotoMetadata `digitalSourceType` value appropriate to the
  operation (`trainedAlgorithmicMedia` for direct generation,
  `compositeSynthetic` for compositional derivation, `algorithmicMedia`
  for post-processing).

**Coverage matrix:**
- 15 of 16 asserted GENERATE MIMEs sign successfully:
  image/png, image/jpeg, image/webp, image/svg+xml, image/tiff,
  image/x-adobe-dng, image/heic, image/heif, image/avif,
  video/mp4, video/quicktime, audio/wav, audio/flac, audio/mpeg,
  audio/mp4. (application/x-pytorch pending c2pa-python wrapper feature.)
- 18 of 20 asserted VALIDATE MIMEs round-trip successfully (add image/jxl,
  image/gif, video/x-msvideo; application/pdf and application/x-pytorch
  pending same wrapper feature).

**Every signed sample independently verifies** as `validation_state=Valid`
via a fresh c2pa.Reader against our cert chain (dev bundle) — evidence in
the C2PA bundle `_bundle_report.json`.

**Interoperability:** JPEG Trust (ISO/IEC 21617-1:2025) adopts the C2PA
manifest engine, so Scruple manifests are structurally interoperable with
JPEG Trust readers. Content Credentials readers (Adobe Verify) can display
Scruple-signed content without adaptation.

## Layer 2 — Sub-measure 1.1.3 (Fingerprinting / logging)

**Standard:** Cryptographic-fingerprint per-iteration log with public-ledger
anchoring — a technique family enumerated in Recital 133 ("logging methods,
fingerprints or other techniques"). No single ISO standard covers this; the
implementation is documented in the Scruple Standard v1.2 at
`github.com/Docenttx/Scruple/blob/feature/witnessing-l2-sprint1/docs/architecture/SCRUPLE_STANDARD_v1.md`.

**Cryptographic parameters:**
- Per-iteration leaf hash: canonical v2.4 preimage of the operation, HMAC-signed
  by the witness server. Preimage includes: `tenant_id`, `principal_id`,
  `stream_id`, `tenant_seq`, `event_time`, `payload_hash`, `workflow_hash`,
  `machine_manifest_hash`, `dims`. Fields defined normatively in
  `lib/witness/canonicalLeafV24.ts`.
- Chain hash: `SHA-256(prev_chain_hash_bytes || leaf_hash_bytes)`, chained
  across all leaves per stream.
- Checkpoint: Merkle root over each closed epoch, Ed25519-signed by a
  distinct checkpoint key.
- Ledger anchor: Merkle root committed to Ravencoin asset issuance on a
  fixed cadence (currently 60-second checkpoint epoch, per-lock super-root
  anchor). This makes the fingerprint durable even after downstream
  processing strips the C2PA manifest.

**Why this qualifies as Sub-measure 1.1.3:** The Code's own text acknowledges
that Sub-measure 1.1.1 alone is insufficient because C2PA manifests can be
stripped by intermediaries (C2PA v2.0 Security Considerations document,
`spec.c2pa.org/specifications/specifications/2.0/security/`). A
fingerprinting/logging layer that persists after strip is exactly the
gap-fill Sub-measure 1.1.3 addresses. The Scruple witness Merkle chain
provides:

- Per-iteration fingerprint that binds output hash + workflow + model
  weights + toolchain, independent of the manifest wrapper.
- Ledger anchoring that makes the fingerprint checkable by third parties
  without runtime dependency on Scruple.
- Retroactive detection of stripping: an artefact whose C2PA manifest is
  missing but whose bytes hash to a leaf in our ledger-anchored chain is
  detectable as AI-generated via `scruple-verify` operating on the raw
  bytes.

**Coverage:** Every operation across every system in the scope inventory
(rows 1–11) emits a witness leaf, unconditionally, without regard to the
downstream marking wrapper.

## Layer we do NOT satisfy — Sub-measure 1.1.2 (Imperceptible watermark)

Scruple does not currently embed a pixel-domain / frequency-domain
imperceptible watermark in generated content. This is disclosed openly.

Rationale for the current gap:
- The Code recognises that Sub-measure 1.1.2 standards are "yet to be
  developed" (Code Section 1 language on state of the art).
- The Article 50(2) "as far as technically feasible" clause applies:
  Scruple's role as a downstream provider of third-party base models
  means the imperceptible watermark ideally lives in the base model's
  generator (SynthID pattern), not in a downstream signer.
- Our roadmap explicitly commits to closing this gap — see
  `../05-governance/interoperability-roadmap.md`.

The multi-layered requirement of Section 1 is satisfied by our two
independent layers (1.1.1 + 1.1.3). The 1.1.2 addition is a strengthening,
not a compliance prerequisite, per the Code text.

## Detection and verification

Third parties can verify Scruple marks in three independent ways:

1. **Any C2PA-conformant reader** (Adobe Verify, Truepic Lens, IPTC
   verifier, `c2pa-python`, `c2pa-rs`). No dependency on Scruple
   infrastructure. This is the Article 50(2) "interoperable" leg.

2. **`scruple-verify` CLI** (`packages/scruple-verify` on our GitHub) — an
   independent Node.js verifier that re-derives leaf hashes from first
   principles, walks the Merkle inclusion, and verifies the checkpoint
   signature against our published trust manifest. Open-source, MIT-licensed
   equivalent, works offline.

3. **Public verification URL** (planned Q1 2027 per roadmap) — a
   `scruple.ai/verify` endpoint modelled on OpenAI's `openai.com/verify`
   pattern. Accepts any Scruple-signed artefact and returns a verdict.
   Interoperable with any C2PA-signed content by delegation to the
   underlying C2PA reader.

## Robustness posture

C2PA v2.0 Security Considerations documents the known failure modes we
address:
- **Manifest strip** — addressed by Layer 2 (witness Merkle chain).
- **Cert-chain trust anchor drift** — addressed by publishing our trust
  manifest at a stable public URL and pinning the trust-anchor list at
  the reader.
- **Downstream re-encoding invalidating BMFF hash assertions** — addressed
  by the witness leaf, which references the pre-encode output hash and
  survives re-encoding.
- **Signing-key compromise** — addressed by hardware-backed key isolation
  (AMD SEV-SNP + OCI Vault); compromise detection via ledger-anchored
  attestation.
