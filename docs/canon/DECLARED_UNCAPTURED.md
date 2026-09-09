# `declared_uncaptured` — the absence set, and the scope it enumerated over

_WO-E2, 2026-09-09. **Written before the implementation and committed before
it**, because the work order's first instruction is to settle the scope rule in
writing and the second is to build to what was settled. Read
`STOOGES_RESULT_BLENDER_COMFYUI_WRAP.md` round 5 §3 and §4, then
`council-impl/WO-C5.md` §10, which is the WO that stopped here on purpose._

## 0 · The question, and who asked it

WO-C5 built the machinery an absence set needs — the upstream identity, the
epoch, both low watermarks, and the five-valued `upstream_uncaptured_reason` —
and did **not** build the set, because its scope rule was unsettled. The
question was put to Coder in round 5 §3 as a question rather than a ruling:

> must `declared_uncaptured` carry the scope it enumerated over — which root
> types were configured, and whether any were `unspecified` — or does it assert
> a closure it does not have? That is your own measured-or-unknown invariant
> applied one level up: the *completeness of the absence set* is itself a fact,
> and it needs a source like every other fact.

The answer, line 369, is the specification this document builds on and does not
reopen:

> `declared_uncaptured` must be scoped, never treated as a global absence claim.
> Its record needs the configured volume types and roots (`output`, `temp`,
> `input`), the query interval or history watermark, whether any `unspecified`
> volume exists, and a completeness result. A complete absence enumeration is
> permitted only when all relevant typed roots are covered and no relevant root
> is `unspecified`; otherwise the set is explicitly partial and cannot support a
> closure claim.

and, on the volatility of `/history` (round 5 §4(b), Coder's answer in the same
paragraph):

> `source: measured` applies to the returned enumeration itself, with
> `enumeration_method: "live_history"` and its observed scope; completeness is
> `source: unknown` unless an independent observer establishes the relevant
> history window and continuity. If history is unavailable, restarted, evicted,
> or outside the requested interval, the absence set must be omitted or marked
> empty only as "not enumerated" — never as "none" — with `source: unknown` and
> an explicit reason.

Everything below is that specification made decidable. Where it required a
reading rather than a transcription, §5 says so and gives the argument.

## 1 · What the set is a set of

**The enumeration source is `GET /history`, not the filesystem**, and round 5
§4(a) is why that is not a compromise: `PreviewImage` sets `self.type = "temp"`
(`nodes.py:1684-1690`), `SaveImage.save_images` emits `"type": self.type` per
file (`:1678`), `execution.py:802-803` puts the result in
`history_result["outputs"]` and `task_done` merges it in (`:1237-1242`). A
`temp/` artifact **is** listed in `/history`, tagged `type: "temp"`, even though
it never reaches `output/`. The enumeration therefore already reaches the volume
the pre-C-8 configuration could not see.

An artifact reference is the triple ComfyUI itself uses on `/view` and in
`history[*].outputs[*]`:

```
{ "type": "output" | "temp" | "input" | "unspecified", "subfolder": "", "filename": "X_00001_.png" }
```

`declared_uncaptured` is **that set, minus what the component captured**. The
captured side is a ledger the component keeps as it emits: every observation
that carries an artifact reference — a `/view` retrieval through the gate, a
file closing in a watched root — is recorded **before** its own leaf is built,
so an artifact never appears in the absence set of its own leaf.

⚑ **Any array under any key of an `outputs` node is walked, not an allowlist of
`images`.** `gifs`, `audio`, `video` and a custom node's own key are the same
shape and the same fact. `correlation.ts` records what a name-shape boundary
cost when `VHS_VideoCombine` fell outside it; a key allowlist here would be the
same defect one file over. An element is an artifact reference if it has a
string `filename`, and a `type` that is absent or unrecognised reads
`unspecified` — never guessed.

## 2 · The closure rule, settled

A leaf carries three signed scalars about the scope and two about the set:

