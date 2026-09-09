# WO-C1 — the three-valued attestation basis, `stale` until the roots agree,
# and the `close_detection` validator rejection

_2026-09-09. Implements WO-C1 of `docs/wo/2026-09-09-council-implementation.md`
against the settled design in `docs/canon/STOOGES_RESULT_BLENDER_COMFYUI_WRAP.md`
(§1, §2, Appendix C item 0). Sandbox only: app `127.0.0.1:3902`, witness
`127.0.0.1:5899`, scratch `/mnt/corpus/scruple-council-impl/wo-c1`.
`/opt/scruple-witness` was READ, never written — its mtime is in the live run
below, before and after, as evidence._

**GATE: PASSED. All three named controls demonstrated RED before the change and
green after, over the real HTTP route, with the runs recorded.**

---

## 1 · What the leaf says now

`verified` | `stale` | `passthrough`. One basis per leaf. No per-field
`basis_ref` — twelve fields pointing at one basis still read as twelve
measurements to anyone not following the pointer.

`lib/leaf/attestationBasis.ts` is the single definition, mirrored in
`packages/scruple-api/scruple_api/attestation_basis.py` for the Python
components. Resolution order, each step a different fact:

| # | condition | basis |
|---|---|---|
| 1 | desktop profile, or enforcement `none` | `verified` unreachable → fall through |
| 2 | ⚑ Merkle vectors unsettled (today) | **`stale`, every profile** |
| 3 | no quote at all | `passthrough` |
| 4 | a quote that does not bind THIS emission | **`stale`, never `passthrough`** |
| 5 | root-chained, external nonce, covers this emission | `verified` |

Step 4 is the amendment the third value exists for. `passthrough` says the
placement has no attestable compute and the fix is a different placement;
`stale` says it has one and the binding broke, and the fix is the nonce path.
Collapsing them tells an operator to buy hardware they already own.

**Absent or malformed is never `verified`.** `basisForTrust()` is the only
reader a trust decision may use; it maps absent, null, malformed, a string
from a future version, a number and an object to `'unknown'`. `'unknown'` is
deliberately not a member of the emittable enum — a leaf written under this
design is not entitled to be unknown about its own basis, and every leaf that
predates migration 053 legitimately is.

## 2 · ⚑ `verified` is unreachable on the desktop by construction

Not unlikely. Unrepresentable, three independent ways, and each is load-bearing
because the other two are bypassed by a different kind of mistake:

1. **the type** — `BasisOn<'desktop'>` excludes it. Proved by a
   `@ts-expect-error` in `test/v2/attestation-basis.test.ts` that `npm run
   typecheck` executes; swapping the value makes tsc fail with *Unused
   '@ts-expect-error' directive*, so the guard breaks loudly rather than
   quietly widening. Demonstrated: `02-ts-expect-error-is-a-control.txt`.
2. **the validator** — `lib/leaf/captureClaims.ts` returns 422. Types do not
   survive JSON, and the wire is JSON.
3. **the database** — migration 053's cross-column CHECK. Tested with a
   control: `('verified','desktop')` is refused and
   `('verified','server-managed')` and `('stale','desktop')` are accepted, so
   the constraint is not merely refusing everything. A partial index was
   written first and replaced — an index does not refuse an INSERT, it files
   it.

The profile is derived from the **effective** placement (`profileFor()`), never
a declared one, and `attested-client` maps to `desktop` deliberately: a
host-signature check at load is a real boundary against a casual edit and none
at all against the root that can rewrite the loader.

## 3 · ⚑ Every new leaf emits `stale`

Appendix C item 0, in code rather than in prose: `CHECKPOINT_VECTORS_SETTLED =
false`. Three live Merkle constructions disagree and the witness anchors
whichever root the caller supplies, so "the root" is not a well-defined value
and no checkpoint can be claimed settled by anybody. **WO-C6 flips that
constant and nothing else may** — `resolveAttestationBasis()` takes an explicit
`vectorsSettled` override so a test can drive the settled path without changing
what the estate emits.

