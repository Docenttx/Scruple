# WO-E4 — Blender registers as a Level-2 adapter, and the leaf says `supplied`

_2026-09-09. Desktop repo + addon repo (`/data/scruple-blender` `47bc3d6`);
the server repo is untouched. Gate: `bash scripts/e4-gate.sh` (`npm run e4`);
whole transcript in `.run/e4/gate-final.txt`._

## Verdict

**GATE PASSED.** Every stage green, every control fired, and the seven
mutations were each caught by exactly the assertions they target.

| what the work order asked for | outcome |
|---|---|
| the addon registers as a Level-2 host adapter, statically and at build time | **PASS** — `adapter/host_hook.py`, validated by the SDK's own `register_host()` inside Blender at enable time |
| a generation announced by the addon lands `host_semantics: supplied`, `capture.host: blender`, with the scene facts in the MAC | **PASS** — `scenarios/blender-host.json`, 37 assertions |
| control: with the addon absent, the same generation reads **`blind`** | **PASS** |
| control: addon present, silent on that generation → **`declined`** | **PASS** |
| control: a document failing the addon's own schema is refused and recorded, run continues | **PASS**, both halves — the addon refuses to write it, and one forced onto disk is declined **with its reason recorded** |
| ⚑ a wrong `prompt_id` makes a leaf say **less**, never something false | **PASS** — asserted over the whole `iterations` table, not just the run's own leaf |

The leaf, read from the shell out of the app database:

```
$ sqlite3 scruple-scratch.db "SELECT host, host_adapter, host_semantics, host_evidence …"
blender|comfy-bridge@0.1.0|supplied|9d02516496bff044…|
{"camera":"CAM_hero","engine":"BLENDER_EEVEE_NEXT","file_format":"PNG",
 "frame":196,"material_count":2,"object_count":3,"resolution":[1920,1080],
 "resolution_percentage":100,"samples":64,"scene":"atrium-872320673583dc83…"}
```

…on the same leaf as `model_fingerprints_hash=c6c3638ac614` over
`upscale_models/scruple-tiny-x2.safetensors`. **The addon never saw those bytes
and the gate never saw that scene.** That is the sentence `docs/BLENDER.md`
opens with, and it is now a row in a table.

---

## What was built

### The addon is the adapter — `/data/scruple-blender`

`HOST-HOOK.md`'s "Adding the next host" has three steps and says there is no
step 4. This is those three steps and no more:

| file | what |
|---|---|
| `adapter/host_hook.py` | the static `HostRegistration`, the evidence schema, `build_evidence()` off `bpy`, `declare()`, `announce()` |
| `operators/host_hook.py` | `scruple.host_declare` and `scruple.host_announce` — so a bridge can reach this without importing `bl_ext.user_default.scruple_blender.adapter.host_hook` |
| `__init__.py` | registers the two operators and calls `host_hook.declare()` at enable |
| `adapter/scene.py` | `render_samples()` — the sample count of the engine that is **set** (finding E4-4) |
| `tests/test_host_hook.py` | 19 tests; `tests/test_scene_capture.py` +3 |
| `tests/mocks/bpy_mock.py` | `resolution_percentage`, `EeveeSettings` — both on real bpy, both missing from the mock |
| `vendor/` | re-vendored at `/data/scruple-web` `634c66e`, which **closes finding E3-4** |

The declaration it writes, in full — every value from a module constant except
`hostVersion`, which is `bpy.app.version` measured inside the process that
declared:

```json
{ "host": "blender", "hostVersion": "4.2.23",
  "adapter": "comfy-bridge", "adapterVersion": "0.1.0",
  "evidenceType": "scruple.dev/evidence/blender-comfy-bridge/v1",
  "hooks": ["artifact.produced", "graph.execute"],
  "surfaces": ["host-api-callback"], "fidelity": "as-written",
  "declaredPlacement": "unattested-client", "enforcement": "none",
  "capabilityClasses": ["authoring-application"], "custodyLocus": "tenant-custody",
  "schema": { "type": "object", "required": ["scene", "frame", "camera",
     "engine", "resolution", "resolution_percentage", "file_format"], … } }
```

### Three decisions in it worth reading