| field | values | what it says |
|---|---|---|
| `capture.uncaptured_enumeration_method` | `live_history` \| `none` | how the set was obtained |
| `capture.uncaptured_scope` | `complete` \| `partial` \| `not_enumerated` | the **completeness result** line 369 asks for |
| `capture.uncaptured_scope_source` | `measured` \| `unknown` | the source **of the completeness**, §4 |
| `capture.declared_uncaptured_count` | integer \| null | how many are in the set. **0 is a count** |
| `capture.declared_uncaptured_hash` | sha256 \| null | binds the document below |

and the document itself top-level beside `model_fingerprints` and
`host_evidence`, for the reason those are top-level: `capture` is what the
component **observed**, and a list is not a scalar the MAC can carry. Only its
hash is signed, and `/api/v2/witness` recomputes the hash from the document and
refuses a pair that disagrees — the same arrangement, for the same reason.

**`uncaptured_scope` is `complete` only when all four conditions hold. Any one
failing makes it `partial`, and each failure names itself in the document.**

1. **`roots_cover_c8`** — `output`, `temp` and `input` are all declared in
   `watchedVolumes`, and **no** declared root has type `unspecified`.
   *Why this is a condition of a set drawn from `/history`, which is the
   non-obvious part:* `/history` enumerates what output **nodes** reported. A
   custom node that writes straight to disk — IT Expert's runaway 50 GiB case,
   which round 6 §5 classified as "correctly uncaptured" — produces **no**
   `/history` entry at all. The filesystem watcher is the only observer of that
   class, so a closure claim needs it watching every typed root; and an
   `unspecified` root's observations cannot be matched against a typed
   reference, so an untyped root is an unwatched root for this purpose. This is
   line 369's condition, and this is the mechanism that makes it a condition
   rather than a convention.
2. **`history_enumerated`** — `capture.upstream_uncaptured_reason` is
   `enumerated` **and** `capture.upstream_source` is `measured`. This is
   WO-C5's field doing the job it was built for: the ring held across both ends
   of the bracket and the reading covers this leaf's interval.
3. **`window_unsaturated`** — the enumeration read `/history?max_items=N` and
   got back **fewer than N** entries, so the window is the whole retained ring
   and nothing escaped it by being older than the window. A saturated window may
   have been truncated by the window rather than by the ring, and cannot support
   a closure claim. (`N` is `upstreamAnchorWindow`, 64 by default.)
4. **`ledger_intact`** — the component's captured-set ledger is bounded and has
   evicted nothing. A ledger that has forgotten a capture would report a
   captured artifact as uncaptured. The bound is disclosed rather than assumed,
   which is the same discipline the ring gets.

## 3 · What `complete` means, and the one thing it does not

`complete` is closure **over what `/history` reported, across roots that cover
every typed volume**. It is not closure over what the machine wrote.

The residual, named here rather than discovered: a write that is **neither**
reported by `/history` **nor** landed in any configured root is invisible to
both halves. Condition 1 shrinks that class to writes outside every watched
root, which is a declared root boundary and is exactly the class round 6 §1
already put outside every completeness claim: *"an artifact written straight to
`output/` never crosses the wire, so there is no transaction ... the leaf must
explicitly record `declared_uncaptured` with its scope, `transaction: none`, and
`completeness: {source: unknown}`."* The document carries `transaction: "none"`
for every member for that reason: nothing in this set was numbered by the
ratchet, and a verifier must not read a delivery-completeness interval as
artifact completeness.

## 4 · `uncaptured_scope_source`, and why it is `unknown` on every leaf today

Coder's answer is explicit and is not softened here: **completeness is
`source: unknown` unless an independent observer establishes the relevant
history window and continuity.** The only party that reads `/history` is the
same component that emits the leaf. It is not independent of the claim, and a
completeness fact sourced from the party it describes is exactly the
self-grading the host registry refuses one file over
(`host_may_not_grade_itself`).