Enforced at both ends. The emitters resolve it (`buildLeaf()` in the sidecar,
`ServerLibraryComponent` in Python), and the validator refuses a capture-bearing
submission that declares anything else.

## 4 · `close_detection` is rejected as provenance

§1: "Filesystem observations are not freeze-gate authentication and
`close_detection` is rejected as provenance." Round 11: "so this cannot return
as a dead schema dependency."

- The validator returns 422 for any non-null `close_detection`, **inside the
  capture block and at the top level**. The top-level case was a real hole
  found by its own control: zod strips undeclared top-level keys, so a rule
  written against the parsed body refused it in one place and waved it through
  one level up. The route now validates the raw JSON.
- The key **stays in the MAC preimage, pinned at null**. Dropping it would
  change the canonical JSON and therefore every MAC across three
  implementations for a cosmetic gain; keeping it makes the MAC cover the
  assertion that there is no close detection, so a proxy cannot add one in
  flight. Dead as provenance, load-bearing as a negative.
- The observation is not deleted. `fs-watch.ts` and `kohya/checkpoint-watch.ts`
  now emit `fs_diagnostic`, uncovered by the MAC, creating and completing
  nothing — the council kept fs-watch as diagnostic corroboration. The
  capture-component test asserts **both** halves, because checking only that
  the value moved would also pass if the observation had been dropped.
- The `'IN_CLOSE_WRITE'` value in `test/vectors/component-preimage-vectors.json`
  is gone, regenerated to null. A vector carrying the retracted value is
  precisely the dead schema reference the retraction was meant to prevent —
  the next contributor copies vectors.

## 5 · The profile went into the signed preimage

Not asked for by WO-C1 by name, and it is not optional. The basis is
conditional on the profile, and `verified` is refused on `desktop`; leave the
profile out of the MAC and that refusal is one byte away from being bypassed by
anything sitting between the component and the route. This is WO-C2's argument
about the resolution handles, arriving one field early.

`profile` is now in all three preimage implementations
(`lib/leaf/componentPreimage.ts`, `services/scruple-capture/src/leaf.ts`,
`server_library.py`) and the shared vectors were regenerated. The test that
proves it works has a control: rewriting `capture.profile` in flight yields
`component_unverified`, and the untampered submission of the same shape yields
201.

## 6 · The runs

All recorded under `/mnt/corpus/scruple-council-impl/wo-c1/`.

| file | what it shows |
|---|---|
| `00-baseline-suites.txt` | before any change. v2 656/656, conformance 47/47, integration 19/19, **sdk 2 pre-existing failures in `test_model_write.py`** |
| `01-controls-RED.txt` | the three controls against unchanged code: the route answers **201** to `verified` on desktop, to `attestation_status: null`, and to `close_detection: 'fs-watch-quiescence'` |
| `02-ts-expect-error-is-a-control.txt` | the type-level guard proved load-bearing |
| `03-live-GREEN.txt` | real HTTP to `:3902`; six refusals, one 201 reading `stale`, the row on disk |
| `04-suites-AFTER.txt` | v2 672/672, conformance 47/47, integration 19/19, sdk the same 2 pre-existing failures |
| `live-run.mjs` | the live script |

### The controls, before

```
CONTROL 1: verified on the desktop profile      → 201  (accepted)
CONTROL 2: attestation_status: null             → 201  (accepted)
CONTROL 3: close_detection as a provenance field→ 201  (accepted)
THE GATE : attestation_basis column             → no such column
```

### The same six shapes, after, over real HTTP

```
CONTROL 1  — verified on the desktop profile              422 attestation_basis_refused
CONTROL 1b — verified on a sidecar, blocker standing      422 attestation_basis_refused
CONTROL 2  — attestation_status: null                     422 attestation_basis_required
CONTROL 2b — attestation_status absent entirely           422 attestation_basis_required
CONTROL 3  — close_detection: fs-watch-quiescence         422 close_detection_rejected
CONTROL 3b — close_detection: IN_CLOSE_WRITE              422 close_detection_rejected
THE GATE   — a leaf emitted today                         201 basis=stale profile=isolated-sidecar
             ROW ON DISK: {"id":1,"attestation_basis":"stale",
                           "attestation_profile":"isolated-sidecar",
                           "component_verified":1}
```