**1. It declares `unattested-client`, and that is not modesty.** The phantom
host in `scenarios/host-adapter.json` declares `attested-client` on purpose, so
that `assuranceForHost` can be watched degrading it — that is a demonstration
of the degradation, not an example to copy. A Blender addon is a zip in a
directory the user can write to; nothing signs it and nothing isolates it, so
`unattested-client` is what it can be resolved to. Declared **equals** effective
and there is no gap to explain. `test_a_dishonest_placement_would_be_degraded`
is the control that keeps that from being a constant.

**2. It validates itself with the gate's own code, not a lookalike.**
`scruple_api.host_registry` is the Python mirror of `lib/capture/hostRegistry.ts`
and it is **vendored inside the zip**, so `register()` runs the same fifteen
refusal codes the gate will run, in the user's own Blender, at enable time. An
addon build that a gate would refuse refuses itself first. Stage 2 checks the
other half of that: the addon contains no local canonicalization, no local
hashing and no local copy of the refusal codes — a second implementation is a
second thing that can drift.

**3. `announce()` refuses to write a document its own schema rejects**, and
that is the whole of finding E4-2 below. A scene with no camera produces **no
announcement**, the leaf reads `declined`, and that is true. Writing
`{"camera": null}` would be accepted by the SDK and the leaf would read
`supplied` with a null camera inside the MAC — a leaf saying something false
instead of a leaf saying less.

### The desktop side took no new seam

**`app/` is byte-identical to WO-E3's commit**, checked by the gate rather than
asserted (`git diff --name-only 8590948 -- app/` is empty), and
`/data/scruple-web` has no uncommitted change. The whole of WO-E4 on this side
is a driver fixture, a scenario and a gate:

| file | what |
|---|---|
| `scenarios/blender-host.json` | 37 assertions, 6 mutations + `assert-expectation` |
| `scripts/e4-blender-host.py` | runs inside Blender; sets the scene up, announces, reports JSON |
| `scripts/e4-gate.sh` | the gate and all its controls (`npm run e4`) |
| `scripts/desktop-run.mjs` | `blender-host` fixture kind; `json-equals` and `host-evidence-equals-file` assertion kinds; the WO-D6 host mutations generalised from `ctx.fixtures.phantom` to *whichever host fixture the scenario declared* |
| `docs/BLENDER.md`, `docs/HOST-HOOK.md` | the two rows that changed, and `blender-host.json` added to "Proved by" |

---

## The gate

### Stage 1 — the control, RED before the change

Not a code inspection: **the addon zip built from the commit before
`adapter/host_hook.py` existed**, installed into a Blender profile of its own,
asked the same three questions as the zip after it. Resolved from the change
(the parent of the commit that first added the file), never from `HEAD`, so it
keeps meaning the same thing however many work orders land after.

```
                                                     BEFORE     AFTER
   enabling the addon writes a declaration           false      true
   bpy.ops.scruple.host_announce exists              false      true
   the generation is announced                       false      true
   PASS  both were RED before this change and are GREEN after, on the same Blender 4.2.23
```

The before-tree run is a real Blender that loaded the real previous zip and
answered `RAISED: Calling operator "bpy.ops.scruple.host_announce" error, could
not be found`. A control that produced no report at all would be
**INCONCLUSIVE**, so the in-Blender script reports a missing operator rather
than dying on it.

### Stage 4 — ⚑ what the addon refuses to say

A real Blender, a real scene, `scn.camera = None`:

```
   the scene Blender held:  camera=null  engine="BLENDER_EEVEE_NEXT"
   bpy.ops.scruple.host_announce returned ['CANCELLED']
   announce/ contains: nothing
   PASS  nothing was announced, and the declaration is still there:
         the leaf will read `declined`, which is true
```

The declaration staying put is the point: this deployment is **set up** and had
nothing sayable about **this** scene. `declined`, not `blind`.

### The gate — 37/37

Everything asserted is a column in sqlite or a JSON field returned by `bpy`
inside a running Blender. Nothing reads a pixel; nothing reads a log line for
its verdict. Three assertions carry most of the weight:

- **`⚑-leaf-carries-the-scene`** — a nonce-derived string the driver gave
  Blender, set on a `bpy` scene datablock, read back out of it by the addon,
  written to a file **before the app was launched**, and found on a leaf. The
  gate could not have known it: a wire carries bytes and a graph.
