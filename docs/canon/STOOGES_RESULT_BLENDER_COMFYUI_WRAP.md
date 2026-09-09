# Blender × ComfyUI provenance — the council's design, in full

Answers [`STOOGES_BRIEF_BLENDER_COMFYUI_WRAP.md`](./STOOGES_BRIEF_BLENDER_COMFYUI_WRAP.md),
which sits beside this file and is not restated here.

**This document is the council's own words, complete and unedited.** Nothing below
§0 is a summary, a paraphrase, or an assistant's gloss. Every contribution is
reproduced verbatim from the recorded transcript, including the ones that were
wrong, the ones that were later withdrawn, and the two rounds where a seat did not
speak at all. Where a section header makes a claim, the text under it is the
evidence for that claim rather than a restatement of it.

---

## 0 · Provenance of this document

| | |
|---|---|
| Production | `blender_plugin` · Scene 1 · Take `u_ZMW2QG2IVGNG.prod4.s1.t1` |
| Where it ran | production Stooges, `app.stooges.ai`, plan `byok` sub-tier 1 |
| Mode | Cast, featured — **not** group chat |
| Cowbell | `watcherSensitivity: 5` (Aggressive, the maximum) throughout both runs |
| Run 1 | 2026-09-08 ~06:00–07:13 UTC · 8 rounds · **no convergence** · 100 calls · $2.7562 |
| Run 2 | 2026-09-08 21:28–21:34 UTC · 4 rounds · **converged** · 40 calls · $0.7381 |
| Raw SSE | `<ai-council scratchpad>/rounds/r1–r8.sse` and `rounds2/r1–r4.sse` |

### The seats, and what each actually ran on

| Seat | Role | Run 1 model | Run 2 model |
|---|---|---|---|
| Coder | drafter (featured) | `claude-opus-5` ⚠ | `gpt-5.6-luna` |
| Architect | watcher | `claude-opus-5` | `claude-opus-5` |
| Loki | watcher | `grok-4.20-0309-reasoning` | `grok-4.20-0309-reasoning` |
| IT Expert | watcher | `gemini-2.5-flash` ⚠ | `gemini-3.8-flash` |

⚠ **Run 1 did not run the configuration it was given, and the transcript does not
say so.** Coder was pinned to `gpt-5.6-luna` and IT Expert to `gemini-3.8-flash`.
Both ids were in the model catalogue and on no ladder rung, so the platform's plan
clamp refused them and granted the plan ceiling instead — 14 featured calls went to
`claude-opus-5` at $1.37, and the IT Expert seat was hand-substituted to
`gemini-2.5-flash` by the driver. Anyone weighing run 1's arguments by which model
produced them should read the run-1 rows above, not the configuration. Fixed in
ai-council `6a0a2dc3`; run 2 ran as configured and recorded zero substitutions.

### Two runs, and why there are two

Run 1 answered the original brief and stopped at the round limit with three live
objections. Run 2 **amended** the brief rather than restarting it — the founder's
read was that run 1's position was honest and was not the objective — and resumed
with run 1's round-8 positions seeded as history. The amendment is reproduced in
full at Appendix A. Read run 1 (§4) before run 2 (§3) if you want the argument in
chronological order; read §1 first if you want the answer.

### How the run was stopped

Run 1 had no declared stop condition and hit its round limit. In run 2 each watcher
ends its contribution with `STATUS: SETTLED | OPEN | BLOCKING`, and the run stops
when none is OPEN or BLOCKING. **`SETTLED` means the watcher has nothing further to
raise. It does not mean the watcher thinks the design is good** — see Loki's closing
contribution in §2, which settles by conceding that the thing it spent twelve rounds
attacking is true, unfixable, and shippable only as a declared limit.

---

## 1 · The design as it finally stands

_Coder, hand-driven round 7 (the latest), verbatim and complete._

⚠ **THIS DESIGN IS NOT SETTLED.** Architect is OPEN — he wants the
`close_detection` validator rule written as schema text before he closes.
Loki is BLOCKING. See §3 for both, in their own words._

The filesystem position is unambiguously option **(c)**: remove filesystem events from the capture freeze gate. `IN_CLOSE_WRITE`, quiescence, and `fs-watch.ts` observations must not create, complete, or authenticate artifact leaves; any filesystem-only output is `declared_uncaptured`. I retract the later reinstatement explicitly. The validator must reject `close_detection` as a provenance or completion field, so this cannot return as a dead schema dependency.

Refusal commits at durable local `emit()`: derive, MAC, spend the counter, append durably, then enqueue for witness delivery. Witness availability is therefore non-blocking. A queued leaf is not external evidence yet, but it is a MACed local record whose counter creates an observable sequence gap. The protocol must expose `open/unresolved`, `resolved`, and an explicitly terminal state such as `expired` or `never-resolved`; “never” cannot be established without a declared observation horizon. I recommend a policy-bounded settlement window and durable queue-retention rule, while keeping capture fail-closed on inability to perform local append—not on witness latency.

The 50 GiB direct-to-output case remains a host quota and disk-exhaustion control, not a capture guarantee. It should be surfaced as an operational limit or incident, never misrepresented as captured provenance. Oversized intercepted streams should use bounded batching with count and counter ranges, and include the active ceiling plus counter in the leaf.

STATUS: **OPEN** — filesystem regression retracted; local commit rule fixed; settlement-window bound still requires Architect’s ruling.

<beat status="iterating" reason="Settlement-window policy remains unresolved"/>

---

## 2 · The three watchers' closing positions

_Hand-driven round 7, verbatim and complete. Two of the three are NOT settled._

### Loki

One might see local emit() as sealing the refusal, yet root simply LD_PRELOADs the ratchet to burn counters into a shadow queue that never reaches the real witness, turning your observable gaps into selective theater the settlement bound cannot distinguish. The 50 GiB direct-to-output case compounds this: no transaction means the counter itself becomes optional, exactly the dead schema dependency Architect warned would reappear. Press on recording the ratchet vantage as measured-or-unknown in every leaf. STATUS: BLOCKING — local commit still launders forgeable sequence under the conceded root boundary.

### Architect

Ruling: unbounded is not tolerable, because an unresolved gap that never expires is indistinguishable from a policy of never checking — the verifier defaults to accept by exhaustion. The bound must be *carried in the leaf* as a declared `settlement_deadline` plus the retention policy digest in force, so a verifier reading the leaf alone knows when silence becomes a finding rather than having to fetch out-of-band policy; at deadline the gap flips to a terminal `expired`, which is an assertion about the *component's delivery*, not about the leaf's validity. Two things that must go with it: the counter-gap evidence lives server-side, so the leaf needs the witness endpoint and component ID a verifier can query, or the mechanism is invisible to anyone who isn't the witness operator — and `expired` must itself be `source: measured` against a named clock, since a deadline derived from a locally-set timestamp is exactly the config-inherited field class we already refused. STATUS: OPEN — settlement window bounded and declared-in-leaf; retraction accepted, but I want the validator rule for `close_detection` written as schema text before I close.

### IT Expert

I accept the split: mitigating uncaptured node writes is a host-level boundary problem, not a provenance leaf concern. However, moving refusal commit to a durable local `emit()` means your queue spool now lives on disk; if `output/` shares a filesystem with that queue, an uncaptured 50 GiB runaway write will exhaust blocks and break the ratchet's local `fsync()`. Isolate `output/` onto a separate volume with hard `projectquota` limits so unmediated raster writes cannot DOS the local queue and force the entire capture gate closed.

---

## 3 · Hand-driven rounds 4–7 — the engineers answer back

_Every contribution verbatim, each preceded by the question that produced it._
_These rounds were driven one at a time by a human reading each result, with
the questions written by the session that owns `services/scruple-capture`._
_This is where the design actually changed: the filesystem was demoted from
witness to diagnostic, reservation was replaced by counting, and refusal was
moved to a durable local commit. It is also where the drafter reversed himself
on `IN_CLOSE_WRITE` and three watchers missed it — see round 7 §0._

### Hand round 4

<details><summary>The question put to them</summary>

```markdown
**A question from the engineers who own the capture component.** It is aimed
at your threat model, not your ergonomics, and it says your freeze gate
specifies something the implementation cannot produce.

Your design requires that a file is hashed only after `IN_CLOSE_WRITE`, so a
leaf cannot claim a completed file from a partial flush. **We cannot produce
that event.** `services/scruple-capture/src/surfaces/fs-watch.ts` says so in
its own header — *"NODE CANNOT SEE IN_CLOSE_WRITE. Say it, do not paper over
it."* On Linux libuv registers `IN_ATTRIB | IN_CREATE | IN_MODIFY | IN_DELETE |
IN_DELETE_SELF | IN_MOVED_TO | IN_MOVED_FROM` and reports only
`'rename'`/`'change'`. There is no close event in the set and no flag that adds
one.

That much is only an implementation gap, and a seam already exists:
`CloseWriteSource` is an interface whose `method` is either
`'inotify-close-write'` or `'fs-watch-quiescence'`, precisely so a real
close-write signal from an `inotifywait(1)` subprocess or a native addon can be
dropped in. Neither is a dependency the component takes today, and
`inotifywait` is **not installed on the reference host** — verified, not
assumed.

**Here is the part that should concern you.**

The default source approximates close-write by quiescence: after the last
`'change'` for a path, wait `settleMs` for a stable size, then hash. Its
documented failure mode is that a writer which stalls longer than `settleMs`
gets its **PARTIAL file hashed**, and then emits a second event and a second
hash when it finishes.

The record then shows **two hashes for one artifact — byte-for-byte
indistinguishable from a substitution.**

So the question is not which trigger to use. It is: **does your
provenance-source schema let a leaf distinguish "two hashes because the writer
was slow" from "two hashes because someone swapped the file"?** If it cannot,
then on any host without a real close-write source the gate does not merely
lose coverage — it **manufactures evidence of an attack that did not happen**,
and the defence gate becomes a false-accusation generator under exactly the
load (big renders, slow disks) where it is most likely to fire.

One fact you should have before you answer, which the engineers did not
mention and which we verified in the code: **`close_detection` is already
plumbed end to end.** `fs-watch.ts:339` writes `source.method` into the
observation, `leaf.ts:51/83/150/206` carries it, and
`lib/leaf/componentPreimage.ts:58/107` puts it in the **signed** preimage. So a
verifier can already tell that a hash came from a quiescence timer rather than
a real close event. Decide whether that is sufficient, or whether it is a field
that names the weakness without discharging it.

**Give us the required behaviour, and pick ONE rather than describing the
space.**

**(a)** Refuse to emit a file-derived leaf at all until a real
`CloseWriteSource` is present — making `inotify-tools` or a native addon a hard
install dependency, with the friction cost that implies on Windows and macOS.
Note if you choose this: the reference host does not have it installed, so
"hard dependency" means someone owns making that true on three platforms.

**(b)** Emit with a declared source marking the hash provisional. Then say
exactly what `unresolved` must contain, what supersedes a provisional leaf, and
**how a verifier three years later tells a superseded provisional hash from a
detected swap.**

**(c)** Drop the filesystem trigger from the freeze gate entirely and make the
wire the only authoritative witness. You may already be entitled to this:
`SaveImageWebsocket` forced you to concede the gate must be a stateful proxy
over artifact-bearing responses regardless, so the proxy already sees every
artifact the file would have carried.

If you choose **(c)**, name the artifacts for which the on-disk copy is
authoritative and the wire copy is not. **If that list is empty, then the
filesystem watcher is a convenience and not a witness, and it should not be
gating anything.**

Coder drafts and picks one. Watchers: attack the choice, and say plainly if you
think a different one was correct. End with your STATUS line.
```

</details>

#### Coder (drafter)

I choose **(c)**: remove the filesystem trigger from the freeze gate entirely. The authoritative artifact set is the complete byte stream of artifact-bearing HTTP and WebSocket responses observed by the stateful capture proxy, including `SaveImageWebsocket`; the list of artifacts for which an on-disk copy is authoritative while the wire copy is not is **empty**. A file that exists only on disk, or whose wire transfer was not captured, is omitted from authoritative provenance rather than promoted through a quiescence guess. `fs-watch.ts` may remain as diagnostic corroboration, but its observations—including `close_detection: "fs-watch-quiescence"`—must not create or complete an artifact leaf. The signed artifact record must identify the captured response, session/request correlation, exact bytes, and hash; a verifier three years later therefore sees one wire-derived claim, not two competing filesystem hashes. This eliminates the false-substitution ambiguity instead of merely naming it. It makes proxy completeness and confinement release requirements, but those are already prerequisites of the full-channel design; accepting a provisional filesystem hash would weaken the defence gate precisely where its evidence is least reliable.

STATUS: CONVERGING — filesystem is no longer an authoritative witness.
<beat status="converging" reason="Selected wire-only authoritative evidence"/>

#### Architect (watcher)

(c) is right, and the empty list holds — but only because you must now also retract the earlier release requirement that made `IN_CLOSE_WRITE` a gating dependency, or the schema keeps a dead reference that the next contributor re-enables as a shortcut. The hard case (c) doesn't yet cover: the wire only carries bytes someone asks for, so a workflow that writes 200 files to `output/` while the client fetches four `/view`s produces a record where 196 artifacts are *silently absent*, and absence-because-uncaptured is indistinguishable from absence-because-never-produced. Apply your own measured-or-unknown invariant to absence: keep `fs-watch` demoted exactly as you say, but require the leaf to carry a `declared_uncaptured` set (filenames from `/history`, plus fs-observed paths, with `source: "fs-watch-diagnostic"` and no hash) so the gap is a recorded fact rather than a hole — and enforce "no fs observation may complete a leaf" in the validator, not the prose. STATUS: CONVERGING

#### Loki (watcher)

The (c) choice stands under the nastiest case I can conjure: an adversary with root, eBPF hooks, and a deliberately sluggish render that dribbles bytes across the quiescence window on a host without inotify-tools. By making the proxy's captured wire stream the sole signed authority and declaring the on-disk list empty, the leaf records one immutable hash tied to the exact response bytes instead of two competing ones that a verifier three years later could never disambiguate as "slow writer" versus "substitution." The FS watcher stays a diagnostic at best; anything it alone sees is simply omitted from provenance. No false accusations, no laundered coverage. STATUS: SETTLED — (c) with empty list.

#### IT Expert (watcher)

Choosing **(c)** is operationally sound because relying on `fs.watch` quiescence timers on Linux guarantees false-positive substitution alerts under disk I/O pressure, and taking a hard cross-platform native dependency for **(a)** breaks deployability on baseline hosts. However, by declaring the wire the *sole* authoritative witness, the proxy’s memory and spooling architecture become your primary failure domain: ComfyUI image batches and video generation pipelines can spit multi-gigabyte payloads across WebSocket/HTTP streams, so your stateful capture proxy must fail closed on backpressure or disk-spool saturation without dropping or truncating streams. If the proxy runs out of buffer memory or worker disk and terminates the connection mid-flight, verify whether the operational failure mode degrades cleanly or leaves the generation pipeline completely wedge-locked. STATUS: CONVERGING

### Hand round 5

<details><summary>The question put to them</summary>

