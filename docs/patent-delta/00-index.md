# Patent Delta — Index

**Scruple end-to-end canonical flow, segmented for flowchart generation and patent counsel.**

Date: 2026-06-24
Source: `/data/scruple-web` (branch: `feature/pivot`)
Companion: `/opt/scruple-witness/server.js` (witness server, Oracle VM, separate Node process)

## Purpose

Five outline documents tracing the canonical Scruple flow end-to-end, segmented for hand-off to chart-generation tools (Claude Web, Grok, mermaid) and to patent counsel for continuation-in-part analysis. Each segment is self-contained and includes code citations with file:line precision suitable for substantiating patent claims.

## Segments

| # | Title | Scope |
|---|---|---|
| 01 | Session Setup | Auth → tier resolution → Stripe pre-auth (manual_capture hold) → Modal machine boot → manifest pinning → proxy gate activation. |
| 02 | Graph Capture + Iteration Witnessing | Proxy interception (POST /prompt + GET /view) → hash construction (input / output / workflow / model_fingerprints / machine_manifest) → Leaf v2.2 canonical record → sign → chain via prev_record_hash. |
| 03 | Local Lock | Lock trigger → ownership + state validation → witness server confirm-and-execute → Merkle root over canonical-ordered leaves → lock_server_signature countersignature → state transition → receipt generation. |
| 04 | Chain Lock + Ledger Anchoring | Trigger → wallet vs custodial branch → RVN testnet asset issuance → optional IPFS pin (pinned tier) → Arweave token record → anchor state write-back → publication mode resolution (Full / Hash-only / Witness-only). |
| 05 | Verification + Audit | 5A live in code: `audit-receipts.py` + receipt page + manual third-party path. 5B proposed: scheduled audit cron, public verifier endpoint, browser extension, chain-event webhook re-audit, third-party watchdog, attorney offline kit, verify-on-view, per-project verification log. |

## Conventions used in all segment docs

- `[file:line-range]` — code citation
- `◇` — decision diamond (branch)
- `► State writes` — tables + columns affected at each step
- `► External calls` — Stripe / Modal / Google / RVN / IPFS / Arweave
- `► Key decision diamonds (for chart)` — 5-10 branch points to surface in mermaid
- `► Patent-bearing observations` — paragraphs labeled for CIP consideration

## Patent gap reference (G-N codes from prior Patent Coverage Audit)

- **G-1** — Toolchain-bound provenance via pinned-manifest hash + content-addressed execution image
- **G-2** — Server-side reverse proxy as cryptographic provenance gate between authenticated user and per-user rented compute
- **G-3** — Non-custodial billing via Stripe manual_capture pre-auth + capture-actual-on-end
- **G-5** — Presentation-layer redaction over an unchanged cryptographic preimage with upgrade-only semantics

These four gaps surface across the five segments below; segment docs flag them inline.

## Source code locations

- Main repo: `/data/scruple-web` (feature/pivot)
- Witness server: `/opt/scruple-witness/server.js`
- Modal runner: `/data/scruple-web/modal/canvas_app.py`
- Audit script: `/data/scruple-web/scripts/audit-receipts.py`

## Companion documents in `DevSpaceManual/Scruple/` (Drive)

- Patent Coverage Audit — gaps G-1 through G-9 identified
- SCRUPLE Standard — Technical Specification Draft v0.1 — normative spec
- C2PA Comparison v1.1 — competitive positioning
- Website v1 series — public-facing copy that references this architecture