- **`⚑-leaf-carries-a-render-engine-nobody-here-chose`** — the driver says
  nothing about the engine. The expected value is what the running Blender
  reported for `scene.render.engine`, and `BLENDER_EEVEE_NEXT` is not a string
  this repository could have produced.
- **`⚑-the-document-on-the-leaf-IS-the-document-blender-wrote`** — the whole
  document, not a field of it. The per-field assertions prove fields survive;
  this proves nothing was added, dropped, or helpfully defaulted on the way.

### Stage 6 — four leaves, read from the shell

Four real runs, four rows, `sqlite3` and `bash`, independent of node, of the
app, of the gate and of the sidecar:

```
   RUN                     SEMANTICS  HOST      ADAPTER             EVIDENCE?
   clean                   supplied   blender   comfy-bridge@0.1.0  yes
   break-no-host-adapter   blind      (null)    (null)              no
   break-no-announcement   declined   blender   comfy-bridge@0.1.0  no
   break-announce-…-id     declined   blender   comfy-bridge@0.1.0  no
```

The middle two are the rows a two-valued design would have lost. `declined`
still **names the host** — that is a fact about the deployment, true whether or
not this observation was announced — and carries no document and no hash. An
operator reading `declined` goes and looks at the add-on; an operator reading
`blind` goes and installs one.

### ⚑ The correlation control, asked of the whole table

The work order's flag: *the correlation is ComfyUI's `prompt_id` and the host
chooses it; choosing it must grant nothing.* The `announce-under-a-different-id`
run has a real, complete, schema-valid announcement about a real scene on disk,
under an id the generation was not submitted with. The leaf reads `declined`
with no document — it says **less**. And then:

```sql
SELECT COUNT(*) FROM iterations WHERE host_evidence LIKE '%atrium-a66e5552…%';
→ 0
   PASS  no leaf in the database carries 'atrium-a66e5552d1cc6fa9275dba89'
```

Nothing matches loosely — not the most recent announcement, not the only one,
not the nearest timestamp. A design that did any of those would put scene facts
on an artifact nobody announced and it would look exactly like success.

### Stage 7 — the sweep

Every mutation reddened **exactly** its target list and nothing else:

```
  no-host-adapter               caught   20 red exactly
  no-announcement               caught   12 red exactly
  partial-announcement          caught   12 red exactly
  announce-under-a-different-id caught   12 red exactly
  forge-the-declaration         caught   21 red exactly
  model-swap                    caught    1 red exactly
  assert-expectation            caught    1 red exactly
```

Note what separates them, because that is the design working rather than the
tests passing. `no-declaration-was-refused` is **green** under `no-host-adapter`
and **red** under `forge-the-declaration`: Level 1 by absence and Level 1
because a declaration was rejected are different facts. `leaf-names-the-host` is
**green** under the three that leave the addon registered and **red** under the
two that do not.

`model-swap` reddening exactly one assertion is WO-D4's claim surviving a third
adapter in the chain — the host adapter, the model store adapter and the
Submitter, composed through the one `sinkWrap` seam, none aware of the others.

### Stage 8 — WO-D6 still passes

`host-adapter` (28 assertions) and `host-blind` (20) both green after the four
host mutations were generalised off `ctx.fixtures.phantom`. `phantom-cam` is
deliberately not Blender, and it has to keep working: a hook that only the host
we happen to have can satisfy is a special case wearing a general name.

### Why it is not in `npm run gate`

`npm run e4` runs it on its own. The chain `d1…d7` is already ~25 minutes; this
gate launches Blender roughly **eighteen** times — six directly and one per
scenario run, of which there are twelve — and every one of them is `qemu-user`
on an aarch64 box (finding E3-2, ~16s per background launch, ~40s per install), so
chaining it would roughly double the time to a red light for everything before
it. That is a runtime argument and not a confidence one — the gate is green and
exits 0, unlike `npm run e3`, which is red by design.

### Suites

- addon: **330 passed** (306 + 2 failed on arrival, then 308 after re-vendoring,
  then +22 new here). Nothing left red.
