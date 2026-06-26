# Patent Critique — Written Description + Figures

**Cross-reference critique of the SCRUPLE Audit Patent application against the patent-delta canonical-flow analysis of live code.**

Date: 2026-06-26
Source (patent application):
- Written description chapters in Drive root folder `Scruple Audit Patent — Written Description (2026-06-26)` (id `1uh8svUyxfpVl2HiJb3IzPaXJbeb5KYLs`), files `ch-00.md` through `ch-08.md`.
- Figure specifications in Drive root folder `Scruple Audit Patent — Figures (2026-06-26)` (id `1h_KMWHf8ZMzPzXhN0Kxq62gfNgJe0QTG`), files `FIG-01.md` through `FIG-08.md`.

Reference (live code):
- Patent Delta segments 01-05 at `/data/scruple-web/docs/patent-delta/` (committed `30f03bf` on `feature/pivot`).

## Methodology

Two Explore agents read all 17 source files and the 6 patent-delta segments in parallel. Each section of the written description and each figure was classified:

- **STRONG** — accurately reflects live code; no enhancement needed.
- **NEEDS_DETAIL** — directionally correct but missing specifics that the code surfaces explicitly.
- **GAP** — a shipped feature is entirely absent from the patent prose or figure.
- **OVERCLAIM** — the patent describes something as a system feature that the code shows is planned, not shipped.
- **AMBIGUOUS** — language is loose where the code is precise (e.g., signing algorithm ambiguity).

Findings are organized by section number (Part 1) and figure number (Part 2). Cross-cutting gaps that span multiple sections are consolidated in Part 3. New figures and new continuation-in-part candidates are proposed in Parts 4 and 5. Part 6 ranks the work for filing readiness.

---

# Part 1 — Written Description, section-by-section

## ch-00 — Field, Background, Summary

**Overall:** Strong conceptual foundation. Accurately frames the multi-adversary threat model and the three-way verification posture. Oversimplifies the witness sealing scheme and entirely omits publication-mode redaction.

### § Witness Sealing (Background, ¶3) — AMBIGUOUS
The chapter says "the Witness Service applies an independent cryptographic seal." Live code (Segment 02 `[server.js:194-199]`) ships HMAC-SHA256; the SCRUPLE Standard mandates Ed25519 / ECDSA P-256.
**Enhancement:** Add the embodiment caveat from ch-02 here as well: *"In some embodiments, the seal is a keyed-hash message authentication code (HMAC); in alternative embodiments, the seal may be an asymmetric digital signature such as ECDSA or Ed25519, which allows public verification without a shared secret."*
**Cross-ref figure:** FIG-02 (witness service 218).

### § Three-Way Verification (Summary, ¶2) — NEEDS_DETAIL
Claims the verifying party performs content-match, seal validation, and Merkle inclusion proof. Live code (Segment 05.A.4) implements this as a manual / scripted recipe today; the integrated API endpoint (5B.2) is proposed but not shipped.
**Enhancement:** *"In some embodiments, the verification surface is configured to provide all three attestations atomically (FIG. 4); in other embodiments, a third party may perform the three checks manually using the receipt, a public key registry, and public ledger data, as illustrated in Segment 5A.4."*
**Cross-ref figure:** FIG-04.

### § Public-Ledger Anchoring (Summary, ¶3) — NEEDS_DETAIL
The chapter speaks of "a public ledger." Live code (Segment 04) ships three independent anchors (RVN testnet + IPFS + Arweave) with COALESCE write-back resilience.
**Enhancement:** *"In some embodiments, the Merkle root is committed to a single permissionless blockchain; in other embodiments the root is committed to multiple independent ledgers (e.g., Ravencoin for asset issuance, Arweave for archival, IPFS for distributed pinning) such that no single ledger failure prevents independent verification."*
**Cross-ref figures:** FIG-03 (public anchor modules 320-326), FIG-08 (STIFS multi-ledger).

### § Publication-Mode Redaction — **GAP (critical)**
Entirely absent from ch-00. Live code (Segment 04 §10-11) ships three modes (Full / Hash-only / Witness-only) as pure presentation redaction over the unchanged cryptographic preimage, with upgrade-only semantics. This is a patent-bearing feature (G-5) that should be claimed.
**Enhancement:** Add to the Summary: *"In some embodiments, receipts may be rendered in multiple publication modes (e.g., Full disclosure, Hash-only redaction, or Witness-only redaction) while preserving the underlying cryptographic preimage unchanged, enabling selective disclosure with upgrade-only semantics and without requiring the event to be re-anchored."*
**Cross-ref figures:** FIG-04 (mode-aware verification), FIG-08 (enterprise presentation layer), proposed FIG-03C.

---

## ch-01 — Substrate Master Architectural Overview

**Overall:** Comprehensive 14-module breakdown. Conflates *witness service* (cryptographic primitive) with *Witness Operator* (trust role). Shipped-vs-planned status note is too coarse.

