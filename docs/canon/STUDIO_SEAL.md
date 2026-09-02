# Studio's canvas path — registered, bound, and deliberately not sealed

**Status:** Implemented. `lib/canvas/deployment.ts`, `lib/db/migrations/047_canvas_deployment.sql`, `test/v2/studio-sealed.test.ts`.
**Version:** 1.0.0 · 2026-08-31 · WO-25
**Closes:** `INTEGRATION_LIFECYCLE.md` §10 item 6 and its final correction · `STUDIO_IS_AN_EXEMPLAR.md`'s live violation (partially — see §4)
**Does not close:** `PRIORITIES.md`'s "one integration that actually grades compliant end to end". §5 says why, and §7 says what is left.
**Binds:** `CAPABILITY_CLASSES.md` (class), `CUSTODY_LOCUS.md` (locus), `CANVAS_BASELINE.md` (the tamper surface this boundary is a superset of)

---

## 1. What landed

`PRIORITIES.md` states the gap in one sentence: canvas has **no registered
deployment**, ingests through `lib/iterations/ingest.ts` rather than
`/v2/witness`, and so carries `seal_state = NULL`. Three of those four facts
have changed.

| Before | After |
|---|---|
| no deployment | `studio-canvas-shared-default`, registered by migration 047 |
| `seal_state = NULL` on every canvas leaf | the fold **as of the leaf's own instant**, and `deployment_id` beside it |
| the seal question was never asked on this path | `checkDeploymentSeal()` — **the same function** `/v2/witness` calls |
| no class, no locus | `inference-host`, `vendor-custody`, both declared on the profile |
| no pipeline manifest | four boundary classes, a superset of the 23-file tamper surface |
| canvas ingests through `lib/iterations/ingest.ts` | **unchanged.** §4 |

Migration 047 inserts a **name** and nothing else. Migration 046 draws that
line in its own words — *"nothing here is signed, because nothing here is a
claim"* — and every actual claim (`integrating`, `verifying`, `sealed`) is an
Ed25519-signed lifecycle event that a migration has no key to produce. Writing
one unsigned would be a claim nobody made, which is the whole reason that table
is signed rather than merely stored.

The fold over zero events is `integrating`. That is step 1, and step 1 is an
ordinary place to be.

---

## 2. The custody locus, argued rather than assumed

**Declared: `vendor-custody`. The claim it unlocks is withheld.**

### What store this is about

`CUSTODY_LOCUS.md` asks where files rest *between* witnessed events. For canvas
there are two candidate stores and they land in different loci, so naming which
one the declaration is about is the first half of the argument:

- **The workspace** — ComfyUI's `output/`, `temp/` and `input/` inside the
  Modal container. This is the store the continuity claim is about, because it
  is where a state could change between two witnessed events.
- **The delivered artifact at rest** — uploaded by `ingestIteration` to the
  *user's own* Drive / OneDrive / GitHub, with the local copy purged by the
  retention sweeper. That is `tenant-custody`, and it is deliberately **outside
  this declaration**: a bait-and-switch there is already defeated by the hash,
  which is `CUSTODY_LOCUS.md`'s own opening paragraph.

### Why `vendor-custody` and not `shared-custody`

