# The ComfyUI hook, host-agnostic

_WO-D6, 2026-09-09. Read `DESIGN.md` first — this is the specification its
"The ComfyUI hook — generic, not Blender-specific" section asks for._

Blender is consumer #1 of this hook. It is not a special case of it, and this
document exists so that the next host — Photoshop, ToonBoom, Meshroom, a
renderer nobody here has heard of — is a registration rather than a new capture
path. **The gate never changes.**

## The two levels

|  | Level 1 | Level 2 |
|---|---|---|
| what the host does | points its ComfyUI address at the gate | that, plus registers an adapter |
| code from us | none | none — the adapter is the host's |
| byte coverage | **complete** | complete |
| the workflow graph | captured | captured |
| model fingerprints | present | present |
| **meaning** | **none, and the leaf says so** | supplied by the host |
| `capture.host_semantics` | `blind` | `supplied` or `declined` |

Level 1 is not a degraded Level 2. It is the honest description of what a
network gate can see: `lib/capture/surface.ts` says the surface axis affects
**coverage**, not assurance, and a Level-1 deployment has full coverage and no
semantics. An anonymous PNG was uploaded and an anonymous PNG came back; that
is true, complete, and blind.

⚑ **The point of the whole design is the last row.** A Level-1 leaf DECLARES
its blindness. It is not a Level-2 leaf minus some fields.

## How a host declares itself

Registration is **explicit, static and build-time**. `surface.ts`'s caveat binds
here unchanged: there is no dynamic plugin loading and there will not be one —
an adapter loaded at runtime from a path the measured party can write to is
`unattested-client` by definition, whatever it declares.

A host hands a `HostRegistration` to `registerHost()`
(`lib/capture/hostRegistry.ts`; Python mirror in
`packages/scruple-api/scruple_api/host_registry.py`):

```jsonc
{
  "host": "phantom-cam",              // stable, lowercase; lands in capture.host
  "hostVersion": "4.2.1",             // which build declared itself
  "adapter": "viewport",              // one host has several: viewport, render-queue
  "adapterVersion": "1.0.0",
  "evidenceType": "scruple.dev/evidence/phantom-cam-viewport/v1",
  "hooks": ["artifact.produced", "graph.execute"],   // §4 hooks it serves
  "surfaces": ["host-api-callback"],
  "fidelity": "as-written",
  "declaredPlacement": "attested-client",            // DECLARED. Resolved before trusted.
  "enforcement": "none",
  "schema": { "type": "object", "required": ["scene", "frame", "camera"], "...": {} }
}
```

### What a registration may NOT say

A host declares **what it is**. It does not declare **how good it is**.

- `attestation` is refused as a registration key (`host_may_not_grade_itself`).
  The outcome is derived by `assuranceForHost()` from the **resolved** placement.
  In the example above the host declares `attested-client` and nothing enforces
  it, so the effective placement is `unattested-client` — the gap between the
  two is the finding, not a claim we repeat.
- `evidenceType` must be a versioned predicate URI. An evidence shape that
  changes without changing its name is unreadable in hindsight.
- `schema.required` must be non-empty. A schema that validates everything makes
  `declined` unreachable, and an adapter that can never decline is an adapter
  whose `supplied` says nothing.

Every refusal has a code: `host_id_malformed`, `host_already_registered`,
`host_version_missing`, `adapter_malformed`, `evidence_type_unversioned`,
`hooks_empty`, `hook_unknown`, `surfaces_empty`, `surface_unknown`,
`fidelity_unknown`, `placement_unknown`, `enforcement_unknown`,
`schema_not_an_object_schema`, `schema_requires_nothing`,
`host_may_not_grade_itself`.

A refused declaration does **not** stop capture. The deployment runs at Level 1
and the refusal is recorded (`gate.hostHook.refused`), because a third-party
add-on with a bad manifest must not be able to take a tenant's ComfyUI down —
and must not be able to get its meaning onto a leaf either.

## What an adapter must implement

Against `surface.py`'s `ObservationSink`, and **not by implementing it**:

```ts
interface HostAdapter {
  readonly registration: HostRegistration;
  semanticsFor(o: CaptureObservation): Promise<Record<string, unknown> | null>;
}
```

That is the entire interface. `hostAdapterSink({ adapter, inner })` builds the
`ObservationSink` and the host never holds `inner`.

This is deliberate and it is CANON_SKELETON.md §5's adapter rule made
structural. A surface "MUST NOT construct an HTTP request, handle payment,
decide MIME, decide applicability, or write its own retry… MUST NOT compute a
MAC, advance the ratchet counter, or decide whether a leaf is verified or
passthrough." A host that wrote its own sink *could* do several of those, and
could swallow an observation — the gate delivers bytes only after `sink.emit`
resolves, so a dropped observation is a silently un-witnessed artifact. A host
that writes `semanticsFor` **cannot**, because it is never handed the sink.

`semanticsFor` may throw. The SDK catches, records `declined`, and delivers the
observation anyway: a host adapter bug costs the leaf its semantics and never
costs the artifact its leaf.

**Transport is the adapter's business.** The contract is the return value. Scruple
Desktop Studio's adapter (`app/comfy/hostAdapter.ts`) uses a directory, because
`open(path, 'w')` exists in every host's scripting runtime and needs no port, no
auth and no dependency:

```
<hostDir>/scruple-host.json          the declaration
<hostDir>/announce/<prompt_id>.json  one document per generation
```

The correlation is the ComfyUI `prompt_id`, and the host chooses it — `server.py`
does `prompt_id = str(json_data.get("prompt_id", uuid.uuid4()))`. Choosing it
grants nothing: the announcement directory is named by the app's environment, an
id nobody announced reads back as `declined`, and a document that fails the
host's own declared schema reads back as `declined` too. The worst a wrong id
can do is make a leaf say less.

