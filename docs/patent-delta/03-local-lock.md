# Patent Delta — 03 — Local Lock

**Scruple canonical flow, segment 3 of 5.**

Source: `/data/scruple-web` (feature/pivot), `/opt/scruple-witness/server.js`

## Purpose

Trace the moment the user finalizes (or checkpoints) a project: the server validates ownership and state, computes the Merkle root over canonical-ordered leaves, the witness server countersigns the lock event, payment is captured, and the project transitions to a locked state. **Distinct from Segment 4** (chain lock — the public-ledger anchoring step that may follow).

## Canonical flow (numbered)

1. **User triggers lock** — `[components/LockButtons.tsx:69-147]` — three buttons in the lock grid: ◇ Checkpoint, ◆ Finalize, ⛓ Chain Lock. Click opens `LockConfirmModal`.

2. **◇ DECISION — payment mode (fiat or wallet)** — `[components/wallet/LockConfirmModal.tsx:52-98]`
   - **Fiat** → mount Stripe Elements → `/api/stripe/confirm`
   - **Wallet (non-custodial)** → direct → `/api/lock/local` or `/api/lock/checkpoint`

3. **API route entry** — three routes share the lock pattern:
   - `[app/api/lock/local/route.ts:30-130]` — finalize
   - `[app/api/lock/checkpoint/route.ts:41-137]` — checkpoint
   - `[app/api/stripe/confirm/route.ts:42-217]` — fiat bridge (calls witness with paymentIntentId)

4. **Server validation** — all three routes:
   - Auth check: 401 if no session.
   - Ownership: `WHERE id = ? AND user_id = ?`.
   - State guards ◇:
     - Checkpoint: status ∈ {unlocked, checkpointed}
     - Finalize: status ∉ {local_locked, chain_locked, persistent_locked, permanent_locked}
   - Iteration count guard ◇: must have ≥1 iteration. `[*:59-60, *:68-69, *:78-79]`

5. **Witness server confirm-and-execute call** — `[lib/scruple/witness.ts:76-102]` — `witness.confirmAndExecute({ action, projectId: 'sw:userId:projectId', paymentIntentId, merkleRoot, preScrId })`. Routes to `[server.js:933-1138]` (`handleConfirmAndExecute`).

6. **Witness-side verification chain** — `[server.js:954-977]`
   - Retrieve Stripe PaymentIntent ◇ — require `status='succeeded'`.
   - Metadata anti-tamper ◇ — action, projectId, amount must match.
   - Fee match against `STRIPE_FEES` constant.

7. **Merkle root computation** — `[lib/scruple/merkle.ts:38-85]` — `buildMerkle(leaves: string[])`:
   - 0 leaves → null (rejected by guard above).
   - 1 leaf → leaf is root (no hashing).
   - 2+: sort pair lexicographically (`combined = left < right ? left+right : right+left`), `sha256(combined)`, recurse. Odd count → duplicate last.
   - Canonical leaf ordering: by `run_sequence ASC`.

8. **lock_server_signature** — `[server.js:1003-1010]` — witness server HMACs the tuple `{project_id, action, merkle_root, witnessed_count, locked_at}`. The action string in the preimage prevents replay (a checkpoint signature cannot be presented as a finalize). Returned as `serverSignature` in the response.

9. **Payment capture** — fixed fees per action (project-lock fees, NOT canvas-session capture-actual):
   - Finalize: $5 / 500¢
   - Checkpoint: $5 / 500¢
   - Chain-lock-basic: $50 / 5000¢
   - Chain-lock-pinned: $65 / 6500¢

   **NOTE:** The Segment 1 capture-actual pattern is canvas-session-specific (`finalizeCanvasCharge`). Project lock uses fixed fees verified server-side.

10. **State transition + persistence** — transaction wraps:
    - DELETE + INSERT `merkle_nodes` (tree node rows: level, position, hash, left/right child).
    - UPDATE `projects`: status, merkle_root, scr_id (or pre_scr_id), lock_server_signature, lock_locked_at_witnessed, locked_at, is_active=0.
    - `[app/api/lock/local/route.ts:108-113, checkpoint:117-122, stripe/confirm:159-186]`
    - Atomicity: `.transaction()` callback wraps all writes.

