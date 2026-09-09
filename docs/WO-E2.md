# WO-E2 — `declared_uncaptured`, the absence set, with its scope on the leaf

_2026-09-09. **Server repo change**, committed in `/data/scruple-web`:
`61b1138` (the settled scope rule, **first**) and `634c66e` (the implementation);
parent `ae89b7f`._
_Gate: `bash /data/scruple-web/scripts/e2-gate.sh` — **8 pass, 0 fail**. It
contacts no server: every stage runs in a temporary directory._
_Run artifacts: `/mnt/corpus/scruple-council-impl/wo-e2/`._

## The scope rule was settled in writing first, and that is checkable

The work order's first instruction was to settle the scope rule before building
to it. `docs/canon/DECLARED_UNCAPTURED.md` is that document and it is **its own
commit, one before the code** — `61b1138`, then `634c66e`. It is not a
retrospective justification, and `git log` says so.

The question is not mine. Round 5 §3 put it to Coder as a question rather than a
ruling:

> must `declared_uncaptured` carry the scope it enumerated over — which root
> types were configured, and whether any were `unspecified` — or does it assert
> a closure it does not have? That is your own measured-or-unknown invariant
> applied one level up: **the completeness of the absence set is itself a fact**,
> and it needs a source like every other fact.

Line 369 answered it, and that answer is the specification: the record needs
"the configured volume types and roots, the query interval or history watermark,
whether any `unspecified` volume exists, and a completeness result", with a
complete enumeration permitted "only when all relevant typed roots are covered
and no relevant root is `unspecified`". WO-C5 built everything this depends on
and stopped here deliberately — `council-impl/WO-C5.md` §10 names this as "the
largest thing left".

## What is on the leaf

Five signed scalars in `capture`, all five in the MAC preimage, plus the set
itself at the top level with only its digest signed — the `host_evidence`
arrangement, because a list cannot be a preimage field:

| field | values |
|---|---|
| `capture.uncaptured_enumeration_method` | `live_history` · `none` |
| `capture.uncaptured_scope` | `complete` · `partial` · `not_enumerated` |
| `capture.uncaptured_scope_source` | `measured` · `unknown` |
| `capture.declared_uncaptured_count` | an integer, or null |
| `capture.declared_uncaptured_hash` | sha256 of the document, or null |
| `declared_uncaptured` (top level) | the set, its scope and its completeness |

`/api/v2/witness` recomputes the digest from the document and refuses a pair
that disagrees, and refuses each half without the other.

## The enumeration reaches `temp/`, and that is the fact that made it viable

The source is `GET /history`, not the filesystem. Round 5 §4(a) was checked in
the ComfyUI source for that round rather than reasoned about: `PreviewImage` is
a `SaveImage` subclass whose `output_dir` is `folder_paths.get_temp_directory()`
(`nodes.py:1684-1690`), `SaveImage.save_images` emits `"type": self.type` per
file (`:1678`), and `task_done` merges the result into the ring
(`execution.py:1237-1242`). **A `temp/` artifact is listed in `/history`, tagged
`type: "temp"`, even though it never reaches `output/`.** That is the artifact
class an `output`-only deployment cannot see, and it is what session A of the
gate catches.

⚑ **Any array under any key of an `outputs` node is walked — there is no
allowlist of `images`.** `gifs` is VideoHelperSuite's, `audio` is `SaveAudio`'s,
and a vendor node picks its own. A key allowlist is an enumeration used as a
boundary with none of an enumeration's honesty: a key that does not match is not
"unknown", it is silently *not an artifact*, and the absence set then omits
exactly what nobody thought of. That is WO-27's finding in `correlation.ts`, one
file over, where it cost the component a node the product ships. Mutant 6 turns
the allowlist back on and the anti-vacuity test goes red.

## The closure rule, and why the roots are a condition of a set drawn from `/history`

