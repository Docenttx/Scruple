# Conformance — the seven probes, the self-grade, and the submission

_2026-08-30. WO-9, extended by WO-14, **P2 re-cut by WO-23**. Implementation:
`packages/scruple-conformance/`, `services/scruple-capture/probes/`,
`scripts/probe-harness/`, `test/v2/conformance.test.ts`._

## Bottom line

A conformance suite that cannot reproduce a known failure is not evidence of
anything. This one reproduces `STUDIO_P1-P8_GRADE.md` cell for cell against a
named commit, **including both FAILs**, from source rather than from a table of
booleans.

Three things came out of building it that are worth more than the code:

1. **Four of the seven probes cannot be strengthened by writing more code.**
   Probes 1, 2, 3 and 7 ask "can the tenant reach X?", which is a fact about
   network and mount topology. A process inside the same namespace as the
   tenant cannot answer it by observation, and a process outside it is
   answering about the wrong position. They can only be strengthened by moving
   where they run. This is `oss-study/sonobuoy-conformance.md` §5.2 — "P1 and
   P3 are the irreducible cases" — arrived at from the other end.
   **WO-14 moved where they run.** See §1.1.
2. ~~**§10 C-8's three directories are satisfiable today only by accident.**~~
   **Closed by WO-14.** `CaptureConfig.watchedVolumes` declares the three roots
   with their types, one watcher per root, and the type reaches the leaf. See
   §1.2.
3. ~~**P2 cannot be satisfied by a declaration, and one hole remains that it
   can.**~~ **Re-cut by WO-23.** P2 was implemented as a runtime completeness
   proof and that was measuring the wrong thing: it made canvas look
   unfixable and it made §10 C-7's route enumeration a rotting denylist. P2 is
   now **seal currency** — is the running pipeline sealed against an approved
   measurement of the *whole pipeline*, and is that seal current. See §3.

WO-14 added a fourth, and it is the one worth reading twice:

4. **Every probe that had never run from the tenant position was wrong about
   something, and the first clean run was the least trustworthy artifact in the
   exercise.** Four defects came out of the first genuine run — probe 6 never
   reaching a ratchet, a probe run of one deployment satisfying another's P2, a
   derived P7 reason stating a fact it had not checked, and probe 6's downward
   counter case degenerating on a young component. None was visible from
   reading the code. Three were visible only because a **green** run got read
   line by line instead of being taken at its summary.

---

## 1. A probe is an attack

H-4 §7 says it in one line: *"Run from inside the tenant container, where the
adversary sits; each must fail."* Two consequences the code takes literally.

**Two results, running in opposite directions.** `outcome` is what happened to
the attack (`blocked` | `succeeded` | `not-attempted`); `verdict` is what that
means for the deployment (`pass` | `fail` | `inconclusive`). Blocked → pass.
Succeeded → fail. They are never one field, because conflating them is how a
suite reports a successful exfiltration as a green tick.

**Inconclusive is not a pass, anywhere.** Sonobuoy requires
`--mode=certified-conformance` precisely because "a valid certification run may
not skip any conformance tests". A probe that could not be attempted, or one
attempted from a vantage that only *models* the tenant's position, is recorded
as inconclusive and counts as not-passed everywhere it aggregates. There is no
configuration in which a skip becomes a pass.

### The seven

| id | H-4 ref | attack | kind |
|---|---|---|---|
| P-01 | §7.1, §2 obl. 1 | reach ComfyUI directly, bypassing the component | topological |
| P-02 | §7.2, §4.4, C-5 | reach the provisioning or admin surface | topological |
| P-03 | §7.3, §4.4 step 4 | read the sealed IK | topological |
| P-04 | §7.4, C-8 | write into `output/`, `temp/`, `input/` and get no leaf | behavioural |
| P-05 | §7.5, §2 path 2 | retrieve over WS and get no leaf | behavioural |
| P-06 | §7.6, C-2/C-3/C-6 | submit a leaf at or below the last counter | behavioural |
| P-07 | C-9 → §7.7, new obl. 4 | open an outbound connection to an external host | topological |

### Where they run, and why `--simulate` is not evidence

`OsVantage` **occupies** the tenant's position — real sockets, real filesystem.
Run it inside the workload container and its answers are facts about that
deployment:

```
docker exec -it  <workload-container>  npx scruple-conformance run --config …
kubectl exec -it <workload-pod>     -- npx scruple-conformance run --config …
./scripts/probe-harness/run.sh                 # namespaces, when there is no Docker (§1.1)
```

