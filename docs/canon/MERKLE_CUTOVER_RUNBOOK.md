# WO-C7 — Merkle cutover: rehearsal findings and deploy runbook

_2026-09-09. Rehearsed against a **read-only snapshot** of the live production
witness database. `/opt/scruple-witness` was never written; `witness.db` mtime is
still `1788392266` (2026-09-02 23:37:46), the value recorded as legitimate when
the tripwire was calibrated. `:5799` and `:3001` were never contacted._

Snapshot taken with `sqlite3 "file:…?mode=ro" ".backup …"` rather than `cp`,
because the source has a live WAL and a file copy can snapshot torn state.

---

## 0 · The headline

🔴 **The cutover is not free, and it is not expensive in the way we assumed.**
The premise we were working from — *"there are no existing REAL provenance
packages, they have all been test work"* — is correct about intent and
incomplete about consequence:

> **Two locked projects are anchored to public immutable ledgers (Arweave and
> Ravencoin), both currently reproduce EXACTLY, and neither survives the
> cutover.** A test row can be deleted. An Arweave transaction cannot.

And a second finding the cutover did not cause and would have buried:

> **The estate's roots are ALREADY mostly unverifiable. Of 31 locked projects,
> only 15 can be reproduced from the leaves in the database today** — and one of
> those 15 only because its leaves are fed in REVERSED order.

## 1 · What is actually in the production witness

188 rows in `witnesses`, 31 in `locked_projects`, 0 in `projects`.

| locked roots | count | note |
|---|---|---|
| reproduce under **sorted-pair** (`lib/scruple/merkle.ts`) | **9** | |
| reproduce under **hex-concat** (`server.js:483`) | **4** | includes both anchored rows |
| reproduce under **RFC 6962** (the canonical target) | **0** | |
| **unreproducible**, leaves present | **15** | 12 explained below; 3 not |
| no leaves in the table at all | 3 | |
| **total** | **31** | |

⚑ **Nothing in production is on the canonical construction.** That is expected —
it is what WO-C6 measured — but it means the cutover moves 15 working roots to
a construction none of them was computed under, and leaves the other 16 exactly
as broken as they already are.

### The 15 that reproduce under nothing

**12 of them have a `witnessed_count` that disagrees with the table** — they
claim `0` while holding 1 to 5 leaves (projects 27, 28, 29, 31, 46, 47, 48, 53,
58, 63, 68, 73, 180). A root computed over a leaf set that is not the leaf set
now present cannot be reproduced from it, and the count is the evidence that the
sets differ.

**Three were unreproducible with a count that agrees. Two are now explained,
and the third is not.** (The first sweep used `COALESCE(leaf_hash, content_hash)`,
which is wrong whenever a root predates leaf hashing but the row later acquired a
leaf hash — that alone hid project `25`.)

| project | verdict |
|---|---|
| **`25`** | ✅ **root == its single `content_hash`, unhashed.** A one-leaf tree whose root is the leaf itself, not `H(0x00‖leaf)`. Reproducible. |
| **`6`** | ✅ **hex-concat over `content_hash`, leaves in REVERSED order.** 🔴 The root depends on the order rows came back from an unordered query. |
| **`puffjuly12-1783882341`** | 🔴 **UNREPRODUCIBLE, and the search was controlled.** 5 constructions (including duplicate-last variants) × all 120 permutations × 7 hash columns. No match. The same search finds project `6` at `(content_hash, hex-concat, order (1,0))` and anchored project `30`, so it can find a match when one exists. |

⚑ **Project 6 is a defect class, not a curiosity.** A root whose value depends on
the row order an unordered `SELECT` happened to return is not reproducible by
anyone who does not already know the answer. The canonical construction pins leaf
order to ascending `tenant_seq`, which is one more reason the cutover is right —
and one more reason the algorithm must be recorded before it happens.

🔴 **`puffjuly12-1783882341` is the L2 project `server.js` names in its own
comment as legitimate, and its root cannot be reproduced from the database.**
That is the most important row to understand before step 1: it is the one where
we believed we had provenance and the arithmetic says otherwise.

## 2 · The two anchored rows, in full

| | project 30 | project 32 |
|---|---|---|
| `merkle_root` | `7be97c81…b27bfe` | `5fc6b275…c1478c` |
| locked | 2026-03-31T21:52Z | 2026-03-31T23:21Z |
| leaves | 2 | 2 |
| `arweave_txid` | `T-XW9_0BbSjNrrgMVP4KNMjVBBi1bfJVRnXkKYK4HNg` | `MZxtXtG87-Gg1XIbLR3iGkUDIHEOZwLkJM_KGaKl95Q` |
| `rvn_txid` | `4abbaf5b…0c5836` | `5661982a…e4eff6` |
| `ipfs_cid` | — | `QmPBL3AwP7kAEKhj8SRs8yt4mSRsSKkPDQXFw9t1WFXSsD` |
| reproduces under | **hex-concat ✅** | **hex-concat ✅** |
| under RFC 6962 | `6d88848f…` ✗ | `05f4f7ff…` ✗ |

