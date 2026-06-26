# Patent Delta — 05 — Verification + Audit

**Scruple canonical flow, segment 5 of 5.**

Source: `/data/scruple-web` (feature/pivot), `/opt/scruple-witness/server.js`

## Purpose

Trace third-party verification — what an external party does to independently confirm a SCRUPLE record. The Standard requires that anyone with the open verifier can re-derive every leaf from first principles, with no proprietary tool required.

This segment has two sub-parts:

- **5A** — what's live in code today (for patent delta accuracy)
- **5B** — proposed automated additions (forward-looking continuation-in-part candidates)

---

# 5A — Verification + Audit (LIVE IN CODE)

## 5A.1 — `audit-receipts.py`

**Location:** `/data/scruple-web/scripts/audit-receipts.py` (~374 lines)

**Input:**
- `MODE_PROJECTS` array of test projects across 5 modes (txt2img, img2img, txt2vid, img2vid, LoRA training)
- Two tiers: `local_locked` (DB only) and `persistent_locked` (RVN + IPFS + Arweave)

**What it re-derives from first principles:**

1. Per-iteration `leaf_hash` (three protocols, newest-first fallback):
   - **v2.2** — `sha256(canonical({run_sequence, output_hash, input_hash, workflow_hash, model_fingerprints_hash, machine_manifest_hash, server_timestamp, prev_record_hash}))`
   - **v2.1** — same but omits `machine_manifest_hash`
   - **v2.0** — omits both `machine_manifest_hash` and `model_fingerprints_hash`
2. `input_hash` — `sha256(canonical({provider, prompt, spec, inputs}))`
3. `workflow_hash` — `sha256(canonical(workflowApiJson))`
4. `model_fingerprints_hash` — `sha256(canonical(sorted_manifest))`
5. Merkle root — sorted-pair binary tree over leaves in `run_sequence` order

**What it checks (60+ assertions per project):**

- DB iteration ↔ witness server row match (content, input, workflow, leaf hashes)
- Artifact bytes match recorded SHA-256 (samples first input, verifies length)
- Leaf hash reproducibility (tries v2.2 → v2.1 → v2.0 until match)
- Merkle root matches `project.merkle_root`
- Receipt HTML contains every full hash and the verification recipe
- Witness server journal shows `[WITNESS]`, `[CHECKPOINT]`, `[LOCAL_LOCK]` markers
- Lock countersignature (HMAC) present and rendered
- Chain anchors validated:
  - RVN testnet asset issuance + tx confirmation
  - IPFS CID resolvable
  - Arweave URI in receipt

**Output:** structured report; current state (smoke A-3): 260/260 checks passing across all 5 modes.

**Dependencies:** stdlib only (`hashlib`, `json`, `sqlite3`, `urllib.request`, `subprocess` for `journalctl`). External: public RVN testnet node, public IPFS gateway, public Arweave HTTP API. **No proprietary or non-redistributable dependencies.**

## 5A.2 — Receipt page

**Location:** `/data/scruple-web/app/receipt/[scrId]/page.tsx` (~652 lines)

**Route:** `GET /receipt/{scrId}` — **public, unauthenticated**.

**Rendered fields:**

1. Header — project name, SCR-ID, lock status, timestamp
2. Stat grid — iteration count, witnessed count, Merkle depth, project type
3. Merkle root (full SHA-256 monospace)
4. Witness server signature
5. Lock countersignature (HMAC over `{project_id, action, merkle_root, witnessed_count, locked_at}`)
6. Iterations — per iteration:
   - Header — seq, leaf scheme badge (v1/v2/v2.2), output_kind, machine, timestamp
   - Hash grid (leaf, output, input, workflow, models — per publication-mode redaction)
   - Model files loaded — path, content_hash, header_hash, size, mtime
   - Input artifacts — kind, filename, hash, byte count
   - Witness footer — witness_id, signature prefix, status
7. Verification recipe — step-by-step third-party re-derivation instructions
8. Execution attestation summary
9. Training-run fingerprints (for training projects)
10. On-chain references — RVN tx, IPFS CID, Arweave URI

**Publication-mode redaction** — render-time conditional on iteration's `workflow_publication` field. Leaf preimage unchanged across modes; redaction is presentation-only. `[receipt:278-286]`

## 5A.3 — Receipt PDF

**Current state:** not yet implemented. Browser print-to-PDF works against the HTML page. Native PDF generation deferred (tracked as part of WO-12).

## 5A.4 — Public verification path (third-party manual)

**Step-by-step for anyone with a SCR-ID:**

1. Fetch `/receipt/{scrId}` HTML (unauthenticated).
2. Extract the verification recipe from the page.
3. For each iteration:
   - Recompute `input_hash`, `workflow_hash`, `model_fingerprints_hash` (canonical JSON rules in receipt).
   - Fetch input artifacts via `GET /api/artifact/{hash}`; verify SHA-256 + byte count.
   - Assemble canonical Leaf v2.2 record; compute `sha256(canonical_json)`; compare to receipt leaf_hash.
