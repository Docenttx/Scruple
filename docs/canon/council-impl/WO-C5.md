# WO-C5 — upstream restart detection, and the epoch that carries it

_2026-09-09. Implements WO-C5 of `docs/wo/2026-09-09-council-implementation.md`
against the settled design in `docs/canon/STOOGES_RESULT_BLENDER_COMFYUI_WRAP.md`
(hand round 6 §2, where the engineers took this back from the schema; Architect's
round 5 condition on the `declared_uncaptured` reason field; and Coder's round 5
§4(b) verification of `MAXIMUM_HISTORY_SIZE` in the ComfyUI source). Sandbox
only: app `127.0.0.1:3902`, witness `127.0.0.1:5899`, scratch
`/mnt/corpus/scruple-council-impl/wo-c5`. `/opt/scruple-witness` was READ,
never written — `05-rails.txt` shows nothing under it has an mtime later than
2026-09-04._

**GATE: PASSED. The scratch upstream is restarted mid-session against the real
`CaptureComponent` and a leaf carries `upstream_continuity: "restarted"` with
`upstream_uncaptured_reason: "evicted_or_restarted"` and
`upstream_source: "measured"`. The control is in the same run: an unrestarted
session of the same length and the same work raises nothing and holds ONE epoch
throughout, while the restarted session holds three.**

---

## 1 · The finding that decides the shape of the whole fix

The work order says *"poll `/system_stats`, record the upstream's identity and a
history epoch"*. Those are two different measurements and only the first comes
from `/system_stats`, because:

🔴 **`/system_stats` CANNOT DETECT A RESTART.** `server.py:646-685` returns
`os`, `ram_total`, `ram_free`, `comfyui_version`, the frontend and template
versions, `python_version`, `pytorch_version`, `embedded_python`, `argv`, and a
`devices` array of names and VRAM figures. **There is no boot id, no pid, no
start time, no session uuid.** Not one field changes because the process
restarted — and the two that do move (`ram_free`, `vram_free`) move
continuously whether it restarted or not, so they are noise rather than signal.

A first pass at this work order digests `/system_stats`, compares the digest to
the last one, finds it equal across a restart, and ships a detector that can
never fire. It would pass a green test and prove only that it cannot fail,
which is the exact failure mode this WO series exists to refuse. So the
identical digest is **asserted**, twice — once in
`test/v2/upstream-epoch.test.ts` against the stub, and once in the live run
against the real component:

```
identity before restart : sha256:cc53c0f4b0f740949ff1658619f5b08ffd9ceb25be6f80cd70513a82ec2b291e
identity after  restart : sha256:cc53c0f4b0f740949ff1658619f5b08ffd9ceb25be6f80cd70513a82ec2b291e
→ IDENTICAL. A /system_stats digest CANNOT detect this restart.
```

If a future ComfyUI adds a boot id, that assertion goes red and the epoch
machinery becomes belt-and-braces rather than the only signal — which is a fact
worth finding out from a red test rather than from a code review.

So the two halves are separate fields, and they stay separate everywhere —
type, preimage, validator, and two database columns:

| field | source | what it identifies | changes on a restart? |
|---|---|---|---|
| `upstream_identity` | `/system_stats` | which **install** | **no** |
| `upstream_epoch` | `/history` | which **run** | **yes** |

Reading one as the other is the blind spot this WO closes, so migration 057
refuses to hold them in one column and says why.

## 2 · The epoch, and what each rule is sufficient for

`PromptServer.number` is 0 at construction (`server.py:217`) and incremented per
accepted prompt (`:929`). `PromptQueue.history` is a plain dict
(`execution.py:1197`) that `task_done` evicts from the **front**
(`:1227-1228`). Both are process state, which gives three independent
contradictions — a restart only has to trip one.

| rule | contradiction | sufficient because |
|---|---|---|
| 1 | the high watermark went backwards | `self.number` cannot decrease inside one process |
| 2 | the low watermark went backwards | eviction pops the front, so the oldest retained number is non-decreasing |
| 3 | witnessed prompt ids vanished with too little new work to have evicted them | **the one the watermarks miss** |
| 0 | the `/system_stats` identity changed | a different install is answering the address |