`SimulatedVantage` **models** the position from a policy, for tests and dry
runs. Every topological result from it is stamped inadmissible by the runner,
not by the probe — one place to enforce it rather than seven places to forget.

The upstream address, the state directory and the egress target are **given by
the operator, never discovered**. A probe that had to find the upstream would
be testing our port scanner, and a deployment that survived a failed scan would
pass on our incompetence rather than on its topology. A conformant deployment
is one where *knowing* the address does not help.

---

## 1.1 Occupying the tenant position without Docker

There is no Docker on this host. `scripts/probe-harness/` builds the tenant
position out of `unshare(2)` instead:

```
unshare --user --map-root-user --net --mount --fork   # the deployment
  └── unshare --net --mount --pid --fork              # the tenant
      joined by two veth pairs; no default route, no resolver
```

`run.sh` runs the seven; `run.sh --audit` runs them nine times, once per
deliberately broken topology. Results land under
`$TMPDIR/scruple-probe-harness/<stamp>/<profile>/` — `probes.json` (results plus
the namespace inodes the run occupied), `probes.log` (the Sonobuoy-shaped human
half), `deployment.json`, `gaps.json`. Set `HARNESS_OUT` to put them somewhere a
submission bundle can pick them up; **not** under `artifacts/`, which is the
app's content-addressed store.

**What this genuinely answers, and it is most of the point of WO-14:**

| probe | answered? | by what |
|---|---|---|
| P-01 | **yes** | the upstream binds the deployment namespace's loopback; the tenant's loopback is a different loopback, and the deployment's routable address does not carry that port |
| P-02 | **yes** | the gate's listener and the provisioning endpoint are both reached over a real socket from the tenant's namespace |
| P-03 | **partly** — see below | the state directory is absent from the tenant's mount namespace, and absent from `/proc/<pid>/root` because the tenant has its own PID namespace |
| P-04, P-05, P-06 | **yes** (they always could be) | behavioural; the deployment is real either way |
| P-07 | **yes** | the tenant's routing table has no default route, and the negative control sits on a *second* veth subnet so a reachable control proves routing works somewhere other than the one link the tenant obviously has |

**What it does not answer, stated so that nobody reads a namespace as a
container.**

- **It is not a container.** No image, no cgroup, no seccomp or LSM profile.
  A conformance claim about a vendor's *container* runtime is not what this
  produces; it is a claim about network and mount topology, which is the part
  probes 1, 2, 3 and 7 actually ask about.
- **P-03 is answered for one of §4.4 step 4's two postures and not the other.**
  A user namespace maps the invoking uid to root, so a 0600 file owned by that
  uid is readable inside it by construction. This harness therefore answers
  *"the state directory is not in the tenant's mount namespace"* — and cannot
  answer *"the state directory is shared, 0600, owned by a principal the tenant
  is not"*. That second posture needs two real uids, which needs a real
  container runtime or a second unprivileged account. **The two are different
  configurations and certification is per configuration (§7)**, so the run
  records which one it occupied rather than generalising.
- **The tenant runs as the same uid that owns the component's files on disk.**
  Everything the mount namespace hides is hidden by the mount namespace alone.
- **A shared PID namespace defeats the mount boundary outright, and the audit
  proves it.** `/proc/<pid>/root` resolves in the *component's* mount namespace.
  Under the `p3-shared-pid` profile the tenant reads `identity.json` — chain key
  included — through `/proc`, with the tenant's own view of that path still
  empty. P-03 now attempts that route when the operator declares
  `componentPid`, because a boundary nobody tested is not a boundary anybody
  demonstrated.

**Recording the position, mechanically.** §10 C-11 asks a run to record which
position it occupied. `probes.json` carries the namespace *inodes* of both
sides (`/proc/self/ns/*`), read on the tenant side and on the deployment side,
plus `network_namespace_differs` / `mount_namespace_differs`. Two inode numbers
a reader can compare is a fact; "we ran it in a container, honest" is not.

**What the remaining inconclusives would need.** Nothing in the WO-14 run is
inconclusive. The two configurations this harness cannot reach need:

- the **shared-mount 0600** posture — a second uid, i.e. a container runtime
  (Docker/Podman/containerd) or a dedicated unprivileged account;
- **canvas's** tenant position — a browser against scruple-web plus a Modal-
  hosted ComfyUI. No namespace on this host can construct it, because the
  workload is not on this host. See "Canvas's P2, on evidence" below.

## 1.2 §10 C-8, in configuration rather than by accident

