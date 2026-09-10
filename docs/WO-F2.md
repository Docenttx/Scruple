# WO-F2 — `WitnessWorker.stop()` does not drop queued captures

_2026-09-10. `docs/STATE.md` §4.9 / `docs/WO-E7.md` finding **E7-3**._

**Gate: PASS.** 51 checks, 0 failures, 0 inconclusive — `npm run f2`,
transcript `.run/f2-gate-2.txt`.

Changed: `/data/scruple-blender` `8c9062a`. The desktop repo carries the gate,
the two probes, this report, and the two E7 assertions that had to be flipped
because they asserted the defect.

**The one-line result.** Five captures queued and `stop()` called immediately:
**before**, zero of them were on either disk and nothing anywhere recorded that
they had existed. **After**, five of five, counted out of the app's database and
the SDK's spool file by digests this gate computes itself. In real Blender, four
saves and then the add-on disabled: **1 of 4 before, 4 of 4 after.**

---

## What was wrong

**`_run()` asked the wrong question at the wrong moment.**

```py
while not self._stop_flag.is_set():
    job = self._q.get()
    if self._stop_flag.is_set():
        break            # <- whatever it just pulled is dropped
    job()
```

`stop()` set the flag and put a `lambda: None` on the queue, so the loop exited
with everything still queued behind it discarded.

**And the loss was total, not partial.** A capture in that queue had not reached
the SDK, so it was not on the SDK's on-disk retry spool either — the one
mechanism whose entire job is surviving this. `unregister()` calls `stop()`, so
the losing case was a capture taken shortly before Blender quits or the add-on
is disabled: exactly what store-and-forward is for. It bit WO-E7 first, which
reported two captures where the same Blender, waiting for quiescence, reported
three.

**There was a second drop next to it.** `submit()` put jobs on the queue
whatever the worker's state, so a submission after `stop()` went onto a queue
whose reader had exited and the call site could not tell. Same defect, one
lifecycle up.

## The fix, and the product decision inside it

The work order said the code change is small — *"drain the queue before
honouring the flag, with a bound"* — and that the bound is a product question:
**how long may Blender's shutdown block on a network call?** That question is
answered here rather than deferred, and the answer is the part worth reading.

**1. The flag is honoured when a typed sentinel comes up.** `_STOP` is an
instance of `_StopSentinel`, not a callable. The queue is FIFO, so the sentinel
sits behind everything queued before `stop()` was called; a queued capture
therefore *runs*, and having run it is delivered or spooled by
`http.submit()` — the one code path CANON_SKELETON §5 property 3 guarantees
enqueues. The type matters: a `lambda: None` cannot say whether it means "the
queue is finished" or "a job that happens to do nothing".

**2. ⚑ The bound is on the NETWORK, not on the set of jobs.** This is the
decision. Nothing is ever skipped for being late. What shrinks under time
pressure is how long a *server* gets to answer:

| phase | budget | what a capture gets |
|---|---|---|
| normal session | — | `DEFAULT_TIMEOUT_SECONDS`, 30 s |
| `stop()` called | `SHUTDOWN_TIMEOUT_SECONDS` = **2.0 s** per request | a healthy server answers a small JSON POST in tens of ms; a dead one costs 2 s instead of 30 |
| drain budget expired (`SHUTDOWN_DRAIN_SECONDS` = **6.0 s**) | `HURRY_TIMEOUT_SECONDS` = **0.1 s** per request, for `SHUTDOWN_HURRY_SECONDS` = **4.0 s** | the remaining queue empties onto the spool at a fraction of a second each |

So a capture the shutdown has no time left to **deliver** is **spooled**, and
the next Blender session sends it. The declared worst case is 12 s, and stage 4
measures 6.3 s against a socket that accepts and never answers — five captures,
all five on disk.

**3. ⚑ The cut goes in FRONT of the first shutdown request, not behind it.**
The first version cut the budget only when the 6 s drain expired. That does not
work, and the gate is what said so: `http.submit()` hands `session.timeout` to
`urlopen`, and a socket already blocked in `read()` cannot be called back, so
one wedged request spent the entire shutdown and all five captures were
abandoned. Cutting at the *start* of the drain caps every request that starts
after `stop()`. See finding **F2-1** for the one it still cannot cap.

