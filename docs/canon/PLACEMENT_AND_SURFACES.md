# Placement and surfaces — the two axes §4 was missing

**Status:** Design. The interfaces are written (`lib/capture/surface.ts`,
`packages/scruple-host-sdk/scruple_host_sdk/surface.py`); no surface is
implemented yet.
**Version:** 0.1 · 2026-08-30 · WO-5 of `WO-SERIES-CANON-AS-FLOOR.md`
**Binds:** `CANON_SKELETON.md` §4 (hooks) and §5 (what an adapter may not do)
**Consumes:** `H4-DUKPT-CAPTURE-COMPONENT.md` (the sidecar spec and its probes),
H-5 as implemented in `packages/scruple-attestation-verifiers/`
(`verified` / `passthrough`), `oss-study/witness.md` §6 (the interface shape)

---

## 1. The problem this closes

`CANON_SKELETON.md` §4 gives nine host hooks. Every one of them answers
**when** capture fires. None answers **how the bytes are observed** or **where
the observing code runs** — and those two decide whether P1 (runtime boundary
integrity) and P3 (key custody) can hold at all.

The consequence, concretely: `model.write` in Kohya's in-pod monkey-patch and
`model.write` in a vendor's own inference backend are the same hook, and one of
them fails five of the eight requirements. §4 as written cannot tell them
apart. A skeleton that cannot distinguish those two is not a skeleton; it is a
list of event names.

Three axes, then:

| Axis | Question | Values |
|---|---|---|
| **Hook** *(existing)* | When does capture fire? | `attach`, `detach`, `document.open`, `document.close`, `document.save`, `artifact.produced`, `graph.execute`, `model.write`, `idle.tick` |
| **Surface** *(new)* | How are the bytes observed? | `network-gate`, `filesystem-watch`, `in-process-callback`, `host-api-callback` |
| **Placement** *(new)* | Where does the observing code run? | `server-library`, `sidecar-gate`, `attested-client`, `unattested-client` |

---

## 2. Two rules that do most of the work

### 2.1 Assurance is a pure function of placement and attestation

Not of surface, not of hook, not of host, not of modality. Onboarding a new
host means naming its hooks, its surfaces and its placement — never writing new
evidence logic. §5 below specifies the function.

### 2.2 Surface does not affect assurance. It affects coverage.

This is the generalisation of the ComfyUI two-path finding (H-4 §2). ComfyUI
returns retrievable output over the WebSocket without ever touching disk, so a
filesystem watch alone misses it entirely; a tenant with a shell reads
`output/` directly, so a network gate alone misses that.

Neither gap produces a *weaker* leaf. Each produces **no leaf, for events that
happened**. That is a different kind of failure from a passthrough attestation
and it must not be modelled as a lower tier, because a missing leaf is
invisible and a passthrough one is not.

Two consequences:

- `assuranceFor()` takes no surface argument, deliberately.
- Coverage is established outside the axes — by H-4 §7 probes 4 and 5, and by
  ratchet gap accounting (H-4 §4.2). See DEFECT-2.

---

## 3. Surface — how the bytes are observed

| Surface | Bytes seen as | Canonical example | Structurally cannot see |
|---|---|---|---|
| `network-gate` | in transit through a proxy the measured party cannot route around | ComfyUI `POST /prompt`, `GET /view`, WS binary frames | anything produced and consumed without crossing the gate — a shell reading the output volume |
| `filesystem-watch` | a completed file, hashed on `IN_CLOSE_WRITE` | the H-4 component's watcher on the shared output volume | anything that never becomes a file — ComfyUI's `SaveImageWebsocket` path |
| `in-process-callback` | inside the producing process, via hook, patch, or direct SDK call | Kohya's `safetensors.torch.save_file` patch; a vendor calling `capture()` from its handler | anything the process does not route through the patched call |
| `host-api-callback` | handed over by the host application across a published API | Blender `save_post`/`render_write`, Fusion `documentSaved`, Adobe UXP `afterSave` | anything the host does not raise an event for — Blender has no `export_post`, so glTF/FBX/USD exports are invisible to it |