### § Witness Service 118 — NEEDS_DETAIL
"Structurally separated cryptographic sealing service." Live code shows the witness service is a separate Node process on an Oracle VM, not a separate legal entity.
**Enhancement:** *"The witness service 118 may operate in a separate process on the same physical machine, in a separate virtual machine on distinct hardware, on a separate cloud-hosted instance, or under a separate legal entity. In a preferred embodiment, the witness service is deployed on infrastructure controlled by a distinct operator from the event-capture system."*
**Cross-ref figures:** FIG-02 (218), FIG-04 (seal verifier 414).

### § Knob Suite 130 — NEEDS_DETAIL
Described as a "unified configuration interface" governing capture policies. Live code today implements feature flags as individual if/else branches, not a unified knob-driven system. The three presets (Stooges 132 / SJ 134 / STIFS 136) are documented in ch-06/07/08 but not implemented as a parameter-driven overlay.
**Enhancement:** Add status note: *"In current implementations, the knob suite 130 controls capture-class activation, window-trigger thresholds, and retention policies via configuration; in planned implementations, the knob suite will support full product-tier overlays as described in FIGS. 6-8."*
**Cross-ref figures:** FIG-05 (130), FIG-06/07/08 (presets).

### § Notification-Dispatch Closed Loop (Side-Channel) — NEEDS_DETAIL
Describes a closed loop where every dispatched notification is captured, receipted, and chained. Live code dispatches notifications but does NOT yet route them back through the witness pipeline (the closure is planned).
**Enhancement:** *"In some embodiments, the notification dispatcher 142 and notification capture module 110 interact to form a closed audit loop wherein every dispatched notification is captured, receipted, and chained (FIG. 7). In current implementations, notification dispatch is implemented; closed-loop capture is planned for a near-term release."*
**Cross-ref figures:** FIG-01 (142, 110), FIG-07 (718, 738).

### § Status of Embodiments — AMBIGUOUS
Coarse — says "basic implementation of the witness service using symmetric key cryptography" without naming HMAC-SHA256; says "basic verification endpoint" without noting that verification is manual/scripted.
**Enhancement:** Tighten with code-grade specifics — name HMAC-SHA256, RVN+IPFS+Arweave anchors, manual verification recipe (5A) vs proposed automated endpoint (5B).

---

## ch-02 — Receipt Generation Method

**Overall:** Strong technical depth and precise numeral mapping. The iterative-input-gathering subgraph is well-articulated. Misses toolchain binding (G-1) and the HMAC/asymmetric resolution.

### § Model Identifier Set Resolver 208 — NEEDS_DETAIL
Covers model fingerprints well. Omits **machine_manifest_hash** — the G-1 toolchain-binding hash that captures ComfyUI version + custom-node pack + dependency lockstate. Live code (Segment 02 §4, `[ingest.ts:230-246]`) binds this into every Leaf v2.2.
**Enhancement:** Add a new sub-element after 208: *"A machine manifest resolver 209 is configured to determine the identity of the execution environment. Functionally, it collects a cryptographic hash of the execution toolchain, including the container image digest, ComfyUI version, custom-node pack fingerprints, and dependency lockstate. The machine manifest hash binds the exact pinned toolchain versions to the event, enabling reproducibility audits and protecting against supply-chain substitution. Supports a dependent claim element reciting a toolchain-identity field included in the canonical bundle."*
**Cross-ref figures:** FIG-02 (add 209), FIG-01 (knob-change capture 112 snapshots config).

### § Witness Service 218 — AMBIGUOUS
The chapter already lists HMAC and ECDSA/Ed25519 as alternative embodiments. Live code is HMAC-SHA256; Standard mandates asymmetric. The chapter's neutral framing is defensible but doesn't resolve the trade-off.
**Enhancement:** Clarify the engineering trade-off and the migration intent: *"In current implementations, the witness service 218 uses HMAC-SHA256 for performance. In preferred embodiments for higher-assurance scenarios, the witness service uses an asymmetric signature (ECDSA P-256 or Ed25519) that allows independent verification without shared-secret distribution. The trade-off is that asymmetric signatures are larger and slower; the current code prioritizes latency and may migrate to asymmetric signing in a future release."*
**Cross-ref figures:** FIG-02 (218), FIG-04 (414).

### § Prior Receipt Pointer Fetcher 210 — STRONG
Accurately describes `prev_record_hash` chaining. Maps directly to Segment 02 §6 (`[server.js:488-494]`).
**No enhancement needed.**

### § Canonical Bundle Assembler 212 — NEEDS_DETAIL
Describes the assembler but doesn't specify the canonicalization rule (compact JSON, fixed field order, empty-string default for missing fields). Live code (Segment 02 §6, `[server.js:233-245]`) is precise about this. Re-derivation reproducibility depends on it.
**Enhancement:** Add: *"In a preferred embodiment, the canonical bundle assembler 212 produces a deterministic JSON representation using compact encoding (no whitespace), a fixed field order, and an empty-string default for any field whose value is absent. This canonicalization rule is identical across implementations to enable bit-exact re-derivation by third-party verifiers."*
**Cross-ref figure:** FIG-02 (212).

