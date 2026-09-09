# WO-C4 — storage confinement: refused at startup, and re-measured on every leaf

_2026-09-09. Implements WO-C4 of `docs/wo/2026-09-09-council-implementation.md`
against the settled design in `docs/canon/STOOGES_RESULT_BLENDER_COMFYUI_WRAP.md`
(§3 as confirmed in hand round 8, IT Expert's round 8 ruling, Architect's round 8
condition 2, IT Expert's round 9 `st_dev` amendment, and the round 9 §5 and round
11 §6 "taken without argument" entries). Sandbox only: app `127.0.0.1:3902`,
witness `127.0.0.1:5899`, scratch `/mnt/corpus/scruple-council-impl/wo-c4`.
`/opt/scruple-witness` was READ, never written — `05-rails.txt` shows nothing
under it has an mtime later than 2026-09-03._

**GATE: PASSED. A `mount --bind` performed AFTER startup, against the real
component, is detected at the next emission — leaf 1 reads `confined`, leaf 2
reads `degraded_shared_storage` with `source: measured`. The control is shown
NOT firing in the same run: the startup reading the component still holds says
`confined` after the mount, which is exactly the config-inherited answer a
startup-only check would have given every leaf from then on.**

---

## 1 · What this closes

IT Expert found the coupling; the council confirmed it in the code rather than
taking it on the argument:

> `config.ts:153`: *"Sealed IK, ratchet counter, and the durable queue live
> here. 0700."* — that is `stateDir`. And `outputVolume` / `watchedVolumes` are
> separate config fields with **no stated constraint between them.**

and the chain that follows:

> an uncaptured runaway write exhausts blocks on a shared filesystem, the
> ratchet's local append cannot `fsync`, and because the MAC is the **blocking**
> half of `emit()`, the gate fails closed. **Fail-closed becomes fail-stopped,
> triggered by the very artifact class the gate cannot see.**

Two halves were settled, and the second is the one a first pass drops.

**Startup**, IT Expert, round 8, SETTLED:

> The startup check should measure `stat(stateDir).st_dev !==
> stat(outputVolume).st_dev` and verify that `stateDir` has an enforced quota or
> minimum reservable capacity via `statvfs` **before binding the proxy socket**.
> Degraded diagnostic mode is acceptable only if the resulting session leaves are
> explicitly tagged `confinement: "degraded_shared_storage"` with
> `source: measured`.

**Per leaf**, Architect, round 8, accepted unconditionally:

> a startup-only check is a *config-inherited fact by the time the leaf is
> emitted* — volumes can be remounted or bind-mounted after boot, which is
> exactly the inheritance pattern we killed on `pinned_build`. Re-read the
> `stateDir`/`outputVolume` device identity at emission and carry it as
> `source: measured | unknown`.

and IT Expert's amendment, round 9, taken without argument and named in the
ruling as *"the difference between the check working and looking like it
works"*:

> ensure the emission re-read uses **raw `stat()` device identifiers (`st_dev`)
> rather than cached path lookups**, so a mid-session mount namespace rewrite or
> bind mount directly drops the check.

## 2 · One module, and it is called twice for two different reasons

`lib/capture/storageConfinement.ts` is the whole measurement. It issues
`fs.statSync(path, { bigint: true })` on the **configured path** at the moment
it is asked — nothing memoised, no `realpath` cache, no `fs.Stats` outliving
the call that produced it — plus `fs.statfsSync` for the reservable-capacity
half. `packages/scruple-host-sdk/scruple_host_sdk/storage_confinement.py` is
the same decision in Python, for the same reason the preimage has three
implementations and one definition.

It is called in exactly two places, and the difference between them is the
work order:

| call site | when | what it does |
|---|---|---|
| `component.ts`, above `server.listen` | once, at start | refuses to bind, or logs a declared degradation |
| `leaf.ts` via `LeafContext.confinementFor` | every emission | fills `capture.confinement` / `capture.confinement_source` |

`confinementFor` is a **function** and not a `StorageMeasurement`, and that is
the whole of Architect's condition made structural: a component that captured
the reading once and passed the value would ship the defect this WO closes.
Mutant 1 in `02-the-test-is-a-control.txt` is that exact edit, and the gate test
goes red on it.

### Four values, not two

The council named one degraded tag because it was arguing about one mechanism.
There are two ways to starve the ratchet's append and they have different fixes,
so:

| value | means | fix |
|---|---|---|
| `confined` | own device, above the reservable floor | — |
| `degraded_shared_storage` | shares a device with a watched volume | move the state onto its own mount |
| `degraded_no_reservation` | own device, below the floor | give the state volume a quota or more room |
| `unknown` | a reading failed, or nothing to compare | find out why the stat failed |

This series has already refused to fold two operational conditions into one
value once — WO-C1 kept `stale` out of `passthrough` because *"those are
different operational conditions with different fixes."* A separate filesystem
that is already full stops `fsync` exactly as a shared one does, and calling
that `degraded_shared_storage` would send an operator to move a mount that is
already moved.