**Rule 3 is the load-bearing one.** An upstream that has never held 10,001
prompts has low watermark 0 in *both* epochs, and if it processed more prompts
after the restart than before, the high watermark rises too. Both watermarks
read continuous across a real restart. The prompt ids do not — they are fresh
`uuid.uuid4()`s from the new process (`server.py:933`). Mutant 1 in
`02-the-test-is-a-control.txt` removes rule 3 and takes the gate down with it.

⚑ **AND THE UNDECIDABLE CASE IS `unknown`, NEVER `continuous`.** If no
witnessed prompt id survives into the current reading, nobody established
continuity — the ring may have turned over legitimately or it may have been
reset. An idle upstream with an empty history at both ends therefore reads
`unknown` forever, and that is correct: a restart between two empty readings
leaves no evidence of any kind. Reporting `continuous` there is precisely
"letting a restart look like a quiet afternoon", which is the sentence the work
order is written against.

## 3 · Both ends of the query, and why it is not pedantry

`GET /history` takes `max_items` and `offset` (`server.py:888-900`) and
`get_history` walks the dict under the mutex **per call**
(`execution.py:1282`). A client reading the ring in pages issues separate,
non-atomic requests, and `task_done` can evict between them. An enumeration
bracketed by one reading cannot tell "these entries were never there" from
"these entries left while I was reading". Bracketing it at both ends can.

So a bracket is four requests, and the order is the point:

```
GET /system_stats                  which install
GET /history?max_items=1&offset=0  OPEN  — offset=0 walks from the front: the low watermark
GET /history?max_items=64          the enumeration — the newest anchors
GET /history?max_items=1&offset=0  CLOSE — if it moved, entries left mid-query
```

(`max_items` with no `offset` returns the *newest*, because `offset` defaults to
-1 and becomes `len - max_items`. `offset=0` is what returns the oldest.)

Both watermarks reach the leaf, because the derivation must be checkable and
because one number cannot carry Architect's requirement. `test/v2` asserts the
exact four-request sequence, so a future refactor that drops the second
low-watermark read fails rather than quietly reverting to one end.

## 4 · Five reason values, because there are five fixes

Architect's condition, verbatim, is the whole of why this field is not a
boolean:

> "'not enumerated' is right, but the reason field needs to distinguish
> restart/eviction (bounded, detectable if you record the history epoch identity
> and the low watermark at both query ends) from 'history simply not queried' —
> otherwise the volatile source degrades to unknown for both the recoverable and
> unrecoverable cases and **you lose the only signal that would tell an operator
> to shorten their query interval**."

| value | means | fix |
|---|---|---|
| `enumerated` | the ring held across both ends and covers this interval | — |
| `evicted_or_restarted` | the epoch broke, or entries left the ring | **shorten the query interval** |
| `interval_not_covered` | a real reading, older than this leaf's interval | shorten the poll interval |
| `history_unavailable` | the query itself failed | the upstream is down or unreachable |
| `not_queried` | nobody asked | configure tracking — or nothing, on a placement with no upstream |

This series has now refused to fold two operational conditions into one value
three times: WO-C1 kept `stale` out of `passthrough`, WO-C4 kept
`degraded_no_reservation` out of `degraded_shared_storage`, and this keeps
`not_queried` out of `evicted_or_restarted`. Rule 6(d) enforces the last of
them where a prose version would rot — an unmeasured source may carry only
`not_queried` or `history_unavailable`, so the recoverable case can never wear
the unmeasured case's clothes.

## 5 · Why this polls, when WO-C4 measures inside `emit()`

WO-C4 established that a fact read once at startup is config-inherited by the
time a leaf is emitted, and that the fix is to re-read it **at** emission. That
is right for `stat(2)`. It is wrong here, for two reasons that are not
convenience:

1. **`emit()` is the blocking half of the gate** — no byte is forwarded until it
   resolves. An HTTP round trip inside it makes every artifact's latency depend
   on the upstream, and WO-C4's own finding is what a stalling blocking half
   costs.
2. **The thing being measured IS the upstream.** A component that blocks its
   capture path on the health of the process it is watching stops capturing
   exactly when that process misbehaves.

So the reading is taken out of band and **the staleness is disclosed on the leaf
rather than assumed**: `observationFor(observedAtMs)` degrades continuity to
`unknown` and the reason to `interval_not_covered` when the newest bracket is
older than `upstreamMaxReadingAgeMs`. A reading with a disclosed age is a
measurement; a reading whose age is silently assumed is the inheritance pattern.
The structural consequence is that **`continuous` can never be claimed for an
interval longer than the poll window**, which is exactly the bound the
underlying fact supports.