So the source is **derived from a named blocker, not hardcoded**, in the shape
`attestationBasis.ts` already uses for `CHECKPOINT_VECTORS_SETTLED`:

```ts
export const UNCAPTURED_INDEPENDENT_OBSERVER = false;
export const UNCAPTURED_OBSERVER_BLOCKER_REASON = '…';
```

`uncaptured_scope_source` is `measured` only when that flag is true **and** the
component measured the window; `unknown` otherwise; and the validator refuses
`measured` on the wire while the flag stands, with the blocker as the message —
rule 4's shape exactly. The function computes both branches and the tests drive
it with the flag both ways, so the day an independent observer exists the value
moves without a schema change and without a field that was never able to fire.

⚑ **`complete` with `source: unknown` is two facts, not a contradiction.** The
first says the component's configuration and its own bracket satisfy every
condition closure requires. The second says nobody outside the box confirmed
the window. WO-C5 settled the identical shape when it accepted
`upstream_continuity: "unknown"` beside `upstream_source: "measured"`: a
reading and the strength of the reading are different questions, and collapsing
them forces a component to lie in one direction or the other.

## 5 · The one place this reads the specification rather than transcribing it

Coder: *"If history is unavailable, restarted, evicted, or outside the requested
interval, the absence set must be omitted or marked empty only as 'not
enumerated' — never as 'none'."*

Taken literally, all four conditions produce `not_enumerated`. That is right for
**unavailable** — the query failed, so there is no enumeration and nothing to
say. It is wrong for **restarted / evicted / outside the interval**: in all
three the read *succeeded* and returned real artifacts the component really did
not capture, and discarding them would delete measured facts to avoid a claim
nobody was making.

So this design splits them, and the prohibition is honoured by the mechanism
rather than by the omission:

| upstream reason | scope | why |
|---|---|---|
| `history_unavailable`, `not_queried` | `not_enumerated` | no enumeration exists |
| `evicted_or_restarted`, `interval_not_covered` | `partial`, with the reason named | the enumeration is real; it is not a closure |
| `enumerated` | `complete` if conditions 1, 3, 4 also hold, else `partial` | — |

The sentence Coder was protecting is *"an empty set must never read as
none"*, and condition 2 guarantees it: an empty set on a restarted or stale
reading is `partial`, which asserts nothing about what is not in it. A
`partial` set is a list of things that were definitely not captured; it is
never a statement about anything absent from the list.

## 6 · Empty-and-present is not absent, and it is signed

The two states the work order names must be distinguishable **from the signed
fields alone**, without fetching the document:

| | `declared_uncaptured_count` | `_hash` | document | `uncaptured_scope` |
|---|---|---|---|---|
| enumerated, nothing uncaptured | **0** | present | present, `artifacts: []` | `complete` or `partial` |
| never enumerated | **null** | null | **absent** | `not_enumerated` |

That is why the count is in the MAC beside the hash even though it is derivable
from the document: a verifier holding a leaf must be able to tell "the component
looked and found nothing" from "the component did not look" without trusting an
unsigned attachment, and those two are different operational conditions with
different owners — the same distinction `blind` / `declined` holds open one
block over, and `not_queried` / `evicted_or_restarted` one block before that.

## 7 · Three guards, and none of them is the same guard twice

The pattern 053, 056, 057 and 058 each earned:

| guard | stops |
|---|---|
| the types in `lib/capture/declaredUncaptured.ts` | the code being written |
| `lib/leaf/captureClaims.ts` rule 8 | the JSON arriving — types do not survive a wire |
| migration `059`'s cross-column CHECKs | any other writer that reaches the table through neither |

`declared_uncaptured_*` is **NULL and not backfilled** for every row written
before 059, for 057's reason: NULL is "the question was never asked of this
leaf", `not_enumerated` is "asked, and there was nothing to enumerate".