**4. Nothing writes its own retry.** CANON_SKELETON §5 forbids an adapter
retrying; the adapter here changes exactly one number on the session
(`client.timeout`) and lets the SDK's own failure path do the enqueuing.
`start()` puts the number back, so a session that reloads the add-on does not
inherit a shutdown's 0.1 s as its normal budget.

**5. `stop()` returns a report and remembers it.** `queued_at_stop`, `ran`,
`hurried`, `abandoned` — the **labels** of anything the two budgets could not
reach, not a count. `unregister()` puts a non-empty `abandoned` on the panel's
error surface. A capture that was not taken has to be visible as one, which is
the whole point of the work order.

**6. `submit()` refuses after `stop()`** and returns `False`; `_dispatch()`
records `"…: not captured — the witness worker is stopped"`.

## The gate

`scripts/f2-gate.sh` (`npm run f2`), 8 stages.

**⚑ Nothing in it is counted from the worker.** The gate recomputes the sha256
of every capture file with `sha256sum` and then counts those digests in two
places on disk: `iterations.output_hash` in the app's SQLite database, and the
`content_hash` inside each line of the SDK's queue JSONL. The identity of a
capture never passes through the code under test. The worker's own accounting is
printed beside the disk numbers, never instead of them.

| stage | what it measures |
|---|---|
| 1 | ⚑ **CONTROL (a), RED.** The add-on repo's WO-F2 commit is resolved by subject, its parent (`29962b8`) is checked out into a worktree, and **the same probe** is pointed at that tree |
| 2 | ⚑ **THE GATE.** 5 captures queued behind a held worker, `stop()`, server up |
| 3 | the same, with the base URL moved to a port nothing is listening on |
| 4 | the bound: a loopback socket that accepts and never answers |
| 4B | ⚑ **finding F2-1 measured**: a capture left on the wire *before* `stop()`, and what the drain then cannot reach |
| 5 | **CONTROL (b)**: nothing queued |
| 6 | **CONTROL (c)**: a stub answering 400, and a file over the inline limit |
| 7 | ⚑ the same thing in real Blender 4.2.23, both trees, through `unregister()` |
| 8 | **CONTROL**: the add-on's own suite — 355 tests |

### The numbers, read from disk

| | queued | delivered | spooled | total | abandoned |
|---|---|---|---|---|---|
| **before** (`29962b8`), server up | 5 | **0** | **0** | **0 / 5** | — (it could not say) |
| before, server unreachable | 5 | 0 | **0** | **0 / 5** | — |
| after (`8c9062a`), server up | 5 | 5 | 0 | **5 / 5** | `[]` |
| after, server unreachable | 5 | 0 | 5 | **5 / 5** | `[]` |
| after, server wedged | 5 | 0 | 5 | **5 / 5** | `[]` (6.3 s) |
| after, one request left on the wire first | 5 | 0 | 0 | **0 / 5** | **5, named** — finding F2-1 |
| after, nothing queued | 0 | 0 | 0 | **0 / 0** | `[]` |

The before-tree's second row is the finding in one line: **store-and-forward
could not help, because the captures never reached the SDK.**

### Control (c) — a real failure reads differently from a drop

| | recorded state | content hash | error | on the spool | delivered |
|---|---|---|---|---|---|
| dropped (before) | — nothing at all | — | — | 0 | 0 |
| server refused it (400) | `rejected` ×5 | yes | `HTTP 400` | 0 | 0 |
| over the inline limit | `refused_locally` | — | *"…is over the 26214400-byte inline limit and was not witnessed"* | 0 | 0 |

Both failures are **present** on the record with their own state, their reason
and (where one exists) the hash needed to re-take them. A dropped capture had no
state, no hash and no row anywhere. That is the distinction the control asked
for, and it is the difference between a system that lost something and a system
that will not tell you it did.