**The same surface value spans the whole assurance range.** Kohya's
monkey-patch and a Hugging-Face-shaped vendor's SDK call are both
`in-process-callback`. That is not a modelling failure — it is the point.
Surface says how you see; placement says whether what you saw is worth
anything.

### 3.1 Fidelity — a modifier on the observation, not a fifth surface

See DEFECT-3. Every observation declares one of:

| Fidelity | Meaning | Third party can re-check the hash? |
|---|---|---|
| `as-delivered` | the exact bytes the consumer received | yes |
| `as-written` | the exact bytes the host wrote to disk | yes, tamper-evidently (a later edit is a new close, a new hash) |
| `induced` | the surface **caused** a serialization and hashed that | **only if the exporter is byte-deterministic and the artifact was retained** |

Fidelity does not enter the assurance function — it says nothing about who
could tamper with the capture code. It says whether the leaf is checkable by
someone holding the artifact, which is exactly the adversary the desktop
plugins exist for.

---

## 4. Placement — where the observing code runs

Placement is **not topology**. It answers one question:

> Can the party whose behaviour is being measured modify the code that measures
> it, or reach the key that seals the measurement?

Read every value by that question and only that question. Kohya's in-pod hook
is server-side, runs on hardware the tenant does not own, and is nonetheless
`unattested-client`, because the tenant has root in that container.

| Placement | What it means | P1 | P3 |
|---|---|---|---|
| `server-library` | the vendor's own backend calls the SDK; the measured party has no code execution in that process | holds, structurally | holds — ordinary secret management |
| `sidecar-gate` | a separate container/namespace with no tenant exec, debug or filesystem access, on the only route to the workload | holds by topology; checkable only by probe | holds if the IK is sealed to an attested measurement, otherwise conditional |
| `attested-client` | capture runs inside a host application that verifies code integrity at load | conditional on the host actually enforcing it | conditional on OS key custody |
| `unattested-client` | capture code the measured party can read and edit | **fails** | **fails** |

### 4.1 The fourth value exists so the model can refuse

`unattested-client` is not a wastebasket. It is the shape the standard says no
to, and naming it is how a standard refuses rather than bends. Events at this
placement may be **recorded as declared**; they may never be reported as
witnessed (D-8: `ok` never implies `witnessed`).

**Attestation is ignored at this placement, by design.** A browser page can
relay a genuine root-verified SEV-SNP quote it fetched from a server it does
not run. That quote proves something about a machine and nothing about the
capture. If attestation could lift `unattested-client`, the standard would be
claimable by anyone able to make one HTTP request.

### 4.2 Declared vs. effective placement

A placement is a claim about enforcement. The claim and the enforcement are
recorded separately, and the assurance function only ever sees the resolved
result:

| Declared placement | Required enforcement |
|---|---|
| `server-library` | `no-tenant-code` |
| `sidecar-gate` | `isolated-namespace` |
| `attested-client` | `host-enforced-signature` |
| `unattested-client` | `none` |

`resolvePlacement(declared, enforcement)` is total over 4 × 4. If the required
enforcement is absent the effective placement is **`unattested-client`** — never
an intermediate tier, because "some enforcement, but not the one this tier
needs" is a different claim, not a partial one.

`no-tenant-code` is a property of a **configuration**, not of a vendor. A
vendor offering bring-your-own-container or `trust_remote_code` alongside a
managed path has two configurations with two placements and two tiers.
Certification is per configuration, EMV L3-style (H-4 §7).

---

## 5. The assurance function

**Input:** effective placement, and the attestation outcome.

The attestation outcome is H-5's `dispatch()` result reduced to three cases,
using H-5's vocabulary unchanged
(`packages/scruple-attestation-verifiers/src/verifier.ts`):

- `verified` — `{ok: true, status: 'verified'}`. Chained to the vendor root,
  nonce matched the leaf preimage, inside the freshness window. All three.
  **No plugin in the package can produce this today**; none implements root
  chaining, which is why `verifyRootVerified()` demands a `rootProof` argument.