- regression over the shared driver: `d2-gate.sh` **PASSED** and `d4-gate.sh`
  **PASSED**, both after the host mutations were generalised in
  `scripts/desktop-run.mjs`. `d6-gate.sh`'s two scenarios are stage 8 above.

---

## Findings

### ⚑ E4-0 — the scratch database was one migration behind, and every leaf 500'd

**Found before this work order changed anything.** The first thing run here was
WO-D6's own `host-adapter` scenario, unmodified, and it failed 11 assertions
with `no iteration row for these bytes` and `queueDepth: 2`. The gate log:

```
[comfy-gate] counter=0 submit rejected 500: ; kept in queue — a captured event
             is never dropped to tidy the queue (§10 C-3)
```

`lib/db/migrations/059_declared_uncaptured.sql` — WO-E2, committed at 17:43 —
had never been applied to `/mnt/corpus/scruple-council-impl/scruple-scratch.db`,
and the app on `:3902` is `next dev`, so it was running WO-E2's code against
WO-C5's schema. Running `runMigrations()` against that database made D6 green
again in one command.

Three things follow and none of them is about WO-E2:

1. **D6's gate was silently red from 17:43 until now.** Nothing noticed, because
   nothing re-runs it.
2. **Nothing in any gate applies migrations.** The next work order that adds a
   column will break every desktop scenario the same way, and the symptom
   (`no iteration row`) points at the scenario rather than at the schema.
3. The queue behaved correctly throughout — the events were **kept**, not
   dropped. §10 C-3 held under a fault nobody had arranged.

**Suggested**: a migration check at the top of the desktop gates, or in
`d3-sandbox.ts`, which already talks to the app.

### ⚑ E4-2 — the SDK's schema check is presence-only, so a required field may be `null`

Both implementations, verbatim:

```ts
const missing = reg.schema.required.filter((k) => evidence[k] === undefined);
```
```py
missing = [k for k in reg.schema.get("required", ()) if k not in evidence]
```

A document with `"camera": null` passes both. It is then hashed, put in the
MAC, and the leaf reads **`supplied`** with a null camera — a Level-2 leaf that
asserts a host supplied semantics it did not have. `declined` was reachable and
was not reached.

**Not patched. The gate is not this work order's to change** — `docs/BLENDER.md`:
"if a WO here needs a change to the gate, that is a finding to report, not a
licence." What is this addon's business is not to emit such a document, and
`host_hook.schema_problems()` checks presence **and** type against the same
schema, so `announce()` writes nothing. Pinned in the addon suite as
`test_the_sdk_would_accept_the_document_this_addon_refuses`, which asserts both
halves in one place and says in its docstring that it should be rewritten rather
than deleted if the SDK ever tightens.

⚑ **The mitigation is per-host.** The next host to register will hit this with
nothing between it and the leaf. The fix belongs in `hostAdapterSink` —
`evidence[k] === undefined || evidence[k] === null`, or a real type check
against the declared `properties` — and it is a server-repo change with its own
gate.

### E4-3 — the Python mirror needs enum members where the TypeScript takes strings

`registerHost()` in TypeScript takes `"unattested-client"` and `"none"` as
plain strings, which is what a JSON declaration contains. `register_host()` in
Python takes the same values and **crashes**:

```
AttributeError: 'str' object has no attribute 'value'
  surface.py:236, in resolve_placement
```