`CaptureConfig.watchedVolumes` is a list of `{ type, path }`; `output`, `temp`
and `input` are declared separately, each gets its own watcher, and nested roots
are **refused** (`resolveWatchedVolumes`) because a write under two roots has
two volume types and the question C-8 exists to answer stops having one answer.
`loadConfig` fails closed on a partial declaration: set one of
`SCRUPLE_CAPTURE_VOLUME_{OUTPUT,TEMP,INPUT}` and all three are required.

**The type reaches the leaf through `capture.egress`**, as
`file:<type>:<path within that root>` — the same `<scheme>:<qualifier>:<value>`
shape `ws-gate.ts` already uses (`ws:binary:4`). It goes there and not into a
new field because every member of `capture` is inside the MAC preimage
(`leaf.ts#preimageOf`), computed identically by the component and the ingest;
adding a member is a preimage change that invalidates every provisioned
component in the field. So the volume type is **authenticated, not annotated**,
and it cost no migration.

The pre-C-8 singular `outputVolume` is still accepted, because two callers this
change does not own construct a config with it, and it produces one root of type
`unspecified`. `topologyAdvisory` says so at startup and P-04 reports it as an
**unrecorded** type rather than a wrong one — an absent declaration and a false
one are different findings, which is the distinction `mime.ts` already refuses
to blur.

---

## 2. What each probe cannot prove

**P-01.** A `blocked` says this vantage has no route. It does not say no route
exists — a second interface, a DNS name resolving elsewhere, a host-network
sibling. H-4 §6 is explicit that topology probes plus reconciliation make P1
*checkable* and that neither makes it *provable*. The evidence record carries
that sentence so a reader is not left to supply it.

**P-02.** The provisioning endpoint is on the public internet by design, so
reachability is not the question; what must fail is the *request*. §10 C-5: the
one-time token cannot say which tenant is calling, so an API key carrying
`component:provision` is required in addition, and a tenant credential must not
carry it.

**P-03.** The mode is recorded as context, never as the answer. A 0600 file in
a namespace the tenant shares as the same uid is 0600 *and* readable. The read
decides.

**P-04.** Covers all three of C-8's directories with distinct bytes per
directory — one blob would let a single leaf answer for three writes. Three
outcomes, not two: **witnessed** (a `filesystem-watch` leaf covers those exact
bytes), **unwitnessed** (attack succeeded), and **surface absent** (there is no
filesystem surface here at all — canvas, because the Modal volume is not
mountable into scruple-web). The third is `not-attempted`: nothing was gated
and nothing could leak. Scoring the absence of a surface as a pass would be
scoring a gap as a success.

**P-05.** Requires a leaf from a **non-filesystem** surface. A leaf is keyed by
content hash, so two artifacts with identical bytes share one — and a leaf the
watcher produced for a *file* does not witness a WebSocket delivery of the same
bytes, which never became a file. Accepting it would report a gated WS path
where there is none. (Found the hard way: the stub emits the same 1×1 PNG down
both paths, and the first version of this probe passed on a collision.)

**P-06.** §7 probe 6 was written when §4.2 required strict increase. **C-3
replaced that with a bounded acceptance window**, so "submit at or below the
last counter" would now fail a conformant server for doing the right thing — an
unseen counter below the high-water mark is the queue draining, and refusing it
destroys the evidence the queue exists to preserve. What survives is replay
defence: three forged submissions (inside the window, far below, far above),
all of which must be refused. A tenant without the chain key cannot produce a
valid MAC at all, so this probe measures **the server**, not the tenant.

**P-07.** Two channels, because a policy that blocks TCP and leaves the
resolver open still leaks a hash per query. And it **requires a negative
control**: an endpoint outside the workload's policy that this position is
expected to reach. Without one, "nothing got out" cannot be told apart from an
air-gapped runner, and the probe returns inconclusive rather than a pass it did
not earn. NXDOMAIN counts as an open channel — the query left and something
answered.

---

## 3. The self-grade

Two sources of truth, and the split is the design.

**Derived** — P1 and P3 come from `assuranceForHost()` in
`lib/capture/surface.ts`, which is already a total function of (placement,
enforcement, attestation). The harness does not re-decide it.

**Declared and checked** — everything the placement axes cannot see: whether a
baseline covers the capture path, where the credential physically lives,
whether a leaf is created at all, whether prior rows are mutated. Every one
carries a `cite`, because a grade whose inputs are unsourced booleans is a
survey.

### P2 is seal currency (WO-23)