`upstreamFor` is still a **function** and not an `UpstreamObservation`, and
mutant 6 is the edit that makes it a value: the gate goes red.

### A discontinuity is an event in an interval, not a property of a poll

A leaf's interval runs from the previous emission to this one; the poll cadence
has nothing to do with it. A restart detected at 12:00:03 belongs on the next
leaf even if two clean brackets are taken before an artifact happens to be
produced. A tracker reporting only its newest reading would raise the alarm for
one poll window and then go quiet — **the restart would be in the log and on no
leaf at all**, which is this work order's own defect one level up. The first
green run of the gate script exhibited exactly that: the epoch changed, the
tracker's readings contained `restarted`, and not one leaf carried it.

So a detected discontinuity is **held** until an emission takes it, and mutant 2
removes the hold and turns two tests red.

⚑ It is not a de-duplicator. Inside the poll window in which the restart was
measured, the newest reading also says `restarted`, so a second leaf emitted
before the next bracket reports it too. That is one event seen by two leaves
whose intervals both contain it — both carry the same epoch transition — not two
events. And 🔴 the hold is cleared inside `buildLeaf`, **before** the MAC: if the
ratchet then fails to spend a counter the leaf is never emitted and the pending
event goes with it. That window is the one in which the gate is already failing
closed and forwarding nothing, and the epoch id still carries the discontinuity
to every later leaf. A weaker record, not an absent one, and it is written down
in the code rather than discovered.

## 6 · What this does NOT defend against, said here rather than discovered later

🔴 **The watermarks and the prompt ids are tenant-influenceable.**
`server.py:920` takes `number` FROM THE CLIENT
(`number = float(json_data['number'])`) and `:933` takes `prompt_id` from the
client too. A tenant who reaches `/prompt` can inject a number, negate it with
`front`, or choose its own ids.

So this is a detector for an **operational** restart — the process died and came
back, the failure mode the council named — and it is **not** a proof of
continuity against a hostile tenant. `upstream_source: "measured"` claims that
the component asked and recorded what it was told, which is the whole of what it
claims. That bound is the same class as the correlation heuristic
`correlation.ts` already labels on every leaf it touches, and stating it is the
difference.

Two defensive consequences follow, and both are tested:

- a `number` that is not a safe integer is **excluded from the watermarks**
  rather than poisoning them or aborting the reading. A float in a MAC preimage
  is a MAC that fails unreproducibly (§10 C-1), and an abort would hand a tenant
  an off switch for the signal. Its id remains an anchor, because the overlap
  rule is the part a tenant cannot forge: it cannot make ids it never sent
  reappear after a reset.
- the route refuses a float watermark at rule 6, and the ratchet independently
  refuses to MAC one. Both are asserted, and the float has to be put on the wire
  *after* the MAC because a conforming component cannot produce that shape.

## 7 · Three guards, and none of them is the same guard twice

053's and 056's pattern, repeated because it earned it:

| guard | stops |
|---|---|
| the types in `lib/capture/upstreamEpoch.ts` | the code being written |
| `captureClaims.ts` rule 6 | the JSON arriving — types do not survive a wire |
| migration `057`'s cross-column CHECK | any other writer that reaches the table through neither |

⚑ **And one refusal is deliberately NOT carried over from 056.**
`upstream_continuity = 'unknown'` **with** `upstream_source = 'measured'` is
**accepted**, where the analogous storage pair is refused. The facts differ. A
storage `unknown` means the stat failed, so no measurement exists. An upstream
`unknown` is frequently the *conclusion of* a measurement: an idle history at
both ends genuinely cannot distinguish a restart from a quiet afternoon, and a
component that looked and found that out is telling the truth. Refusing it would
force such a component to lie, and the lie in the `continuous` direction is the
exact defect this work order closes.

`upstream_*` is **NULL and not backfilled** for every row written before 057.
NULL is "the question was never asked of this leaf"; `not_queried` is "asked, and
there was nothing to ask".

### One refusal a draft got wrong, and the live run caught