4. Build Merkle tree (sorted-pair binary) over leaves in `run_sequence` order; compare to receipt root.
5. If chain-locked: query RVN testnet for SCR_ asset; confirm Merkle root in asset description matches.
6. If pinned tier: fetch IPFS CID + Arweave URI; verify they match leaf hashes + root.

**Verifiable from public ledger alone (no receipt needed):**
- Merkle root committed on-chain
- Asset mint timestamp
- Mint wallet address

**Requires the receipt:**
- Iteration-level detail (hashes, timestamps, models, inputs)
- Witness server signatures (per-iteration + lock event)

**No proprietary tools required** — `audit-receipts.py` is in the repo (MIT/Apache), stdlib-only.

## 5A.5 — Existing CI / smoke

**Invocation:** `python /data/scruple-web/scripts/audit-receipts.py`

**Smoke history:**
- A-3 — full-spectrum audit across all 5 modes — 260/260 passing
- L-5, L-6 — `lock_server_signature` smoke
- M-4 — receipt renders model fingerprints + audit script check
- C-4 — extend audit to cover chain-lock anchors per mode

## Decision diamonds (for 5A flowchart)

| ID | Where | Condition | Branches |
|---|---|---|---|
| D1 | audit start | Project locked? | YES → proceed \| NO → skip chain checks |
| D2 | per iteration | Leaf scheme version? | v2.2 / v2.1 / v2.0 → dispatch canonical form |
| D3 | per iteration | Witness row found in server DB? | YES → compare \| NO → fail (unwitnessed) |
| D4 | per iteration | Input artifacts fetchable? | YES → verify \| NO → warn (orphaned) |
| D5 | tree build | Merkle root reproducible? | YES → continue \| NO → fail |
| D6 | chain checks | Anchors present? | ALL/PARTIAL/NONE → conditional checks |
| D7 | lock_server_signature | Field set? | YES → verify HMAC \| NULL → allow (legacy) |
| D8 | execution_attestation | Payload present? | YES → optional GPU-vendor PKI check \| NO → baseline sufficient |

---

# 5B — Proposed Automated Verification + Audit (FORWARD)

The following eight proposals build on the existing architecture (witness server, `audit-receipts.py`, RVN + IPFS + Arweave anchors). Each is grounded in current code surfaces and flagged for continuation-in-part eligibility.

## 5B.1 — Scheduled Random Audit Cron

**One-line:** Daily sampling of N% of locked projects with full audit; alert on mismatch.

**What it adds:** Continuous assurance that locked receipts remain reproducible over time. Catches artifact expiry, DB corruption, ledger divergence early. Builds a "Verified on DATE" timestamp for the UI.

**Implementation surface:**
- `scripts/audit-scheduled.sh` cron wrapper.
- New table `receipt_audit_log(project_id, audit_date, pass_count, fail_count, details)`.
- `GET /api/projects/[id]/audit-status`.
- Receipt sidebar badge: "Last verified: DATE."
- Systemd timer targeting 2% of projects per night (~7 weeks to 100%).

**CIP candidate:** YES — recurring automated verification with time-stamped audit trail is novel.

## 5B.2 — Public Verifier Web Endpoint

**One-line:** `scruple.ai/verify/{scrId}` runs audit on-the-fly, returns pass/fail + reproducibility proof.

**What it adds:** Anyone can paste a SCR-ID and see "Verified ✓" in seconds. No CLI, no signup. Shareable link.

**Implementation surface:**
- `app/verify/[scrId]/page.tsx` — fetches receipt, calls audit-receipts.py subprocess, streams results.
- `POST /api/verify/check` — JSON endpoint.
- `VerifyWidget` component (checkmarks per step, anchor confirmations).
- Cache: `verify:{scrId}:{hash(receipt_json)}` 12h TTL.
- Rate limit: 100 verifies/hour/IP.

**CIP candidate:** YES — publicly accessible verification UI for decentralized artifact proof.

## 5B.3 — Browser Extension Badge

**One-line:** Detect SCRUPLE receipt URLs; run client-side audit; render ✓ or ✗ badge in toolbar.

**What it adds:** Passive assurance while viewing receipts (including third-party shares). Click → detailed audit report modal.

**Implementation surface:**
- `/extensions/scruple-badge/` Manifest v3 Chrome extension.
- Content script detects receipt page, extracts scrId.
- Background worker runs audit (local Python or WASM port).
- Popup HTML for detail view.

**CIP candidate:** MAYBE — browser-integrated verification UI for decentralized proof. Risk: extension adoption barrier.

## 5B.4 — Webhook Re-audit on Chain Events

**One-line:** RVN node emits event on SCR_ mint/burn; triggers automatic full audit.