`docs/canon/INTEGRATION_LIFECYCLE.md` is the founder direction and it corrects
what P2 was measuring:

> **Define the boundary, measure the whole thing, and make any change to it
> require re-approval.**

The approved artefact is **the entire pipeline**, not the capture files. The
routes that exist are the routes in the measured image; a new upstream release
is a new measurement and a new approval. **Nobody enumerates routes, so nothing
rots.**

**P2 now asks:** is the running pipeline sealed against an approved
measurement, and is the seal current? Concretely, in `p2SealedPipeline`:

0. **the attached probe run is of THIS deployment** — WO-14's finding,
   unchanged and checked first (below);
1. **a seal state exists at all** — the registry's `undeclared` is a FAIL and
   an ordinary place to be. Every integration starts there;
2. **the deployment is registered** — `unregistered` is a claim about somebody
   else's seal, and is not the same fact as (1);
3. **the fold says `sealed`** — `lib/seal/registry.ts#sealStatus().claims_standard`.
   `integrating`, `verifying` and `resealing` **cannot claim the standard**;
4. **the seal row agrees with itself** — the recorded measurement is
   recomputed from the stored manifest, never trusted;
5. **the pipeline running now is the approved one** — see below; and
6. **the declared capture path lies inside the measured boundary.**

**Three roles, separated, each previously doing part of another's job:**

| mechanism | proves | where |
|---|---|---|
| pipeline measurement | this is the approved configuration | **P2** |
| attestation | the running thing *is* that measurement | **P7/P8** — `verified` vs `passthrough` |
| counter (ratchet) | this deployment has not gone dark or been suppressed | **liveness**, not a P-item |

No new tier was required and none was introduced.

### The counter is liveness, and it reaches compliance nowhere

The old third conjunct — ratchet gap accounting — is still computed and is
reported on every grade as `PathGrade.liveness`: `live`, `gaps-accounted`,
`unaccounted`, or `not-applicable`. It does not enter `compliant`.

That single change is what unstuck canvas. The old rule said canvas could not
satisfy P2 **"at any level of effort"** because it has no ratchet. That
sentence was a fact about the grader, not about canvas — and the harness now
distinguishes *"there is a counter chain and nobody accounted for its gaps"*
(a real operational finding) from *"there is no counter chain here"* (nothing
to be silent with), which the old model could not express and therefore
reported as the same failure.

### Containment, not enumeration — and the asymmetry is the whole point

The capture-path file list is still an input, and it is now checked **only for
containment inside the measured boundary**. A declared capture file outside the
measurement is a finding, because the seal does not cover it. **The converse is
deliberately not checked**: a route inside the boundary that nobody declared is
covered anyway, the way a measured image covers a route nobody wrote down.

Make that a two-way check and the declaration is a denylist again, which is
exactly the shape §10 C-7 rots into.

### The check the fold cannot make

`sealStatus()` is a fold over lifecycle events the vendor **declared** —
material changes they told us about, drift they recorded. It is a correct
answer to *"what has this deployment said about itself"*.

P2 asks a different question, and the gap between them is the change nobody
declared. So the grader takes an **observed** manifest measured at grade time
and classifies it against the approved one with the estate's own materiality
rule (`lib/seal/materiality.ts`, consumed rather than restated — a second copy
of a materiality rule is a second rule). A seal state that can only be moved by
the sealed party's own honesty checks paperwork.

When nothing measured the running pipeline at grade time, P2 is a **conditional
pass** that says so, rather than a pass that does not mention it.

### WO-14's borrowed run survives the re-cut, and is checked first

The harness once produced a real, admissible, seven-of-seven run from an
occupied tenant position — against the **`scruple-capture` ComfyUI
deployment** — and attaching it to **canvas's** grade carried canvas past P2.
Every fact in that run was true. The conclusion was false.

That finding was never about which conjunct the run fed. A run is evidence
about the deployment it occupied and about no other (§7: certification is per
configuration), and **a deployment cannot reach a seal on somebody else's
step-2 evidence.** So `ProbeRun.subject` still names the subject, and a
borrowed run still fails P2 — now checked *before* anything else, because
nothing computed downstream of inadmissible evidence is worth reporting.

### DEFECT-2 is still open and is no longer P2's problem

WO-5's DEFECT-2 — nothing in the hook/surface/placement model can say that a
set of surfaces *covers* every egress path of a host — has not closed. A
profile naming only `filesystem-watch` is still a well-formed sentence about
coverage that carries no coverage claim.