`scruple_api.surface`'s enums are `str` subclasses, so `"none" ==
PlacementEnforcement.NONE` is `True` — but `resolve_placement` compares with
`is`, so the correct string takes the **degradation branch** and then dies
reaching for `.value` on the error message. A caller that read a declaration out
of JSON and passed it straight in would get a crash; a caller that caught
`AttributeError` broadly would get a silent `unattested-client`.

Handled here by passing enum members and serialising `.value` on the way to
disk (`_wire()` in `adapter/host_hook.py`), with the reason written where the
constants are. It is a real asymmetry between two files HOST-HOOK.md says to
"keep in sync by hand".

### E4-4 — the addon reported Cycles' sample count for EEVEE renders

`adapter/scene.py::read_render_settings` looked in `("cycles", "eevee")` in
order and took the first group with a `.samples`. **`scene.cycles` exists on
every scene whatever the engine is** — the Cycles addon registers its property
group unconditionally — so on Blender 4.2.23 a default scene reported:

```
engine = BLENDER_EEVEE_NEXT      samples = 4096      ← Cycles' default
```

4096 had nothing to do with those pixels. This predates WO-E4 and it is not
only a host-hook problem: `build_render_workflow` puts `samples` into the
`blender_render` workflow dict on the addon's **standalone** leaves, so the
number has been travelling for a while.

Fixed at the source: `render_samples()` dispatches on the engine that is set
(`CYCLES → cycles.samples`, `BLENDER_EEVEE[_NEXT] → eevee.taa_render_samples`,
anything else → **no sample count**, never another engine's). Measured after
the fix, in Blender: `samples: 64`, EEVEE Next's `taa_render_samples` default.
Three tests, and the mock gained the `taa_samples`/`taa_render_samples` pair so
a test can get the wrong one.

### E4-5 — the announcement is bound to the artifact by the prompt id and nothing else

HOST-HOOK.md's third limit, now measured rather than stated. A Level-2 leaf says
*"the host asserted X about the generation it submitted as N"*, which is exactly
as strong as the host and no stronger. Nothing cross-checks that the announced
scene is the scene that was rendered — and for a ComfyUI generation there is no
render at all, only a graph the addon did not see. **WO-E6's control (c)** — "an
announcement naming a scene that no render produced must not make a leaf claim
it" — cannot be satisfied by anything in this layer; the strongest available
statement is the one stage 6 makes, that a leaf never claims a scene announced
under a **different** id.

### E4-6 — two hosts with different declarations still produce indistinguishable leaves

HOST-HOOK.md's second limit, sharpened by having a second host. `blender`
declares `unattested-client` honestly; `phantom-cam` declares `attested-client`
and is degraded to `unattested-client`. Both effective placements are recorded
in the gate's ready file and **neither is on the leaf**. A verifier holding two
leaves sees `host: blender` and `host: phantom-cam` and cannot tell that one
made an honest declaration and the other made one that was refused. HOST-HOOK.md
already calls this "the next thing to close"; E4 is the first work order in
which the difference is real rather than hypothetical.

### E3-4 is closed

The zip WO-E3 measured carried a vendored SDK three commits stale, and the
addon's own suite was red about it on arrival (`306 passed, 2 failed`).
Re-vendored at `634c66e`; the suite is green and `npm run e3` was re-run against
the new zip with **no change in its verdict** — still passing everything except
WO-E3's own unresolved finding E3-1.

---

## What this does NOT cover

- **`register()` is idempotent by reusing the existing entry**, because the
  registry refuses a second registration of the same host id and an addon that
  is disabled and re-enabled would otherwise fail on the second enable. The
  identity is static, so this cannot smuggle a different declaration in — with
  one exception, named rather than hidden: an addon **upgraded in a live
  session** keeps the entry the previous version registered until Blender
  restarts. The declaration on disk is rewritten; the in-process registry entry
  is not.
- **No render happened.** This work order announces the scene a ComfyUI
  generation was submitted *from*. It does not render, and it does not check
  that the scene it announced produced anything. That is WO-E6.
- **No bridge was involved.** The prompt id is minted by the driver and the
  announcement is driven by `bpy.ops.scruple.host_announce`. Whether any of the
  eleven bridges will call that operator, and whether they can be pointed at an
  arbitrary address, is WO-E6's question.
- **Only `artifact.produced` and `graph.execute` are declared**, and the
  adapter declines anything else by construction (`hook-not-declared`). The
  addon's standalone render/save/export flow is a *different* adapter that does
  not exist yet.
- **Every Blender measurement is on an emulated CPU** (finding E3-2, aarch64
  under `qemu-user`). Enabling an addon, reading datablocks and writing JSON are
  CPU-agnostic, so nothing here is affected — but that sentence stops being
  free the moment E6 renders anything.
- **The `4096` in E4-4 was measured on 4.2.23 only.** 4.3–4.5 were not tested,
  here or in WO-E3.
- 🔴 **Every leaf in this work order reads `attestation_basis: stale`** and is
  asserted to. The surrogate is SOFTWARE-backed and the profile is `desktop`;
  `verified` is unrepresentable by construction (migration 053) and nothing
  here went near it.
