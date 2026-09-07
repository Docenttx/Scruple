# WO-B4 — Store-and-forward, and gap detection

_2026-09-07. Follows `03-V2-WITNESS-L2.md`. Machine-readable twin:
`04-live-phases.jsonl`, appended by
`tests/live/store_and_forward_in_blender.py` inside real Blender against
the scratch stack, one line per phase, each phase a separate Blender
process. `04-live-phases-attempt1.jsonl` is the first run and is kept
because it contains a control that fired without being asked to._

---

## The headline: the queue worked, and could never have been reached

WO-B3 left the addon with `queue.py` wired into `http.submit()`'s failure
path — genuinely wired, unlike the six forks the SDK header describes.
It still could not spool a single capture in the case that matters.

Probed before anything was written, with the addon exactly as B3 left it:

```
client = new_client(...); opener.offline = True
witness_render(client, scene)
  -> attach failed: could not establish or verify a baseline
  -> queued: False      error: Could not establish a Scruple baseline
  -> queue depth: 0
```

**A Blender started while the server is unreachable witnesses nothing and
spools nothing.** Every capture is refused client-side and the queue never
sees one.

It is not a bug in the queue. `witness_flow.witness()` refuses without
`session.state.baseline_ref` — D-3, and correctly: a leaf without a
baseline is not a weaker leaf, it is not Scruple-witnessed at all.
`SessionState` is in memory. `Client.attach()` is a network call, and it
is deliberately **not** queued, because a baseline is a precondition
rather than a Phase-3 event. One Client per Blender process therefore
means one successful network call per Blender process before any capture
can happen at all — and a laptop on a train, a studio behind a dropped
VPN and a machine rebooted mid-outage are all exactly that.

`adapter/baseline_cache.py` is the answer, and it is deliberately narrow:

1. Only a baseline a **live** `attach()` established is cached. A ref this
   client did not just hear from the server is never written.
2. It is restored only when `attach()` could not reach the server **and**
   the tamper surface hash of the code running now equals the one it was
   cached under. Different bytes are a different integration (D-3,
   Standard §4).
3. Everything captured on a restored baseline goes into the **queue**, and
   `/api/v2/witness` validates `baseline_ref` at ingest. A stale baseline
   surfaces as a rejection at drain time, which is visible, instead of as
   silence, which is not.

**Rule 2 fired during the live run, unplanned.** `adapter/` had been
edited between the `attach` phase and the `capture` phase:

```
cached tamper_surface_hash   2d14e208204b4e218a7e91717e698a43095373b445fa552a05efad77c894e1d2
running tamper_surface_hash  1cc15be2b9bd6abc605ba2ad42c9708606fef1bc1f643fb2cea182aeb5076c14
-> cached baseline refused; three captures refused_locally, none spooled
```

That transcript is `04-live-phases-attempt1.jsonl`. It is the control for
the cache, produced by accident and kept on purpose.

---

## Why the queue cannot be the reconciliation

`QueueStore` deletes an entry when it drains. So it can say what has **not**
settled and never what **has** — and an entry lost for any reason (a torn
write, a `replace_all` that lost a race, a user deleting the spool, a bug)
is lost silently, because the only record it ever existed was the entry.

A reconciliation built on the queue alone reports "all clear" for exactly
the case it exists to catch.

So settlement needs a second record. `adapter/ledger.py` is one line per
capture, written **before** the request — between the content hash being
computed and anything being sent — and never deleted. `Client.witness_file()`
is `capture()` + `witness()` in one call with no seam between them, so
`flow.py` now makes those two SDK calls itself, in the same order, and
records the receipt exactly as `witness_file()` does.

The settlement (`adapter/reconcile.py`) is then:

1. drain — `Client.detach()` and nothing else, because an adapter may not
   write its own retry (CANON_SKELETON §5);
2. for every ledger line, ask the **server**:
   `GET /api/v2/verify/{content_hash}`;
3. a line the server does not have, and which is no longer in the queue,
   is a **GAP**.

Step 2 is why a dropped entry is caught: the queue no longer knows about
it, the ledger still does, and the difference is the gap.

### The one rule the module is written around

Three answers, not two — present, absent, and **not asked**.
`Reconciliation.all_clear` is False for anything unchecked, anything still
pending in the queue, any line with no hash to ask about, and any ledger
that lost or damaged a row. "Could not ask" never rounds down to "clear",
because that rounding is precisely the failure `L2_AS_THE_VENDOR_FLOOR.md`
Missing 2 describes.