---

## ch-03 — Chain Assembly + Public-Ledger Anchoring

**Overall:** Sound architecture, good module descriptions. Two **critical gaps**: the lock-event countersignature (`lock_server_signature`) and the three-anchor COALESCE resilience pattern are entirely absent.

### § Anchor Window Manager 122 — NEEDS_DETAIL
Mentions configurable triggers (time, count, event-driven). Live code has basic windowing but not parameterized event-driven triggers (e.g., crisis-event forced closure).
**Enhancement:** *"In some embodiments, the anchor window manager 122 is configured to close a window upon the occurrence of a high-priority event, such as a verdict from the verdict capture module 106 that flags a content-policy violation or crisis. The choice of trigger is configurable via the knob suite 130 and may vary by product tier (e.g., mandatory forced-closure in the Stooges Jr minor-protection configuration, time-based in adult-tier configurations)."*
**Cross-ref figures:** FIG-03 (312), FIG-07 (706, 734).

### § Three-Anchor Pattern — **GAP (critical)**
Not mentioned. Live code (Segment 04 §6-9) ships three independent anchors with COALESCE write-back: failure of any one does not invalidate the lock, and retries fill missing anchors without invalidating prior ones.
**Enhancement:** Insert new section: *"In some embodiments, the Merkle root is committed to a single public ledger. In other embodiments corresponding to higher-assurance deployments, the Merkle root is committed to multiple independent public ledgers according to a tiering model. For example, in a pinned-tier configuration, the Merkle root is committed to Ravencoin (asset issuance with deterministic SCR-ID), IPFS (distributed pin with content-addressed CID), and Arweave (long-term archival with token record). The failure of any single ledger does not prevent independent verification from the others, and the anchor result persistence module 326 uses COALESCE semantics to record successful anchors while retrying failed ones independently. Supports a dependent claim element of resilient distributed public commitment."*
**Cross-ref figures:** FIG-03 (expand 320-326 to show three sub-anchors), FIG-04 (418), FIG-08 (multi-ledger).

### § Lock Server Signature — **GAP (critical)**
Not mentioned. Live code (Segment 03 §8, `[server.js:1003-1010]` + migration 018) ships a witness countersignature over `{project_id, action, merkle_root, witnessed_count, locked_at}`. The action string in the preimage prevents cross-action replay (a checkpoint sig cannot be presented as a finalize).
**Enhancement:** Insert new section: *"In some embodiments, the anchor window manager 122 and public ledger anchor 126 are extended with a witness-server countersignature that commits the witness service 118 to the moment of locking. Functionally, the witness service receives a tuple comprising the project identifier, the action (e.g., 'checkpoint', 'finalize', or 'chain_lock'), the Merkle root, the receipt count, and the lock timestamp. The witness service computes a keyed-hash message authentication code (HMAC) or digital signature over this tuple, binding the witness identity to the lock event. The action string in the preimage prevents cross-action replay: a checkpoint signature cannot be presented as a finalize. This countersignature is persisted with the project and later verified by the verification endpoint 138, providing independent attestation that the witness service approved the lock at a discrete moment. Supports a dependent claim element of an action-typed second-party seal binding event metadata to a specific lock action."*
**Cross-ref figures:** FIG-03 (124, 126), FIG-04 (414), FIG-08 (lock_server extension).

---

## ch-04 — Three-Way Independent Verification

**Overall:** Excellent and highly detailed. The three-attestation model is precisely articulated. Describes the verification flow as a shipped system component when the live code (Segment 05.A) shows it's still manual/scripted.

### § Verification Request 402 — NEEDS_DETAIL
Describes a programmatic entry point. Live code today is the receipt page HTML (public, unauthenticated) + `audit-receipts.py` (third-party recipe). The integrated API endpoint is proposal 5B.2.
**Enhancement:** *"In some embodiments, the verification request 402 is implemented as a programmatic API endpoint (e.g., REST or GraphQL). In current implementations, the verification procedures described in FIG. 4 are performed manually by third parties using the receipt HTML page, an open-source audit script (Segment 05.A.1), and public ledger data. In planned embodiments, the verification endpoint 138 exposes an API that automates the three-way flow and returns a composite result."*
**Cross-ref figure:** FIG-01 (138), proposed FIG-04B (audit script detail).

### § Leaf Comparison 410 — NEEDS_DETAIL
The current spec compares the recomputed leaf to the receipt leaf. Live code (Segment 05.A.1) tries v2.2 → v2.1 → v2.0 canonical forms until one matches, supporting forward and backward compatibility across leaf schemes.
**Enhancement:** *"The leaf comparison 410 may be configured to test multiple canonical-form versions in sequence (e.g., v2.2 first, then v2.1, then v2.0) to support forward and backward compatibility across receipt scheme revisions."*
**Cross-ref figure:** add decision diamond to FIG-04 (try v2.2 → v2.1 → v2.0).