`uncaptured_scope` is `complete` only when **all four** hold. Any one failing
makes it `partial`, and each failure names itself in the document's
`completeness.reasons`.

1. **`roots_cover_c8`** — `output`, `temp` and `input` all declared, and no root
   `unspecified`. The non-obvious part: `/history` enumerates what output
   **nodes** reported, so a custom node writing straight to disk produces **no
   entry at all** — round 6 §5 classified that as "correctly uncaptured" and a
   host quota problem. The filesystem watcher is the only observer of that
   class, so a closure claim needs it watching every typed root; and an
   `unspecified` root's observations cannot be matched against a typed
   reference. That is line 369's condition, with the mechanism that makes it one.
2. **`history_enumerated`** — `upstream_uncaptured_reason` is `enumerated` and
   `upstream_source` is `measured`. WO-C5's field doing the job it was built for.
3. **`window_unsaturated`** — the enumeration asked `/history?max_items=N` and
   got back fewer than N, so the window is the whole retained ring and the page
   size did not truncate it.
4. **`ledger_intact`** — the component's captured-set ledger is bounded and has
   evicted nothing. A ledger that forgot a capture would report a captured
   artifact as uncaptured, so the bound costs the leaf its **closure claim**
   rather than its accuracy.

## ⚑ 0 is a count and null is not

The two states the work order names must be distinguishable **from the signed
fields alone**:

| | count | hash | document | scope |
|---|---|---|---|---|
| enumerated, nothing uncaptured | **0** | present | present, `artifacts: []` | `complete`/`partial` |
| never enumerated | **null** | null | **absent** | `not_enumerated` |

That is why the count is in the MAC beside the digest even though the document
carries it: without it, "the component looked and found nothing" and "the
component did not look" are one dropped attachment apart. Different operational
conditions, different owners — the distinction `blind`/`declined` holds open one
block over and `not_queried`/`evicted_or_restarted` one block before that.

## The completeness has its own source, and it is `unknown` on every leaf today

Coder's answer on round 5 fact (b) is explicit and is not softened here:

> completeness is `source: unknown` unless an **independent observer**
> establishes the relevant history window and continuity.

The only party that reads `/history` is the component that emits the leaf. It is
not independent of its own claim — that is the self-grading `hostRegistry.ts`
refuses one file over (`host_may_not_grade_itself`).

So the value is **derived from a named blocker rather than hardcoded**, in the
shape `attestationBasis.ts` already uses for `CHECKPOINT_VECTORS_SETTLED`:
`UNCAPTURED_INDEPENDENT_OBSERVER` with `UNCAPTURED_OBSERVER_BLOCKER_REASON`, and
rule 8 refuses `measured` on the wire while it stands. The tests drive both
branches, so this is a value that can move rather than a field that can never
fire — which is the failure mode WO-C5 refused for a `/system_stats`-based
restart detector.

⚑ `complete` beside `source: unknown` is **two facts, not a contradiction**: the
first says every condition closure requires holds as the component measured
them, the second says nobody outside the box confirmed the window. WO-C5 settled
the identical shape when it accepted `upstream_continuity: "unknown"` beside
`upstream_source: "measured"`.

## The one place this reads the specification rather than transcribing it

Coder: *"If history is unavailable, restarted, evicted, or outside the requested
interval, the absence set must be omitted or marked empty only as 'not
enumerated' — never as 'none'."*

Taken literally all four produce `not_enumerated`. That is right for
**unavailable** — the query failed, there is no enumeration. It is wrong for
**restarted / evicted / outside the interval**: in all three the read *succeeded*
and returned real artifacts that really were not captured, and discarding them
would delete measured facts to avoid a claim nobody was making.

So they are split, and the prohibition is honoured by the mechanism instead:
those three are `partial` with the reason named, and **a `partial` set is a list
of things that were definitely not captured — it is never a statement about
anything absent from the list.** An empty set on a restarted reading therefore
cannot read as "none". This is written out in the design doc §5 rather than left
for a reader to discover.