Under the old rule that defect had to be carried by P2, which is why P2 grew
three conjuncts and a named hole (`surfaceAbsences`: a coverage probe coming
back `not-attempted` was accepted on a cited declaration the model could not
check). Under the new rule **coverage is not established by enumerating
surfaces at all** — it is established by measuring the whole boundary the
surfaces live in. The declaration hole is gone from P2 with it.

`surfaceAbsences` remains in the evidence type, still read by the frozen
profile and still reported by probe 4 as its third outcome. It is no longer
load-bearing for anyone's compliance.

### The grade is scoped to a capability class (WO-24)

`docs/canon/CAPABILITY_CLASSES.md`. `CANON_HOST_PROFILES` describes specific
integrations — a Security Target. The layer above is the **class**, a Protection
Profile with the requirements every member must meet, and a profile is now
graded **against its class** rather than against the union of everything.

`gradePath` computes `classScope` **before any item is graded**, because a grade
against the wrong class is a grade of nothing:

```
classScope: {
  declared, audited, ambiguityResolved,
  hooks[], surfaces[], probes[],   // required | permitted | not-applicable
  pItems, custody, permittedClaims, forbiddenClaims,
  findings[], unmeasured[], inScope
}
```

**Four outcomes, and the fourth is the one the grader used to spell as one of
the others**: `not-applicable` (declared by the class, checked against the
profile), `satisfied`, `failed`, and `unmeasured` — applicable and nobody looked.
`unmeasured` aggregates as NOT PASSED everywhere, which is WO-14's rule moved up
a level. A borrowed run (`subject ≠ this path`) supplies **nothing**, so its
verdicts cannot satisfy class scope either — P2 already refuses such a run, and
letting scope accept it would have meant only one cell noticed.

**`compliant` is conjoined with `inScope`.** A blocking class finding means the
deployment is not a member of the class it asked to be graded as, or does not
meet that class's floor, and you cannot be compliant with a standard you were
measured against the wrong part of. A vendor who could pick the profile that
grades easiest and still claim the name is the gradations-of-certification
problem the trademark terms exist to forbid.

**The class is inside the signed submission** (`capability_classes` in the bundle
manifest), because the anti-gaming rule needs the choice to be a matter of record
before it can be disputed.

### DEFECT-2, narrowed a third time — and one place it genuinely closes

The class turns "this surface is absent" from an unchecked declaration in
`surfaceAbsences` into a declaration **checked against the profile's own surface
list**. Probe 4 is not applicable to an inference host that declares no
`filesystem-watch`, and it is applicable the instant one is declared.

**The residue is real and is reproduced as a test.** `profile.surfaces` is still
a declaration; two profiles differing only in whether they admit to a filesystem
surface get two different probe-4 scopes. What changed is the **cost** of the
lie, not its availability — the same list now decides the class floor, the class
identity and the permitted claim wording, so shading it can put a vendor below
their floor or trigger a finding against a class they did not declare. A
declaration load-bearing in four places is harder to shade than one load-bearing
in a footnote. `residualDefect2()` says exactly this in the code, so it cannot be
claimed closed by someone reading only the tests.

**And there is one place it closes outright.** A not-applicable probe for which
the attached run reports `pass` or `fail` — as opposed to `inconclusive`, which
is what a genuine absence produces — **voids the exemption and raises `CF-04`**.
The probe got an answer, so the surface the declaration denies is there. An
observation beats a declaration; nothing a vendor writes down can prove what a
vendor did not write down, and only a run from the tenant position can.

### What changed for canvas and for the plugins

**Canvas — `inference-host`, `vendor-custody`.** Probe 4 is now **out of scope**
rather than a failure: the class declares it not applicable to a member with no
filesystem surface, and canvas declares none. For three WOs that read as a canvas
failure. Six probes are in scope and all six are `unmeasured`, because no run is
attached — which is the honest reading and is not a pass. Canvas is the one
configuration in the estate entitled to *"this is the complete history of the
project"*, and the conditions say what that rests on.

**Kohya — `training-host`, `shared-custody`.** Probe 5 **leaves** its scope: a
checkpoint is a file, fetched as one or not at all. And a finding **arrives** that
the P-item table never carried — `training-host` requires a `filesystem-watch`
position *because* there is no fail-closed point, and Kohya as shipped has only
an in-process patch on `safetensors.save_file`, which covers the saves that go
through the function it patched and no others. That is a **coverage** finding,
independent of the placement failure that already sinks P1 and P3, and it holds
with perfect enforcement. It is exactly the re-placement WO-11 describes;
`kohya_target` meets the floor.

