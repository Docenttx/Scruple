# WO-F5 — the app refuses to write a leaf onto a schema behind its tree

_2026-09-10. `docs/WORK-ORDERS-F.md` WO-F5, the second half of finding **E4-0**._

**Gate: PASS.** 71 checks, 0 failures, 0 inconclusive — `npm run f5`,
`scripts/f5-gate.sh`. Server change committed in `/data/scruple-web` as
`3651f11`; the gate, its probe and this report in the desktop repo.

**The precondition was checked, not assumed.** WO-F5 runs *only if F1–F4 are
green*, so all four were re-run from scratch before a line of this was written:

| gate | result |
|---|---|
| `npm run f1` | 42 ok / 0 FAIL / 0 inconclusive |
| `npm run f2` | 55 ok / 0 FAIL / 0 inconclusive |
| `npm run f3` | 82 ok / 0 FAIL / 0 inconclusive |
| `npm run f4` | 93 ok / 0 FAIL / 0 inconclusive |

---

## What was wrong, in one sentence

A leaf submission to a database one migration behind the tree answered **500
with an empty body** — no code, no message, nothing — while the server's own log
held the exact sentence `SqliteError: table iterations has no column named
imported_datablocks_source`. The diagnosis existed and never left the process,
which is why WO-D6's gate read the event as **eleven failed assertions** with
`no iteration row` and stayed silently red for over an hour.

`scripts/preflight-schema.mjs` (WO-E4) closed the **gate** half: seven gate
scripts ask before they run. `docs/MIGRATION-GAP.md` ends by naming what was
left: *"The app still does not refuse to serve on a stale schema. Failing closed
at the source would be stronger than eleven callers each remembering to ask."*
This is that.

## The fix, and the one thing about its shape that matters

Three files in `/data/scruple-web`, and the interesting one is **where**:

| file | what |
|---|---|
| `lib/db/schemaGuard.ts` | new. Reads the migrations directory against `_migrations` and returns a `SchemaState`. |
| `lib/v2/http.ts` | `schema_stale` → **503**, with `detail.pending` carrying the filenames as data. |
| `lib/v2/auth.ts` | `V2_LEAF_WRITE_SCOPES`, checked inside `requireScope`. |

⚑ **`requireScope` is the guard all eleven `/v2` routes already start with.**
Nothing was added to a route. `app/api/v2/mark/route.ts` refuses on a stale
schema and does not contain the string `schema` anywhere — asserted by the gate,
because that is the property being bought: a route written tomorrow inherits the
refusal by asking for a scope, and E4-0's whole shape is that a check the caller
has to remember is a check the next caller forgets.

```
HTTP/1.1 503
{"error":{"code":"schema_stale",
  "message":"This server's database is BEHIND THE TREE: 1 of 60 migrations are
             pending (060_imported_datablocks.sql). Leaf-writing routes refuse
             until they are applied — a leaf written now would be missing the
             columns those files add. …",
  "detail":{"reason":"migrations_pending","pending":["060_imported_datablocks.sql"],
            "pending_count":1,"migrations_on_disk":60,
            "migrations_dir":"/data/scruple-web/lib/db/migrations"}}}
```

and in the server's log, where the operator who can fix it is actually looking:

```
[schema] REFUSED witness:write: migrations_pending — 1 of 60 pending: 060_imported_datablocks.sql (/data/scruple-web/lib/db/migrations)
```

**Four decisions inside it, each of which could have gone the other way:**

1. **It never applies anything.** Same rule as the preflight: an app that
   silently migrated its own database on the way past would fix this morning's
   symptom, write leaves under a schema nobody chose, and leave the next drift
   undiagnosable.
2. **Every uncertain answer is a refusal.** A missing migrations directory, a
   directory with no `.sql` files in it, a database that will not answer — all
   three are "we do not know", and a don't-know that serves is the failure this
   file exists to prevent. In particular a **zero count of files on disk is
   refused rather than read as "nothing pending"**, which is the shape a wrong
   `SCRUPLE_REPO_ROOT` takes.