- `passthrough` — `{ok: true, status: 'passthrough'}`. Stored and anchored
  opaquely. Every built-in verifier is here.
- `none` — the leaf carries no envelope. Note H-5 *rejects*
  `attestation_type: 'none'` on a leaf envelope; `none` here means absent, not
  null.

A hard failure (`ok: false`) is not an input: the leaf is rejected before
assurance is computed.

### 5.1 The decision procedure

```
assurance(placement, attestation):

  1. if placement == unattested-client:
         P1 = fails; P3 = fails; leaf = NONE (no leaf may be issued)
         canClaim = false
         return                          # attestation is not consulted

  2. P1 by placement:
         server-library    → holds        (no tenant code in the process)
         sidecar-gate      → conditional  (H-4 §7 probes 1, 2, 4, 5)
         attested-client   → conditional  (host verifies signature at load;
                                           running build measurement matches a
                                           published build; no scripting console
                                           that can call the plugin with forged
                                           arguments)

  3. P3 by placement + attestation:
         server-library                    → holds
         attestation == verified           → holds   (IK sealed to the build
                                                      measurement, H-4 §4.4)
         otherwise                         → conditional
                                             (sealed key 0600, owned by a
                                              principal the measured party is not)

  4. leaf = 'verified' if attestation == verified else 'passthrough'

  5. canClaim = true
```

`conditional` is not a third compliance state — compliance stays binary
(Standard §5). It means the property is true *if and only if* the named
conditions are evidenced, and it names them so they can be.

### 5.2 The full table — 12 cells, all resolved

| Placement | Attestation | P1 | P3 | Leaf | Can claim? |
|---|---|---|---|---|---|
| `server-library` | `verified` | holds | holds | `verified` | yes |
| `server-library` | `passthrough` | holds | holds | `passthrough` | yes |
| `server-library` | `none` | holds | holds | `passthrough` | yes |
| `sidecar-gate` | `verified` | conditional | holds | `verified` | yes |
| `sidecar-gate` | `passthrough` | conditional | conditional | `passthrough` | yes |
| `sidecar-gate` | `none` | conditional | conditional | `passthrough` | yes |
| `attested-client` | `verified` | conditional | holds | `verified` | yes |
| `attested-client` | `passthrough` | conditional | conditional | `passthrough` | yes |
| `attested-client` | `none` | conditional | conditional | `passthrough` | yes |
| `unattested-client` | `verified` | **fails** | **fails** | **none** | **no** |
| `unattested-client` | `passthrough` | **fails** | **fails** | **none** | **no** |
| `unattested-client` | `none` | **fails** | **fails** | **none** | **no** |

Read the top-right cell carefully: **`server-library` with no attestation at
all still produces only a `passthrough` leaf.** P1 being free does not buy a
`verified` attestation; nothing does except chaining to a vendor root. That is
the honest answer to H-4 §9's open question about canvas on Modal, and it is
why a reference integration built on non-attestable compute can only ever
demonstrate its second-strongest tier.

---

## 6. The interfaces

`CaptureSurface` in `lib/capture/surface.ts` and
`scruple_host_sdk/surface.py`. Shape follows TestifySec witness's `Attestor`
(`Name`/`Type`/`RunType`/`Attest`/`Schema`) as already translated in
`oss-study/witness.md` §6.1. That study's `CapturePlugin` is the **evidence**
contract — what is captured, in which phase. `CaptureSurface` is the
**transport** contract — how the bytes are seen at all. A surface hosts capture
plugins; it does not replace them.

```
name()          stable id, e.g. "comfyui-http-gate"
evidenceType()  versioned predicate URI
surface()       which of the four mechanisms
fidelity()      as-delivered | as-written | induced
hooks()         which §4 hooks this surface can serve
placement()     declared placement
enforcement()   what enforces it
schema()        JSON Schema of this surface's evidence shape

open(ctx)   acquire the observation position — bind the gate, start the
            inotify watch, install the host callback. MUST throw if the
            position cannot be acquired: a surface that silently fails to
            open is the ComfyUI WS gap by another name.
observe()   drive the surface's own event source, emit to the sink. On the
            interface so a host with no event source (idle.tick) can be pumped.
close()     release and flush. Does NOT drain the SDK queue; that is the SDK's.
```