**What it adds:** Real-time assurance at anchor time. Catches on-chain vs off-chain divergence the moment a mint confirms.

**Implementation surface:**
- `lib/webhooks/ravencoin.ts` — parse RVN node block events, filter SCR_ operations.
- `POST /api/webhooks/rvn` (HMAC-gated).
- Handler runs audit, persists to `receipt_audit_log`.
- Subscribe to local RVN node; fallback to hourly poll.
- Alert on failure (Slack/email).

**CIP candidate:** YES — event-driven verification triggered by distributed ledger confirmation.

## 5B.5 — Third-party Watchdog Service

**One-line:** External party maintains shadow index of all SCRUPLE records; cross-checks weekly; publishes signed index.

**What it adds:** Cross-validation. Detects retroactive modification (Scruple cannot quietly rewrite the past — the watchdog index would diverge).

**Implementation surface:**
- `docs/WATCHDOG_KIT.md` — protocol for external auditors.
- `GET /api/projects/public/list` (paginated).
- `scripts/export-all-receipts.sh` for mirroring.
- `lib/watchdog/index.ts` — types for third-party audit log.
- Optional: render "Cross-checked by [Auditor] on DATE" on receipt.

**CIP candidate:** YES — third-party audit service model with mutually-verifiable published indices.

## 5B.6 — Patent-Attorney Offline Audit Kit

**One-line:** Self-contained ZIP for legal discovery: audit script + offline RVN snapshot + IPFS tar + Arweave snapshot + verify.sh.

**What it adds:** Reproducible verification in an isolated environment for litigation, escrow, compliance audits. No internet needed.

**Implementation surface:**
- `scripts/export-audit-kit.sh` — bundles project DB rows, artifacts, witness DB rows, RVN snapshot, IPFS tar, Arweave records, audit script + lockfile.
- `scripts/verify-offline.py` — runs against bundled data only.
- Deterministic kit hash; optional PGP sign.

**CIP candidate:** YES — self-contained verification package for third-party legal discovery.

## 5B.7 — Verify-on-View with Cache

**One-line:** Receipt page load triggers lightweight audit in background; renders "Verified 2m ago" badge inline.

**What it adds:** Instant trust signal without leaving the page. Cached pass/fail keyed by `(scrId, root_hash)`.

**Implementation surface:**
- `lib/verify/client.ts` — pure JS Merkle builder.
- `lib/verify/server.ts` — async audit runner.
- `POST /api/verify/lightweight?scrId=...` returns `{status, root, timestamp, elapsed_ms}`.
- `VerifyBadge` component in receipt header.

**CIP candidate:** NO — UX refinement on existing capabilities.

## 5B.8 — Per-Project Verification Log

**One-line:** Track audit attempts per project; project owner sees "Verified 47 times by 3 IPs."

**What it adds:** Trust metric backed by observable usage, not just capability. Useful for showing business partners or legal discovery.

**Implementation surface:**
- Migration: `receipt_verification_log(project_id, scrId, verified_by, verified_at, result, ip_hash, referrer)`.
- On receipt page mount: client-side POST `/api/verify/log-view`.
- `GET /api/projects/[id]/verification-stats` returns summary.
- `VerificationHistoryChart` component.
- Privacy: IP hashed; opt-in for public badge.

**CIP candidate:** MAYBE — crowd-sourced verification audit trail as a trust metric.

## Decision diamonds (for 5B flowchart)

| Axis | Choice 1 | Choice 2 | Maps to proposals |
|---|---|---|---|
| Initiator | User | Automated | User → 5B.2, 5B.3, 5B.6 ; Auto → 5B.1, 5B.4, 5B.5, 5B.7 |
| Trigger | On-demand | Event-driven | On-demand → 5B.2, 5B.6 ; Event → 5B.4 ; Scheduled → 5B.1 |
| Trust party | Scruple | Third party | Scruple → 5B.1, 5B.4, 5B.7 ; Third → 5B.5, 5B.6 |
| CIP eligibility | YES | NO | YES → 5B.1, 5B.2, 5B.4, 5B.5, 5B.6 ; NO → 5B.7 ; MAYBE → 5B.3, 5B.8 |

## Summary — top CIP candidates from 5B

1. **5B.1 — Scheduled Random Audit Cron** — persistent audit trail, time-stamped verification
2. **5B.2 — Public Verifier Web Endpoint** — reduced barriers to third-party verification
3. **5B.4 — Webhook Re-audit on Chain Events** — event-driven verification triggered by ledger confirmation
4. **5B.5 — Third-party Watchdog Service** — incentivized cross-validation with published indices
5. **5B.6 — Patent-Attorney Offline Audit Kit** — offline reproducible verification for legal discovery

The remaining three (5B.3 extension, 5B.7 verify-on-view, 5B.8 verification log) are UX/analytics refinements with weaker patent posture but real product value; consider bundling as "enhanced user trust signals" in a single CIP claim if pursued.
