# Patent Delta — 04 — Chain Lock + Ledger Anchoring

**Scruple canonical flow, segment 4 of 5.**

Source: `/data/scruple-web` (feature/pivot), `/opt/scruple-witness/server.js`, `/opt/scruple-witness/testnet-locker.js`, `/opt/scruple-witness/ipfs-pinner.js`, `/opt/scruple-witness/arweave-treasury.js`

## Purpose

Trace the public-ledger anchoring step that follows local lock: the locked Merkle root is minted to the Ravencoin testnet as an on-chain asset, optionally pinned to IPFS, and recorded as an Arweave token. Three publication modes (Full / Hash-only / Witness-only) are resolved here as pure presentation redaction over the unchanged cryptographic preimage.

## Canonical flow (numbered)

1. **User triggers chain lock** — `[components/LockButtons.tsx:61-66, 100-135]` — `⛓ Chain Lock` button on a locally-locked project. Pre-condition: project must be locked (Segment 3 completed).

2. **◇ DECISION — payment mode** — `[components/wallet/LockConfirmModal.tsx:52-98]`
   - **Fiat (custodial)** → `StripePaymentModal` → `/api/stripe/confirm`
   - **Wallet (non-custodial)** → direct → `POST /api/lock/chain`

3. **◇ DECISION — anchoring tier (fiat only)** — `[LockConfirmModal.tsx:128-150]`
   - **Basic ($50)** — RVN mint + Arweave token (no IPFS pin)
   - **Pinned ($65)** — RVN mint + IPFS pin + Arweave token

4. **API route** — `[app/api/lock/chain/route.ts:36-159]`
   - Path A (custodial Stripe) — `[lines 105-129]` → `witness.confirmAndExecute()`
   - Path B (wallet) — `[lines 134-159]` → `witness.lockProject()`
   - Both paths converge on the same witness-side handler.

5. **SCR-ID derivation** — `[server.js:597-598, 1057-1058]` — `SCR_` + first 8 hex chars of `sha256(merkle_root).toUpperCase()`. Deterministic from the Merkle root, so the SCR-ID is the same regardless of who triggers the chain lock.

6. **RVN testnet asset issuance** — `[opt/scruple-witness/testnet-locker.js:44-76]` — `issueAsset(scrId, ipfsCid)`:
   - Calls `raven-cli issue` on testnet.
   - Asset description embeds Merkle root.
   - Returns `{ txid, scrId }`.
   - **Failure handling:** mint failure does NOT fail the lock (returns mintError; lock proceeds with chain anchors absent). `[server.js:606]`

7. **IPFS pin (pinned tier only)** — `[server.js:263-287, ipfs-pinner.js:22-84]`
   - Trigger: `tier === 'pinned'`.
   - Pin JSON proof record to local Kubo via multipart `/api/v0/add`.
   - Returns CID.
   - Failure non-blocking. `[server.js:286]`

8. **Arweave token record (basic + pinned)** — `[server.js:290-306, arweave-treasury.js:71-114]`
   - Trigger: always runs.
   - Treasury wallet loaded from `AR_KEY_PATH` env var.
   - Defaults to arlocal (`localhost:1984`); env-configurable to mainnet.
   - Posts JSON token record: `{scr_id, merkle_root, rvn_txid, witness_signature, ipfs_cid}`.
   - Returns TX URI. Failure non-blocking. `[server.js:306]`

9. **Anchor state write-back** — `[app/api/lock/chain/route.ts:171-207]` — transaction:
   - DELETE + INSERT `merkle_nodes`.
   - UPDATE `projects` with COALESCE semantics: existing rvn_txid/ipfs_cid/arweave_uri preserved if a new mint/pin failed.
   - Status transition:
     - **chain_locked** (basic tier)
     - **persistent_locked** (pinned tier)
   - Columns: status, merkle_root, witnessed_count, scr_id, rvn_txid, ipfs_cid, arweave_uri, locked_at, updated_at, is_active=0.

10. **Publication mode resolution per iteration** — `[app/api/iterations/[id]/publication/route.ts:1-86]`
    - Per-iteration field `workflow_publication`: `'full' | 'hash-only' | 'witness-only'`.
    - Default `'full'`.
    - Modes can be set anytime (before or after chain lock).

11. **Receipt rendering per publication mode** — `[app/receipt/[scrId]/page.tsx:278-325]`
    - `full` — show all hashes (workflow + input + output + models).
    - `hash-only` — show output + manifest; redact workflow + input.
    - `witness-only` — show leaf + timestamp only; redact output/input/workflow.
    - Publication mode label displayed in receipt header per iteration.