3. **It is not cached.** E4-0's timeline is a file appearing in the tree at
   17:43 under a server that started at 15:00; a cache keyed on anything
   cheaper than looking again answers 15:00's question. The cost is one
   `readdir` of 60 entries and one indexed `SELECT` on a request that is about
   to do a witness round trip and a 77-column INSERT.
4. **It runs LAST in `requireScope`** — after the key resolves and after the
   scope check — so an anonymous caller cannot ask a deployment what state its
   schema is in, and `forbidden_scope` is not shadowed by the newer refusal.
   Both are asserted by the gate.

## What is refused, and what deliberately is not

| scope | refused on a stale schema | why |
|---|---|---|
| `witness:write` | **yes** | INSERTs the leaf row |
| `mark:write` | **yes** | §9.5 records the selection **in** the leaf — it UPDATEs the same row |
| `baseline:write` | no | writes `baselines`, a registry row |
| `component:provision` | no | writes `components` and returns key material |
| every read | no | a row already written is not made wrong by a file appearing in `lib/db/migrations` |

**A database behind the tree is a reason not to write provenance onto it. It is
not by itself a reason to stop a deployment doing what it is still doing
correctly.** Refusing everything would have been the easier rule and a larger
claim than the finding supports — and, on the deployment measured in F5-1 below,
it would have taken down paths that work. Control (d) demonstrates the boundary
rather than asserting it: on the same stale server, with keys minted the same
way, `POST /api/v2/baseline` answers **201 and the row is there**, while
`POST /api/v2/witness` answers **503**.

---

## The gate, and the RED before

`npm run f5` — `scripts/f5-gate.sh`. **71 ok / 0 FAIL / 0 inconclusive.**

It builds **two databases** and starts **three servers**, so that the before and
the after differ in exactly one thing:

* `current.db` — every migration in the tree, applied by the preflight.
* `stale.db` — the same tree with its **last** migration withheld, applied
  through `SCRUPLE_REPO_ROOT` at a copy of the tree minus one file. The gate
  then proves the fixture is what it says it is: the preflight exits **3** on it
  and names exactly `060_imported_datablocks.sql`, exits **0** on the other, and
  `pragma_table_info` confirms the column is genuinely **absent** — a missing
  column, not merely a missing row in `_migrations`.
* Both are seeded by copying the tenant, the keys and the **baselines** out of
  the scratch database. A baseline this gate invented would only prove the route
  accepts one this gate invented.

| server | tree | database | answers |
|---|---|---|---|
| `:3941` | **parent commit**, in a worktree the gate makes and removes | `stale.db` | **500, empty body** |
| `:3942` | this commit | `stale.db` | **503 `schema_stale`, naming the file** |
| `:3943` | this commit | `current.db` | **201, and the row is in the database** |

**Stage 3, the RED, is E4-0 reproduced rather than quoted:**

```
   ok  ⚑ RED: a leaf submission answers 500, the symptom E4-0 was found as   500
   ok  …and names no migration file anywhere in its body                     0
   ok  …and the body it answers with is EMPTY: the caller is told nothing    0 bytes
   ok  ⚑ …while the server's OWN LOG knew exactly what was wrong all along   1
       server log: SqliteError: table iterations has no column named imported_datablocks_source
   ok  ⚑ …and the app wrote NO row                                          0
   ok  ⚑ …while the WITNESS took a leaf for it                              1   (1340 -> 1341)
```

⚑ **The last line is the part worth keeping.** The witness call happens before
the INSERT, so the failed submission left **a leaf in the witness with no row in
the app pointing at it** — evidence nothing can find. The guarded server, on the
same database, refuses *above every write*: `witnesses` does not move.

### The controls, and what each would have caught

* **(a) with the schema current it serves normally** — the same body, the same
  build, `201`; the leaf id read back out of the database with `sqlite3` rather
  than believed from the response; `mark` answers `200`. Without this the
  refusal could have been a route that never worked.