## Three guards, and none of them is the same guard twice

| guard | stops |
|---|---|
| the types in `lib/capture/declaredUncaptured.ts` | the code being written |
| `lib/leaf/captureClaims.ts` **rule 8** — six refusals, 422 | the JSON arriving; types do not survive a wire |
| migration **059**'s four cross-column CHECKs | any other writer that reaches the table through neither |

Rule 8's six: (a) absent or malformed; (b) `not_enumerated` carrying a count, a
hash or a method; (c) **the empty-set rule** — an enumerated scope with a null
count or hash; (d) `scope_source: "measured"` while the blocker stands;
(e) **the cross-rule** — `complete` on a leaf whose own
`upstream_uncaptured_reason` is not `enumerated`; (f) a count that is not a safe
non-negative integer, a scope field sent one level up (outside the MAC while
looking signed), or the document sent one level down.

⚑ Stage 4 of the gate exercises 059 **from the shell against a fresh database
with no validator in the path**, because a guard only ever reached through the
two above it has never been shown to be a guard. Eight rows, four refused by
each of the four CHECKs, two accepted, and a legacy all-NULL row accepted.

## The float has two independent guards, and only one of them is mine

`declared_uncaptured_count` cannot be a float. `canonicalPreimage` refuses to
MAC one at all (§10 C-1), so **a conforming component cannot produce that
shape** — the test has to put the float on the wire *after* the MAC, and asserts
both guards. Same arrangement WO-C5 uses for a watermark one field over.

## The gate, and its controls

`bash /data/scruple-web/scripts/e2-gate.sh`. Three sessions against the real
`CaptureComponent` and a stub ComfyUI that reports artifacts in `/history`. Same
upstream, same graph, same retrievals — **the only difference is which roots are
declared.**

| | before (`01-controls-RED.txt`, a worktree at the parent commit) | after (`03-live-GREEN.txt`) |
|---|---|---|
| leaves submitted (A 4 · B 6 · C 4) | 14 | 14 |
| distinct leaves, after the listing de-duplicates re-deliveries | 13 | 13 |
| leaves carrying any scope at all | **0 — the field does not exist** | 13 |
| A: leaves naming an uncaptured artifact | 0 | **4** |
| B: newest count / scope | `(ABSENT)` / `(ABSENT)` | **0** / `complete` |
| C: scopes | `(none)` | `partial`, every leaf |
| result | **GATE FAILED** | **GATE PASSED** |

- **THE GATE** — session A watches `output/` only. The `PreviewImage` write
  lands in `temp/`, is listed in `/history`, and nobody retrieves it. Four
  leaves name it, with `scope: types=[output] missing=[temp,input]
  unspecified=0 window=1/64` and the epoch of the bracket it was read from.
- **CONTROL 1** — session B watches all three roots, so the watcher captures the
  temp write too. The newest leaf carries `count=0` with the **document present
  and its `artifacts` list empty**, and `uncaptured_scope: complete`. Not an
  absent field.
- **CONTROL 2** — session C uses the pre-C-8 single untyped root. Every leaf
  reads `partial` with `roots_cover_c8: false` and `unspecified_roots: 1`.
  Closure refused.
- **THE CONTROL FOR THE CONTROLS** — `complete` occurs at least once, so
  `partial` is not a constant and none of the above is measuring a value that
  cannot move.

The gap between 14 submitted and 13 distinct is not a defect and was checked
rather than assumed. `Submitter.capture()` enqueues before it sends and then
drains best-effort, so two concurrent surfaces can both drain one entry; the
submitter's own comment owns it — *"a crash the other way costs one duplicate,
which the server drops idempotently on (component_id, counter)"*. The real route
dedupes and the driver's forty-line ingest stub does not. The duplicates were
verified **byte-identical** — same MAC, same counter, same capture block — so
they are re-deliveries of one leaf, not two leaves. The verdicts run over the raw
list; only the printout is de-duplicated.