### What `statvfs` cannot see, said out loud

The council's phrase was "an enforced quota **or** minimum reservable capacity".
An enforced quota is not readable from userspace portably — `quotactl(2)` has no
Node binding, and a project quota on an overlay or a k8s `ephemeral-storage`
limit is enforced by a layer `statvfs` cannot see. So the module measures the
half it can (`f_bavail * f_frsize` on the state device) and **refuses to let a
configuration setting stand in for the half it cannot**: an env var asserting
`QUOTA_ENFORCED=1` would be precisely the config-inherited fact class this WO
exists to close. The only knob is the floor (64 MiB by default), which is a
policy about headroom, not a fact about a filesystem.

## 3 · Degraded operation is permitted, and it is not silent

`SCRUPLE_CAPTURE_ALLOW_DEGRADED_STORAGE=1` → `CaptureConfig.allowDegradedStorage`.
It converts a refusal into a **visible** degradation rather than making the
finding go away: the session starts, the boot log says
`DEGRADED STORAGE, DECLARED` above the port line, the Submitter logs the value
on every transition, and **every leaf carries the measured degraded value** —
so the condition travels with each artifact instead of living in a log nobody
reads.

⚑ **The waiver does not cover `unknown`.** Its entire basis is that the leaves
carry what was measured; a component that could not read its own device
identity has nothing to carry, so the start is refused whether or not the flag
is set.

⚑ **Four existing configurations declared it, because it is true of them.**
`test/v2/capture-component.test.ts`, `probes/fixtures.ts`,
`scripts/probe-harness/deployment.ts` and the Kohya paths all put `stateDir`
and the watched volumes under one `mkdtemp` root, which is one device. Rather
than weaken the gate for them, they declare — and the harness now asserts its
own degraded tag, so it cannot quietly stop being degraded without a test
noticing.

## 4 · Both fields are in the MAC, and the source is signed separately

`confinement` and `confinement_source` are capture fields in all three preimage
implementations (`lib/leaf/componentPreimage.ts`,
`services/scruple-capture/src/leaf.ts`,
`packages/scruple-host-sdk/.../server_library.py`), with
`test/vectors/component-preimage-vectors.json` regenerated so the Python suite
checks the same bytes.

The source is a separate signed field and that is not redundant. The value says
what was seen; the source says whether anything was. An attacker who could
promote `unknown` to `measured` would turn "nobody looked" into "somebody
checked", which is the whole distinction the measured-or-unknown invariant
holds.

## 5 · Three guards, and none of them is the same guard twice

Migration 053's pattern, repeated because it earned it:

| guard | stops |
|---|---|
| the types in `storageConfinement.ts` | the code being written |
| `captureClaims.ts` rule 5 | the JSON arriving — types do not survive a wire |
| migration `056`'s cross-column CHECK | any other writer that reaches the table through neither |

Rule 5 refuses four shapes, each a way the tag could be present and worth
nothing: **absent** on a capture-bearing leaf (`unknown` is available for a
placement that measured nothing — absent is a component that was never asked); a
**substantive value with an unmeasured source**, in both directions; **`unknown`
with `measured`**, because no measurement concludes that nothing was measured;
and a confinement field sent **one level up**, where `componentPreimage()` reads
by key and would silently skip it — a field outside the MAC that looks like it
is inside one.

`storage_confinement` is **NULL and not backfilled** for every row written
before 056. NULL is "the question was never asked of this leaf"; `unknown` is
"asked, and unanswerable". Defaulting the first into the second would
manufacture an answer nobody gave.

## 6 · The gate, and the control, on the same run

`run-c4.mjs` drives the **real `CaptureComponent`** under `unshare -rm`, so the
bind mount is a bind mount. The identical script was run against the pre-change
tree first.

| | before (`01-controls-RED.txt`) | after (`03-live-GREEN.txt`) |
|---|---|---|
| leaf before the mount | `confinement` **(ABSENT)** | `confined` / `measured` |
| `mount --bind` after startup | st_dev 53 → 2049 | st_dev 53 → 2049 |
| leaf after the mount | `confinement` **(ABSENT)** | **`degraded_shared_storage` / `measured`** |
| the startup-only check | did not fire | **did not fire** |
| start on shared storage | **bound port 18899** | **refused; socket answering: no** |
| shared storage, declared | leaf untagged | `degraded_shared_storage` / `measured`, logged loudly |

The control line in both runs is the same sentence, and it is the point of the
work order:

```
startup-only check AFTER the mount (the snapshot it holds): state=2049 output=53
  → still "separate devices, confined" — CONTROL DID NOT FIRE
```

A startup-only implementation passes every assertion about the boot case and
reports a confined session for every leaf after the mount. That is what the
council refused, and it is what the second column above measures.

### The tests are controls too