`LedgerStore.update()` copies unparseable lines through verbatim rather
than dropping them. The obvious implementation (`load_all()` +
`replace_all()`) deletes every damaged line each time settlement touches
the file, so the first reconciliation after a torn write would repair the
ledger into looking clean. Caught by a test, not by review.

---

## The gate

> stop the scratch witness, capture three events, restart it, and show all
> three land. Then deliberately drop one from the queue and show the
> reconciliation reports the gap. A reconciliation that reports "all clear"
> on the dropped case fails this WO.

### Part 0 — stopping the *witness* does not exercise store-and-forward

Run first, because the WO names it, and it is a finding rather than a step.

`POST /api/v2/witness` swallows a witness-server failure by design —
*"capture must not block on witness-server health"* — and answers 201 with
`witnessed: false`. Measured, witness server on :5899 stopped, one real
Cycles render:

```
witnessdown.png   sha256 4e0629a91424b5e0…
http_leaf_id 26   witnessed False   queued False   state delivered_not_witnessed
queue_depth 0

sqlite> select id, substr(output_hash,1,16), witnessed, leaf_scheme from iterations where id=26;
26|4e0629a91424b5e0|0|v1
```

The capture was **delivered and not witnessed**. It was not queued, it will
not be retried, and it is on the app's record as a v1-scheme row with
`witnessed = 0`. That is one of B3's five states doing its job, and it is
the reason the rest of this gate was run against the **app** on :3902:
store-and-forward engages on a transport failure or a 5xx, and the witness
being down is neither.

### Part 1 — three captures survive the app being stopped

App on :3902 stopped. Three real Cycles CPU renders at 160×120 inside
`blender --background --factory-startup`, in a **separate Blender process**
from the one that attached — the queue, the ledger and the baseline cache
are files, and they are the only things that cross.

```
off0.png  10 496 B  87d965bc7a2cb91a…  queued=True  state=queued
off1.png  10 496 B  52cb226208e29a04…  queued=True  state=queued
off2.png  10 496 B  d1da96f05c1be04d…  queued=True  state=queued
queue_depth 3
```

App restarted, settlement run in a **third** Blender process:

```
drain     {attempted: 3, succeeded: 3, failed: 0, remaining: 0}
counts    {settled: 3}
gaps      []
all_clear True
summary   "Settled: 3 capture(s) confirmed on Scruple's record, nothing missing."
```

Confirmed against the app's own database and against the bytes on disk,
by two programs that share no code:

| leaf | file | `content_hash` (app DB) | sha256 of the PNG | witnessed |
|---:|---|---|---|:-:|
| 21 | `off0.png` | `87d965bc7a2cb91a…` | `87d965bc7a2cb91a…` | 1 |
| 22 | `off1.png` | `52cb226208e29a04…` | `52cb226208e29a04…` | 1 |
| 23 | `off2.png` | `d1da96f05c1be04d…` | `d1da96f05c1be04d…` | 1 |

**`all_clear: True` here is the must-NOT-fire control for Part 2.**

### Part 2 — one entry dropped, and the gap is reported

App stopped again, three more renders spooled, app restarted, and **one
queue line deleted** before the drain:

```
dropped_from_queue  9fa67444155582309bd53262302fb55f5c877f795825f30f5b41e6089579891f
drain               {attempted: 2, succeeded: 2, failed: 0, remaining: 0}
counts              {settled: 5, gap: 1}
all_clear           False
summary             "1 MISSING"

GAP  seq 5  drop1.png  9fa67444155582309bd53262302fb55f5c877f795825f30f5b41e6089579891f
     "MISSING. This capture happened, it is not on Scruple's record, and
      nothing is left in the queue to deliver it."
```

Six captures were taken. The app's database holds five:

```
21 87d965bc7a2cb91a   22 52cb226208e29a04   23 d1da96f05c1be04d
24 f4df2eb2c177f504   25 a938b73333267fe3
                      ── 9fa674441555823 is absent, and is named ──
```

The settlement condemned exactly one line and settled the other five. A
settlement that reported everything missing would satisfy the first
assertion and be worthless; the paired count is what makes it evidence.

---

## Controls — every must-fire check has a must-NOT-fire twin

37 tests in `tests/test_reconcile.py`, and the pairs are deliberate:

| must fire | must NOT fire |
|---|---|
| a dropped queue entry is a `gap` | a clean drain is `all_clear` with `gaps == []` |
| a settlement that cannot reach the server is not `all_clear` | …and reports **no** gaps — "could not ask" is not "absent" |
| the same captures settle clean when the server *is* reachable | (the twin of the twin: without it the two above only prove the harness is broken) |
| a locally refused capture is on the ledger | …and is **not** counted a gap — it is accounted for, with a reason |
| a server 4xx is reported as `rejected` | …and `all_clear` stays True: the server said why |
| a ledger row deleted from the middle is reported | a clean ledger reports no damage and no missing rows |
| an unparseable ledger line is counted | …and `update()` does not delete it |
| the panel draws the queue box when something is spooled | …and does **not** when the queue is empty |
| the panel draws the gap box when settlement found one | …and does **not** when `all_clear` |
| a cold offline session *with* a cached baseline spools | a cold offline session *without* one still captures nothing |
| a cached baseline restores under the same build | …and is refused when the tamper surface hash differs |
| a mapped rebaseline reason goes through | an unmapped one is refused **before any request** |

The panel pairs needed a recording `UILayout` in the bpy mock
(`tests/mocks/bpy_mock.py`). Before it, `draw()` was untested end to end —
only its line-formatting helpers were — so a region that is always drawn
and a region that is drawn conditionally were indistinguishable from the
suite.

`tests/mocks/http_mock.py` gained `opener.offline`, which raises `URLError`
rather than answering 500. The distinction matters: `submit()` queues both,
and a 4xx neither queues nor retries.