Their leaves carry `leaf_hash = NULL` and `leaf_scheme = 'v1'` — they predate
leaf hashing, so the root is over `content_hash`. Both reproduce from data still
in the table, which is what makes them live provenance rather than debris.

**After a bare cutover the anchors still exist and commit to a value no code in
the estate can produce.** That is a worse outcome than never having anchored:
a dangling public commitment invites someone to conclude the root was altered.

## 3 · What this changes about the plan

The earlier decision — *cutover, not versioning* — was right about the **code**:
five call sites converge on one construction and the old ones go away. It was
made on the premise that no stored root needed to survive. **Fifteen do, and
two of them are anchored.**

The fix is small, non-destructive, and it is the versioning idea the founder
already raised — applied to **rows**, not to packages:

> **Record the algorithm that produced each stored root, before changing what
> the code computes.**

A one-column migration (`merkle_algorithm TEXT`) backfilled from the sweep in
§1: `sorted-pair-v1` for 9, `hex-concat-v1` for 4, `hex-concat-v1-reversed` for 1,
`identity-single-leaf` for 1, `unreproducible` for 13, `no-leaves` for 3.
Nothing is recomputed and nothing is destroyed. A verifier then reads the
algorithm and applies it, so **all 15 working roots keep working through and
after the cutover**, and the 16 that never worked are labelled as such instead
of being silently indistinguishable from the ones that do.

⚑ This is not re-litigating the cutover. The cutover still happens and the
canonical construction is still RFC 6962 for everything new. This is the step
that makes it lossless, and it is cheap **only if it happens first** — after the
cutover, the information needed to backfill the column is gone from the code.

## 4 · The runbook

Steps 1–5 are ordinary engineering and can run unattended in the sandbox.
**Step 6 is founder-only.**

| # | step | reversible? |
|---|---|---|
| 1 | Migration: add `merkle_algorithm` to `locked_projects`, nullable, no default. NULL means "never asked". | yes — additive column |
| 2 | Backfill it in the **sandbox copy** from the §1 sweep. Re-run the sweep afterwards and assert every row's label reproduces its own root, or is `unreproducible`/`no-leaves`. | yes — copy only |
| 3 | Teach the verifier to dispatch on `merkle_algorithm`, defaulting to **refuse** rather than to any construction. A missing algorithm must not silently mean "try RFC 6962". | yes |
| 4 | Land the canonical construction at all five call sites — `lib/scruple/merkle.ts`, `lib/witness/merkle.ts`, `packages/scruple-verify/.../merkle.mjs`, `app-legacy/lock/merkle.js`, and witness `server.js:483`. New roots only. | yes — code |
| 5 | Run `scripts/merkle-conformance.mjs`. It must show the canonical spec passing and **the estate's implementations now agreeing with it**, and its five mutants must still fail. Only then may `CHECKPOINT_VECTORS_SETTLED` flip. | yes |
| 6 | 🔴 **FOUNDER: deploy `server.js` to `/opt/scruple-witness` and restart it.** It serves `witness.scruple.ai` and holds the live audit log. | see rollback |

### Rollback for step 6

- Take a `.backup` snapshot of `witness.db` immediately before the restart, the
  same read-only way this rehearsal did.
- Keep the previous `server.js` beside the new one. Reverting is a file swap and
  a restart; **no database change is required**, because steps 1–4 add a column
  and change what NEW roots are computed with — they do not rewrite stored ones.
- The flip of `CHECKPOINT_VECTORS_SETTLED` is a separate commit from the deploy.
  **Deploy first, verify, flip second.** Flipping before the witness is on the
  canonical construction would have leaves claim a settled root the deployed
  server does not compute — the one ordering error that produces false evidence
  rather than a failed request.

### The gate for the whole thing

Both anchored roots must still verify **after** the cutover, through the
algorithm column, from the leaves in the database. If either does not, the
cutover is not done — and that check is the one this rehearsal exists to make
possible.

## 5 · What this rehearsal did NOT do

- **Nothing was written anywhere near production.** No migration was applied to
  the live database, no code was changed, `/opt/scruple-witness` was read only.
- **`puffjuly12-1783882341` was not explained.** The controlled exhaustive search
  says it is not any of those constructions over any of those columns in any
  order. What it IS remains open, and it is the row that most deserves an answer.
- **`witnessed_count` was not corrected** for the 12 rows that disagree. It is a
  separate defect with a separate owner, and correcting a count to match a table
  would destroy the evidence that they ever differed.
- **The checkpoint roots were not swept.** Only 2 of 31 rows carry one; they want
  the same treatment and were out of scope here.
