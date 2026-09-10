# WO-F4 — `merkle_algorithm`, recorded on the snapshot before the code changes

_2026-09-10. `docs/canon/MERKLE_CUTOVER_RUNBOOK.md` steps 1–3, against the
snapshot copy at `/mnt/corpus/scruple-council-impl/c7-rehearsal/witness-prod-copy.db`
only._

**Gate: PASS.** 93 checks, 0 failures, 0 inconclusive — `npm run f4`. All 15
reproducible roots verify **through the column**; the 16 that never reproduced
are labelled `unreproducible` (13) or `no-leaves` (3) and are **refused**.

Changed: `/data/scruple-web` `7af1827` (the migration, the backfill, the
verifier, its CLI, a test, the runbook's two corrections) and this repo (the
gate, the independent Python re-implementation, this report).

**The one-line result.** Before: every row in the snapshot answers
`refused algorithm_absent` — 31 of 31, including the two rows anchored on
Arweave and Ravencoin. After: 15 answer `verified`, each because its recorded
algorithm was **executed and its output compared byte for byte** with the
stored root, and 16 answer a refusal that **names why**.

---

## What this does NOT do

Said first.

**It does not do step 4.** The five call sites — `lib/scruple/merkle.ts`,
`lib/witness/merkle.ts`, `packages/scruple-verify/.../merkle.mjs`,
`app-legacy/lock/merkle.js` and witness `server.js:483` — still compute what
they computed yesterday. No root anything produces has moved.

**It does not flip `CHECKPOINT_VECTORS_SETTLED`,** and step 5 has not been run.
Every leaf in the estate still reads `attestation_basis: stale` for the reason
`docs/STATE.md` §4.2 gives.

**It does not explain `puffjuly12-1783882341`.** It records that the row is not
explained, in a place a verifier reads, which is a different and smaller thing.

**It does not touch the live witness database, and it does not touch
`server.js`.** The second of those was a decision, and it is below.

**It does not correct `witnessed_count`** on the 13 rows where it disagrees with
the table. Same reason the rehearsal gave: correcting a count to match a table
destroys the evidence that they ever differed.

---

## Why `services/witness-server/server.js` was NOT edited

The runbook's step 1 is "add the column", and the obvious place to add it is
`runMigrations()` in `server.js`, beside the fourteen `ALTER TABLE` statements
already there. That was not done, and the reason is a control that already
exists:

> `services/witness-server/server.js` is **byte-identical** to
> `/opt/scruple-witness/server.js` (md5 `79bd250f…`), and
> `scripts/merkle-conformance.mjs` executes the repo copy **as** the deployed
> witness algorithm on the strength of that identity. If the two differ it
> marks that row `UNKNOWN` rather than reporting the repo copy as though it
> were deployed, and `test/v2/merkle-conformance.test.ts` asserts they do not
> differ.

Editing the repo copy makes that test red and turns a measured row into an
unknown one — for a change that does not touch `calculateMerkleRoot` at all —
and it cannot be made green again from here, because closing the gap means
deploying to `/opt/scruple-witness`, which is founder-only step 6.

🔴 **So the runbook's "step 1 is free and reversible" is true of the DATABASE
and not of the CODE.** The column is additive and reversible; the one-line call
that makes the deployed server maintain it has to ride with the step 4 commit
that is going to be deployed anyway. The migration is written and tested as a
module of its own —
`services/witness-server/migrations/locked_projects_merkle_algorithm.js` — so
step 4 lands it by adding two lines to `runMigrations()` and nothing else.

**The consequence, stated plainly: a NEW lock written by the deployed witness
today gets `merkle_algorithm = NULL`, and the verifier refuses it.** That is
correct under step 3's rule and it is not a state anyone should stay in. It is
the strongest argument for step 4 following soon rather than eventually.

---

## What was built

### 1 · The column — `services/witness-server/migrations/locked_projects_merkle_algorithm.js`

`ALTER TABLE locked_projects ADD COLUMN merkle_algorithm TEXT`, idempotent,
**nullable, no default**. Measured: `notnull = 0`, `dflt_value` empty, type
`TEXT`, and the digests of every pre-existing column of `locked_projects` and
of the whole `witnesses` table are **identical before and after**.