11. **Receipt becomes viewable** — `[app/receipt/[scrId]/page.tsx:19-100+]` — public URL `/receipt/{scrId}` (SCR_XXXXXX for finalize, SCRB_XXXXXXXX for chain-locked). Server component fetches project, iterations, merkle_nodes, training_runs. Renders all bound hashes per iteration + verification recipe inline.

12. **End — project locked** — Segment 4 (chain lock) can follow. If user stops here, the project is *locally* locked: cryptographically sealed and receipt-viewable, but not yet anchored to a public ledger.

## Decision diamonds (for flowchart)

| ID | Where | Condition | Branches |
|---|---|---|---|
| D1 | route auth | User authenticated? | YES → continue \| NO → 401 |
| D2 | ownership | Project owned by user? | YES → continue \| NO → 404 |
| D3 | state guard | Status permits this lock action? | YES → continue \| NO → 409 |
| D4 | iteration count | iterations.length > 0? | YES → continue \| NO → 400 |
| D5 | LockConfirmModal | Fiat or wallet? | FIAT → Stripe path \| WALLET → direct route |
| D6 | server.js:954-962 | PaymentIntent.status === 'succeeded'? | YES → continue \| NO → 402 |
| D7 | server.js:965-977 | Metadata matches expected? | YES → continue \| NO → 400 (anti-tamper) |
| D8 | merkle.ts | buildMerkle returned non-null root? | YES → continue \| NO → 500 |
| D9 | witness fetch | Witness server reachable? | YES → continue \| NO → 502 |
| D10 | exec.success | Witness approves execution? | YES → persist \| NO → 402 |

## State writes

| Table | Columns | File:Line |
|---|---|---|
| merkle_nodes | project_id, level, position, hash, left_child_hash, right_child_hash | `lock/local:98-115`, `lock/checkpoint:107-124`, `stripe/confirm:132-141` |
| projects | status, merkle_root, scr_id OR pre_scr_id, lock_server_signature, lock_locked_at_witnessed, locked_at, is_active=0 | `lock/local:108-113`, `lock/checkpoint:117-122`, `stripe/confirm:159-186` |
| locked_projects (witness server) | project_id, action, merkle_root, witnessed_count, locked_at | `server.js:991-1021` |

## External calls

- **Witness server** — `POST /api/confirm-and-execute` (synchronous; web side awaits)
- **Stripe** — `paymentIntents.retrieve(paymentIntentId)` (witness server validates payment server-side)

## Patent-bearing observations

**lock_server_signature as second-party seal** — The witness server HMACs a tuple that binds project_id, action, merkle_root, witnessed_count, and locked_at into a single signature. The action string prevents cross-action replay. This is a server-issued countersignature distinct from the per-iteration witness signatures, and it commits the witness server to the lock event as a discrete moment. `[server.js:1003-1010, migration 018]`

**Witness server payment verification (non-custodial trust)** — The witness server holds no payment credentials. It receives a paymentIntentId from the web side and verifies status + metadata directly against Stripe. The web side never executes the lock without the witness's blessing, and the witness never blesses without verifying payment. Two-party-handshake architecture. `[server.js:954-977]`

**Merkle root canonical ordering (audit reproducibility)** — Leaves are ordered by `run_sequence ASC`, the same monotonic counter that drives the chain in Segment 2. Sorted-pair concatenation eliminates left/right ambiguity. Any third-party verifier with the leaf list can rebuild the root deterministically. `[lib/scruple/merkle.ts:38-85, scripts/audit-receipts.py]`

**State transition atomicity** — Merkle tree write + project state update happen in a single SQLite transaction. A partial lock cannot exist in the local DB. `[lock/local:98-115]`

## Sub-flowchart candidates

- **Receipt rendering** — what gets shown for each leaf scheme (v1 / v2 / v2.2) — useful as a separate diagram when describing third-party verification UX.
- **Anti-tamper verification on witness side** — the metadata/fee/status checks in `handleConfirmAndExecute` deserve their own diagram if illustrating the trust boundary.