### 6.1 No hot-pluggability — the caveat carried from the witness study

witness's attestors are compiled in via Go `init()`. They are not dynamically
loadable and neither are these. Registration is an explicit call made at build
or startup time by code we publish and measure.

This is not a limitation we are apologising for. **A capture surface loaded at
runtime from a path the measured party can write to is `unattested-client` by
definition, whatever its placement claims.** Dynamic plugin loading and P1 are
mutually exclusive; we are choosing P1.

### 6.2 What a surface may not do

`CANON_SKELETON.md` §5's adapter rule binds surfaces identically: no
constructing HTTP requests, no handling payment, no deciding MIME, no deciding
applicability, no writing its own retry. Three more, specific to surfaces:

- no computing a MAC,
- no advancing the ratchet counter (H-4 §5: derive → MAC → ratchet → enqueue is
  the SDK's ordering and getting it wrong is silent),
- no deciding whether a leaf is `verified` or `passthrough`.

If a surface needs one of these, the SDK is missing something and the SDK is
where it gets added.

MIME in particular: a surface takes it from the producing node's type, the host
API, or the gate's declared content type. A surface that cannot determine one
emits the observation **without** a MIME and lets `capture()` refuse — it does
not supply `application/octet-stream`, which is what five of the six shells did
and which silently gates the server's image-only watermarker shut.

---

## 7. Six hosts on three axes

Three of these we have code for. Three we do not. Where a host's declared
placement and its effective placement differ, both are shown, because the gap
**is** the finding.

### 7.1 ComfyUI — `sidecar-gate`, the reference shape

| | |
|---|---|
| **Hooks** | `graph.execute` (`POST /prompt`), `artifact.produced` (output file or WS frame), `attach`/`detach` at component provisioning |
| **Surfaces** | `network-gate` **and** `filesystem-watch` — neither sufficient alone (H-4 §2) |
| **Fidelity** | `as-delivered` on the gate, `as-written` on the watcher |
| **Placement** | declared `sidecar-gate`, enforcement `isolated-namespace` → effective `sidecar-gate` |
| **Attestation** | `none` today (Modal). H-4 §9 open. |
| **Assurance** | P1 conditional · P3 conditional · leaf **`passthrough`** |

**What makes P1 fail:**

1. The tenant reaches ComfyUI directly, bypassing the gate (probe 1). Today's
   canvas proxy is HTTP-only and hands WS to a pass-through sidecar.
2. The WS pass-through assumption is a property of the *upstream application*,
   not of our code. `STUDIO_P1-P8_GRADE.md` records it as condition 1 on
   canvas's conditional PASS: a ComfyUI version that returns result bytes over
   WS silently opens an uncaptured egress path. This needs an assertion in the
   baseline, not a comment in a file.
3. Personal machines. If a user defines their own custom-node manifest they
   choose the middleware inside the boundary. **WO-7 as specified would move
   canvas from P1-PASS to P1-FAIL** — a decision to take deliberately, not to
   discover.

### 7.2 Kohya — the host that proves placement is not topology

**As shipped:**

| | |
|---|---|
| **Hooks** | `model.write` (`safetensors.torch.save_file` monkey-patch) |
| **Surfaces** | `in-process-callback` |
| **Fidelity** | `as-written` |
| **Placement** | declared `sidecar-gate`, enforcement **`none`** → effective **`unattested-client`** |
| **Attestation** | `none` |
| **Assurance** | P1 **fails** · P3 **fails** · **no leaf may be issued** · **cannot claim the standard** |

Kohya is server-side, on hardware the tenant does not own, and the model
classifies it exactly the same as browser JS. That is correct and it is the
sharpest thing the placement axis does. The tenant has root in the pod: they
can unload the patch, and `SCRUPLE_APPS_WITNESS_SECRET` is readable from inside
the container, so they can mint leaves with it. This reproduces the existing
grade (P1 FAIL, P3 FAIL, P4 FAIL derived from P3, P5 FAIL) from the axes alone
rather than from source reading.

`app/api/apps/kohya/witness/route.ts` returns `ok: true` on this path today.
WO-11's first half stops that; this table says why it has to.

**Re-placed (WO-11's second half):**

| | |
|---|---|
| **Hooks** | `model.write`, `artifact.produced` |
| **Surfaces** | `filesystem-watch` on the checkpoint volume + `network-gate` |
| **Placement** | declared `sidecar-gate`, enforcement `isolated-namespace` → effective `sidecar-gate` |
| **Assurance** | P1 conditional · P3 conditional · leaf `passthrough` |

The pod stops being where measurement happens. Note what re-placement does
*not* change: the surface stays a way of seeing bytes, and the hook stays
`model.write`. Only placement moved, and the whole grade moved with it.

### 7.3 A `server-library` vendor, Hugging-Face-shaped — no code, two configurations

**Managed inference path:**

| | |
|---|---|
| **Hooks** | `attach` at deploy, `graph.execute` or `artifact.produced` per request |
| **Surfaces** | `in-process-callback` — the vendor's handler calls `capture()` then `witness()` |
| **Fidelity** | `as-delivered` (the response body is the artifact) |
| **Placement** | declared `server-library`, enforcement `no-tenant-code` → effective `server-library` |
| **Attestation** | `verified` where the fleet has H100-CC or SEV-SNP and we chain to the vendor root; `passthrough` otherwise |
| **Assurance** | P1 **holds** · P3 **holds** · leaf `verified` (or `passthrough`) |

This is the same surface value as Kohya's monkey-patch and the opposite
assurance. Nothing about *how* the bytes are seen changed; the party who can
edit the code did.

**Custom-handler / bring-your-own-container path — the same vendor:**

| | |
|---|---|
| **Placement** | declared `server-library`, enforcement **`none`** → effective **`unattested-client`** |
| **Assurance** | P1 fails · P3 fails · **no leaf** |

`trust_remote_code`, a custom `handler.py`, or a customer-supplied image all
mean tenant code executes in the same process as the capture call. `P1 is free`
at `server-library` **only while the vendor's execution model keeps tenant code
out of the capture process**. A vendor is not a placement; a configuration is.

This is the single most commercially important line in the document, because
`server-library` is the shortest path to a vendor running real traffic and its
free P1 is exactly what a custom-handler feature silently revokes.

### 7.4 Autodesk Fusion 360 — `attested-client`, and the hardest to map

**As shipped:**

| | |
|---|---|
| **Hooks** | `attach` (add-in `run`), `detach` (`stop`), `document.open` (`documentActivated`), `document.save` (`documentSaved`), `idle.tick` (the 300 s dirty-poll custom event) |
| **Surfaces** | `host-api-callback` |
| **Fidelity** | **`induced`** — the add-in drives `design.exportManager` into a tempfile, streams SHA-256 over it, and `os.unlink`s it in a `finally` |
| **Placement** | declared `attested-client`, enforcement **`none`** → effective **`unattested-client`** |
| **Attestation** | `none` |
| **Assurance** | P1 **fails** · P3 **fails** · **no leaf may be issued** |

**What makes P1 fail, specifically:**

1. The add-in manifest carries `editEnabled: true` and installs by robocopying
   readable `.py` into `%APPDATA%\Autodesk\...\AddIns\ScrupleFusion`. Nothing
   is signed, notarised, or store-verified. The user can edit the measuring
   code with Notepad.
2. The API key is cached in plaintext at `%APPDATA%\ScrupleFusion.key` — P3
   fails independently of P1. (WO-12 moves this onto the component's custody
   model.)
3. Even with a signed installer, Fusion exposes a scripting console that can
   call the add-in's own functions with forged arguments. Code signing covers
   the installer, not the runtime, which is why `attested-client`'s conditions
   list that separately.

**Once earned** — `host-enforced-signature`, i.e. Fusion verifies the signature
at load and refuses unsigned code — the same profile resolves to
`attested-client`: P1 conditional, P3 conditional, leaf `passthrough`. Nothing
else in the profile changes. That is `attested-client` fully expressed now for
a host we have not met, which is the WO's requirement.

### 7.5 Blender — the same shape, further away

| | |
|---|---|
| **Hooks** | `attach` (`register()`), `detach` (`unregister()`), `document.save` (`save_post`), `artifact.produced` (`render_complete`/`render_write`) |
| **Surfaces** | `host-api-callback` (bpy handlers deliver the event) + `filesystem-watch`-shaped read of the reconstructed output path |
| **Fidelity** | `as-written` — Blender reads back the file the host already wrote. **Stronger evidence than Fusion's**, on this axis alone. |
| **Placement** | declared `attested-client`, enforcement **`none`** → effective **`unattested-client`** |
| **Attestation** | `none` |
| **Assurance** | P1 fails · P3 fails · **no leaf** |

**What makes P1 fail:** the extension ships as a plain `zip -qr` of readable
`.py` into the user's scripts directory. There is no signing step in the build,
no Extensions-catalog submission, and Blender does not verify extension
integrity at load in the first place. Blender may not be able to earn
`attested-client` at all without an upstream change; that is a fact about the
host, and the model should say so rather than grant the tier by category.

**Coverage gap, separately from placement:** Blender has no `export_post`
handler. glTF/FBX/OBJ/USD exports are witnessed only if the user invokes a
manual operator. The axes express this perfectly — those exports have no hook
and no surface — and that is precisely why it needs saying out loud: an
unexpressed egress path is not a defect in the model, it is a hole in the
integration, and only the probes find it.

**The MIME bug is here, and it is the §5 exemplar:** both call sites default
`content_type` to `application/octet-stream` and the capture path never sets
one, so the default always wins. Blender is the *only* one of the six whose
artifacts are natively watermarkable and C2PA-signable — renders are PNG/JPEG —
and octet-stream shuts both modalities off. The SDK's `capture()` already
raises `MimeRequiredError` rather than guessing; the adapter has not been moved
onto it.

### 7.6 Browser JS — the hostile case, refused

| | |
|---|---|
| **Hooks** | would claim `document.save`, `artifact.produced` |
| **Surfaces** | `in-process-callback` (page JS) |
| **Fidelity** | `as-delivered` — and irrelevant |
| **Placement** | `unattested-client`, and no enforcement can change it |
| **Attestation** | **`verified`**, deliberately, in the test |
| **Assurance** | P1 fails · P3 fails · **no leaf** · **cannot claim the standard** |

The test presents this host holding a genuine root-verified attestation, which
a page can obtain by relaying a quote from a server it does not run. The
function must still refuse. `test/v2/placement.test.ts` pins that case
specifically, because it is the one an implementer would be tempted to
"improve".

What the host *may* do: record events as declared. `witnessed` is `false`,
explicitly, per D-8.

### 7.7 Summary

| Host | Hooks | Surfaces | Fidelity | Declared → effective | Attestation | Leaf |
|---|---|---|---|---|---|---|
| ComfyUI | `graph.execute`, `artifact.produced` | `network-gate` + `filesystem-watch` | as-delivered | `sidecar-gate` → `sidecar-gate` | none | `passthrough` |
| Kohya (shipped) | `model.write` | `in-process-callback` | as-written | `sidecar-gate` → **`unattested-client`** | none | **none** |
| Kohya (re-placed) | `model.write`, `artifact.produced` | `filesystem-watch` + `network-gate` | as-written | `sidecar-gate` → `sidecar-gate` | none | `passthrough` |
| Vendor, managed | `graph.execute`, `artifact.produced` | `in-process-callback` | as-delivered | `server-library` → `server-library` | verified | `verified` |
| Vendor, custom handler | same | same | as-delivered | `server-library` → **`unattested-client`** | verified | **none** |
| Fusion (shipped) | `document.save`, `document.open`, `idle.tick` | `host-api-callback` | **induced** | `attested-client` → **`unattested-client`** | none | **none** |
| Fusion (signed) | same | same | **induced** — signing changes placement, not fidelity (`custody-study/fusion.md` §6.4) | `attested-client` → `attested-client` | none | `passthrough` |
| Blender | `document.save`, `artifact.produced` | `host-api-callback` + `filesystem-watch` | as-written | `attested-client` → **`unattested-client`** | none | **none** |
| Browser JS | — | `in-process-callback` | — | `unattested-client` | verified | **none** |

Four of the nine rows resolve to "no leaf may be issued". If that reads as a
harsh model, note that three of those four are things we have shipped or
proposed, and the fourth is the case we invented to be refused.

---

## 8. The abstraction defects

The WO's instruction was that a host which cannot be expressed is a defect in
the abstraction, and that a table where everything fits suspiciously well means
the hosts were bent. Three defects surfaced. Two are closed here; one is not.

### DEFECT-1 · `attested-client` was a category, not a claim — **CLOSED**

As three bare axes, a host assigns itself its own assurance tier by declaring
its placement. Fusion and Blender are the same shape — a plugin, in-process in
a host app, user attesting their own work — and the WO series lists Fusion as
`attested-client`. Neither can currently earn it: Fusion's manifest sets
`editEnabled: true` over readable Python, Blender's build is a plain zip.

The abstraction as given would have graded both at the plugin tier for being
plugins.

**Closed by** splitting the axis into a *declared* placement plus an
*enforcement mechanism*, with `resolvePlacement()` reducing the pair before the
assurance function sees it. Assurance stays a pure function of
`(placement, attestation)`; the earning happens strictly before. The same
mechanism catches the vendor custom-handler case in §7.3, which was not the
case it was designed for — a small sign it is the right shape.

### DEFECT-2 · No axis carries coverage completeness — **NOT CLOSED**

Nothing in hook × surface × placement can say *these surfaces jointly cover
every egress path of this host*. A ComfyUI profile naming only
`filesystem-watch` is perfectly expressible and perfectly wrong; the WS path
disappears and nothing in the model objects.

This is the one gap I am not closing, because I do not think it can be closed
by a type. Completeness is not a property of a declaration — it is a property
of a running system, and it is established by:

- **H-4 §7 probes 4 and 5** — write a file into the output volume and get no
  leaf; retrieve output over the non-file path and get no leaf. Those two
  probes are the two-surface finding turned into tests, and they are the ones
  that would have caught both Studio paths.
- **Ratchet gap accounting** (H-4 §4.2) — a counter arriving at `last + 4`
  means three events were produced and not delivered. Suppression becomes
  visible without a separate protocol.

**What the model must therefore not do:** report a configuration as compliant
on the strength of its declared profile. The profile is what to probe, not
evidence that probing would pass. This is recorded here so that WO-9's
self-grade harness does not quietly treat a well-formed profile as a P2 pass.

### DEFECT-3 · Surface conflated observing bytes with causing them — **CLOSED, with a consequence**

Fusion is the only one of the six that does not observe an artifact. It
*manufactures* one: `exportManager.createFusionArchiveExportOptions` → tempfile
→ stream SHA-256 → `os.unlink` in a `finally`. The `.f3d` that was hashed exists
for milliseconds and is then destroyed. The user keeps a cloud document, not
that file.

The four surface values have no term for this. `host-api-callback` describes
how the *event* arrived and says nothing about where the bytes came from, and
under the original model Fusion and Blender look identical on the surface axis
despite one hashing an artifact that survives and one hashing an artifact that
does not.

**Closed by** `ObservationFidelity` — `as-delivered` / `as-written` /
`induced` — as a required property of every observation. It is a modifier and
not a fifth surface value because it cross-cuts: a network gate is normally
`as-delivered`, a filesystem watch `as-written`, a host API callback any of the
three.

**The consequence is a real bug, and it is not mine to fix here.** A leaf at
`induced` fidelity with no retained artifact is evidence only Scruple can read.
Fusion's threat model is a third party disputing the user's claim *later* — and
that party cannot re-derive the hash unless Fusion's archive exporter is
byte-deterministic, which we have not established and should not assume. The
interfaces therefore require `inducedArtifactRef` when fidelity is `induced`.
Where the Fusion path gets fixed: WO-10-adjacent, alongside the plugin work,
either by retaining and addressing the exported `.f3d` or by moving the
observation to `as-written` over the user's actual saved file.

### 8.1 Two smaller notes, not defects

- **`document.save` and `artifact.produced` each hide two contracts.** Fusion
  *produces* bytes it asks the host to write; Blender *finds* bytes the host
  already wrote. Fidelity now distinguishes them, and no further axis is
  needed.
- **Streaming output.** A `server-library` vendor generating text has no file
  and no graph. `artifact.produced` covers it with the response body as the
  artifact. There is no `stream.complete` hook and none appears to be needed;
  noted in case a partial-output requirement emerges.

---

## 9. The plugins carry a different threat model

The abstraction must hold this without bending, and it does — but only because
assurance is placement-derived rather than host-derived.

| | Inference host | Desktop plugin |
|---|---|---|
| Adversary | the **tenant**, at the terminal, with root in their container | a **third party**, later, disputing the user's claim |
| What is proved | what a machine did | that a human did this work |
| The user is | the party being measured | the party being protected |
| Tampering means | editing a monkey-patch | hacking the host application, which tracks project work natively |

That asymmetry is the whole reason the "proof of no AI" market exists on the
plugin side. It is also why the placement axis is not a quality ranking:
`attested-client` sits below `server-library` on P1 and is nonetheless the
right placement for a claim `server-library` cannot make at all.

### 9.1 A correctness bug this reframes — recorded, not fixed here

`lib/c2pa/signAsset.ts:332` defaults `digital_source_type` to
`TRAINED_ALGORITHMIC_MEDIA`, with the same fallback server-side in
`services/c2pa-signer/sign.py`. Neither the Fusion nor the Blender path passes
an override, so both inherit it.

For a plugin whose entire purpose is attesting human work, that default asserts
**the opposite of what the plugin proves**. It is a correctness bug, not a
preference.

**Placement is what determines the correct default** — an `attested-client`
capture of a `document.save` defaults to a human-origin source type; a
`sidecar-gate` capture of `graph.execute` on an inference host defaults to
trained-algorithmic. That is why it was correct to wait for this axis before
fixing it.

**Where it gets fixed:** at `lib/c2pa/signAsset.ts:332`, when the plugin work
lands (WO-10 onward) and a placement is available at the call site. Not in
WO-5, which owns no C2PA file. Today's Fusion `.f3d` path never reaches the
signer anyway (`lib/v2/capabilities.ts` marks CAD MIMEs non-C2PA-signable), so
the bug is currently latent on that path and live on Blender's renders.

---

## 10. Deliberately left for later

- **No surface is implemented.** WO-7 builds ComfyUI's two; WO-6 builds
  `server-library`. This WO builds the contract they satisfy.
- **`packages/scruple-host-sdk/scruple_host_sdk/__init__.py` is untouched** —
  `surface.py` is importable but not re-exported. Wiring belongs with the
  orchestrator.
- **The TS and Python definitions are hand-kept in sync.** WO-1's leaf-field
  registry is the right generator for this; two emitters from one definition is
  its stated pattern and this is a second consumer for it.
- **`observe()` has no back-pressure story.** Fine for a gate and a watcher;
  revisit if a surface ever outruns the sink.
- **Fidelity is not yet on the leaf.** It should be a registry field (WO-1) so
  a receipt can say whether the reader can re-derive the hash. Not added here,
  because the leaf-field registry is another agent's file.