🔴 NULL is load-bearing and that is why there is no default. NULL means *the
question was never asked of this row*. `unreproducible` means *asked, and no
retained data produces this root*. A `DEFAULT` would erase that distinction on
all 31 rows at once.

### 2 · The vocabulary and the verifier — `packages/scruple-verify/src/core/storedRootAlgorithm.mjs`

The label is a computation, not a name:

```
<construction>/<leaf-source>/<order>
   construction   identity-single-leaf | hex-concat-v1 | sorted-pair-v1 | rfc6962-v1
   leaf-source    leaf_hash | content_hash
   order          asc | desc          (over run_sequence)
```

plus two **terminal** labels — `unreproducible`, `no-leaves` — that record an
absence of arithmetic rather than arithmetic. Both refuse.

`verifyStoredRoot({algorithm, storedRoot, leaves})` returns `verified` **only
after recomputing the root and finding it equal**. Every other path is a
refusal carrying a reason code:

| reason | when |
|---|---|
| `algorithm_absent` | the column is NULL — nobody asked |
| `algorithm_unknown` | not in the vocabulary, including the runbook's short forms |
| `algorithm_unreproducible` / `algorithm_no_leaves` | the two terminals |
| `stored_root_malformed` | refused before any arithmetic runs |
| `no_leaves_present` / `leaf_count_mismatch` | the tree is not the shape the label claims |
| `leaf_source_unavailable` | the named column is NULL on some leaf — **it does not fall back to the other one** |
| `root_mismatch` | the label was executed and the answer is not the stored root |

🔴 **The module exports no way to COMPUTE a root.** The four constructions are
module-private and only `verifyStoredRoot`, `parseAlgorithm`,
`enumerateAlgorithms` and `TERMINAL_LABELS` are exported; the test asserts that
export list. `scripts/merkle-canonical-spec.mjs` warns that a construction
under an importable path is one `import` away from becoming a live one, and
three of these four are constructions we are leaving the estate for. They can
be asked *did this produce that*, and they cannot be asked *produce me one*.

### 3 · The backfill — `scripts/merkle-algorithm-backfill.mjs`

`node scripts/merkle-algorithm-backfill.mjs --db <path> [--apply] [--json]`.
Applies the migration, sweeps, writes, then re-reads from the database and
re-verifies every row.

⚑ **The sweep is not a second implementation.** It asks `verifyStoredRoot` —
the same function step 3 ships to third parties — which labels it *accepts* for
this row, and writes one of those. A backfill that can write a label its own
verifier rejects is precisely the failure the column exists to prevent, so they
are not allowed to be two pieces of code.

Where it refuses to guess:

- more than one label verifying a **multi-leaf** row **fails the run** (exit 5).
  Two constructions producing one root is a fact about that row, not something a
  backfill resolves by taking the first. Measured: this never fires on the
  snapshot — every multi-leaf row has exactly one match.
- a one-leaf row is labelled `identity-single-leaf`, never `sorted-pair-v1`.
- `unreproducible` and `no-leaves` are refusals, never upgraded by a wider
  later search.

### 4 · The verifier's CLI — `scripts/merkle-algorithm-verify.mjs`

`--project`, `--all`, and two that exist for the controls:

- `--algorithm <label>` overrides the stored label **without writing it**.
  "Project 27 under project 25's label" is a question you ask a verifier, not
  an edit you make to a database.
- `--exhaust <id>` tries **every** label in the vocabulary against one row.
  That is how `puffjuly12`'s `unreproducible` is proved by search rather than
  asserted — and the same search run against project 30 finds its label, so a
  "NONE" answer means something.

### 5 · The independent check — `scripts/f4-root-arithmetic.py` (this repo)

Python, sharing nothing with the above: no import, no vocabulary constant, no
hash helper. Handed only what a third party would have — the database and the
label string — it re-derives leaf source, order and construction by splitting
the label on `/`, recomputes, and compares. **The two implementations agree on
all 31 rows**, field for field (`algorithm`, `outcome`, `reason`).

---