⚑ Stage 1 asserts **why** it is red: all 13 distinct leaves at the parent commit
carry `scope=(ABSENT)`. "The control did not fire" and "the control fired" are not
allowed to read the same, and an inconclusive stage is scored as such.

## The tests are controls too

`02-the-test-is-a-control.txt` reverts one half at a time. Each mutant is
targeted, nothing else moves, and the unmutated tree is 49/49 green.

| mutant | red |
|---|---|
| 1. closure condition 1 (`roots_cover_c8`) always true | 4 tests **and CONTROL 2 of the live gate** |
| 2. an empty enumerated set reports a null count | 3 tests **and CONTROL 1** |
| 3. rule 8 is not called | 9 of the route refusals |
| 4. the five keys leave the server preimage | all three in-the-MAC tests and the shape test |
| 5. the ledger write moves below `buildLeaf` | the ordering test |
| 6. `artifactsInOutputs` uses an `images` allowlist | the anti-vacuity test |

### ⚑ Found by this sweep, and it was a hole in my own tests

**Mutant 5 survived the first pass** — 48/48 green and the live gate exit 0. The
ordering decision (record the captured-set ledger **before** `buildLeaf`, so an
artifact never appears in the absence set of its own leaf) was implemented and
documented and **not asserted**: both the live sessions and the suite happened
to observe the leaf only after the ledger had caught up.

The fix was a test rather than a code change. "An artifact NEVER appears in the
absence set of its OWN leaf" isolates the ordering deterministically — the
artifact is put into the `/history` enumeration **before** the gate retrieves it,
and only `input/` is watched so the filesystem watcher cannot capture it first.
Under the mutant the leaf names itself; under the shipped code it does not. All
six mutants now die in the right places.

The live gate still does **not** catch mutant 5, and that is stated rather than
papered over: the driver's sessions cannot isolate the ordering, and the suite is
what covers it.

## What this does NOT buy — said here, not discovered later

1. ⚑ **`complete` is closure over what `/history` REPORTED, not over what the
   machine wrote.** A write that is neither reported by `/history` nor landed in
   any configured root is invisible to both halves. Condition 1 shrinks that
   class to writes outside every watched root, which round 6 §1 already put
   outside every completeness claim — and every member of the set carries
   `transaction: "none"` for that reason, so a verifier cannot read the ratchet's
   delivery-completeness interval as artifact completeness.
2. **The completeness source is `unknown` on every leaf and will stay so until
   an independent observer exists.** Nothing here proposes one. What would flip
   the flag is a witness-side history attestation or a second gate reading the
   same upstream; neither is built, and the blocker names itself.
3. **The enumeration inherits WO-C5's bound on the upstream.** `server.py:920`
   takes `number` from the client and `:933` takes `prompt_id` from the client,
   so a tenant who reaches `/prompt` influences what `/history` says it produced.
   This is a detector for an **operational** coverage gap — a workflow whose
   outputs nobody fetched — and is not a proof against a hostile tenant. It is
   the same class of bound `upstream_source: measured` already carries and the
   same one `correlation.ts` labels on every leaf it touches.
4. **The captured-set ledger is process state.** It does not survive a component
   restart, so the first leaves after one may name artifacts that an earlier
   process did capture. The ledger is bounded at 4096 and its eviction is
   disclosed; its *lifetime* is not, and a restart is a wider version of the same
   gap. Recorded rather than fixed — the honest fix is a durable ledger, which is
   its own work order.
5. **Two `test_model_write.py` failures are the pre-existing pair** recorded at
   every head in this series (`bbf4008`, `81d1661`, `179f875`, `abbc02d`,
   `d09b116`, `a8f91e2`) and are unrelated to this change.