The two failure states are not new — `assurance.py` has carried
`REJECTED`/`REFUSED_LOCALLY` since WO-B3 — but until now they were the *only*
outcomes that produced a record, so their presence proved nothing about what
absence meant. It does now.

### Stage 7, in real Blender

Both trees, same Blender 4.2.23, same manifest install path, same sandbox, same
four `.blend` saves, worker held the same way — then `unregister()`, which is
what Blender calls when the add-on is disabled.

```
after   stop {"queued_at_stop": 4, "ran": 4, "hurried": false, "abandoned": []}
        unregister() 2.46s      from disk: delivered 4  spooled 0   (of 4)
before  stop  null              (it has nothing to report)
        unregister() 1.36s      from disk: delivered 1  spooled 0   (of 4)
```

⚑ **How much the before-tree loses is not fixed.** Two runs of this stage
measured 1-of-4 and 0-of-4 — it depends on where the worker happens to be when
the flag is set. That is the shape WO-E7 hit as "two where there were three",
and it is why the defect survived a work order: a loss that is sometimes zero
looks like flakiness rather than like data loss.

## Findings

### ⚑ F2-1 — the bound cannot cover the request already on the wire, and that case still loses captures

`http.submit()` passes `session.timeout` to `urlopen` and there is no cancel, so
a socket already blocked in `read()` when `stop()` is called keeps the budget it
was given — the session's 30 s — whatever the worker does afterwards. Every
request that *starts* after `stop()` is capped; that one is not.

**The consequence is not a long hang. It is that the drain may never get to
run.** `stop()` still returns inside its own budgets, because the budgets are
enforced by `join(timeout=…)` on the caller's side; but the worker thread is
still stuck behind one wedged socket, so everything queued behind it goes
unreached. Measured — **gate stage 4B**, one capture put on the wire against a
server that never answers, four queued behind it, then `stop()`:

```
   the first capture went on the wire with a 30.0s budget and stayed there
   stop() took   10.0s   hurried=True   abandoned=5
   from disk:    delivered 0   spooled 0   (of 5)
```

So this fix does **not** make loss impossible. What it changes is that the loss
is no longer silent: `abandoned` names all five, `unregister()` puts them on the
panel's error surface, and the gate asserts the identity
`delivered + spooled + abandoned = N` against disk. The guarantee the work order
asked for — *delivered or spooled* — holds for everything the drain reaches; for
what it cannot reach the guarantee is *named*, which is the weaker promise and
is stated as one.

The practical exposure is narrow: it needs the user to quit Blender in the
window where a submission is already open against a server that has stopped
answering. It is also the reason the drain budget cannot simply be tightened —
shortening it makes this case more likely, not less.

Closing it means giving the SDK a cancellable transport (a session-scoped opener
whose sockets can be shut down, or moving submission onto something with a
cancel token). That is the SDK's, it affects every host, and it is not a change
to make under a Blender work order. **Needs a work order.**

### ⚑ F2-2 — the typed sentinel introduced a hazard, and the new tests caught it

`stop()` used to put its sentinel on the queue unconditionally. When the worker
thread had already exited, that sentinel stayed there — and the *next* thread
`start()` created pulled it as its first item and returned immediately. Every
capture in that session was then refused with *"the witness worker is not
running"*.

The old `lambda: None` swallowed this: a stale sentinel was just a no-op job. A
typed sentinel makes it fatal, which is a fair trade only because it is also
visible. `start()` now purges stale sentinels and `stop()` only posts one when a
live thread will read it. Found by
`test_a_capture_queued_at_stop_reaches_the_on_disk_spool` on its first run, ten
minutes after it was written; recorded because it is the same defect one
lifecycle up — a lifecycle transition losing work silently — and because a fix
that quietly created one would have been worth less than the one it replaced.

### F2-3 — `iterations` has no `content_hash` column

The v2 leaf's `content_hash` lands in `iterations.output_hash`. The first run of
this gate scored 9 FAILs against `WHERE content_hash = …`, and sqlite3 answers a
missing column with an **error**, not a zero — so `q()` returned an empty string
and every disk count read 0, including the ones that were supposed to be 0.