## The estate, as labelled

| label | rows | note |
|---|---|---|
| `identity-single-leaf/leaf_hash/asc` | 7 | 19, 20, 21, 22, 23, 27, 181 |
| `identity-single-leaf/content_hash/asc` | 3 | 25, `sw:87a5cc3a…:5`, `sw:87a5cc3a…:6` |
| `hex-concat-v1/content_hash/asc` | 4 | **30**, **32**, `scruple-web-test-1777701353570`, 5 |
| `hex-concat-v1/content_hash/desc` | 1 | 6 — the root that depends on row order |
| `unreproducible` | 13 | 12 with a `witnessed_count` that disagrees, plus `puffjuly12-1783882341` |
| `no-leaves` | 3 | `smoke-smoke-mint-…`, `sw:VFkUaqCs4qELs3HViFrPm:4`, `:7` |
| **verified / refused** | **15 / 16** | |

Two things this table says that the rehearsal's §1 tally does not:

- **7 of the 15 take their leaves from `leaf_hash` and 8 from `content_hash`.**
- **10 of the 15 are one-leaf trees** and 5 are not. No stored root is
  sorted-pair at n > 1, and **none is RFC 6962** — the cutover's premise,
  re-measured.

---

## The gate, and the controls

`npm run f4` — `scripts/f4-gate.sh`. **93 ok / 0 FAIL / 0 inconclusive.**

### RED before, on a fresh copy of the pristine snapshot

| check | before |
|---|---|
| column present | **absent** |
| independent Python verifier | **exit 4 — cannot run, no column** |
| rows verified, all 31 | **0** |
| refusals reading `algorithm_absent` | **31** |
| anchored project 30 | **refused `algorithm_absent`** |
| anchored project 32 | **refused `algorithm_absent`** |

### (a) A NULL algorithm is refused, not tried as RFC 6962

Project 30's label is set back to NULL on a scratch copy:

- `refused`, reason **`algorithm_absent`**;
- 🔴 **`computed: null`** — the evidence that nothing was attempted. A refusal
  that had tried a construction would be carrying its answer;
- the other 30 rows in the same database still verify (14 of the remaining 14
  reproducible ones), so the refusal is about that row and not about the run;
- and what "silently try the canonical construction" would have answered for an
  Arweave-anchored project is printed: `6d88848f8faf77bd…`, against a stored,
  anchored `7be97c811b305a94…`. That is the number the column exists to stop
  anyone reporting.

### (b) The two anchored rows, which are why this exists

Both carry an `arweave_txid` **and** an `rvn_txid` — asserted, so the check has
stakes — and both **verify from the leaves in the database** under
`hex-concat-v1/content_hash/asc`, computing exactly the roots that are on
Arweave and Ravencoin:

```
project 30   7be97c811b305a9471ff0ad3220392368ff30fce58c7c192c0b44a2157b27bfe
project 32   5fc6b2758df98c3342459de816c93f7530261901542a7ce6e4927c5f66c1478c
```

### (c) `puffjuly12-1783882341` does not acquire a label that looks verified

- labelled **`unreproducible`**; refused with `algorithm_unreproducible`;
- it holds 5 leaves and its `witnessed_count` is 5 — **nothing about it looks
  wrong**, which is what made it worth this care;
- **all 14 non-terminal labels tried; 0 verify**;
- and the control on that control: **the same search finds project 30**, and
  returns exactly its recorded label.

### Four that must NOT fire

| control | result |
|---|---|
| the **leaf column** is load-bearing — project 27's label with `content_hash` substituted | `root_mismatch`; under its own label it still verifies |
| the **order** is load-bearing — project 6 under `asc` | `root_mismatch`; recorded as `desc` |
| the runbook's own short label `hex-concat-v1` | `algorithm_unknown` — never accepted with a guessed column |
| one flipped hex digit in one of project 30's leaves | `refused root_mismatch`, while project 32 in the same tampered database **still verifies** |

### The rails, measured before and after