### § Publication-Mode-Aware Verification — **GAP**
Not mentioned. Live code (Segment 04 §10-11) ships three publication modes (Full / Hash-only / Witness-only). The verification flow should be mode-aware: in witness-only mode, only the leaf hash is shown, but seal validity and ledger inclusion remain verifiable.
**Enhancement:** Insert paragraph: *"The leaf comparison 410 may be configured to support selective-disclosure modes in which certain fields of the canonical bundle are redacted from presentation while their preimage hashes remain bound to the leaf. For example, in a 'witness-only' mode, the leaf hash is verifiable, but the workflow, input, and output hashes are redacted. The leaf preimage itself is unchanged across modes; redaction is presentation-only. This enables attestation-without-disclosure: a verifier can confirm seal and public-anchor validity even when content disclosure is restricted."*
**Cross-ref figures:** FIG-04 (410), FIG-08 (CMEK audit-without-disclosure), proposed FIG-03C.

---

## ch-05 — Cross-Domain Receipt Attestation

**Overall:** Well-structured. Forward-looking on shared-secret rotation. The image-case cross-link path is shipped; the deliberation case and rotation subgraph are planned. The chapter assumes more shipped than is true.

### § Secret Rotation Subgraph D 530 — NEEDS_DETAIL
Not yet implemented. The shared secret is static per controller-pair today.
**Enhancement:** *"In current implementations, the shared secret is static per controller-pair. In planned implementations, the rotation subgraph D enables time-based or event-triggered secret rotation with fingerprint-based verification that allows third parties to confirm continuity of prior MACs across the rotation boundary."*

### § Inverse Cross-Link MAC — AMBIGUOUS
The chapter assumes symmetric HMAC for inverse links. Worth flagging the asymmetric alternative.
**Enhancement:** *"In some embodiments, the inverse cross-link HMAC computer 526 uses an identical keyed construction as the forward link with the data field roles reversed. In alternative embodiments, the inverse link may use an asymmetric signature that proves authorization by the destination domain without requiring shared-secret distribution, supporting scenarios in which one domain is not fully trusted."*

### § Scope of Cross-Domain Attestation — **OVERCLAIM**
The chapter implies the cross-domain system is generally available. The image case (510, 512, 514, 516, 520) is shipped; the deliberation case and origin-side back-reference receipt (528) are planned. This needs explicit shipped-vs-planned framing.
**Enhancement:** Add a status table at the chapter's end with each numeral marked as shipped or planned.

---

## ch-06 — Stooges Adult-Tier Configuration

**Overall:** Clear preset-driven narrative. **Critical issue**: numeral consistency violations that must be resolved before filing.

### § Numeral Consistency — **OVERCLAIM / blocker**
References like "Receipt Generator (708, corresponding to 116/214)" introduce new numerals (708) without defining them in a FIG-06 numeral table. Per USPTO drafting convention and the engineer's notes in the spec, numerals must be either explicitly reused (with their original definition) or formally introduced in a numeral table.
**Enhancement:** Rewrite all such references. Options:
- Option A: *"The Canonical Bundle Assembler (212, reused from FIG. 2) is configured..."*
- Option B: Add an explicit FIG-06 numeral table that lists every numeral used in the chapter, with each marked as REUSED FROM <fig> or NEW.
**Cross-ref figure:** FIG-06 (must add numeral table).

### § Retention Policy Enforcer 612 — **OVERCLAIM**
Described as a system component. Live code does NOT implement a retention policy enforcer; deletion/anonymization of post-anchor event payloads is planned, not shipped.
**Enhancement:** *"In current implementations, the retention policy enforcer 612 is planned but not yet deployed; receipts are persisted indefinitely. The purge mechanism, when implemented, will preserve the integrity of any already-anchored cryptographic chains on the public ledger even after local deletion."*

### § Cross-Domain Disabled — AMBIGUOUS
The chapter says cross-domain attestation (FIG-05) is "disabled" in the Stooges adult preset. FIG-05 is presented as a standalone capability, creating uncertainty about whether it's *available but off* or *unavailable*.
**Enhancement:** Clarify: *"In the Stooges adult preset, the cross-domain attestation subgraph (FIG. 5) is supported but disabled by default. Users may opt in to cross-domain attestation by enabling the corresponding knob in the knob suite 130."*

---

## ch-07 — Stooges Jr Minor-Protection Configuration

**Overall:** Ambitious, technically detailed, but **multiple OVERCLAIMS** and numeral issues parallel ch-06.

### § Crisis Protocol Subgraph 706 — **OVERCLAIM**
Crisis detector 730, crisis verdict capture 732, forced window close 734, crisis notification dispatch 736 — none implemented in live code. These are forward-looking features.
**Enhancement:** *"In current implementations, the crisis protocol subgraph 706 is planned but not yet deployed; mandatory capture and notification loops are implemented, but crisis-driven forced closure is not yet active."*

### § Full Cross-Domain Attestation Overlay 704 — **OVERCLAIM**
Live code ships the image case (510-520); deliberation case and origin-side back-reference receipt (528) are planned.
**Enhancement:** *"In current implementations, the core cross-link generation 512 and verification 520 are shipped for the image-generation use case; the deliberation case and the origin-side back-reference receipt 528 are planned for a future release."*