`shared-custody` is *"vendor space, but tenant has direct reach — mounted
volume, shell, object-store credentials."* On the shared-default machine the
tenant has **none of the three**: the Modal container exposes no shell (which is
the property that lets canvas's P1 pass at all), the volume is not mounted into
scruple-web or into the browser, and the tenant holds no Modal credentials.
Their only reach into that store is ComfyUI's own HTTP API, and **every byte of
it is proxied through the gate**. That is `vendor-custody`'s definition, word
for word.

Declaring `shared-custody` would have bought a weaker, safer-sounding sentence
by **misdescribing the topology**. That is the same defect as choosing a
capability class to avoid a requirement, one axis over, and
`CAPABILITY_CLASSES.md`'s rule — *"the class is determined by what the vendor
installs and offers, not by which audit they would prefer"* — cuts in both
directions. A locus is a statement about where files rest. It is not a dial.

### And why the sentence it unlocks is refused anyway

`custodyAssuranceFor('vendor-custody', 'sidecar-gate')` permits **"this is the
complete history of the project"** — on a condition:

> no path the measured party can reach writes into the custody store without
> crossing the pipeline — **evidenced by probe 4 from an occupied tenant
> position, or by the class-checked absence of a filesystem egress path**

**Canvas has neither half.** Probe 4 is not satisfiable at all — canvas has no
`filesystem-watch` surface, `CANVAS_BASELINE.md` §3.1 — and the filesystem
egress path is not *absent*, it is **unobserved**: §7's C-9 records that
`comfy_api_nodes/` ships ~25 in-tree node packs that open sessions to external
services from inside the ComfyUI process, and those bytes leave through neither
leg of the gate.

So the condition is unmet, and a conditions array nobody evaluates is a caveat.
A caveat printed beside a permitted sentence is exactly how a true specific
claim launders a false general one — the defect `CustodyCorroborator` was
invented to stop. `lib/canvas/witness.ts`'s `canvasClaimsToday()` therefore
**withholds the sentence** rather than printing it with an asterisk, citing the
blocking finding by id, and it is a subtraction only: it can never permit
something the class did not.

What canvas may say today is `Scruple-witnessed inference`, and
`CANVAS_BASELINE.md` §7 already words the narrow version: *"every artifact
retrieved through the sanctioned path is witnessed"*, which is not the same
sentence as *"cannot produce a retrievable artifact with no leaf"*.

**The custody gap and the probe gap are the same gap on two axes.** Both are
recorded (`CSB-01`, `CSB-03`) so that neither can be closed by forgetting the
other.

---

## 3. The pipeline boundary — what is inside, and what is deliberately not

`lib/canvas/baseline.ts` already enumerates a 23-file **tamper surface**. The
pipeline manifest is not that list, and every difference is a decision.

### It is a superset, and the test asserts it

`boundaryOmissions(manifest, TRACKED)` is empty: every file the tamper surface
covers is inside the measured boundary. Nothing was dropped in the
re-partitioning, and if anyone drops one later, `test/v2/studio-sealed.test.ts`
fails.

### The four classes, and why each entry is in the one it is in

| Class | What canvas puts there |
|---|---|
| `capture` | the proxy route, all eight `lib/canvas/*` modules, the WS sidecar, `lib/iterations/ingest.ts`, the three preimage modules, the four **component** modules canvas consumes, and `lib/seal/registry.ts` |
| `config` | `lib/canvas/baseline.ts`, `lib/capture/surface.ts`, `lib/capture/classes.ts`, migrations 044/046/047, plus two `declared` entries: the witness endpoint and the upstream credential's **source** |
| `dependency` | `package.json`, `package-lock.json`, by content |
| `host` | `host:comfyui@modal-shared-default`, digested by `machines.manifest_hash` |

**`lib/seal/registry.ts` is the arguable one and it is argued.** It is not
observing code. It is the code that decides the `seal_state` written onto every
canvas leaf, and the class rule is *"changes what a leaf says"*. A change here
that let an unapproved pipeline stamp `sealed` is precisely the change a seal
exists to cover. It is inside, and its edits are material — including the ones
made by other work orders, which is a real cost accepted for a correct
boundary.

### Three things the manifest holds that the tamper surface cannot

1. **`lib/canvas/baseline.ts` itself.** The tamper surface excludes it,
   correctly: it carries its own recorded hash, so hashing it is a fixpoint
   rather than a measurement. That reason **does not transfer** — a pipeline
   manifest is stored on the seal row, not in the file — and baseline.ts is
   where canvas's placement, enforcement, surfaces and `attestation: none` are
   *declared*. A configuration that can be edited without moving the approved
   measurement is not an approved configuration.

2. **The host image.** The tamper surface excludes `modal/**` on the grounds
   that the image is *"measured separately and better"* by
   `machines.manifest_hash`. **Separately is the problem a pipeline measurement
   exists to end** — *"a new upstream release is a new measurement and a new
   approval"* — so the image is inside this boundary as the `host` class, as a
   `declared` digest. On canvas the concrete case is not hypothetical: a ComfyUI
   release that starts returning result bytes over the WebSocket is exactly the
   host upgrade that changes what the gate sees.

3. **The endpoint and the credential's source.** `measure.ts`'s `config` class
   names both and neither is a file. Kohya is this estate's standing proof that
   a configuration change turns capture off while looking exactly like a quiet
   afternoon.

   The credential entry digests **`env:SCRUPLE_CANVAS_SHARED_SECRET`, never the
   secret**. Two reasons, and the second is easy to get backwards: a manifest is
   stored in full on a signed row and read by auditors, so a digest of a secret
   is an offline oracle against it; and *rotating* a credential is not a change
   to the approved configuration, while *changing where the credential comes
   from* is the Kohya failure exactly.

### Partitioned, not flat — which is the point of doing this at all

The tamper surface is **one hash**, so a `package-lock.json` bump breaks it as
loudly as a rewrite of `lib/canvas/gate.ts`. That is the *"vendor stops
bothering"* failure `materiality.ts` was written to avoid. In the manifest:

- a lockfile bump is `consequential` — a signed `drift` event, counted against a
  budget of 8, no reseal;
- a change to the gate, the endpoint, or the host image is `material` — a
  mandatory reseal, and no claim until it happens.

Asserted in the test rather than described here.

### Deliberately outside

`components/canvas/**` and `app/canvas/**` (browser UI — placement is
`unattested-client` by definition, and baselining code whose modification we
already assume would imply a claim P1 explicitly refuses); `modal/**` *source*
(inside as the `host` digest instead — a second preimage for one thing is worse
than one); the OS, kernel, Node runtime, `node_modules` as installed, the
machine, model weights and tenant content (`measure.ts`'s explicit outside
list); `lib/seal/measure.ts`, `materiality.ts` and `cli.ts` — **the measuring
instrument, not the specimen**, and in materiality's case a change to the
*scheme*, which moves every deployment at once and is not one vendor's seal to
record.

And one exclusion that is a **finding rather than a scoping choice**:
`app/api/v2/witness/route.ts`. See §4.

---

## 4. Did binding canvas make it a consumer, or move the parallel implementation?

**Both, and the honest split matters.**

**Genuinely a consumer.** There is exactly one `checkDeploymentSeal()` in the
estate and canvas now calls it. The seal fold, the tenant check, the `unchecked`
posture, the as-of instant, the vocabulary (`undeclared` / `unregistered` /
`unchecked`) — all of it is the shared registry's, imported. A test asserts that
`canvasSealStamp()` *is* `checkDeploymentSeal()` and not merely resembles it: an
event appended through `lib/seal/registry.ts` moves the stamp on the next canvas
leaf. That is `STUDIO_IS_AN_EXEMPLAR.md`'s direction of dependency, satisfied
for this capability.

**Still parallel.** Canvas does not traverse `POST /api/v2/witness`. What was a
parallel implementation of *the seal stamp* is now shared; what remains parallel
is *the leaf write itself* — `ingestIteration` builds and inserts the row.

And the reason is not laziness, which is why the exclusion is recorded as a
finding: **canvas has no component, no ratchet and no MAC**, so there is no
envelope for that route to verify. Posting an unMACed submission over HTTP to
our own process would add a network hop and a second authentication story
without adding a single fact. The correct fix is the one
`STUDIO_IS_AN_EXEMPLAR.md` already scheduled — *"rebuild canvas as a thin
consumer of the component"* — which needs the component's framework-agnostic
request adapter and multi-upstream resolution first. Until then the gap is
narrower and nameable rather than closed, and `CSB-02` records what it costs.

---

## 5. The state canvas honestly reaches, and what blocks the next one

**`verifying`.** Not `sealed`.

`verifying` is honestly earned and is not a consolation: it is the state where
*"real leaves flow from here and are NOT claims to the standard"*, and canvas is
doing exactly that — real leaves, stamped, from an unsealed pipeline. Step 2 is
where the failures are supposed to happen.

**`sealed` is refused, and the refusal is in code.**
`INTEGRATION_LIFECYCLE.md` correction 4 is unambiguous: *"probes are a
PRECONDITION OF APPROVAL... a seal is not granted without an admissible run,
probe 7 with its negative control included."* `lib/canvas/deployment.ts` carries
`CANVAS_SEAL_BLOCKERS`, which a test asserts is non-empty — so the day someone
believes the gap is shut, they have to **delete an entry and say why**, not edit
a paragraph.

### CSB-01 — no admissible probe run exists from canvas's tenant position

Canvas's tenant is **a browser on the public internet holding a session
cookie**; the workload is a ComfyUI process in **a Modal container we have no
shell in**. Neither position is on this host.

The partial was considered and **rejected**, per probe:

- **P-01 (bypass the gate)** asks whether the tenant can reach the ComfyUI
  upstream without crossing it. The browser cannot, because it never learns
  `canvas_sessions.modal_url` — but that is provable only by *reading* the proxy,
  and this host **can** read that column out of the database. An `OsVantage`
  here therefore answers about a strictly more privileged position than the one
  under test. It would produce a pass that means nothing.
- **P-02 / P-03 (admin surface, sealed IK)** are questions about a capture
  component's provisioning surface and key material. Canvas has neither, so
  running them here measures the *absence of a component* and reports it as a
  boundary property.
- **P-05 (WS retrieval)** is the one probe with a genuinely reachable subject —
  and its subject is the sidecar on this host, not the tenant's socket through
  the Cloudflare tunnel to Modal.
- **P-07 (egress)** requires a negative control from the tenant position. The
  canvas "tenant" is a browser with full internet egress; the egress question
  that actually matters for canvas is C-9, **egress from inside the Modal
  container**, and that needs a shell in a container that does not offer one.

WO-14's namespace harness builds a tenant position out of network and mount
namespaces **on this machine**. It cannot build one on Modal's, and
`SimulatedVantage` stamps every result inadmissible by construction — which is
correct and is the reason a modelled run is not the partial either.

**Running `OsVantage` from here and attaching the result would be a borrowed
run**, which `CAPABILITY_CLASSES.md` already rules supplies nothing
(`ProbeRun.subject ≠ this path`), and it is the "paperwork checking paperwork"
failure WO-23 closed. Canvas is not sealed.

### CSB-02 — P-06 has no subject on this path

`inference-host` requires P-01…P-07 (P-04 exempt, contingently). P-06 is
counter/replay against the ratchet, and **canvas has no ratchet**. This is *not*
the liveness not-a-finding of correction 5 — a counter that cannot go silent
because there is no counter. It is a **required probe of the declared class with
no subject**, which aggregates as `unmeasured` and therefore as not passed.

Clearing it means canvas submits through a ratcheted component envelope (§4's
rebuild), or `inference-host` is shown to be the wrong class for a deployment
whose capture path is the vendor's own server code — **and the second is a
change argued at class scope, never a canvas exemption.**

### CSB-03 — the `vendor-custody` history condition is unmet

§2.

---

## 6. Operator steps

Nothing here is self-serve, and there is no HTTP write route: *"a deployment
that can move its own lifecycle state can grant itself the right to claim the
standard."* All of it needs the registry key locally.

```
# 1. The deployment already exists — migration 047 inserted the NAME.
#    `cli.ts register studio-canvas-shared-default` will correctly refuse
#    with `already_registered`.
node --import tsx lib/seal/cli.ts status studio-canvas-shared-default

# 2. Record the signed transition into end-to-end verification.
node --import tsx lib/seal/cli.ts verifying studio-canvas-shared-default \
  --reason "real leaves flowing from an unsealed pipeline; probes outstanding"

# 3. THE SEAL. Do not run this yet — CSB-01..03 stand. When they do not:
#    npx tsx -e "import('./lib/canvas/deployment').then(m=>console.log(
#      JSON.stringify(m.canvasPipelineManifestFromEnv(), null, 2)))" > canvas-pipeline.json
#    node --import tsx lib/seal/cli.ts seal studio-canvas-shared-default \
#      --manifest canvas-pipeline.json --notes "…"
```

`canvasPipelineManifestFromEnv()` **throws** when no shared-default machine
manifest is recorded, rather than emitting a placeholder host digest: approving
a configuration whose host nobody resolved is `declareManifest`'s
`missing_file` refusal wearing a nicer error.

---

## 7. What remains before Studio can be shown end to end to an outside reviewer

In order, and none of it is in this work order's files.

1. **An admissible probe run from canvas's real positions.** A conformance run
   from inside the Modal container (`OsVantage`, the container's own namespace)
   plus a browser-equivalent client outside it, with probe 7's negative control.
   This is the single blocking item and it needs a container that offers a
   shell, or a Modal image that ships the suite and runs it on boot.
2. **P-06's subject.** Either canvas gains a ratcheted component envelope — the
   `STUDIO_IS_AN_EXEMPLAR.md` rebuild, which needs the component's
   framework-agnostic request adapter and multi-upstream resolution — or the
   class question is settled at class scope.
3. **C-9, the container's own egress.** Closed at the boundary or observed.
   Until then the `complete-history` sentence stays withheld and canvas's honest
   claim is the narrower one.
4. **The witness redeploy and the CVM**, which `PRIORITIES.md` sequences ahead
   of this and which nothing here changes: production still runs the 2026-07-16
   build without H-1, so leaves are HMAC-sealed rather than signed by the TOE
   key, and the CVM's stop/start attestation is still unverified.
5. **Then seal, then rehearse.** In that order. The demo is the first thing that
   exercises capture, leaf, seal, signing and verification as one path rather
   than as separately-passing suites, and it must not be the thing that
   discovers item 4.

**What could be shown today, honestly:** a registered deployment whose leaves
carry a real, as-of-correct lifecycle state; a pipeline boundary that is
measurable, partitioned and reproducible from the manifest alone; a declared
class and locus; and a seal that has **not** been granted, with three named
findings saying why. That is a working lifecycle with an unfinished
integration in it — which is a better thing to show an auditor than a seal
nobody probed.

---

## 8. Update 2026-09-02 — the manifest exists; two things stand between it and a seal

**§5 says canvas honestly reaches `verifying`. The fold says `integrating`.**

`npx tsx lib/seal/cli.ts status studio-canvas-shared-default` returns
`state: "integrating"`, `events: 0`, `claims_standard: false`. Migration 047
registered the deployment and deliberately inserted no lifecycle event, because
a migration has no key and *"an UNSIGNED row in `deployment_lifecycle_events`
would be a claim nobody made"*. Nothing has recorded one since.

So `verifying` is **earned and unrecorded**. The distinction matters: §5 is a
statement about what canvas does, and the fold is a statement about what anyone
can check. A reader of this document and a reader of the database currently get
different answers, and the database is the one that is right — a state nobody
signed is not a state the deployment is in.

### The pipeline manifest is now built, and this is what it measures

`docs/canon/studio-canvas-manifest.json` — **28 entries**, profile
`scruple/pipeline-manifest/v1`:

| class | source | n | what |
|---|---|---|---|
| `capture` | `content` | 24 | every file on canvas's capture path — `TRACKED` from `lib/canvas/baseline.ts`, **imported rather than re-listed**, because two lists of the same set drift |
| `host` | `declared` | 1 | `host:comfyui@v0.18.5`, the container's own commit |
| `dependency` | `declared` | 3 | the custom-node packs, by commit and contents hash |

    pipeline measurement   sha256:cb9a59802b0fded50e3062d36cb32fd24e20da2d2bb3a3f204e97062b5de8081

The four `declared` entries are `declared` on purpose — *"a declared digest is
an ASSERTION, and a manifest that did not say which of its entries were
asserted would be presenting the vendor's word as our measurement."* We did not
read the container; the container measured itself.

**Those four entries were unobtainable until 2026-09-02.** The in-container
manifest never reached a leaf — the import raised on every run and a `try/except`
ate it (WO-31). Half of this boundary was literally unmeasurable, which is worth
recording as the reason this manifest could not have been written before.

### What stands between the manifest and a seal — TWO blockers, not one

1. **CSB-01, and it is a designed refusal rather than an omission.** No
   admissible probe run exists from canvas's tenant position: the tenant is a
   browser on the public internet, the workload is a ComfyUI process in a Modal
   container we have no shell in, and neither position is occupiable from this
   host. `CANVAS_SEAL_BLOCKERS` is asserted non-empty by a test, so closing it
   requires **deleting an entry and saying why**. Building a manifest does not
   touch this and must not be read as progress against it.

2. **`SCRUPLE_BUILD_REGISTRY_KEY_HEX` does not exist**, and minting it is not a
   chore. Every lifecycle event and every seal is Ed25519-signed by that key
   (`registrySigner()`), so it is the **root identity of the registry** — the
   thing whose signature means "Scruple attested this". Generating it
   incidentally, in order to move a status field, would be creating the
   estate's attestation identity as a side effect of tidying. It is a founder
   act, and `INTEGRATION_LIFECYCLE.md` §10 item 5's *"sealing is not a
   self-serve act"* is the same sentence one level down.

**The founder step, once the key exists**, is two commands — and the first is
the one that makes the document and the database agree:

```bash
node --import tsx lib/builds/cli.ts keygen        # → SCRUPLE_BUILD_REGISTRY_KEY_HEX
node --import tsx lib/seal/cli.ts verifying studio-canvas-shared-default \
  --reason "real leaves flow from here and are not claims to the standard"
```

`seal` is NOT in that list, and will not be until CSB-01 clears.