| rail | value |
|---|---|
| `/opt/scruple-witness/witness.db` mtime | `1788392266` — the tripwire the rehearsal calibrated, **unchanged at both ends of the run** |
| `/opt/scruple-witness/server.js` md5 | `79bd250f93669564ec18bf94f955c5d7`, and the repo copy still byte-identical |
| pristine snapshot sha256 | `9ce5397781bb8c320f76a02d0d36c8e3656bdeac9e274a78131f9c9a996e0c29`, unchanged |
| backfill handed a path under `/opt` | **exit 3, refused** |
| verifier handed a path under `/opt` | **exit 3, refused** |
| `sqlite3 "file:///…?mode=ro" "CREATE TABLE …"` | **refused**, and no stray `=ro` file appeared |

No port was opened, no server was started, `:5799`, `:3001` and the sandbox
`:5899` were not dialled, and `CHECKPOINT_VECTORS_SETTLED` was not touched.

### The suites

`test/v2/stored-root-algorithm.test.ts` — 20 pass / 0 fail, run from inside the
gate. And the whole of `/data/scruple-web`: `npm run test:v2` **0 fail**,
`npm run test:conformance` **0 fail**, `npm run test:integration` **0 fail**.
`test/v2/merkle-conformance.test.ts` is re-run inside the gate specifically to
show that this work order did not degrade the deployed-witness row it depends
on.

---

## Findings

### F4-1 — the runbook's own backfill vocabulary does not determine a computation

`MERKLE_CUTOVER_RUNBOOK.md` §3 proposes `sorted-pair-v1` / `hex-concat-v1` /
`hex-concat-v1-reversed` / `identity-single-leaf` / `unreproducible` /
`no-leaves`. **Those labels never say which column the leaves come from**, and
the estate needs both: 7 of the 15 reproducible roots are over `leaf_hash` and
8 are over `content_hash`.

🔴 A verifier handed `sorted-pair-v1` would have to guess the leaf source — the
same "silently try the likely one" that step 3 exists to forbid, arriving one
level further down, in a field whose whole purpose is to remove the guess. The
guess is not hypothetical: projects 25 and 27 are both one-leaf trees whose
`leaf_hash` and `content_hash` differ, and each reproduces under exactly one of
them. `parseAlgorithm` therefore **rejects the short forms outright**, and the
test pins that.

**And 9 of the labels the runbook plans are over-claims.** At n = 1 the three
historical constructions are the *same function* — each returns `level[0]`
untouched — so a one-leaf row cannot distinguish sorted-pair from hex-concat
from identity. §3 calls 9 of the 10 one-leaf rows `sorted-pair-v1` and only
project 25 `identity-single-leaf`. What the arithmetic establishes about all 10
is "root == leaf, and therefore **not** RFC 6962", and nothing more. They are
labelled `identity-single-leaf` here — the minimal true claim, and the same one
§1's own project-25 row already makes.

⚑ The counts are unaffected: 10 identity + 5 hex-concat = the runbook's 9 + 1 +
4 + 1 = 15. The correction is to what the labels *assert*, not to which rows
reproduce.

### F4-2 — §1 lists thirteen project ids for a count of twelve, and the extra one reproduces