⚑ **A control that reads 0 because the query is broken is indistinguishable from
one that reads 0 because the system is correct**, and stage 5 (control b) would
have passed on a broken query. It is fixed and named in the gate at the function
that does the counting. Recorded for the same reason WO-E1 recorded E1-c: an
uncalibrated control is not a control, and this one was calibrated only by
accident — the after-stages demanded a non-zero.

## What this does NOT do

- **It does not make loss impossible.** Finding F2-1 is a measured case where
  captures are still lost. What it makes impossible is losing them *silently*.
- **It does not make shutdown instant, and it does not make it free.** A
  Blender being quit with captures still queued now waits — up to 6 s normally,
  up to 12 s against a dead server, and see F2-1 for the case that is worse.
  That is a deliberate trade: the alternative on offer was losing the captures.
- **It does not touch the SDK.** `scruple_host_sdk` is vendored into the add-on
  and unchanged; the fix is entirely in `adapter/handlers.py`.
- **It does not change what `unregister()` drains first.** The spool still goes
  out before the worker stops, not after. Retrying a capture the drain has *just*
  spooled would put a second round of network calls in front of a user who is
  quitting, for something that is already durable.
- **It does not close E7-4** (one still render landing two leaves), and it does
  not touch the add-on's leaf content — that is WO-F3.
- **It does not fix F1-2.** The leaves stage 2 and stage 7 landed still carry the
  stale baseline `22e97c93…`, and the error surface still reads *"Baseline
  drift…"*. Recorded in `docs/WO-F1.md`; unrelated to this work order and
  deliberately not smuggled into it.

## Housekeeping: two assertions that had to be flipped

`scripts/e7-worker-stop-probe.py` exited **0 when a capture was dropped** —
correct when it was recording a finding, and a suite requirement that the data
loss stay once it is fixed. It now exits 0 when both jobs run, with the old
expression kept in a comment. `scripts/e7-gate.sh` stage 1C followed
(*"a capture still queued when stop() is called does not run"* → *"…is NOT
dropped"*), the way WO-F1 flipped stage 1B.

⚑ **The E7 gate was not re-run end to end** — it renders in Cycles under qemu
and takes hours. Only stage 1C is covered, verified directly:
`.run/f2/e7check-worker-stop.json`, `ran: ["first","second"]`, exit 0.

## Files

| repo | file | what |
|---|---|---|
| add-on | `adapter/handlers.py` | the drain, the typed sentinel, the two-phase network budget, the stop report, `submit()` refusing after stop, `_set_session_network_budget()` |
| add-on | `tests/test_handlers.py` | +9 tests: the drain, order, the empty stop, the named abandonment, the budget in front of the first request, submit-after-stop, the spool count read from the queue file |
| desktop | `scripts/f2-gate.sh` | the gate, 8 stages |
| desktop | `scripts/f2-worker-spool-probe.py` | the real class outside Blender, six modes, runs against **both** trees |
| desktop | `scripts/f2-blender-quit.py` | inside Blender: save, then disable the add-on |
| desktop | `scripts/e7-worker-stop-probe.py`, `scripts/e7-gate.sh` | flipped to assert the closure |
| desktop | `docs/STATE.md` | §4.9 marked closed; §9 row E7-3 → `closed` |
| desktop | `package.json` | `npm run f2` |

## Re-running

```bash
cd /mnt/corpus/scruple-desktop
npm run f2                                        # the gate — 51 checks
python3 scripts/e7-worker-stop-probe.py           # the smallest reproduction, now asserting the closure
cd /data/scruple-blender && python3 -m pytest -q  # 355
```

🔴 Rails. The only remote the gate dials is the scratch app on `:3902` and,
through it, the scratch witness on `:5899`. Everything else it talks to is a
loopback stub the probe's own process starts and stops: a closed port, a socket
that accepts and never answers, and an HTTP server that returns 400. Nothing
here touches `:5799` or `:3001`, nothing reads or writes the live witness
database, and `CHECKPOINT_VECTORS_SETTLED` was not flipped. `$HOME` is
redirected per stage so the SDK's key cache and spool under `~/.scruple` are the
gate's and not the box's.