### Which witness

```
scratch witness rows before: 12   after: 13
production witness db mtime : 2026-09-02T23:37:46.576Z  (before AND after — untouched)
```

⚑ Worth recording for the WOs that follow: `.env.local` sets
`WITNESS_SERVER_URL=http://127.0.0.1:5799` — **the production witness**. Next.js
(`@next/env` `processEnv`) does not override a variable already present in the
launch environment, so the sandbox app on `:3902` keeps the `5899` it was
started with; the row counts above are the empirical confirmation, not the
argument. The same precedence rule is why the app derives component IKs from
`.env.local`'s `SCRUPLE_BDK_HEX` and why a client MACing under a dev BDK gets
`bad_mac` on every leaf — which looks exactly like a preimage disagreement and
cost half an hour here.

### One sandbox change the next WO inherits

The app on `:3902` was **restarted** during this WO (same port, same
`SCRUPLE_DB_PATH`, same `SCRUPLE_DIST_DIR=.next-council`, same
`WITNESS_SERVER_URL=http://127.0.0.1:5899`) so that migration 053 was loaded
and so a `SCRUPLE_BDK_ALLOW_DEV=1` was present — which turns out to be inert,
because `.env.local` supplies `SCRUPLE_BDK_HEX` and that wins for any variable
NOT in the launch environment. The four PIDs killed were resolved to their
command lines and their listening socket first (`ss -lptn`, `ps -o ppid,lstart`);
`:3001`'s `next-server` was identified and left alone. The scratch DB at
`/mnt/corpus/scruple-council-impl/scruple-scratch.db` is migrated to 053.
`.next-council/` is now in `.gitignore`.

### Anti-vacuity

Every assertion in §3 is `stale`, and a resolver hardcoded to return `stale`
would satisfy all of them. So one test drives the settled path with a bound
quote at a non-desktop profile and asserts `verified` comes back. `stale` is
what the blocker produces, not what the function is capable of.

## 7 · What this WO changed that it was not asked to

- **`profile` in the signed preimage** (§5). Regenerating the shared vectors
  was the consequence; the Python and TypeScript halves were re-checked
  against each other.
- **The validator refuses `passthrough` from a capture-bearing leaf** while the
  Merkle blocker stands. The ⚑ line says "every new leaf emits `stale`" and the
  series' thesis is that a rule enforced only in prose gets re-enabled by the
  next contributor. The boundary is the `capture` block: canvas, the desktop
  plugins and every component-less caller are untouched and continue to record
  no basis at all.
- **`Dockerfile.jobapi`** gained a COPY for `attestationBasis.ts`, named as a
  file rather than a directory, under the rule that already governs that list.
  A test caught this, which is the second time that test has earned its place.

## 8 · Left standing

- `npm run test:sdk` has **two pre-existing failures** in
  `packages/scruple-host-sdk/tests/test_model_write.py`
  (`test_the_dataset_lands_on_input_hash_with_the_shipped_formula`,
  `test_a_float_cannot_sneak_into_a_fixed_order_preimage`). They fail
  identically at `bbf4008` before any of this work — see
  `00-baseline-suites.txt` — and are not WO-C1's to fix. Flagged rather than
  absorbed.
- `platform_attestation_status` still exists beside `attestation_basis`.
  Migration 039 wrote its CHECK as `IN ('verified','passthrough')` and SQLite
  cannot widen a CHECK in place; rebuilding `iterations` — ~50 columns, several
  indexes, inbound foreign keys, and every leaf the estate has ever written —
  to admit one enum value deserves its own work order and the founder's eyes.
  The two are also not the same question: one is §12.4's report on the
  attestation envelope, the other is the council's per-leaf basis, which folds
  in a condition H-5 knows nothing about.
- One intermittent failure of `§10 C-6 — no ratcheting before authentication`
  was observed once during development and did not reproduce in nine
  subsequent full-suite runs or six parallel single-file runs. Recorded rather
  than dismissed; it is not caused by anything in this WO that could be found.