### § Notification-Evidence Loop — NEEDS_DETAIL
Loop described as fully wired (dispatch → witness → ledger). Live code wires dispatch and capture but not the closed loop.
**Enhancement:** *"In current implementations, notification dispatch is functional; the automatic re-routing of notification events through the witness pipeline is planned for a near-term release."*

### § Numeral Consistency — **OVERCLAIM / blocker**
Same issue as ch-06: 702, 704, 706, 714, 716, 720-740 used without a FIG-07 numeral table that explicitly distinguishes reused-from-FIG-1 from new-to-FIG-7.
**Enhancement:** Add a FIG-07 numeral table.

---

## ch-08 — STIFS Enterprise-Compliance Configuration

**Overall:** Sophisticated and ambitious. The CMEK encryption layer, audit-without-disclosure separation, and four-attestation result composer represent novel claims. Many features are aspirational rather than shipped.

### § CMEK Encryption Layer 820 — **OVERCLAIM**
Not implemented. Canonical bundles are currently hashed in plaintext.
**Enhancement:** *"In current implementations, the CMEK Encryption Layer 820 is a planned feature; plaintext canonical bundles are currently hashed and sealed directly. When implemented, the CMEK layer will introduce a decryption-on-read step 826 during verification, allowing plaintext-match attestation only when the Customer CMEK Key 810 is supplied."*

### § Four-Attestation Result Composer 828 — **OVERCLAIM**
Not implemented. Live verification produces a single per-receipt view.
**Enhancement:** *"In current implementations, the four-attestation composer 828 is a planned enhancement; the verification flow currently provides attestations without CMEK separation."*

### § BYOK Token Usage Capture 822 and Admin Action Capture 824 — **OVERCLAIM**
Neither shipped. Live code captures prompts, responses, artifacts, and verdicts only.
**Enhancement:** *"In current implementations, these modules are planned features; core capture is limited to prompts, responses, artifacts, and verdicts."*

### § Tenant-Admin Binding Key 836 — NEEDS_DETAIL
Live code's cross-domain support is image-case shared secret only; tenant-admin binding is planned.
**Enhancement:** *"The tenant-admin binding key 836 may be implemented as a shared symmetric secret derived from a customer-controlled passphrase or hardware security module, an asymmetric key pair with the public key registered at both domains, or a derived ephemeral key established via a secure channel (e.g., Diffie-Hellman) at configuration time. In current implementations, the tenant-admin binding is planned; cross-domain binding is supported only for controller pairs within a single administrative domain."*

### § Effect of CMEK on Merkle Root — **GAP**
The chapter doesn't address whether the Merkle root is computed over plaintext leaves or ciphertext leaves under CMEK. This is load-bearing for the "audit without disclosure" claim.
**Enhancement:** *"Under the CMEK encryption layer 820, the Merkle root is computed over ciphertext leaves. This ensures the witness service 118 and public ledger 300 never see plaintext. Verification of the first three attestations (ciphertext chain position, witness seal, public anchor) requires only public data and is therefore achievable by any third party. Verification of the fourth attestation (plaintext match) requires the Customer CMEK Key 810, supplied by the customer at audit time."*

---

# Part 2 — Figures, figure-by-figure

## FIG-01 — Substrate Master — STRONG with refinements

**What it shows:** Five-layer architecture (capture / core / knobs / verification / side-channel). Maps to all 5 segments.

**Critique:**
- Mixes architectural primitives with product presets (Stooges 132 / SJ 134 / STIFS 136 shown as if they are core components rather than configurations).
- No reference numerals for `machine_manifest_hash`, `prev_record_hash`, or `capture_method='manual'`.
- "Public Ledger Anchor 126" is a single box, hiding the three-anchor pattern.
- Notification dispatcher feedback loop is shown but the per-notification receipting is not visible.

**Enhancements:**
- Move presets out of the architectural layer; render them as a "Configuration Profiles" sidebar that overlays the Knob Suite.
- Add new reference numerals: `machine_manifest_hash` (e.g. 145), `prev_record_hash` (e.g. 146).
- Expand "Public Ledger Anchor 126" into three sub-anchors: 126a RVN mint, 126b IPFS pin, 126c Arweave token, with conditional edges per tier.
- Add a decision diamond between dispatcher 142 and capture 110 labeled "auditable dispatch loop."

**Cross-ref chapters:** all (ch-01 specifically).

---

## FIG-02 — Receipt Generation — NEEDS_DETAIL

**What it shows:** Linear flow event → bundle assembly → hash → witness seal → persistence. Maps to Segment 02.

**Critique:**
- **The five hashes are collapsed into a single "hash leaf" 214.** Segment 02 §4 defines five (output, input, workflow, model_fingerprints, machine_manifest).
- **Prev_record_hash chaining is omitted entirely.**
- Canonicalization rule (compact JSON, fixed field order, empty-string defaults) is not visualized.
- Witness service 218 boundary is correct but the separate-process nature is implicit.