The rehearsal says *"**12 of them** have a `witnessed_count` that disagrees with
the table"* and then lists **13** ids: `27, 28, 29, 31, 46, 47, 48, 53, 58, 63,
68, 73, 180`. Measured on the snapshot:

- **13 rows** have a `witnessed_count` that disagrees with the table;
- **12 of those are unreproducible**;
- the thirteenth is **project 27**, whose count disagrees (claims 0, holds 1)
  and whose root **reproduces anyway** — `identity-single-leaf/leaf_hash/asc`.

Two sets got one sentence. It matters because "count disagrees" is the
rehearsal's *evidence* that a root was computed over a leaf set that is no
longer present, and project 27 is a live counterexample: a disagreeing count
does not imply an unreproducible root. All three numbers are now assertions in
the gate.

### F4-3 — a `cp` of the snapshot loses the backfill, and looks like it worked

Found by doing it. The snapshot is in WAL mode — it was taken with `.backup`
from a live WAL database — so committed labels sit in `witness-prod-copy.db-wal`
until a checkpoint folds them in. `cp` of the main file alone yields a database
that **has the column and NULL in every row**.

🔴 That reads as *"the migration ran and the backfill did not"*, which is a
plausible and completely wrong diagnosis; the first run of this gate produced
exactly that and went red in two later stages on rows that had been labelled two
stages earlier. It is the torn-state hazard the rehearsal used `.backup`
instead of `cp` to avoid, arriving on the way **out** instead of the way in.

Closed both ways: the backfill runs `PRAGMA wal_checkpoint(TRUNCATE)` before it
exits, so the file on disk is self-contained; the gate derives every scratch
copy with `.backup`; and a check asserts no `-wal` sidecar is left beside the
snapshot.

---

## What is still missing after this

- **Steps 4, 5 and 6.** The five call sites, the conformance run, and the
  founder's deploy. Nothing here shortens any of them.
- **The one-line call in `server.js`** — see above. Until it lands, every new
  lock is written with `merkle_algorithm = NULL` and refuses.
- **`puffjuly12-1783882341` is still unexplained.** `c7-rehearsal/PUFFJULY12.md`
  says the root is provably not a function of the retained columns; the only
  route left is the original v2 leaf preimage documents, if an export, a backup
  or a `.scr` package still holds them.
- **The checkpoint roots were not swept.** Only projects 30 and 32 carry a
  `checkpoint_root`; they want the same treatment and are still out of scope.
- **The 15 reproducible roots are still not verifiable by a stranger.** They
  verify from the leaves in *this* database. Nothing about that changed.

---

## Files

**`/data/scruple-web`**

| file | what |
|---|---|
| `services/witness-server/migrations/locked_projects_merkle_algorithm.js` | step 1, as a module both the server and the backfill can call |
| `packages/scruple-verify/src/core/storedRootAlgorithm.mjs` | step 3 — the vocabulary and the dispatching verifier that refuses by default |
| `scripts/merkle-algorithm-backfill.mjs` | steps 1+2 against a snapshot; refuses `/opt`; read-only handle unless `--apply` |
| `scripts/merkle-algorithm-verify.mjs` | the verifier's CLI, including `--algorithm` and `--exhaust` |
| `test/v2/stored-root-algorithm.test.ts` | 20 assertions on the refusal rules and the two anchored rows |
| `docs/canon/MERKLE_CUTOVER_RUNBOOK.md` | steps 1–3 marked done, with F4-1 and F4-2 recorded against §1 and §3 |

**`/mnt/corpus/scruple-desktop`**

| file | what |
|---|---|
| `scripts/f4-gate.sh` | the gate — `npm run f4` |
| `scripts/f4-root-arithmetic.py` | the independent second implementation |
| `docs/WO-F4.md` | this |

**`/mnt/corpus/scruple-council-impl/c7-rehearsal`** (not a git repo)

| file | what |
|---|---|
| `witness-prod-copy.pristine.db` | a byte-identical `.backup` of the snapshot taken **before** anything was written, mode 444. sha256 `9ce53977…`, equal to the copy's digest at the start of this work order. |
| `witness-prod-copy.db` | the designated copy, now carrying `merkle_algorithm` on all 31 rows |

---

## Rails

- 🔴 `/opt/scruple-witness` was **read** — `stat` and `md5sum`, as a tripwire —
  and never written. Its `witness.db` mtime is still `1788392266`.
- 🔴 `127.0.0.1:5799` and `:3001` were not contacted. Neither were the sandbox
  witness `:5899`, the app `:3902` or the surrogate `:8799` — this gate opens no
  socket at all.
- 🔴 `CHECKPOINT_VECTORS_SETTLED` was not touched.
- 🔴 Both new programs **refuse any path under `/opt`** before they open
  anything, and the gate demonstrates both refusals rather than trusting them.
- `docs/README-TRAVEL-LAPTOP.md` and `docs/WO-W1.md` were not opened for
  writing; no shared history was rewritten and nothing was force-pushed.
- Nothing in `app/`, `lib/` or the Blender add-on was touched; no Blender ran.
- `scripts/preflight-schema.mjs` was not wired in, and does not apply: this gate
  reads the **witness** snapshot, never the scruple-web application database.
