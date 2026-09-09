# WO-C3 — `retention_policy_digest` binds a duration, and `expired` is measured against a named clock

_2026-09-09. Implements WO-C3 of `docs/wo/2026-09-09-council-implementation.md`
against the settled design in `docs/canon/STOOGES_RESULT_BLENDER_COMFYUI_WRAP.md`
(§1, §2 Architect's and IT Expert's rulings, hand round 7 §2, round 8 §2,
round 11 §1, Appendix C). Sandbox only: app `127.0.0.1:3902`, witness
`127.0.0.1:5899`, scratch `/mnt/corpus/scruple-council-impl/wo-c3`.
`/opt/scruple-witness` was READ, never written — `05-rails.txt` shows nothing
under it has an mtime later than 2026-09-09 01:00._

**GATE: PASSED. All three states are distinguishable from one query path, and
each was demonstrated collapsed first — before the change the four shapes
returned a BYTE-IDENTICAL HTTP 404, and through the receipt path a leaf whose
evidence was legitimately gone returned the same bytes as a leaf id nobody ever
issued.**

---

## 1 · What this closes

Architect settled the claims-versus-evidence split on two conditions. WO-C2 was
the first. This is the second, verbatim:

> the `retention_policy_digest` must bind evidence RETENTION DURATION, not just
> policy identity, so a resolution attempt after the evidence is legitimately
> gone yields a named `evidence_expired` state rather than being
> **indistinguishable from a forged handle**.

and the settlement machinery from hand round 7, which is the same argument
about silence rather than about evidence:

> an unresolved gap that never expires is indistinguishable from a policy of
> never checking — the verifier defaults to accept by exhaustion … at deadline
> the gap flips to a terminal `expired` … and `expired` must itself be
> `source: measured` against a **named clock**, since a deadline derived from a
> locally-set timestamp is exactly the config-inherited field class we already
> refused.

Two handles, in the same block and the same MAC preimage as WO-C2's five:

| handle | says |
|---|---|
| `settlement_deadline` | when this leaf's silence becomes a finding |
| `retention_policy_digest` | how long the evidence that would settle it is kept |

and one new route, `GET /api/v2/resolve/{leaf_id}`, which is where a verifier
FOLLOWING a handle arrives.

## 2 · The digest is over the durations, and that is the whole field

`lib/leaf/retentionPolicy.ts`. The digested object is

```json
{"clock":"scruple-witness-v2","policy_id":"scruple-default-v1",
 "retention_duration_s":2592000,"settlement_window_s":86400,"version":1}
```

canonicalised under `jcs-2` and hashed. Every field is inside the digest; there
is no un-digested half, because a half nobody hashes is a half anybody edits.

Two policies with the same `policy_id` and different durations therefore have
different digests — which is exactly what a digest over the NAME cannot do, and
the test asserts both halves: the digests differ AND `sha256(policy_id)` is
equal for the same pair, so what moved the digest was the duration and not the
object.

**The policy names the clock, and the clock is inside the digest too.** A
duration is not a time; "thirty days" becomes "gone at 14:00" only against some
clock, and the other half of Architect's ruling is that the clock must be
named. One signed handle therefore binds the duration AND the clock it is
counted on, and neither can be swapped for a friendlier one.

⚑ **Enrolment is not done at ingest, and that is load-bearing.** If the route
recorded whatever policy a submission described, every digest would resolve —
including a fabricated one — and the forged-handle state would collapse back
into the resolvable state on the way in. A digest is a pointer at something a
deployment already decided.

⚑ **The stored row is re-digested before it is trusted** (`resolveRetentionPolicy`).
A row edited after enrolment would otherwise answer to its original digest with
different durations: the exact substitution the digest exists to prevent,
performed on our own side of it. There is a test that edits a row and watches
it stop resolving.

## 3 · The named clock, and what it is honestly worth

`lib/leaf/namedClock.ts`. A named clock is a time source with an IDENTIFIED
READER — a name, an authority that answers for the reading, and a recorded
instant. The property the council asked for is **attribution**: that a terminal
`expired` be traceable to a party who read a clock rather than inherited from
the emitter's configuration.