**Enhancements:**
- Break "hash computation 214" into five parallel sub-hashes: 214a input_hash, 214b output_hash, 214c workflow_hash, 214d model_fingerprints_hash, 214e machine_manifest_hash.
- Add Prior Receipt Pointer Fetcher (e.g. 211) feeding `previous_hash` into the assembler.
- Add a Leaf Scheme Selector (e.g. 215) that sets `leaf_scheme = machine_manifest_hash ? 'v2.2' : 'v2'`.
- Annotate witness service 218 with "separate Node process" marginalia.

**Cross-ref chapter:** ch-02.

---

## FIG-03 — Chain Assembly + Public Anchor — NEEDS_DETAIL

**What it shows:** Chain validation → window batching → Merkle tree → ledger submission. Maps to Segment 04 but **conflates local lock with chain lock**.

**Critique:**
- Local lock (Segment 03) entirely missing: no Merkle root computation moment, no `lock_server_signature`, no state transition box.
- Decision diamonds for "status permits chain lock?" and "tier = pinned?" absent.
- Three-anchor pattern not visible.
- Publication modes (Segment 04 §10-11) not shown.
- SCR-ID derivation rule (first 8 hex of `sha256(merkle_root)`) not depicted.

**Enhancements:**
- **Split into FIG-03A (Local Lock) and FIG-03B (Chain Lock).** Local Lock shows Merkle root computation → lock_server_signature → state transaction → receipt visibility. Chain Lock shows wallet vs custodial branch → SCR-ID derivation → three-anchor submission.
- Add a third panel FIG-03C — Publication Mode Redaction — showing per-iteration mode setter, render-time conditional, upgrade-only enforcement.
- Expand Ledger Selector 320 to three branches (RVN, IPFS conditional, Arweave) with COALESCE write-back annotation.

**Cross-ref chapters:** ch-03 (Local Lock), ch-04 (Chain Lock).

---

## FIG-04 — Verification Flow — STRONG with refinements

**What it shows:** Three parallel branches (event-content match / witness seal / public anchor) → result composer → output. Maps to Segment 05.

**Critique:**
- `audit-receipts.py` (Segment 05.A.1) not referenced as the canonical re-derivation tool.
- Leaf-scheme fallback (v2.2 → v2.1 → v2.0) not shown as a decision diamond.
- Planned vs shipped not visually distinguished.
- Witness Identity Resolver 412 has two input paths (witness 218 direct vs public ledger 300) but the trust-minimal preference isn't called out.

**Enhancements:**
- Add a sub-flowchart FIG-04B — Audit Script Re-derivation — showing the five hash recomputations in sequence.
- Insert decision diamond after 410: "leaf v2.2 hash matches? NO → try v2.1 → NO → try v2.0."
- Visually distinguish shipped (solid border) from planned (dashed border) nodes per USPTO convention.
- De-emphasize the witness 218 → resolver 412 direct path; emphasize the public-ledger 300 → resolver 412 trust-minimal path.

**Cross-ref chapters:** ch-04, ch-08 (four-attestation extension).

---

## FIG-05 — Cross-Domain Attestation — OVERCLAIM

**What it shows:** Origin domain → cross-link HMAC → dispatch → destination → inverse HMAC, with optional secret rotation. **Not covered by the 5-segment baseline.**

**Critique:**
- This is an extension feature; the patent-delta segments (01-05) define the baseline end-to-end flow. Cross-domain attestation deserves its own segment.
- Shipped (512, 520 image-case) vs planned (528 back-reference, 530-536 rotation) is unclear.
- No integration with the local-lock handshake (Segment 03) is shown.

**Enhancements:**
- Either: promote FIG-05 to a continuation-in-part segment (proposed segment 06 — Cross-Domain Attestation) with its own canonical flow and decision diamonds; or
- Integrate it into FIG-07 (Stooges Jr binding) and FIG-08 (STIFS tenant-admin) where it actually appears in the live system.

**Cross-ref chapter:** ch-05.

---

## FIG-06 — Stooges Adult Preset — AMBIGUOUS

**What it shows:** Selective module activation, opt-in audit, controller-discretion retention.

**Critique:**
- No formal reference numeral table; the chapter introduces 706, 708, etc. without specifying their relationship to FIG-01.
- Redundant with FIG-01's Knob Suite preset.
- Retention Policy Enforcer 612 implies a shipped purge mechanism that doesn't exist in code.

**Enhancements:**
- Recast as a detail callout from FIG-01 rather than a standalone figure: **FIG-06A — Stooges Adult Configuration Variant.**
- Provide a formal reference numeral table.
- Expand "Retention Policy Enforcer" with three explicit policy branches (retain-forever / retain-N-days / controller-discretion) and a "planned" marker.

**Cross-ref chapter:** ch-06.

---

## FIG-07 — Stooges Jr Minor-Protection — NEEDS_DETAIL

