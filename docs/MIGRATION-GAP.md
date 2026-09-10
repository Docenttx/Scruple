# The migration gap (finding E4-0) — fix, evidence, and what is left

## The defect

WO-E2 added `059_declared_uncaptured.sql` at 17:43 and **nothing applied it to
the sandbox database**. `next dev` does not migrate on boot. Every leaf
submission answered 500, and WO-D6's gate reported **eleven failed assertions
with `no iteration row`** — the symptom, saying nothing about the cause. The gate
was silently red for over an hour and the next work order found it by accident.

**Scope, measured twice — the second time corrected the first.** 12 gate scripts
exist across the two repos and **eleven have no schema check of any kind** (only
`e2-gate.sh` does, added by the work order that caused the drift). But *needing*
one is narrower than *lacking* one:

| gates | which | preflight |
|---|---|---|
| **7** | `d3 d4 d5 d6 d7 e4 e5` — each exports `SCRUPLE_DB_PATH` with a default and reads the app database | **wire it, right after that export** |
| 4 | `d1 d2 e3 e1` — zero references to `iterations`, `witness`, `leaf_hash` or `sqlite3` | **leave alone** |
| 1 | `e2` — builds its own temp databases and runs `migrate.ts` | already handled |

⚑ **Adding a preflight to a gate that never opens the database would be false
rigor** — a check that can never fail, in a project whose whole discipline is
that a green result with no way to go red proves nothing. The 7 are the fix.

The insertion point is unambiguous: every one of the 7 has a single
`export SCRUPLE_DB_PATH="${SCRUPLE_DB_PATH:-…}"` line, and the preflight goes
immediately after it — before that line the path is not yet known, and every
gate begins with an identical `set -uo pipefail` that would be the wrong anchor
for exactly that reason.

🔴 **On a fresh clone this is not occasional, it is certain.** A new checkout has
no database at all, so every gate that submits a leaf fails on first run and
looks like a platform bug. That is exactly what the travel laptop will hit.

## The fix: `scripts/preflight-schema.mjs`

⚑ **The point is not that migrations get applied. It is that a schema failure
stops looking like a test failure.** A gate that applied migrations silently
would have fixed this morning's symptom and left the next one undiagnosable — so
the default is to **REFUSE and name the pending files**; `--apply` is opt-in, and
it re-reads the database afterwards rather than trusting its own writes.

Distinct exit codes, so a caller can tell these apart without parsing prose:

| exit | means |
|---|---|
| `0` | schema matches the tree |
| `3` | **migrations pending** (and `--apply` was not given) |
| `4` | the database could not be opened or read |

It resolves the migrations directory **from its own location, never from cwd**.
`lib/db/migrate.ts` uses `process.cwd()`, so it silently depends on being run
from the repo root and a gate that `cd`s anywhere gets a different answer to the
same question.

## Evidence — every case run, with controls

| case | expected | got |
|---|---|---|
| **CONTROL** — current database | 0 | ✅ 0, `pending=0` |
| behind by one | 3 | ✅ 3, names `059_declared_uncaptured.sql` |
| `--apply` | 0 | ✅ 0, applied and re-verified |
| re-run after apply | 0 | ✅ 0 |
| **CONTROL** — unopenable database | 4 | ✅ 4 |
| **the laptop's first run** — no database at all | 3 then 0 | ✅ 59 pending → applied → **48 tables, identical count to the live sandbox** |

The current-database and unopenable cases are controls: without them a script
that always exited 3 would pass the case that matters and be useless.

Checked against the live sandbox database while the E series was running:
`pending=0`, so WO-E5 is not affected.

## What is NOT done

- 🔴 **The seven gates are not wired to it yet.** The script is proven; the
  one-line addition to each gate is not made, because the E-series runner owns
  both trees right now and editing under it would collide.
- **No control yet shows a gate failing with the schema message instead of
  assertion errors.** That is the assertion that would actually close E4-0, and
  it needs the sandbox the runner is using.
- The app still does not refuse to serve on a stale schema. Failing closed at
  the source would be stronger than eleven callers each remembering to ask, and
  it is a bigger change than this.