A first draft of rule 6 also refused `upstream_uncaptured_reason: "enumerated"`
with both watermarks null — "claims an enumeration, bracketed nothing". **An
empty history ring legitimately has no watermark at either end, and the bracket
immediately after a restart finds exactly that.** The component was emitting a
shape its own validator would 422. It is fixed, the reason is written into the
file, and §7 of the test suite now puts every shape a real restarted session
produces through the real route so the component and the validator cannot drift
apart again silently.

## 8 · The gate, and the control, on the same run

`run-c5.mjs` drives the **real `CaptureComponent`** against a restartable stub
upstream transcribed from the ComfyUI source. Two sessions, the same length and
the same six rounds of work; the only difference is that A's upstream is
restarted halfway. The identical script was run against the pre-change tree
first.

| | before (`01-controls-RED.txt`) | after (`03-live-GREEN.txt`) |
|---|---|---|
| `/system_stats` across the restart | **IDENTICAL** | **IDENTICAL** |
| A — leaves flagged `restarted` | 0 (fields **ABSENT**) | **1** |
| A — distinct epochs | 1, `(ABSENT)` | **3** |
| B — leaves flagged `restarted` | 0 (fields **ABSENT**) | **0** |
| B — distinct epochs | 1, `(ABSENT)` | **1**, a real epoch |
| result | **GATE FAILED** | **GATE PASSED** |

The control is what makes the gate mean anything: B does the same work for the
same duration and stays on one epoch, so the flag is measuring the restart and
not the session length.

### The tests are controls too

`02-the-test-is-a-control.txt` reverts one half at a time. Each mutant is
targeted, nothing else in the file moves, and the unmutated tree is green:

| mutant | red |
|---|---|
| 1. the prompt-id overlap rule removed (watermarks only) | rule 3, the re-pin test, the null-number test, both hold tests, **and the gate** |
| 2. the discontinuity is not held for the next emission | both hold tests |
| 3. staleness is not disclosed | the fresh-vs-stale test |
| 4. validator rule 6 removed | ten of the eleven refusals |
| 5. the seven keys leave the server preimage | all three in-the-MAC tests, and the float MAC test |
| 6. `upstreamFor` becomes a value instead of a function | **the gate** |

## 9 · Files

| file | change |
|---|---|
| `lib/capture/upstreamEpoch.ts` | **new.** The measurement, the four rules, the reason vocabulary, the poller |
| `lib/db/migrations/057_upstream_epoch.sql` | **new.** Seven columns, the cross-column CHECK, two indexes |
| `test/v2/upstream-epoch.test.ts` | **new.** 47 tests: the gate, its control, the fold table, the refusals |
| `packages/scruple-host-sdk/scruple_host_sdk/upstream_epoch.py` | **new.** The vocabulary only — see §10 for why there is no second measurement |
| `services/scruple-capture/src/config.ts` | three options, and a refusal to accept a number that disables the detector |
| `services/scruple-capture/src/component.ts` | the tracker; `upstreamFor`; the first bracket awaited before the first leaf; `deps.upstreamFetchImpl` |
| `services/scruple-capture/src/submitter.ts` | carries `upstreamFor`; logs the transition |
| `services/scruple-capture/src/leaf.ts` | `LeafContext.upstreamFor`; seven capture fields; all seven in `preimageOf` |
| `lib/leaf/componentPreimage.ts` | the same seven keys, server side |
| `lib/leaf/captureClaims.ts` | rule 6 |
| `lib/v2/http.ts` | `upstream_epoch_required` / `_refused`, both 422 |
| `app/api/v2/witness/route.ts` | stores the seven columns |
| `services/scruple-capture/test-support/stub-comfyui.ts` | `/system_stats`, `/history` with ComfyUI's paging, uuid prompt ids, `restart()` |
| `scripts/gen-component-preimage-vectors.mjs`, `test/vectors/…json` | regenerated with the seven keys |
| `packages/scruple-host-sdk/.../server_library.py`, `model_write.py` | preimage keys; the `not_queried` shape |
| `packages/scruple-host-sdk/tests/test_server_library.py` | the hand-listed preimage gains the seven keys |
| `test/v2/{attestation-basis,resolution-handles,retention-settlement,component-auth,storage-confinement}.test.ts`, `probes/fixtures.ts`, `scripts/probe-harness/deployment.ts`, `kohya/{index,job-api-server}.ts` | fixtures and configs carry the new fields |

## 10 · What this WO did NOT do, recorded rather than left to inference