**What it shows:** Full-coverage capture + cross-domain binding + notification-evidence loop + crisis protocol.

**Critique:**
- Crisis protocol subgraph (730/732/734/736) and Session Pause Trigger (740) not in baseline segments — novel.
- Shipped vs planned not separated.
- Notification-evidence loop shown as wired; live code is not fully closed.
- No formal numeral table.
- Cross-domain binding to FIG-05 not annotated for the controller-pair (parent/child) case.

**Enhancements:**
- Promote crisis protocol to its own sub-segment with canonical flow and decision diamonds.
- Add formal numeral table separating FIG-01 reuse from new FIG-07 numerals.
- Add shipped-vs-planned table per numeral.
- Add entry decision diamond: "minor tier? YES → continue, NO → fall back to FIG-06."

**Cross-ref chapter:** ch-07.

---

## FIG-08 — STIFS Enterprise — NEEDS_DETAIL / OVERCLAIM

**What it shows:** CMEK encryption layer + BYOK + admin capture + four-attestation composer + tenant-admin binding.

**Critique:**
- CMEK encryption-before-hashing inverts the baseline flow (plaintext → encrypt → hash → seal). Not covered in segments 01-05.
- "Audit without disclosure" claim is novel; needs explicit framing of the verification flow for ciphertext-only-verifiers vs key-holders.
- Effect of CMEK on Merkle root computation (over plaintext vs ciphertext leaves) not addressed.
- Admin Action Capture 824 is a new event class — needs its own segment or explicit integration.
- No shipped-vs-planned table.
- Cross-domain reuse from FIG-05 doesn't address whether the HMAC is over plaintext or ciphertext.

**Enhancements:**
- Promote to its own continuation-in-part segment: **segment 07 — Enterprise Encryption (CMEK)** with full canonical flow including key rotation, decryption-on-read, ciphertext-derived Merkle root, audit-script fallback.
- Specify in segment 07: Merkle root is over ciphertext leaves; verification of first three attestations is keyless; plaintext attestation requires Customer CMEK Key 810.
- Add state-write implications: new columns for `key_fingerprint`, `encrypted_bundle`.
- Add shipped-vs-planned table.
- Address cross-domain HMAC under CMEK explicitly.

**Cross-ref chapter:** ch-08.

---

# Part 3 — Cross-cutting gaps consolidated

| Gap | Code | Where it should appear | Status in code | Status in patent |
|---|---|---|---|---|
| Toolchain binding (machine_manifest_hash) | G-1 | ch-02 (208/209), FIG-02 (214e) | **SHIPPED** Segment 02 §4 | Implied, not named |
| Proxy-as-cryptographic-gate | G-2 | ch-01 (witness/capture boundary), new figure | **SHIPPED** Segment 01 §10 | Not named |
| Non-custodial Stripe pre-auth | G-3 | ch-01, new FIG-09 | **SHIPPED** Segment 01 §8 | Not named |
| Publication-mode redaction | G-5 | ch-00, ch-04, ch-08, new FIG-03C | **SHIPPED** Segment 04 §10-11 | **ENTIRELY ABSENT** |
| HMAC vs asymmetric witness signing | open | ch-00, ch-02 §218, ch-04 §414 | HMAC; standard mandates asymmetric | Acknowledged but unresolved |
| `lock_server_signature` action-typed replay protection | open | ch-03 (new section), FIG-03 (new component) | **SHIPPED** Segment 03 §8 | **ENTIRELY ABSENT** |
| Three-anchor COALESCE resilience | open | ch-03 (new section), FIG-03 (expanded anchor) | **SHIPPED** Segment 04 §9 | **ENTIRELY ABSENT** |
| 5B forward-looking proposals (audit cron / public verifier / webhook re-audit / watchdog service / attorney offline kit) | open | ch-00 forward-looking, segment 05 CIP | PLANNED Segment 05.B | **ENTIRELY ABSENT** — CIP candidates |

---

# Part 4 — Proposed new figures

| # | Title | Why | Source |
|---|---|---|---|
| **FIG-02B** | Proxy interception (browser → /canvas-proxy/{sessionId}/ → Modal upstream, with witness hooks on POST /prompt and GET /view) | G-2 patent-bearing gate not depicted | Segment 01 §10, Segment 02 §1-3 |
| **FIG-03A** | Local Lock flow (Merkle root computation → witness confirm-and-execute → `lock_server_signature` → state transaction → receipt becomes viewable) | Currently conflated into FIG-03 | Segment 03 |
| **FIG-03B** | Chain Lock flow (wallet vs custodial branch → SCR-ID derivation → three-anchor submission with COALESCE) | Currently collapsed into FIG-03; three-anchor invisible | Segment 04 |
| **FIG-03C** | Publication-mode redaction (per-iteration mode setter → render-time conditional → upgrade-only enforcement) | G-5 entirely missing | Segment 04 §10-11 |
| **FIG-04B** | Audit script re-derivation (five hash recomputations → Merkle rebuild → chain check → anchor validation) | Patent describes verification logic; missing the script that implements it | Segment 05.A.1 |
| **FIG-09** | Stripe pre-auth lifecycle (PaymentIntent manual_capture mint → heartbeat tick → lock → capture-actual or cancel) | G-3 non-custodial billing pattern not depicted anywhere | Segment 01 §8 |