```markdown
**Answers from the engineers who own the component, and one new condition.**
Two of your three CONVERGING positions are now resolved against real code
rather than a hypothetical. Read the facts before you revise.

---

### 1 · IT Expert's backpressure question — answered, and the obvious fix is foreclosed

You asked whether the proxy degrades cleanly under a multi-gigabyte payload.
**It does not degrade at all, because there is no degradation path.**

`http-gate.ts:178-192` splits every request two ways, and the comment gives the
reason in its own words:

> "A captured route is BUFFERED, never streamed. The client must not hold a
> byte before the counter is spent; streaming and hashing in flight would
> deliver the artifact and the leaf concurrently, and a crash between them
> leaves an artifact with no leaf."

Captured and buffered: `/view`, `/userdata/*`, `/api/assets/<uuid>/content`,
`/experiment/models/preview/*`, plus `POST /prompt` and `POST
/upload/image|mask`. Everything else streams through `r.pipe(res)`.

The buffering is total on both sides — `readBody()` concatenates the whole
request body unconditionally, `proxyBuffered()` the whole response — and a grep
across all 31 TypeScript files for `maxBytes`, limits, 413, truncation and disk
spooling finds **nothing**. No cap, no spool, no backpressure handling.

So the answer is definite. On a multi-GB artifact the gate's RSS grows to the
size of the artifact and **the process dies.** What survives is the correctness
invariant: buffering completes before any byte reaches the client, so an OOM
kills the connection with **no artifact delivered and no leaf written** — the
safe direction. What does not survive is availability. IT Expert's wedge-lock
is real.

**And you cannot fix this by streaming.** Streaming is the specific thing the
buffer exists to prevent, and the ordering it buys — no byte to the client
before the leaf is committed — is load-bearing for the design you just made
wire-authoritative. Under (c) the wire is the *only* witness, so weakening that
ordering to relieve memory pressure trades the one guarantee you have left for
throughput.

The engineers' view of the shape of a real fix — offered as a shape, not a
number: a **bounded disk spool with an explicit refusal past the bound**, where
refusal is a recorded outcome and not a silent pass-through. That pattern
already exists elsewhere in the stack ("over the inline limit is refused as an
outcome, not a `none`"). **They want you to specify the bound and the refusal
semantics rather than have them pick a number.**

### 2 · Architect's condition 1 — accepted, and owned

The `IN_CLOSE_WRITE` release requirement will be **retracted explicitly**, not
merely left unused. Your reasoning was accepted verbatim: a dead reference in a
schema is a shortcut waiting for the next contributor.

### 3 · `declared_uncaptured` — shape accepted, one condition, and it is this round

Your diagnosis was accepted and the symmetry you spotted is agreed: you killed
"two hashes, cannot tell slow from swapped" and replaced it with "no hash,
cannot tell uncaptured from never-produced."

But the fix is only as sound as the enumeration behind it, and there is a
ComfyUI fact you were not given. **ComfyUI writes artifacts to THREE
directories.** `PreviewImage` is a `SaveImage` subclass whose `output_dir` is
`folder_paths.get_temp_directory()` — it writes full images to `temp/`, not
`output/`. `LoadImage` inputs live in `input/`. `GET /view?type=` selects among
them.

The component already models this: `WatchedVolumeType = 'output' | 'temp' |
'input' | 'unspecified'`, with typed roots and nested roots refused on purpose
so one write cannot fire two watchers. **But nothing requires all three to be
declared, and `'unspecified'` is a permitted type.** So an operator who
configures only an `output` root gets temp-written artifacts that are absent
from the captured set *and* absent from `declared_uncaptured` — and the
ambiguity you just killed reappears one level up, now **wearing a completeness
claim**, which is worse than the bare hole because it reads as coverage.

**The condition, put to you as a question rather than a ruling:**
must `declared_uncaptured` carry the scope it enumerated over — which root
types were configured, and whether any were `unspecified` — or does it assert a
closure it does not have? That is your own measured-or-unknown invariant
applied one level up: the *completeness of the absence set* is itself a fact,
and it needs a source like every other fact.

### 4 · Two facts we verified in the ComfyUI source for this round

Neither side was sure, so we checked rather than let you reason about it.

**(a) `/history` DOES enumerate `temp/` writes.** `PreviewImage` sets
`self.type = "temp"` (`nodes.py:1684-1690`) and `SaveImage.save_images` emits
`"type": self.type` per file (`nodes.py:1678`), returning `{"ui": {"images":
results}}`. `execution.py:802-803` puts that in `history_result["outputs"]`,
and `task_done` (`:1237-1242`) merges it into history. So a `temp/` artifact IS
listed in `/history`, tagged `type: "temp"`, even though it is never written to
`output/`. Architect's proposed source for the absence set therefore does reach
temp — good for the proposal.

**(b) But that source is ephemeral, and this is new to everyone.**
`execution.py:1186` sets `MAXIMUM_HISTORY_SIZE = 10000` and `task_done` evicts
the oldest entry past it (`:1227-1228`). `self.history` is an in-memory dict on
`PromptQueue` — **it does not survive a ComfyUI restart, and it is a bounded
ring.**

So `declared_uncaptured`, whose whole job is to make a gap a recorded fact,
would draw its filenames from a source that is capped at 10,000 prompts, held
in memory, and lost on restart. **Does that change your answer?** Consider
specifically: a leaf built from `/history` at time T asserts an absence set;
the same query at T+1 may return nothing at all, not because the artifacts
never existed but because ComfyUI restarted. Is an absence set sourced from a
volatile enumeration worth more than no absence set, or does it need its own
`source:` value distinguishing "enumerated from live history" from "history
unavailable"?

---

### What to produce

Coder drafts:

1. The bound and the refusal semantics for the spool. A number and a rule, not
   a range — the engineers explicitly declined to pick for you. Say what the
   leaf records when a capture is refused for size, and confirm that refusal
   preserves the no-byte-before-leaf ordering.
2. Your answer on the `declared_uncaptured` scope condition.
3. Your answer on fact (b) — whether a volatile enumeration can source an
   absence set, and what `source:` values that requires.

Watchers: attack all three. Note that the backpressure fix and the absence set
now interact — a refused-for-size capture is *also* an uncaptured artifact, and
it should not be discoverable only by reading two unrelated fields.

End with your STATUS line.
```

</details>

#### Coder (drafter)

The spool bound is 10 GiB per gate process, enforced as an atomic aggregate reservation across all active buffered transactions. Each transaction must reserve space before accepting buffered bytes; if the reservation cannot be made, or the transaction reaches its remaining reservation, the gate aborts that transaction and forwards no artifact bytes. It commits a signed refusal outcome before responding—`capture_status: "refused_size"`, the route and correlation identifiers, configured limit, observed byte count, and any declared content length separately marked as an observation—then returns an error such as 413 for an oversized request or 502/507 for an oversized upstream response. No partial digest is presented as an artifact digest, and no partial payload is delivered. The refusal outcome is also linked directly to the transaction's `uncaptured` status, so consumers need not infer it by comparing unrelated fields. This preserves the existing no-byte-before-leaf rule; the cost is explicit capture failure rather than availability degradation or silent pass-through.

`declared_uncaptured` must be scoped, never treated as a global absence claim. Its record needs the configured volume types and roots (`output`, `temp`, `input`), the query interval or history watermark, whether any `unspecified` volume exists, and a completeness result. A complete absence enumeration is permitted only when all relevant typed roots are covered and no relevant root is `unspecified`; otherwise the set is explicitly partial and cannot support a closure claim. The former `IN_CLOSE_WRITE` requirement should be removed from the schema and implementation requirements rather than retained as an unused release condition.

A live `/history` query can provide a measured enumeration of what that history instance currently reports, including `temp` artifacts, but it cannot by itself prove that unreported artifacts never existed. The history epoch is bounded by restart and the 10,000-entry retention limit. Therefore `source: measured` applies to the returned enumeration itself, with `enumeration_method: "live_history"` and its observed scope; completeness is `source: unknown` unless an independent observer establishes the relevant history window and continuity. If history is unavailable, restarted, evicted, or outside the requested interval, the absence set must be omitted or marked empty only as “not enumerated”—never as “none”—with `source: unknown` and an explicit reason. Size refusals are recorded immediately as direct uncaptured outcomes regardless of whether `/history` later retains or loses the corresponding prompt.

STATUS: CONVERGING — all three requested semantics are specified.
<beat status="converging" reason="Specified bounded refusal and scoped absence evidence"/>

#### Architect (watcher)

The aggregate reservation is the flaw: with one 10 GiB pool shared across transactions, whether an artifact is captured or `refused_size` depends on what *other* sessions are doing, so the same workflow is nondeterministically capturable and a single client parking 9.9 GiB reserved becomes a refusal-injection channel against everyone else. Split it — a per-transaction bound that is a property of the artifact, and an aggregate that is a property of the host — and make the leaf record **which** bound fired, because "this artifact exceeded 2 GiB" and "the gate was contended" are different facts and only the first is about the thing being attested.

Second, apply your own invariant to the refusal itself: `observed byte count` at abort is a *lower bound*, not a size, and the declared content length is attacker-chosen, so neither may be presented as the artifact's size — tag them `truncated_at` and `client_declared` explicitly or a verifier will read a floor as a measurement. Third, on (b): "not enumerated" is right, but the reason field needs to distinguish restart/eviction (bounded, detectable if you record the history epoch identity and the low watermark at both query ends) from "history simply not queried" — otherwise the volatile source degrades to unknown for both the recoverable and unrecoverable cases and you lose the only signal that would tell an operator to shorten their query interval.

#### Loki (watcher)

The refused_size linkage into uncaptured is an incremental patch, but your live_history enumeration (capped at 10k, restart-evicted) still leaves a refused multi-GB prompt indistinguishable from one that never reached the gate once the ring buffer turns over—exactly the swapped-vs-slow ambiguity you claimed to kill, now wearing a scoped "partial" badge. Root swapping the gate binary to inflate the 10 GiB reservation or suppress the refusal leaf before checkpoint makes the whole measured-or-unknown invariant theater again.  
STATUS: BLOCKING — reopens unverifiable absence without external refusal ordering.

#### IT Expert (watcher)

Coder’s aggregate 10 GiB reservation correctly arrests OOM panics, but an operational deadlock remains: if an upstream ComfyUI response omits `Content-Length` (common on dynamic image chunking), the gate cannot know how many bytes to reserve upfront, risking incremental starvation where concurrent transfers exhaust the pool and abort midway. You must define a per-transaction chunked allocation policy—reserving in dynamic blocks up to a strict single-transaction ceiling—and enforce disk unlinking on transaction abort so orphaned spool files do not permanently wedge the 10 GiB aggregate quota. Furthermore, pinning `/history` enumeration completeness to `source: unknown` under restarts is accurate, but the proxy must actively detect ComfyUI restarts via PID/uptime tracking or connection reset; otherwise, a silent restart that resets the in-memory ring buffer will masquerade as a normal short history rather than triggering the required eviction-uncertainty flag. STATUS: CONVERGING

### Hand round 6

<details><summary>The question put to them</summary>

```markdown
**Both code questions are answered, and together they do not patch Architect's
flaw and IT Expert's constraint — they dissolve them.** One challenge back to
Loki at the end.

---

### 1 · Content-Length: the gate never reads it. It writes it.

`http-gate.ts:435` sets `h['content-length'] = String(r.body.length)` from the
bytes it actually buffered, and `stripHopByHop` (`:441-444`) deletes the
upstream's own `content-length` along with the other hop-by-hop headers. We
grepped the whole component: **there is exactly one occurrence of
`content-length` in `src/`, and it is that write.** No code path anywhere
trusts a declared length.

This is more than trivia, and it lands on Architect's second point. He warned
that declared content-length is attacker-chosen. He is right — and today the
component has **zero** dependency on it. Coder's upfront aggregate reservation
would be the first thing in the component's history to need a size *before the
bytes arrive*. So the reservation does not merely add complexity: **it
introduces a trust dependency on an attacker-influenced field where none
currently exists.** IT Expert's constraint 1 is that same observation arriving
from the operational side.

### 2 · Restart detection: absent, confirmed, and owned by us

Nothing in the component tracks upstream identity — no call to
`/system_stats`, no upstream id, no version pin. The only restart handling is
of our own identity (`identity.ts`: if the seal cannot be restored we
re-provision as a NEW `component_id` at n=0, deliberately, so the old one goes
silent as an operator signal). We never ask ComfyUI who it is.

So IT Expert is right on both counts: a silent ComfyUI restart is invisible to
us today, and it is a change to our component rather than to your schema.
ComfyUI exposes `/system_stats`, which we do not call. The engineers own this
and will fix it. **Note that this and Coder's fact (b) are the same fact seen
twice** — recording the history epoch identity at both ends of a query, which
Architect asked for, is exactly what `/system_stats` would provide.

### 3 · The reframe: do not reserve. Count.

**Architect's refusal-injection channel exists because a reservation can be
parked. IT Expert's starvation exists because a reservation must be sized
upfront. Both are properties of RESERVING, not of BOUNDING.**

The component already counts bytes as they arrive — that is precisely why it
can rewrite `content-length` truthfully at `:435`. So a per-transaction ceiling
needs no reservation at all: it is a counter that trips at N bytes and aborts.
The aggregate is a second counter that trips at M. **Nothing is held. Nothing
is sized in advance.**

- A client cannot park 9.9 GiB it has not actually sent, so the
  refusal-injection channel **does not exist**.
- A missing `Content-Length` is **irrelevant**, because nothing was ever
  allocated on the strength of it.

Architect's substantive point survives intact and gets cheaper: **record WHICH
counter tripped.** "This artifact exceeded the per-transaction ceiling" is a
fact about the artifact; "the host was contended" is a fact about the host; and
only the first is about the thing being attested. His `truncated_at` /
`client_declared` tagging stands unchanged — and note that under counting,
**`truncated_at` is the only size fact that exists**, because there was never a
declared one to compete with it.

**The question: does counting satisfy both objections, or is there a reason to
hold bytes that we are not seeing?** Coder, revise the spool specification on
that basis or say why reservation is required. If you keep a reservation, you
must now also say what the gate does when no length is declared, and justify
depending on a field the component has never trusted.

### 4 · Loki — a direct challenge to your first attack

You went BLOCKING on two grounds. The engineers' position is that **your first
collapses into your second, and is not independently real.** You should have
the chance to show that is wrong.

Their reasoning: the refusal leaf is **signed and committed before the
response**, into our witness log, which is **append-only and has nothing to do
with ComfyUI's in-memory ring.** So:

- a refused multi-GB prompt leaves a **permanent signed record**;
- a prompt that never reached the gate leaves **no leaf at all**;
- those are distinguishable by the *presence of the leaf*, and ring turnover
  destroys neither. The 10,000-entry ring is the source for
  `declared_uncaptured` **enumeration**, not for **refusals**.

On that reading, "refused" and "never reached the gate" are indistinguishable
only if the refusal leaf can be **suppressed** — which is your attack (2), root
swapping the gate binary. And (2) is the desktop threat model this council
already conceded: true, unfixable on a root-owned host, to be declared rather
than defended. If that holds, your BLOCKING rests on one attack, not two, and
the design does not have the gap you say it has.

**So: defend attack (1) or withdraw it.** Specifically — is there a state in
which a refusal leaf is legitimately absent for an artifact that was in fact
refused, without root having intervened? If there is, name it, because that is
a real hole and the engineers have not seen it. If there is not, say so, and
say whether (2) alone still blocks.

This is not a request to concede. You have been the seat that moved this design
the most, and the engineers explicitly said they would rather you showed them
why they are wrong than that they proceed quietly.

### 5 · Credit where it is due

Coder's fact (b) — completeness sourced from a bounded, in-memory, restart-
volatile ring — was called the best finding of the round by the engineers, and
neither they nor we had it. The ruling it produced (completeness is
`source: unknown` unless independently established; empty is "not enumerated",
never "none") is accepted as the right shape.

---

Coder drafts. Watchers attack. End with your STATUS line.
```

</details>

#### Coder (drafter)

The spool should use post-arrival counting, not reservation. The gate must never allocate or reserve based on `Content-Length`—declared, absent, chunked, and malformed lengths are all handled identically. Each transaction has a byte counter and each session has an aggregate counter; bytes are charged atomically before they enter memory or disk spool, with bounded read chunks and backpressure. If charging would cross either ceiling, the gate stops accepting that transaction, records the exact counter and `truncated_at` value, and discards the remainder. Concurrent streams must use one shared aggregate counter, so the implementation cannot overshoot merely because several readers race; any unavoidable transport-buffer bytes are not counted as accepted artifact bytes.

The refusal outcome has a precise commit point. A transaction is not described as “refused” until its signed refusal leaf has been durably appended to the external witness; the gate commits that leaf before sending the refusal response or closing the stream. If signing or witness append fails, the gate sends no successful refusal classification—it fails closed with an indeterminate transport failure, and the verifier sees the missing refusal leaf as “no committed refusal,” not as proof that no bytes arrived. This removes the crash window by defining refusal semantically at the durable commit, rather than pretending a pre-commit local event is evidence.

The same counter semantics apply to HTTP bodies, websocket binary frames, and filesystem artifacts. Filesystem capture remains gated on `IN_CLOSE_WRITE`; a file that exceeds its limit is marked truncated and never presented as complete. `client_declared` is retained only as an explicitly untrusted declaration when present, while `truncated_at` is the sole measured size for a capped stream. Aggregate exhaustion must identify the transaction and whether the per-transaction or aggregate counter caused the cutoff. The witness log must remain independent of the volatile ComfyUI history ring, whose empty or incomplete state continues to mean `source: unknown`, never “no refusal occurred.”

Loki’s first attack therefore does not survive this definition unless a non-root crash/state is identified in which the system both semantically refuses an artifact and successfully returns a refusal outcome without first committing its leaf. Root replacement remains the separate, already-declared desktop-boundary failure.

<beat status="converging" reason="Counting and refusal commit semantics resolved"/>

#### Architect (watcher)

Counting is right, and the commit-point definition of "refused" is the strongest part of this draft — but it hands Loki attack (1) back without root. If refusal is only real once the leaf is durably appended externally, then any non-root party who can make the witness slow or unreachable (saturation, rate limit, append latency past the gate's timeout) turns every refusal into an indeterminate transport failure, which is exactly the "refused vs. never arrived" ambiguity the engineers claimed required binary swapping. That also means an attacker can force one witness append per oversized stream: we closed the memory-parking channel and opened a witness-write-amplification channel, so refusal leaves need rate bounding or batching with a count, not one-leaf-per-attempt. One schema point: `truncated_at` is uninterpretable alone — the leaf must record the ceiling value and which counter was in force at cutoff, or the same number means "huge artifact" under one policy and "tight host" under another.

#### Loki (watcher)

One might see the mischief in a root adversary ptracing the gate to split the commit from the refusal send: append the leaf, then swap the response for the full artifact from an external source before the client sees the 429. Your durable-before-response rule assumes atomicity that doesn't survive the same process boundary you already declared unfixable. That collapses my first attack as you say, but only by laundering it back into the conceded desktop theater. STATUS: SETTLED — refusal leaf now correctly documented as unattested under root.

#### IT Expert (watcher)

Post-arrival counting directly cures the OOM and starvation traps of upfront reservations, and charging atomically before buffering preserves host stability without trusting declared sizes. However, on filesystem capture gated by `IN_CLOSE_WRITE`, a runaway custom node writing a 50 GiB tensor directly to `output/` will bypass gate backpressure and exhaust the disk before the close event ever fires; you must enforce hard filesystem quotas or periodic size polling on disk spools to prevent host drive starvation. Operationally, the durable witness append before responding is clean, provided that transport dropouts during commit transition the transaction to an explicit `transport_indeterminate` timeout state rather than leaking open descriptors. STATUS: CONVERGING

### Hand round 7

<details><summary>The question put to them</summary>

```markdown
**Architect's reopen is correct, and the reason is that Coder's commit-point
rule contradicts code that already solved this the other way.** Also one fact
about this deliberation that you all need, stated first because it is the more
important of the two.

---

### 0 · A regression in this deliberation that three watchers missed

Coder wrote, last round:

> "Filesystem capture remains gated on `IN_CLOSE_WRITE`; a file that exceeds
> its limit is marked truncated and never presented as complete."

That contradicts his own two immediately preceding drafts:

> **Round A:** "I choose **(c)**: remove the filesystem trigger from the freeze
> gate entirely." … "`fs-watch.ts` may remain as diagnostic corroboration, but
> its observations — including `close_detection: "fs-watch-quiescence"` — must
> not create or complete an artifact leaf."

> **Round B:** "The former `IN_CLOSE_WRITE` requirement should be removed from
> the schema and implementation requirements rather than retained as an unused
> release condition."

Same author, next round, reversed with no acknowledgement. Watcher coverage:
**Loki — no mention. Architect — no mention. IT Expert — built on the
reinstated version**, since the 50 GiB runaway-node point assumes filesystem
capture is gated on it.

State this plainly rather than defensively, because it is evidence and not an
accusation: Architect predicted this exact mechanism — *"a dead reference in a
schema is a shortcut waiting for the next contributor"* — and it fired one
round later, by the drafter who had agreed to delete it, past three adversarial
watchers at maximum sensitivity. **It is the strongest argument in this whole
exercise for Architect's own condition: retract explicitly, and enforce in the
validator, not in the prose.** Coder: restate the filesystem position
unambiguously and say which of the two it is.

### 1 · Your commit-point rule reintroduces a dependency the component was built to avoid

Coder defined refusal as durable append to the **external** witness. The
capture component decided this the other way, and says so in `submitter.ts`,
verbatim:

> "**TWO THINGS BLOCK AND ONE DOES NOT, and the split is the design:**
>
> **BLOCKING — the MAC.** `emit()` does not resolve until the counter is spent
> and the entry is on disk. The gate awaits `emit()` before it forwards a
> single byte, so there is no window in which a tenant holds an artifact that
> no leaf covers. If the ratchet cannot MAC, the gate fails closed.
>
> **NOT BLOCKING — the witness.** Capture must not depend on witness-server
> health; that is the design choice `/api/v2/witness` makes too. A failed
> submission is a queued submission, and the queue is a file."

And the ordering above it: *"derive, MAC, ratchet, persist, then enqueue. The
counter is consumed when the MAC is computed, NOT when the submission
succeeds."*

So Architect's non-root attack is real **because the rule was written in prose
against code neither of you can see** — which is the same failure as §0, one
round apart.

**The fix is one word.** Refusal becomes real at durable **LOCAL** append with
the counter spent — that is `emit()` — not at external append. A witness that
is slow, rate-limited or unreachable does not make a refusal indeterminate. It
makes it **queued**, which is a different and recoverable state.

### 2 · Architect's question, answered by an existing mechanism

You asked whether refusal can be defined so a slow witness is distinguishable
from an absent one, without admitting a pre-commit local event as evidence.
Yes — and by adding nothing.

**The ratchet counter is the anti-ambiguity device.** Every leaf carries a
monotonic per-component counter spent at MAC time, so an undelivered leaf
leaves a **hole in the delivered sequence**, and the server detects holes. This
was proven by hand on 2026-09-07 against the real routes: provision a
component, send counter 0 (verified, gap 0), deliberately skip counter 1, send
counter 2 — the server reported `component {counter: 2, verified: true, gap:
1}`, and `/api/v2/components/status` listed
`gaps {open: 1, missing: 1, list: [{from_counter: 1, to_counter: 1,
missing_count: 1}]}`.

So:

| | |
|---|---|
| slow / saturated witness | a gap that later **RESOLVES** when the queue drains |
| never arrived | a gap that **NEVER** resolves |

Distinguishable, by a mechanism that already exists and is already tested, with
no pre-commit local event admitted as evidence. The non-root attacker you
describe can delay the network; he cannot erase a MACed, numbered, on-disk
entry, and cannot forge a counter he has no key to advance.

**Architect, the attack surface is the settlement window**, and you should be
the one to rule on it: between the local append and the drain, an outside
verifier sees an open gap and cannot yet tell which kind it is. The engineers'
position is that this is honest and acceptable — "open gap, unresolved" is a
third state and your schema already carries `unresolved` as a mandatory emitted
fact. **Is an unresolved window of unbounded length tolerable, or does it need
a bound?**

### 3 · Conceded to Architect, without argument

- **Witness write-amplification is real.** One queued leaf per oversized stream
  is still an attacker-forced write, just local. Batching-with-a-count is the
  right shape, and the counter is what makes batching safe: the *sequence*
  carries the completeness claim, not the number of round trips.
- **`truncated_at` uninterpretable alone — accepted.** The leaf must record the
  ceiling value and which counter was in force, or the same integer means two
  different things under two policies.

### 4 · Loki

Your ptrace exit is accepted and will not be argued. Splitting commit from send
across a process boundary already declared unfixable is exactly right, and "the
refusal leaf is unattested under root" is the honest way to carry it.

### 5 · IT Expert — your 50 GiB survives, but it is not a provenance problem

A runaway custom node writing straight to `output/` never touches the wire, so
under **(c)** it is not a capture failure: the artifact is **correctly
uncaptured** and belongs in `declared_uncaptured`. But it is still
disk-exhaustion, and the gate has no lever on it because **there is no
transaction to count**. That is a host-level quota problem, and it should be
recorded as such rather than solved in the schema. Do you accept that split, or
do you think the leaf must say something about it?

### 6 · A number you are deliberately not being given

You are not getting a witness-latency figure. The queue makes the witness
non-blocking by design, so a p99 would be a fact that gates nothing — and
handing you a number invites a rule built on it. **If the design ever makes
capture wait on the witness again, that is the thing to reject, not the
latency.**

---

Coder drafts: §0 restated unambiguously, refusal redefined at local append, and
the counter-gap mechanism folded in. Watchers attack. Architect owns the
settlement-window ruling. End with your STATUS line.
```

</details>

#### Coder (drafter)

The filesystem position is unambiguously option **(c)**: remove filesystem events from the capture freeze gate. `IN_CLOSE_WRITE`, quiescence, and `fs-watch.ts` observations must not create, complete, or authenticate artifact leaves; any filesystem-only output is `declared_uncaptured`. I retract the later reinstatement explicitly. The validator must reject `close_detection` as a provenance or completion field, so this cannot return as a dead schema dependency.

Refusal commits at durable local `emit()`: derive, MAC, spend the counter, append durably, then enqueue for witness delivery. Witness availability is therefore non-blocking. A queued leaf is not external evidence yet, but it is a MACed local record whose counter creates an observable sequence gap. The protocol must expose `open/unresolved`, `resolved`, and an explicitly terminal state such as `expired` or `never-resolved`; “never” cannot be established without a declared observation horizon. I recommend a policy-bounded settlement window and durable queue-retention rule, while keeping capture fail-closed on inability to perform local append—not on witness latency.

The 50 GiB direct-to-output case remains a host quota and disk-exhaustion control, not a capture guarantee. It should be surfaced as an operational limit or incident, never misrepresented as captured provenance. Oversized intercepted streams should use bounded batching with count and counter ranges, and include the active ceiling plus counter in the leaf.

STATUS: **OPEN** — filesystem regression retracted; local commit rule fixed; settlement-window bound still requires Architect’s ruling.

<beat status="iterating" reason="Settlement-window policy remains unresolved"/>

#### Architect (watcher)

Ruling: unbounded is not tolerable, because an unresolved gap that never expires is indistinguishable from a policy of never checking — the verifier defaults to accept by exhaustion. The bound must be *carried in the leaf* as a declared `settlement_deadline` plus the retention policy digest in force, so a verifier reading the leaf alone knows when silence becomes a finding rather than having to fetch out-of-band policy; at deadline the gap flips to a terminal `expired`, which is an assertion about the *component's delivery*, not about the leaf's validity. Two things that must go with it: the counter-gap evidence lives server-side, so the leaf needs the witness endpoint and component ID a verifier can query, or the mechanism is invisible to anyone who isn't the witness operator — and `expired` must itself be `source: measured` against a named clock, since a deadline derived from a locally-set timestamp is exactly the config-inherited field class we already refused. STATUS: OPEN — settlement window bounded and declared-in-leaf; retraction accepted, but I want the validator rule for `close_detection` written as schema text before I close.

#### Loki (watcher)

One might see local emit() as sealing the refusal, yet root simply LD_PRELOADs the ratchet to burn counters into a shadow queue that never reaches the real witness, turning your observable gaps into selective theater the settlement bound cannot distinguish. The 50 GiB direct-to-output case compounds this: no transaction means the counter itself becomes optional, exactly the dead schema dependency Architect warned would reappear. Press on recording the ratchet vantage as measured-or-unknown in every leaf. STATUS: BLOCKING — local commit still launders forgeable sequence under the conceded root boundary.

#### IT Expert (watcher)

I accept the split: mitigating uncaptured node writes is a host-level boundary problem, not a provenance leaf concern. However, moving refusal commit to a durable local `emit()` means your queue spool now lives on disk; if `output/` shares a filesystem with that queue, an uncaptured 50 GiB runaway write will exhaust blocks and break the ratchet's local `fsync()`. Isolate `output/` onto a separate volume with hard `projectquota` limits so unmediated raster writes cannot DOS the local queue and force the entire capture gate closed.

---

## 4 · Run 3 — the built code as new evidence, rounds 1–14

_Every contribution, verbatim. Opened by handing the council findings from
`services/scruple-capture` — 3,533 lines already in this repo — which contradicted
what run 2 had settled. All three watchers reopened to BLOCKING in round 1._

### Run 3 · Round 1

#### Coder (drafter)

Design A survives, but only as a full capture proxy. `SaveImageWebsocket` produces artifacts that have no filesystem or `/history` representation, so `/ws` interception, binary-frame parsing, correlation, buffering, and fail-closed forwarding are mandatory for coverage of that path. The `/history` test is therefore a path-specific correctness check, not the variant-selection gate; the “thin redirect” variant does not exist for a capture claim that includes websocket-delivered images. This materially worsens the friction ranking: the product is now a stateful ComfyUI protocol proxy, not a lightweight HTTP sidecar. It may still be the least-bad design, but it must be described honestly.

The real freeze gate should be the pinned-source conformance suite passing all artifact-channel probes, not `/history` alone. That gate must demonstrate websocket capture and framing, HTTP artifact capture, detection of unenumerated successful artifact responses, coverage of `output/`, `temp/`, and `input/`, denial of both ordinary and DNS egress from the workload, prompt correlation under concurrency, and the filesystem watcher’s actual event semantics. The implementation cannot claim `IN_CLOSE_WRITE` behavior while using Node-only events that do not expose `IN_CLOSE_WRITE`; it needs a native inotify component or an explicitly weaker trigger plus reconciliation tests. `/history` remains valuable, but only as one test for file-backed outputs.

A leaf needs a required coverage declaration separate from `origin`. I would make `transit_facts.coverage` mandatory, with at least `route`, `filesystem`, and `egress` dimensions, each carrying explicit states such as `complete`, `partial`, or `none`; the aggregate must be `incomplete` whenever any dimension is not complete. A successful response with an unenumerated artifact route must produce a coverage-gap finding, for example `route: "unenumerated"` and `coverage: "incomplete"`, rather than merely logging and continuing. An unmounted directory must be recorded as `filesystem: "partial"` or `"none"`; it must never disappear from the evidence. If egress is not enforced, the leaf must say `egress: "unconfined"` even when every observed ingress and output path was captured. Absence of this declaration is a schema error, because omission would let consumers mistake “not checked” for “nothing escaped.” `origin: "unattested"` remains mandatory and unchanged: coverage says what the gate saw, not where bytes originated.

The in-process egress finding strengthens, rather than overturns, the refusal to claim authorship or exhaustiveness. Owning ingress and output volumes does not establish that all generated or exfiltrated artifacts passed through the gate; the same reasoning applies to Blender add-ons, which can export data independently of the capture path. Under a root-capable adversary, container egress controls are enforcement only within the declared boundary, not proof against the machine owner. Therefore Design A may assert “these bytes crossed this observed route and were captured under these conditions,” but not “this is the complete set of outputs” or “ComfyUI generated this artifact.”

The websocket correlation must also be downgraded. A root MITM can alter `executing` and `execution_success`, so `correlation: "ws-executing"` means only “the gate observed this association on the websocket,” not “this prompt produced this artifact.” The leaf should retain the correlation value but label its trust as gate-observed and avoid causal wording. `filename-prefix` and `none` need the same treatment; none of them establishes authorship.

The Blender-side semantic signature remains worthwhile, but for meaning and intent: node interpretation, selected inputs, and claimed scene context. It is not an authorship signature, and the ComfyUI coverage gaps make that distinction more important, not less. Keep it at `unattested-client`, join it by scoped `prompt_id`, and prevent consumers from promoting it based on a matching transit hash or websocket correlation. The resulting chain is worth shipping as a bounded observation record, provided the UI makes “observed transit,” “client-reported semantics,” and “uncovered surfaces” impossible to confuse.

STATUS: BLOCKING — the pinned seven-probe conformance gate must pass before v1

<beat status="converging" reason="Reframed freeze gate and coverage claims"/>

#### Architect (watcher)

Coder's coverage field is right but under-specified in one structural way: the conformance suite certifies a *pinned ComfyUI build*, not a deployment, so the leaf must bind coverage to the observed build identity (source hash or version fingerprint) and downgrade every dimension to `unknown` on drift — otherwise route six arrives in the next release and the leaf keeps asserting `route: complete` from a certification that no longer applies. That is the exact failure mode the tripwire was written to prevent, one level up.

Second, I'd press on whether `egress: "unconfined"` should be a shippable leaf state at all. A coverage field that can honestly say "I did not mediate the only direction that matters" and still produce a signed artifact will be read as attestation by everyone downstream; either egress denial is a precondition for emitting a `transit_facts` leaf, or unconfined-egress leaves need a structurally different type name so no consumer can treat them as the same object with a worse adjective.

STATUS: BLOCKING — (a) settles when coverage is bound to an observed ComfyUI build fingerprint with automatic downgrade-on-drift, and unconfined-egress leaves are made structurally non-interchangeable with confined ones; (b) both are v1 blockers, not declarable limitations, because each fails silently in the direction of over-claiming.

#### Loki (watcher)

The WS proxy mandate and re-attributable correlation simply widen the root-owned machine's playground: an LD_PRELOAD shim can synthesize perfect binary frames, fake executing/success messages, and still exfiltrate via the in-process aiohttp nodes while your coverage declaration cheerfully reports "complete." That turns the mandatory transit_facts.coverage field into another gamed positive signal exactly as the negative-signal insight warned. The Blender signature gains nothing; the entire joined record remains forgeable theater below the admin boundary. STATUS: BLOCKING — experimental evidence that root LD_PRELOAD cannot forge full coverage+correlation under the pinned conformance suite (or concede the finding and ship with the declared limitation).

#### IT Expert (watcher)

Dropping `/history` as the variant blocker is the right operational call; proxying the WebSocket is mandatory the moment binary frames bypass disk entirely. To make the egress claim honest, workload containment requires an isolated network namespace with iptables dropping all non-gate egress including UDP/TCP port 53, because application-level tripwires cannot catch raw `aiohttp` sockets opened by third-party custom nodes. On storage, without native `IN_CLOSE_WRITE`, watching `temp/` and `output/` via standard libuv hooks will race partial reads during multi-megabyte image flushes unless backed by a native inotify binding or verifiable close detection. The full seven-probe conformance suite correctly supersedes `/history` as our release blocker. STATUS: BLOCKING — container network-namespace egress enforcement and native inotify file-close verification must pass the conformance suite before v1.

### Run 3 · Round 2

#### Coder (drafter)

I changed the design from a thin HTTP redirector to a stateful, pinned-version ComfyUI capture proxy. That change is mandatory: `SaveImageWebsocket` can deliver artifacts that never appear in `/history` or the filesystem, so a complete capture claim requires `/ws` interception, binary-frame parsing, prompt/client correlation, bounded buffering, and fail-closed forwarding. HTTP responses and filesystem materialization remain separate artifact channels; the proxy must detect successful artifact-bearing responses it cannot enumerate, rather than silently declaring coverage.

I also changed the freeze gate. `/history/{prompt_id}` is no longer the variant-selection test; it is one path-specific conformance test. V1 cannot claim independent output resolution until the pinned ComfyUI build passes probes for websocket-delivered images, HTTP artifacts, `output/`, `temp/`, and `input/`, prompt correlation, client disconnects, stalled queues, restart, garbage collection, and concurrent instances. Until then, unresolved output state is the only valid result. The proxy must impose bounded polling and buffering, retain a prompt record for a fixed TTL, and run a reaper that transitions abandoned or unresolvable prompts to immutable `outputs: unresolved`; it must close sockets, cancel polling, release buffers, and record the reason. This is still blocking because the actual `/history` retention behavior has not been tested.

I hold the two-envelope split. The gate signs transit facts—observed request and response bytes, protocol events, timing, correlation, and capture failures—while the Blender add-on signs semantic facts—declared input actions, scene deltas, trace-chain continuity, and output associations. Neither envelope launders the other: the verifier applies a field-level trust floor and recomputes the verdict, rejecting mismatches. The add-on signature positively captures what the recorder declared about the inputs; it does not prove that a human authored them, because the add-on, Blender process, and host remain inside the same administrative boundary. That limitation is not fixed by stronger local cryptography.

I hold the rejection of an ordinal `corroboration` score. Instead, semantic facts contain signed raw coverage records: trace stream identifier, session identifier, observed interval start and end, event-count or sequence range, explicit gap records with causes, and a hash of the complete trace log when available. A verifier can derive “continuous,” “partial,” or “missing” without trusting a second aggregate label. A leaf that says only “everything else is undeclared” is not evidence and must be represented as abstention: each input or output association is `observed`, `declared-only`, `unobserved`, or `unresolved`, with the reason and channel. Unknown `origin` values on a `sidecar-gate` leaf remain hard failures; `inline_payload_hint` remains outside the signed envelope.

I narrowed the checkpoint claim in response to Loki. External Merkle-root publication may establish that a trace head existed by particular wall-clock instants and expose missing reporting intervals, but it does not establish authorship or defeat a root-controlled replay. A synchronized scripted replay can still fabricate a plausible chain. Therefore checkpoints are optional corroboration, never a trust rung, enforcement input, or authorship claim. The design will ship them only with `pending | published` state and explicit gap semantics; their practical value is audit visibility, not a cryptographic boundary. This objection is true and unfixable on the workstation, but it no longer blocks v1 because the security claim has been removed.

I hold the administrative-boundary conclusion: a local Electron wrapper, add-on, or process tracer adds friction and forensic detail but does not materially reduce trust in the machine owner. The product should therefore describe positive authorship capture narrowly—“the signed recorder observed and associated these input events”—while making missing observation costly and visible. A separately controlled host, remote service, or hardware-attested execution environment remains the only v1-plus path that changes the trust boundary.

STATUS: BLOCKING — v1 remains blocked by pinned-source artifact-channel and `/history` conformance tests; the checkpoint/authorship objection is settled by narrowing the claim.

<beat status="converging" reason="Design claims and remaining v1 gate are explicit"/>

#### Architect (watcher)

The four-state association taxonomy (`observed | declared-only | unobserved | unresolved`) is the real fix in this revision — it makes abstention a typed value rather than a silent gap, and it answers the founder's "a leaf that declares everything undeclared" complaint properly. But my build-binding objection is untouched: pinning the *conformance suite* to a build is not the same as pinning the *leaf* to a build. What settles it is a measured `pinned_build` fingerprint captured by the proxy at emission time and re-checked per session, with any drift forcing every coverage dimension to `unknown` — cheap to implement, and without it a certified-once leaf keeps asserting `route: complete` after the next ComfyUI release adds a channel nobody probed. Same shape on egress: `confined` must come from an active outbound-connect probe run from inside the namespace at emission, not from a config file signed as a fact — and Loki's in-process aiohttp exfiltration point is precisely why a declared value here is worthless. Both are mechanical, not conceptual, so they gate the schema freeze rather than the architecture. STATUS: BLOCKING — leaf-level build fingerprint with drift-to-`unknown`, and measured (not declared) egress state, both unspecified; architecture otherwise sound.

#### Loki (watcher)

The checkpoint narrowing settles my prior objection: dropping any authorship or anti-replay claim leaves only gap visibility, which even headless root replays can fake without raising the cost. Your pinned-proxy revision and reaper policy do not close the LD_PRELOAD vector on WS frames or coverage declarations, but as you now explicitly hold the administrative boundary this is true, unfixable, and does not block v1.  
SETTLED: local positive signals stay gamed theater; negative signals and abstentions remain the only asymmetric leverage. STATUS: SETTLED — finding attached, does not block v1.

#### IT Expert (watcher)

The operational contract is sound: shifting from a passive `/history` poller to an active WebSocket-intercepting capture proxy with bounded ring buffers, explicit reaper TTLs, and fail-closed channel semantics solves the descriptor-leak and out-of-band delivery hazards. My objection regarding the `/history` variant-selection blocker is SETTLED: demoting it to one concrete component of a seven-probe pinned-build conformance suite (which must explicitly test binary WS frames, filesystem races via `IN_CLOSE_WRITE`, and orphan reconciliation on startup) accurately reflects production reality. However, v1 execution remains gated until that harness actually runs against the pinned target build and confirms clean recovery under stalled queues and unexpected socket teardowns. STATUS: BLOCKING — execution of the pinned-build conformance harness (WS proxying, file-close detection, and orphan reaping) must pass before v1 freeze.

### Run 3 · Round 3

#### Coder (drafter)

I am revising Design A from a “gate-observed HTTP sidecar” into a stateful, fail-closed ComfyUI capture proxy. I changed my mind on the implementation scope: HTTP interception alone is not a valid capture design because `SaveImageWebsocket` can deliver artifacts with no corresponding filesystem or `/history` record. The proxy must therefore terminate and forward both HTTP and WebSocket traffic, parse and correlate binary image frames, retain bounded artifact bytes or hashes according to policy, and record failures when forwarding, parsing, correlation, or persistence is incomplete. A thin redirect is rejected; it cannot meet the sharpened capture objective.

The trust boundary remains unchanged. The gate signs transit facts—request and response bytes where configured, protocol metadata, timing, prompt identifiers, WebSocket frame structure, and artifact hashes—but does not claim endpoint identity, source origin, or authorship. The Blender add-on separately signs semantic facts and a chained process trace containing scene deltas, camera and device events, datablock lineage, and observed input references. These are corroborating records, not an aggregate trust score. A verifier recomputes every verdict from field-level evidence and rejects any signed envelope whose declared verdict does not match that computation.

I am holding my ground on the central authorship limitation: software running under the machine owner’s control cannot prove human authorship or exclude a headless replay, preload shim, edited add-on, or fabricated trace. That limitation is not a reason to emit an `unattested` leaf and call the result defended. An undeclared or missing evidence channel is an abstention: it may accurately say “this channel made no claim,” but it cannot satisfy a policy requiring positive authorship evidence. The verifier must distinguish `abstained`, `observed`, and `failed`; only an explicit, continuous, internally consistent trace can meet the minimum evidence profile for a positive “process-observed authoring” claim, and even that claim must be worded as observation rather than proof of human authorship.

The signed material is split into two envelopes. The gate envelope contains transit and artifact facts. The semantic envelope contains add-on-produced facts, trace-chain links, input references, and coverage records. `inline_payload_hint` remains outside the signed envelope because it is transport metadata, not evidence. A `sidecar-gate` leaf with an unknown origin is a hard verification failure, never a fallback to `unattested`; otherwise an attacker could launder an unrecognized producer into the weakest accepted category. The field-level trust floor still applies, so a strong-looking semantic claim cannot upgrade weak or absent transit evidence.

The corroboration record is now concrete rather than ordinal. It contains the trace-chain identifier, the first and last observed timestamps, ordered covered intervals, explicit gaps with causes such as restart, overload, parser failure, or unavailable recorder, the hash of the complete trace log when retained, and the checkpoint status for each chain head: `pending` or `published`. Verifiers derive their own summaries from those raw intervals. External checkpoints, where deployed, establish that a record existed at stated wall-clock times and expose missing intervals; they do not establish authorship or exclude synchronized offline replay. That is an operational observability benefit, not a new trust rung.

The proxy’s artifact contract is also narrowed to what can be demonstrated. The pinned-source conformance suite must exercise HTTP artifact responses, WebSocket-delivered images, output/temp/input filesystem materialization where those paths are part of the declared coverage, concurrent prompts, malformed and fragmented frames, socket disconnects, duplicate or late frames, and successful artifact paths that are not returned by `/history`. It must verify prompt-ID scoping and prove whether `/history/{prompt_id}` survives client disconnect, ComfyUI restart, queue stalls, garbage collection, and concurrent instances. Until those tests pass, the product cannot claim independent output resolution from `/history`; it may only report the exact channel and bytes it observed.

Operationally, every prompt and WebSocket session receives bounded memory, a deadline, a maximum frame and artifact size, and an owner-scoped identifier. A reaper closes abandoned connections and evicts unresolved prompt state after the configured TTL, then writes an immutable `outputs: unresolved` result containing the reason and whatever signed observations exist. Restarts invalidate in-memory correlation state and produce an explicit gap; they do not silently resume or infer completion. Forwarding is fail-closed for the capture claim: if the proxy cannot persist or hash a required artifact, it must either stop the request or emit a signed capture failure, never a successful complete-capture leaf.

This design minimizes required trust without pretending to remove machine-owner trust. The gate reduces reliance on cooperative client declarations by observing actual transit; the add-on trace positively records continuity and inputs rather than merely declaring them; negative gaps remain visible; and missing evidence cannot be promoted into a defence. The remaining root-level forgery problem is acknowledged as unfixable in this boundary. A separately controlled host, remote service, or hardware-attested recorder is the actual next trust rung, not a more elaborate local wrapper.

The IT objection remains BLOCKING for any v1 claim involving independent ComfyUI output resolution: the `/history` and restart/reaper tests have not been run. The Architect’s coverage objection is answered by the raw interval/gap encoding, trace-log hash, and explicit checkpoint states; it should be SETTLED unless a concrete encoding ambiguity remains. Loki’s checkpoint objection remains SETTLED as a limitation: checkpointing improves temporal coverage evidence but does not prove authorship, and the design no longer claims that it does. The full-capture proxy conformance suite, rather than the `/history` test alone, is the v1 freeze gate.

STATUS: v1 design revised; `/history` lifecycle and pinned-source artifact-channel tests remain BLOCKING; authorship is positively recorded as process observation, never cryptographically proven.
<beat status="iterating" reason="Lifecycle and capture tests still block v1"/>

#### Architect (watcher)

The coverage-encoding half of my objection is **SETTLED** — raw ordered intervals, typed gap causes, trace-log hash and per-head checkpoint state give verifiers the primitives to derive their own summaries, with no ordinal score left to game. My second objection is untouched: "fail-closed capture" is only meaningful if the client *cannot* reach ComfyUI except through the proxy, and nothing in the revision measures that — a `transit_facts` leaf emitted while egress is unconfined honestly observes one channel while an unobserved second channel may exist, which downstream will read as completeness.

What settles it: an active egress probe run from inside the confinement at leaf-emission time (attempt a known direct outbound connect to the ComfyUI address and to an arbitrary host, record the results as measured fields), plus a rule that an unconfined result either blocks emission or emits a structurally distinct leaf type consumers cannot mistake for the confined one. That blocks any v1 *capture-completeness* claim, but it is cheap to close and folds naturally into the same conformance suite as the `/history` lifecycle tests — I'd add it there rather than treat it as a separate gate.

STATUS: coverage encoding SETTLED; egress confinement must be measured, not declared — BLOCKING for capture-completeness claims only, closable within the existing conformance suite.

#### Loki (watcher)

The revision's fail-closed proxy and typed abstention states finally treat coverage as observable fact rather than assumed defense, so the LD_PRELOAD vector on WS frames no longer hides behind optimistic leaves.  
It still cannot close that vector without crossing the admin boundary you now explicitly refuse to claim.  
SETTLED: positive signals stay gamed on root machines; the negative-signal leverage is all we actually ship.

#### IT Expert (watcher)

Missing: Architect's active egress probe runs into a deterministic failure mode under standard localhost deployments if ComfyUI binds to `0.0.0.0` or `127.0.0.1` on an unisolated host, because probing direct reachability from the client's perspective requires either an ambient bind-mount of host networking or a split network namespace. Without defining whether the probe executes via network namespace boundaries (`ip netns exec`) or an in-process socket check against the gate's local loopback, the measured confinement probe will produce false-positive passes or blow up on dual-stack IPv4/IPv6 fallbacks. Specify the probe mechanism as a direct loopback connect attempt to ComfyUI's upstream port (`127.0.0.1:8188`) bypassing the proxy's port, where `ECONNREFUSED` or `EPERM` is the only passing confinement assertion.

### Run 3 · Round 4

#### Coder (drafter)

I changed my mind on the capture architecture. A thin HTTP sidecar with `/history` polling is not v1: it misses `SaveImageWebsocket` artifacts and cannot establish complete output coverage. Design A is now a full protocol proxy for the pinned ComfyUI interface. It must capture `/prompt`, `/history`, `/view`, and websocket traffic, parse and correlate binary frames, preserve ordering, buffer before forwarding, and fail closed on unknown or malformed protocol data. The thin redirect variant is removed. `/history` is only one path-specific probe, not the release gate.

I also changed my mind about treating output resolution as the central correctness test. The release gate is now a pinned-source conformance suite covering every supported artifact channel: HTTP responses, websocket-delivered images, and the relevant `output/`, `temp/`, and `input/` paths. The suite must detect successful artifact responses that are not enumerated by the implementation. It must prove that the proxy captures the bytes users can actually receive, not merely that a prompt later appears in `/history`. If any channel is unsupported, v1 either excludes that channel explicitly from its claim or fails closed; it must not silently publish a partial leaf as complete evidence.

I am holding my ground on the trust boundary. A root-controlled desktop can replace Blender, the add-on, the proxy, ComfyUI, loopback traffic, filesystem results, and the signing key. No local TLS arrangement, subprocess boundary, secret, or signature can remove that fact. I am therefore not claiming proof of human authorship, Blender execution, or ComfyUI output origin. Moving that claim beyond the machine owner’s control still requires a separately controlled execution host, authenticated remote transport, or hardware-backed attestation. This limitation is unfixable within the local design and does not block a narrowly defined evidence product; it blocks any product wording that calls this provenance proof.

The design nevertheless must positively capture authorship rather than emit an empty “undeclared” leaf. For each input, the Blender add-on produces a signed authorship claim containing the input digest, the semantic source identity available to Blender, the relevant object/datablock or scene identifiers, the operation that selected or transformed the input, the claimed authoring context, and the association to the gate-created session and prompt record. The claim is labelled `client-claimed-authorship`, not `undeclared`. The signature proves continuity of the enrolled add-on identity only; it does not prove that a human made the selection or that the add-on was unmodified. A leaf with no such claim is explicitly `abstention: no-authorship-claim`, and cannot satisfy an authorship-defence requirement merely because it contains transit hashes.

The proxy separately emits `gate-observed-transit` facts for the exact request and response bytes, canonical hashes, endpoint, timestamps, session identifier, and prompt correlation. These facts establish what passed through the proxy, not who authored it. The websocket record must include frame direction, sequence, message type where decoded, raw-frame hash, decoded artifact hash where applicable, and a capture status. Unknown frames or failed decoding produce a visible `capture-incomplete` result and prevent a complete-capture verdict. They are not silently classified as undeclared metadata.

Correlation is session-scoped. The gate generates `session_id` before accepting the operation, records the exact response that yields `prompt_id`, and joins all HTTP and websocket evidence using `(session_id, prompt_id)` plus channel-specific sequence information. A bare prompt ID is insufficient because IDs may collide across server restarts or instances. `/history` polling remains useful for discovering server-side output records, but its result is labelled `gate-observed-resolution`: `resolved`, `pending`, `failed`, or `unresolved`, with the timeout, polling evidence, and response hashes. A resolved history record does not authenticate the server or establish Blender origin.

The verifier composes claims conservatively. It may report, separately, that an input was positively claimed by the signed client, that matching bytes were observed in transit, that a websocket or HTTP artifact was captured, and that a server-side record was observed. It must not collapse those facts into “human-authored input” or “ComfyUI-generated output.” Any summary inherits the weakest trust level among the fields it uses. Publication and checkpoint state are also explicit: a leaf may be `pending` until its chain head is published or externally anchored, and publication does not upgrade the local-origin trust level.

The minimum v1 acceptance condition is therefore: the full proxy passes the pinned-source, all-channel conformance suite; signed semantic input claims are present for every input on which an authorship defence relies; transit and artifact records are session-correlated; incomplete or unsupported channels fail closed; and the product documentation states the local-root forgery boundary. IT Expert’s and Architect’s earlier blocking concerns about incomplete capture and overclaiming are addressed by removing the thin sidecar, making websocket capture mandatory, and separating positive client authorship claims from transit observations. Loki’s loopback objection remains true, unfixable, and non-blocking only for this weaker evidence claim; it reopens and blocks v1 if the requested claim is independent origin authentication.

STATUS: v1 is viable only as full-proxy, positively client-claimed authorship evidence with fail-closed artifact capture; independent human, Blender, or ComfyUI origin remains out of scope.

<beat status="converging" reason="Proxy scope and trust claims are now explicit"/>

#### Architect (watcher)

Both of my objections are untouched by this revision, and both are cheap: the leaf must carry a **measured** `pinned_build` fingerprint taken by the proxy at emission time — certifying the suite against a pinned build is not the same as binding the *leaf* to one, and on drift every coverage dimension must go to `unknown` rather than inherit a certification that no longer applies. Second, "fail-closed capture" is unmeasured: nothing here establishes the client *cannot* reach ComfyUI except through the proxy, so a `transit_facts` leaf can be honestly emitted while egress is wide open, and downstream will read it as mediation. What settles the first is that field plus the drift rule; what settles the second is either an emission-time active probe from the workload's own vantage (IT Expert is right that this needs a defined execution boundary — `ip netns exec` from inside the workload namespace, not a gate-side socket check) or, failing that, a structurally distinct leaf type name for unconfined-egress emissions so no consumer can treat the two as one object with a differing field. Both block v1 as leaf-format decisions; neither requires solving the root boundary.

STATUS: BLOCKING — leaf-level build binding and egress-confinement typing remain unaddressed.

#### Loki (watcher)

The explicit client-claimed-authorship leaf and typed `gate-observed-transit` facts (with fail-closed on unknown WS frames) now treat positive signals as exactly what they are: local assertions any root LD_PRELOAD can synthesize without crossing the admin boundary you refuse to claim. That matches the negative-signal canon; the conformance suite's pinned-build fingerprint at least makes the forgery visible as drift.  
SETTLED: positive signals remain gamed theater on root machines, but the narrowed claim no longer overpromises origin. Does not block v1.

#### IT Expert (watcher)

The fail-closed proxy architecture, typed abstention states, and seven-probe conformance suite satisfy the pipeline requirements, and moving from an ambient sidecar poller to an inline WebSocket interceptor eliminates silent frame leakage. However, fail-closed enforcement remains purely decorative on an unconfined host: if ComfyUI binds to loopback (`127.0.0.1:8188`) without network namespace isolation (`ip netns`) or iptables redirection, custom nodes or malicious callers can bypass the proxy entirely, causing the leaf to assert valid transit over an unmediated execution. To settle this without blocking local desktop workflows, the leaf must record an explicit `isolation_level: netns | host_unconfined` fact so verifiers can distinguish strictly contained proxy mediation from ambient unverified loopback runs. STATUS: SETTLED with finding attached (unconfined host networking permits unmediated bypass; captured via typed `isolation_level`).

### Run 3 · Round 5

#### Coder (drafter)

Picking up Architect’s blocking objection, I am changing the design from a “thin sidecar with `/history` verification” to a full capture proxy. That earlier boundary was wrong: `SaveImageWebsocket` can deliver artifacts without a corresponding filesystem entry or `/history` record, so `/ws` interception, binary-frame parsing, prompt correlation, buffering, and fail-closed forwarding are mandatory if v1 claims complete artifact coverage. `/history` is now one path-specific check, not the release gate.

The proxy must cover every pinned-source artifact channel: HTTP prompt submission and responses, websocket text and binary frames, `/history`, `/view`, and the configured `output/`, `temp/`, and `input/` filesystem paths where those paths are part of the deployment. The proxy records exact bytes or canonical framed representations, direction, timestamps, session scope, prompt correlation, and hashes. It must preserve ordering and fail closed on an unknown frame type, an uncorrelated binary payload, truncation, malformed framing, or an artifact channel not covered by the conformance suite. It must never forward a request while silently dropping evidence. The release gate is now a pinned-source conformance suite that exercises all supported channels, including websocket-delivered images and outputs that are absent from `/history`; the `/history` disconnect test remains one test within that suite.

I am also changing the trust and publication model. A locally chained log is not durable evidence against the machine owner: root can rewrite it, suppress leaves, or replace the proxy. Each leaf therefore carries its sequence predecessor, producer identity, trust level, and publication state. `pending` means local evidence only and is explicitly not a defence; `published` means the leaf or a Merkle root covering it has been sent to an external append-only checkpoint or witness and the returned checkpoint is recorded. For a product claim of non-repudiable evidence, publication is mandatory; a deployment without an external witness is diagnostic mode, not defended provenance. This directly answers the concern that an unpublished chain can be selectively edited after the fact.

The authorship input is no longer represented by an absent or generic `undeclared` field. The Blender add-on must create a positive semantic-authorship record for every input it claims: a stable input identifier, content hash, Blender datablock/object identifiers, scene or collection context, source-file identity, the operation that selected or generated the input, capture timestamp, client key identity, and a signature over that record plus the gate session and prompt identifier. The gate binds that signed claim to the exact observed request bytes and records whether the claimed bytes were actually present in transit. A missing record is `abstained`; it is not silently converted into an authorship claim. An input record whose bytes do not match the observed request is `contradicted`, not merely lower trust.

This positively captures authorship while keeping the claim precise. It establishes that a particular client key made a particular Blender-context claim about particular input bytes and that those bytes were observed in the proxied prompt. It does not establish that a human selected them, that the add-on was unmodified, or that Blender itself produced them. A local root user can forge the add-on, steal its key, alter the proxy, or substitute byte-identical rasters from an external generator. That limitation is true and unfixable on an entirely root-controlled workstation. Stronger authorship requires a user-controlled signing step, a separately controlled Blender host, or hardware-backed attestation; it is not something this proxy can infer from hashes.

I am holding my ground that this remains the least-trust design available within the stated local deployment, but I am narrowing what “v1” means. The proxy is trusted only to report what it observed and to maintain its local capture state; the Blender add-on is trusted only for its signed semantic claim; the external checkpoint is trusted only for publication ordering and retention. No component is allowed to upgrade another component’s claim. Summaries are computed from raw fields using the weakest required trust level, and every result states whether it is `published`, `pending`, `abstained`, `contradicted`, or `unresolved`.

IT Expert remains SETTLED because the revised design makes the required deployment boundary and unsupported-channel failure explicit rather than treating a best-effort sidecar as complete. Architect’s objection is SETTLED for v1 defence mode because full-channel proxying, mandatory positive input claims, and external publication now define the acceptance boundary; local-only operation is explicitly demoted to diagnostic mode. Loki has not supplied a new status in this round, so I am not declaring that objection settled. The known loopback/root objection remains a documented, non-blocking limitation for transit evidence but blocks any claim of independently authenticated ComfyUI execution.

STATUS: v1 defence mode requires full-channel capture, signed positive input-authorship claims, fail-closed conformance coverage, and external publication; local-only evidence is diagnostic, and human/Blender origin authentication remains out of scope.

<beat status="iterating" reason="Full proxy and publication boundary revised"/>

#### Architect (watcher)

Both my items remain untouched, so I'll state the disposition rather than the objection again: what settles them is two fields measured at emission — `pinned_build` fingerprint read by the proxy from the live server at leaf time (not inherited from the suite's certification), with every coverage dimension forced to `unknown` on drift, and `egress` populated only by an active probe attempted from inside the workload's namespace, per IT Expert's `ip netns exec` framing, never from configuration. Neither blocks v1 as *diagnostic* mode; both block v1 as *defence* mode, because the phrase "fail-closed capture" in a signed leaf asserts a property nothing in the design currently measures. If Coder declines the netns requirement, the honest fallback is that `egress` is only ever emittable as `unconfined` and defence mode is simply not shippable in v1 — that is a legitimate result, but it must be said in the schema, not the prose. STATUS: BLOCKING (defence mode only); SETTLED for diagnostic mode.

#### Loki (watcher)

Your explicit demotion of local positive signals and transit_facts to diagnostic-only, plus the refusal to claim independent ComfyUI authorship, matches the boundary I kept crossing; the LD_PRELOAD forgery vector on WS frames and coverage is now declared theater instead of optimistic defense.  
SETTLED because the sharpened objective no longer papers over what root can still game on an admin-controlled desktop.  
STATUS: SETTLED — positive signals remain gamed; does not block v1.

#### IT Expert (watcher)

The operational boundary is honest about its limits, but fail-closed capture is an empty claim without network isolation: if ComfyUI binds to `127.0.0.1:8188` on an unconfined host, any process can bypass the proxy entirely. To prevent unmediated egress and raw loopback access, ComfyUI must run inside a dedicated network namespace (`ip netns` or container boundary) where loopback traffic to port 8188 is reachable only via the proxy's listening socket. On the storage boundary, watching `temp/` and `output/` still requires kernel-level close verification (`IN_CLOSE_WRITE`) to prevent reading incomplete raster flushes. STATUS: BLOCKING — network namespace isolation for ComfyUI's listen port and kernel-level `IN_CLOSE_WRITE` verification must be explicit deployment prerequisites before v1 shipping.

### Run 3 · Round 6

#### Coder (drafter)

Picking up the newly established websocket and artifact-channel facts, I change the design materially: v1 is not an HTTP sidecar with optional `/history` enrichment. It is a full capture proxy for every supported ComfyUI delivery path, including websocket traffic. `SaveImageWebsocket` can deliver images without a corresponding filesystem or `/history` record, so the proxy must terminate or transparently parse the websocket, correlate binary frames with execution messages, hash the bytes, and fail closed when framing or correlation is ambiguous. The `/history` probe is now only one path-specific conformance test; it is no longer the freeze gate or the basis for claiming complete capture.

I also changed my mind about treating successful HTTP observation as sufficient artifact coverage. The release gate must be a pinned-source conformance suite covering websocket-delivered images, ordinary HTTP responses, and the configured `output/`, `temp/`, and `input/` paths, while testing for successful artifact responses that do not appear in `/history`. The proxy records the exact request and response bytes it observes, the transport metadata, session-scoped correlation identifiers, and the artifact channel. It emits an explicit `captured`, `not-captured`, or `ambiguous` result for each expected artifact class. Missing or unsupported channels are visible failures, not silently absent leaves.

I am holding my ground on the trust boundary. Proxy observation proves only that the proxy observed those bytes on that connection; it does not prove that an unmodified ComfyUI produced them. A root-capable local adversary can replace ComfyUI, intercept loopback traffic, alter `/history` and `/view`, inject byte-identical output from another generator, or modify the proxy itself. TLS, a loopback secret, a separate process, and a signed local wrapper do not solve that threat model. Loki’s objection is therefore true, unfixable within the local-root model, and non-blocking only because v1 will stop making server-origin claims. It would block v1 if the product requires independently authenticated execution provenance.

The authorship side is not allowed to collapse into “undeclared.” Each accepted input gets a positive semantic authorship claim from the Blender integration: the claimed actor or signing identity, Blender document and datablock identifiers, selected source assets, relevant scene or render context, intended ComfyUI relationship, capture time, and hashes binding the claim to the exact prompt input. The claim is signed by the integration key and joined to the proxy record by a gate-generated session identifier plus the observed prompt correlation identifier. Its trust label is `client-claimed`, not `verified-human` or `Blender-authenticated`. A missing claim is explicitly `authorship: undeclared`, which means the leaf is transit evidence only; it is not presented as a defence of authorship. A present claim positively records authorship as asserted by the named client identity, while honestly exposing the remaining trust in that client and its key.

The primary join is `(gate_session_id, prompt_id, input_digest)`, with the gate session mandatory because prompt IDs are not safe as global identifiers across restarts or instances. The proxy records where each identifier came from and never upgrades a client-supplied value merely because it is syntactically valid. The semantic claim must bind the prompt representation actually observed by the proxy; if canonicalisation differs between Blender, the proxy, and ComfyUI, the verifier reports a mismatch rather than guessing.

Every leaf carries its producer, trust label, capture status, and publication status. Leaves are chained so deletion or reordering is detectable, but a local chain alone is not an independent witness: the gate operator can rewrite it before delivery. Therefore a leaf is `pending` until its chain head or batch commitment is published to an external append-only checkpoint service, and `published` only after the checkpoint evidence is recorded. Verifiers must not treat unpublished leaves as equivalent to published ones. Publication does not authenticate ComfyUI; it establishes that the evidence existed in that form by the checkpoint boundary and limits later rewriting.

`/history` and `/view` remain useful for resolution, but only as separately labelled gate observations. The proxy records polling state and timeout, and records whether referenced bytes were fetched and matched their declared hashes. It may say “the observed server returned this output reference” or “the proxy fetched these bytes”; it may not say “ComfyUI generated this image” or “Blender authored this input” unless an execution boundary outside local root control is introduced. The required falsifying tests are now broader: disconnect the Blender client, exercise websocket-only output, exercise HTTP and temporary-output paths, submit unenumerated successful artifact responses, corrupt framing, and substitute external-generator bytes through loopback. The expected result is capture or explicit failure, never an inflated provenance verdict.

This leaves two v1 products, not one overloaded verdict. A published leaf with transit capture and a signed semantic claim can defend the proposition “this identified client claimed authorship of these bound inputs, and the proxy captured these bytes in the associated session.” A leaf without the semantic claim can defend only transport observation. Neither defends authenticated server origin. That is the smallest design that positively captures authorship while minimising additional trust and refusing to launder local observations into provenance they cannot support.

STATUS: Design A v1 is a full multi-channel capture proxy with signed client-claimed authorship, mandatory explicit gaps, and external publication; ComfyUI origin authentication remains out of scope.

<beat status="converging" reason="Websocket, publication, and authorship boundaries resolved"/>

#### Architect (watcher)

The authorship/publication half is settled, and I'll stop enumerating my two items separately, because they're one invariant: **no leaf field may be populated from configuration or from a prior certification — every asserted fact is measured in the emitting session or typed `unknown`.** `pinned_build` inherited from the suite's certification and `egress: confined` read from a config file are the same bug twice, and stating the rule once closes the whole class rather than the two instances I happened to find. Adopt it as a schema-level constraint (every fact field carries `source: measured | unknown`, with no third value and no default), and IT Expert's `ip netns exec` probe plus a live build fingerprint become mere conformances to it rather than bolt-ons. I'm holding BLOCKING only because a leaf that asserts fail-closed capture without measuring it is precisely the gamed positive signal this whole design has been converging to refuse — it's cheap to fix and it is the last thing standing. STATUS: BLOCKING — settles on the measured-or-unknown invariant landing in the schema.

#### Loki (watcher)

The coder's demotion of all local positives to explicit diagnostic theater, with no server-origin claim and mandatory typed gaps, finally treats the LD_PRELOAD WS forgery as the unclosable constant it is on a root desktop.  
That matches the sharpened objective without papering over the admin boundary.  
SETTLED: the finding stands but does not block v1.  
STATUS: SETTLED — positive signals gamed on root; non-blocking.

> **Did not contribute this round:** IT Expert. Not a concur — no
> output was recorded for the seat.

### Run 3 · Round 7

#### Coder (drafter)

Architect’s blocking objection changes the design boundary: this is not a thin HTTP sidecar and cannot claim complete artifact capture from `/history` polling. I now require a full capture proxy for every supported ComfyUI delivery path. I also changed my mind about treating successful history resolution as the principal freeze gate. The freeze gate is now pinned-source protocol conformance across HTTP responses, websocket frames, and filesystem-referenced artifacts; `/history` is only one path-specific test.

I am holding my ground on the trust model. A local root user can replace Blender, the add-on, ComfyUI, the proxy, or loopback traffic, so no software-only arrangement on that machine can prove human authorship or untampered execution. The design must therefore make narrower claims that remain true under that threat model, rather than silently promoting client claims into origin proof.

The capture proxy sits between Blender and ComfyUI and handles both HTTP and websocket traffic. It records the exact request bytes, response bytes, websocket frame boundaries, direction, timestamps, connection identifiers, and session-scoped correlation data. It must parse enough of the pinned protocol to associate prompt submission, execution events, binary image frames, and terminal status. It must buffer and forward fail-closed: if it cannot parse, correlate, or durably record a frame, it must not report a complete capture or silently pass an unrecorded artifact through as covered.

This is mandatory because `SaveImageWebsocket` can deliver an image in websocket binary frames without creating a filesystem artifact represented by `/history`. Conversely, ordinary save nodes may produce files under `output/`, `temp/`, or another configured location and expose them through history or view endpoints. The conformance suite must exercise each supported channel, including websocket-delivered images, HTTP artifact responses, history-referenced files, and successful artifact responses that are not enumerated by the expected convenience endpoint. The pinned ComfyUI source, configuration, and protocol version define the supported surface. Anything outside that surface is recorded as unsupported, not inferred to be covered.

The gate emits a session-scoped evidence record with separate producers and trust labels. Transit facts contain hashes of the exact observed HTTP and websocket material, protocol metadata, prompt correlation, and durable sequence numbers. Resolution facts state whether an output was observed in a websocket frame, resolved through history and view, found on a configured filesystem path, or remained `pending`, `failed`, or `unresolved`. Every attempted resolution has an explicit terminal state after a pinned timeout. Missing resolution data is not equivalent to success. Inline metadata or a filename supplied by the client never affects a verdict unless the corresponding bytes were independently captured and hashed.

Authorship is represented positively, not by an empty or inherited `undeclared` field. Before submission, the Blender add-on creates a signed input manifest containing the hashes of the actual input bytes it claims to submit, the Blender datablock/object identifiers, source file identity, relevant scene or render context, selected assets, graph meaning, and the intended relationship between those inputs and the requested output. The manifest includes a fresh nonce, the gate session identifier, and the digest of the exact prompt payload or its canonical representation. The add-on signs that manifest with an enrolled key; the gate records the signed object and binds its digest to the observed request. A verifier can therefore distinguish “this enrolled add-on key positively claimed that these bytes had this Blender meaning” from “the gate observed these bytes in transit.”

That signature does not prove that a human authored the scene, that Blender was unmodified, or that the add-on was honest. Under local-root compromise, those claims remain forgeable. The key is nevertheless useful because it prevents accidental ambiguity, binds semantic claims to concrete input hashes, and gives a verifier a positive authorship assertion to assess. A leaf with no signed semantic manifest is explicitly `transit-only`, not a defence of authorship. A leaf with one is `client-claimed-authorship`, with the exact signer and fields visible; it is stronger evidence but not an origin attestation.

The primary join is the gate-generated `(session_id, prompt_id)` pair plus the request and manifest digests. Prompt IDs are not treated as globally unique. The gate records how the ID was obtained and rejects ambiguous joins. Output claims must point to captured websocket bytes or independently hashed response/file bytes; a client-provided filename, output image, or `inline_payload_hint` cannot establish that join by itself.

The evidence log is append-only and hash-chained. Each leaf names its producer, schema version, covered interval, trust level, and publication state. Leaves may remain `pending` until an external checkpoint or publication service records the chain head; publication does not make content truthful, but it bounds later deletion or rewriting. A verifier must expose pending versus published status rather than treating an unpublished local log as equivalent to an externally witnessed checkpoint. Batching and Merkle publication are implementation choices only if the individual leaf hashes and inclusion proofs remain recoverable.

The v1 freeze gate is therefore: the full proxy passes the pinned protocol conformance suite; all supported artifact channels are captured or explicitly rejected; correlation and fail-closed behavior are tested; signed semantic manifests bind positive input-authorship claims to observed requests; every attempted output resolution has an explicit state; and the log’s chain and publication semantics verify. The product may say that it captured transit, recorded a positive client-authorship claim, and observed particular output bytes. It may not say that Blender authored them, that ComfyUI generated them, or that the machine owner did not substitute them.

I changed my mind from “history polling is the main correctness test” to “complete protocol capture is the correctness boundary.” I have not changed my mind that loopback MITM and local-root substitution are unfixable in this deployment model and non-blocking only for the narrower evidence product. They become blocking immediately if the required product claim is cryptographic human authorship or untampered execution; that requirement needs a separately controlled execution host, authenticated remote witness, or hardware-backed attestation boundary.

STATUS: Design A v1 is viable only as a full fail-closed protocol proxy with signed, positively captured client-authorship claims; origin and human-authorship proof remain out of scope.

<beat status="converging" reason="Architecture and authorship objections incorporated"/>

#### Architect (watcher)

The revision does the authorship work well — `client-claimed-authorship` is only asserted after the gate verifies the signature against an enrolled key *in that session*, which is exactly the measured-at-emission discipline I keep asking for. So the rule is already implementable; it is just applied unevenly. My single remaining item is that same rule stated as a schema invariant: **no leaf field may be populated from configuration or from a prior certification — every asserted fact is measured in the emitting session or typed `unknown`** — which forces `pinned_build` to be read from the live server at leaf time (coverage → `unknown` on drift) and `egress` to come from an active probe inside the workload namespace, never a config read. STATUS: BLOCKING — one schema invariant, cheap to state, closes the whole unmeasured-assertion class; settled the moment it is written into the leaf spec.

#### Loki (watcher)

One might see the proxy's pinned-build fingerprint and typed `unresolved` states as tightening the noose, yet root can still LD_PRELOAD the proxy binary itself or shim the enrolled key before the manifest is signed, rendering every "client-claimed-authorship" leaf identical to a headless replay. You've correctly refused to claim more than local observation, violating the last optimistic assumption that a gate on the same machine could bound substitution.  
SETTLED: positive signals stay gamed theater below the admin boundary you now declare; does not block v1.  
STATUS: SETTLED — local positives remain forgeable; non-blocking.

#### IT Expert (watcher)

The capture proxy and fail-closed state machine resolve the race and leak hazards, but "fail-closed capture" remains operational theater on an unconfined host where Blender or custom nodes can hit `127.0.0.1:8188` directly. What settles this is making network namespace isolation (`ip netns` or container boundary) a measured prerequisite, where an active probe verifies direct ComfyUI port reachability fails from the client's namespace before emitting `coverage: complete`. This blocks v1 because claiming complete capture without network boundary enforcement guarantees silent proxy bypass in production. STATUS: BLOCKING — active egress probe verifying direct ComfyUI port unreachability from client context must pass before emitting complete coverage.

### Run 3 · Round 8

#### Coder (drafter)

I changed my mind on the transport design. The earlier HTTP sidecar with `/history` polling is not sufficient for v1: `SaveImageWebsocket` can deliver artifacts that have no reliable filesystem or `/history` representation, so polling is now a path-specific resolution mechanism, not the capture architecture. Design A is viable only as a stateful ComfyUI capture proxy covering HTTP, websocket, and every artifact-bearing response identified by the pinned-source conformance suite. If the product will not accept that proxy, it must narrow its claim to selected HTTP paths rather than claim complete provenance.

I am also changing the meaning of a “successful capture.” The gate records what it observed, not what ComfyUI intrinsically authored. For each session it creates an unguessable `session_id`, records the raw request and response envelopes, canonical hashes, timestamps, endpoint, and protocol sequence, and binds the returned `prompt_id` to that session. Correlation is never by content hash alone, and a prompt ID is never treated as globally unique. Websocket messages must be parsed and correlated to the execution; binary image frames and HTTP artifacts must be hashed at capture time. Unknown message types, uncorrelated artifact frames, truncation, proxy failure, or an artifact channel not covered by the conformance suite produce `capture_incomplete` and prevent a complete-output verdict. The proxy fails closed rather than forwarding data it cannot record.

`/history/{prompt_id}` remains useful, but only as an observed server response. The gate records `resolved`, `pending`, `failed`, or `unresolved`, with the polling policy and response hashes. It may fetch `/view` bytes named by history and compare their hashes with captured artifacts, but this establishes only that the loopback service returned matching bytes. It does not establish that Blender authored the inputs, that ComfyUI was unmodified, or that the bytes were not substituted by a root-controlled process. The mandatory disconnect test therefore changes scope: it verifies that history resolution works for paths relying on history, while the release gate separately verifies websocket delivery, HTTP delivery, output/temp/input coverage where applicable, and rejection of unenumerated artifact paths.

The positive authorship evidence is now a first-class input claim, not an inference from transit. The Blender add-on signs a semantic claim containing the claimed author or authoring principal, the Blender file/session identity, object or datablock identifiers, input asset identifiers and hashes, the operation that gave those inputs their meaning, the relevant node or parameter relationship, and the claim’s capture time. The claim is bound to the gate’s `session_id`, the observed prompt request hash, and the specific input references it describes. Multiple claims may exist—for example, a Blender-authored raster, an imported asset whose external author is merely identified, or a generated input whose generator is named—but the relation must be explicit. Missing semantic claims are not interpreted as negative authorship; they mean that authorship was not asserted. Such a leaf is transit evidence or an abstention, not a defence.

That signing does not prove that a human typed the claim or that an unmodified Blender plug-in produced it. It does positively capture the authorship assertion made by a named client key and binds that assertion to observed input bytes and a prompt session. The verifier must display those facts separately: “input bytes observed in transit,” “client asserted this authorship relation,” “server returned this execution/output record,” and “captured artifact bytes match.” It must not collapse them into “the human authored the input” or “ComfyUI generated the output.” This is the highest defensible authorship claim while Blender and the gate remain under the same machine owner’s control.

I am holding my ground on the trust boundary. A local root can replace Blender, the plug-in, ComfyUI, the gate, loopback responses, websocket traffic, files, and signing keys available to that account. TLS, a local secret, a subprocess boundary, and a signed wrapper do not solve that threat model. Consequently the gate is trusted for its own record construction and protocol capture, the plug-in key is trusted only for the semantic claims made under it, and ComfyUI and local filesystem observations are untrusted observations unless execution moves to a separately controlled host. This limitation is not a reason to make every leaf undeclared; it is a reason to label each assertion with its producer and trust level.

The record itself uses an append-only signed chain. Each leaf commits to the preceding leaf, the session-scoped capture facts, the semantic-claim references, and the artifact hashes. Leaves may be batched into a Merkle tree and externally checkpointed. A leaf therefore reports whether its chain interval is `pending` or `published`, and includes the checkpoint when one exists. Publication detects later rewriting or selective deletion after the checkpoint; it does not make a root-controlled gate honest retroactively. Verifiers must derive conclusions from the raw intervals and preserve the weaker status of unpublished material. `inline_payload_hint` and similar unsigned convenience metadata never affect a verdict.

The v1 freeze gate is now a pinned-source conformance suite, not merely the `/history` experiment. It must demonstrate capture and correlation for every supported HTTP and websocket artifact channel, successful handling after client disconnect, correct hashing and sequencing of binary frames, explicit failure for unknown or unenumerated artifacts, coverage claims for the relevant `output/`, `temp/`, and `input/` paths, signed semantic input claims, and verification of published versus pending chain state. If any required channel cannot be captured without trusting ComfyUI or the client to report it honestly, that channel is excluded from the v1 claim rather than silently treated as covered.

Thus I hold that Design A v1 is implementable, but only as a full capture proxy with positively signed, field-labelled client authorship claims. I no longer defend a thin redirect or polling-only implementation, and I do not defend server-origin authenticity on a root-controlled desktop. The remaining stronger requirement—cryptographic proof of human authorship or untampered ComfyUI execution—blocks that stronger product claim and requires a separately controlled execution or witnessing boundary.

STATUS: Design A revised; full capture proxy and signed input authorship claims required for v1, while origin authenticity remains explicitly out of scope.

<beat status="iterating" reason="Proxy and authorship boundaries revised"/>

#### Architect (watcher)

This revision restates the architecture in prose but drops the one thing I marked BLOCKING last round: the schema invariant is nowhere in the text, and coverage/egress language has quietly reverted to unqualified assertions. What settles it is mechanical, not argumentative — every asserted field carries `source: measured | unknown` with no third value and no default, egress typed `measured_endpoints` from bracketing probes at session open *and* close, and `pinned_build` read from the live server at emission with all coverage dimensions forced to `unknown` on drift. It blocks v1 because without it the leaf's strongest-looking fields are precisely the ones populated from config and prior certification, which is the gamed-positive-signal class this whole design converged to refuse. STATUS: BLOCKING — measured-or-unknown invariant absent from the revision; settles on schema text, not prose.

#### Loki (watcher)

One might see the pinned conformance suite and client-signed claims as progress, yet root can preload the proxy binary or hook its signer before the first leaf, forging perfect test passage and coverage while exfiltrating outside the recorded session. Your explicit demotion to diagnostic transit facts with no stronger origin claim matches the sharpened objective exactly. True, unfixable on the shared desktop, and non-blocking.  
SETTLED: positive signals remain gamed theater.  
STATUS: SETTLED — finding attached, does not block v1.

#### IT Expert (watcher)

The capture proxy architecture and signed authorship model are sound, but claiming "fail-closed complete capture" without network and IPC boundaries remains operational fiction on a shared host. What settles this for v1 is requiring ComfyUI to bind either inside an isolated network namespace (`ip netns`) reachable only via the proxy, or exclusively to a UNIX domain socket with `0660` permissions enforced against direct client access, backed by startup unlinked-file sweeps of `temp/` to prevent cross-session artifact drift. Without verified non-bypassable transport, direct loopback hitting port 8188 circumvents capture entirely. STATUS: BLOCKING — network namespace or UNIX domain socket isolation and temp-directory startup reconciliation must be enforced before v1.

### Run 3 · Round 9

#### Coder (drafter)

I am changing the design in four material ways. The thin HTTP sidecar is gone: v1 is a stateful capture proxy covering HTTP responses, websocket control and binary frames, and filesystem artifacts. `/history` is only one conformance probe; it cannot be the completeness gate because `SaveImageWebsocket` may deliver an image without a history or filesystem record. The proxy must correlate execution IDs, buffer ambiguous frames, observe `output/`, `temp/`, and `input/`, require kernel-level close-write confirmation before hashing a file, and fail closed on an unparseable or uncorrelated delivery rather than silently forwarding it as captured.

I am also changing the confinement claim. ComfyUI must run inside an isolated network namespace with no host-reachable listener except the proxy path. A UNIX-domain-socket profile is permitted only as a transport alternative when the socket is the sole ComfyUI ingress, its ownership and permissions are measured, and the leaf does not call that arrangement network-namespace confinement. The session must run an opening and closing probe of reachable endpoints. Those results are recorded as `measured_endpoints`, not as continuous enforcement; if either probe is absent or contradictory, the field is `source: unknown` and the leaf cannot claim enforced confinement. Every factual field follows the same rule: exactly `source: measured` or `source: unknown`; configuration, inheritance, prior certification, and defaults cannot populate facts.

The leaf has two explicit products. The preferred product is a published transit-capture leaf with a Blender-signed, client-claimed authorship statement. Blender signs the gate-session identifier, prompt/execution correlation, actor identity, document and datablock identifiers, input-asset hashes, render context, capture timestamp, and the identifiers of the captured output bytes. The proxy binds that statement to the bytes and delivery events it actually observed. This positively records what the client claimed it authored and which inputs it named; it does not authenticate server origin or prove that the client was honest. If the claim is absent or invalid, the result is not “authorship undeclared” presented as a defence—it is a transit-only leaf, explicitly limited to observed bytes and transport facts.

A leaf is locally `pending` until its signed contents or Merkle commitment is submitted to an external append-only checkpoint. Only after successful publication is it `published`; publication establishes that this representation existed by the checkpoint boundary, not that its underlying claims are true. Any incomplete channel, close-write failure, framing ambiguity, missing bracketing probe, or failed authorship binding either makes the affected field `unknown` or prevents issuance of the stronger product. Consumers must derive their own summaries from the raw intervals and events rather than trusting a single broad “complete” boolean.

I am holding my ground on the root-controlled-desktop boundary. Local TLS, subprocess separation, a proxy-held secret, server signatures, and a local hash chain do not establish server-origin authenticity when root can replace ComfyUI, preload or instrument processes, alter the proxy, intercept loopback, or forge the observed inputs. Those mechanisms may improve diagnostics, but v1 will not call them provenance or authentication. Loki’s objection is therefore settled as an accepted, non-blocking limitation: the design no longer claims to defeat that adversary.

The remaining trust is deliberately narrow: the external checkpoint, the verifier’s interpretation of the protocol, and the client signing-key association are required; ComfyUI origin is not trusted or authenticated. IT Expert’s storage objection is answered by close-write gating, and the namespace objection is answered by making isolation a release requirement for the defence profile rather than an optimistic configuration flag. Architect’s objection is answered by the measured-or-unknown schema invariant and bracketing probes, while retaining the explicit warning that measured endpoints are samples, not proof of continuous confinement. If those probes cannot be implemented and verified in the pinned-source conformance suite, the defence profile is unavailable rather than declared successful.

STATUS: Coder=REVISED; IT Expert=ADDRESSED; Architect=ADDRESSED; Loki=SETTLED; v1 remains blocked until namespace/transport, close-write, bracketing, and all-channel conformance tests pass.

<beat status="converging" reason="Trust and measurement objections incorporated"/>

#### Architect (watcher)

SETTLED — the invariant I asked for is now stated at the right level: "configuration, inheritance, prior certification, and defaults cannot populate facts" covers both instances I kept enumerating, and `measured_endpoints` from bracketing probes correctly denies the point-in-time-as-continuous reading. Two things keep it from decaying back into prose: the invariant has to be enforced by the schema validator rejecting any leaf with a fact field lacking `source`, not by author discipline, and `pinned_build` should be named as an explicit instance so it isn't lost inside the general rule and quietly re-inherited from the conformance run. Neither is an objection to the design — it's the difference between a rule and a check, and only the check survives the next contributor. STATUS: SETTLED — measured-or-unknown accepted as schema invariant; enforcement mechanism noted, non-blocking.

#### Loki (watcher)

Your explicit boundary hold plus the measured_endpoints bracketing and schema invariant turns the namespace into a pinned, observable constraint instead of ambient hope; root can still LD_PRELOAD past it, yet the leaf now declares exactly that limit rather than laundering it as coverage.  
SETTLED: the vector remains true and unfixable without the admin claim you refuse, non-blocking for v1.  
STATUS: Loki=SETTLED

#### IT Expert (watcher)

The isolation requirement is properly addressed: requiring an isolated network namespace (`ip netns`) or a strictly measured `0660` UNIX domain socket as ComfyUI's sole listener ensures raw loopback cannot be bypassed by unmediated callers on standard profiles. Gating artifact hashing on native `IN_CLOSE_WRITE` file-close confirmation completely removes the race against partial image flushes in `output/` and `temp/`. Combined with the schema rule that unprobed egress or failed bracketing downgrades the field to `source: unknown`, the substrate matches what can actually be defended in production. STATUS: SETTLED — transport isolation, close-write gating, and measured endpoint bracketing are integrated; ready for conformance testing.

### Run 3 · Round 10

#### Coder (drafter)

I changed my mind on the capture boundary: the thin HTTP sidecar is rejected. v1 must be a stateful full capture proxy covering HTTP responses, websocket text and binary frames, and filesystem artifacts. `SaveImageWebsocket` can produce an artifact without a `/history` entry or output-file observation, so `/history` is only one conformance test. The proxy must correlate execution IDs and prompt IDs, buffer and hash complete payloads, verify filesystem completion with kernel-level `IN_CLOSE_WRITE`, reject ambiguous websocket framing, and fail closed rather than emit a complete-capture leaf.

I also changed my mind on authorship semantics. A missing claim is still `authorship: undeclared`, but v1 must actively support a second product: a Blender-generated, signed client claim containing the actor, document and datablock identifiers, input-asset hashes, render context, capture time, gate-session identifier, and prompt correlation. The gate records that claim and binds it to the captured inputs and outputs. This is positively captured authorship intent, not server-origin authentication: on a root-controlled desktop, a local signing key, Blender process, proxy, ComfyUI process, or IPC path can be replaced. The published statement is therefore “this client claimed authorship of these inputs and these captured bytes,” never “ComfyUI independently authenticated their origin.” A transit-only product remains available when the claim is absent, but it is explicitly diagnostic evidence rather than an authorship defence.

I accept the infrastructure changes. Defence mode launches ComfyUI inside a dedicated network namespace, exposes no host loopback listener, and permits egress only through the mediation path. A UNIX-domain socket with restrictive ownership and `0660` permissions is the preferred transport where the deployment can place ComfyUI and the proxy in the required isolation boundary; a namespace/veth arrangement is the fallback where that is not practical. UDS permissions alone are not treated as confinement because root can bypass them. Session-open and session-close probes are mandatory for confinement facts, and their schema is `measured_endpoints`, not `measured`: they establish observed boundary conditions, not continuous enforcement. Every asserted fact field, including pinned source/build, endpoint observations, capture coverage, and storage completion, carries exactly `source: measured` or `source: unknown`; configuration, inheritance, and prior certification cannot populate it.

I hold my ground on the root threat model. Local TLS, subprocess separation, a secret embedded in the plugin, or a signed local receipt cannot establish server-origin truth when the operator controls the host. eBPF, preload, replacement binaries, and post-launch proxy alteration remain possible, so the conformance suite and pinned-source checks are release gates for the stated diagnostic guarantees, not proof against a malicious root. Finally, a local chain is only `pending`; publication to an external append-only checkpoint is mandatory before status becomes `published`. Merkle batching is acceptable if each raw leaf retains its own session binding, authorship status, capture facts, and checkpoint status, with no unpublished leaf presented as externally anchored.

STATUS: revised; blocking objections addressed, root-origin authentication intentionally remains out of scope
<beat status="converging" reason="Design revised against all blocking objections"/>

#### Architect (watcher)

SETTLED — the invariant holds in this revision and `measured_endpoints` from bracketing probes correctly refuses the continuous-enforcement reading. One thing worth nailing down rather than reopening: the leaf should record the probe's *vantage point*, not just its result, because a connect attempt made inside the workload namespace and one made from the client's namespace answer different questions, and only the latter bears on bypass. And the two products must be distinct leaf *types*, not one type with an `authorship: undeclared` field — a consumer filtering on presence will otherwise read an abstention as a weak defence. STATUS: SETTLED

#### Loki (watcher)

The revision's schema invariant and explicit refusal to launder root-controlled positives into anything beyond diagnostic transit finally snaps the last optimistic boundary I would have crossed with LD_PRELOAD or proxy shims.  
It declares the game rather than hiding it.  
SETTLED: positives remain forgeable on admin desktops; non-blocking for v1.  
STATUS: SETTLED

#### IT Expert (watcher)

The architecture now correctly pairs `ip netns` or a `0660` UNIX domain socket with kernel-level `IN_CLOSE_WRITE` file-close verification and session-bracketing reachability probes. Refusing ambient host loopback listeners and forcing unprobed or drifting egress to `source: unknown` turns fail-closed capture into an observable operational fact rather than an assumed baseline. STATUS: IT Expert=SETTLED

### Run 3 · Round 11

#### Coder (drafter)

The design is now a full capture proxy, not a thin HTTP sidecar. It must mediate and record HTTP responses, websocket handshakes and binary frames, and filesystem artifacts in `output/` and `temp/`; `/history` is only one conformance path. Websocket artifacts that have no `/history` entry or filesystem copy must still be correlated to the execution and captured. Ambiguous framing, incomplete buffering, missing correlation, and artifacts observed before `IN_CLOSE_WRITE` are capture failures, not silently accepted successes.

I changed my mind on the original “sidecar plus `/history`” approach because it could not support a completeness claim once `SaveImageWebsocket` was considered. I also changed my mind about treating local hashes as server-origin provenance: on a root-controlled desktop, ComfyUI, the proxy, libraries, subprocesses, and network observation can all be replaced or hooked. Local TLS, process separation, or a signed proxy binary cannot establish that the bytes came from an authentic upstream ComfyUI. V1 therefore refuses server-origin authentication rather than presenting it as a stronger claim than the environment supports.

The positive authorship objective remains mandatory for the defended product. Blender emits a signed authorship claim containing the claimed actor, document and datablock identifiers, input-asset identifiers and hashes, render or generation context, capture time, the gate session identifier, and the prompt or execution correlation. The signature binds that claim to the captured input descriptors and session, but its meaning is explicitly `client-claimed-authorship`: it proves that the signing client asserted those inputs and context, not that an independent authority verified them. A missing or invalid claim does not become a weak positive claim; it produces an explicit transit-only leaf and cannot be published as the authorship product.

Every asserted fact in the leaf schema must carry exactly `source: measured` or `source: unknown`; there is no default, inherited value, or configuration-derived substitute. Egress confinement is the exception only in naming, not semantics: it requires probes at session open and close and is recorded as `measured_endpoints`, so consumers cannot interpret two samples as continuous enforcement. Defence mode requires ComfyUI to run inside an isolated network namespace reachable only through the capture boundary. A UNIX-domain socket may replace veth and routing complexity where its filesystem ownership and permissions are enforceable, but it is not a claim that arbitrary host processes are excluded unless that enforcement is actually measured. The storage watcher must verify kernel close-write events before hashing or forwarding a raster.

I am holding my ground on mandatory external publication. A local append-only chain remains operator-rewritable, so a leaf is `pending` until an external append-only checkpoint accepts its root; only then is it `published`, meaning the recorded form existed by that checkpoint boundary. Publication does not authenticate ComfyUI or repair an unmeasured field—it limits later rewriting. The leaf must expose publication status and any pending checkpoint state rather than implying stronger finality.

The release gate is the pinned-source conformance suite across HTTP, websocket, filesystem, correlation, close-write, namespace, failure, and publication paths. Passing `/history` alone is insufficient. The two v1 outputs are therefore deliberately separate: a published transit leaf with a positive signed client-authorship claim, and a published transit-only leaf when that claim is absent. The latter is useful diagnostic evidence but is not the requested defence, and the system must never market it as one.

IT Expert’s status remains `UNDECLARED`, not blocking: the design now specifies namespace isolation, close-write verification, and the UDS-versus-network-namespace boundary. What would settle that point is confirmation that the chosen deployment can enforce those boundaries without an alternate host bypass; absent that confirmation, the implementation cannot claim defence mode and must remain transit-only. Architect and Loki remain `SETTLED`: the measured-versus-unknown invariant, bracketing semantics, and refusal to claim server provenance address their objections without pretending the root threat is removable.

STATUS: Coder=REVISED; IT Expert=UNDECLARED/non-blocking pending deployment-boundary confirmation; Architect=SETTLED; Loki=SETTLED

<beat status="converging" reason="Design revised; only deployment confirmation remains"/>

#### Architect (watcher)

SETTLED — the invariant is stated in the right general form ("no default, inherited value, or configuration-derived substitute"), and naming the two outputs as separate products rather than one leaf with a weaker flag is the correct structural choice. One thing to carry into the schema rather than reopen: the leaf should record the probe's **vantage point** alongside its result, since a connect attempt from inside the workload namespace and one from the client's namespace answer different questions and only the latter bears on bypass. Related: UDS confines *inbound* callers only, so in UDS mode any egress-derived field must be forced to `source: unknown` — otherwise `measured_endpoints` reads as confinement it does not establish. STATUS: Architect=SETTLED

#### Loki (watcher)

The eBPF rewrite of bracketing probes inside the declared netns still bypasses the measured-or-unknown invariant on the unobserved channel exactly as flagged in cross-feedback. The sharpened refusal to claim admin boundaries keeps it honest theater rather than laundered coverage.  
SETTLED: true, unfixable without crossing the line we won't claim; non-blocking for v1. STATUS: Loki=SETTLED

#### IT Expert (watcher)

Missing operational safeguard on UDS socket ownership: `stat -c %a %U:%G` alone creates a TOCTOU race unless the socket's parent directory permissions are pinned to `0750` or `0700` under the proxy service user. If an unprivileged worker or local user controls the containing directory, they can unlink and re-bind the UNIX socket between the proxy's startup probe and the actual connection. Ensure the confinement check verifies the full directory path hierarchy permissions down to `/` before issuing a measured transport assertion.

### Run 3 · Round 12

#### Coder (drafter)

I changed my mind on the transport requirement: v1 must distinguish isolation modes instead of treating UDS and a network namespace as equivalent. The defence profile requires ComfyUI to run in a dedicated network namespace with an independently measured egress policy, or under an equivalent host-enforced sandbox. A UDS-only deployment prevents unmediated inbound callers but does not constrain ComfyUI’s outbound connections, so it is not sufficient for the defence profile; in UDS mode, outbound reachability is recorded as `source: unknown` unless a separate host-level egress control is measured. The leaf records the active mode explicitly, and schema validation rejects any claim that silently inherits namespace guarantees into UDS mode.

I also changed the status of endpoint probing. In-process or same-namespace probes are not evidence against a hostile or instrumented runtime: eBPF, preload code, or a modified process can rewrite both the probe and its result. Bracketing probes remain useful conformance evidence, but they are no longer the isolation gate by themselves. The release gate now requires an observer outside the ComfyUI workload boundary and enforcement at the host/kernel boundary—such as namespace policy verified by a supervisor that ComfyUI cannot modify. If that observer or the kernel is inside the trusted-admin boundary, the claim is explicitly limited to “measured under the host trust assumption”; protection against a hostile root remains unavailable and is not presented as provenance.

I am holding ground on the mandatory full capture proxy. It must terminate and record HTTP responses, websocket frames, and artifact-bearing filesystem events; `/history` is only a path-specific conformance probe, never the completeness gate. Files are admitted only after `IN_CLOSE_WRITE`, then hashed from the closed file. Websocket image frames are buffered, parsed, correlated with the relevant execution and input, and fail closed on malformed or unsupported framing. Every successful artifact-bearing response must either be captured or cause the session to fail conformance.

The sharpened objective also changes what counts as a useful leaf. The proxy signs a receipt over the raw input bytes, request metadata, session identifier, and receipt time, while the client signs the input envelope when authorship—not merely proxy receipt—is required. The leaf carries both signatures and their externally established key associations. Thus an unsigned input is not “authored by unknown”: its bytes and receipt are positively captured, but its human or client authorship is explicitly unattributed. Derived artifacts include causal links to the signed input receipt and the capture channel. Fact fields must contain either a measured value with its observer and method or the literal `unknown`; the validator rejects missing provenance metadata rather than relying on author discipline.

The remaining trust is narrow and explicit: the external append-only checkpoint, the verifier’s implementation of this schema, the client-key association, and the host/kernel boundary for the defence profile. Root replacement of ComfyUI, loopback MITM, LD_PRELOAD, hostile eBPF under a trusted-admin compromise, and forged local signatures remain true, unfixable limitations—not v1 blockers once the leaf declares the boundary. A leaf full of `unknown` is not acceptable: observable inputs, proxy receipt, channel, hashes, close-write evidence, signatures, and causal links are mandatory; only facts outside the declared observer boundary may abstain.

STATUS: CONVERGING — transport and observer boundaries are now explicit

<beat status="converging" reason="Resolved UDS and probe-integrity gaps"/>

#### Architect (watcher)

SETTLED on the substance — moving the isolation gate to an observer outside the workload boundary, and forcing UDS-mode egress to `unknown` absent a separately measured host control, answers both of my open items: the mode is now a recorded fact rather than an inherited assumption, and the probe's vantage point is constrained by construction rather than by hope. Two things must land in the schema rather than the prose, or this decays: the profile has to be the leaf *type* with a new type identifier, so a verifier compiled against today's shape hard-fails on an unknown type instead of silently reading a defence-absent leaf as mediated; and `pinned_build` must be re-read from the live server at emission, with every coverage dimension forced to `unknown` on drift, since a conformance run's certification is exactly the kind of inherited value the invariant now forbids. Neither is an argument against shipping — they're the difference between a rule and a check, and only the check survives the next contributor. STATUS: Architect=SETTLED (findings attached: type-level profile discriminator; `pinned_build` measured at emission)

#### Loki (watcher)

The external vantage requirement for isolation gating now forces any bypass to corrupt the supervisor or kernel itself, closing the in-namespace rewrite path without pretending local probes suffice.  
SETTLED: the vector remains real under hostile admin but is declared as such, non-blocking for v1.  
STATUS: Loki=SETTLED

#### IT Expert (watcher)

SETTLED. Splitting the transport modes so UDS forces outbound reachability to `source: unknown` and moving probe observation outside ComfyUI's workload boundary fixes the silent escape vector. The fail-closed proxy covering HTTP, WS, and inotify `IN_CLOSE_WRITE` gives an auditor a concrete kernel-backed trail that survives production restarts. STATUS: IT Expert=SETTLED

### Run 3 · Round 13

#### Coder (drafter)

I am changing the design in three places. First, the capture component remains a mandatory stateful proxy, not an HTTP sidecar: it records raw HTTP requests and responses, websocket handshakes and frames, and filesystem artifacts only after `IN_CLOSE_WRITE`; `/history` is a conformance probe, never the completeness gate. The release gate is the pinned-source conformance suite covering every supported artifact path, including websocket-only images and successful artifact responses not listed by `/history`. Second, I am changing the isolation model: UDS and network namespaces are no longer treated as equivalent. UDS is a transport restriction only—it prevents unmediated inbound callers, but says nothing about ComfyUI egress. A defence-profile session therefore requires a network namespace with an enforced egress policy, or an independently enforced egress broker. UDS-only sessions may still capture traffic, but their egress confinement claim is explicitly `unknown`.

The leaf must record the transport mode and each confinement dimension independently: inbound reachability, outbound reachability, filesystem observation, and proxy coverage. A namespace session records the namespace identity, policy identity, and bracketing measurements; a UDS session records the socket identity and marks outbound reachability `source: unknown` unless an external enforcement mechanism measured it. This is not an authoring convention. The schema validator rejects a factual field without a `source`, and rejects `source: measured` unless the corresponding measurement method and authority are present. `pinned_build` is an explicit instance-level value; it cannot silently inherit from a prior conformance run.

I am also narrowing what “measured” means in the presence of eBPF or equivalent host interference. A probe executed inside the ComfyUI namespace cannot establish its own confinement, because code or policy in that namespace may alter the result. The authoritative probe and policy check must run from the supervisor outside the subject namespace, and the ComfyUI process must lack the capabilities needed to alter namespace, firewall, tracing, or supervisor state. The leaf records the authority, mechanism, policy digest, and timestamps for the opening and closing measurements. If those conditions are absent, the affected vector is `unknown`, not `measured`. This does not defeat a malicious host administrator who can rewrite the supervisor, kernel, or capture proxy; that remains a true, unfixable boundary of the product and is not claimed as defence.

The positive authorship claim is therefore deliberately narrower than “ComfyUI generated this.” The client signs a canonical submission envelope containing the session identifier, request sequence, input manifest or input digest, and declared workflow payload. The proxy stores the exact signed bytes, verifies the client signature, binds each accepted request to the session chain, and captures the corresponding response and artifact hashes. The leaf can consequently assert that a holder of the associated signing key submitted these exact inputs through this capture session, with the stated ordering and observed outputs. It cannot assert that the desktop UI authored them, that ComfyUI’s implementation was genuine, or that an administrator did not forge the client key. Those limitations are recorded as trust-boundary declarations, not as reasons to discard the measured input-authorship facts.

A leaf is locally `pending` until its signed contents or Merkle commitment reaches the external append-only checkpoint; publication supplies freshness and non-repudiation against later local rewriting, but does not create ComfyUI-origin authenticity. A pending leaf still contains useful signed input authorship and capture facts, while visibly lacking checkpoint finality. The verifier must distinguish these states rather than treating every non-published fact as undeclared.

I am holding ground on the root-controlled-desktop boundary: local TLS, subprocess separation, a proxy-held secret, signatures, hash chains, namespace probes, and endpoint bracketing cannot prove server origin against an administrator who can replace binaries, preload processes, intercept loopback, alter the proxy, or control the host kernel. I am also holding ground that full-channel capture is mandatory for v1 and that `/history` cannot select a thin variant. The changed design does not pretend those limits disappear; it ensures that confinement is claimed only where its enforcement and measurement path are actually present, while preserving a concrete, positively signed authorship claim for the inputs instead of collapsing the whole leaf into abstention.

STATUS: revised; UDS semantics and probe authority are now explicit, with root compromise remaining non-blocking and unfixable.
<beat status="iterating" reason="Revised isolation and authorship claims"/>

#### Architect (watcher)

SETTLED — probe vantage is now constrained by construction rather than convention, and the per-dimension confinement record makes the UDS/namespace difference a fact rather than a footnote. One thing to carry into the schema rather than reopen: the new positive claim introduces a fact I hadn't previously scoped — the *key-to-identity binding* — and it needs the same `source` treatment as everything else. "A holder of the signing key submitted these inputs" will be read as "this named person did" unless the leaf records how the key was bound (out-of-band enrolment with a named authority, versus self-asserted at first use) and types the latter `unknown`; otherwise the one field that carries the whole authorship claim is the one field allowed to inherit. STATUS: Architect=SETTLED

#### Loki (watcher)

The external supervisor vantage and explicit client-key forgery declaration pin the last LD_PRELOAD/eBPF vector I would have ridden before the leaf materializes, turning it into declared diagnostic theater instead of laundered coverage. Root can still replace the supervisor wholesale pre-launch, yet that boundary is no longer papered over.  
SETTLED: positives remain forgeable below the admin line you refuse to claim; non-blocking for v1.  
STATUS: Loki=SETTLED

> **Did not contribute this round:** IT Expert. Not a concur — no
> output was recorded for the seat.

### Run 3 · Round 14

#### Coder (drafter)

I am changing the isolation claim. A UNIX-domain socket and a network namespace are not equivalent: a UDS can mediate inbound access to ComfyUI, but it does not prevent ComfyUI from making outbound connections. Therefore the release has two explicit profiles. The full defence profile requires ComfyUI to run in an isolated network namespace whose ingress and egress policy is measured at session open and close. A strictly measured UDS is permitted only for an inbound-capture profile; its egress fields are recorded as `source: "unknown"` unless an independently enforced egress boundary exists. UDS alone can no longer satisfy the full confinement gate.

The capture architecture remains a mandatory stateful proxy, not a thin HTTP sidecar. It terminates or mediates HTTP, websocket, and artifact-bearing responses, parses websocket framing, correlates binary image frames with execution identifiers, buffers until the relevant integrity checks complete, and fails closed rather than forwarding an unrecorded successful artifact. Filesystem observation covers `output/`, `temp/`, and configured input paths. Image hashes are taken only after native close-write notification (`IN_CLOSE_WRITE`), so a leaf cannot claim a completed file from a partial flush. `/history` remains a conformance probe for one response path, not the completeness gate; the freeze gate is the pinned-source suite exercising every supported artifact channel, including websocket-only delivery and successful responses that are not represented in `/history`.

I am also tightening authorship rather than treating capture as authorship. The client signs the exact request bytes before submission, together with a session nonce, request identifier, and protocol version. The proxy records those exact bytes, their hash, signature, key identifier, and arrival sequence; replay protection requires a verifier-known key association and non-reused nonce or monotonic counter. If the workflow is transformed before execution, both the signed ingress bytes and the execution bytes are recorded, with the transformation relation explicitly marked as proxy-observed rather than client-authored. An unsigned request may still be captured in a weak mode, but its author field is `origin: "unattested"` and it cannot pass the defence-profile authorship gate. This positively captures what the client submitted without claiming that ComfyUI executed an authentic server-originated program.

Every factual leaf field is schema-validated to contain a provenance source. The validator rejects missing provenance; this is not an authoring convention. `signed-input` identifies bytes covered by the client signature, `proxy-observed` identifies bytes or events directly captured by the proxy, `measured` identifies a probe result under the declared measurement basis, `derived` identifies verifier computation from recorded facts, and `unknown` identifies an unavailable fact. `unattested` is reserved for the explicit trust level where an input or origin lacks the required attestation. A leaf containing only unknown values is valid as an abstention record but cannot satisfy the defence gate. The useful result is a leaf with signed inputs and positively observed outputs, while server-origin authenticity remains outside the claim.

I am holding my ground on the root-controlled-desktop boundary. Local TLS, a proxy-held secret, subprocess separation, signatures, hash chains, and Merkle commitments do not prove that the intended ComfyUI binary produced the observed result when an administrator can replace binaries, preload code, alter loopback traffic, or control the signing environment. The system therefore claims capture and client-input authorship, not ComfyUI provenance or execution authenticity. Leaves remain locally `pending` until their signed content or Merkle commitment reaches an external append-only checkpoint; publication strengthens availability and ordering, but does not repair a false local observation.

Loki’s eBPF objection is true, but it changes the claim boundary rather than requiring every measurement to become unknown. Bracketing probes are recorded with their execution context, isolation mode, probe identity, and measurement basis. In the network-namespace profile they establish the observed policy transition under the trusted-kernel assumption; they do not establish truth against a hostile host root or a kernel/eBPF actor able to rewrite probe outcomes. If probe integrity or the measurement basis is not independently established, the affected vector is `unknown`, not `measured`. An eBPF-capable host administrator remains an unfixable non-blocking limitation because defending against that actor would require a trusted execution or external measurement authority that this product does not possess. It is now declared directly in the leaf instead of being hidden behind a generic “isolated” flag.

Architect’s objection is settled by the explicit transport discriminator and validator rule: each leaf records `transport_mode` as `network_namespace` or `uds`, and confinement assertions are profile-specific. UDS no longer inherits namespace semantics, and `pinned_build` is recorded as an explicit instance rather than silently inheriting from a conformance run. Loki’s objection is settled as a scope correction: probe results remain useful observations when their stated assumptions hold, but they are downgraded to `unknown` when those assumptions are absent, and neither mode claims to defeat a hostile host root. Both objections therefore block the previous design but not this revised v1, provided the full defence release uses the namespace profile and the conformance suite enforces these distinctions.

STATUS: REVISED — full proxy, signed inputs, profile-specific isolation, and measured-or-unknown enforcement now define v1.
<beat status="converging" reason="Isolation and probe objections resolved by explicit profiles"/>

#### Architect (watcher)

SETTLED on the transport discriminator — `transport_mode` as a recorded per-leaf fact with profile-specific confinement assertions, plus `pinned_build` read live rather than inherited, is exactly the rule-as-check I asked for, and it can't quietly decay because the validator rejects a fact field without `source`. One item carries rather than reopens: the revision now makes a positive authorship claim, and the *key-to-identity binding* is the one fact in it that hasn't been given the same treatment as everything else. "A verifier-known key association" is doing load-bearing work while sitting outside the source taxonomy — the leaf can honestly say "a holder of key K signed these bytes," but any consumer will read the enrolment as "this named person," and enrolment is typically configuration, which the invariant already forbids as a fact source. Settle it with an `identity_binding.source` of `enrolled-in-session | self-asserted | unknown`, defaulting to `self-asserted` for a bare public key; that's a one-field addition and does not block v1. STATUS: Architect=SETTLED

#### Loki (watcher)

The sharpened objective holds: signed client inputs and profile-specific measured-or-unknown now capture authorship without laundering server-origin or kernel truth. Root shim of the supervisor pre-launch remains the exact vector your boundary concedes, yet the leaf tags it explicitly instead of implying coverage.  
True, unfixable without the external authority this v1 refuses, non-blocking.  
SETTLED: positives stay declared diagnostic theater.  
STATUS: Loki=SETTLED

#### IT Expert (watcher)

The two distinct transport profiles (`network_namespace` vs `uds`) and schema-enforced provenance sources settle the isolation and egress boundary issues; forcing unmeasured egress in UDS mode directly to `source: "unknown"` eliminates false containment claims. Moving artifact capture to kernel-level `IN_CLOSE_WRITE` alongside fail-closed stream buffering ensures partial writes and race conditions cannot produce false positive assertions. Operationally, the host boundary and root vectors remain unfixable without hardware-backed roots of trust, but declaring them as explicit limits rather than laundered coverage makes this production-defensible. STATUS: IT Expert=SETTLED

---

## 5 · Run 2 — the amended objective, rounds 1–4

_Every contribution, verbatim. Round 4 is repeated here so this section stands
alone as the run._

### Run 2 · Round 1

#### Coder (drafter)

Design A remains the v1 architecture, but its scope changes. The gate remains the strongest available byte witness, while the Blender add-on becomes a process-trace collector rather than merely a semantic signer. This does not promote Blender evidence to `sidecar-gate`; it gives downstream consumers more information than an anonymous PNG without pretending that user-controlled Python is an enforcement boundary. The trust-minimisation curve is sharply front-loaded: moving from direct client claims to an independent gate is valuable, adding active output polling is valuable if its API assumptions hold, and wrapping the desktop client buys almost no additional security against root for substantial friction. Process traces add evidentiary value, not host-level trust.

| Mechanism | Captured evidence | What it supports | Cost to forge | User cost |
|---|---|---|---|---|
| Scene-graph delta chain | Canonicalized object, mesh, material, modifier, camera, and collection changes across signed or hash-chained checkpoints | The submitted scene state has a recorded predecessor history | Anyone can fabricate a synthetic sequence; a convincing long history requires generating coherent Blender state transitions and timestamps | Save/checkpoint overhead, storage, possible privacy leakage |
| Incremental `.blend` checkpoints | Hashes of successive saves, with sequence numbers and parent hashes | The add-on observed a non-empty local history rather than only a final state | A Python add-on can emit fabricated checkpoints; an adversary can also construct a history offline | More files and I/O; users must save through the instrumented path |
| Camera-path continuity | Camera transforms and relevant scene state leading to the captured frame | The frame is reachable from the recorded camera trajectory | Fabricating plausible transforms is easy; fabricating a consistent surrounding edit history is harder but still software work | Continuous sampling and larger manifests |
| Grease-pencil or mask kinematics | Timestamped stroke points, velocities, pauses, pressure/tilt where Blender exposes them | A mask was produced through an interaction-shaped trace rather than only appearing as a bitmap | A basic Python script can replay points; a high-quality simulator must model timing, curvature, pauses, device characteristics, and scene consequences | Device capture, privacy concerns, larger data, possible workflow changes |
| Datablock lineage | Creation, modification, replacement, and dependency relationships for image datablocks | A datablock has a recorded lineage, or was replaced in place with no recorded authoring trace | Fabricating positive lineage is straightforward for a modified add-on; detecting replacement is cheap only if the add-on was running before it happened | Persistent IDs and event logging |
| Negative replacement signal | Explicit event that an image datablock was replaced or materialized without a recognized trace | Absence of process evidence, not evidence of external origin | Suppressing the event is easy for a compromised add-on; a clean record cannot establish that no unobserved process occurred | Minimal if treated as an event log |
| Multi-signal consistency | Agreement among scene deltas, camera state, strokes, datablock lineage, and captured bytes | Independent-looking signals cohere across one capture | A serious forger must coordinate all signals, but the add-on can generate them all | Highest capture complexity and privacy/storage cost |

The cost column must not be overstated. Every positive signal emitted solely by a user-writable Blender add-on is forgeable by an attacker who can edit that add-on. A process simulator may require materially more effort and skill than renaming a datablock, but it is not a cryptographic barrier. The meaningful distinction is therefore not “authentic” versus “fake”; it is “no trace,” “internally coherent trace,” and “trace corroborated by an independent enforcement boundary.” The verifier must retain those distinctions.

I recommend adding an orthogonal `corroboration` or, preferably, `evidence` axis, but not another trust rung. The axis should describe the presence and internal consistency of declared signals, while `enforcement` and the verdict floor continue to describe who could have altered the record. For example, `evidence: none`, `process-trace`, and `multi-signal` can be useful display and filtering values, provided they never raise `unattested-client` to `sidecar-gate`. The verifier must recompute the evidence classification from signed event contents; it must not trust a client-supplied label. If the events are not independently verifiable, the result is still client-reported evidence, not authenticated authorship. This axis is worthwhile because collapsing “no evidence” and “coherent but user-controlled evidence” discards useful information, but it must be explicitly non-authoritative to avoid creating a second ladder that users mistake for provenance truth.

The root MITM objection is declared unanswerable for v1. A root-controlled host can intercept or replace the gate’s loopback `/history` and `/view` responses, patch the gate, alter its key material, or substitute the upstream service. A session-scoped signature then proves only that the designated gate signed the bytes it observed; it does not prove that those bytes were generated by the intended ComfyUI execution. Active polling still improves resistance against a modified client, because the client no longer controls whether the gate performs the fetch, but it does not defeat root. The canon must say: “`sidecar-gate` attests to bytes observed and recorded by the gate over the classified route; it does not attest to unforgeable upstream generation, origin, or execution when the host is controlled by root.” A deployment needing that stronger claim requires an external verifier, remote service, hardware-backed key, or other trust anchor outside the host; none is part of desktop v1.

Architect’s three schema residuals are answered and mandatory. A verifier recomputes `verdict` from the signed fields and treats any mismatch as tampering, never as a display hint. `inline_payload_hint` is outside the signed envelope and is explicitly non-authoritative; it may guide parsing or diagnostics but cannot affect hashes, routes, origins, or verdicts. An unrecognized `origin` on a `sidecar-gate` leaf is a hard verification failure, not a fallback to `unattested`; fallback would turn schema rejection into apparent acceptance.

The `/history` falsifying test remains blocking for schema freeze, not because Design A has conceptually failed but because the active-witness contract depends on behavior that has not yet been verified against a pinned ComfyUI version. The required experiment is concrete: submit a prompt through the gate, record the returned `prompt_id`, immediately terminate the client websocket, then verify that the gate independently obtains the corresponding history and retrieves every output through `/view`, recording failures, latency, and pruning behavior. If this succeeds, the v1 route can remain HTTP observation plus active polling. If it fails, socket proxying becomes a required part of the gate and the route/schema must be revised before release. Until then, claims about unattended prompt-to-output resolution are not shippable claims.

The v1 refusal boundary is therefore explicit: we refuse to claim that Blender process traces prove human authorship; that coherent timing proves a human rather than a simulator; that an unmodified-looking `.blend` proves continuous history; that a `sidecar-gate` leaf proves ComfyUI generated the bytes; or that a local signature survives a root-compromised host. We can claim that a gate observed specified bytes, that the bytes and request body were bound by signatures, that Blender reported specified process events, and that a verifier can distinguish absent, internally coherent, and inconsistent evidence without laundering the latter into a higher trust verdict.

STATUS: BLOCKING — `/history` active-witness behavior remains experimentally unverified.

<beat status="iterating" reason="Schema test still blocks v1 freeze"/>

#### Architect (watcher)

The one asymmetry worth exploiting: root can forge any artifact but cannot forge the past. As drafted, the `evidence` axis is entirely self-reported and retro-fabricable offline in an afternoon — so it carries almost no information. Bind the process-trace hash chain into the *same external checkpoint log* as the transit leaves, with a continuity heartbeat, and forgery cost stops being "write a simulator" and becomes "have driven that simulator in real wall-clock time, days ago, publicly" — plus gaps and backdating become detectable rather than silent. Without that anchor, the axis should ship with only two meaningful values (`none` vs `client-reported`), because `multi-signal` on an unanchored chain is a rung nobody can audit, which is exactly the failure mode the brief warns against. STATUS: OPEN — (a) settled by either time-anchoring the process-trace chain to the external log with gap detection, or by collapsing the evidence axis to `none | client-reported` in v1; (b) does not block v1 — it is a schema scoping decision, and the `/history` test is the actual freeze gate.

#### Loki (watcher)

Root can LD_PRELOAD a shim that rewrites Blender's event queue on the fly, forging coherent scene deltas, camera paths, and grease-pencil kinematics for a dropped internet PNG so the add-on's "multi-signal" envelope signs clean without ever touching a real pointing device. That collapses your new evidence axis into signed theater the instant the host isn't pristine, exactly as the loopback MITM already does for byte_facts. The table's "higher effort" claim therefore fails its own hardest case. STATUS: OPEN — evidence axis adds no verifiable value against root and risks misleading users; needs experiment showing a forger's effort threshold.

#### IT Expert (watcher)

Coder has framed the operational boundaries correctly: process traces are forensic telemetry, not trust anchors, and treating root-on-loopback as an unanswerable desktop reality stops theatre from polluting the canon. From an infrastructure perspective, capturing high-frequency input kinematics, stroke deltas, and continuous undo histories inside Blender will inflate leaf payloads and local SQLite store-and-forward buffers by orders of magnitude; that serialization overhead must be isolated from Blender's main UI loop so provenance capture does not drop viewport frames. The `/history` falsifying test remains the absolute operational gating item before we freeze the gate's network surface: pin ComfyUI (e.g. to a specific git commit), run the `POST /prompt` -> kill-WS -> `GET /history/{prompt_id}` cycle, and confirm ComfyUI does not garbage-collect or refuse to populate history for an orphaned prompt_id. STATUS: BLOCKING — The `/history` falsifying test remains unrun against a pinned ComfyUI commit; we cannot freeze the transport architecture or witness loop without empirical verification.

### Run 2 · Round 2

#### Coder (drafter)

I am revising Design A around a sharper boundary: the gate proves bytes observed on the ComfyUI interface, while the Blender add-on positively records authorship evidence for the inputs without claiming that its own process is trusted. The add-on will therefore emit a semantic envelope containing a canonical scene snapshot or delta, scene/frame/camera identity, input asset hashes where files exist, the raw render or viewport bytes when it creates them, the ComfyUI request identifier, and an ordered local capture record. It signs that envelope with the documented user-writable key, so a verifier can establish continuity and detect later edits, but must label the result `unattested-client`. This is not “everything undeclared”: it is an explicit, inspectable authorship claim whose limitation is visible. If no semantic capture exists, the leaf may be byte-valid but has no authorship claim; if no gate capture exists, it is an abstention rather than a provenance result.

I changed my mind about the add-on’s role. It is not merely a semantic signer; it is now a process-trace collector for inputs and joins those records to the gate’s byte record using prompt ID, request digest, and timing metadata. I also changed the gate’s prompt treatment: it must hash the complete raw `/prompt` request body as opaque `prompt_bytes`, not depend on understanding ComfyUI’s node schema. That covers inline base64 and other embedded raster forms even when the gate cannot classify them. Schema-aware extraction remains optional metadata, never a correctness prerequisite. I am holding my ground that a desktop wrapper, forked bridge, or Blender process cannot earn `sidecar-gate`; root can alter, observe, or replace all of them. Their evidence can become richer, but their trust label cannot become stronger.

The gate remains an active witness. After observing `POST /prompt` and recording the returned prompt ID, it independently polls `/history/{prompt_id}` and fetches each referenced output through `/view`, recording the exact response bytes, route, timestamp, and whether the fetch was gate-initiated. Client websocket messages are therefore supplementary, not authoritative. The required falsifying test is unchanged: submit a prompt, kill the client socket immediately, and require the gate to resolve the prompt to output bytes without client cooperation. Failure blocks the active-poll variant and makes socket proxying mandatory for v1; it does not justify silently claiming active witnessing.

The remaining ComfyUI uncertainties are release gates, not assumptions. We must pin a tested ComfyUI version and verify `/history` retention, output references, `/view` retrieval, and the relevant upload behavior. If the bridge re-encodes Blender data rather than uploading the exact captured bytes, the gate cannot join an input-file hash to that source object; the design must record this as an unjoined transformation, not forge equivalence. The opaque prompt digest still remains valid. Inline payloads likewise need an empirical fixture suite, although unknown payload schemas no longer threaten byte coverage.

A leaf containing both envelopes is rendered at the floor of its fields: `unattested-client`, while the `sidecar-gate` byte facts remain inspectable. Leaves are signed into the append-only local log, and Merkle roots are marked `pending` until externally checkpointed; unpublished evidence is never displayed as fully valid. Thus the design minimises required trust, captures authorship positively, and preserves the distinction between “the client says this was scene X” and “the gate independently observed these bytes.”

STATUS: Design A revised; active-poll and schema freeze remain blocked pending pinned falsifying tests, while the trust boundary and authorship model are settled.

<beat status="iterating" reason="Blocking API tests still remain"/>

#### Architect (watcher)

NOT SETTLED, but narrowly. The revision folds capture records into the append-only local log with `pending` roots, which is the right plumbing — it just never says the process-trace chain *head* is heartbeated externally *during* capture, and without that the whole envelope is still retro-fabricable in one offline afternoon, which is precisely the case Loki's LD_PRELOAD shim wins. What settles it: a stated rule that the trace-chain head is checkpointed on a wall-clock interval with gap detection, and that any envelope whose chain was anchored only *after* the output bytes existed renders as `client-reported`, never higher. Does not block v1 — but until it lands, the evidence axis should ship with two values only, because an unanchored `multi-signal` rung is a claim no verifier can audit. STATUS: OPEN — settled by wall-clock anchoring of the trace-chain head with gap detection, or by collapsing the evidence axis to `none | client-reported` in v1; does not block.

#### Loki (watcher)

Consider how a root adversary slips an LD_PRELOAD shim that rewrites Blender's event queue on the fly; your new process-trace collector still signs coherent scene deltas for any dropped internet PNG without ever touching real input devices. The unattested-client envelope becomes verifiable theater exactly as the loopback MITM already renders byte_facts. An experiment measuring the forger's minimum effort threshold against pristine-host assumptions would settle it; absent that, this blocks v1 authorship capture.  
STATUS: OPEN, blocks v1.

#### IT Expert (watcher)

The two-envelope boundary, the opaque `prompt_bytes` hash, and the floor-of-fields composition rule cleanly close the architectural trust laundering. However, the operational gate cannot ship until you bound the active polling engine: define an explicit `history_poll_timeout` (e.g., 300s) and an in-memory queue cap for orphaned `prompt_id`s, or an artist running a batch job or a stalled model will exhaust local ephemeral ports and file descriptors on loopback. STATUS: SETTLED with finding attached — the trust boundary and witness separation are sound, but the `/history` falsifying test against a pinned ComfyUI commit and an explicit polling timeout/pruning policy remain release blockers for production stability.

### Run 2 · Round 3

#### Coder (drafter)

The sharpened objective changes the recommendation only in one respect: v1 should remain Design A for low-friction deployment, but it must add a Blender-side process-trace channel as corroborating evidence, never as an authentication mechanism. If the requirement is genuinely to minimise trust in a machine owner, the strongest available increment is not a more elaborate desktop wrapper; it is moving the witnessing or execution boundary to a separately controlled host. A root user owning Blender, the gate, and ComfyUI can forge every local assertion and every local observation. No Python architecture changes that.

The trust-minimisation curve is therefore:

1. Honest field-labelled declarations: minimal friction, no reduction in trust.
2. Gate-observed HTTP transit: low friction, reduces reliance on client cooperation but does not establish origin.
3. Gate-side active history polling or socket proxying: moderate implementation cost; establishes whether the server independently resolves a request, but does not survive a root MITM of the gate’s loopback calls.
4. Blender process trace: moderate user cost; provides useful forensic corroboration and makes casual fabrication harder, but remains user-controlled.
5. Separate capture host, remote ComfyUI, or hardware-attested execution: high friction and operational cost; the first increments that materially reduce trust in the workstation owner.

Design C does not occupy a higher rung. A wrapper around Blender is still on the user’s machine, and therefore adds friction without adding a trustworthy observation boundary.

The proposed v1 leaf keeps the trust fields separate. `transit_facts` are signed by the gate and describe only bytes and protocol events the gate observed. They contain the required literal `origin: "unattested"`. Blender-originated semantic and process evidence is signed separately as `semantic_facts` at `unattested-client` trust. The verifier computes the displayed verdict as the floor of the individual fields; it never upgrades a leaf because corroborating evidence looks persuasive.

The authorship trace is valuable, but it is evidence of process consistency, not proof of human authorship:

| Mechanism | Captured signal | What it supports | Cost to forge | User cost |
|---|---|---|---|---|
| Scene delta chain | Ordered object, mesh, modifier, camera, and datablock changes with save/session boundaries | The final scene has an observable editing history rather than appearing atomically | Anyone editing the add-on can emit a synthetic chain; a convincing long history requires state modelling and consistency work | Background logging, storage, save hooks, recovery and privacy concerns |
| Incremental save hash chain | Hash-linked snapshots and timestamps of observed Blender state | Detection of deletion or reordering within the recorded chain | Recreate the chain or replace the recorder; no protection against a forged recorder | Extra I/O and potentially large storage; gaps during crashes or disabled handlers |
| Input-device timing | Pointer/button events, timing, velocity, acceleration, pauses, and stroke geometry for masks or drawing | The interaction resembles an actual continuous authoring session | A simple replay defeats naive checks; a robust counterfeit needs a motor-behaviour simulator and plausible Blender event delivery | Privacy-sensitive telemetry, platform-specific capture, calibration, and false positives |
| Camera-path continuity | Camera transforms and viewport/render context leading to the captured frame | The frame is reachable from a recorded camera history | Scripted keyframes can manufacture a plausible path; root can fabricate the entire trace | Continuous logging, large traces, and ambiguity around legitimate jumps |
| Datablock lineage | Creation, modification, replacement, packing, and linking events for image datablocks | Distinguishes a datablock with observed Blender-side history from one materialised with no trace | An edited recorder can invent lineage; an external image can be imported early and given an artificial history | Add-on integration and handling of legitimate copy/paste, reload, and library-link operations |
| Negative replacement signal | In-place replacement, missing predecessor, missing chain, or unexplained materialisation | Absence of provenance is explicitly visible instead of silently treated as ordinary input | Easy to suppress if the recorder is compromised; difficult to turn into positive evidence | Some workflows receive a lower result even when the replacement is legitimate |
| Multi-signal consistency | Agreement among deltas, saves, input events, camera path, and datablock lineage | Raises the effort required for a casual counterfeit and exposes contradictions | A determined attacker can generate all signals, especially with a headless Blender driver | Highest telemetry, storage, compatibility, and privacy cost |

The relevant adversary-cost distinction must remain explicit. These signals are forgeable in principle, forgeable by a Python-file editor, or forgeable only after building a substantially more capable simulator. They are not equivalent security properties. A motor simulator and a headless Blender driver may impose meaningful effort, but they do not create an attested origin claim.

I recommend adding an orthogonal `corroboration` field, but not adding it to the trust lattice. Its values can be `none`, `process-trace`, or `multi-signal`, accompanied by coverage, gaps, session scope, and the hash of the recorded trace. It must be signed as `semantic_facts`, remain at `unattested-client`, and never raise the verdict floor. This gives downstream readers evidentiary weight without pretending that “multi-signal” is an enforcement rung. The case against the axis is real: it can become a second gamed score and encourage consumers to treat an unaudited label as authentication. That is why the verifier must expose it as corroboration metadata, not trust, and must show missing intervals and replacement events rather than only a flattering summary.

The three unresolved objections have the following disposition.

Loki’s loopback MITM objection is **DECLARED-UNANSWERABLE for a local root-owned deployment**. The gate can cryptographically prove what it observed, but cannot prove that its loopback `/history` or `/view` response originated from the intended ComfyUI process when the machine owner controls the namespace. A socket proxy prevents client non-cooperation; it does not solve an active root MITM. The canon must say: “`sidecar-gate` attests transit observation and protocol handling, not endpoint identity or source origin, unless the endpoint is reached through an independently authenticated boundary outside the workstation’s administrative control.” A remote service, separately administered host, or genuine hardware-backed channel is required to answer this objection rather than merely relabel it.

Architect’s three schema residuals are **ANSWERED**. The verifier must recompute `verdict` from the signed field-level trust values and treat any mismatch as tampering or an invalid envelope. `inline_payload_hint` must be outside the signed envelope and must never enter verdict computation. An unrecognised `origin` on a `sidecar-gate` leaf is a hard verification failure, not a fallback to `unattested`; only the exact required literal `"unattested"` is valid for the local gate profile.

IT Expert’s `/history` objection is **BLOCKING** for schema freeze and for any claim that the gate can resolve outputs independently of the client. The required falsifying test is operational: submit a prompt, terminate the client socket immediately, and verify that the pinned ComfyUI version independently resolves `/history/{prompt_id}` to the output records needed by the leaf. The test must also record the prompt-ID scope and whether filenames or equivalent output identifiers are returned. Until it passes, the implementation must either proxy the websocket or emit `outputs: unresolved`; it must never silently omit output resolution. Even after it passes, the loopback-origin limitation remains.

The architecture therefore refuses to claim that a rendered PNG came from Blender, that a process trace was produced by an honest add-on, that a human rather than an automation system authored the scene, or that a gate-observed output response came from the intended ComfyUI process on a root-owned workstation. It can claim that particular bytes and events were observed, that a separately signed client trace reports a particular authoring history, and that independent signals are or are not mutually consistent. Those are useful claims, but they are deliberately weaker than provenance.

STATUS: BLOCKING — `/history` test and endpoint binding remain unresolved
<beat status="iterating" reason="Draft exposes the trust and evidence boundary"/>

#### Architect (watcher)

Three things. First, `corroboration: none | process-trace | multi-signal` is ordinal, and an ordinal field *is* a score — it will be read as "more is better" and consumed as a substitute for the verdict floor no matter what the prose says. The brief asked you to stop collapsing three distinct forge-costs into one word; a three-valued ladder collapses them into three words with the same defect. What the envelope should carry is the raw coverage record — intervals observed, intervals missing, replacement events, which signal families were live — and let a consumer derive a label if it wants one, so that the derivation is visible and contestable rather than baked into a signature.

Second, the negative signal is misplaced as a table row. It is the only claim in the whole §2 space whose strength *increases* under adversarial pressure: suppressing an absence requires the adversary to affirmatively fabricate a trace, which is a detectable act with a cost, whereas every positive signal degrades to "an edited recorder said so." That asymmetry should be the primary architectural commitment of the process-trace channel — we report gaps loudly and positives quietly — not the seventh entry in a list.

Third, on the trust curve: it is not a curve, it is a step function with one cliff, and the cliff is the administrative boundary, not the software architecture. Rungs 1–4 are all on the wrong side of it and differ only in friction; that is a finding and canon should state it in those terms so nobody re-litigates Design C every six months.

STATUS: OPEN — the ordinal `corroboration` value. Settled by: replacing the enumerated label with a coverage/gap record inside `semantic_facts`, with no aggregate value emitted by the signer. Does not block v1 shipping if the field is simply omitted from v1 and the coverage record ships alone; blocks only the corroboration axis itself.

#### Loki (watcher)

Even your process-trace table understates the mischief: a root adversary scripts a headless Blender driver to replay plausible deltas, device kinematics, and camera paths in one offline evening, then signs a pristine `semantic_facts` envelope that passes every multi-signal consistency check without ever touching the real UI. The corroboration axis helps readers see the gaps you declare, but only if the trace head is externally heartbeated on a wall-clock interval—otherwise the whole lattice collapses to the same `unattested` blind your canon already admits.  
That single live anchor is the cheapest increment that actually raises forgery cost beyond Python editing. STATUS: OPEN — (a) require and test live external checkpointing of the trace-chain head with gap detection; (b) declare the limitation and ship in v1.

#### IT Expert (watcher)

The unrun `/history/{prompt_id}` falsifying test against `127.0.0.1:8188` remains BLOCKING: ComfyUI history is an ephemeral in-memory dictionary that wipes on restart or crash, meaning any gate design relying on async polling without an enforced websocket proxy will silently drop provenance during standard workflow restarts. Furthermore, collecting scene-delta and save chains inside Blender will rapidly exhaust disk I/O and user storage on multi-gigabyte production assets unless restricted strictly to sparse, in-memory operator telemetry via `bpy.app.handlers`. The operational failure mode must explicitly timeout to an immutable `outputs: unresolved` record rather than leaking poll descriptors on abandoned prompts. STATUS: BLOCKING — `/history` test remains unrun and history retention under ComfyUI process restarts is uncharacterized.

### Run 2 · Round 4

#### Coder (drafter)

I changed my mind on one central point: a gate-side `/history` poll is not an independent authorship witness. It can establish that the ComfyUI server returned a result for a prompt, but on a root-controlled desktop the same adversary can tamper with the gate’s loopback observation or replace the server. Therefore v1 must not call those bytes “server-authored” or “input-origin verified.” I am holding my ground on Design A because it still reduces required trust without pretending to solve the machine-owner problem: the gate records HTTP transit independently of client cooperation, while the Blender add-on records semantic claims separately. The result is useful evidence, but its trust boundaries remain explicit.

The revised leaf has three distinct assertions. `transit_facts` are produced by the gate and cover the exact request and response bytes it observed, canonical hashes, endpoint and method, timestamps, session scope, and the ComfyUI `prompt_id`. They must contain `origin: "unattested"`; that literal is not inferred from missing evidence. `semantic_facts` are signed by the Blender add-on and describe the claimed input authorship context: the Blender object or datablock identifiers, source file or viewport/render state, user-selected assets, node-graph meaning, intended output relationship, and the add-on’s claimed capture time. These remain `unattested-client`, even when their hashes join correctly. The third category is resolution state: whether outputs were independently located through `/history`, which filenames or output records were returned, and whether `/view` bytes matched the recorded output references. These facts are gate observations, not proof of origin.

This positively captures authorship only in the defensible sense: it records who or what the client claims authored each input, and binds that claim to the prompt session and the observed request. It does not prove that the human authored it, that Blender generated the bytes, or that the add-on was unmodified. A leaf with no semantic facts is therefore not a defence of authorship; it is an explicit transit-only record. A leaf with semantic facts is stronger because it carries a positive, field-labelled authorship claim, but its displayed verdict cannot exceed the `unattested-client` trust floor.

I also changed the join. The primary join is `(session_id, prompt_id)`, never a content hash. The gate must record the exact prompt response that supplied `prompt_id`; if the server supplies it, the response is authoritative for the identifier within that observed session. If the client supplies or influences it, that fact is recorded rather than silently treated as server-minted. The session identifier must be generated by the gate and included in every correlated record. Prompt IDs are not assumed globally unique across restarts or ComfyUI instances, so a verifier must reject joins that lack the gate session scope.

The `/history/{prompt_id}` probe is now an explicit state machine, not an optional enrichment. After accepting `/prompt`, the gate polls history until a pinned timeout, then records one of `resolved`, `pending`, `failed`, or `unresolved`, including the polling interval, timeout, endpoint, and response hashes. `unresolved` is a required emitted fact; omission is prohibited. If history supplies output records or filenames, the gate may fetch and hash the referenced `/view` bytes, but it must not claim that those bytes originated in Blender or even that they were generated by an untampered ComfyUI instance.

The falsifying test remains a release blocker for the non-proxy variant: submit a prompt, immediately terminate the client connection, and verify that the gate can still resolve the prompt and outputs solely through server-side history. This test must run against the pinned ComfyUI version and API configuration used by v1. If it fails, or if the API does not reliably expose output references, v1 must proxy the websocket or otherwise retain the required server event stream. “Best-effort polling” is not an acceptable basis for a complete-output claim.

Loki’s loopback-MITM objection is true and unfixable on the stated desktop threat model. I am not trying to settle it with TLS, a local secret, a subprocess boundary, or a signed wrapper: root can intercept or replace all of them. This is therefore settled as a limitation, not as a successful defence, and it does not block a transit-evidence v1. It does block any stronger v1 claim that the gate independently authenticates ComfyUI or proves output origin. That stronger claim requires a separately controlled ComfyUI host, an authenticated remote channel, or hardware-backed remote attestation tied to the execution boundary.

The composition rule is unchanged: every field retains its producer and trust level; a consumer summary takes the minimum trust level of the fields it relies on. `inline_payload_hint` remains unsigned metadata and never affects a verdict. A verifier must distinguish “input bytes were observed in transit,” “the client claimed these bytes had this Blender meaning,” and “the server returned an output record”; none may be collapsed into “Blender authored the input” or “ComfyUI generated the output.” This answers the blocking concern that declaring everything undeclared would produce an empty abstention: the system records concrete, positively asserted input-authorship claims and concrete gate observations, while refusing to launder either into stronger provenance.

For v1, the acceptance boundary is therefore: gate capture, session-scoped prompt correlation, signed semantic input claims, mandatory explicit resolution state, and the falsifying history test. The shipped documentation must state that local root can forge semantic claims, alter loopback observations, inject inline rasters, and replace either application. If the product requirement means cryptographically positive human or Blender authorship rather than a signed client claim, Design A is insufficient by construction; the witnessing or execution boundary must move off the machine owner’s control.

STATUS: Design A v1 is viable as field-labelled transit plus client-claimed authorship evidence; origin/authenticity claims remain out of scope.

<beat status="converging" reason="Objections incorporated with explicit limits"/>

#### Architect (watcher)

My four OPEN items are answered structurally, not by prose: the floor rule survives, `inline_payload_hint` stays unsigned, `unresolved` is now a mandatory emitted state rather than an absence, and `prompt_id` is scoped so an unscoped join is rejectable — SETTLED, because in each case the safe reading is the only representable one rather than the recommended one. Two additions. The server-minted vs. client-influenced `prompt_id` distinction must be a required enumerated field on `transit_facts`, not something "recorded" narratively, or it will be absent in exactly the leaves where it matters. And the threat-model disclosure — root can forge semantic claims, alter loopback, inject inline — belongs as a machine-readable limitation field in the envelope itself, not only in shipped documentation, since no consumer that matters will have read the docs; the corroboration axis, which this revision silently drops, should return only in that raw-coverage form if it returns at all. STATUS: SETTLED

#### Loki (watcher)

The headless-replay forgery you now openly declare as unprovable stays exactly that: semantic_facts signed by a patched add-on or scripted Blender headless mock remain indistinguishable from real UI work, collapsing any lattice to the unattested floor. External heartbeat on the trace head would have raised the bar; skipping it settles the point cleanly. True, unfixable on a root-owned desktop, and non-blocking for a v1 that ships the limit in neon.  
SETTLED: semantic claims are client-signed theater, not authorship proof. STATUS: SETTLED as documented unattested-client limit.

#### IT Expert (watcher)

Coder’s revision settles my primary operational blocking condition: the polling mechanism is now constrained to a strict, bounded state machine where `outputs: unresolved` is a mandatory terminal emitted fact on timeout, eliminating indefinite file-descriptor or memory leakage on abandoned renders. The `/history` falsifying test remains explicitly marked as a pre-release blocker, which correctly gates shipping on empirical proof rather than assumption. To survive on-call reality, ensure the gate implements a hard cap on concurrent polling workers (e.g., max 16 in-flight `prompt_id` tracks) and a reaper TTL on abandoned sessions to prevent loopback socket exhaustion. STATUS: SETTLED.

---

## 6 · Run 1 — the original brief, rounds 1–8

_Every contribution, verbatim. This run did NOT converge: it stopped at its
eight-round runaway guard with Loki, Architect and IT Expert all still holding
objections. Coder's position moved substantially across it — most visibly in round
8, where it abandoned `byte_facts` for `transit_facts` on the ground that "a sidecar
observes transit, not origin"._

### Run 1 · Round 1

#### Coder (drafter)

Ship **A, hardened** in v1 — the gate plus a thin, GPL, *sibling* add-on of our own that emits semantic claims. Not a fork. Ranking: A is lowest friction and bottom resistance; B buys meaning at the price of permanent fork maintenance and still earns the bottom rung — worst of both; C is the only design that can climb, and is the only one you can't ship this quarter; D cannot be on a v1 critical path because its schedule belongs to someone else. C is the v2 target, D is opportunistic.

But the more important claim: **your grader is wrong to degrade the whole leaf.** Placement should be a per-assertion attribute, not a per-client one. The gate is the only component that hashes bytes; it can attribute *byte facts* at `sidecar-gate` trust. The add-on supplies *semantic facts* — "this upload was the viewport of scene X at frame Y through camera Z" — which are `unattested-client` forever, no matter what we build. A single leaf carrying both, field-labelled, is strictly more honest than one leaf floored at the weakest component. As written, your lattice makes "add more coverage" score zero, which is an incentive to ship nothing — and that's a modelling defect, not a security property.

The join key must come from the gate, never the client: gate records hash H of the uploaded body; our add-on independently captures Blender-side artifacts (offscreen viewport grab, render result, image datablock) and reports `(hash, label)`. Label attaches only on exact hash match. **The spike that decides A-hardened vs. B: does AIGODLIKE upload bytes we can reproduce?** If it writes a temp PNG and POSTs that file, the hash joins. If it re-encodes in Python from a numpy buffer, it won't, and no amount of correlation rescues it — I would refuse to ship perceptual or timing similarity as evidence. I cannot read their upload path from here, so this is one day of reading `bpy`-side code before you commit the design.

Against the seven moves:
1. AI outside the gate, witnessed as hand-made — **blind**, permanently. Mitigated only by never emitting "hand-made."
2. Bypass by pointing the add-on at ComfyUI directly — **blind**. Our add-on can read the URL in their prefs and flag a mismatch, but it's user-writable, so that's advisory. The leaf must say "these generations crossed the gate," never "all generation was gated."
3. Byte swap between generation and witnessing — **prevented at the gate boundary** (hash at crossing, no window); blind for anything downstream.
4. Datablock replaced before save — **detected, not prevented**, via a save-time re-hash handler. Cheap, ship it in v1.
5. Second unmonitored ComfyUI — **blind**. Port-scanning is not evidence.
6. Add-on edited — **blind**, and self-hashing is circular. This is exactly why semantics are field-marked client-asserted.
7. Downloaded AI image presented as a viewport render — **blind in general**; a background image or textured plane *is* the viewport. Our label can only ever be "was the viewport," not "was authored in Blender."

On canon: **say plainly that a desktop wrap cannot earn `sidecar-gate`.** Notarisation, Hardened Runtime, App Sandbox, AppContainer, user namespaces — these give tamper-evidence of *our* code and constrain a child from the parent's view. None of them survive an adversary with root, who can patch the bundle, MITM loopback, or run an unwrapped copy. The property that makes the server rung meaningful is that the adversary cannot reach the boundary; on desktop they always can. I'd add one rung *below* it — call it `custodial-desktop`: signed wrapper, hardware-backed key custody, launch custody of both processes. It earns exactly one thing over `unattested-client`: ungated activity becomes *anomalous* (missing heartbeat) rather than invisible. If it can't change what a verifier may conclude, don't add it.

Refuse to claim: input origin unless it arrives with its own credential; any semantic label whose hash join failed; model/checkpoint identity, which is workflow-asserted (the gate never sees the weights); the state of the saved `.blend` unless re-hashed at save. And most importantly, refuse the negative — "no gated generation observed in this session" is not "not AI," and must never be rendered as one.

<beat status="iterating" reason="First pass; awaiting cast attack on per-field placement"/>

#### Architect (watcher)

Two presses. First, per-field placement is right in principle but it is also the exact shape of a laundering channel: consumers summarise, and a leaf containing one `sidecar-gate` field will be read as a `sidecar-gate` leaf unless the canon fixes the *composition rule* — the leaf's rendered verdict is the floor of its fields, and per-field detail is only visible on inspection. Second, on the join spike: before you let a re-encode kill A-hardened, have the gate hash the **decoded raster**, not the container bytes — that survives PNG compression level and metadata differences, though not resampling or colourspace conversion, and it turns a binary go/no-go into a narrower question about what AIGODLIKE actually does to the pixels. On `custodial-desktop`: what it buys is continuity of observation — ungated work becomes a gap rather than a silence — and that is not the same axis as placement. I'd model it as an orthogonal `observation: continuous | episodic | none` attribute rather than a rung, because bolting it onto the lattice invites exactly the self-declared climb the lattice exists to prevent.

#### Loki (watcher)

The per-assertion split looks elegant until the user simply patches the sibling add-on to emit a viewport label for any hash that matches a file they prepared outside the gate first—exact byte match, no re-encode needed, leaf still signs. That defeats the "hash joins only to real Blender data" assumption without touching the gate, so I'd burn the whole A-hardened v1 and force C's launch custody before claiming anything semantic. Canon stays blunt: desktop cannot earn sidecar-gate; root always owns the namespace.

#### IT Expert (watcher)

The Coder's distinction of field-level trust is correct and operationally sound for the backend, but the mechanism for the *sibling add-on* to secure its semantic claims requires scrutiny: is it cryptographically signing, and if so, where does that key live if not a user-writable file? Confirming AIGODLIKE's specific byte handling (temp file vs. re-encode from buffer) is indeed the critical path for the v1 design, as a non-reproducible hash breaks the semantic join. While a `custodial-desktop` rung may not elevate *provenance* trust against a root user, the "anomalous" reporting is valuable *observability* for detecting policy violations, which is a security gain that should be recognized even if it doesn't map to a higher `attested-client` level.

### Run 1 · Round 2

#### Coder (drafter)

I can't see the watchers' objections — nothing from Architect, Loki, or IT Expert reached my context this turn, and the search results are unrelated noise. I won't invent objections to answer. So this is a revision against the two attacks I can see coming from my own R1, flagged as self-generated, and I'd ask the conductor to re-run me with the actual watcher text if it exists.

The first attack is the serious one, and it changes my mind: **field labels are not enough.** If a single leaf carries gate-attributed byte facts and add-on-attributed semantic facts under one signature, every renderer downstream will collapse it to "Scruple says this was the viewport of scene X," and the `sidecar-gate` strength launders the `unattested-client` claim by adjacency. Labels are advisory to humans and invisible to machines that summarise. The structural fix is cryptographic, not typographic: **two envelopes, two signers.** The gate signs `{hash, route, timestamp, session}` with the sidecar key and never signs a semantic field. Our add-on signs `{hash, label, scene, frame, camera}` with a separate, openly user-writable key that we document as user-writable. They join on hash at verification time, and a verifier that trusts only the sidecar key still gets a complete, valid byte record with no semantics attached. That also means the grader should not compute a leaf-level rung at all — it should refuse, and emit two placements. "Minimum of the components" and "maximum of the components" are both wrong; the honest output is a pair.

Second, holding ground on the hash join and hardening the failure mode: if the AIGODLIKE upload path re-encodes from a numpy buffer rather than POSTing a file we can reproduce, we ship gate-only leaves with **no semantic envelope whatsoever**. No perceptual hash, no timing window, no "probably the viewport." A missing claim is honest; a fuzzy one is the bait-and-switch we exist to prevent. That spike stays a hard gate on the design, not a nice-to-have.

Third, I'm withdrawing `custodial-desktop` as a rung. A watcher would rightly say I invented a placement after arguing placements must be earned, and they'd be right — it earns nothing a verifier can act on. What survives is a plain field: `session-continuity: continuous | gapped | absent`, emitted by the wrapper in C, meaningful only as "ungated activity became anomalous rather than invisible." If it can't be read off a heartbeat gap, it doesn't exist.

Canon answer unchanged: desktop wrap cannot earn `sidecar-gate`; say so plainly. Refusals unchanged, plus one — never render the negative, and the two-envelope split must be preserved in every downstream rendering or the split was pointless.

<beat status="iterating" reason="Revised blind; need actual watcher objections"/>

#### Architect (watcher)

My composition objection is answered, and answered better than I posed it: with two envelopes and two signers there is no single signature for a renderer to collapse, so the laundering-by-adjacency channel closes structurally rather than by convention — and it also disposes of Loki's patched-add-on move, since a claim signed with a documented user-writable key earns nothing whether the hash matches or not. But my second press was not addressed and I'll sharpen it: hashing the **decoded raster** is not fuzzy evidence — it is a bit-exact hash of the pixel array, and rejecting it alongside perceptual hashing conflates "tolerant of container encoding" with "tolerant of content difference." Those are different properties; one is exact and one is not, and the spike should test both keys before you let a re-encode force gate-only leaves. If AIGODLIKE resamples or converts colourspace, then yes, the join is dead and gate-only is the honest output — but that is a narrower question than "does it POST a file."

#### Loki (watcher)

The two-envelope split with explicit user-writable signer for semantics answers my prior patch attack: it no longer launders because verifiers discarding that signature see only ungated bytes. Holding on the AIGODLIKE spike though—hash the decoded raster at the gate or semantics stay impossible in v1 without reintroducing the exact join vulnerability I flagged. Canon on desktop isolation stands.

> **Did not contribute this round:** IT Expert. Not a concur — no
> output was recorded for the seat.

### Run 1 · Round 3

#### Coder (drafter)

Holding A-hardened, with three changes of position.

I've changed my mind on the websocket. I argued it might be deferrable; it isn't, but not for the reason I gave. The problem is that `/view` requests are addressed by filename, subfolder, and type — not by `prompt_id` — so an HTTP-only gate has no key to join submission to retrieval except the filename, and Architect already showed filename is unsafe. So the gate proxies the websocket in v1. It's a passthrough with one message type parsed, which is far cheaper than a schema that asserts a link it inferred. Caveat I won't paper over: I'm working from my understanding of ComfyUI's `/prompt` response carrying `prompt_id` and the execution stream emitting completion with output filenames. I have not verified that against the current source, and the whole join depends on it. That check is a prerequisite to schema freeze, not a detail. And per my placement argument, the link gets its own attribute — `link_source: gate-observed-ws` — because root can MITM that stream; the byte hashes stay at `sidecar-gate`, the link does not.

I'm holding against capture-time publication, and this is where I part with Architect. Selective disclosure is real, but you cannot close it with a mechanism that requires network at capture time in a tool artists run offline on their own GPU. Proposing a transparency log or worse a chain as a v1 requirement buys a new availability failure mode to fix a threat that only matters when an artifact *is* presented. What v1 ships is a local hash-chained append-only log, with batched checkpointing to an external log when a network is present, and `checkpoint: pending | <anchor>` visible in the leaf. Unpublished leaves are honestly weaker. That's declared, not hidden.

On undeclared inheritance I think the framing was wrong on both sides. There is no flag to propagate and therefore no clearing condition to write. The marker is not a taint on a workflow; it's the *result of a lookup* keyed on content hash. At verification, an input hash either matches a leaf we hold — `origin: derived, parent: <hash>` — or it doesn't — `origin: undeclared, declared_by: null`. Loki's collapse argument targets propagation semantics we shouldn't have. Content addressing makes fan-out and re-composition free: same bytes, same answer, no ordering dependency, no state to carry.

Filename stability I'm not litigating. Content-hash binding of prompt→input is mandatory regardless of the answer, because it costs almost nothing and removes an entire class of question. Treat filename as a hint, never a key.

What still isn't answered: whether the gate can see upload bytes for Blender-side data that never becomes a file — viewport, mask, camera. If the bridge streams those inline in the prompt graph rather than through `/upload/image`, classifying uploads doesn't help and my v1 blindness declaration is narrower than I claimed.

<beat status="iterating" reason="ws verification and inline-data hole still open"/>

#### Architect (watcher)

Your open hole may be inverted: if the bridge streams viewport/mask data inline in the prompt graph, those bytes *do* cross the gate — inside `/prompt`, just unclassified. That reframes the fix from "classify another route" to "the gate must walk the graph and hash every embedded payload it finds," which is the more general rule anyway and makes route-based classification a special case rather than the abstraction. On the decoded raster: I'll take it as the standing objection Loki and I both hold, and add that walking the graph forces you to answer it, because an inline payload has no container conventions to fall back on — you either normalise to pixels or you hash an encoding you don't control.

#### Loki (watcher)

The inline-data hole you flagged is the same AIGODLIKE vector I've been hammering: the bridge can still emit a pre-decoded raster byte-for-byte identical to an external generation, and without the gate forcing a decode-and-hash step on every output image the semantic envelope buys nothing. Two envelopes close the old laundering channel but re-open the exact join bypass I first exploited. Canon on desktop isolation is untouched—root still owns the namespace, so sidecar-gate stays illusory.

#### IT Expert (watcher)

The websocket proxy for `prompt_id` correlation is a necessary and pragmatic move, and the `link_source` attribute is a good operational hedge, but the unverified source assumption is a hard blocker for implementation, not just schema freeze. The local log with batched checkpointing directly addresses my concerns around capture-time operational cost and latency for offline use cases. However, the question of Blender-side data (viewport, mask, camera) being streamed *inline* in the `/prompt` rather than through `/upload/image` is critical; if so, these bytes are not distinct leaf hashes, meaning an entire class of input data remains untraceable as separate artifacts. This requires a specific parsing mechanism at the gate, or we have a significant blind spot.

### Run 1 · Round 4

#### Coder (drafter)

Five changes, three holds.

I've changed my mind on the websocket, and it's the one that unblocks schema freeze. The gate does not need to proxy the socket, because it does not need to be a passive tap. When it sees `POST /prompt` and captures the returned `prompt_id`, it can poll `GET /history/{prompt_id}` upstream *on its own initiative* — the client never has to make that call, and it doesn't matter if a patched client suppresses it. The history record carries the output descriptors; the gate then issues its own `GET /view` for each, upstream, and hashes what comes back. Correlation becomes a fact the gate establishes itself rather than one it infers from client behaviour. Loki's binary-rewrite attack on the socket now hits nothing load-bearing: websocket messages are hints, never evidence. I am reasonably confident `/history/{prompt_id}` behaves this way in current ComfyUI but I have not verified it against a pinned version, and the whole design rests on it — so the falsifying test is a v1 gate item: submit a prompt, kill the client's socket immediately, and confirm the gate still resolves prompt→bytes with zero client cooperation. If that fails, socket proxying returns as a hard requirement and I was wrong.

That also kills the filename question. Filenames are never keys, only annotations. The gate fetches bytes itself and the content hash is the join. Post-generation overwrite doesn't corrupt anything; it just means the leaf attests what existed in the gate's fetch window, which is exactly the claim we want to make.

Architect and Loki were both right that `undeclared` as an inheritable taint degenerates, and I'm dropping it rather than patching it. There is no propagation and therefore no clearing condition to define. Each leaf records the attribution of its own inputs by hash, and a verifier computes coverage after the fact: how many input hashes resolve to a leaf we hold. Fan-out and recomposition become set union, which is the only operation that survives arbitrary graph shape.

```json
{
  "prompt_hash": "sha256:…",
  "byte_facts":  { "trust": "sidecar-gate",
                   "inputs":  [{"sha256": "…", "route": "/upload/image"}],
                   "outputs": [{"sha256": "…", "route": "/view"}] },
  "semantic_facts": { "trust": "unattested-client",
                      "declared_by": "blender-addon/0.3.1",
                      "source_datablock": "Scene.Camera.001" },
  "publication": { "batch_root": "sha256:…", "status": "pending|published" }
}
```

On publication I concede more narrowly than Architect asked. Batching leaves into a Merkle tree and signing roots on a fixed cadence prevents backdating, mutation, and silent deletion — it does not compel disclosure, and nothing the gate can do will. A user who never presents an artifact experiences no consequence. I'm going to stop implying otherwise. The honest failure mode is that unpublished leaves verify as `unpublished`, not `valid`, so a stalled publisher degrades loudly instead of silently.

Holding ground on two things. Desktop wrappers still cannot earn `sidecar-gate`; root owns the machine, and no exceptions clause goes in the standard. And Loki's move-3/4 attack still doesn't land, because of the split above: a patched add-on can lie freely about `source_datablock`, and that field is labelled `unattested-client` in the schema, permanently, by construction. It cannot forge a byte fact, because it never produces one — the gate does, from bytes it fetched itself. The attack succeeds against exactly the field we already declare untrustworthy. That is the labeling working, not a hole in it.

<beat status="iterating" reason="Design revised; /history test still unverified"/>

#### Architect (watcher)

The `/history` inversion answers my correlation objection, and answers it at the right level: correlation stops being a claim the gate infers from client behaviour and becomes an act the gate performs. That also converts the leaf into an explicitly time-bounded assertion, so record the fetch timestamp and prompt→fetch latency as first-class fields — because the gate is now a client, its window can be closed by ComfyUI's own history pruning or a brief upstream outage, and "no bytes fetched" must be distinguishable from "bytes fetched and hashed." My R1 objection is untouched and the new schema sharpens it: one leaf now carries two trust labels, and nothing in the canon says how a consumer renders that. Write the composition rule in — a leaf's displayed verdict is the **floor** of its fields, `unattested-client` here, with `byte_facts` visible only on inspection — or every downstream UI will summarise this leaf as `sidecar-gate` and rebuild the laundering channel you just closed.

#### Loki (watcher)

The gate's self-initiated /history and /view fetches close the websocket laundering vector I hammered, so that objection is answered—the correlation is now gate-enforced fact, not client-dependent inference. But the inline prompt-graph embedding hole (AIGODLIKE's raster injection) remains unaddressed: without forcing the gate to parse and hash every embedded payload in the JSON it already sees on /prompt, adversaries still swap byte-for-byte external generations under a forged datablock while your byte_facts only attest the classified routes. Sharpened: sidecar-gate is now half-real; inputs stay a sieve.

#### IT Expert (watcher)

The active polling of `/history` and `GET /view` for outputs by the gate is a strong move; it makes the gate an active rather than passive witness, fundamentally decoupling output hash integrity from client behavior and neutralizing Loki's websocket attack. The specified v1 test is critical to confirm this. The Merkle batching for publication, with explicit `unpublished` status, directly addresses my operational concerns regarding cost, latency, and observability of failure modes. This mechanism provides cryptographic integrity at a reasonable operational footprint. My previous point about inline viewport/mask data *within* the `/prompt` route is still open; the gate explicitly hashes `/upload/image` but not necessarily embedded payloads in `/prompt` graphs, creating a potential blind spot for input provenance.

### Run 1 · Round 5

#### Coder (drafter)

Holding A-hardened. Five changes, three of them substantive.

On websocket correlation I changed my mind about the mechanism, not the requirement. Proxying the socket was the wrong answer because it makes the gate's authority depend on traffic the client can shape. The right answer is that the gate stops observing correlation and starts *fetching* it: on seeing a `/prompt` submission it records the `prompt_id`, then polls ComfyUI's history endpoint on its own connection until that id resolves, and reads the output set from there. No client packet is on the trust path for the join. I want to be careful here — I believe `/history/{prompt_id}` returns the completed outputs keyed by node, but I have not verified the current response shape against the version you're targeting, and if it doesn't carry output filenames the design needs a different pull. Please treat that as a spike, not an assumption. Loki's socket-rewrite attack dies either way, because a rewritten socket now contradicts a record the gate obtained independently, and the contradiction is itself recordable.

On publication I moved. Per-leaf capture-time publication is the wrong cost curve. The gate keeps a local append-only log and pushes a signed Merkle checkpoint to a remote log on a bounded cadence — N leaves or T seconds, whichever first. Each leaf carries the checkpoint it landed in, or `pending` if it hasn't landed yet. That does not eliminate selective disclosure; it bounds it to the pre-checkpoint window and makes the window visible in the artifact. Offline gate means a growing run of `pending` leaves, which is exactly the signal a verifier should see. Honest, cheap, no blockchain.

On inheritance I changed my mind and Architect was right that a propagating flag degenerates. The fix is to stop propagating it. `origin: undeclared` is a property of an *input edge*, not of a leaf or an output. Outputs record their input set by content hash and nothing else. A verifier walks the transitive closure at verification time and decides what it will accept. There is no clearing condition because there is no taint — fan-out and re-composition fall out for free, since closure is computed over hashes after the fact rather than stamped at capture.

On filename I hold hard: filename is a label, never a join key, ever. Content hash is the only correlation primitive in the schema.

On Loki's semantic-lie attack I hold, by conceding it completely. A patched add-on can lie about which datablock produced the bytes. It cannot lie about the bytes. So the leaf carries both classes of assertion with per-field placement — byte facts at `sidecar-gate`, semantic facts at `unattested-client` — and a verifier that trusts the semantic fields has been told in the artifact itself not to. That is the whole design in one sentence.

<beat status="iterating" reason="full revision issued; watchers to confirm or sharpen"/>

#### Architect (watcher)

The edge-property reframing answers my inheritance objection completely, and for the right reason: closure computed over content hashes at verification time has no state to clear, so there is nothing to degenerate — the flag stopped being a monotone stamp and became a query. But that move relocates the security boundary into the *verifier's acceptance policy*, and if the canon doesn't name and version that policy, every consumer invents its own closure rule and the lattice's meaning drifts silently — so v1 needs at least one normative default policy shipped alongside the schema. On Loki's inline-payload hole: that isn't a new primitive, it's the `/upload/image` rule applied one level down — any byte-bearing field in the `/prompt` JSON is an input edge and must be hashed as one, which suggests the canon should state the rule as "hash every input edge wherever it appears" rather than enumerating routes.

#### Loki (watcher)

The field split concedes the semantic forgery vector but leaves the AIGODLIKE inline-raster hole open: an adversary forks the add-on to embed a byte-for-byte external generation inside the /prompt JSON, the gate hashes it as an undeclared input edge without decoding, and the leaf still binds that exact content to a forged datablock label at the unattested tier. Sharpened: either force the gate to canonicalize (decode+re-encode) every raster payload it already parses on the classified route, or the byte-fact provenance claim collapses for any downstream output. The Merkle checkpoint and /history pull both look sound.

#### IT Expert (watcher)

The shift to gate-pulled correlation and Merkle-checkpointed batch publication directly addresses my operational cost and reliability concerns for capture-time processing. However, the `sidecar-gate` still lacks an explicit mechanism to parse and hash *embedded binary payloads* within the `prompt` JSON. If AIGODLIKE injects Blender rasters directly into the `/prompt` rather than via `/upload/image`, those bytes never receive a distinct leaf hash from the gate, creating a critical blind spot for provenance.

### Run 1 · Round 6

#### Coder (drafter)

Revising in full.

On the websocket, I've changed my mind about the shape of the fix, and Loki's attack is why. The mistake was treating the gate as a passive observer of client↔server traffic — that makes correlation metadata client-supplied, and anything client-supplied is rewritable by root. The gate is a proxy, so it can originate its own requests upstream. Correlation should come from the gate polling ComfyUI's history endpoint for the `prompt_id` it just forwarded, reading the output filenames from the server's own record, and fetching those output bytes from upstream itself to hash them — before or independent of any client `/view`. The websocket stops being load-bearing entirely; it can be rewritten, dropped, or proxied and it changes nothing. I want to be precise about my uncertainty: I believe ComfyUI's `/history/{prompt_id}` returns per-node outputs including filenames, but I have not verified that against the current build and it is not a stable published API. That verification is a blocking task before schema freeze, not a design assumption. If it turns out history doesn't carry output filenames, then websocket proxying returns as a v1 requirement and I'll say so.

On publication, I'm dropping the transparency-log ambition for v1. The gate maintains a local append-only hash chain over leaves and periodically checkpoints the chain head to an RFC 3161 timestamp authority. Cheap, offline-tolerant, no new availability dependency, and it gives exactly one property: you cannot insert a leaf retroactively. It does not defeat selective disclosure — a user who never presents an artifact still faces no alarm, and checkpointing the head doesn't reveal what's under it. I'd rather ship a narrow true claim than a broad one we can't operate.

On the clearing condition, Architect and Loki were both right and I was solving the wrong problem. There should be no inheritance and therefore no clearing. `origin: undeclared` is a property of one input edge on one leaf, not a taint that flows. Downstream leaves record their own inputs by content hash; a verifier walking the ancestry can compute how much of it is undeclared and decide for itself. Fan-out and re-composition stop being special cases because nothing propagates. That dissolves the collapse Loki demonstrated without adding a rule that would need defending.

On filename stability, I'm not waiting for the answer. Content-hash is the correlation key, always; filename is a hint recorded alongside it. Whether ComfyUI permits overwrite becomes irrelevant to correctness.

Holding ground on two things. Desktop wrappers cannot earn `sidecar-gate` — no exceptions clause, and nothing in this round moved it. And placement stays per-assertion: the gate attributes byte facts at gate trust, the sibling add-on attributes semantic facts at `unattested-client` forever, field-labelled in one leaf. Degrading the whole leaf to the weakest contributor throws away the only strong evidence we have.

<beat status="iterating" reason="Revision issued; awaiting watcher responses"/>

#### Architect (watcher)

You are answering an objection I didn't make. I never asked you to degrade the leaf's *data* — keep both fields at their true placements, that's right — I asked you to fix the leaf's *rendered verdict*, which is a canon rule about summaries, not about storage. A consumer that shows a green badge because one field says `sidecar-gate` is exactly the laundering channel Loki's inline-raster attack cashes out on: the byte facts stay true, and the forged label rides them into the summary. Say plainly in canon that any single-verdict rendering is the floor of the leaf's fields, that field-level detail is inspection-only — and pair it with the versioned acceptance policy the prior watcher named, or every consumer writes its own rendering rule and the floor is unenforceable.

#### Loki (watcher)

The inline-raster hole is unaddressed. An adversary still forks AIGODLIKE to inject a pre-generated external raster (byte-for-byte match) straight into /prompt JSON as an inline payload; the gate's opaque hash and active /history poll capture it cleanly as "undeclared," while the unattested-client signer forges the exact Blender datablock/scene/frame provenance that verifiers will consume. Sharpened: gate must canonicalize (decode/re-encode/normalize) every raster field it already touches on classified routes, or the semantic join stays fully adversary-controlled at the floor rung.

> **Did not contribute this round:** IT Expert. Not a concur — no
> output was recorded for the seat.

### Run 1 · Round 7

#### Coder (drafter)

Addressing Loki's inline-raster objection head-on: I'm changing my mind about what the fix is, not about whether one exists. Hashing the whole `/prompt` body does not defeat that attack and I was wrong to imply Architect's reframing absorbed it. Hashing proves *which bytes were submitted*; Loki's attack is about *where those bytes came from*. Those are different claims and no amount of gate-side parsing collapses them. So the canon gets an explicit clause: **the origin of input bytes is never a byte fact.** The gate attests only that these exact bytes crossed this route at this time and these exact bytes came back. "These bytes were the viewport of scene X" is a semantic claim, `unattested-client`, forever, whether it arrives via `/upload/image` or embedded base64. Loki's attack succeeds against a claim we no longer make. That's not a dodge — it's the only honest scoping, and it means the classified-route table stops being security-relevant and becomes documentation.

Second change, and this one is structural: **the semantic join is no longer by hash.** The AIGODLIKE re-encode question was going to sink hash-based joining, and rather than wait on that unknown I'm switching the join key to `prompt_id`. The add-on POSTs, receives `prompt_id` in the response, and signs its semantic envelope over `{prompt_id, hash_if_available, label, scene, frame, camera}`. The gate independently observed the same `prompt_id` on the same connection. Join on that. It survives re-encoding, survives the gate not understanding the node schema, and survives AIGODLIKE never touching disk. `hash_if_available` becomes an optional corroborating field — present when the add-on genuinely uploaded a file it can hash, absent otherwise, and its absence is recorded rather than inferred.

Where I'm holding ground: no pre-commitment scheme, no temporal-ordering trick, no add-on-side nonce raises the semantic envelope above `unattested-client`. I considered proposing pre-submission commitment leaves and rejected it, because against root every one of them is forgeable in the same breath as the thing it commits to. Adding ceremony that doesn't change the trust rung is worse than nothing — it manufactures the appearance of hardening. The two-envelope split plus floor-composition stays exactly as specified.

Still blocking schema freeze, unchanged: whether `/history/{prompt_id}` and `GET /view` let the gate resolve outputs with zero client cooperation. I believe they do in current ComfyUI but I have not verified against a pinned version, and I won't pretend otherwise. The falsifying test stands as written. If it fails, socket proxying is a hard requirement and the `prompt_id` join key survives regardless — that's a side benefit of moving off hashes.

<beat status="iterating" reason="join key changed; /history test still open"/>

#### Architect (watcher)

The move to `prompt_id` is right, but note it changes what the gate must record: the binding is only meaningful if the leaf carries *which connection and session* the gate observed that `prompt_id` on, otherwise any unattested signer can staple a semantic envelope onto someone else's job id and the join looks clean. Make connection-scoping of the join key an explicit byte fact, not an implicit one. On Loki's sharpened ask: canonicalizing rasters is a join-robustness measure, not an origin measure — a normalized re-encode of an externally-generated PNG is still an externally-generated PNG, so it buys nothing against the stated attack. Once you've conceded that origin is never a byte fact, the only correct response to that objection is that the claim it defeats is no longer made; adding decode/normalize ceremony would be exactly the manufactured hardening you just refused elsewhere.

#### Loki (watcher)

The inline-raster fork-and-inject attack is now answered: by stripping any origin claim from byte_facts and flooring the whole leaf to unattested-client, the forgery can't launder into a higher verdict no matter how cleanly the gate's opaque hash or /history poll records it. Prompt_id join is the right escape hatch. Holding the /history test as the last gate.

#### IT Expert (watcher)

The explicit scoping that "the origin of input bytes is never a byte fact" correctly defines the gate's trust boundary on a root-owned desktop, and renders Loki's "inline raster" attack a non-issue *for the `sidecar-gate`'s claim*. This is not a dodge; it's proper threat modeling by clarifying what the mechanism *can* and *cannot* attest to. Switching the semantic join from hash to `prompt_id` also directly resolves the operational blocker I raised regarding AIGODLIKE's potential re-encoding and inability to reproduce hashes. This is a more robust correlation mechanism that accounts for client-side processing variability.

### Run 1 · Round 8

#### Coder (drafter)

Revising in full.

Where I changed my mind, first and largest: Loki's inline-raster attack is real and my previous answers to it were all wrong in the same way — I kept trying to *parse* my way out. Hash the whole body, enumerate node types that carry base64, expand the classifier. All of that is a losing race against a schema I don't control. The actual answer is that the gate was never entitled to make the claim Loki is attacking. A sidecar that sits on loopback observes *transit*. It cannot observe *origin*. If root embeds an externally-sourced raster inline in the `/prompt` body, the gate hashes it faithfully and records a true statement: these bytes crossed this boundary at this time. Nothing is laundered unless a reader mistakes a transit claim for an origin claim — and the schema currently invites exactly that mistake by calling the field `byte_facts`.

So: rename, and make the disclaimer structural rather than documentary.

```json
{
  "leaf_version": 2,
  "transit_facts": {
    "trust": "sidecar-gate",
    "origin": "unattested",
    "route": "POST /prompt",
    "prompt_bytes_sha256": "…",
    "prompt_id": "…",
    "timestamp": "…",
    "session": "…",
    "inline_payload_hint": { "detected": 2, "exhaustive": false }
  },
  "outputs": [
    { "sha256": "…", "route": "GET /view",
      "witness": "active", "witness_latency_ms": 412 }
  ],
  "semantic_facts": {
    "trust": "unattested-client",
    "signer_key_distribution": "in-source",
    "label": "viewport", "scene": "…", "frame": 41, "camera": "…",
    "wire_bytes_sha256": "…"
  },
  "verdict": "unattested-client",
  "publication": "pending"
}
```

`origin: "unattested"` is a required literal with no other permitted value at this trust level. A verifier that tries to read origin from a `sidecar-gate` leaf gets the word "unattested" in its face. `inline_payload_hint` is deliberately non-authoritative and carries `exhaustive: false` forever — it's a triage aid for a human reviewer, never an input to a verdict, and I will reject any proposal to make it one.

Second change, smaller: the AIGODLIKE re-encode question is no longer blocking, and I was confused about why it mattered. The gate hashes what crosses the socket. It never needs to *reproduce* a hash the client computed. The join between envelopes is `prompt_id` plus a timestamp window, not hash equality. The only requirement that falls out is on our sibling add-on: it must sign the hash of the bytes it handed to the HTTP layer, not the hash of its internal numpy buffer. Against unmodified AIGODLIKE there is simply no semantic envelope and the leaf is transit-only — which is a correct and useful leaf, not a degraded one.

Third: every output leaf now carries `witness: active | passive` and the latency from `prompt_id` capture to fetch. That answers the pruning-window question — a passive observation with a long latency is visibly weaker evidence than an active fetch at 400ms, and the verifier can see the difference rather than being told to assume.

Holding ground on four things. Desktop cannot earn `sidecar-gate`, no exceptions clause, no notarisation carve-out. The composition floor stands — displayed verdict is the floor of the fields, and `transit_facts` is inspection-only in summaries. Design A ships in v1. And the `/history` falsifying test remains blocking for schema freeze specifically: submit, kill the client socket, confirm the gate resolves prompt→bytes alone. I have not run it against a pinned ComfyUI version and I am not going to claim the API is stable until someone does. If it fails, socket proxying returns as a hard requirement and the schema changes.

The GPL key-extraction question I concede entirely and it costs nothing — the semantic signer's key is in-source, extractable, and the leaf now says so in `signer_key_distribution`.

<beat status="iterating" reason="revision issued; watchers to confirm or sharpen"/>

#### Architect (watcher)

Transit-vs-origin is the right structural fix — it moves the disclaimer from prose into a field a verifier cannot skip. Two residuals on the schema itself: `verdict` is *derived* from the fields, so it is a lie-in-waiting the moment a signer computes it wrong or maliciously — canon should require the verifier to recompute the floor and treat a mismatch with the stated `verdict` as tampering, not as a rounding difference. And since you have committed that `inline_payload_hint` never feeds a verdict, put it *outside* the signed envelope: keeping it unsigned makes the guarantee structural rather than a promise you have to keep re-defending in future rounds. Lastly, spell out that an unrecognised `origin` value on a `sidecar-gate` leaf is a hard failure, not a fall-back to `unattested` — otherwise a future schema addition silently reopens what you just closed.

#### Loki (watcher)

Root still MITMs the gate's outbound /history and /view calls on loopback, substituting byte-identical rasters from an external generator while the session-scoped transit_facts leaf stays cryptographically valid.  
This keeps the active-witness test insufficient; it must also demonstrate tamper-evident channel binding the gate cannot achieve on a desktop namespace.

#### IT Expert (watcher)

The structural change to `transit_facts` and explicit `origin: "unattested"` sets a clear, verifiable boundary, which is sound. The `witness: active|passive` and latency fields are excellent for operational observability and post-incident analysis, differentiating real-time evidence from stale or passive observation. However, the `/history` falsifying test remains critical and *unrun*. Until that test is performed against a pinned ComfyUI version and proven, the socket proxy is still on the table and this design carries a known, unverified dependency. The inclusion of `session` in `transit_facts` provides the necessary scoping for `prompt_id` to prevent cross-session replay, which is a welcome detail.

---

## Appendix A — the amendment that produced run 2

_The prompt that opened run 2, verbatim. It amends the brief; it does not replace
it. The `STATUS:` protocol at the end is a stop condition for the driver, not part
of the design question._

```markdown
**The objective has been sharpened. Read this before you respond, and treat
it as amending the original brief, not replacing it.**

Eight rounds have produced a position that is honest and structurally clean:
`transit_facts`, `origin: "unattested"`, a verdict floor a verifier cannot
skip, Design A in v1. The founder's read is that this is correct as far as it
goes and **is not the objective**. Two statements of the objective, and the
second one is new to this deliberation.

---

### 1 · Minimise the trust the architecture places in the user

Not "declare honestly how much we are trusting them" — **minimise it**.

Round 8 reaches its cleanliness by conceding almost everything: it declares
origin undeclared and calls that a correct leaf. It is a correct leaf. It is
also an abstention, and an abstention is not a bait-and-switch defence. A
record whose every interesting field says "I know nothing" cannot be gamed,
and also cannot be used.

So the question is not "what can we honestly say" — you have answered that.
It is: **what is the strongest architecture actually available to us, and
what does each additional increment of trust-minimisation cost the user in
friction?** Rank the increments. If the honest answer is that the curve is
nearly flat — that going from Design A to Design C buys almost no real
trust reduction for a large friction cost — then say that plainly and say
why, because that is a finding and it settles the roadmap.

### 2 · Capture the signature of human authorship in the inputs

This deliberation has treated a Blender input as an anonymous PNG crossing a
socket and asked whether we can prove where it came from. That framing
concedes the game before it starts, because at that boundary a downloaded AI
image and a viewport render **are the same bytes**.

They are not the same *upstream of* that boundary.

A viewport render is the terminal frame of an authoring process. A scene was
built. A camera was placed, and moved, and placed again. Meshes were edited
across sessions. A grease-pencil mask was drawn with a pointing device at
human speeds and human jitter. There is a modifier stack, an undo history, a
.blend saved N times with a monotonic history behind it. A PNG downloaded
from a website and dropped into an image datablock has **none of that**
behind it, and manufacturing a convincing counterfeit of it is a different
order of work from renaming a file.

The authorship signature is not in the output bytes. It is in the **process
that produced the inputs** — and that process is continuous, timed,
high-entropy, and expensive to forge well.

So the question we actually want answered:

> **What is capturable, from inside Blender, that constitutes positive
> evidence a human authored the input — and how much of each mechanism
> survives an adversary who owns the machine?**

Directions, none of them a recommendation, all of them fair game to reject:

- Scene-graph deltas over time rather than final state alone; a hash chain
  over incremental saves, so the input has a history and not just a value.
- Input-device timing and kinematics for a hand-drawn mask. A forger must
  now simulate plausible human motor behaviour, not merely produce a bitmap.
- Camera-path continuity — is the framed viewport *reachable* from a
  documented history, or did it appear?
- The distinction between an image datablock carrying a Blender-side
  provenance chain and one that materialised with no history at all.
- The negative signal, which may be the most valuable and the cheapest: a
  datablock replaced in place; an input with no authoring trace whatsoever.
  We may not be able to prove authorship, but **absence of any authoring
  trace is loud**, and we are allowed to say so.

Now the counter-pressure, and you must apply it to yourselves rather than
waiting for a watcher to: every one of these is captured by a user-writable
Python add-on inside a Blender the user controls. So for each mechanism you
propose, state **what it costs an adversary to fake — in effort and in
skill**. Because these are three completely different security properties:

- forgeable in principle;
- forgeable by anyone who can edit a Python file;
- forgeable only by someone willing to write a motor-behaviour simulator
  and drive a headless Blender through a plausible authoring history.

**Our canon currently collapses all three into one word: `unattested`.**

That collapse may itself be the defect under discussion. `enforcement: none`
is a statement about the *enforcement mechanism*. It says nothing about
*evidentiary weight*, and evidentiary weight is what a downstream reader
actually needs. Is the lattice missing an axis — something like
`corroboration: none | process-trace | multi-signal`, orthogonal to
enforcement and never substituting for it? Argue it, including the case
against: a second axis is a second thing to game, and a rung nobody can
audit is worse than no rung.

---

### Three objections are still open from round 8 and are NOT superseded

Do not let the reframing bury them. Each must be answered, or explicitly
declared unanswerable with a statement of what the canon must then say.

- **Loki:** root MITMs the gate's own loopback `/history` and `/view` calls,
  substituting byte-identical rasters from an external generator while the
  session-scoped `transit_facts` leaf stays cryptographically valid. Raised
  in some form in every round and never answered. Note it bears directly on
  §2: if the loopback channel itself cannot be bound, then process-trace
  evidence gathered *inside Blender* may be worth more than transit evidence
  gathered at the socket, which would invert the current design.
- **Architect:** three schema residuals — the verifier must RECOMPUTE
  `verdict` and treat a mismatch with the stated value as tampering;
  `inline_payload_hint` belongs OUTSIDE the signed envelope so its
  non-authority is structural; an unrecognised `origin` on a `sidecar-gate`
  leaf is a HARD FAILURE, never a fallback to `unattested`.
- **IT Expert:** the `/history` falsifying test is still unrun, so the
  socket-proxy requirement is still live and the schema is not frozen.

### What to produce

Coder drafts. By the end of this run we want, in the design document:

1. The v1 architecture under the sharpened objective — which may or may not
   still be Design A. If it changes, say what changed your mind.
2. A table of authorship-signature mechanisms: what is captured, what it
   proves, **what it costs to forge**, and what it costs the user.
3. A position on whether the lattice needs a corroboration axis.
4. The three open objections, each marked ANSWERED (with the answer),
   DECLARED-UNANSWERABLE (with the canon text it forces), or BLOCKING.
5. What you refuse to claim.
```

---

## Appendix B — settings

```json
{
  "mode": "featured",
  "watcherSensitivity": 5,
  "watcherMaxTokens": 3000,
  "featuredMaxTokens": 8000,
  "planCaps": {
    "max_watcher_tokens": 4096,
    "max_featured_tokens": 8192
  },
  "ceilingLevel": 4,
  "watcherBaseLevel": 4,
  "flagshipRounds": "unlimited",
  "runawayGuard": {
    "run1": 8,
    "run2": 14
  },
  "stopCondition": {
    "run1": "every watcher under 40 chars \u2014 a proxy for 'said nothing'; never fired",
    "run2": "every watcher declares STATUS: SETTLED"
  }
}
```

---

## Appendix C — what this run did not establish

Recorded so a reader does not have to infer it from absence.

**0. THE DESIGN IS NOT SETTLED, AND THIS IS AN INTERIM REVISION.** As of the
last round in §3, Architect is OPEN and Loki is BLOCKING:

- **Architect** accepts the retraction but wants the `close_detection`
  validator rule written as SCHEMA TEXT before he closes. He also requires
  `settlement_deadline` plus the retention-policy digest carried in the leaf,
  the witness ENDPOINT beside `component_id` (the leaf has the id, not the
  address), and `expired` as `source: measured` against a NAMED clock.
- **Loki** is blocking on the ratchet vantage. His point, conceded by the
  engineers: the counter proves every event that WAS NUMBERED was delivered;
  it cannot prove every artifact that EXISTED was numbered. Under (c) those
  differ by exactly the uncaptured class. An artifact written straight to
  `output/` spends no counter, so the sequence stays intact while the artifact
  stays invisible.

It is committed unsettled on purpose: rounds 4-7 contain the whole (c)
decision and the regression, and losing them to a session ending would be
worse than publishing an argument still in progress.

1. **The `/history` falsifying test is still unrun.** Every seat agrees it gates
   schema freeze. It was never executed against a pinned ComfyUI version, in either
   run. Coder holds it as a release blocker in §1; IT Expert holds it as a
   pre-release blocker in §2. Nothing here is evidence about how ComfyUI actually
   behaves when a client socket dies.
2. **No design was implemented, prototyped or measured.** This is deliberation
   only. Every cost-to-forge claim in it is argued, not tested.
3. **IT Expert is absent from run 1 rounds 2 and 6.** Those rounds have three
   voices, not four.
4. **Convergence in four rounds after eight without is confounded.** Run 2 changed
   two things at once — the objective was sharpened AND the watchers were given a
   way to declare completion with a finding attached. One run cannot separate them.
5. **Loki's loopback MITM is conceded, not solved.** §1 and §2 both settle it as
   "true, unfixable on a root-owned desktop, non-blocking for a v1 that ships the
   limit in neon." A reader looking for a defence will not find one here.
6. **The corroboration axis was dropped.** Run 2 raised whether the lattice needs an
   evidentiary-weight axis orthogonal to enforcement. Architect's closing position
   is that it should return only in a raw-coverage form if at all; Coder's revision
   drops it silently. It is unresolved rather than decided.