**Suite: 253 passed** (214 at the end of WO-B3 → +37, minus one baseline
test updated for a new key in `drain_queue()`'s return).

---

## Where the drain now happens

Before this WO the only caller was `unregister()`. An offline capture
therefore landed on the next Blender session that got as far as being
disabled — and not at all if Blender was killed.

| when | why |
|---|---|
| `register()` | a previous session's spool goes out without waiting for a render. On the worker thread: a network round-trip in `register()` is a hang at launch. |
| a `bpy.app.timers` tick, 60 s | no coarser than `BACKOFF_SCHEDULE`'s finest step (5 s), or the schedule's early retries would be silently stretched to the tick. |
| `unregister()` | unchanged, still the last chance. |
| `scruple.drain_queue` / `scruple.reconcile` | on demand. |

`_drain_tick()` catches everything and always returns an interval. A bpy
timer callback that raises is **unregistered by Blender**, so one network
hiccup would silently stop all future draining — the invisible failure this
WO is about, reintroduced by the fix for it.

---

## What this WO did NOT do, and the one thing standing in the way

### The server's own gap detection exists, works, and the addon cannot reach it

`L2_AS_THE_VENDOR_FLOOR.md` Missing 2 asks for *"per-component sequence
accounting: a monotonic counter per capture-component instance, gap
detection, and an expected-heartbeat window."* All of it is built —
`lib/ratchet/verify.ts`, `lib/reconcile/status.ts`,
`POST /api/v2/components/provision`, `GET /api/v2/components/status` — and
the Python half of the component is in the addon's **own vendored SDK**
(`scruple_host_sdk.ratchet.Ratchet`,
`scruple_host_sdk.server_library.component_preimage`).

Driven by hand from this addon's vendored code against the scratch app, to
establish that the only thing missing is a parameter:

```
$ POST /api/v2/components/provision      -> component_id a78a6fa6-…, ik_hex, counter 0
$ Ratchet(IK, 0).mac(component_preimage(body)); POST /api/v2/witness
    component -> {"counter": 0, "verified": true, "gap": 0}
$ spend counter 1 WITHOUT sending it; send counter 2
    component -> {"counter": 2, "verified": true, "gap": 1}
$ GET /api/v2/components/status?component_id=…
    counters {last_verified: 2, delivered: 2, backfilled: 0}
    gaps     {open: 1, missing: 1, resolved: 0,
              list: [{from_counter: 1, to_counter: 1, missing_count: 1}]}
    liveness live, ever_witnessed true
```

The MAC verified first try, against the preimage function the route itself
calls. **The addon cannot send that envelope**, because
`scruple_host_sdk.witness_flow.witness()` has no `component`, `mac` or
`capture` parameter — it accepts `attestation` and `continuity` and stops
there — and CANON_SKELETON §5 forbids an adapter assembling its own
request. `docs/developer.md` says where that change belongs
(`packages/scruple-host-sdk`, then `build/vendor_sdk.sh`), and this work
order's brief is **read-only** on `/data/scruple-web`. So it is written up
rather than made. `reconcile.component_status()` reports
`available: false` with `reason: not_configured` and the explanation, in
the payload, rather than omitting the field.

**The two halves are complementary, not redundant**, and this is the
argument for building the client ledger even once the envelope lands:

- the **server** notices a counter that was never delivered — including one
  from a client that never came back to say so, which is the Kohya failure
  the floor is written against. It notices it when a *later* counter
  arrives.
- a **trailing** loss — the last capture of a session — has no later
  counter behind it, so from the server it is indistinguishable from a
  component that simply stopped, and only the heartbeat window says
  anything. The client ledger has the intent recorded either way.
  `test_the_LAST_capture_being_dropped_is_also_a_gap` is that case.

The honest limit of the ledger, stated in its own header: it is written by
the same process it measures. A capture that never reached
`record_intent()` leaves no line, and its absence is invisible from here.
That is what the component envelope is for.

### Two more closed enums the SDK does not know are closed

`/api/v2/baseline/rebaseline` closes `reason` to five values.
`Client.rebaseline()` takes a free string and validates nothing:

```
reason=integration_update -> invalid_enum_value
reason=capture_point_change -> accepted
```

Same shape as the `kind` enum B3 found, and found the same way. Refused
client-side now (`flow.REBASELINE_REASONS`), because a build that cannot
rebaseline cannot witness and the reason should be legible in one place.

### The rebaseline could not actually be recorded

The addon's tamper surface changed for this WO, so the tenant's active
baseline describes different bytes than the ones running, and `attach()`
reports drift. Rebaselining is the honest response and the scratch witness
refused it:

```
POST /api/v2/baseline/rebaseline -> 503 signer_unavailable
  "The witness is unreachable, so this baseline transition cannot be
   recorded as a leaf. §4 requires the change to be a witnessed event, so
   the transition is declined rather than applied silently."
  detail: Witness POST /api/witness 400 "synthetic project_id refused …
          Set SCRUPLE_WITNESS_ALLOW_SYNTHETIC_PROJECT=1 if this is deliberate."
```

A sandbox configuration, not a defect: the runner starts the scratch
witness without that flag. **Every leaf in this run therefore carries a
baseline_ref that does not equal the running build's tamper surface hash**,
and `attach()` said so on every phase. Recorded rather than worked around.

### Untouched

- **H-4 client-binding is still not closed.** No component envelope, no
  ratchet on the wire, no MAC. Unchanged from `01-GAP.md` row 4 and from
  B3, except that the path is now measured end to end and costs one SDK
  parameter.
- **The panel is not rebuilt.** The spool, the retry button, the reconcile
  button and the gap list are there; project switching, price display and
  receipt drill-down are **WO-B5**.
- **No leaf is `verified`.** Unchanged: the surrogate signs with a software
  key and says so.

## Three things for the founder

1. **One SDK parameter unlocks the floor's own reconciliation.** Adding
   `component` / `mac` / `capture` to
   `packages/scruple-host-sdk/scruple_host_sdk/witness_flow.py` — beside
   `attestation` and `continuity`, which are already there — lets every
   vendored integration send the H-4 envelope. The server half is built,
   the Python component half is built, and the round trip is measured
   above. Without it, `GET /api/v2/components/status` has nothing to report
   about any addon.
2. **No route mints a provisioning token.** `issueProvisioningToken()` is
   called only by `test/v2/*.test.ts` and by "the vendor console", which
   does not exist. A component cannot provision itself end to end today;
   the sandbox run used a script that reproduces that INSERT. That is
   arguably correct — in payments the injection ceremony is deliberately
   not something the terminal initiates — but it means the ceremony has no
   implementation.
3. **A baseline is a network precondition for every capture.** Until the
   cache in this WO, an offline Blender captured nothing. The cache is
   narrow on purpose, and the general question is the SDK's: should
   `SessionState.baseline_ref` persist, and under what re-verification
   rule? Every embedded host — Fusion, Blender, ToonBoom, Meshroom — has
   this problem and each will otherwise solve it in its own adapter, which
   is the shape of the six queue implementations D-10 is about.

## How to reproduce

```
$ SB=/mnt/corpus/scruple-blender-l2
$ $SB/b4-driver.sh app_up
$ $SB/b4-driver.sh phase attach          # establishes and caches the baseline
$ $SB/b4-driver.sh app_down
$ $SB/b4-driver.sh phase capture         # 3 real renders -> spooled
$ $SB/b4-driver.sh app_up
$ $SB/b4-driver.sh phase settle          # all three land, all_clear True
$ $SB/b4-driver.sh app_down
$ $SB/b4-driver.sh phase drop            # 3 more -> spooled
$ $SB/b4-driver.sh app_up
$ $SB/b4-driver.sh phase settle_drop     # deletes queue line 1 -> 1 MISSING
$ $SB/b4-driver.sh witness_down; $SB/b4-driver.sh phase witness_down; $SB/b4-driver.sh witness_up
```

Do not edit anything under `TAMPER_SURFACE_PATHS` between `attach` and
`capture`: the baseline cache will refuse itself, which is rule 2 working
and looks like a failure.