🔴 **It is not a timestamp authority, and the module says so in its own header
and in a `caveat` string carried on every reading.** `scruple-witness-v2` is
this server's wall clock; nothing signs it; an operator who can set this host's
clock can move every deadline it evaluates. The honest upgrade is an RFC 3161
TSA or a roughtime authority enrolled as a second entry in `NAMED_CLOCKS`, and
the module's shape is built to take one — `readNamedClock()` is the only door.

What it does buy today is the whole of the requirement: **the component cannot
name its own clock, cannot supply the reading, and cannot produce a terminal
`expired` at all.**

### The band — how a locally-set deadline is actually caught

The component signs the deadline. It has to: the component is the only party
that knows its own settlement window. So the claim is CHECKED at ingest against
the window the named clock puts it in:

```
|deadline − (named_clock_now + policy.settlement_window_s)| ≤ 300s
```

A component whose clock agrees with the named clock lands inside the band. A
component two hours fast lands two hours out, in perfect good faith, and is
refused with `settlement_deadline_unbound` and the skew in the detail. That is
the config-inherited field rule applied to a deadline, enforced rather than
described.

And there is an **anti-vacuity case** beside it: a deadline five seconds out is
ACCEPTED. Without it, the two-hour test would prove only that a check exists,
not that it measures skew.

## 4 · Two classes of fact, stored separately

| class | columns (migration 055) |
|---|---|
| **SIGNED by the component** | `resolution_settlement_deadline`, `resolution_retention_policy_digest` |
| **MEASURED by this server** | `settlement_clock`, `settlement_clock_authority`, `settlement_observed_at`, `evidence_retained_until` |

The signed pair is stored VERBATIM — what the component said, never what this
server would have preferred, the same rule WO-C2 set for the endpoint. The
measured half the component never sees.

⚑ **There is no `settlement_state` column, deliberately.** A stored state would
be written by a reaper on a schedule and would then be wrong for exactly as long
as the reaper was down — which is the failure this mechanism exists to make
visible, reintroduced inside the mechanism. The deadline is a fact; the state is
a comparison; the comparison is made when somebody asks.

Migration 055 carries the same cross-column CHECKs WO-C1 and WO-C2 established:
a deadline without a policy is refused, and a deadline without a named clock is
refused, by the database as well as by the validator. Both are tested by UPDATE
against a real row.

## 5 · Three states, one query path

`GET /api/v2/resolve/{leaf_id}` — public and unauthenticated, for the receipt's
reason.

| state | means |
|---|---|
| `resolvable` | inside its retention window; go and fetch the evidence |
| `evidence_expired` | kept for the duration the SIGNED policy binds, and that has elapsed. Legitimately gone. `source: measured`, against the named clock |
| `unresolvable` | no such leaf, or a handle that is not the one signed |

`reason` is set only on `unresolvable`, and separates `unknown_leaf`,
`handle_mismatch` and `no_retention_binding`. A legacy leaf is not a forgery,
and flattening those would recreate the collapse one level down.

⚑ **All three answer HTTP 200, including the unknown leaf.** A 404 is also what
a verifier gets from a lost route, a firewall, a typo'd host and a decommissioned
service. Putting the one thing the council required be unambiguous into the one
field that is ambiguous by operational reality would undo the work. The state is
in the body, where the answer is the server's and not the network's.

**A forged query discloses nothing.** `leaf_hash` is null on every
`unresolvable` answer: returning it beside `unknown_leaf` would let a caller
walk the id space, and returning it beside `handle_mismatch` would hand back the
correct handle to whoever supplied a wrong one — an oracle for the exact
substitution the digest exists to prevent.

**One pair of functions, two surfaces.** `GET /api/v2/receipt/{leaf_id}` now
discloses the same two verdicts from `evaluateEvidence()` and
`evaluateSettlement()`, and a test asserts the two surfaces agree about the same
leaf. A receipt read a year later says `evidence_expired` where the same receipt
said `resolvable` the week it was issued — a measurement, not a revision.

## 6 · The runs

All recorded under `/mnt/corpus/scruple-council-impl/wo-c3/`.