* **(b) a route that does not touch the database is unaffected** —
  `/api/v2/capabilities` answers `200` on the stale server, **byte-identical**
  (`cmp`) to the current one, and non-empty so the comparison is not vacuous.
  A read-scope route **on the stale database** also still answers `200`, which
  is the deliberate part of the design, shown rather than described.
* **(c) the older refusals are not shadowed** — unauthenticated is still `401`
  and says nothing about migrations; a read-only key is still `403
  forbidden_scope`.
* **(d) the boundary** — above.
* **the second door** — `/api/v2/mark` refuses with the same code, and the gate
  asserts its source contains no mention of a schema.
* **stage 7, E4-0's own timeline** — a migration file is dropped into the
  running server's migrations directory. The **next request refuses**, naming
  `061_f5_probe.sql`; the listener's pid is read out of `ss` before and after to
  prove nothing restarted; the file is removed and the next request is `201`
  again. This is the exact event of 2026-09-09, arriving in under a second
  instead of over an hour.
* **stage 8, the answers that are not "pending"** — `schemaState()` asked
  directly (`scripts/f5-schema-probe.ts`) on a matching tree (**current**, the
  anti-vacuity control), a tree with one extra file (**pending**), an **empty**
  migrations directory and a **missing** one. The last two refuse with
  `migrations_unreadable`, which no HTTP probe can show without a server whose
  tree is broken.
* **stage 9, the suites and the rails** — `test:v2` **972/972**,
  `test:conformance` **47/47**, the shared sandbox database still current, the
  sandbox app on `:3902` still answering. Separately, **`bash scripts/d3-gate.sh`
  passed end to end** after the change — the vault flow writing real leaves
  through `:3902`, every mutation caught, all controls fired.

---

## Findings

### ⚑ F5-1 — the deployment serving on `:3001` is **eight migrations behind**, and its v2 leaf door has been dead since migration 053

Measured **without contacting the port**, which the rails forbid: `/proc` for the
process, and the database read-only.

```
pid 4105224  next-server (v14.2.15)  cwd=/data/scruple-web  started Mon Sep 7 10:15:54 2026
SCRUPLE_DB_PATH is NOT in its environment  ->  lib/db/sqlite.ts falls back to data/scruple.db
data/scruple.db: 52 of 60 migrations applied
pending: 053_attestation_basis … 060_imported_datablocks   (all eight)
app/api/v2/witness INSERT: 77 columns, of which 40 DO NOT EXIST in that database
last row in `iterations`: 2026-09-03T18:19:24Z   (127 rows)
```

**E4-0 is not a sandbox condition. It is the state of the deployment**, and it
has been since 053 landed. Every `POST /api/v2/witness` there answers 500 with
an empty body, and has for days. This work order does not fix that — applying
migrations to that database is a decision for whoever owns the process — but
after it, the answer names the eight files instead of saying nothing.

🔴 **This is the reason the guard refuses the leaf doors rather than refusing to
BOOT.** That tree is served by a `next dev` that hot-reloads it. A boot-time
refusal would have taken a live site down the moment this file was saved;
refusing the leaf-writing routes changes an answer that is already a 500 into
one that says why.

### ⚑ F5-2 — `npm run test:v2` deletes its own database out from under itself

One subtest of 972 failed on the second gate run — `§10 C-6 … the owning tenant
DOES ratchet`, reading `expected at least 250 steps, got 0` **on a 201** — while
three `next dev` instances were compiling on the same box. It passed on three
standalone runs before and after.

It cannot be this work order's doing: **the guard's only output is a 503**, and
that assertion is reached through a 201. The mechanism is in the test script:

```
"test:v2": "SCRUPLE_DB_PATH=$(mktemp -d)/v2-test.db node --import tsx --test $(ls test/v2/*.test.ts …)"
```

**One** temp directory for **forty** test files, which `node --test` runs in
**parallel processes** — and `test/v2/auth.test.ts` ends with
`fs.rmSync(TMP, { recursive: true, force: true })`. Demonstrated
deterministically: run `auth.test.ts` and `component-auth.test.ts` together and
the directory is **gone** when the run ends, three times out of three. The
database, its `-wal` and its `-shm` are removed while ~39 other processes are
still using them.