`02-the-test-is-a-control.txt` reverts one half at a time and records which
tests go red. Each mutant is targeted — nothing else in the file moves:

| mutant | red |
|---|---|
| 1. the per-leaf re-read becomes a startup-only value | the gate test, and only the gate test |
| 2. the startup gate never refuses | the socket-not-bound test |
| 3. the two fields leave the preimage | "rewriting `confinement` in flight invalidates the signature" |
| 4. validator rule 5 removed | six of the seven route refusals, plus the row-recording assertion |

## 7 · Files

| file | change |
|---|---|
| `lib/capture/storageConfinement.ts` | **new.** The measurement, the four values, the startup decision |
| `packages/scruple-host-sdk/scruple_host_sdk/storage_confinement.py` | **new.** The same decision in Python |
| `lib/db/migrations/056_storage_confinement.sql` | **new.** Two columns, the cross-column CHECK, the index |
| `test/v2/storage-confinement.test.ts` | **new.** 21 tests: the gate, its control, the refusals, the CHECK |
| `services/scruple-capture/src/config.ts` | `allowDegradedStorage`, `stateMinReservableBytes` |
| `services/scruple-capture/src/component.ts` | the startup gate above `listen`; `confinementFor`; `StorageConfinementError` |
| `services/scruple-capture/src/submitter.ts` | carries `confinementFor`; logs the value on change |
| `services/scruple-capture/src/leaf.ts` | `LeafContext.confinementFor`; two capture fields; both in `preimageOf` |
| `lib/leaf/componentPreimage.ts` | the same two keys, server side |
| `lib/leaf/captureClaims.ts` | rule 5 |
| `lib/v2/http.ts` | `storage_confinement_required` / `_refused`, both 422 |
| `app/api/v2/witness/route.ts` | stores both columns |
| `services/scruple-capture/kohya/{index,job-api-server}.ts` | per-leaf measurement on both Kohya doors |
| `scripts/gen-component-preimage-vectors.mjs`, `test/vectors/…json` | regenerated with the two keys |
| `packages/scruple-host-sdk/.../server_library.py`, `model_write.py` | preimage keys; measured or `unknown`/`unknown` |
| `test/v2/{attestation-basis,resolution-handles,retention-settlement,component-auth,capture-component}.test.ts` | fixtures carry the fields; the harness asserts its own degraded tag |

## 8 · Runs

| file | what it holds |
|---|---|
| `00-baseline-suites.txt` | before any change. v2 739, conformance 47, integration 19, **sdk 2 pre-existing failures in `test_model_write.py`**, typecheck clean |
| `01-controls-RED.txt` | the live run against the pre-change tree: no confinement field on either leaf, the socket bound on shared storage |
| `02-the-test-is-a-control.txt` | four mutants, each reverting one half, each red in the right place |
| `03-live-GREEN.txt` | the same live run after the change — the gate, and the control not firing |
| `04-suites-AFTER.txt` | v2 761, conformance 47, integration 19, sdk unchanged at 2, typecheck clean |
| `05-rails.txt` | `/opt/scruple-witness` untouched; no code here names `:5799` or `:3001`; the three sandbox endpoints still answer |
| `run-c4.mjs` | the script behind 01 and 03. Same file, both runs |

## 9 · What this WO did NOT do, recorded rather than left to inference

- **The startup refusal is bound to binding a proxy socket, and only the
  ComfyUI sidecar binds one.** The Kohya paths (`kohya/index.ts`,
  `kohya/job-api-server.ts`) are a checkpoint watcher and a job API; no artifact
  passes through either socket. They get the **per-leaf** half, so a Kohya pod
  with its checkpoints on the ratchet's filesystem shows up on the evidence.
  They do not refuse to start, because there is no socket whose binding would be
  the thing refused. Said here so nobody later reads the asymmetry as an
  oversight.
- **`server-library` emits `unknown`/`unknown`, and that is a measurement of the
  question.** That placement declares no watched volume — the vendor's handler
  *is* the observation — so there is no device pair to compare and `confined`
  would claim a boundary nobody established.
- **An enforced quota is still not measured**, only reservable capacity. See §2.
- 🔴 **`packages/scruple-host-sdk/.../model_write.py` IS STILL REFUSED BY THE
  ROUTE**, unchanged from what WO-C1, WO-C2 and WO-C3 each recorded: it sends a
  non-null `capture.close_detection`, which `captureClaims.ts` rule 1 returns 422
  for, and its `attestation_status` is H-5's two-valued envelope answer rather
  than the council's three-valued basis. This WO added the two confinement
  fields to it so it is not *newly* non-conformant, and measured them properly
  where `seal_path` makes the pair knowable — but it did not fix the two older
  faults, which are WO-C1's residue and want their own work order.
- The **two `test_model_write.py` failures are the pre-existing pair** recorded
  at every head in this series (`bbf4008`, `81d1661`, `179f875`, `abbc02d`) and
  are unrelated to storage.