| file | what it shows |
|---|---|
| `00-baseline-suites.txt` | before any change. v2 706, conformance 47, integration 19, **sdk 2 pre-existing failures in `test_model_write.py`** |
| `01-controls-RED.txt` | the fourteen shapes against unchanged code — the query path did not exist and all four states were one 404 |
| `02-the-test-is-a-control.txt` | three runs of the new test file, each with ONE mechanism removed from `settlement.ts` |
| `03-live-GREEN.txt` | the same fourteen shapes, live over HTTP, after |
| `04-suites-AFTER.txt` | typecheck clean, v2 **739/739**, conformance 47/47, integration 19/19, sdk the same 2 pre-existing |
| `05-rails.txt` | `/opt/scruple-witness` unmodified; which sockets were reached |
| `red-run.mjs` | the live script (one file, run twice — `WO_C3_PHASE=RED` then `GREEN`) |

### Before — unchanged code, real HTTP

`git stash` put the tree back at `179f875` and the new `app/api/v2/resolve/`
directory was moved aside, so this is the pre-WO server answering.

```
I1  THE HONEST LEAF (deadline + duration-binding digest)   422 resolution_handles_unsigned
I2  an IDENTITY-ONLY retention digest                      422 resolution_handles_unsigned
I3  a deadline from a clock two hours fast                  422 resolution_handles_unsigned
I4  a deadline beyond the retention window                  422 resolution_handles_unsigned
I5  a deadline with no retention policy                     422 resolution_handles_unsigned
I6  a capture-bearing leaf with NO deadline at all          201 ACCEPTED      ← the finding
I7  settlement_deadline moved 5s in flight                  422 resolution_handles_unsigned
I8  retention_policy_digest swapped in flight               422 resolution_handles_unsigned
I9  a legacy leaf                                           201 ACCEPTED
```

⚑ **Seven of those refusals are the WRONG REFUSAL and that is the finding, not
a pass.** WO-C2's rule 3 refuses any key the preimage does not read, so the
pre-WO server answers `resolution_handles_unsigned` — *"the block carries a key
no implementation of the MAC preimage reads"*. **The leaf could not state a
deadline at all.** I6 is the other half: a capture-bearing leaf that says
nothing about when its silence becomes a finding was accepted with a 201.

```
--- the three states, before ---
A  resolvable        HTTP 404  <!DOCTYPE html>…
B  evidence expired  HTTP 404  <!DOCTYPE html>…      ← byte-identical to A
3a forged leaf id    HTTP 404  <!DOCTYPE html>…      ← byte-identical to B
3b forged handle     HTTP 404  <!DOCTYPE html>…      ← byte-identical to B
  → A vs B  : COLLAPSED — the same answer
  → B vs 3a : COLLAPSED — the same answer
  → B vs 3b : COLLAPSED — the same answer

--- and through the receipt path, with real bytes ---
leaf D receipt BEFORE the reaper : 200 {"leaf_id":"30",…}
leaf D receipt AFTER  the reaper : 404 {"error":{"code":"not_found",…}}
a leaf id NOBODY EVER ISSUED     : 404 {"error":{"code":"not_found",…}}
BYTE-IDENTICAL? YES — legitimately-gone evidence is indistinguishable from a forged handle

leaf B ROW ON DISK: every settlement column null — nothing recorded when its evidence stops existing
```

Migration 055 had already been applied to the scratch database when this re-run
happened, so the columns exist in that listing. The pre-WO CODE does not write
them, which the row dump above shows.

### After — the same script, same shapes