---

# Part 5 — Proposed new chapters / continuation-in-part candidates

| Proposed chapter | Scope | Continuation-in-part rationale |
|---|---|---|
| **ch-09 — Publication-Mode Redaction (G-5)** | Full / Hash-only / Witness-only modes; upgrade-only semantics; presentation-only redaction over unchanged preimage; mode-aware verification | Shipped feature with no current patent coverage — direct CIP candidate |
| **ch-10 — Cross-Domain Attestation (relocated from FIG-05)** | Cross-link HMAC, dispatch, intake, verify, inverse link, planned rotation | Promote from figure-only to full chapter with shipped-vs-planned table |
| **ch-11 — Crisis Protocol Subgraph (relocated from ch-07)** | Crisis-class detector, forced window close, immediate notification dispatch, session pause trigger | Novel claim cluster; separate from baseline minor-protection |
| **ch-12 — Enterprise Encryption / CMEK (relocated from ch-08)** | Plaintext → encrypt → hash → seal; ciphertext-only ledger; four-attestation verification; key rotation; decryption-on-read | Fundamental change to receipt format — needs its own claim cluster |
| **ch-13 — Automated Verification + Audit (5B proposals)** | Scheduled audit cron, public verifier endpoint, webhook re-audit on chain events, third-party watchdog service, attorney offline audit kit | Five distinct CIP candidates surfaced in Segment 05.B |

---

# Part 6 — Priority action list (filing readiness)

## Critical — must resolve before filing

1. **Add G-5 publication-mode coverage.** Update ch-00 (Summary), ch-04 (verification mode-awareness), ch-08 (plaintext/ciphertext modes). Add FIG-03C. Without this, a shipped feature is uncovered.
2. **Add `lock_server_signature` section to ch-03.** Action-typed replay protection is a discrete claim element. Add FIG-03A.
3. **Add three-anchor COALESCE resilience section to ch-03.** Expand FIG-03's anchor sub-tree.
4. **Resolve numeral consistency in ch-06 and ch-07.** Add explicit numeral tables for each figure. Per the engineer's notes this is a USPTO-convention blocker.
5. **Tighten all shipped-vs-planned status notes.** ch-01 (status of embodiments), ch-05 (cross-domain scope), ch-06 (retention policy), ch-07 (crisis protocol, cross-domain overlay, notification-evidence loop), ch-08 (CMEK, four-attestation, BYOK, admin capture, tenant-admin binding). Use the embodiment-status table format from FIG-08.

## High priority — strengthen before filing

6. **Explicitly claim G-1 (toolchain binding).** ch-02 add 209 sub-element; FIG-02 add 214e hash and a manifest resolver box.
7. **Explicitly claim G-2 (proxy-as-cryptographic-gate).** ch-01 expand witness-vs-capture boundary; add FIG-02B.
8. **Explicitly claim G-3 (non-custodial Stripe pre-auth).** ch-01 add a billing section; add FIG-09.
9. **Resolve HMAC-vs-asymmetric ambiguity.** ch-00 / ch-02 / ch-04 clarify with engineering trade-off and migration intent rather than neutral "in some embodiments" language alone.
10. **Add 5B forward-looking proposals as CIP candidates.** Either as ch-13 or as an appendix to ch-04.

## Medium priority — strengthen but not blocking

11. **Specify canonicalization rule** (compact JSON, fixed field order, empty-string defaults) in ch-02 §212. Re-derivation reproducibility depends on this being unambiguous.
12. **Add leaf-scheme fallback** (v2.2 → v2.1 → v2.0) to ch-04 §410 and FIG-04.
13. **Promote FIG-05 (cross-domain) to its own chapter** with shipped-vs-planned per numeral.
14. **Promote CMEK to its own chapter / segment** with effect on Merkle root explicitly addressed.
15. **Standardize reference-numeral conventions.** Even-integer scheme across all figures; FIG-NN numeral tables explicit about reuse vs new.

## Summary

The patent application is conceptually well-founded and the architecture maps cleanly to the live code. Three categories of work remain before filing:

- **Three shipped features are entirely absent from the patent prose** — publication modes (G-5), lock_server_signature, three-anchor resilience. These are direct claim opportunities.
- **Multiple sections overclaim planned features as shipped** — CMEK, crisis protocol, four-attestation composer, full cross-domain attestation, notification-evidence loop closure. Clarification with explicit shipped-vs-planned tables resolves this.
- **Numeral consistency in ch-06 and ch-07 is a USPTO-convention blocker** — add explicit reference numeral tables before submission.

Five strong continuation-in-part candidates surface from the 5B forward-looking proposals: scheduled audit cron, public verifier endpoint, webhook re-audit on chain events, third-party watchdog service, attorney offline audit kit.