## What the leaf says

Five fields on the capture block, **all five in the MAC preimage**, plus the
document at the top level beside `model_fingerprints`:

| field | Level 1 | Level 2 supplied | Level 2 declined |
|---|---|---|---|
| `capture.host_semantics` | `blind` | `supplied` | `declined` |
| `capture.host` | `null` | `phantom-cam` | `phantom-cam` |
| `capture.host_adapter` | `null` | `viewport@1.0.0` | `viewport@1.0.0` |
| `capture.host_evidence_type` | `null` | the predicate URI | the predicate URI |
| `capture.host_evidence_hash` | `null` | sha256 of the canonical document | `null` |
| `host_evidence` (top level) | absent | the document | absent |

`capture.host_semantics` is **never null on a leaf a component emits**:
`buildLeaf` defaults it to `blind`, so blindness is declared by the code that
runs when there is no adapter and cannot be forgotten by an adapter that is not
there.

### Why three values and not two

`declined` — an adapter **was** registered and had nothing to say about **this**
observation — is a different operational condition from `blind`, with a
different fix and a different owner:

- `blind` → an integration that was never done. Ship the adapter.
- `declined` → an integration that is not working. The add-on did not announce,
  or announced a document its own schema rejects.

Collapsing them would make those read the same and send an operator to the wrong
file. It is the distinction `upstream_uncaptured_reason` holds open between
`not_queried` and `evicted_or_restarted`, one field over, for the same reason.

### Three guards, and none of them is the same guard twice

1. **Types** (`hostRegistry.ts`) stop the code being written.
2. **`captureClaims.ts` rule 7** returns 422 — types do not survive a wire.
   It refuses: a capture-bearing leaf with no `host_semantics`; a non-`blind`
   value with no adapter; `blind` beside any host field or document; `supplied`
   with no hash; `declined` with one; and any of the five sent one level up,
   where `componentPreimage()` would not read it and the field would be outside
   the MAC while looking exactly like a signed one.
3. **Migration 058's cross-column CHECK** stops any other writer, present or
   future, that reaches the table through neither.

And the document is bound twice over: the **hash** is inside the MAC and the
**document** is not, so `/api/v2/witness` recomputes the digest from the
manifest and refuses a pair that disagrees. Rewriting the level in flight breaks
the signature; rewriting only the document is caught by the recomputation.

## What Level 2 does NOT buy — say it here, not in a sales deck

`host_semantics: "supplied"` means **a registered host said this**. It does not
mean anybody checked, and three limits follow from that. None of them is a bug
to be engineered away; all three are properties of putting the meaning where the
meaning actually is.

1. **The host is the source, and the host is unattested.** `phantom-cam` above
   resolves to `unattested-client`, as `blender` and `fusion_today` do in
   `CANON_HOST_PROFILES`. An add-on that reports the wrong camera produces a
   leaf that faithfully records the wrong camera. What the leaf buys is that the
   claim is *attributable and versioned* — `host_adapter` is `viewport@1.0.0`,
   so a batch of leaves from a known-bad build can be found.

2. ⚑ **The host's resolved placement is NOT on the leaf.** It is computed at
   registration and recorded in the gate's ready file
   (`gate.hostHook.registered.effectivePlacement`), but a verifier holding only
   a leaf sees `host` and `host_adapter` and has to look the host up to learn
   that neither was enforced. **This is the next thing to close** — a sixth
   signed field, or a resolution handle to the registration — and it is named
   here rather than left for a reader to discover.

3. **The announcement is bound to the artifact only by the `prompt_id`, which
   the host also chooses.** The gate correlates by that id and nothing else
   cross-checks that the announced scene is the scene that was rendered. A
   Level-2 leaf therefore says "the host asserted X about the generation it
   submitted as N", which is exactly as strong as the host and no stronger.

The things that are **not** conditional on any of this are the bytes, the graph,
the model fingerprints and the leaf itself. Those come from the gate and from
the machine, and a Level-1 deployment has all of them.

## Adding the next host

1. Write the `HostRegistration`. Pick a versioned `evidenceType` and a schema
   whose `required` list is what your evidence actually always contains.
2. Write `semanticsFor`. One function. Pick your own transport.
3. Register it at startup.

There is no step 4. The gate, the correlator, the Submitter, the ratchet, the
leaf and the route are untouched — which is what "the gate is host-agnostic; the
meaning is host-supplied" means when it is code rather than a sentence.

## Proved by

- `scenarios/host-adapter.json` — a fake host, `phantom-cam`, declaring itself
  and reaching the leaf. 28 assertions.
- `scenarios/blender-host.json` — **consumer #1, for real** (WO-E4). Blender
  4.2.23 headless with the shipped addon zip installed: enabling it writes the
  declaration, `bpy.ops.scruple.host_announce` writes the document, and the
  scene, frame, camera, engine, resolution, sample count and file format reach
  the leaf beside `model_fingerprints`. 37 assertions, six mutations, and it
  needed **no change to this contract, to `hostRegistry.ts`, or to `app/`** —
  which is the sentence "there is no step 4" being true rather than intended.
- `scenarios/host-blind.json` — the same gate with nobody registered, asserting
  `blind` **positively**, with an inverse control that adds a host and turns it
  red.
- `test/v2/host-hook.test.ts` in the server repo — 25 tests over registration,
  composition, rule 7 and the route.
- `scripts/d6-gate.sh` — including stage 1, which asks the pre-change tree the
  same two questions and shows both controls red.