```
I1  THE HONEST LEAF                                        201 leaf_id=31
I2  an IDENTITY-ONLY retention digest                      422 retention_policy_unresolvable
I3  a deadline from a clock two hours fast                  422 settlement_deadline_unbound
I4  a deadline beyond the retention window                  422 settlement_deadline_unbound
I5  a deadline with no retention policy                     422 resolution_handles_refused
I6  a capture-bearing leaf with NO deadline at all          422 resolution_handles_required
I7  settlement_deadline moved 5s IN FLIGHT (inside band)    422 component_unverified
I8  digest swapped for ANOTHER ENROLLED policy              422 component_unverified
I7b settlement_deadline moved ONE HOUR in flight            422 settlement_deadline_unbound
I8b digest swapped for a policy NOBODY ENROLLED             422 retention_policy_unresolvable
I9  a legacy leaf                                           201 leaf_id=32

--- the three states, after ---
STATE 1  resolvable        200  {"resolution":"resolvable", evidence.source:"measured"}
STATE 2  evidence_expired  200  {"resolution":"evidence_expired", retained_until:…,
                                 clock:{name:"scruple-witness-v2",authority:"scruple-web:v2-ingest"}}
STATE 3a forged leaf id    200  {"resolution":"unresolvable","reason":"unknown_leaf","leaf_hash":null}
STATE 3b forged HANDLE     200  {"resolution":"unresolvable","reason":"handle_mismatch","leaf_hash":null}
  → A vs B : distinct   B vs 3a : distinct   B vs 3b : distinct

--- the gap flips, measured ---
leaf B settlement : {"state":"expired","terminal":true,"source":"measured",
                     "clock":{"name":"scruple-witness-v2","authority":"scruple-web:v2-ingest",…}}
leaf A settlement : {"state":"pending","terminal":false,"source":"measured",…}
the legacy leaf   : {"state":"unknown","terminal":false,"source":"unknown",…}

leaf B ROW ON DISK: {"resolution_settlement_deadline":"2026-09-09T03:19:31.7…Z",
                     "resolution_retention_policy_digest":"sha256:1da6eaa…",
                     "settlement_clock":"scruple-witness-v2",
                     "settlement_clock_authority":"scruple-web:v2-ingest",
                     "settlement_observed_at":"2026-09-09T03:19:30.7…Z",
                     "evidence_retained_until":"2026-09-09T03:19:31.7…Z"}
```

⚑ **I7 and I8 are where the MAC coverage is actually demonstrated, and I7b/I8b
are why they had to be written that way.** `bindSettlement()` runs BEFORE
`verifySubmission()` — it refuses content and must leave no row and spend no
counter — so a tamper that also breaks a binding rule answers with the binding
rule's code. I7 moves the deadline five seconds (inside the clock band) and I8
swaps the digest for a DIFFERENT ENROLLED POLICY WITH IDENTICAL DURATIONS, so
every rule below the MAC passes and only the signature fails. The ordering is
reported rather than presented as a signature failure, and there is a test whose
name says so.

### The test file is itself a control

`02-the-test-is-a-control.txt` runs `test/v2/retention-settlement.test.ts` three
times, each with ONE mechanism removed from `lib/leaf/settlement.ts` and
everything else — validator, migration, route, receipt — left in place.

| removed | red | green |
|---|---|---|
| the named-clock BAND | **1** — `A DEADLINE FROM A CLOCK TWO HOURS FAST IS REFUSED` | 32 |
| the `evidence_expired` branch | **2** — the gate case, and the fixed-instant unit case | 31 |
| the digest RESOLUTION | **2** — the identity-only digest, and the unenrolled swap | 31 |

Each removal turns exactly the cases that measure it red and nothing else. Two
things worth stating from that table:

- **removing the expiry branch did NOT turn the settlement-flip test red**, and
  correctly: evidence retention and settlement are two axes, and the test file
  measures them separately. If one removal had reddened both, the two states
  would be one state wearing two names.
- **removing the digest resolution did not redden the foreign-clock case**,
  because that policy is genuinely enrolled — it is refused for its clock, which
  is a different rule.

### Anti-vacuity

Four cases exist only to stop the gate passing by refusing everything:

- a deadline **five seconds** out of alignment is ACCEPTED (the band measures
  skew rather than existing);
- a query supplying the **CORRECT** retention digest still reads `resolvable`
  (so `handle_mismatch` is not the answer to every query that carries a handle);
- a **legacy leaf with no capture block and no handles** is still accepted with
  a 201, and reads `settlement: null`;
- the honest leaf is accepted and its `evidence_retained_until` is later than
  its deadline — if the deadline outlived the evidence, the finding could never
  be checked.

## 7 · ⚑ A deployment requirement this WO cannot enforce

**The retention policy governs the EVIDENCE. The leaf record must outlive it.**

`evidence_expired` is answerable only because the leaf row is still there to
answer it. Part 3 of the GREEN run deletes the row and shows the collapse
returning immediately and byte-for-byte:

```
leaf D receipt AFTER the reaper : 404 {"error":{"code":"not_found",…}}
a leaf id NOBODY EVER ISSUED    : 404 {"error":{"code":"not_found",…}}
BYTE-IDENTICAL? YES
```