**The plugins — `authoring-application`, `tenant-custody`.** Probes 1, 2, 5 and 7
are out of scope: there is no gate to bypass, no vendor-side admin surface, no
retrieval channel, and no vendor network policy — a probe reporting open egress on
an artist's laptop is reporting that a laptop is a laptop. Only P-03 and P-06 are
required. Both Fusion rows carry a finding that `artifact.produced` is not
declared: Fusion witnesses the *document*, not the *artifact*, which is the same
fact DEFECT-3 records from the other end.

**No published cell moved.** The acceptance test grades the same pinned evidence
with class scoping live and asserts the divergence list is still exactly WO-23's
two P2 qualifiers, and that no item became `n/a` by class scope.

### Kohya's `surfaceAbsences` was canvas's, copied

Found while wiring this: `deriveKohya` declared *"no filesystem surface — the
Modal volume is not mountable into scruple-web"*, citing `lib/canvas/witness.ts`,
on a grade of a RunPod pod. Kohya has a filesystem; what it lacks is a watcher on
it. The frozen profile never reached that field for Kohya — P2 fails earlier, on
the missing baseline — so no published cell was affected. It was a false
statement waiting for the first rule that read it, and the class's required
surface is the honest version of the same fact.

### The old rule is kept executable, deliberately

`STUDIO_P1-P8_GRADE.md` was issued under the old rule, and a suite that cannot
re-derive a published failure is not evidence of anything. So the old rule is
not deleted: it is `RUNTIME_COMPLETENESS_PROFILE`, frozen, and it still grades
exactly as it did — including the `surfaceAbsences` hole, which stays named
rather than quietly repaired inside a frozen rule.

**A grade therefore names its profile**, beside its source ref, in `GRADE.md`
and in the submission manifest (`grade_profile`). A grade of a moving tree is a
grade of nothing; a grade under an unnamed rule is an opinion about a moving
standard.

The acceptance test does both halves:

1. the published grade is reproduced **cell for cell under the frozen rule**,
   including both FAILs and the reasons the document gives; and
2. the **same pinned evidence** is graded under the rule in force and compared
   to the **same published table**. Every disposition is unchanged. The only
   rendered difference is that both P2 cells gain a qualifier — `**FAIL**` →
   `**FAIL** (never sealed)` — because the old rule had one way to fail P2 and
   the new rule has several, and the test asserts that list of divergences
   exactly rather than tolerating it.

That second test is the one that matters. A re-cut that quietly turned a
published FAIL into a PASS would otherwise be indistinguishable, from inside
the suite, from a re-cut that fixed something.

### Canvas's P2, re-graded — the problem was never architectural

**Canvas at HEAD: `P1` conditional pass, `P2` FAIL (never sealed), `P3`–`P6`
pass, `P7` FAIL, `P8` n/a. Lifecycle `integrating`. Liveness
`not-applicable`.**

The published grade said canvas's P2 could not be satisfied **at any level of
effort** because it has no ratchet. That is withdrawn. Under the rule in force,
graded with the same derivation and a measured, approved pipeline supplied,
**canvas grades compliant** — P2 a conditional pass, P7 closing with
`provider: none` declared in the approved configuration. Nothing architectural
stands in the way.

What actually remains for canvas, in order:

1. **It carries no deployment.** Migration 046 says so in as many words:
   canvas and the plugins carry no component and no deployment. Register one
   and bind the path to it. Until then the honest grade is `undeclared`.
2. **Step 2 still needs canvas's tenant position** — a browser against
   scruple-web plus a Modal-hosted ComfyUI. No namespace on this host is that
   position. This has not become easier; what changed is that it is now a
   precondition of *sealing* rather than a standing P2 conjunct with no path
   to satisfaction.
3. **Measure the pipeline and approve it.** `lib/canvas/baseline.ts#TRACKED`
   already names 22 files, which is the `capture`/`config` half of a boundary;
   the missing entry is the **host** — the Modal machine's ComfyUI, as a
   declared identity and version. Canvas already has the hash for it
   (`manifest_hash`), which is also where P1's third declared condition — the
   `user_id IS NULL` fallback — stops being a footnote and becomes a boundary
   question.
4. **Declare the attestation provider in the approved configuration.** `none`
   is the correct value; P7 fails today only because there is nowhere durable
   that says it.
5. **P1 stays conditional**, on the three declared conditions the published
   grade names plus the four §7 probe conditions `assuranceFor` attaches to
   every `sidecar-gate`. WO-23 changed none of them.