12. **End — project anchored to public ledger** — independently verifiable by any third party with the receipt + a Ravencoin testnet node (+ IPFS gateway + Arweave HTTP API for the pinned tier).

## Decision diamonds (for flowchart)

| ID | Where | Condition | Branches |
|---|---|---|---|
| D1 | LockButtons | Lock kind = chain? | YES → continue \| NO → Segment 3 |
| D2 | chain/route.ts:60-62 | Status permits chain lock? | YES → continue \| NO → 409 (already chain-locked) |
| D3 | chain/route.ts:68-70 | Iterations exist? | YES → continue \| NO → 400 |
| D4 | LockConfirmModal | Wallet or fiat? | WALLET → Path B \| FIAT → Path A |
| D5 | LockConfirmModal:128-150 | Fiat tier: basic or pinned? | BASIC → no IPFS \| PINNED → IPFS pin |
| D6 | /api/stripe/confirm | PaymentIntent succeeded? | YES → witness call \| NO → 402 |
| D7 | server.js:confirmAndExecute | Witness approves? | YES → continue \| NO → 402 |
| D8 | testnet-locker.js | RVN mint succeeded? | YES → capture txid \| NO → mintError (lock continues) |
| D9 | server.js:263 | tier === 'pinned'? | YES → IPFS pin \| NO → skip |
| D10 | ipfs-pinner.js | IPFS pin succeeded? | YES → capture CID \| NO → log + continue |
| D11 | arweave-treasury.js | Arweave post succeeded? | YES → capture URI \| NO → log + continue |
| D12 | receipt/page.tsx:278-286 | Per iteration: publication mode? | full/hash-only/witness-only → conditional render |

## State writes

| Table | Columns | File:Line |
|---|---|---|
| merkle_nodes | project_id, level, position, hash, left_child_hash, right_child_hash | `lock/chain:172-179` |
| projects | status (chain_locked or persistent_locked), merkle_root, witnessed_count, scr_id, rvn_txid, ipfs_cid, arweave_uri, locked_at, updated_at, is_active=0 | `lock/chain:181-205` |
| iterations | workflow_publication | `iterations/[id]/publication/route.ts:82` |
| witness server (ledger anchors) | scr_id → rvn_txid, ipfs_cid, arweave_uri | `server.js:991-1128` |

## External calls

- **Stripe** — `paymentIntents.retrieve` (witness-side verification)
- **Ravencoin testnet** — `raven-cli issue` (asset mint)
- **IPFS Kubo** — `POST /api/v0/add` (pin proof record)
- **Arweave** — POST to arlocal (`localhost:1984`) or mainnet (treasury wallet signs)

## Patent-bearing observations

**Three-anchor pattern with COALESCE write-back (resilience)** — RVN, IPFS, and Arweave anchors are independent. Mint failure does not invalidate the lock; the project records what succeeded. Subsequent retries can fill missing anchors without invalidating prior ones (COALESCE semantics). `[lock/chain:181-205, server.js:606,286,306]`

**Publication-layer redaction is presentation-only (G-5 candidate)** — The cryptographic leaf preimage is unchanged across all three publication modes. Redaction happens at receipt render time, gated by `workflow_publication` per iteration. Upgrade-only enforcement: `'witness-only' → 'hash-only' → 'full'`, no downgrade. This separates "what was committed" from "what is shown." A holder can upgrade their disclosure without invalidating any prior receipt. `[iterations/[id]/publication/route.ts:22-26, 71-79, receipt:278-286]`

**Custodial vs non-custodial parity** — Path A (Stripe-paid custodial) and Path B (user wallet non-custodial) produce identical on-chain artifacts (same SCR-ID, same Merkle root, same RVN asset). The only difference is who signed the RVN transaction. Receipts from both paths are indistinguishable to third-party verifiers. `[lock/chain:105-159]`

**SCR-ID determinism** — SCR-ID = first 8 hex chars of `sha256(merkle_root)`. The same project content always produces the same SCR-ID, regardless of when or by whom it's chain-locked. Re-anchoring is detectable; collisions require finding a 32-bit hash partial collision on the Merkle root (cost: ~2^16 work). `[server.js:597-598, 1057-1058]`

## Sub-flowchart candidates

- **Anchor failure handling** — what happens when each of the three anchors fails — useful as a separate diagram for resilience claims.
- **Publication mode lifecycle** — set, upgrade, render — useful as a separate diagram for the G-5 claim specifically.
- **Wallet path detail** — what the user's wallet actually signs — useful if the patent counsel wants to differentiate custodial-vs-non-custodial flows for jurisdictional reasons.