That is in the GREEN record on purpose. A deployment whose reaper deletes the
leaf row along with the checkpoint evidence is back to a 404 that means either
"gone on schedule" or "you made that up", and no amount of the machinery above
changes it. Nothing in this process can stop an operator running a DELETE, so
it is stated here, in `retentionPolicy.ts`'s header and in migration 055 rather
than enforced.

## 8 · What this WO changed that it was not asked to

- **`RESOLUTION_HANDLE_KEYS` went from five to seven, which changes EVERY MAC.**
  All three implementations and the shared vectors move in this commit:
  `lib/leaf/componentPreimage.ts` (via the spread it already had),
  `services/scruple-capture/src/leaf.ts`, `server_library.py`,
  `test/vectors/component-preimage-vectors.json`.
- **A capture-bearing leaf must now carry both**, so every construction site had
  to say so out loud: the sidecar config and Submitter, `kohya/index.ts`,
  `kohya/job-api-server.ts`, the probe harness, the probe fixtures, probe 06's
  forged replay, `run_demo.py`'s forged submission, and four test files. The
  type caught every one of them before a test did.
- **`lib/leaf/retentionPolicy.ts` is split from `lib/leaf/retentionRegistry.ts`**
  — pure digest function versus the half that touches the database — because the
  capture sidecar imports the first and a sidecar container has no business
  reaching a database. `Dockerfile.jobapi` copies `retentionPolicy.ts` and
  `namedClock.ts` and deliberately does NOT copy `retentionRegistry.ts`. The
  closure test caught the omission, for the fourth WO running.
- **`packages/scruple-api/scruple_api/retention.py` is a SECOND IMPLEMENTATION,
  not a copied constant**, with `test/vectors/retention-policy-vectors.json`
  generated from the TypeScript and `tests/test_retention_policy.py` recomputing
  every vector in Python. A digest is only a binding if two parties independently
  arrive at the same one.
- **`lib/canvas/baseline.ts`'s tamper-surface hash was re-recorded, and the note
  says it is a false positive.** `package.json` gained one npm script
  (`gen:retention-vectors`); nothing canvas captures changed and no dependency
  pin moved. The list hashes whole files and `package.json` is on it for the
  pins. Recorded as what it is rather than dressed as a capture-path change.
- **Two new `V2ErrorCode`s**, because the two failures have different fixes —
  "enrol the policy" and "your clock is wrong" — and one code for both would send
  an operator to the wrong file.

## 9 · Left standing, and not absorbed

- 🔴 **`scruple-witness-v2` is this server's own wall clock and nothing signs
  it.** Named and attributable, which is what the council required of a terminal
  `expired`; not trustworthy time. An operator with `date -s` moves every
  deadline this deployment evaluates. §3 says where the upgrade goes.
- 🔴 **The reaper does not exist.** `evidence_retained_until` is computed and
  stored and READ; nothing yet deletes checkpoint evidence when it elapses. That
  is the correct order — a state that flips before anything acts on it is
  honest, a reaper with nothing recording what it may delete is not — but a
  deployment reading `evidence_expired` today is being told about a duration
  that has elapsed, not about a deletion that has happened. No work order
  covers the reaper.
- `checkpoint_id` is still null on every leaf (WO-C2 rule 9, Appendix C item 0),
  so the `settled` branch of `evaluateSettlement()` is unreachable through the
  route. It is a real read of a real column and it is unit-tested, so it is not
  first exercised on the day WO-C6 lifts the blocker.
- **`packages/scruple-host-sdk/.../model_write.py` IS STILL REFUSED BY THE ROUTE**
  for WO-C1's reasons — `close_detection` and a basis it does not resolve. WO-C2
  reported it; WO-C3 has given it the settlement pair so it is not refused for a
  third reason, and has not fixed the WO-C1 half. Still a WO-C1 gap in a
  shipping path.
- **`/data/scruple-blender/vendor/` holds a STALE COPY of the host SDK**,
  predating WO-C1, WO-C2 and now WO-C3.
- `npm run test:sdk` still has the **two pre-existing failures** in
  `tests/test_model_write.py`, identical at `bbf4008`, `81d1661`, `179f875` and
  here.