- 🔴 **`declared_uncaptured` — THE ABSENCE SET ITSELF — IS NOT BUILT HERE, and
  that is the largest thing left.** This WO builds the machinery the set
  depends on and the reason field it must carry: the epoch identity, both
  watermarks, and the five-valued `upstream_uncaptured_reason` in the MAC, in
  the validator and in the database. It does **not** enumerate `/history`
  outputs and diff them against the captured set. That work has an unsettled
  precondition in the design itself — round 5 §3 put the scope question to
  Coder as *"must `declared_uncaptured` carry the scope it enumerated over —
  which root types were configured, and whether any were `unspecified` — or
  does it assert a closure it does not have?"*, and the answer at line 369
  requires an `enumeration_method` and an observed scope this WO does not
  specify. Building the set on top of an unsettled scope rule would ship a
  completeness claim the design has not agreed. **The WO's own sentence about
  `declared_uncaptured` is discharged — the reason distinguishes
  "evicted/restarted" from "not queried", enforced in the validator — but the
  field it will hang from wants its own work order.**
- **There is no second measurement in Python, only the vocabulary.**
  `storage_confinement.py` is a full second implementation because the
  `server-library` placement can genuinely measure its own device pair. Here it
  cannot: the sidecar gate sits between a tenant and a *separate* ComfyUI whose
  in-memory ring can be reset under it, while at `server-library` the vendor's
  handler **is** the observation, in-process, with no `/system_stats` to poll
  and no history ring to lose. So that placement emits `not_queried`, which is
  the accurate answer and not a weaker one. `upstream_epoch.py` exists so the
  string it emits is the one the validator recognises; if a future host-library
  placement acquires a separate upstream, that file is where the real
  measurement goes and the shared vectors are what would hold the two together.
- **The Kohya doors get the `not_queried` shape too**, for the same reason:
  a checkpoint watcher and a job API have no upstream process with a volatile
  enumeration to lose. Said here so nobody later reads the asymmetry as an
  oversight.
- **`deps.fetchImpl` is deliberately not handed to the tracker.** That
  injection point exists so a test can stand in for the scruple-web API the
  Submitter posts to; the upstream is a different endpoint with a different
  owner, and handing the API's stub to the tracker would let a fixture answer
  `/system_stats` on ComfyUI's behalf. `deps.upstreamFetchImpl` is the separate
  seam.
- **A restart entirely inside one poll interval, with no prompt at either end,
  is undetectable and is reported `unknown`.** No implementation can do better:
  the evidence does not exist. The poll interval is therefore the bound on the
  claim rather than a performance knob, and `config.ts` says so.
- 🔴 **`packages/scruple-host-sdk/.../model_write.py` IS STILL REFUSED BY THE
  ROUTE**, unchanged from what WO-C1, WO-C2, WO-C3 and WO-C4 each recorded: it
  sends a non-null `capture.close_detection`, which rule 1 returns 422 for, and
  its `attestation_status` is H-5's two-valued envelope answer rather than the
  council's three-valued basis. This WO added the seven upstream fields so it is
  not *newly* non-conformant; it did not fix the two older faults, which are
  WO-C1's residue and want their own work order.
- The **two `test_model_write.py` failures are the pre-existing pair** recorded
  at every head in this series (`bbf4008`, `81d1661`, `179f875`, `abbc02d`,
  `d09b116`) and are unrelated to upstream tracking.

## 11 · Runs

| file | what it holds |
|---|---|
| `00-baseline-suites.txt` | before any change. v2 761, conformance 47, integration 19, **sdk 2 pre-existing failures**, typecheck clean |
| `01-controls-RED.txt` | the live run against the pre-change tree: no upstream field on any leaf, `/system_stats` already shown identical across the restart |
| `02-the-test-is-a-control.txt` | six mutants, each reverting one half, each red in the right place; the unmutated tree green |
| `03-live-GREEN.txt` | the same live run after the change — the gate raised, the control not raised, three epochs against one |
| `04-suites-AFTER.txt` | v2 808, conformance 47, integration 19, sdk unchanged at 2, typecheck clean |
| `05-rails.txt` | `/opt/scruple-witness` untouched; no code here names `:5799` or `:3001`; the three sandbox endpoints answer; migration 057 applies to a fresh database |
| `run-c5.mjs` | the script behind 01 and 03. Same file, both runs |