**Liveness for canvas is `not-applicable`, permanently and honestly.** There is
no counter chain on the path, so there is nothing to be silent with. That is
not a coverage failure, and reading it as one is what made a componentless path
look permanently non-compliant.

### Anchors match code, not prose

Written by a bug. The first cut anchored Kohya's P3 on
`/SCRUPLE_APPS_WITNESS_SECRET/` and matched on
`/SCRUPLE_WITNESS_SECRET:\s*witnessSecret/`. A concurrent WO replaced the
global secret with a per-session token — and the old identifier survived **in a
comment explaining what had been removed**. The anchor still matched, the
pattern did not, and the grader reported P3 as *improved*.

It had not improved. A per-session token narrows blast radius from all-users to
one-user and does not move the credential out of a shell the witnessed party
controls. P3 is about custody, not scope.

Two rules, both enforced in `studio.ts`:

1. **Strip comments before matching.** A grader that reads documentation as
   evidence can be defeated by deleting a line and explaining why.
2. **Anchor on the property, not the identifier.** "a credential-shaped value
   is injected into the pod environment" survives a rename;
   "`SCRUPLE_WITNESS_SECRET` appears" does not.

And every anchor **throws** when its anchor is missing. A derivation that
silently returns the benign value is how a harness grades a broken integration
clean.

### The capture-path file list is an input, not a constant

It moves. The canvas retrofit replaced `scripts/canvas-ws-proxy.mjs` with
`lib/canvas/ws-capture.ts` and pulled the shared secret into
`lib/canvas/gate.ts`. Re-declaring the list when the code moves is exactly what
P2 asks an integrator to do; a derivation pinned to a stale list throws.

---

## 4. The submission

`cncf/k8s-conformance`'s four files, adapted. What changed, and why each change
earns itself:

| K8s | here | why |
|---|---|---|
| `PRODUCT.yaml` | `INTEGRATION.yaml` | same eight fields by name, plus placement / enforcement / attestation / standard version — the inputs to `assuranceForHost`, so the metadata and the grade cannot disagree |
| `junit_01.xml` | `probes.json` | JUnit has no room for "the attack succeeded" as distinct from "the test errored", and that is the whole semantics here |
| `e2e.log` | `probes.log` | same job, same closing summary line |
| — | `GRADE.md` | the file K8s needs no analogue for, because every K8s claim is functional and P1/P3 are not |
| — | `MANIFEST.json`, signed | K8s's trust anchor is a PR from an identified member and evidence anyone can re-run; ours is a report about a boundary nobody outside the vendor can see, so the least it can do is be attributable |

The signature is Ed25519 over the canonical manifest — C-1's rules (UTF-8 JSON,
keys by Unicode code point, compact, **floats refused**) applied recursively,
held byte-identical to `lib/ratchet/ratchet.ts#canonicalPreimage` on flat
objects by a test. It is **not a security claim about the deployment**: it is
attribution plus integrity, which is what §5.3 says the industry does for the
parts it cannot verify.

`verifyBundle()` is the bot's half — required files present, no strays, hashes
match, signature verifies, run admissible. The human half (is this a real
counterparty, is the Integration Agreement signed) is deliberately absent, for
the reason `reviewing.md` keeps it out of Prow.

**READMEs carry no links.** The K8s FAQ bans them because link rot defeats
reproducibility, and reproducibility is the enforcement mechanism for
everything P1 and P3 cannot prove in advance.

---

## 5. What is unimplementable as §7 is written

- **§7 probe 6 is stale.** It predates C-3's acceptance window and would now
  fail a conformant server. Implemented as replay defence instead; §7 should be
  amended to say so.
- **§7 says "each must fail" and stops.** It does not say what a probe that
  *could not run* means. Silence there is how a skip becomes a pass; the
  three-valued outcome and the inadmissibility rule are this suite's answer and
  belong in the spec.
- **§7 assumes the probe can occupy the tenant's position.** For probes 1, 2, 3
  and 7 that assumption is the entire content of the result, and nothing in the
  spec requires a run to record which position it had. `INTEGRATION.yaml`
  carries `probe_vantage` for that reason.
- **§7 probe 7 needs a negative control** and does not mention one. Without it
  the probe reports every air-gapped CI runner as a conformant egress policy.
- ~~**§2 obligation 3 (as amended by C-8) has no configuration to express it.**~~
  **Closed by WO-14** — `CaptureConfig.watchedVolumes`, §1.2 above.