6. **One flake, observed once, not reproduced.** The first full `test:v2` run
   after the change reported 3 failures in `watermark-chain.test.ts`, a file this
   WO does not touch. Seven subsequent full runs and six runs of that file alone
   are clean. Suspected load: this WO's new file starts several HTTP servers and
   `CaptureComponent`s in a 38-file parallel run. **Not diagnosed**, and recorded
   here because "I could not reproduce it" is a different sentence from "it did
   not happen".

## Files

| file | change |
|---|---|
| `docs/canon/DECLARED_UNCAPTURED.md` | **new, committed first.** The settled scope rule |
| `lib/capture/declaredUncaptured.ts` | **new.** The vocabulary, the enumeration, the ledger, the four-condition fold, the blocker |
| `lib/db/migrations/059_declared_uncaptured.sql` | **new.** Six columns, four cross-column CHECKs, two indexes |
| `test/v2/declared-uncaptured.test.ts` | **new.** 49 tests: the fold table, the ledger, rule 8, the MAC, the live gate and its controls |
| `scripts/run-e2.mjs`, `scripts/e2-gate.sh`, `scripts/e2-migration-checks.mjs` | **new.** The driver, the four-stage gate, the CHECK prober |
| `packages/scruple-host-sdk/.../declared_uncaptured.py` | **new.** The vocabulary only — the `server-library` placement has nothing to enumerate |
| `lib/capture/upstreamEpoch.ts` | `HistoryReading.outputs` carried raw; `enumerationWindow()`, `anchorWindow` |
| `lib/leaf/captureClaims.ts` | rule 8 |
| `lib/leaf/componentPreimage.ts` | the five keys, server side |
| `lib/v2/http.ts` | `declared_uncaptured_required` / `_refused`, both 422 |
| `app/api/v2/witness/route.ts` | the document, the digest recomputation, six columns |
| `services/scruple-capture/src/leaf.ts` | `uncapturedFor`, five capture fields, all five in `preimageOf`, the document at the top level |
| `services/scruple-capture/src/submitter.ts` | `uncapturedFor`, `recordCaptured` **before** the derive, the transition log |
| `services/scruple-capture/src/component.ts` | the ledger, the declared roots, the fold |
| `services/scruple-capture/src/surfaces/http-gate.ts` | `artifact_ref` on `/view` only |
| `services/scruple-capture/src/surfaces/fs-watch.ts` | `artifactRefFor()` |
| `services/scruple-capture/test-support/stub-comfyui.ts` | `temp/`, `PreviewImage`, and `outputs` merged at execution |
| `lib/canvas/baseline.ts` | re-recorded — `http-gate.ts` is on canvas's tamper surface. The mechanism working |
| `scripts/gen-component-preimage-vectors.mjs` output, six `test/v2` fixtures, the SDK's hand-listed preimage | the five new keys |

## Runs

| file | what it holds |
|---|---|
| `00-baseline-suites.txt` | before any change. v2 863, conformance 47, integration 19, typecheck clean |
| `01-controls-RED.txt` | the live driver against a worktree at the parent commit: no scope on any leaf, gate not raised, both controls red |
| `02-the-test-is-a-control.txt` | six mutants, each red in the right place, including the one that survived first and the assertion that now kills it |
| `03-live-GREEN.txt` | the same driver at HEAD — gate raised, both controls hold, `complete` reachable |
| `04-suites-AFTER.txt` | v2 912, conformance 47, integration 19, sdk unchanged at 2 pre-existing failures, typecheck clean |
| `05-rails.txt` | `/opt/scruple-witness` untouched; the gate contacts no server; `CHECKPOINT_VECTORS_SETTLED` not touched; 059 applies to a fresh database |
| `06-wo-suite.txt`, `07-migration-checks.txt` | the WO suite, and 059's CHECKs probed from the shell |
| `mutants.sh`, `run-e2.mjs` | the scripts behind 02, 01 and 03 |