Not fixed here: it is another repo's test harness, the fix (a database per test
file, or not deleting a directory you did not create) belongs with someone who
can demonstrate the race red and then green, and guessing at it would be exactly
the unverified change this series scores INCONCLUSIVE.

### F5-3 — `next dev` rewrites `tsconfig.json` in the tree it is started from

Starting a dev server with a new `SCRUPLE_DIST_DIR` makes Next reformat
`tsconfig.json` and add `<distDir>/types/**/*.ts` to `include`. On this box that
tree is shared with a live server and with every other rig, so a gate that
started a server in it left a modified file behind that nobody changed on
purpose. The gate now takes a copy before it starts anything and restores it
after — and **checks both halves**: that the servers did change the file, and
that it is byte-identical afterwards. A `cp` that only checked its own copy
would prove nothing.

### F5-4 — the two legacy plugin doors will still write a leaf onto a stale schema, and are NOT guarded

Measured against `stale.db`, by extracting each route's `INSERT INTO iterations`
column list and asking `pragma_table_info` whether those columns exist:

| door | columns | missing on a stale schema | outcome |
|---|---|---|---|
| `/api/v2/witness` | 77 | 6 | **500** (and now 503) |
| `/api/scruple/witness/adobe` | 17 | **0** | **writes a leaf** |
| `/api/scruple/witness/photoshop` | 17 | **0** | **writes a leaf** |

Those two name only pre-053 columns, so on the deployment in F5-1 **they are the
only leaf doors that still work** — and every leaf they write reads NULL in all
40 columns migrations 053–060 added, which is `host_semantics` NULL all over
again: *"the question was never asked of this leaf"* and *"this leaf was written
under a schema that could not ask"* recorded identically. Not guarded here on
purpose: they do not go through `requireScope`, guarding them is four one-line
edits of exactly the kind this work order exists to avoid, and doing it would
break the last working leaf door on a live deployment. **It should be taken
deliberately, with the migration applied first.**

---

## What this does NOT do

* **It does not apply a migration.** Nothing in the server touches `_migrations`
  except `runMigrations`, which is unchanged.
* **It does not make the app refuse to start.** WO-F5 allows either; the route
  refusal was chosen, and F5-1 is the reason.
* **It does not protect the legacy doors** (F5-4) or the v1 surface.
* **It does not know whether a migration is SAFE** — only whether it has been
  applied. A tree whose newest file is a broken migration refuses the same way,
  and should.
* **It does not close E4-0's other end**: nothing yet notices that a deployment
  has been refusing for a week. The refusal is per request; there is no alarm.

---

## Files

**`/data/scruple-web`** (`3651f11`)

* `lib/db/schemaGuard.ts` — new. `schemaState()`, `migrationsDir()`,
  `schemaRefusalMessage()`, `schemaRefusalDetail()`.
* `lib/v2/http.ts` — `schema_stale`, 503.
* `lib/v2/auth.ts` — `V2_LEAF_WRITE_SCOPES` and the check in `requireScope`.

**this repo**

* `scripts/f5-gate.sh` — the gate. `npm run f5`.
* `scripts/f5-schema-probe.ts` — stage 8's four answers.
* `docs/WO-F5.md` — this.
* `docs/MIGRATION-GAP.md`, `docs/STATE.md` — the open item closed, with F5-1
  recorded beside it.

## Re-running

```bash
cd /mnt/corpus/scruple-desktop
npm run f5                      # 71 checks: three servers, two databases, ~6 min
bash scripts/d3-gate.sh         # the vault flow end to end through :3902
cd /data/scruple-web && npm run test:v2 && npm run test:conformance
```

Ports `3941–3943` must be free; the gate refuses rather than guessing if they
are not. It starts every server on `127.0.0.1` with an explicit
`WITNESS_SERVER_URL=:5899` — the default in `lib/scruple/witness.ts` is `:5799`,
which is production, and a gate that forgot would dial it. Nothing here contacts
`:3001` or `:5799`, nothing opens the live witness database, and the shared
scratch database is only ever read.
