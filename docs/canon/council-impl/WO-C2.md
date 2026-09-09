# WO-C2 — the resolution handles go inside the signed preimage

_2026-09-09. Implements WO-C2 of `docs/wo/2026-09-09-council-implementation.md`
against the settled design in `docs/canon/STOOGES_RESULT_BLENDER_COMFYUI_WRAP.md`
(§1, §2 Architect's ruling, Appendix C, hand round 8 and round 11 §2). Sandbox
only: app `127.0.0.1:3902`, witness `127.0.0.1:5899`, scratch
`/mnt/corpus/scruple-council-impl/wo-c2`. `/opt/scruple-witness` was READ,
never written — `05-rails.txt` shows nothing under it was modified._

**GATE: PASSED. Every gate case and every control was demonstrated RED against
unchanged code — the route answered 201 to all fourteen shapes — and green
after, over the real HTTP route, with the runs recorded.**

---

## 1 · What this closes

The council split what a leaf CLAIMS from what it CARRIES AS EVIDENCE. Round 11:
"The leaf carries its claims and its resolution handles … The Merkle path and
the raw quote are EVIDENCE, and evidence is resolvable rather than carried."

Architect settled on that split with a condition, and this WO is the condition:

> the handles (`witness endpoint`, authority identity, `checkpoint_id`,
> preceding checkpoint id and quote time) must sit inside the signed preimage,
> or an attacker who can rewrite an unsigned endpoint redirects resolution to a
> service that will happily confirm anything — **the handle becomes the attack
> surface the proof used to close.**

Five fields, in the MAC preimage of all three implementations, carried in a
top-level `resolution` block:

| handle | says |
|---|---|
| `witness_endpoint` | WHERE the evidence resolves |
| `witness_authority` | WHOSE signature counts when you get there |
| `checkpoint_id` | which checkpoint this leaf settles into (null on every leaf today) |
| `prev_checkpoint_id` | the preceding checkpoint — Architect's interval bound |
| `prev_checkpoint_quote_time` | and when it was quoted |

They enter the preimage prefixed — `resolution_witness_endpoint`, and so on —
so a handle can never collide with a capture field and the canonical JSON says
which block a key came from.

**A top-level block, not a capture field.** `capture` is what the component
SAW; these say where the evidence for what it saw is fetched. The distinction
is load-bearing rather than tidy: `componentPreimage()` reads `capture` BY KEY,
so an unrecognised key inside it is silently skipped — it looks signed, sits
beside fields that are, and is not. That is control B below.

**The authority is not decoration on the URL.** Hand round 8: "an endpoint
field in the leaf is self-asserted by the emitter, so a compromised gate names
its own witness — the field has to carry the witness's key/authority identity
alongside the URL, or a verifier following it just gets A COOPERATING LIAR AT A
VALID ADDRESS." So a `checkpoint_id` with no `witness_authority` is refused: it
is a claim resolvable only by trusting whoever answers.

## 2 · Absent is null, and that is what signs the absence

All five keys are always in the preimage. A component with no enrolled
authority MACs `null` for it, and a component that named no witness at all MACs
five nulls.

The consequence is the half that is easy to miss: a party between the component
and the route cannot **add** a handle either. Stripping the block and supplying
one are the same failure — both change the canonical JSON — and both are caught.
Two of the gate cases below exist only to demonstrate that.

Same discipline `close_detection` runs on, one WO over.

## 3 · What is deliberately NOT in the preimage

§1 lists "checkpoint identifier and **leaf index/hash**" among the handles, and
neither is here. A component cannot sign what it does not yet know: the index is
assigned by a checkpoint that does not exist when the MAC is computed, and the
leaf hash is derived by the witness from the submission the MAC is over.
Signing a placeholder for either would put a forgeable field in the preimage
and call it covered. They belong to the checkpoint record, reached through
`checkpoint_id` — and WO-C6 bears on the index specifically: **a sorted-pair
Merkle cannot bind an index at all**, so `lib/scruple/merkle.ts` could not
honour such a field today even if the leaf carried one.

`settlement_deadline` and `retention_policy_digest` are WO-C3's. The block is
shaped to take them without a second block appearing beside it.

## 4 · The rules, enforced in the validator rather than in prose

`lib/leaf/resolutionHandles.ts`, called by the route from the RAW json — zod
strips undeclared top-level keys, so a rule about a handle sent where the
preimage does not read it cannot see the key it is about. WO-C1 found that hole
one file over; this one was written knowing it.

1. A handle outside the `resolution` block is refused — top level,
   inside `capture`, inside `component`, or a whole `resolution` object nested
   in either.
2. A capture-bearing leaf must carry the block. The endpoint and the authority
   are knowable at emission; the checkpoint half is not, and stays nullable.
3. The block's key set is EXACTLY the preimage's key set. A sixth handle
   introduced on the wire ahead of being introduced into the MAC would sit
   inside the block a reader trusts, covered by nothing.
4. A `resolution` block on a submission with no component and no MAC is
   refused. The handles' only protection is the ratchet MAC.
5. The endpoint must be an absolute http/https URL with no embedded
   credentials, no query and no fragment. It is a URL a verifier is expected to
   FOLLOW, and it is a BASE it appends a path to.
6. `prev_checkpoint_id` and `prev_checkpoint_quote_time` are present together or
   not at all, and the time is an RFC 3339 UTC instant. Half an interval bounds
   nothing; a local-offset timestamp is a bound against a clock nobody named.
7. A `checkpoint_id` requires an authority — and while the Merkle blocker
   stands, may not be named at all. Same constant WO-C1's rule 4 reads
   (`CHECKPOINT_VECTORS_SETTLED`), applied to the other half of the claim.
   **WO-C6 lifts both together, and nothing else may.**

Migration **054** stores the five, and carries the same guard as a cross-column
CHECK — WO-C1's three-guard pattern: the validator stops the JSON arriving,
this stops every other writer that reaches the table. A CHECK and not a partial
index; an index does not refuse an INSERT, it files it.

⚑ **The endpoint stored is what the COMPONENT signed, not this server's own
address**, and the route deliberately does not overwrite it. A compromised
component naming somewhere else is a fact, and rewriting the column would
destroy the only record of it. `GET /api/v2/receipt/{id}` discloses the block
with `signed`, computed from whether the component envelope actually verified —
a reader who sees `signed: false` beside a `witness_endpoint` knows to follow
nothing.

## 5 · The runs

All recorded under `/mnt/corpus/scruple-council-impl/wo-c2/`.

| file | what it shows |
|---|---|
| `00-baseline-suites.txt` | before any change. v2 672, conformance 47, integration 19, **sdk 2 pre-existing failures in `test_model_write.py`** |
| `01-controls-RED.txt` | the fourteen shapes against unchanged code — **the route answered 201 to every one** |
| `02-the-test-is-a-control.txt` | the new test file run with ONLY the preimage spread removed: 8 fail, 25 pass |
| `03-live-GREEN.txt` | the same fourteen shapes, live over HTTP, after — and the receipt |
| `04-suites-AFTER.txt` | typecheck clean, v2 **706/706**, conformance 47/47, integration 19/19, sdk the same 2 pre-existing |
| `05-rails.txt` | `/opt/scruple-witness` unmodified; which sockets were reached |
| `red-run.mjs` | the live script (one file, run twice — `WO_C2_PHASE=RED` then `GREEN`) |

### Before — unchanged code, real HTTP

```
GATE 1  witness_endpoint rewritten by ONE BYTE in flight        201 ACCEPTED
GATE 2  witness_authority rewritten by ONE BYTE in flight       201 ACCEPTED
GATE 3  checkpoint_id forged in flight                          201 ACCEPTED
GATE 4  prev_checkpoint_id rewritten by ONE BYTE                201 ACCEPTED
GATE 5  prev_checkpoint_quote_time moved by ONE BYTE            201 ACCEPTED
CONTROL A  bare handle keys at the top level                    201 ACCEPTED
CONTROL B  handles inside `capture`                             201 ACCEPTED
CONTROL C  a `resolution` block nested in `capture`             201 ACCEPTED
CONTROL D  a capture-bearing leaf with NO handles               201 ACCEPTED
CONTROL E  an endpoint carrying embedded credentials            201 ACCEPTED
CONTROL F  a checkpoint_id claimed while the blocker stands     201 ACCEPTED
CONTROL G  a checkpoint_id with NO authority                    201 ACCEPTED
CONTROL H  half an interval                                     201 ACCEPTED
THE HONEST LEAF                                                 201 ACCEPTED
handle columns on `iterations`: NONE — nothing recorded where this leaf resolves
```

### After — the same fourteen shapes, same script

```
GATE 1     422 component_unverified
GATE 2     422 component_unverified
GATE 3     422 resolution_handles_refused   (see the note below)
GATE 4     422 component_unverified
GATE 5     422 component_unverified
CONTROL A  422 resolution_handles_unsigned
CONTROL B  422 resolution_handles_unsigned
CONTROL C  422 resolution_handles_unsigned
CONTROL D  422 resolution_handles_required
CONTROL E  422 resolution_handles_refused
CONTROL F  422 resolution_handles_refused
CONTROL G  422 resolution_handles_refused
CONTROL H  422 resolution_handles_refused
THE HONEST LEAF  201 leaf_id=16
  ROW ON DISK: {"resolution_witness_endpoint":"http://127.0.0.1:5899",
                "resolution_witness_authority":"sha256:aaaa…",
                "resolution_checkpoint_id":null,
                "resolution_prev_checkpoint_id":"ckpt-2026-09-08-0417",
                "resolution_prev_checkpoint_quote_time":"2026-09-08T23:00:00.000Z"}
  RECEIPT:    resolution.signed = true
```

⚑ **GATE 3 is refused by the validator, not by the MAC, and that is stated
rather than presented as a signature failure.** Rule 7 forbids naming a
`checkpoint_id` at all while the Merkle blocker stands, so it answers before the
ratchet is consulted. The MAC does cover the field, and that is demonstrated
where it can be: `checkpoint_id is COVERED BY THE MAC, even though no leaf may
name one today` in `test/v2/resolution-handles.test.ts` MACs two preimages
differing in nothing but the checkpoint id and asserts the two MACs differ.

### The test file is itself a control

`02-the-test-is-a-control.txt` runs `test/v2/resolution-handles.test.ts` against
the tree with **one thing removed** — the `...resolutionPreimageFields()` spread,
from both TypeScript preimages — and everything else (validator, migration,
receipt) left in place. Exactly the six gate cases and the two preimage-key
cases fail; the seven control cases and the anti-vacuity case still pass,
because they measure the validator and not the preimage. That is the shape a
control is supposed to have.

Two limits of that run, recorded rather than left to be discovered:

- *`the server and the sidecar produce the identical preimage` stayed GREEN*,
  correctly — it detects DRIFT between the two, and both were wrong in the same
  way. What catches "both TypeScript implementations dropped the handles" is the
  eight failures above; what catches "Python dropped them" is
  `test_the_mac_verifies_against_an_independently_derived_key`, which builds the
  field list by hand and does not call the function under test.
- The shared vectors in `test/vectors/component-preimage-vectors.json` are
  GENERATED from `componentPreimage.ts`, so they move with it. They pin the
  cross-LANGUAGE agreement, not the field set's existence.

### Anti-vacuity

"The MAC rejects everything" would satisfy every gate case here. So
`capture.header_hash` — deliberately NOT in the preimage, and `leaf.ts` says why
— is rewritten in flight in its own test and must still be **accepted**. If that
ever fails, the gate tests have stopped measuring the preimage.

### Which witness

```
scratch witness rows before: 75   after: 76
production witness db mtime : 2026-09-02T23:37:46.576Z  (before AND after — untouched)
nothing under /opt/scruple-witness has an mtime later than 2026-09-09 01:00
```

## 6 · What this WO changed that it was not asked to

- **`witnessAuthority` is REQUIRED on `CaptureConfig`**, not optional. Every
  construction site now has to say `null` out loud. An optional field would let
  a deployment forget to enrol an authority and look identical to one that
  decided not to — and null is the value that stops the leaf naming a
  checkpoint, so it is a decision, not a default.
- **The endpoint is not separately configurable.** It is `apiBaseUrl` — the
  service the component actually submits to. Two settings for one fact is two
  answers, and the drift is silent.
- **`witness_flow.witness()` gained a `resolution=` parameter** and refuses a
  `resolution` with no `component`, mirroring the rule it already enforces for
  `capture`.
- **`model_write.py` sends the block too.** It is already refused for a separate
  reason (§8), and leaving it out would have added a second one.
- **Probe 06 and `examples/server-library-vendor/run_demo.py` gained the block
  in their forged submissions.** Both forge a MAC to prove a refusal comes from
  the ratchet; without handles the route would refuse them earlier, and each
  would report a green result it had not tested. Probe 06 says so in a comment,
  because that is exactly the failure its own header warns about.
- **`Dockerfile.jobapi`** gained a COPY for `resolutionHandles.ts`, named as a
  file. The same test caught this that caught WO-C1's omission — third time it
  has earned its place.

## 7 · Left standing, and not absorbed

- 🔴 **`packages/scruple-host-sdk/.../model_write.py` IS REFUSED BY THE ROUTE
  TODAY, AND IT WAS BEFORE THIS WO.** Its capture block sends
  `close_detection: "save-returned" | "quiescence"`, which WO-C1's validator
  returns 422 for, and it declares no `profile` and takes
  `attestation_status` from `self._assurance.leaf` rather than from
  `resolve_attestation_basis()`. Verified against the validators directly, at
  `81d1661`, before any WO-C2 change. **This is a WO-C1 gap in a shipping path,
  not a WO-C2 regression**, and it is reported rather than fixed: the fix needs
  WO-C1's controls re-run to be worth anything, and folding it in here would
  make WO-C1's "GATE PASSED" record misleading about when it was actually
  closed.
- **`/data/scruple-blender/vendor/` holds a STALE COPY of the host SDK**,
  predating both WO-C1 and WO-C2, and
  `docs/canon/blender-l2/07-h4-vendored-probe.py` calls
  `witness_flow.witness(capture=CAPTURE)` with a capture block that declares no
  basis and now no handles. Different repo, no work order; recorded so it is
  found deliberately rather than as a surprise.
- `npm run test:sdk` still has the **two pre-existing failures** in
  `tests/test_model_write.py` that WO-C1 recorded. They fail identically at
  `bbf4008` and at `81d1661`.
- One **flaky** v2 run at baseline: the first `npm run test:v2` of this session
  reported 1 failure out of 672, and the immediate re-run and every run since
  reported 0. Not identified — the first run's output was tailed and the name
  was lost. WO-C1 recorded the same shape of intermittency in `§10 C-6 — no
  ratcheting before authentication`. Recorded rather than dismissed.
- `checkpoint_id` is null on every leaf and rule 7 forbids anything else. That
  is Appendix C item 0 and it lifts with WO-C6.