### Added by WO-14, from running the seven where they mean something

- **Probe 6 had never reached a ratchet.** Its forged submission was a
  plausible sketch, not a `Submission`: no `component.attestation`, no `kind`,
  a three-field `capture`. An ingest that canonicalises before it verifies
  refuses that at the JSON layer, and all three attempts came back
  `400 malformed_submission` — recorded as a clean PASS. **Three 400s from a
  field validator are indistinguishable from a deployment with no replay
  defence at all.** The forgery is now the full submission written out longhand
  (restated, not imported, for the reason probe 5 restates `server.py`'s frame
  header), the only wrong thing in it is the MAC, and a refusal that smells of
  the validator is recorded as **inconclusive** rather than banked.
- **Probe 6's downward case degenerates on a young component.** With a
  high-water mark below the window width, "far below the window" is a negative
  counter and is refused as `invalid_counter` — the integer check, not C-3's
  floor. The evidence record now carries `far_below_degenerate`. Exercising the
  floor properly needs a component whose high-water mark exceeds
  `ACCEPTANCE_WINDOW + MAX_RATCHET_ADVANCE`, which a probe must not manufacture
  by spending 250,000 of the vendor's counters.
- **§7 probe 3 asks about a file and the answer is not only about files.**
  `/proc/<pid>/root` resolves in the target's mount namespace, so a shared PID
  namespace hands over a state directory that the tenant's own mount namespace
  does not contain. The probe now attempts it when the operator declares
  `componentPid`. **§7 should say that P1's isolation requirement includes the
  PID namespace, because mount isolation without it is not isolation** — the
  `p3-shared-pid` audit profile recovers the chain key through `/proc` with the
  direct path still empty.
- **A conformance run needs to say what it is a run OF.** §7 assumes one
  deployment and therefore never says this. Without it a run satisfies any
  integration's P2, which it did. `ProbeRun.subject`, above.

### Added by WO-23, from re-cutting P2

- **§7 does not say when the probes run relative to the seal, and the order is
  the whole point.** They are step 2: end-to-end testing, before anything is
  measured. A probe run is a precondition of an approval, not a standing
  conjunct of a compliance item — and §7 should say so, because reading it the
  other way is how P2 came to be a runtime completeness proof.
- **Probe 7 is load-bearing in a way §7 does not mark.** A pipeline measurement
  says what the egress configuration IS; only probe 7 says whether the network
  enforces it. §10 C-12 records that it must pass, with its negative control,
  before a seal is granted.

---

## 6. The audit pass, and why the clean run did not close the WO

`scripts/probe-harness/run.sh --audit` runs nine topologies: the conformant one
and eight deliberate breaks, one per probe (P-03 gets two, because it has two
boundaries). It takes about twenty seconds.

| profile | what is broken | expected |
|---|---|---|
| `none` | nothing | 7 pass |
| `p1-second-route` | the upstream is also reachable on the shared link | P-01 fail |
| `p2-open-provisioning` | provisioning grants an identity to anyone | P-02 fail |
| `p3-state-mounted` | the state directory is in the tenant's mount namespace | P-03 fail |
| `p3-shared-pid` | the tenant shares the component's PID namespace | P-03 fail |
| `p4-singular-volume` | the pre-C-8 single untyped root | P-04 fail |
| `p5-passthrough-ws` | HTTP gated, WebSocket relayed by a sidecar | P-05 fail |
| `p6-permissive-ingest` | the ingest records what it cannot verify | P-06 fail |
| `p7-open-egress` | a route to the egress target | P-07 fail |

The observed result is a clean diagonal: **each break is caught by exactly the
probe it targets and by no other.** That is the property worth having — a probe
that fires on every break is not sensitive, it is noisy, and a suite of noisy
probes cannot localise a fault.

**Re-verified after WO-23's P2 re-cut, and it is still a perfect diagonal.**
Nine profiles, `P-01`…`P-07`, each break caught by exactly its own probe and by
no other. That the re-cut could not disturb it is the point: WO-23 changed what
the GRADER does with a run, not what a probe attacks. The probes are the same
seven, running the same attacks from the same occupied position.

**The diagonal is what makes the green run mean something, and the green run on
its own meant almost nothing.** The `none` profile passed 7/7 on the first
attempt, and reading its evidence rather than its summary is what found probe 6
measuring our own malformed request. The rule the first WO series arrived at
holds here too: *every artifact that got used by something else was found to be
wrong.* The probes had never been used by anything.
